import { z } from "zod";
import { CampusError } from "../../errors.js";
import { hasSubmissionRecord } from "../../domain/submission-guard.js";
import { AssignmentsSchema, AssignParticipantsSchema, AttemptReviewSchema, EnrolledUsersSchema, QuizAttemptsSchema, QuizzesSchema, SubmissionStatusSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * ADR-119 · Trabajo de los estudiantes (R4 salvo devolver a borrador):
 * - Borrar intentos de un cuestionario: el formulario del informe de calificaciones
 *   (`/mod/quiz/report.php`, POST `id`, `mode=overview`, `attemptid[]`, `delete=1`, sesskey). Moodle sólo
 *   borra intentos de participantes del informe (no vistas previas) y exige mod/quiz:deleteattempts.
 *   Recalcula la nota del cuestionario. Uno por ítem. Verificación: el intento ya no aparece en
 *   `mod_quiz_get_user_attempts`.
 * - Entregas de una tarea: devolver a borrador (`action=reverttodraft`, R3: el archivo queda) o borrar
 *   la entrega (`action=removesubmission`, R4). Borrar entregas ajenas exige
 *   mod/assign:editothersubmission, que el rol docente no suele tener: el plan lee antes la página de
 *   confirmación (sin escribir) y, si Moodle no lo permite, lo dice. Tareas grupales: no. Moodle no avisa
 *   al estudiante en ninguno de los dos casos. Verificación: el estado de la entrega en
 *   `mod_assign_list_participants` (nunca get_submission_status sin registro: crea entregas, ADR-051).
 */

const fmtDate = (unix: number | null | undefined, tz: string) => (unix ? new Date(unix * 1000).toLocaleString("es-AR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "sin terminar");

// ---------- intentos de cuestionario ----------

async function userAttempts(ctx: IntentContext, quizId: number, userId: number) {
    return (await ctx.read.session.transport.call("mod_quiz_get_user_attempts", { quizid: quizId, userid: userId, status: "all", includepreviews: true }, QuizAttemptsSchema)).attempts;
}

async function readAttemptVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, quiz, user, attempt] = k.split(":");
        out[k] = kind === "qattempt" ? ((await userAttempts(ctx, Number(quiz), Number(user))).find((a) => a.id === Number(attempt))?.state ?? null) : null;
    }
    return out;
}

async function verifyAttempt(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const still = (await userAttempts(ctx, Number(t.quiz_id), Number(t.user_id))).some((a) => a.id === Number(t.attempt_id));
    return still ? { outcome: "sin_efecto", checked: ["intento"], differences: [{ field: "intento", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["intento"], differences: [] };
}

const okInterpret = (): Interpretation => ({ ok: true });
const reconcileBy =
    (verify: (i: PlanItem, p: Plan, c: IntentContext) => Promise<ItemVerification>) =>
    async (item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> => {
        const v = await verify(item, plan, ctx);
        return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
    };

const attemptShape = {
    course_id: z.number().int().positive(),
    attempt_ids: z.array(z.number().int().positive()).min(1).max(20).describe("Intentos a borrar, todos del MISMO cuestionario (salen de campus_get_quiz_attempts)."),
};

export const quizAttemptDeleteIntent: WriteIntent<typeof attemptShape> = {
    name: "quiz_attempt_delete",
    title: "Plan: borrar intentos de un cuestionario (R4)",
    description:
        "Arma el plan para BORRAR intentos de estudiantes en un cuestionario (p. ej. para que vuelva a rendir quien tuvo un problema técnico). Se pierden sus respuestas y la nota se recalcula. No borra vistas previas del docente. Sin deshacer. No escribe.",
    inputShape: attemptShape,
    capability: "delete_student_work",
    synthetic_only: false,
    readVersions: readAttemptVersions,
    interpret: okInterpret,
    verify: verifyAttempt,
    reconcile: reconcileBy(verifyAttempt),
    async plan(input, ctx): Promise<PlanDraft> {
        if (new Set(input.attempt_ids).size !== input.attempt_ids.length) throw new CampusError("WRITE_NOT_ALLOWED", "attempt_ids repite un intento.");
        const attempts: z.infer<typeof AttemptReviewSchema>["attempt"][] = [];
        for (const id of input.attempt_ids) attempts.push((await ctx.read.session.transport.call("mod_quiz_get_attempt_review", { attemptid: id, page: -1 }, AttemptReviewSchema)).attempt);
        const quizIds = new Set(attempts.map((a) => a.quiz));
        if (quizIds.size !== 1) throw new CampusError("WRITE_NOT_ALLOWED", "Los intentos son de cuestionarios distintos: un plan por cuestionario.");
        const quizzes = (await ctx.read.session.transport.call("mod_quiz_get_quizzes_by_courses", { courseids: [input.course_id] }, QuizzesSchema)).quizzes;
        const quiz = quizzes.find((q) => q.id === attempts[0]!.quiz && q.course === input.course_id);
        if (!quiz) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Los intentos no son de un cuestionario del curso ${input.course_id}.`);
        if (attempts.some((a) => a.preview)) throw new CampusError("WRITE_NOT_ALLOWED", "Hay vistas previas del docente: Moodle no las borra por el informe (se descartan solas al editar el cuestionario).");
        const users = await ctx.read.session.transport.call("core_enrol_get_enrolled_users", { courseid: input.course_id }, EnrolledUsersSchema);
        const nameOf = (id: number) => users.find((u) => u.id === id)?.fullname ?? `participante ${id}`;
        const tz = ctx.profile.read_profile.timezone;
        const rows = attempts.map((a) => ({ attempt_id: a.id, user_id: a.userid, name: nameOf(a.userid), number: a.attempt ?? null, state: a.state ?? null, sumgrades: a.sumgrades ?? null, finished: fmtDate(a.timefinish, tz) }));
        const people = new Set(rows.map((r) => r.user_id)).size;
        const items: PlanItem[] = rows.map((r, i) => ({
            item_id: `i${i + 1}`,
            description: `Borrar el intento ${r.number ?? "?"} de «${r.name}» (${r.attempt_id})`,
            call: { kind: "form", fn: "quiz_attempt_delete", params: { query: {}, fields: { id: String(quiz.coursemodule), mode: "overview", "attemptid[]": String(r.attempt_id), delete: "1" } } },
            target: { course_id: input.course_id, quiz_id: quiz.id, user_id: r.user_id, attempt_id: r.attempt_id },
            expected: { deleted: true },
        }));
        return {
            intent: "quiz_attempt_delete",
            capability: "delete_student_work",
            course_id: input.course_id,
            base_risk: "R4",
            summary: `BORRAR ${rows.length} intento(s) de ${people} estudiante(s) en el cuestionario «${quiz.name ?? quiz.id}».`,
            payload_preview: { quiz: { quiz_id: quiz.id, course_module_id: quiz.coursemodule, name: quiz.name ?? null }, attempts: rows },
            side_effects: [
                `Intentos: ${rows.map((r) => `«${r.name}», intento ${r.number ?? "?"} (${r.state === "finished" ? `terminado ${r.finished}` : (r.state ?? "?")}${r.sumgrades !== null ? `, puntaje ${r.sumgrades}` : ""})`).join("; ")}.`,
                "Se pierden sus respuestas; la nota del cuestionario se recalcula con los intentos que queden y, si quedan intentos permitidos, pueden volver a rendir.",
                "Moodle no avisa a los estudiantes.",
            ],
            preconditions: { description: "Los intentos siguen como en el plan.", versions: Object.fromEntries(rows.map((r) => [`qattempt:${quiz.id}:${r.user_id}:${r.attempt_id}`, r.state])) },
            undo: { kind: "ninguno", how: "Un intento borrado no se recupera.", until: null },
            warnings: ["R4: borra trabajo de estudiantes.", "Formulario web: requiere la sesión web del Campus."],
            items,
            prior_state: {},
            untrusted_fields: ["payload_preview.quiz.name", "payload_preview.attempts"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo() {
        return { kind: "ninguno", reason: "Un intento borrado no se recupera." };
    },
};

// ---------- entregas de tareas ----------

async function participantsOf(ctx: IntentContext, assignmentId: number) {
    return ctx.read.session.transport.call("mod_assign_list_participants", { assignid: assignmentId, groupid: 0, filter: "", skip: 0, limit: 0, onlyids: false, includeenrolments: false, tablesort: false }, AssignParticipantsSchema);
}

async function readSubmissionVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, assign, user] = k.split(":");
        out[k] = kind === "subst" ? ((await participantsOf(ctx, Number(assign))).find((p) => p.id === Number(user))?.submissionstatus ?? null) : null;
    }
    return out;
}

async function verifySubmission(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const status = (await participantsOf(ctx, Number(t.assignment_id))).find((p) => p.id === Number(t.user_id))?.submissionstatus ?? "";
    const want = item.expected.status as string;
    const ok = want === "draft" ? status === "draft" : status === "" || status === "new" || status === "reopened";
    if (ok) return { outcome: "coincide", checked: ["estado"], differences: [] };
    return { outcome: status === item.expected.prior ? "sin_efecto" : "difiere", checked: ["estado"], differences: [{ field: "estado", expected: want === "draft" ? "draft" : "sin entrega", observed: status || "sin entrega" }] };
}

/** Moodle muestra la confirmación de borrar la entrega sólo si el docente puede editar entregas ajenas. */
export function removeConfirmAllowed(html: string): boolean {
    return /name="action"\s+value="removesubmission"|value="removesubmission"\s+name="action"|action=removesubmission(?:&|&amp;|")/.test(html);
}

const submissionShape = {
    course_id: z.number().int().positive(),
    assignment_id: z.number().int().positive(),
    participant_ids: z.array(z.number().int().positive()).min(1).max(20),
    operation: z.enum(["revert_to_draft", "remove"]).describe("revert_to_draft: vuelve a borrador para que la corrija y la reenvíe (R3, el archivo queda). remove: BORRA la entrega (R4)."),
};

export const assignSubmissionResetIntent: WriteIntent<typeof submissionShape> = {
    name: "assign_submission_reset",
    title: "Plan: devolver a borrador o borrar entregas de una tarea",
    description:
        "Arma el plan para devolver a borrador entregas enviadas (R3: el estudiante puede corregirla y reenviarla; el archivo queda) o BORRARLAS (R4: se pierden archivos y texto; Moodle lo permite sólo si el docente puede editar entregas ajenas). Tareas individuales. Moodle no avisa al estudiante. No escribe.",
    inputShape: submissionShape,
    capability: "delete_student_work",
    synthetic_only: false,
    readVersions: readSubmissionVersions,
    interpret: okInterpret,
    verify: verifySubmission,
    reconcile: reconcileBy(verifySubmission),
    async plan(input, ctx): Promise<PlanDraft> {
        if (new Set(input.participant_ids).size !== input.participant_ids.length) throw new CampusError("WRITE_NOT_ALLOWED", "participant_ids repite un participante.");
        const res = await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [input.course_id] }, AssignmentsSchema);
        const a = res.courses.find((c) => c.id === input.course_id)?.assignments.find((x) => x.id === input.assignment_id);
        if (!a) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La tarea ${input.assignment_id} no es del curso ${input.course_id}.`);
        if (a.teamsubmission) throw new CampusError("WRITE_NOT_ALLOWED", "Es una tarea grupal: la entrega es del grupo entero. No se hace por esta vía.");
        const list = await participantsOf(ctx, a.id);
        const remove = input.operation === "remove";
        const rows = [];
        for (const id of input.participant_ids) {
            const p = list.find((x) => x.id === id);
            if (!p) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${id} no figura en la tarea.`);
            const status = p.submissionstatus ?? "";
            if (remove ? !["submitted", "draft"].includes(status) : status !== "submitted") throw new CampusError("WRITE_NOT_ALLOWED", `«${p.fullname ?? id}» no tiene una entrega ${remove ? "para borrar" : "enviada para devolver a borrador"} (estado: ${status || "sin entrega"}).`);
            // Archivos de la entrega: sólo con registro (si no, get_submission_status la crearía, ADR-051).
            let files = 0;
            if (hasSubmissionRecord(list, id, false)) {
                const s = await ctx.read.session.transport.call("mod_assign_get_submission_status", { assignid: a.id, userid: id }, SubmissionStatusSchema);
                files = (s.lastattempt?.submission?.plugins ?? []).flatMap((pl) => (pl.fileareas ?? []).flatMap((fa) => fa.files ?? [])).length;
            }
            rows.push({ user_id: id, name: p.fullname ?? `participante ${id}`, status, files });
        }
        if (remove) {
            // Lectura de la confirmación (no escribe): si Moodle no deja borrar entregas ajenas, se dice acá.
            // En UdeSA (2026-10-22) Moodle responde «nopermission» con HTTP 404 a la cuenta docente.
            const denied = new CampusError("MOODLE_PERMISSION_DENIED", "El Campus no te deja borrar entregas de estudiantes (falta el permiso de editar entregas ajenas). Alternativa: devolverlas a borrador (operation: revert_to_draft).");
            let html: string;
            try {
                html = await ctx.web.readPage("assign_remove_submission_confirm", { id: String(a.cmid), action: "removesubmissionconfirm", userid: String(rows[0]!.user_id) });
            } catch (e) {
                if (e instanceof CampusError && (e.code === "MOODLE_PERMISSION_DENIED" || /HTTP 404/.test(e.message))) throw denied;
                throw e;
            }
            if (!removeConfirmAllowed(html)) throw denied;
        }
        const totalFiles = rows.reduce((s, r) => s + r.files, 0);
        const items: PlanItem[] = rows.map((r, i) => ({
            item_id: `i${i + 1}`,
            description: `${remove ? "Borrar" : "Devolver a borrador"} la entrega de «${r.name}»`,
            call: { kind: "form", fn: remove ? "assign_remove_submission" : "assign_revert_to_draft", params: { query: {}, fields: { id: String(a.cmid), action: remove ? "removesubmission" : "reverttodraft", userid: String(r.user_id) } } },
            target: { course_id: input.course_id, assignment_id: a.id, user_id: r.user_id },
            expected: { status: remove ? "new" : "draft", prior: r.status },
        }));
        return {
            intent: "assign_submission_reset",
            capability: "delete_student_work",
            course_id: input.course_id,
            base_risk: remove ? "R4" : "R3",
            summary: remove
                ? `BORRAR ${rows.length} entrega(s) de la tarea «${a.name ?? a.id}»${totalFiles ? `, con ${totalFiles} archivo(s)` : ""}.`
                : `Devolver a borrador ${rows.length} entrega(s) de la tarea «${a.name ?? a.id}» (los archivos quedan).`,
            payload_preview: { assignment: { assignment_id: a.id, course_module_id: a.cmid, name: a.name ?? null }, operation: input.operation, submissions: rows },
            side_effects: [
                `Entregas: ${rows.map((r) => `«${r.name}» (${r.status}${r.files ? `, ${r.files} archivo(s)` : ""})`).join("; ")}.`,
                remove ? "Se pierden los archivos y el texto de cada entrega; la nota y la devolución, si había, quedan." : "Cada estudiante puede corregir su entrega y volver a enviarla; hasta entonces figura como borrador.",
                "Moodle no avisa a los estudiantes.",
            ],
            preconditions: { description: "Las entregas siguen como en el plan.", versions: Object.fromEntries(rows.map((r) => [`subst:${a.id}:${r.user_id}`, r.status])) },
            undo: { kind: "ninguno", how: remove ? "Una entrega borrada no se recupera." : "El estudiante la vuelve a enviar (no hay forma de reenviarla por él).", until: null },
            warnings: [remove ? "R4: borra trabajo de estudiantes." : "R3: cambia el estado de entregas de estudiantes.", "Formulario web: requiere la sesión web del Campus."],
            items,
            prior_state: {},
            untrusted_fields: ["payload_preview.assignment.name", "payload_preview.submissions"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo() {
        return { kind: "ninguno", reason: "No hay deshacer automático para entregas." };
    },
};

export const STUDENT_WORK_INTENTS = [quizAttemptDeleteIntent, assignSubmissionResetIntent];
