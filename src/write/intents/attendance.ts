import { z } from "zod";
import { CampusError } from "../../errors.js";
import { parseManagedSessions, parseRecordedStatuses, parseSessionRoster } from "../../domain/attendance.js";
import { MobileContentSchema } from "../../moodle/schemas.js";
import type { ParamValue } from "../../moodle/serialize.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { toHtml } from "../text.js";
import type { FormSubmission } from "../web.js";

/**
 * W4 · Asistencia (directiva §8.7; investigación [T] §21) y alta de módulos y sesiones de
 * asistencia por formulario (W6 adelantada, ADR-055).
 * - Tomar asistencia: `tool_mobile_get_content` / `mobile_view_activity` con `status<userid>`, con la
 *   política de escritura propia. El plugin NO valida sesión, estados ni alumnos, y muestra «éxito»
 *   aunque no escriba: todo se valida antes y se verifica releyendo `mobile_teacher_form`.
 * - Retomar BORRA las observaciones (remarks) de los alumnos reenviados: el plan lo advierte.
 * - Umbrales de aviso por correo (tarea notify del plugin): si la actividad los tiene y el perfil no
 *   permite notificar, se rechaza.
 */

const APP_VERSION = 45000;

const ContentsSchema = z.array(
    z.object({ section: z.number().nullable().optional(), modules: z.array(z.object({ id: z.number().int().positive(), modname: z.string(), name: z.string().nullable().optional(), visible: z.number().nullable().optional() })).default([]) }),
);

async function contents(ctx: IntentContext, courseId: number) {
    return ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema);
}

async function attendanceModule(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await contents(ctx, courseId)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m || m.modname !== "attendance") throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es una asistencia del curso ${courseId}.`);
    return m;
}

export async function sessionsOf(ctx: IntentContext, cmid: number) {
    const web = ctx.read.web;
    if (!web) throw new CampusError("AUTH_REQUIRED", "Esta operación necesita la sesión web del Campus.");
    const op = await web.open();
    try {
        const page = await op.get("attendance_sessions", { id: String(cmid), view: "5", group: "-1" });
        const parsed = parseManagedSessions(new TextDecoder().decode(page.bytes));
        if (!parsed.recognized) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció la lista de sesiones de la asistencia.");
        // Una fila no interpretada podría ser justo la sesión a verificar: no se planifica ni se verifica a ciegas.
        if (parsed.discarded > 0) throw new CampusError("UNEXPECTED_RESPONSE", `La lista de sesiones de la asistencia tiene ${parsed.discarded} filas no interpretadas (¿cambió el formato del Campus?).`);
        return parsed.sessions;
    } finally {
        await web.afterOperation(op);
    }
}

async function teacherForm(ctx: IntentContext, courseId: number, cmid: number, sessionId: number) {
    const params: Record<string, ParamValue> = { component: "mod_attendance", method: "mobile_teacher_form" };
    Object.entries({ cmid, courseid: courseId, sessid: sessionId, appversioncode: APP_VERSION }).forEach(([name, value], i) => {
        params[`args[${i}][name]`] = name;
        params[`args[${i}][value]`] = value;
    });
    const res = await ctx.read.session.transport.call("tool_mobile_get_content", params, MobileContentSchema);
    const roster = parseSessionRoster(res.templates.map((t) => t.html).join("\n"));
    if (!roster.recognized) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció el formulario de asistencia de la sesión.");
    let other: unknown = res.otherdata;
    if (typeof other === "string") {
        try {
            other = JSON.parse(other);
        } catch {
            other = {};
        }
    }
    return { roster, current: parseRecordedStatuses(other) };
}

/** Sin umbrales de aviso: la página no trae tabla. Con tabla (o irreconocible) puede notificar. */
async function assertNoWarnings(ctx: IntentContext, cmid: number) {
    if (ctx.profile.policy.allow_participant_notifications) return;
    const html = await ctx.web.readPage("attendance_warnings", { id: String(cmid) });
    const main = html.slice(Math.max(0, html.indexOf('role="main"')));
    if (!html.includes('role="main"') || /<table\b/i.test(main)) {
        throw new CampusError("WRITE_NOT_ALLOWED", "La asistencia tiene umbrales de aviso por correo (o no se pudo comprobar): tomar asistencia podría notificar a estudiantes y el perfil no lo permite.");
    }
}

// ---------- versiones, interpretación y verificación ----------

/** `att:<curso>:<cmid>:<sesión>:<uids>` · `sessions:<cmid>` · `cm:<curso>:<cmid>`. */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const key of Object.keys(plan.preconditions.versions)) {
        const [k, a, b, c, d] = key.split(":");
        if (k === "att") {
            const f = await teacherForm(ctx, Number(a), Number(b), Number(c));
            out[key] = (d ?? "").split(",").map((u) => `${u}=${f.current.get(Number(u)) ?? 0}`).join(",");
        } else if (k === "sessions") out[key] = (await sessionsOf(ctx, Number(a))).map((s) => s.session_id).sort((x, y) => x - y).join(",");
        else if (k === "cm") out[key] = (await contents(ctx, Number(a))).some((s) => s.modules.some((m) => m.id === Number(b))) ? 1 : null;
        else out[key] = null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    if (item.call.kind === "form" && item.call.fn === "course_modedit_attendance_add") {
        const cmid = /\/mod\/attendance\/view\.php\?(?:.*&)?id=(\d+)/.exec((data as FormSubmission | null)?.location ?? "")?.[1];
        return cmid ? { ok: true, moodle_ids: { cmid: Number(cmid) } } : { ok: true };
    }
    // tool_mobile_get_content responde la vista con «éxito» aunque no escriba: decide la relectura.
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected;
    switch (item.call.fn) {
        case "tool_mobile_get_content": {
            const f = await teacherForm(ctx, plan.course_id, Number(t.cmid), Number(t.session_id));
            const want = x.statuses as Record<string, number>;
            const prior = x.prior as Record<string, number>;
            const differences = Object.entries(want).filter(([u, s]) => f.current.get(Number(u)) !== s).map(([u, s]) => ({ field: `status${u}`, expected: s, observed: f.current.get(Number(u)) ?? null }));
            if (!differences.length) return { outcome: "coincide", checked: Object.keys(want).map((u) => `status${u}`), differences };
            const unchanged = Object.keys(want).every((u) => (f.current.get(Number(u)) ?? 0) === (prior[u] ?? 0));
            return { outcome: unchanged ? "sin_efecto" : "difiere", checked: Object.keys(want).map((u) => `status${u}`), differences };
        }
        case "attendance_session_add": {
            const before = new Set(x.prior_session_ids as number[]);
            const added = (await sessionsOf(ctx, Number(t.cmid))).filter((s) => !before.has(s.session_id) && s.date === x.date && s.start_time === x.start && s.end_time === x.end);
            if (added.length === 1) return { outcome: "coincide", checked: ["fecha", "inicio", "fin"], differences: [], moodle_ids: { session_id: added[0]!.session_id } };
            if (!added.length) return { outcome: "sin_efecto", checked: ["sesión"], differences: [{ field: "sesión", expected: `${x.date} ${x.start}-${x.end}`, observed: "no aparece" }] };
            return { outcome: "difiere", checked: ["sesión"], differences: [{ field: "sesiones nuevas", expected: 1, observed: added.length }] };
        }
        case "attendance_session_delete": {
            const still = (await sessionsOf(ctx, Number(t.cmid))).some((s) => s.session_id === Number(t.session_id));
            return still ? { outcome: "sin_efecto", checked: ["sesión"], differences: [{ field: "sesión", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["sesión"], differences: [] };
        }
        case "course_modedit_attendance_add": {
            const mods = (await contents(ctx, plan.course_id)).flatMap((s) => (s.modules ?? []).map((m) => ({ ...m, section: s.section })));
            const m = known.cmid ? mods.find((y) => y.id === known.cmid) : mods.filter((y) => y.modname === "attendance" && y.name === x.name && !(x.prior_cmids as number[]).includes(y.id))[0];
            if (!m) return { outcome: "sin_efecto", checked: ["actividad"], differences: [{ field: "actividad", expected: "creada", observed: "no aparece" }] };
            const differences = [
                ...(m.name === x.name ? [] : [{ field: "name", expected: x.name, observed: m.name ?? null }]),
                ...(m.section === x.section ? [] : [{ field: "section", expected: x.section, observed: m.section ?? null }]),
                ...((m.visible === 1) === x.visible ? [] : [{ field: "visible", expected: x.visible, observed: m.visible === 1 }]),
            ];
            return { outcome: differences.length ? "difiere" : "coincide", checked: ["name", "section", "visible"], differences, moodle_ids: { cmid: m.id } };
        }
        case "core_courseformat_update_course": {
            const still = (await contents(ctx, plan.course_id)).some((s) => s.modules.some((m) => m.id === Number(t.cmid)));
            return still ? { outcome: "sin_efecto", checked: ["actividad"], differences: [{ field: "actividad", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["actividad"], differences: [] };
        }
        default:
            throw new CampusError("UNEXPECTED_RESPONSE", `Sin verificación para ${item.call.fn}.`);
    }
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };
const applied = (r: { outcome: string }) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido";

// ---------- tomar asistencia ----------

const takeShape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("course_module_id de la actividad de asistencia."),
    session_id: z.number().int().positive(),
    marks: z
        .array(z.strictObject({ participant_id: z.number().int().positive(), status: z.string().min(1).max(20).describe("Acrónimo o nombre del estado (P, A, T, J…), o su status_id.") }))
        .min(1)
        .max(60),
};
type TakeInput = { course_id: number; course_module_id: number; session_id: number; marks: { participant_id: number; status_id: number }[] | { participant_id: number; status: string }[] };

async function buildTake(input: TakeInput, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    await attendanceModule(ctx, input.course_id, input.course_module_id);
    // La sesión tiene que ser de ESTA actividad (el plugin no lo verifica [T §21.2]).
    const session = (await sessionsOf(ctx, input.course_module_id)).find((s) => s.session_id === input.session_id);
    if (!session) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sesión ${input.session_id} no es de esa actividad de asistencia.`);
    await assertNoWarnings(ctx, input.course_module_id);
    const f = await teacherForm(ctx, input.course_id, input.course_module_id, input.session_id);
    if (!f.roster.statuses.length) throw new CampusError("UNEXPECTED_RESPONSE", "La sesión no informa estados de asistencia.");
    const seen = new Set<number>();
    const statuses: Record<string, number> = {};
    const prior: Record<string, number> = {};
    const preview: Record<string, unknown>[] = [];
    for (const m of input.marks) {
        if (seen.has(m.participant_id)) throw new CampusError("WRITE_NOT_ALLOWED", `El participante ${m.participant_id} aparece dos veces.`);
        seen.add(m.participant_id);
        const student = f.roster.students.find((s) => s.participant_id === m.participant_id);
        if (!student) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${m.participant_id} no está en el padrón de la sesión.`);
        const wanted = "status_id" in m ? String(m.status_id) : m.status.trim();
        const st = f.roster.statuses.find((s) => String(s.status_id) === wanted || s.acronym.toLowerCase() === wanted.toLowerCase());
        if (!st) throw new CampusError("WRITE_NOT_ALLOWED", `El estado «${wanted}» no es de esta sesión (estados: ${f.roster.statuses.map((s) => s.acronym).join(", ")}).`);
        statuses[String(m.participant_id)] = st.status_id;
        prior[String(m.participant_id)] = f.current.get(m.participant_id) ?? 0;
        preview.push({ participant_id: m.participant_id, name: student.name, from: f.roster.statuses.find((s) => s.status_id === f.current.get(m.participant_id))?.acronym ?? "sin registrar", to: st.acronym });
    }
    const changed = Object.keys(statuses).filter((u) => statuses[u] !== prior[u]);
    if (!changed.length) throw new CampusError("WRITE_NOT_ALLOWED", "Los alumnos ya tienen esos estados: no hay nada que escribir.");
    const args: Record<string, number> = { cmid: input.course_module_id, courseid: input.course_id, sessid: input.session_id, appversioncode: APP_VERSION };
    for (const u of Object.keys(statuses)) args[`status${u}`] = statuses[u]!;
    const params: Record<string, ParamValue> = { component: "mod_attendance", method: "mobile_view_activity" };
    Object.entries(args).forEach(([name, value], i) => {
        params[`args[${i}][name]`] = name;
        params[`args[${i}][value]`] = value;
    });
    const uids = Object.keys(statuses).join(",");
    const retaken = Object.values(prior).some((p) => p > 0);
    return {
        intent: "attendance",
        capability: "take_attendance",
        course_id: input.course_id,
        base_risk: "R3",
        summary: `${undoOf ? "Deshacer: " : ""}registrar la asistencia de ${Object.keys(statuses).length} alumno(s) en la sesión ${input.session_id} (${session.date_text ?? ""} ${session.time_text ?? ""}).`,
        payload_preview: { session: { session_id: input.session_id, date: session.date, start: session.start_time, end: session.end_time, description: session.description }, marks: preview },
        side_effects: [
            "Registro académico: cambia la nota de asistencia en el libro de calificaciones (si la actividad tiene nota).",
            "Evento attendance_taken. Sin avisos por correo (la actividad no tiene umbrales de aviso).",
            ...(retaken ? ["RETOMAR BORRA las observaciones (remarks) de los alumnos reenviados; no se recuperan."] : []),
        ],
        preconditions: { description: "Los estados de esos alumnos no cambiaron desde el plan.", versions: { [`att:${input.course_id}:${input.course_module_id}:${input.session_id}:${uids}`]: Object.keys(statuses).map((u) => `${u}=${prior[u] ?? 0}`).join(",") } },
        undo: Object.values(prior).every((p) => p === 0)
            ? { kind: "ninguno", how: "Los alumnos no tenían estado: un registro no se puede borrar por esta vía (sólo cambiar).", until: null }
            : { kind: "compensación", how: "Reenviar los estados anteriores de los alumnos que tenían uno. Las observaciones borradas no vuelven.", until: null },
        warnings: retaken ? ["Hay alumnos con estado ya registrado: retomar borra sus observaciones."] : [],
        items: [
            {
                item_id: "i1",
                description: `Tomar asistencia en la sesión ${input.session_id}`,
                call: { fn: "tool_mobile_get_content", params },
                target: { course_id: input.course_id, cmid: input.course_module_id, session_id: input.session_id },
                expected: { statuses, prior },
            },
        ],
        prior_state: { prior },
        untrusted_fields: ["payload_preview.marks[].name", "payload_preview.session.description"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const takeAttendanceIntent: WriteIntent<typeof takeShape> = {
    name: "attendance",
    title: "Plan: tomar asistencia",
    description: "Arma el plan para registrar el estado de asistencia (P, A, T, J… según la sesión) de alumnos en una sesión de una actividad de asistencia del curso. No escribe. Retomar borra las observaciones.",
    inputShape: takeShape,
    capability: "take_attendance",
    synthetic_only: false,
    ...common,
    plan: (input, ctx) => buildTake(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some(applied)) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const prior = (plan.prior_state as { prior: Record<string, number> }).prior;
        const marks = Object.entries(prior).filter(([, s]) => s > 0).map(([u, s]) => ({ participant_id: Number(u), status_id: s }));
        if (!marks.length) return { kind: "ninguno", reason: "Ningún alumno tenía estado antes: un registro no se puede borrar por esta vía." };
        const t = plan.items[0]!.target;
        return { kind: "plan", draft: await buildTake({ course_id: plan.course_id, course_module_id: Number(t.cmid), session_id: Number(t.session_id), marks }, ctx, result.action_id) };
    },
};

// ---------- agregar una sesión ----------

const sessionShape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha AAAA-MM-DD (zona del perfil)."),
    start: z.string().regex(/^\d{2}:\d{2}$/).describe("HH:MM"),
    end: z.string().regex(/^\d{2}:\d{2}$/).describe("HH:MM"),
    description: z.string().max(2_000).optional(),
    calendar_event: z.boolean().optional().describe("Crear el evento de calendario de la sesión (por defecto no)."),
};

export const addSessionIntent: WriteIntent<typeof sessionShape> = {
    name: "attendance_session",
    title: "Plan: agregar una sesión de asistencia",
    description: "Arma el plan para agregar UNA sesión (para todos los alumnos) a una actividad de asistencia del curso. No escribe. Los alumnos no pueden marcarse solos.",
    inputShape: sessionShape,
    capability: "take_attendance",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        await attendanceModule(ctx, input.course_id, input.course_module_id);
        const [y, mo, d] = input.date.split("-").map(Number) as [number, number, number];
        const [sh, sm] = input.start.split(":").map(Number) as [number, number];
        const [eh, em] = input.end.split(":").map(Number) as [number, number];
        if (sh > 23 || eh > 23 || sm > 59 || em > 59 || eh * 60 + em <= sh * 60 + sm) throw new CampusError("WRITE_NOT_ALLOWED", "Horario inválido: el fin tiene que ser posterior al inicio.");
        const existing = await sessionsOf(ctx, input.course_module_id);
        if (existing.some((s) => s.date === input.date && s.start_time === input.start)) throw new CampusError("WRITE_NOT_ALLOWED", "Ya hay una sesión ese día a esa hora.");
        const html = input.description ? toHtml(input.description, "markdown") : "";
        const cal = input.calendar_event ?? false;
        return {
            intent: "attendance_session",
            capability: "take_attendance",
            course_id: input.course_id,
            base_risk: "R1",
            summary: `Agregar una sesión de asistencia el ${input.date} de ${input.start} a ${input.end}${cal ? ", con evento de calendario" : ""}.`,
            payload_preview: { date: input.date, start: input.start, end: input.end, description_html: html, for: "todos los alumnos", students_can_mark: false, calendar_event: cal },
            side_effects: [cal ? "Crea el evento de calendario de la sesión (visible para los alumnos; sin notificaciones)." : "Sin evento de calendario.", "Sin notificaciones."],
            preconditions: { description: "Las sesiones de la actividad no cambiaron desde el plan.", versions: { [`sessions:${input.course_module_id}`]: existing.map((s) => s.session_id).sort((a, b) => a - b).join(",") } },
            undo: { kind: "exacto", how: "Borrar la sesión creada.", until: null },
            warnings: [],
            items: [
                {
                    item_id: "i1",
                    description: `Nueva sesión ${input.date} ${input.start}-${input.end}`,
                    call: {
                        kind: "form",
                        fn: "attendance_session_add",
                        params: {
                            query: { id: String(input.course_module_id), action: "1" },
                            fields: {
                                "sessiondate[day]": String(d),
                                "sessiondate[month]": String(mo),
                                "sessiondate[year]": String(y),
                                "sestime[starthour]": String(sh),
                                "sestime[startminute]": String(sm),
                                "sestime[endhour]": String(eh),
                                "sestime[endminute]": String(em),
                                "sdescription[text]": html,
                                "sdescription[format]": "1",
                                calendarevent: cal ? "1" : "0",
                                sessiontype: "0",
                                addmultiply: "0",
                                studentscanmark: "0",
                                autoassignstatus: "0",
                            },
                        },
                    },
                    target: { course_id: input.course_id, cmid: input.course_module_id },
                    expected: { date: input.date, start: input.start, end: input.end, prior_session_ids: existing.map((s) => s.session_id) },
                },
            ],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: (input.description ? { description: input.description } : {}) as Record<string, string>,
            undo_of: null,
        };
    },
    async undo(plan, result) {
        const sessionId = result.items.find(applied)?.moodle_ids.session_id;
        if (!sessionId) return { kind: "ninguno", reason: "No se conoce la sesión creada." };
        const cmid = Number(plan.items[0]!.target.cmid);
        return {
            kind: "plan",
            draft: {
                intent: "attendance_session",
                capability: "take_attendance",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar la sesión de asistencia ${sessionId}.`,
                payload_preview: { delete_session: sessionId },
                side_effects: ["Borra la sesión y sus registros de asistencia (irreversible)."],
                preconditions: { description: "Las sesiones de la actividad no cambiaron.", versions: {} },
                undo: { kind: "ninguno", how: "El borrado no se puede deshacer.", until: null },
                warnings: [],
                items: [
                    {
                        item_id: "i1",
                        description: `Borrar la sesión ${sessionId}`,
                        call: { kind: "form", fn: "attendance_session_delete", params: { query: {}, fields: { id: String(cmid), action: "3", sessionid: String(sessionId), confirm: "1" } } },
                        target: { course_id: plan.course_id, cmid, session_id: sessionId },
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

// ---------- crear el módulo de asistencia ----------

const createShape = {
    course_id: z.number().int().positive(),
    name: z.string().min(1).max(255),
    intro: z.string().max(10_000).optional(),
    section: z.number().int().min(0).max(200).describe("Número de sección EXISTENTE."),
    visible: z.boolean().optional().describe("Por defecto false: se crea oculta."),
    max_grade: z.number().int().min(1).max(100).optional().describe("Con nota (puntos); ausente = sin nota."),
};

export const createAttendanceIntent: WriteIntent<typeof createShape> = {
    name: "create_attendance",
    title: "Plan: crear una actividad de asistencia",
    description: "Arma el plan para crear una actividad de asistencia en una sección existente (por defecto oculta, sin nota y sin notificar). No escribe.",
    inputShape: createShape,
    capability: "create_attendance",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const c = await contents(ctx, input.course_id);
        if (!c.some((s) => s.section === input.section)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.section} no existe (abrir el formulario la crearía).`);
        const visible = input.visible ?? false;
        const html = input.intro ? toHtml(input.intro, "markdown") : "";
        const fields: Record<string, string> = {
            name: input.name,
            "introeditor[text]": html,
            "introeditor[format]": "1",
            visible: visible ? "1" : "0",
            coursecontentnotification: "0",
            "grade[modgrade_type]": input.max_grade ? "point" : "none",
            ...(input.max_grade ? { "grade[modgrade_point]": String(input.max_grade) } : {}),
        };
        return {
            intent: "create_attendance",
            capability: "create_attendance",
            course_id: input.course_id,
            base_risk: visible ? "R2" : "R1",
            summary: `Crear la asistencia «${input.name}» ${visible ? "VISIBLE" : "oculta"} en la sección ${input.section}, ${input.max_grade ? `con nota sobre ${input.max_grade}` : "sin nota"}.`,
            payload_preview: { name: input.name, intro_html: html, section: input.section, visible, grade: input.max_grade ?? "sin nota", notifications: "ninguna (coursecontentnotification=0)", other_settings: "valores por defecto del formulario del sitio" },
            side_effects: ["Crea la actividad con el conjunto de estados por defecto del sitio.", input.max_grade ? "Crea su ítem de calificación." : "Sin ítem de calificación.", "Sin notificaciones."],
            preconditions: { description: "La sección sigue existiendo.", versions: {} },
            undo: { kind: "compensación", how: "Borrar la actividad (va a la papelera; restaurarla crea otro cmid).", until: null },
            warnings: ["Creación por formulario web: requiere la sesión web del Campus."],
            items: [
                {
                    item_id: "i1",
                    description: `Nueva asistencia «${input.name}»`,
                    call: { kind: "form", fn: "course_modedit_attendance_add", params: { query: { add: "attendance", course: String(input.course_id), section: String(input.section) }, fields } },
                    target: { course_id: input.course_id, section: input.section },
                    expected: { name: input.name, section: input.section, visible, prior_cmids: c.flatMap((s) => s.modules.map((m) => m.id)) },
                },
            ],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: { name: input.name },
            undo_of: null,
        };
    },
    async undo(plan, result) {
        const cmid = result.items.find(applied)?.moodle_ids.cmid;
        if (!cmid) return { kind: "ninguno", reason: "No se conoce la actividad creada." };
        return {
            kind: "plan",
            draft: {
                intent: "create_attendance",
                capability: "create_attendance",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar la asistencia (cmid ${cmid}).`,
                payload_preview: { delete_activity: cmid },
                side_effects: ["Va a la papelera del curso (7 días), con sus sesiones y registros."],
                preconditions: { description: "La actividad sigue en el curso.", versions: { [`cm:${plan.course_id}:${cmid}`]: 1 } },
                undo: { kind: "ninguno", how: "Sólo restaurando desde la papelera, a mano.", until: null },
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

export const ATTENDANCE_INTENTS = [takeAttendanceIntent, addSessionIntent, createAttendanceIntent];
