import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, WriteIntent } from "../intent.js";
import type { PlanDraft } from "../plan.js";
import { addSessionIntent, sessionsOf } from "./attendance.js";
import { overridesOf, quizOverrideIntent } from "./quiz.js";
import { assignOverrideIntent, overrideForm, overrideIds } from "./assign-override.js";
import { quizAddQuestionsIntent, quizOf, slotsOf } from "./quiz-slots.js";
import { quizHasAttempts } from "./quiz-structure-edit.js";

/**
 * W6 · Borrar elementos EXISTENTES que antes sólo se borraban como deshacer de lo creado por el MCP
 * (ADR-084): una sesión de asistencia, una excepción de cuestionario o de tarea, y una pregunta (slot)
 * de un cuestionario. Cada plan arma el MISMO ítem que el deshacer original y lleva la intención
 * original (`attendance_session`, `quiz_override`, `assign_override`, `quiz_add_questions`), así la
 * relectura la hace el verificador que ya maneja ese borrado. Sin deshacer automático (R3).
 */

const noInterpret = (): Interpretation => ({ ok: true });
/** Estas intenciones sólo arman planes; la verificación la hace la intención original del plan. */
const delegated = {
    readVersions: async () => ({}),
    interpret: noInterpret,
    verify: async () => {
        throw new CampusError("UNEXPECTED_RESPONSE", "La verificación corresponde a la intención original del plan.");
    },
    reconcile: async () => "desconocido" as const,
    undo: async () => ({ kind: "ninguno" as const, reason: "Un borrado no se deshace automáticamente." }),
};
const base = (intent: string, capability: PlanDraft["capability"], courseId: number, summary: string, preview: Record<string, unknown>, sideEffects: string[], risk: "R3" | "R4" = "R3"): Omit<PlanDraft, "items"> => ({
    intent,
    capability,
    course_id: courseId,
    base_risk: risk,
    summary,
    payload_preview: preview,
    side_effects: [...sideEffects, "Sin notificaciones."],
    preconditions: { description: "Sin precondición: la relectura verifica el borrado.", versions: {} },
    undo: { kind: "ninguno", how: "Un borrado no se deshace; se puede volver a crear.", until: null },
    warnings: ["Requiere la sesión web del Campus."],
    prior_state: {},
    untrusted_fields: [],
    teacher_text: {},
    undo_of: null,
});

// ---------- sesión de asistencia ----------

const sessionShape = { course_id: z.number().int().positive(), course_module_id: z.number().int().positive().describe("cmid de la asistencia."), session_id: z.number().int().positive().describe("Sesión (sale de campus_get_attendance o campus_list_attendance_sessions).") };
export const attendanceSessionDeleteIntent: WriteIntent<typeof sessionShape> = {
    name: "attendance_session_delete",
    title: "Plan: borrar una sesión de asistencia",
    description: "Arma el plan para borrar UNA sesión de una actividad de asistencia, con lo registrado en ella (R3; R4 si ya se tomó asistencia, ADR-119; sin deshacer). No escribe.",
    inputShape: sessionShape,
    capability: addSessionIntent.capability,
    synthetic_only: false,
    ...delegated,
    async plan(input, ctx: IntentContext) {
        const s = (await sessionsOf(ctx, input.course_module_id)).find((x) => x.session_id === input.session_id);
        if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La asistencia ${input.course_module_id} no tiene la sesión ${input.session_id}.`);
        return {
            ...base("attendance_session", addSessionIntent.capability, input.course_id, `BORRAR la sesión de asistencia del ${s.date_text ?? s.date ?? "?"} ${s.time_text ?? ""}${s.taken ? " (YA TOMADA: se pierden los registros)" : ""}.`, { session: { session_id: s.session_id, date: s.date, start: s.start_time, end: s.end_time, type: s.type_text, taken: s.taken, description: s.description } }, ["Se borra la sesión y lo registrado en ella (estados y observaciones).", ...(s.taken ? ["La sesión ya tiene asistencia tomada: cambian los totales y la nota de asistencia."] : [])], s.taken ? "R4" : "R3"),
            items: [{ item_id: "i1", description: `Borrar la sesión ${s.session_id}`, call: { kind: "form", fn: "attendance_session_delete", params: { query: {}, fields: { id: String(input.course_module_id), action: "3", sessionid: String(s.session_id), confirm: "1" } } }, target: { course_id: input.course_id, cmid: input.course_module_id, session_id: s.session_id }, expected: { deleted: true } }],
        };
    },
};

// ---------- excepción de cuestionario ----------

const quizOverrideShape = { course_id: z.number().int().positive(), quiz_id: z.number().int().positive(), override_id: z.number().int().positive().describe("Excepción (sale de campus_get_activity_settings con include_overrides).") };
export const quizOverrideDeleteIntent: WriteIntent<typeof quizOverrideShape> = {
    name: "quiz_override_delete",
    title: "Plan: borrar una excepción de un cuestionario",
    description: "Arma el plan para borrar UNA excepción (override) existente de un cuestionario, de un participante o de un grupo: vuelve a la configuración general (R3, sin deshacer). No escribe.",
    inputShape: quizOverrideShape,
    capability: quizOverrideIntent.capability,
    synthetic_only: false,
    ...delegated,
    async plan(input, ctx: IntentContext) {
        await quizOf(ctx, input.course_id, input.quiz_id);
        const o = (await overridesOf(ctx, input.quiz_id)).find((x) => x.id === input.override_id);
        if (!o) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El cuestionario ${input.quiz_id} no tiene la excepción ${input.override_id}.`);
        return {
            ...base("quiz_override", quizOverrideIntent.capability, input.course_id, `BORRAR la excepción ${o.id} del cuestionario ${input.quiz_id} (${o.groupid ? `grupo ${o.groupid}` : `participante ${o.userid}`}).`, { override: { override_id: o.id, user_id: o.userid ?? null, group_id: o.groupid ?? null, timeopen: o.timeopen ?? null, timeclose: o.timeclose ?? null, timelimit: o.timelimit ?? null, attempts: o.attempts ?? null } }, ["El participante o el grupo vuelve a las fechas, el tiempo y los intentos generales del cuestionario."]),
            items: [{ item_id: "i1", description: `Borrar la excepción ${o.id}`, call: { kind: "ajax", fn: "mod_quiz_delete_overrides", params: { data: { quizid: input.quiz_id, ids: [o.id] } } }, target: { course_id: input.course_id, quiz_id: input.quiz_id, override_id: o.id, ...(o.groupid ? { group_id: o.groupid } : { user_id: o.userid ?? 0 }) }, expected: { deleted: true } }],
        };
    },
};

// ---------- excepción de tarea ----------

const assignOverrideShape = { course_id: z.number().int().positive(), course_module_id: z.number().int().positive().describe("cmid de la tarea."), override_id: z.number().int().positive(), kind: z.enum(["user", "group"]).describe("Excepción de un participante o de un grupo.") };
export const assignOverrideDeleteIntent: WriteIntent<typeof assignOverrideShape> = {
    name: "assign_override_delete",
    title: "Plan: borrar una excepción de una tarea",
    description: "Arma el plan para borrar UNA excepción de fechas existente de una tarea (de un participante o de un grupo): vuelve a las fechas generales (R3, sin deshacer). No escribe.",
    inputShape: assignOverrideShape,
    capability: assignOverrideIntent.capability,
    synthetic_only: false,
    ...delegated,
    async plan(input, ctx: IntentContext) {
        const ids = await overrideIds(ctx, input.course_module_id, input.kind);
        if (!ids.includes(input.override_id)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La tarea ${input.course_module_id} no tiene la excepción de ${input.kind === "group" ? "grupo" : "participante"} ${input.override_id}.`);
        const f = await overrideForm(ctx, input.override_id);
        return {
            ...base("assign_override", assignOverrideIntent.capability, input.course_id, `BORRAR la excepción ${input.override_id} de la tarea ${input.course_module_id}.`, { override: { override_id: input.override_id, kind: input.kind, user_id: f.userid, group_id: f.groupid, dates: f.values } }, ["El participante o el grupo vuelve a las fechas de la tarea (o a su prórroga, si tiene)."]),
            items: [{ item_id: "i1", description: `Borrar la excepción ${input.override_id}`, call: { kind: "form", fn: "assign_override_delete", params: { query: {}, fields: { id: String(input.override_id), confirm: "1" } } }, target: { course_id: input.course_id, cmid: input.course_module_id, override_id: input.override_id, ...(input.kind === "group" && f.groupid ? { group_id: f.groupid } : {}) }, expected: { deleted: true } }],
        };
    },
};

// ---------- pregunta (slot) de un cuestionario ----------

const slotShape = { course_id: z.number().int().positive(), quiz_id: z.number().int().positive(), slot_id: z.number().int().positive().describe("Slot (sale de campus_get_quiz_structure).") };
export const quizRemoveQuestionIntent: WriteIntent<typeof slotShape> = {
    name: "quiz_remove_question",
    title: "Plan: quitar una pregunta de un cuestionario",
    description: "Arma el plan para quitar UNA pregunta (slot) de un cuestionario sin intentos; la pregunta sigue en el banco (R3, sin deshacer: se vuelve a agregar con campus_plan_quiz_add_questions). No escribe.",
    inputShape: slotShape,
    capability: quizAddQuestionsIntent.capability,
    synthetic_only: false,
    ...delegated,
    async plan(input, ctx: IntentContext) {
        const q = await quizOf(ctx, input.course_id, input.quiz_id);
        const s = (await slotsOf(ctx, input.quiz_id)).find((x) => x.slot_id === input.slot_id);
        if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El cuestionario ${input.quiz_id} no tiene el slot ${input.slot_id}.`);
        if (q.coursemodule && (await quizHasAttempts(ctx, q.coursemodule))) throw new CampusError("WRITE_NOT_ALLOWED", "El cuestionario ya tiene intentos: Moodle no deja cambiar sus preguntas.");
        return {
            ...base("quiz_add_questions", quizAddQuestionsIntent.capability, input.course_id, `Quitar del cuestionario ${input.quiz_id} el slot ${s.slot_id} («${s.name ?? "?"}»).`, { slot: { slot_id: s.slot_id, name: s.name ?? null, max_mark: s.max_mark ?? null } }, ["Quita la pregunta del cuestionario; sigue en el banco."]),
            items: [{ item_id: "i1", description: `Quitar el slot ${s.slot_id}`, call: { kind: "form", fn: "quiz_remove_slot", params: { query: {}, fields: { quizid: String(input.quiz_id), class: "resource", action: "DELETE", id: String(s.slot_id) } } }, target: { course_id: input.course_id, quiz_id: input.quiz_id, slot_id: s.slot_id }, expected: { removed: true } }],
            untrusted_fields: ["payload_preview.slot.name"],
        };
    },
};

export const REMOVE_EXISTING_INTENTS = [attendanceSessionDeleteIntent, quizOverrideDeleteIntent, assignOverrideDeleteIntent, quizRemoveQuestionIntent];
