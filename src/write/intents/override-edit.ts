import { z } from "zod";
import { CampusError } from "../../errors.js";
import { AssignmentsSchema } from "../../moodle/schemas.js";
import { formatLocal } from "../../util/time.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { overrideForm, overrideIds } from "./assign-override.js";
import { selector } from "./edit-dates.js";
import { overridesOf } from "./quiz.js";
import { parseLocalDateTime } from "./w2.js";

/**
 * W6 · Editar una excepción EXISTENTE de un cuestionario o de una tarea (ADR-099), por los formularios
 * de edición (`/mod/quiz/overrideedit.php?id`, `/mod/assign/overrideedit.php?id`). El formulario servido
 * se reenvía tal cual salvo lo que cambia: la contraseña de la excepción de un cuestionario se conserva
 * (el servicio web la reemplazaría). Una fecha en null deja de estar sobrescrita (vale la de la actividad).
 * Verificación: `mod_quiz_get_overrides` o el formulario de la excepción. Deshacer: los valores anteriores.
 */

const QuizzesSchema = z.object({ quizzes: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), course: z.number().int(), name: z.string().nullable().optional() })).default([]) });

type Kind = "quiz" | "assign";
/** Valores comparables de una excepción (0 = no sobrescrito; null = no aplica a ese tipo). */
interface Values {
    open: number;
    close: number;
    due: number;
    cutoff: number;
    time_limit: number;
    attempts: number | null;
}

async function current(ctx: IntentContext, kind: Kind, activityId: number, overrideId: number): Promise<{ values: Values; who: string } | null> {
    if (kind === "quiz") {
        const o = (await overridesOf(ctx, activityId)).find((x) => x.id === overrideId);
        if (!o) return null;
        return { values: { open: o.timeopen ?? 0, close: o.timeclose ?? 0, due: 0, cutoff: 0, time_limit: o.timelimit ?? 0, attempts: o.attempts ?? null }, who: o.userid ? `participante ${o.userid}` : `grupo ${o.groupid}` };
    }
    const f = await overrideForm(ctx, overrideId).catch((e: unknown) => (e instanceof CampusError && e.code === "UNEXPECTED_RESPONSE" ? null : Promise.reject(e)));
    if (!f) return null;
    return { values: { open: f.values.allowsubmissionsfromdate, close: 0, due: f.values.duedate, cutoff: f.values.cutoffdate, time_limit: 0, attempts: null }, who: f.userid ? `participante ${f.userid}` : `grupo ${f.groupid}` };
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [tag, kind, act, id] = k.split(":");
        out[k] = tag === "ovr" ? JSON.stringify((await current(ctx, kind as Kind, Number(act), Number(id)))?.values ?? null) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected as { want: Partial<Values>; prior: Values };
    const now = (await current(ctx, t.kind as Kind, Number(t.activity_id), Number(t.override_id)))?.values;
    const keys = Object.keys(x.want) as (keyof Values)[];
    if (!now) return { outcome: "difiere", checked: keys, differences: [{ field: "excepción", expected: "existe", observed: "no aparece" }] };
    const differences: Difference[] = keys.filter((k) => now[k] !== x.want[k]).map((k) => ({ field: k, expected: x.want[k], observed: now[k] }));
    if (!differences.length) return { outcome: "coincide", checked: keys, differences };
    return { outcome: keys.every((k) => now[k] === x.prior[k]) ? "sin_efecto" : "difiere", checked: keys, differences };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

interface Req {
    course_id: number;
    quiz_id?: number;
    course_module_id?: number;
    override_id: number;
    open?: string | null;
    close?: string | null;
    due?: string | null;
    cutoff?: string | null;
    time_limit_minutes?: number | null;
    attempts?: number;
    /** Deshacer: valores exactos. */
    restore?: Values;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const tz = ctx.profile.read_profile.timezone;
    if ((input.quiz_id === undefined) === (input.course_module_id === undefined)) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá quiz_id (cuestionario) o course_module_id (tarea), uno de los dos.");
    const kind: Kind = input.quiz_id !== undefined ? "quiz" : "assign";
    let activityId: number;
    let name: string;
    if (kind === "quiz") {
        const q = (await ctx.read.session.transport.call("mod_quiz_get_quizzes_by_courses", { courseids: [input.course_id] }, QuizzesSchema)).quizzes.find((x) => x.id === input.quiz_id && x.course === input.course_id);
        if (!q) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El cuestionario ${input.quiz_id} no es del curso.`);
        activityId = q.id;
        name = q.name ?? String(q.id);
    } else {
        const a = (await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [input.course_id] }, AssignmentsSchema)).courses.find((c) => c.id === input.course_id)?.assignments.find((x) => x.cmid === input.course_module_id);
        if (!a) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${input.course_module_id} no es una tarea del curso.`);
        const ids = [...(await overrideIds(ctx, a.cmid!, "user")), ...(await overrideIds(ctx, a.cmid!, "group"))];
        if (!ids.includes(input.override_id)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La tarea no tiene la excepción ${input.override_id} (tiene: ${ids.join(", ") || "ninguna"}).`);
        activityId = a.cmid!;
        name = a.name ?? String(a.cmid);
    }
    const cur = await current(ctx, kind, activityId, input.override_id);
    if (!cur) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `${kind === "quiz" ? "El cuestionario" : "La tarea"} no tiene la excepción ${input.override_id}.`);
    const date = (v: string | null | undefined, label: string): number | undefined => {
        if (v === undefined) return undefined;
        if (v === null) return 0;
        const t = parseLocalDateTime(v, tz);
        if (t === null) throw new CampusError("WRITE_NOT_ALLOWED", `${label}: usá AAAA-MM-DDTHH:MM o ISO 8601 con zona (null = no sobrescribir).`);
        return t;
    };
    const r = input.restore;
    const want: Partial<Values> = {};
    const fields: Record<string, string> = {};
    const setDate = (key: keyof Values, field: string, v: number | undefined) => {
        if (v === undefined) return;
        want[key] = v;
        Object.assign(fields, selector(field, v, tz));
    };
    if (kind === "quiz") {
        if (!r && (input.due !== undefined || input.cutoff !== undefined)) throw new CampusError("WRITE_NOT_ALLOWED", "due y cutoff son de tareas; en un cuestionario: open, close, time_limit_minutes, attempts.");
        setDate("open", "timeopen", r ? r.open : date(input.open, "open"));
        setDate("close", "timeclose", r ? r.close : date(input.close, "close"));
        const limit = r ? r.time_limit : input.time_limit_minutes === undefined ? undefined : (input.time_limit_minutes ?? 0) * 60;
        if (limit !== undefined) {
            want.time_limit = limit;
            Object.assign(fields, limit ? { "timelimit[enabled]": "1", "timelimit[number]": String(limit / 60), "timelimit[timeunit]": "60" } : { "timelimit[enabled]": "0" });
        }
        const attempts = r ? (r.attempts ?? undefined) : input.attempts;
        if (attempts !== undefined) {
            want.attempts = attempts;
            fields.attempts = String(attempts);
        }
    } else {
        if (!r && (input.close !== undefined || input.time_limit_minutes !== undefined || input.attempts !== undefined)) throw new CampusError("WRITE_NOT_ALLOWED", "close, time_limit_minutes y attempts son de cuestionarios; en una tarea: open, due, cutoff.");
        setDate("open", "allowsubmissionsfromdate", r ? r.open : date(input.open, "open"));
        setDate("due", "duedate", r ? r.due : date(input.due, "due"));
        setDate("cutoff", "cutoffdate", r ? r.cutoff : date(input.cutoff, "cutoff"));
    }
    const keys = Object.keys(want) as (keyof Values)[];
    if (!keys.length) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá qué cambiar.");
    if (keys.every((k) => cur.values[k] === want[k])) throw new CampusError("WRITE_NOT_ALLOWED", "La excepción ya está así.");
    const after = { ...cur.values, ...want };
    if (after.open && after.close && after.close <= after.open) throw new CampusError("WRITE_NOT_ALLOWED", "El cierre tiene que ser posterior a la apertura.");
    if (after.due && after.cutoff && after.cutoff < after.due) throw new CampusError("WRITE_NOT_ALLOWED", "La fecha límite no puede ser anterior a la de entrega.");
    const local = (u: number) => (u ? formatLocal(new Date(u * 1000), tz).slice(0, 16) : "(la de la actividad)");
    const show = (v: Values) => (kind === "quiz" ? { open: local(v.open), close: local(v.close), time_limit_minutes: v.time_limit ? v.time_limit / 60 : "(el de la actividad)", attempts: v.attempts ?? "(los de la actividad)" } : { open: local(v.open), due: local(v.due), cutoff: local(v.cutoff) });
    return {
        intent: "override_edit",
        capability: kind === "quiz" ? "quiz_override" : "assign_override",
        course_id: input.course_id,
        base_risk: kind === "quiz" ? "R3" : "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Editar la excepción ${input.override_id} (${cur.who}) de «${name}»: ${keys.join(", ")}.`,
        payload_preview: { activity: { type: kind, id: activityId, name }, override_id: input.override_id, who: cur.who, before: show(cur.values), after: show(after) },
        side_effects: [`Cambia fechas${kind === "quiz" ? ", tiempo o intentos" : ""} sólo para ${cur.who.startsWith("grupo") ? "los miembros del grupo" : "ese participante"}; Moodle actualiza su calendario.`, ...(kind === "quiz" ? ["La contraseña de la excepción, si tiene, se conserva."] : []), "Sin notificaciones."],
        preconditions: { description: "La excepción no cambió desde el plan.", versions: { [`ovr:${kind}:${activityId}:${input.override_id}`]: JSON.stringify(cur.values) } },
        undo: { kind: "compensación", how: "Volver a los valores anteriores de la excepción.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [
            {
                item_id: "i1",
                description: `Editar la excepción ${input.override_id}`,
                call: { kind: "form", fn: kind === "quiz" ? "quiz_override_edit" : "assign_override_edit", params: { query: { id: String(input.override_id) }, fields } },
                target: { course_id: input.course_id, kind, activity_id: activityId, override_id: input.override_id },
                expected: { want, prior: cur.values },
            },
        ],
        prior_state: { values: cur.values },
        untrusted_fields: ["payload_preview.activity.name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

const dateArg = z.string().max(40).nullable().optional();
const shape = {
    course_id: z.number().int().positive(),
    quiz_id: z.number().int().positive().optional().describe("Cuestionario (o course_module_id para una tarea)."),
    course_module_id: z.number().int().positive().optional().describe("Tarea (cmid)."),
    override_id: z.number().int().positive().describe("La excepción (sale de campus_get_activity_settings con include_overrides)."),
    open: dateArg.describe("Apertura (cuestionario) o «permitir entregas desde» (tarea); null = no sobrescribir."),
    close: dateArg.describe("Cuestionario: cierre."),
    due: dateArg.describe("Tarea: fecha de entrega."),
    cutoff: dateArg.describe("Tarea: fecha límite."),
    time_limit_minutes: z.number().int().min(1).max(1440).nullable().optional().describe("Cuestionario: tiempo; null = el del cuestionario."),
    attempts: z.number().int().min(0).max(20).optional().describe("Cuestionario: intentos (0 = ilimitados)."),
};

export const overrideEditIntent: WriteIntent<typeof shape> = {
    name: "override_edit",
    title: "Plan: editar una excepción existente de un cuestionario o una tarea",
    description: "Arma el plan para cambiar fechas, tiempo o intentos de una excepción YA creada (de un participante o de un grupo), conservando lo demás (también la contraseña). No escribe. Sin notificaciones.",
    inputShape: shape,
    capability: "quiz_override",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: (input, ctx) => build(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const t = plan.items[0]!.target;
        const values = (plan.prior_state as { values: Values }).values;
        const base = t.kind === "quiz" ? { quiz_id: Number(t.activity_id) } : { course_module_id: Number(t.activity_id) };
        return { kind: "plan", draft: await build({ course_id: plan.course_id, ...base, override_id: Number(t.override_id), restore: values }, ctx, result.action_id) };
    },
};
