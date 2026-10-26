import { mayNotify } from "../policy.js";
import { z } from "zod";
import { CampusError } from "../../errors.js";
import { AttemptReviewSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { toHtml } from "../text.js";

/**
 * W6 · Calificación manual de UNA pregunta de un intento de cuestionario (directiva: «Calificación
 * manual de cuestionarios: formulario /mod/quiz/comment.php (con sequencecheck)»; investigación [T] §17;
 * ADR-071).
 * - Formulario `comment.php?attempt&slot`: no es un moodleform (sin _qf__); se reenvían sus valores
 *   (incluido `:sequencecheck`, sin el cual Moodle IGNORA el slot en silencio) y se pisan nota y comentario.
 * - Moodle avisa al estudiante cuando termina la calificación manual de su intento (tarea de
 *   notificaciones de calificación). Con allow_participant_notifications=false sólo se califican
 *   intentos PROPIOS (vistas previas del docente).
 * - Verificación: `mod_quiz_get_attempt_review` (nota del slot). Deshacer: la nota anterior.
 */

async function review(ctx: IntentContext, attemptId: number) {
    return ctx.read.session.transport.call("mod_quiz_get_attempt_review", { attemptid: attemptId, page: -1 }, AttemptReviewSchema);
}
const markOf = (q: { mark?: string | number | null } | undefined) => {
    if (!q || q.mark === null || q.mark === undefined || q.mark === "") return null;
    const n = Number(String(q.mark).replace(",", "."));
    return Number.isFinite(n) ? n : null;
};

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, attempt, slot] = k.split(":");
        out[k] = kind === "qmark" ? String(markOf((await review(ctx, Number(attempt))).questions.find((q) => q.slot === Number(slot)))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const now = markOf((await review(ctx, Number(t.attempt_id))).questions.find((q) => q.slot === Number(t.slot)));
    const want = item.expected.mark as number | null;
    if (now === want) return { outcome: "coincide", checked: ["mark"], differences: [] };
    return { outcome: now === (item.expected.prior as number | null) ? "sin_efecto" : "difiere", checked: ["mark"], differences: [{ field: "mark", expected: want, observed: now }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

function draftFor(courseId: number, a: { attempt: number; slot: number; quiz: number; user: number; max: number }, prior: number | null, mark: number, commentHtml: string | null, undoOf: string | null): PlanDraft {
    const fields: Record<string, string> = { mark: String(mark) };
    if (commentHtml !== null) Object.assign(fields, { comment: commentHtml });
    return {
        intent: "quiz_grade",
        capability: "grade_quiz",
        course_id: courseId,
        base_risk: "R3",
        summary: `${undoOf ? "Deshacer: " : ""}Calificar a mano la pregunta ${a.slot} del intento ${a.attempt}: ${prior ?? "sin calificar"} → ${mark}/${a.max}.`,
        payload_preview: { attempt_id: a.attempt, quiz_id: a.quiz, slot: a.slot, attempt_user: a.user, before: prior, after: mark, max: a.max, ...(commentHtml !== null ? { comment_html: commentHtml } : {}) },
        side_effects: ["Recalcula la nota del intento y, si es la que cuenta, la del libro de calificaciones.", "Al terminar la calificación manual Moodle puede avisar al dueño del intento."],
        preconditions: { description: "La nota del slot no cambió desde el plan.", versions: { [`qmark:${a.attempt}:${a.slot}`]: String(prior) } },
        undo: prior === null ? { kind: "ninguno", how: "Una pregunta calificada no vuelve a «sin calificar» desde el formulario.", until: null } : { kind: "exacto", how: `Volver a ${prior}.`, until: null },
        warnings: [],
        items: [
            {
                item_id: "i1",
                description: `Nota ${mark} en la pregunta ${a.slot} del intento ${a.attempt}`,
                call: { kind: "form", fn: "quiz_manual_grade", params: { query: { attempt: String(a.attempt), slot: String(a.slot) }, fields } },
                target: { course_id: courseId, attempt_id: a.attempt, slot: a.slot, quiz_id: a.quiz, user_id: a.user, max: a.max },
                expected: { mark, prior },
            },
        ],
        prior_state: { mark: prior },
        untrusted_fields: [],
        teacher_text: commentHtml !== null ? { comment: commentHtml } : {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    attempt_id: z.number().int().positive(),
    slot: z.number().int().positive().describe("Número de slot de la pregunta en el intento."),
    mark: z.number().min(0).describe("Nota de la pregunta (entre 0 y su máximo)."),
    comment: z.string().max(10_000).optional().describe("Comentario para la pregunta (Markdown)."),
};

export const quizGradeIntent: WriteIntent<typeof shape> = {
    name: "quiz_grade",
    title: "Plan: calificar a mano una pregunta de un intento",
    description:
        "Arma el plan para calificar a mano UNA pregunta (p. ej. un ensayo) de un intento terminado, con comentario opcional. Mientras el perfil no permita notificar a participantes, sólo intentos propios (vistas previas). No escribe.",
    inputShape: shape,
    capability: "grade_quiz",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const r = await review(ctx, input.attempt_id);
        const at = r.attempt as { id?: number; quiz?: number; userid?: number; state?: string | null };
        const quizzes = (await ctx.read.session.transport.call("mod_quiz_get_quizzes_by_courses", { courseids: [input.course_id] }, z.object({ quizzes: z.array(z.object({ id: z.number().int(), course: z.number().int() })).default([]) }))).quizzes;
        if (!quizzes.some((q) => q.id === at.quiz && q.course === input.course_id)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El intento ${input.attempt_id} no es de un cuestionario del curso ${input.course_id}.`);
        if (at.state !== "finished") throw new CampusError("WRITE_NOT_ALLOWED", "Sólo se califican intentos terminados.");
        const mine = (await ctx.read.session.verified()).info.userid;
        if (at.userid !== mine && !mayNotify(ctx.profile.policy, input.course_id, at.userid ? [at.userid] : [])) {
            throw new CampusError("WRITE_NOT_ALLOWED", "Calificar a mano el intento de un estudiante puede notificarlo (aviso de calificación terminada) y el perfil no permite notificarle. Sólo intentos propios (vistas previas) o de las cuentas de prueba del sandbox (ADR-115).");
        }
        const q = r.questions.find((x) => x.slot === input.slot);
        if (!q) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El intento no tiene la pregunta ${input.slot}.`);
        const max = q.maxmark ?? 0;
        if (input.mark > max) throw new CampusError("WRITE_NOT_ALLOWED", `La nota máxima de la pregunta es ${max}.`);
        const prior = markOf(q);
        const mark = Math.round(input.mark * 100) / 100;
        const comment = input.comment !== undefined ? toHtml(input.comment, "markdown") : null;
        if (prior === mark && comment === null) throw new CampusError("WRITE_NOT_ALLOWED", "Esa ya es la nota de la pregunta.");
        return draftFor(input.course_id, { attempt: input.attempt_id, slot: input.slot, quiz: at.quiz!, user: at.userid!, max }, prior, mark, comment, null);
    },
    async undo(plan, result) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const it = plan.items[0]!;
        const prior = it.expected.prior as number | null;
        if (prior === null) return { kind: "ninguno", reason: "La pregunta no tenía nota: no vuelve a «sin calificar» desde el formulario." };
        const t = it.target;
        return { kind: "plan", draft: draftFor(plan.course_id, { attempt: Number(t.attempt_id), slot: Number(t.slot), quiz: Number(t.quiz_id), user: Number(t.user_id), max: Number(t.max) }, it.expected.mark as number, prior, null, result.action_id) };
    },
};
