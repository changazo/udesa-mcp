import { z } from "zod";
import { CampusError } from "../../errors.js";
import { GroupingsSchema, GroupsSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { COMMON_SETTINGS, KIND_SETTINGS, SETTINGS_KINDS, type Control, type SettingDef } from "../settings-catalog.js";
import { readModForm } from "./modform.js";
import { parseLocalDateTime } from "./w2.js";

/**
 * W6 · Ajustes de una actividad (ADR-082), por `/course/modedit.php?update=<cmid>`: un catálogo cerrado
 * por tipo (src/write/settings-catalog.ts) más modo de grupos, agrupamiento, «mostrar descripción» y
 * restricciones de acceso (fechas, grupos, agrupamiento).
 * - Sólo se mandan los campos que cambian; el resto del formulario se reenvía tal cual; sin notificar.
 * - Un ajuste que el formulario de esa actividad no trae se rechaza (p. ej. grupos en un libro).
 * - Verificación: se relee el propio formulario y se compara cada campo según su control.
 * - Deshacer: los valores anteriores (compensación).
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));
const RESTRICTIONS_FIELD = "availabilityconditionsjson";
/** Ajustes de nota de una tarea (ADR-095): sólo mientras no tenga notas puestas. */
const ASSIGN_GRADE_FIELDS = ["grade[modgrade_type]", "grade[modgrade_scale]", "advancedgradingmethod_submissions", "markingworkflow"];
const AssignmentsSchema = z.object({ courses: z.array(z.object({ id: z.number().int(), assignments: z.array(z.object({ id: z.number().int(), cmid: z.number().int() })).default([]) })).default([]) });
const GradesSchema = z.object({ assignments: z.array(z.object({ assignmentid: z.number().int(), grades: z.array(z.object({ grade: z.string().nullable().optional() })).default([]) })).default([]) });

/** true si la tarea tiene alguna nota puesta (assign_grades con valor). */
async function assignHasGrades(ctx: IntentContext, courseId: number, cmid: number): Promise<boolean> {
    const a = (await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [courseId] }, AssignmentsSchema)).courses.flatMap((c) => c.assignments).find((x) => x.cmid === cmid);
    if (!a) throw new CampusError("UNEXPECTED_RESPONSE", "La tarea no aparece en mod_assign_get_assignments.");
    const g = GradesSchema.parse(await ctx.transport.call("mod_assign_get_grades", { assignmentids: [a.id] }));
    return g.assignments.some((x) => x.grades.some((y) => y.grade !== null && y.grade !== undefined && Number(y.grade) >= 0));
}

/** Valor actual de un campo según su control (las casillas simples ausentes valen 0). */
function currentValue(fields: [string, string][], field: string, control: Control | "json"): string | null {
    const values = fields.filter(([n]) => n === field).map(([, v]) => v);
    if (control === "checkbox") return values.includes("1") ? "1" : "0";
    if (!values.length) return null;
    return values[values.length - 1]!;
}

/** JSON de restricciones en forma canónica (claves ordenadas) para comparar. */
function canonical(json: string): string {
    if (!json.trim()) return "";
    const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v);
    try {
        return JSON.stringify(sort(JSON.parse(json)));
    } catch {
        return json;
    }
}

async function moduleOf(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname === "turnitintooltwo") throw new CampusError("WRITE_NOT_ALLOWED", "Turnitin no se edita: guardar su configuración la sincroniza con el servicio externo.");
    if (!SETTINGS_KINDS.includes(m.modname)) throw new CampusError("WRITE_NOT_ALLOWED", `Las actividades de tipo ${m.modname} no tienen ajustes editables por esta vía.`);
    return { cmid, kind: m.modname, name: m.name ?? "" };
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid] = k.split(":");
        if (kind !== "cmsettings") {
            out[k] = null;
            continue;
        }
        const m = await moduleOf(ctx, Number(course), Number(cmid));
        const fields = await readModForm(ctx, m.cmid, m.kind);
        const controls = (plan.items[0]!.expected as { controls: Record<string, Control | "json"> }).controls;
        out[k] = JSON.stringify(Object.keys(controls).sort().map((f) => [f, controls[f] === "json" ? canonical(currentValue(fields, f, "json") ?? "") : currentValue(fields, f, controls[f]!)]));
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { kind: string; controls: Record<string, Control | "json">; values: Record<string, string>; prior: Record<string, string> };
    const fields = await readModForm(ctx, Number(item.target.cmid), x.kind);
    const now = (f: string) => (x.controls[f] === "json" ? canonical(currentValue(fields, f, "json") ?? "") : currentValue(fields, f, x.controls[f]!));
    const want = (f: string) => (x.controls[f] === "json" ? canonical(x.values[f]!) : x.values[f]!);
    const was = (f: string) => (x.controls[f] === "json" ? canonical(x.prior[f]!) : x.prior[f]!);
    const keys = Object.keys(x.values);
    const differences: Difference[] = keys.filter((f) => now(f) !== want(f)).map((f) => ({ field: f, expected: want(f), observed: now(f) }));
    if (!differences.length) return { outcome: "coincide", checked: keys, differences };
    return { outcome: keys.every((f) => now(f) === was(f)) ? "sin_efecto" : "difiere", checked: keys, differences };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

type Value = string | number | boolean;
interface Restrictions {
    from?: string | null;
    until?: string | null;
    group_ids?: number[];
    grouping_id?: number;
    show_when_unmet?: boolean;
}
interface Req {
    course_id: number;
    course_module_id: number;
    settings?: Record<string, Value>;
    restrictions?: Restrictions | null;
    /** Deshacer: valores crudos por campo. */
    raw?: Record<string, string>;
}

/** Valor público → valor del formulario. */
function toRaw(key: string, d: SettingDef, v: Value): string {
    if (d.control === "checkbox" || d.control === "advcheckbox") {
        if (typeof v !== "boolean") throw new CampusError("WRITE_NOT_ALLOWED", `${key}: va true o false.`);
        return v ? "1" : "0";
    }
    if (d.control === "int") {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isInteger(n) || n < (d.min ?? 0) || n > (d.max ?? 1e12)) throw new CampusError("WRITE_NOT_ALLOWED", `${key}: entero entre ${d.min} y ${d.max}.`);
        return String(n);
    }
    const raw = d.values?.[String(v)];
    if (raw === undefined) throw new CampusError("WRITE_NOT_ALLOWED", `${key}: valores admitidos: ${Object.keys(d.values ?? {}).join(", ")}.`);
    return raw;
}

async function restrictionsJson(ctx: IntentContext, courseId: number, r: Restrictions | null): Promise<string> {
    if (r === null) return "";
    const tz = ctx.profile.read_profile.timezone;
    const c: unknown[] = [];
    const when = (raw: string, label: string) => {
        const t = parseLocalDateTime(raw, tz);
        if (t === null) throw new CampusError("WRITE_NOT_ALLOWED", `${label}: fecha inválida (${raw}). Usá AAAA-MM-DDTHH:MM.`);
        return Math.floor(t / 60) * 60;
    };
    const from = r.from ? when(r.from, "from") : null;
    const until = r.until ? when(r.until, "until") : null;
    if (from && until && until <= from) throw new CampusError("WRITE_NOT_ALLOWED", "until tiene que ser posterior a from.");
    if (from) c.push({ type: "date", d: ">=", t: from });
    if (until) c.push({ type: "date", d: "<", t: until });
    if (r.group_ids?.length) {
        const groups = await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: courseId }, GroupsSchema);
        const bad = r.group_ids.filter((g) => !groups.some((x) => x.id === g && x.courseid === courseId));
        if (bad.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Grupos que no son del curso: ${bad.join(", ")}.`);
        const ids = [...new Set(r.group_ids)];
        c.push(ids.length === 1 ? { type: "group", id: ids[0] } : { op: "|", show: true, c: ids.map((id) => ({ type: "group", id })) });
    }
    if (r.grouping_id) {
        const gs = await ctx.read.session.transport.call("core_group_get_course_groupings", { courseid: courseId }, GroupingsSchema);
        if (!gs.some((g) => g.id === r.grouping_id && g.courseid === courseId)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El agrupamiento ${r.grouping_id} no es del curso.`);
        c.push({ type: "grouping", id: r.grouping_id });
    }
    if (!c.length) throw new CampusError("WRITE_NOT_ALLOWED", "restrictions vacío: indicá from, until, group_ids o grouping_id (o null para quitarlas).");
    const show = r.show_when_unmet ?? true;
    return JSON.stringify({ op: "&", c, showc: c.map(() => show) });
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const m = await moduleOf(ctx, input.course_id, input.course_module_id);
    const fields = await readModForm(ctx, m.cmid, m.kind);
    const catalog: Record<string, SettingDef> = { ...COMMON_SETTINGS, ...(KIND_SETTINGS[m.kind] ?? {}) };
    const controls: Record<string, Control | "json"> = {};
    const values: Record<string, string> = {};
    const labels: Record<string, string> = {};
    if (input.raw) {
        for (const [f, v] of Object.entries(input.raw)) {
            const d = Object.values(catalog).find((x) => x.field === f);
            controls[f] = f === RESTRICTIONS_FIELD ? "json" : d!.control;
            values[f] = v;
            labels[f] = f;
        }
    } else {
        for (const [key, v] of Object.entries(input.settings ?? {})) {
            const d = catalog[key];
            if (!d) throw new CampusError("WRITE_NOT_ALLOWED", `«${key}» no es un ajuste editable de ${m.kind}. Admitidos: ${Object.keys(catalog).join(", ")}.`);
            // Una casilla simple sin marcar no figura entre los campos servidos: sólo se exige para los demás controles.
            if (d.control !== "checkbox" && !fields.some(([n]) => n === d.field)) throw new CampusError("WRITE_NOT_ALLOWED", `«${key}» no está disponible en esta actividad.`);
            if (key === "grade_scale") {
                // ADR-095: la escala tiene que ser una de las que ofrece el formulario (curso y sitio).
                const html = await ctx.web.readPage("modedit_form", { update: String(m.cmid) });
                const sel = /<select\b[^>]*name="grade\[modgrade_scale\]"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
                const options = [...sel.matchAll(/<option\b[^>]*value="(\d+)"[^>]*>([^<]*)</g)].map((o) => `${o[1]} = ${o[2]!.trim()}`);
                if (!options.some((o) => o.startsWith(`${v} = `))) throw new CampusError("WRITE_NOT_ALLOWED", `La escala ${v} no está disponible. Escalas: ${options.join("; ") || "ninguna"}.`);
            }
            if (key === "grouping_id" && v !== 0) {
                const gs = await ctx.read.session.transport.call("core_group_get_course_groupings", { courseid: input.course_id }, GroupingsSchema);
                if (!gs.some((g) => g.id === Number(v) && g.courseid === input.course_id)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El agrupamiento ${v} no es del curso.`);
            }
            controls[d.field] = d.control;
            values[d.field] = toRaw(key, d, v);
            labels[d.field] = key;
        }
        if (input.restrictions !== undefined) {
            if (!fields.some(([n]) => n === RESTRICTIONS_FIELD)) throw new CampusError("WRITE_NOT_ALLOWED", "Esta actividad no admite restricciones de acceso.");
            controls[RESTRICTIONS_FIELD] = "json";
            values[RESTRICTIONS_FIELD] = await restrictionsJson(ctx, input.course_id, input.restrictions);
            labels[RESTRICTIONS_FIELD] = "restrictions";
        }
    }
    const prior: Record<string, string> = Object.fromEntries(Object.keys(values).map((f) => [f, currentValue(fields, f, controls[f]!) ?? ""]));
    const changed = Object.keys(values).filter((f) => (controls[f] === "json" ? canonical(values[f]!) !== canonical(prior[f]!) : values[f] !== prior[f]));
    if (!changed.length) throw new CampusError("WRITE_NOT_ALLOWED", "Los ajustes pedidos ya son los actuales.");
    if (m.kind === "assign" && changed.some((f) => ASSIGN_GRADE_FIELDS.includes(f)) && (await assignHasGrades(ctx, input.course_id, m.cmid))) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea ya tiene notas puestas: el tipo de nota, la escala, el método de calificación y el flujo de trabajo no se cambian por esta vía.");
    const want = Object.fromEntries(changed.map((f) => [f, values[f]!]));
    const was = Object.fromEntries(changed.map((f) => [f, prior[f]!]));
    const ctrl = Object.fromEntries(changed.map((f) => [f, controls[f]!]));
    const restr = changed.includes(RESTRICTIONS_FIELD);
    return {
        intent: "activity_settings",
        capability: "edit_activity",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Ajustes de «${m.name}» (${m.kind}): ${changed.map((f) => labels[f]).join(", ")}.`,
        payload_preview: { activity: { course_module_id: m.cmid, type: m.kind, name: m.name }, changes: changed.map((f) => ({ setting: labels[f], field: f, before: was[f], after: want[f] })) },
        side_effects: [
            "Cambia cómo funciona la actividad para los participantes. El resto de la configuración se reenvía tal cual. Sin notificación de cambio.",
            ...(restr ? ["Las restricciones de acceso deciden quién puede entrar a la actividad (y si la ven cuando no cumplen)."] : []),
            ...(changed.includes("groupmode") || changed.includes("groupingid") ? ["Cambiar grupos cambia qué ve cada participante en la actividad."] : []),
        ],
        preconditions: { description: "Los ajustes no cambiaron desde el plan.", versions: { [`cmsettings:${input.course_id}:${m.cmid}`]: JSON.stringify(Object.keys(ctrl).sort().map((f) => [f, ctrl[f] === "json" ? canonical(was[f]!) : was[f]])) } },
        undo: { kind: "compensación", how: "Volver a los valores anteriores.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus. Abrirlo copia los archivos de la actividad a un borrador privado."],
        items: [
            {
                item_id: "i1",
                description: `Ajustes de la actividad ${m.cmid}: ${changed.map((f) => labels[f]).join(", ")}`,
                call: { kind: "form", fn: `course_modedit_${m.kind}_update_settings`, params: { query: { update: String(m.cmid) }, fields: { ...want, coursecontentnotification: "0" } } },
                target: { course_id: input.course_id, cmid: m.cmid },
                expected: { kind: m.kind, controls: ctrl, values: want, prior: was },
            },
        ],
        prior_state: { raw: was },
        untrusted_fields: ["payload_preview.activity.name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

const value = z.union([z.string().max(64), z.number(), z.boolean()]);
const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la actividad."),
    settings: z.record(z.string().max(64), value).optional().describe("Ajustes por clave del catálogo (ADR-082). Comunes: group_mode (none|separate|visible), grouping_id, show_description. Por tipo: choice (allow_update, allow_multiple, show_results…), forum (forum_type, subscription, max_attachments…), glossary, data, choicegroup, assign (online_text, file_submissions, max_files…), quiz (grade_method, navigation, shuffle_answers, behaviour, review_<qué>_<cuándo>…), lesson, h5pactivity, book, wiki, folder, resource. Un error lista las claves admitidas."),
    restrictions: z
        .object({
            from: z.string().max(40).nullable().optional().describe("Disponible desde (AAAA-MM-DDTHH:MM, zona del perfil)."),
            until: z.string().max(40).nullable().optional().describe("Disponible hasta."),
            group_ids: z.array(z.number().int().positive()).max(50).optional().describe("Sólo para estos grupos (cualquiera de ellos)."),
            grouping_id: z.number().int().positive().optional().describe("Sólo para este agrupamiento."),
            show_when_unmet: z.boolean().optional().describe("Mostrarla (gris) a quien no cumple; por defecto true."),
        })
        .nullable()
        .optional()
        .describe("Reemplaza TODAS las restricciones de acceso de la actividad; null las quita."),
};

export const activitySettingsIntent: WriteIntent<typeof shape> = {
    name: "activity_settings",
    title: "Plan: cambiar ajustes de una actividad (grupos, restricciones y ajustes por tipo)",
    description:
        "Arma el plan para cambiar ajustes de una actividad existente: modo de grupos, agrupamiento, mostrar la descripción, restricciones de acceso (fechas, grupos, agrupamiento) y un catálogo de ajustes propios de cada tipo (consulta, foro, glosario, base de datos, elección de grupo, tarea, cuestionario, lección, H5P, libro, wiki, carpeta, archivo). Muestra antes y después. No escribe.",
    inputShape: shape,
    capability: "edit_activity",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        if (!Object.keys(input.settings ?? {}).length && input.restrictions === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá settings o restrictions.");
        return build(input, ctx, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const raw = (plan.prior_state as { raw: Record<string, string> }).raw;
        return { kind: "plan", draft: await build({ course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid), raw }, ctx, result.action_id) };
    },
};
