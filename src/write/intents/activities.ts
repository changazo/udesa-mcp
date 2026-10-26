import { z } from "zod";
import { CampusError } from "../../errors.js";
import { AssignmentsSchema } from "../../moodle/schemas.js";
import { formatLocal } from "../../util/time.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanItem } from "../plan.js";
import { toHtml } from "../text.js";
import type { FormSubmission } from "../web.js";
import { parseLocalDateTime } from "./w2.js";

/**
 * Crear una TAREA por el formulario web (directiva §8.9 «Crear recursos y actividades», W6,
 * adelantada a pedido del dueño: ADR-050). Reglas de la directiva:
 * - oculta al crear salvo pedido explícito;
 * - coursecontentnotification=0 siempre (si no, notifica a los participantes), y tampoco avisos
 *   de entregas ni de calificaciones (sendnotifications, sendlatenotifications, sendstudentnotifications);
 * - la sección tiene que existir (un GET con una sección inexistente CREA secciones);
 * - todas las fechas y opciones que fija el plan van explícitas; el resto de la configuración
 *   queda con los valores por defecto que sirve el formulario.
 * Deshacer: borrar la actividad (AJAX core_courseformat_update_course, acción cm_delete).
 */

const ContentsSchema = z.array(
    z.object({
        section: z.number().nullable().optional(),
        modules: z.array(z.object({ id: z.number().int().positive(), modname: z.string(), name: z.string().nullable().optional(), instance: z.number().nullable().optional(), visible: z.number().nullable().optional() })).default([]),
    }),
);

async function contents(ctx: IntentContext, courseId: number) {
    return ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema);
}

async function assignments(ctx: IntentContext, courseId: number) {
    const res = await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [courseId] }, AssignmentsSchema);
    return res.courses.find((c) => c.id === courseId)?.assignments ?? [];
}

const DATE_KEYS = ["allowsubmissionsfromdate", "duedate", "cutoffdate", "gradingduedate"] as const;
type DateKey = (typeof DATE_KEYS)[number];

/** Partes del selector de fecha de Moodle en la zona del perfil; 0 = deshabilitada. */
function dateFields(key: DateKey, unix: number, tz: string): Record<string, string> {
    if (!unix) return { [`${key}[enabled]`]: "0" };
    const l = formatLocal(new Date(unix * 1000), tz); // AAAA-MM-DDTHH:MM:SS±HH:MM
    return {
        [`${key}[enabled]`]: "1",
        [`${key}[day]`]: String(Number(l.slice(8, 10))),
        [`${key}[month]`]: String(Number(l.slice(5, 7))),
        [`${key}[year]`]: l.slice(0, 4),
        [`${key}[hour]`]: String(Number(l.slice(11, 13))),
        [`${key}[minute]`]: String(Number(l.slice(14, 16))),
    };
}

// ---------- versiones ----------

/** `section:<curso>:<número>` (existe) · `cm:<curso>:<cmid>` (existe). */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, number | null> = {};
    const c = await contents(ctx, plan.course_id);
    for (const key of Object.keys(plan.preconditions.versions)) {
        const [k, , n] = key.split(":");
        if (k === "section") out[key] = c.some((s) => s.section === Number(n)) ? 1 : null;
        else if (k === "cm") out[key] = c.some((s) => s.modules.some((m) => m.id === Number(n))) ? 1 : null;
        else out[key] = null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    if (item.call.kind === "form") {
        const loc = (data as FormSubmission | null)?.location ?? "";
        const cmid = /\/mod\/assign\/view\.php\?(?:.*&)?id=(\d+)/.exec(loc)?.[1];
        return cmid ? { ok: true, moodle_ids: { cmid: Number(cmid) } } : { ok: true };
    }
    return { ok: true };
}

const diff = (field: string, expected: unknown, observed: unknown): Difference[] => (expected === observed ? [] : [{ field, expected, observed }]);

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const x = item.expected;
    if (item.call.kind === "ajax") {
        const cmid = Number(item.target.cmid);
        const still = (await contents(ctx, plan.course_id)).some((s) => s.modules.some((m) => m.id === cmid));
        return still ? { outcome: "sin_efecto", checked: ["actividad"], differences: [{ field: "actividad", expected: "borrada", observed: "sigue en el curso" }] } : { outcome: "coincide", checked: ["actividad"], differences: [] };
    }
    const list = await assignments(ctx, plan.course_id);
    const created = Math.floor(Date.parse(plan.created_at) / 1000) - 120;
    const a = known.cmid ? list.find((y) => y.cmid === known.cmid) : list.find((y) => y.name === x.name && (y.timemodified ?? 0) >= created);
    if (!a) return { outcome: "sin_efecto", checked: ["tarea"], differences: [{ field: "tarea", expected: "creada", observed: "no aparece en el curso" }] };
    const c = await contents(ctx, plan.course_id);
    const section = c.find((s) => s.modules.some((m) => m.id === a.cmid));
    const mod = section?.modules.find((m) => m.id === a.cmid);
    const differences = [
        ...diff("name", x.name, a.name ?? null),
        ...DATE_KEYS.flatMap((k) => diff(k, x[k], a[k] ?? 0)),
        ...diff("section", x.section, section?.section ?? null),
        ...diff("visible", x.visible, mod ? mod.visible === 1 : null),
    ];
    return { outcome: differences.length ? "difiere" : "coincide", checked: ["name", ...DATE_KEYS, "section", "visible"], differences, moodle_ids: { cmid: a.cmid, assignment_id: a.id } };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const shape = {
    course_id: z.number().int().positive(),
    name: z.string().min(1).max(255),
    intro: z.string().max(10_000).optional().describe("Consigna (Markdown)."),
    section: z.number().int().min(0).max(200).describe("Número de sección EXISTENTE (0 = General)."),
    visible: z.boolean().optional().describe("Por defecto false: se crea oculta."),
    allow_from: z.string().max(40).optional().describe("Permitir entregas desde (AAAA-MM-DDTHH:MM local o ISO con zona). Ausente = sin fecha."),
    due: z.string().max(40).optional().describe("Vencimiento. Ausente = sin vencimiento."),
    cutoff: z.string().max(40).optional().describe("Fecha de corte. Ausente = sin corte."),
    online_text: z.boolean().optional().describe("Entrega en texto en línea (por defecto true)."),
    files: z.boolean().optional().describe("Entrega con archivos (por defecto true)."),
    max_grade: z.number().int().min(1).max(100).optional().describe("Nota máxima (por defecto 100)."),
};

export const createAssignmentIntent: WriteIntent<typeof shape> = {
    name: "create_assignment",
    title: "Plan: crear una tarea",
    description:
        "Arma el plan para crear una tarea en una sección existente del curso (por defecto OCULTA y sin notificar a nadie). No escribe. Las fechas y opciones que fija el plan quedan explícitas; el resto toma los valores por defecto del sitio.",
    inputShape: shape,
    capability: "create_assignment",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,

    async plan(input, ctx) {
        const tz = ctx.profile.read_profile.timezone;
        const c = await contents(ctx, input.course_id);
        if (!c.some((s) => s.section === input.section)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.section} no existe en el curso (abrir el formulario con una sección inexistente la crearía).`);
        const when = (v: string | undefined, label: string) => {
            if (v === undefined) return 0;
            const t = parseLocalDateTime(v, tz);
            if (t === null) throw new CampusError("WRITE_NOT_ALLOWED", `${label} debe ser AAAA-MM-DDTHH:MM (zona del perfil) o ISO 8601 con zona.`);
            return t;
        };
        const dates: Record<DateKey, number> = { allowsubmissionsfromdate: when(input.allow_from, "allow_from"), duedate: when(input.due, "due"), cutoffdate: when(input.cutoff, "cutoff"), gradingduedate: 0 };
        // Mismo orden que valida el formulario de Moodle.
        if (dates.allowsubmissionsfromdate && dates.duedate && dates.duedate < dates.allowsubmissionsfromdate) throw new CampusError("WRITE_NOT_ALLOWED", "El vencimiento es anterior a «permitir entregas desde».");
        if (dates.cutoffdate && dates.duedate && dates.cutoffdate < dates.duedate) throw new CampusError("WRITE_NOT_ALLOWED", "La fecha de corte es anterior al vencimiento.");
        if (dates.cutoffdate && dates.allowsubmissionsfromdate && dates.cutoffdate < dates.allowsubmissionsfromdate) throw new CampusError("WRITE_NOT_ALLOWED", "La fecha de corte es anterior a «permitir entregas desde».");
        const onlineText = input.online_text ?? true;
        const files = input.files ?? true;
        if (!onlineText && !files) throw new CampusError("WRITE_NOT_ALLOWED", "Elegí al menos un tipo de entrega (texto en línea o archivos).");
        const visible = input.visible ?? false;
        const max = input.max_grade ?? 100;
        const html = input.intro ? toHtml(input.intro, "markdown") : "";
        const local = (u: number) => (u ? formatLocal(new Date(u * 1000), tz) : "sin fecha");
        const fields: Record<string, string> = {
            name: input.name,
            "introeditor[text]": html,
            "introeditor[format]": "1",
            visible: visible ? "1" : "0",
            coursecontentnotification: "0",
            sendnotifications: "0",
            sendlatenotifications: "0",
            sendstudentnotifications: "0",
            assignsubmission_onlinetext_enabled: onlineText ? "1" : "0",
            assignsubmission_file_enabled: files ? "1" : "0",
            "grade[modgrade_type]": "point",
            "grade[modgrade_point]": String(max),
            ...DATE_KEYS.reduce((acc, k) => ({ ...acc, ...dateFields(k, dates[k], tz) }), {} as Record<string, string>),
        };
        return {
            intent: "create_assignment",
            capability: "create_assignment",
            course_id: input.course_id,
            base_risk: visible ? "R2" : "R1",
            summary: `Crear la tarea «${input.name}» ${visible ? "VISIBLE" : "oculta"} en la sección ${input.section}${dates.duedate ? `, con vencimiento ${local(dates.duedate)}` : ""}.`,
            payload_preview: {
                name: input.name,
                intro_html: html,
                section: input.section,
                visible,
                allow_submissions_from: local(dates.allowsubmissionsfromdate),
                due: local(dates.duedate),
                cutoff: local(dates.cutoffdate),
                grading_due: "sin fecha",
                submission_types: { online_text: onlineText, files },
                max_grade: max,
                notifications: "ninguna: aviso de contenido nuevo, avisos de entregas y notificación de calificaciones en 0",
                other_settings: "valores por defecto del formulario del sitio",
            },
            side_effects: [
                visible ? "Visible para los participantes del curso (sin aviso por correo)." : "Oculta: los estudiantes no la ven.",
                "Crea el ítem de calificación y los eventos de calendario de sus fechas.",
                "Reconstruye la caché del curso y recalcula notas finales del curso.",
                "Abrir el formulario reserva un área borrador para la consigna (se purga sola).",
            ],
            preconditions: { description: "La sección sigue existiendo.", versions: { [`section:${input.course_id}:${input.section}`]: 1 } },
            undo: { kind: "compensación", how: "Borrar la tarea: va a la papelera del curso (7 días); restaurarla crea otro cmid. Borra también sus entregas, notas y eventos.", until: null },
            warnings: ["Creación por formulario web: requiere la sesión web del Campus."],
            items: [
                {
                    item_id: "i1",
                    description: `Nueva tarea «${input.name}» en la sección ${input.section}`,
                    call: { kind: "form", fn: "course_modedit_assign_add", params: { query: { add: "assign", course: String(input.course_id), section: String(input.section) }, fields } },
                    target: { course_id: input.course_id, section: input.section },
                    expected: { name: input.name, section: input.section, visible, ...dates },
                },
            ],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: { name: input.name, ...(input.intro ? { intro: input.intro } : {}) },
            undo_of: null,
        };
    },

    async undo(plan, result) {
        const r = result.items.find((i) => i.outcome === "verificado" || i.outcome === "con_diferencias" || i.outcome === "desconocido");
        const cmid = r?.moodle_ids.cmid;
        if (!r || !cmid) return { kind: "ninguno", reason: "No se conoce la actividad creada." };
        const name = String(plan.items[0]!.expected.name);
        return {
            kind: "plan",
            draft: {
                intent: "create_assignment",
                capability: "create_assignment",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar la tarea «${name}» (cmid ${cmid}).`,
                payload_preview: { delete_activity: { cmid, name } },
                side_effects: ["La tarea va a la papelera del curso (7 días). Se borran sus entregas, notas, ítem de calificación y eventos."],
                preconditions: { description: "La actividad sigue en el curso.", versions: { [`cm:${plan.course_id}:${cmid}`]: 1 } },
                undo: { kind: "ninguno", how: "Sólo restaurando desde la papelera, a mano (crea otro cmid).", until: null },
                warnings: [],
                items: [
                    {
                        item_id: "i1",
                        description: `Borrar la actividad ${cmid}`,
                        call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "cm_delete", courseid: plan.course_id, ids: [cmid] } },
                        target: { course_id: plan.course_id, cmid },
                        expected: { deleted: true },
                    },
                ],
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};
