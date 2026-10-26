import { mayNotify } from "../policy.js";
import { z } from "zod";
import { CampusError } from "../../errors.js";
import { hasSubmissionRecord } from "../../domain/submission-guard.js";
import { AssignmentsSchema, AssignParticipantsSchema, GradeItemsSchema, SubmissionStatusSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { gradingArea } from "./grading-definition.js";

/**
 * W3 · Calificar y devolver una entrega (directiva §8.6; investigación [T] §2, §3, §7, §10).
 * Superficie: `mod_assign_submit_grading_form`, que VALIDA rango y escala y permite fijar la
 * notificación. El servidor fija explícitos los campos con valores por defecto peligrosos:
 * - `attemptnumber` (omitido = PRIMER intento [T §7.4]); el del último intento leído;
 * - `applytoall` = 0 (omitido = 1: aplica a todo el grupo);
 * - `addattempt` = 0 (no reabre);
 * - `sendstudentnotifications` explícito (por defecto el del perfil: no);
 * - el comentario de devolución se reenvía siempre (omitirlo puede anularlo [T §2.4]).
 * Rechazos en el plan: nota bloqueada o sobrescrita en el libro de calificaciones, rúbrica o guía,
 * marking workflow y escala (para eso está campus_plan_grade_advanced, ADR-095), corrección anónima, fuera de rango.
 */

const GradesSchema = z.object({
    assignments: z.array(z.object({ assignmentid: z.number().int(), grades: z.array(z.object({ userid: z.number().int(), attemptnumber: z.number().int().nullable().optional(), grade: z.string().nullable().optional(), grader: z.number().int().nullable().optional(), timemodified: z.number().int().nullable().optional() })).default([]) })).default([]),
});

async function assignmentOf(ctx: IntentContext, courseId: number, assignmentId: number) {
    const res = await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [courseId] }, AssignmentsSchema);
    const a = res.courses.find((c) => c.id === courseId)?.assignments.find((x) => x.id === assignmentId);
    if (!a) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La tarea ${assignmentId} no es del curso ${courseId}.`);
    return a;
}

/** Última nota del participante (assign_grades, intento más reciente). null = sin calificar. */
async function currentGrade(ctx: IntentContext, assignmentId: number, userId: number) {
    const res = GradesSchema.parse(await ctx.transport.call("mod_assign_get_grades", { assignmentids: [assignmentId] }));
    const rows = res.assignments.find((a) => a.assignmentid === assignmentId)?.grades.filter((g) => g.userid === userId) ?? [];
    const last = rows.sort((a, b) => (b.attemptnumber ?? 0) - (a.attemptnumber ?? 0))[0];
    const value = last?.grade !== undefined && last?.grade !== null && Number(last.grade) >= 0 ? Number(last.grade) : null;
    return { value, grader: last?.grader ?? null, timemodified: last?.timemodified ?? 0, attempt: last?.attemptnumber ?? null };
}

/** Comentario de devolución vigente (sólo si ya hay registro de entrega: ADR-052). */
async function currentComment(ctx: IntentContext, assignmentId: number, userId: number, hasRecord: boolean): Promise<{ html: string; attempt: number }> {
    if (!hasRecord) return { html: "", attempt: 0 };
    const s = await ctx.read.session.transport.call("mod_assign_get_submission_status", { assignid: assignmentId, userid: userId }, SubmissionStatusSchema);
    const plugin = s.feedback?.plugins?.find((p) => p.type === "comments");
    const html = plugin?.editorfields?.find((f) => (f.name ?? "").includes("comments"))?.text ?? plugin?.editorfields?.[0]?.text ?? "";
    const attempt = s.lastattempt?.submission?.attemptnumber ?? s.lastattempt?.teamsubmission?.attemptnumber ?? 0;
    return { html: html ?? "", attempt };
}

function parseGrade(raw: string | number, max: number): number {
    const v = typeof raw === "number" ? raw : Number(String(raw).trim().replace(",", "."));
    if (!Number.isFinite(v)) throw new CampusError("WRITE_NOT_ALLOWED", `La nota «${raw}» no es un número.`);
    if (v < 0 || v > max) throw new CampusError("WRITE_NOT_ALLOWED", `La nota ${v} está fuera de rango (0 a ${max}). Moodle la rechazaría en silencio [T §2.1].`);
    return Math.round(v * 100000) / 100000;
}

const fmt = (n: number) => String(n);

// ---------- motor de la intención ----------

async function readVersions(plan: Plan, ctx: IntentContext) {
    const out: Record<string, string | number | null> = {};
    for (const key of Object.keys(plan.preconditions.versions)) {
        const [k, a, u] = key.split(":");
        if (k === "grade") {
            const g = await currentGrade(ctx, Number(a), Number(u));
            out[key] = `${g.value ?? "none"}:${g.timemodified}`;
        } else out[key] = null;
    }
    return out;
}

function interpret(_item: PlanItem, data: unknown): Interpretation {
    // Devuelve external_warnings: «couldnotsavegrade» = la validación del formulario falló.
    if (Array.isArray(data) && data.length) {
        const w = data.map((x) => (x && typeof x === "object" && "message" in x ? String((x as { message: unknown }).message) : "aviso")).join(" · ");
        return { ok: false, reason: `Moodle no guardó la nota: ${w}` };
    }
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected;
    const g = await currentGrade(ctx, Number(t.assignment_id), Number(t.user_id));
    const differences: Difference[] = [];
    if (g.value !== x.grade) differences.push({ field: "grade", expected: x.grade, observed: g.value });
    const c = await currentComment(ctx, Number(t.assignment_id), Number(t.user_id), true);
    if (comparable(c.html) !== x.comment_text) differences.push({ field: "feedback_comment", expected: x.comment_text, observed: comparable(c.html) });
    if (!differences.length) return { outcome: "coincide", checked: ["grade", "feedback_comment"], differences };
    const unchanged = g.value === x.prior_grade && comparable(c.html) === x.prior_comment_text;
    return { outcome: unchanged ? "sin_efecto" : "difiere", checked: ["grade", "feedback_comment"], differences };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const shape = {
    course_id: z.number().int().positive(),
    assignment_id: z.number().int().positive().describe("assignment_id (no el course_module_id)."),
    participant_id: z.number().int().positive(),
    grade: z.union([z.number(), z.string().max(20)]).describe("Nota en puntos (acepta coma decimal)."),
    feedback_comment: z.string().max(20_000).optional().describe("Comentario de devolución (Markdown). Ausente = se conserva el actual."),
    notify_student: z.boolean().optional().describe("Por defecto, el del perfil (no). Notificar exige allow_participant_notifications."),
};

type Input = { course_id: number; assignment_id: number; participant_id: number; grade: number | string | null; feedback_html?: string; feedback_markdown?: string; notify_student?: boolean };

async function build(input: Input, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const a = await assignmentOf(ctx, input.course_id, input.assignment_id);
    const max = a.grade ?? 0;
    if (max < 0) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea se califica con escala: usá campus_plan_grade_advanced (ADR-095).");
    if (max === 0) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea no tiene calificación.");
    if (a.markingworkflow) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea usa flujo de trabajo de calificación: usá campus_plan_grade_advanced, que maneja su estado (ADR-095).");
    if (a.blindmarking && !a.revealidentities) throw new CampusError("WRITE_NOT_ALLOWED", "Corrección anónima: no se califica por esta vía (y nunca se revelan identidades).");
    if (a.teamsubmission) throw new CampusError("WRITE_NOT_ALLOWED", "Entrega grupal: todavía no se califica por esta vía (riesgo del «grupo por defecto» [T §2.9]).");
    // ADR-099: con rúbrica o guía, la nota sale de los criterios. Sin sesión web no se puede saber, pero Moodle rechaza el guardado incompleto.
    const method = a.cmid ? await gradingArea(ctx, input.course_id, a.cmid).then((x) => x.method).catch((e: unknown) => (e instanceof CampusError && e.code === "AUTH_REQUIRED" ? null : Promise.reject(e))) : null;
    if (method) throw new CampusError("WRITE_NOT_ALLOWED", `La tarea se califica con ${method === "rubric" ? "rúbrica" : "guía de evaluación"}: usá campus_plan_grade_advanced (niveles o puntajes por criterio).`);
    const participants = await ctx.read.session.transport.call(
        "mod_assign_list_participants",
        { assignid: a.id, groupid: 0, filter: "", skip: 0, limit: 0, onlyids: false, includeenrolments: false, tablesort: false },
        AssignParticipantsSchema,
    );
    const person = participants.find((p) => p.id === input.participant_id);
    if (!person) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${input.participant_id} no es participante de la tarea.`);
    // Nota bloqueada o sobrescrita en el libro: Moodle no la cambiaría pero sí guardaría la devolución [T §2.2].
    const report = await ctx.read.session.transport.call("gradereport_user_get_grade_items", { courseid: input.course_id, userid: input.participant_id }, GradeItemsSchema);
    const gi = report.usergrades.find((u) => u.userid === input.participant_id)?.gradeitems.find((i) => i.itemmodule === "assign" && i.iteminstance === a.id);
    if (gi && (gi.gradeislocked || gi.locked || gi.gradeisoverridden)) throw new CampusError("WRITE_NOT_ALLOWED", "La nota está bloqueada o sobrescrita en el libro de calificaciones: Moodle no la cambiaría (y sí guardaría la devolución).");
    const hasRecord = hasSubmissionRecord(participants, input.participant_id, false);
    const prior = await currentGrade(ctx, a.id, input.participant_id);
    const priorComment = await currentComment(ctx, a.id, input.participant_id, hasRecord);
    const attempt = Math.max(priorComment.attempt, prior.attempt ?? 0);
    const grade = input.grade === null ? null : parseGrade(input.grade, max);
    const commentHtml = input.feedback_html ?? (input.feedback_markdown !== undefined ? toHtml(input.feedback_markdown, "markdown") : priorComment.html);
    const notify = input.notify_student ?? ctx.profile.policy.notify_students_default;
    if (notify && !mayNotify(ctx.profile.policy, input.course_id, [input.participant_id])) throw new CampusError("WRITE_NOT_ALLOWED", "Notificar a este estudiante no está permitido por el perfil (allow_participant_notifications=false y no es una cuenta de prueba del sandbox, ADR-115).");
    const form = new URLSearchParams({
        grade: grade === null ? "" : fmt(grade),
        attemptnumber: String(attempt),
        applytoall: "0",
        addattempt: "0",
        sendstudentnotifications: notify ? "1" : "0",
        "assignfeedbackcomments_editor[text]": commentHtml,
        "assignfeedbackcomments_editor[format]": "1",
        "assignfeedbackcomments_editor[itemid]": "0",
    });
    const warnings: string[] = [];
    if (!hasRecord) warnings.push("El participante no tiene entrega: calificar crea su registro de entrega vacío (como en la web).");
    if (input.feedback_markdown === undefined && input.feedback_html === undefined && priorComment.html) warnings.push("Se reenvía el comentario de devolución actual sin cambios (omitirlo podría anularlo).");
    return {
        intent: "grade",
        capability: "grade_submission",
        course_id: input.course_id,
        base_risk: "R3",
        summary: `${undoOf ? "Deshacer: " : ""}calificar la entrega del participante ${input.participant_id} en «${a.name ?? a.id}»: ${prior.value ?? "sin nota"} → ${grade ?? "sin nota"} (sobre ${max})${notify ? ", NOTIFICANDO al estudiante" : ", sin notificar"}.`,
        payload_preview: {
            assignment: { assignment_id: a.id, name: a.name ?? null, max_grade: max },
            participant: { id: person.id, name: person.fullname ?? null },
            grade: { from: prior.value, to: grade },
            feedback_comment_html: { from: priorComment.html, to: commentHtml },
            attempt_number: attempt,
            apply_to_all: false,
            add_attempt: false,
            notify_student: notify,
        },
        side_effects: [
            "Libro de calificaciones: la nota pasa al ítem de la tarea (si la tarea está oculta, el ítem también).",
            "Eventos submission_graded. Puede aplicar penalización por entrega tardía (5.x).",
            notify ? "El estudiante recibe un mensaje en menos de un minuto: NO se puede deshacer." : "Sin notificación al estudiante.",
        ],
        preconditions: { description: "La nota no cambió desde el plan.", versions: { [`grade:${a.id}:${input.participant_id}`]: `${prior.value ?? "none"}:${prior.timemodified}` } },
        undo:
            prior.value === null
                ? { kind: "ninguno", how: "No había nota: volver a «sin nota» no es posible por el formulario (queda 0) sin notificar. Revisá bien antes de ejecutar.", until: null }
                : { kind: "compensación", how: "Volver a la nota y al comentario anteriores (guardados en el plan). Una notificación enviada no se deshace.", until: null },
        warnings,
        items: [
            {
                item_id: "i1",
                description: `Calificar al participante ${input.participant_id}`,
                call: { fn: "mod_assign_submit_grading_form", params: { assignmentid: a.id, userid: input.participant_id, jsonformdata: JSON.stringify(form.toString()) } },
                target: { course_id: input.course_id, assignment_id: a.id, user_id: input.participant_id },
                expected: { grade, comment_text: comparable(commentHtml), prior_grade: prior.value, prior_comment_text: comparable(priorComment.html) },
            },
        ],
        prior_state: { grade: prior.value, comment_html: priorComment.html },
        untrusted_fields: ["payload_preview.assignment.name", "payload_preview.participant.name", "payload_preview.feedback_comment_html.from"],
        teacher_text: input.feedback_markdown !== undefined ? { feedback: input.feedback_markdown } : {},
        undo_of: undoOf,
    };
}

export const gradeIntent: WriteIntent<typeof shape> = {
    name: "grade",
    title: "Plan: calificar y devolver una entrega",
    description: "Arma el plan para poner la nota (en puntos) y el comentario de devolución de UN participante en una tarea del curso. No escribe. Por defecto no notifica al estudiante.",
    inputShape: shape,
    capability: "grade_submission",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: (input, ctx) => build({ course_id: input.course_id, assignment_id: input.assignment_id, participant_id: input.participant_id, grade: input.grade, feedback_markdown: input.feedback_comment, notify_student: input.notify_student }, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const p = plan.prior_state as { grade: number | null; comment_html: string };
        // Observado en real (2026-10-19): «sin nota» por el formulario queda guardado como 0. Volver a
        // «sin nota» sólo sería posible con save_grade(-1), que notifica siempre: no se ofrece.
        if (p.grade === null) return { kind: "ninguno", reason: "No había nota antes: Moodle no permite volver a «sin nota» por el formulario (quedaría 0) y la otra vía notifica al estudiante. Si hace falta, borrá la nota desde la web." };
        const t = plan.items[0]!.target;
        return { kind: "plan", draft: await build({ course_id: plan.course_id, assignment_id: Number(t.assignment_id), participant_id: Number(t.user_id), grade: p.grade, feedback_html: p.comment_html, notify_student: false }, ctx, result.action_id) };
    },
};
