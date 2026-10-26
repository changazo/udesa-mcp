import { z } from "zod";
import { CampusError } from "../../errors.js";
import { AssignmentsSchema } from "../../moodle/schemas.js";
import { formatLocal } from "../../util/time.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { parseLocalDateTime } from "./w2.js";

/**
 * W6 · Cambiar fechas y límites de una tarea o un cuestionario existente, para TODOS (directiva §8.8
 * «Cambiar fechas de una actividad: por formulario de edición»; ADR-065).
 * - `/course/modedit.php?update=<cmid>`: el GET trae la configuración actual (y copia los archivos
 *   del módulo al borrador del usuario, efecto declarado); el POST manda SÓLO los campos que cambian
 *   sobre los valores que sirve Moodle. `coursecontentnotification` siempre en 0.
 * - Tarea: apertura de entregas, vencimiento, fecha límite y recordatorio de calificación.
 *   Cuestionario: apertura, cierre, límite de tiempo e intentos.
 * - Un valor `null` deshabilita la fecha (casilla omitida); ausente = sin cambios.
 * - Verificación: se relee la actividad por el servicio web y se comparan los valores.
 * - Deshacer: compensación con los valores anteriores (otro plan con la misma intención).
 * - ADR-080: también consultas (apertura y cierre), lecciones (disponible desde, fecha límite y límite
 *   de tiempo) y bases de datos (período para agregar entradas).
 */

const QuizzesSchema = z.object({
    quizzes: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), course: z.number().int(), name: z.string().nullable().optional(), timeopen: z.number().nullable().optional(), timeclose: z.number().nullable().optional(), timelimit: z.number().nullable().optional(), attempts: z.number().nullable().optional() })).default([]),
});

const ChoicesSchema = z.object({ choices: z.array(z.object({ coursemodule: z.number().int(), course: z.number().int(), name: z.string().nullable().optional(), timeopen: z.number().nullable().optional(), timeclose: z.number().nullable().optional() })).default([]) });
const LessonsSchema = z.object({ lessons: z.array(z.object({ coursemodule: z.number().int(), course: z.number().int(), name: z.string().nullable().optional(), available: z.number().nullable().optional(), deadline: z.number().nullable().optional(), timelimit: z.number().nullable().optional() })).default([]) });
const DatabasesSchema = z.object({ databases: z.array(z.object({ coursemodule: z.number().int(), course: z.number().int(), name: z.string().nullable().optional(), timeavailablefrom: z.number().nullable().optional(), timeavailableto: z.number().nullable().optional() })).default([]) });

const ModulesSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string() })).default([]) }));
type Kind = "assign" | "quiz" | "choice" | "lesson" | "data";
const LABEL: Record<Kind, string> = { assign: "la tarea", quiz: "el cuestionario", choice: "la consulta", lesson: "la lección", data: "la base de datos" };
/** Parámetros de la herramienta que admite cada tipo. */
const ALLOWED: Record<Kind, string[]> = { assign: ["open", "due", "cutoff", "grading_due"], quiz: ["open", "close", "time_limit_minutes", "attempts"], choice: ["open", "close"], lesson: ["open", "close", "time_limit_minutes"], data: ["open", "close"] };
/** Campo de la herramienta → campo del formulario y del servicio web. */
const DATE_FIELDS: Record<Kind, Record<string, string>> = {
    assign: { open: "allowsubmissionsfromdate", due: "duedate", cutoff: "cutoffdate", grading_due: "gradingduedate" },
    quiz: { open: "timeopen", close: "timeclose" },
    choice: { open: "timeopen", close: "timeclose" },
    lesson: { open: "available", close: "deadline" },
    data: { open: "timeavailablefrom", close: "timeavailableto" },
};

interface Current {
    kind: Kind;
    cmid: number;
    name: string;
    values: Record<string, number>;
}

async function current(ctx: IntentContext, courseId: number, cmid: number): Promise<Current> {
    const t = ctx.read.session.transport;
    const a = (await t.call("mod_assign_get_assignments", { courseids: [courseId] }, AssignmentsSchema)).courses.find((c) => c.id === courseId)?.assignments.find((x) => x.cmid === cmid);
    if (a) return { kind: "assign", cmid, name: a.name ?? String(cmid), values: { allowsubmissionsfromdate: a.allowsubmissionsfromdate ?? 0, duedate: a.duedate ?? 0, cutoffdate: a.cutoffdate ?? 0, gradingduedate: a.gradingduedate ?? 0 } };
    const q = (await t.call("mod_quiz_get_quizzes_by_courses", { courseids: [courseId] }, QuizzesSchema)).quizzes.find((x) => x.coursemodule === cmid && x.course === courseId);
    if (q) return { kind: "quiz", cmid, name: q.name ?? String(cmid), values: { timeopen: q.timeopen ?? 0, timeclose: q.timeclose ?? 0, timelimit: q.timelimit ?? 0, attempts: q.attempts ?? 0 } };
    // Consultas, lecciones y bases de datos (ADR-080): sólo se consulta la función del tipo real del módulo.
    const modname = (await t.call("core_course_get_contents", { courseid: courseId }, ModulesSchema)).flatMap((x) => x.modules).find((x) => x.id === cmid)?.modname;
    const c = modname !== "choice" ? undefined : (await t.call("mod_choice_get_choices_by_courses", { courseids: [courseId] }, ChoicesSchema)).choices.find((x) => x.coursemodule === cmid && x.course === courseId);
    if (c) return { kind: "choice", cmid, name: c.name ?? String(cmid), values: { timeopen: c.timeopen ?? 0, timeclose: c.timeclose ?? 0 } };
    const l = modname !== "lesson" ? undefined : (await t.call("mod_lesson_get_lessons_by_courses", { courseids: [courseId] }, LessonsSchema)).lessons.find((x) => x.coursemodule === cmid && x.course === courseId);
    if (l) return { kind: "lesson", cmid, name: l.name ?? String(cmid), values: { available: l.available ?? 0, deadline: l.deadline ?? 0, timelimit: l.timelimit ?? 0 } };
    const d = modname !== "data" ? undefined : (await t.call("mod_data_get_databases_by_courses", { courseids: [courseId] }, DatabasesSchema)).databases.find((x) => x.coursemodule === cmid && x.course === courseId);
    if (d) return { kind: "data", cmid, name: d.name ?? String(cmid), values: { timeavailablefrom: d.timeavailablefrom ?? 0, timeavailableto: d.timeavailableto ?? 0 } };
    throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es una tarea, cuestionario, consulta, lección ni base de datos del curso ${courseId}.`);
}

const iso = (unix: number, tz: string) => (unix ? formatLocal(new Date(unix * 1000), tz).slice(0, 16) : null);

/** Partes del selector de fecha (zona del perfil); 0 = deshabilitada (casilla en 0, que se omite). */
export function selector(key: string, unix: number, tz: string): Record<string, string> {
    if (!unix) return { [`${key}[enabled]`]: "0" };
    const l = formatLocal(new Date(unix * 1000), tz);
    return {
        [`${key}[enabled]`]: "1",
        [`${key}[day]`]: String(Number(l.slice(8, 10))),
        [`${key}[month]`]: String(Number(l.slice(5, 7))),
        [`${key}[year]`]: l.slice(0, 4),
        [`${key}[hour]`]: String(Number(l.slice(11, 13))),
        [`${key}[minute]`]: String(Number(l.slice(14, 16))),
    };
}

/** Campos del formulario para pasar de `from` a `to` (sólo lo que cambia). */
function formFields(kind: Kind, from: Record<string, number>, to: Record<string, number>, tz: string): Record<string, string> {
    const out: Record<string, string> = { coursecontentnotification: "0" };
    for (const [k, v] of Object.entries(to)) {
        if (from[k] === v) continue;
        if ((kind === "quiz" || kind === "lesson") && k === "timelimit") Object.assign(out, v ? { "timelimit[enabled]": "1", "timelimit[number]": String(Math.round(v / 60)), "timelimit[timeunit]": "60" } : { "timelimit[enabled]": "0" });
        else if (kind === "quiz" && k === "attempts") out.attempts = String(v);
        else Object.assign(out, selector(k, v, tz));
    }
    return out;
}

/** Orden de las fechas que valida Moodle (se adelanta en el plan). */
function assertOrder(kind: Kind, v: Record<string, number>) {
    const bad = (a: string, b: string) => v[a]! && v[b]! && v[b]! < v[a]!;
    if (kind === "assign") {
        if (bad("allowsubmissionsfromdate", "duedate")) throw new CampusError("WRITE_NOT_ALLOWED", "El vencimiento no puede ser anterior a la apertura de entregas.");
        if (bad("duedate", "cutoffdate")) throw new CampusError("WRITE_NOT_ALLOWED", "La fecha límite no puede ser anterior al vencimiento.");
        if (bad("duedate", "gradingduedate")) throw new CampusError("WRITE_NOT_ALLOWED", "El recordatorio de calificación no puede ser anterior al vencimiento.");
    } else {
        const { open, close } = DATE_FIELDS[kind] as { open: string; close: string };
        if (v[open] && v[close] && v[close]! <= v[open]!) throw new CampusError("WRITE_NOT_ALLOWED", "El cierre tiene que ser posterior a la apertura.");
    }
}

// ---------- versiones, interpretación y verificación ----------

/** `dates:<curso>:<cmid>` = valores actuales serializados. */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid] = k.split(":");
        out[k] = kind === "dates" ? JSON.stringify((await current(ctx, Number(course), Number(cmid))).values) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const now = (await current(ctx, plan.course_id, Number(item.target.cmid))).values;
    const want = item.expected.values as Record<string, number>;
    const prior = item.expected.prior as Record<string, number>;
    // El selector de fechas de Moodle guarda al minuto: se compara al minuto (una fecha original con segundos se restaura sin ellos).
    const norm = (k: string, v: number | undefined) => (v === undefined ? null : k === "attempts" ? v : Math.floor(v / 60));
    const differences: Difference[] = Object.entries(want).filter(([k, v]) => norm(k, now[k]) !== norm(k, v)).map(([k, v]) => ({ field: k, expected: v, observed: now[k] ?? null }));
    if (!differences.length) return { outcome: "coincide", checked: Object.keys(want), differences };
    const unchanged = Object.keys(want).every((k) => norm(k, now[k]) === norm(k, prior[k]));
    return { outcome: unchanged ? "sin_efecto" : "difiere", checked: Object.keys(want), differences };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

function draftFor(courseId: number, cur: Current, to: Record<string, number>, tz: string, undoOf: string | null): PlanDraft {
    const changed = Object.keys(to).filter((k) => cur.values[k] !== to[k]);
    const show = (k: string, v: number) => (k === "timelimit" ? (v ? `${Math.round(v / 60)} min` : "sin límite") : k === "attempts" ? (v ? String(v) : "ilimitados") : (iso(v, tz) ?? "deshabilitada"));
    const changes = changed.map((k) => ({ field: k, before: show(k, cur.values[k]!), after: show(k, to[k]!) }));
    const want = Object.fromEntries(changed.map((k) => [k, to[k]!]));
    return {
        intent: "edit_dates",
        capability: "edit_activity",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Cambiar en ${LABEL[cur.kind]} «${cur.name}»: ${changes.map((c) => `${c.field} ${c.before} → ${c.after}`).join("; ")}.`,
        payload_preview: { activity: { course_module_id: cur.cmid, type: cur.kind, name: cur.name }, changes, applies_to: "todos (las prórrogas y overrides individuales no cambian)", timezone: tz },
        side_effects: [
            "Cambia las fechas para todos y actualiza los eventos del calendario. Las prórrogas y overrides por alumno o grupo no cambian.",
            cur.kind === "quiz" || cur.kind === "lesson" ? "Los intentos en curso siguen las nuevas reglas de tiempo; los terminados no se recalculan." : cur.kind === "assign" ? "Las entregas ya hechas no cambian." : "Las respuestas o entradas ya hechas no cambian.",
            "Sin notificación de cambio de contenido (coursecontentnotification=0). El resto de la configuración queda tal cual.",
        ],
        preconditions: { description: "Las fechas no cambiaron desde el plan.", versions: { [`dates:${courseId}:${cur.cmid}`]: JSON.stringify(cur.values) } },
        undo: { kind: "compensación", how: "Volver a los valores anteriores con otro plan.", until: null },
        warnings: ["Edición por formulario web: requiere la sesión web del Campus. Abrirlo copia los archivos del módulo a tu borrador privado."],
        items: [
            {
                item_id: "i1",
                description: `Editar ${changed.join(", ")} de la actividad ${cur.cmid}`,
                call: { kind: "form", fn: `course_modedit_${cur.kind}_update`, params: { query: { update: String(cur.cmid) }, fields: formFields(cur.kind, cur.values, to, tz) } },
                target: { course_id: courseId, cmid: cur.cmid },
                expected: { values: want, prior: Object.fromEntries(changed.map((k) => [k, cur.values[k]!])) },
            },
        ],
        prior_state: { values: cur.values },
        untrusted_fields: ["payload_preview.activity.name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

// ---------- intención ----------

const date = z.string().max(40).nullable().optional();
const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de una tarea, cuestionario, consulta, lección o base de datos del curso."),
    open: date.describe("Tarea: apertura de entregas; cuestionario y consulta: apertura; lección: disponible desde; base de datos: desde cuándo se agregan entradas. AAAA-MM-DDTHH:MM (zona del perfil) o ISO con zona; null = deshabilitar; ausente = sin cambios."),
    close: date.describe("Cuestionario y consulta: cierre; lección: fecha límite; base de datos: hasta cuándo se agregan entradas."),
    due: date.describe("Tarea: vencimiento."),
    cutoff: date.describe("Tarea: fecha límite (después ya no se puede entregar)."),
    grading_due: date.describe("Tarea: recordatorio para calificar."),
    time_limit_minutes: z.number().int().min(0).max(1440).optional().describe("Cuestionario y lección: límite de tiempo en minutos (0 = sin límite)."),
    attempts: z.number().int().min(0).max(10).optional().describe("Cuestionario: intentos permitidos (0 = ilimitados)."),
};

export const editDatesIntent: WriteIntent<typeof shape> = {
    name: "edit_dates",
    title: "Plan: cambiar fechas de una tarea, cuestionario, consulta, lección o base de datos",
    description:
        "Arma el plan para cambiar, para todos, las fechas de una tarea (open, due, cutoff, grading_due), un cuestionario (open, close, time_limit_minutes, attempts), una consulta (open, close), una lección (open, close, time_limit_minutes) o una base de datos (open, close: período para agregar entradas). Muestra antes y después; el resto de la configuración no cambia. No escribe.",
    inputShape: shape,
    capability: "edit_activity",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const tz = ctx.profile.read_profile.timezone;
        const cur = await current(ctx, input.course_id, input.course_module_id);
        const allowed = ALLOWED[cur.kind];
        const given = (["open", "close", "due", "cutoff", "grading_due", "time_limit_minutes", "attempts"] as const).filter((k) => input[k] !== undefined);
        const wrong = given.filter((k) => !allowed.includes(k));
        if (wrong.length) throw new CampusError("WRITE_NOT_ALLOWED", `Para ${LABEL[cur.kind]} no corresponde: ${wrong.join(", ")}. Admite: ${allowed.join(", ")}.`);
        if (!given.length) throw new CampusError("WRITE_NOT_ALLOWED", "No se indicó ningún cambio.");
        const to = { ...cur.values };
        for (const k of given) {
            if (k === "time_limit_minutes") to.timelimit = input.time_limit_minutes! * 60;
            else if (k === "attempts") to.attempts = input.attempts!;
            else {
                const raw = input[k] as string | null;
                let unix = 0;
                if (raw !== null) {
                    const parsed = parseLocalDateTime(raw, tz);
                    if (parsed === null) throw new CampusError("WRITE_NOT_ALLOWED", `${k}: fecha inválida (${raw}). Usá AAAA-MM-DDTHH:MM.`);
                    unix = Math.floor(parsed / 60) * 60;
                }
                to[DATE_FIELDS[cur.kind][k]!] = unix;
            }
        }
        if (Object.keys(to).every((k) => to[k] === cur.values[k])) throw new CampusError("WRITE_NOT_ALLOWED", "Los valores pedidos ya son los actuales: no hay cambios.");
        assertOrder(cur.kind, to);
        return draftFor(input.course_id, cur, to, tz, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const item = plan.items[0]!;
        const cur = await current(ctx, plan.course_id, Number(item.target.cmid));
        const to = { ...cur.values, ...(item.expected.prior as Record<string, number>) };
        if (Object.keys(to).every((k) => to[k] === cur.values[k])) return { kind: "ninguno", reason: "Los valores ya son los anteriores." };
        return { kind: "plan", draft: draftFor(plan.course_id, cur, to, ctx.profile.read_profile.timezone, result.action_id) };
    },
};
