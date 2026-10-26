import { mayNotify } from "../policy.js";
import { z } from "zod";
import { CampusError } from "../../errors.js";
import { EnrolledUsersSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * W6 · Calificar el FORO COMPLETO de un participante (directiva: «Calificación de foro», W6;
 * investigación [T] §19; ADR-070).
 * - AJAX `core_grades_grader_gradingpanel_point_store` (mod_forum/forum) con `notifyuser=false`
 *   SIEMPRE: con true Moodle manda un mensaje inmediato aunque la nota no cambie.
 * - Sólo calificación directa por puntos (no escalas ni avanzada). `formdata` «grade=<n>»; «grade=» limpia.
 * - El panel no valida matrícula ni grupo del calificado: el plan exige un participante matriculado.
 * - Lectura previa y verificación: `core_grades_grader_gradingpanel_point_fetch`.
 * - Deshacer: la nota anterior (o limpiarla si no había).
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional(), contextid: z.number().nullable().optional(), instance: z.number().nullable().optional() })).default([]) }));
const ForumsSchema = z.array(z.object({ id: z.number().int(), cmid: z.number().nullable().optional(), course: z.number().int(), name: z.string().nullable().optional(), grade_forum: z.number().nullable().optional() }));
const FetchSchema = z.object({ hasgrade: z.boolean().nullable().optional(), grade: z.object({ grade: z.union([z.number(), z.string()]).nullable().optional(), maxgrade: z.union([z.number(), z.string()]).nullable().optional() }).passthrough().nullable().optional() }).passthrough();

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

async function fetchGrade(ctx: IntentContext, contextId: number, userId: number): Promise<number | null> {
    const web = ctx.read.web;
    if (!web) throw new CampusError("AUTH_REQUIRED", "Esta operación necesita la sesión web del Campus.");
    const op = await web.open();
    try {
        const r = FetchSchema.safeParse(await op.ajax<unknown>("core_grades_grader_gradingpanel_point_fetch", { component: "mod_forum", contextid: contextId, itemname: "forum", gradeduserid: userId }));
        if (!r.success) throw new CampusError("UNEXPECTED_RESPONSE", "La nota del foro no tiene la forma esperada.");
        return r.data.hasgrade === false ? null : num(r.data.grade?.grade);
    } finally {
        await web.afterOperation(op);
    }
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, contextId, user] = k.split(":");
        out[k] = kind === "fgrade" ? String(await fetchGrade(ctx, Number(contextId), Number(user))) : null;
    }
    return out;
}

function interpret(_item: PlanItem, data: unknown): Interpretation {
    const w = (data && typeof data === "object" ? (data as { warnings?: unknown }).warnings : undefined) as { warningcode?: string }[] | undefined;
    return Array.isArray(w) && w.length ? { ok: false, reason: `Moodle devolvió avisos: ${w.map((x) => x.warningcode ?? "aviso").join(", ")}.` } : { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const now = await fetchGrade(ctx, Number(t.context_id), Number(t.user_id));
    const want = item.expected.grade as number | null;
    if (now === want) return { outcome: "coincide", checked: ["grade"], differences: [] };
    return { outcome: now === (item.expected.prior as number | null) ? "sin_efecto" : "difiere", checked: ["grade"], differences: [{ field: "grade", expected: want, observed: now }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

function draftFor(courseId: number, f: { cmid: number; name: string; contextId: number; max: number }, user: { id: number; name: string | null }, prior: number | null, grade: number | null, undoOf: string | null, notify = false): PlanDraft {
    const show = (g: number | null) => (g === null ? "sin nota" : `${g}/${f.max}`);
    return {
        intent: "forum_grade",
        capability: "grade_forum",
        course_id: courseId,
        base_risk: "R3",
        summary: `${undoOf ? "Deshacer: " : ""}Nota del foro «${f.name}» para el participante ${user.id}: ${show(prior)} → ${show(grade)}.`,
        payload_preview: { forum: { course_module_id: f.cmid, name: f.name, max_grade: f.max }, participant: { id: user.id, name: user.name }, before: show(prior), after: show(grade), notify_student: notify },
        side_effects: ["Actualiza el libro de calificaciones del curso (puede cambiar totales).", notify ? "Moodle le manda un mensaje inmediato al estudiante (cuenta de prueba del sandbox, ADR-120)." : "Sin mensaje al estudiante (notifyuser=false)."],
        preconditions: { description: "La nota no cambió desde el plan.", versions: { [`fgrade:${f.contextId}:${user.id}`]: String(prior) } },
        undo: { kind: "exacto", how: prior === null ? "Limpiar la nota." : `Volver a ${prior}.`, until: null },
        warnings: [],
        items: [
            {
                item_id: "i1",
                description: `Nota del foro ${f.cmid} para ${user.id}`,
                call: { kind: "ajax", fn: "core_grades_grader_gradingpanel_point_store", params: { component: "mod_forum", contextid: f.contextId, itemname: "forum", gradeduserid: user.id, notifyuser: notify, formdata: `grade=${grade === null ? "" : grade}` } },
                target: { course_id: courseId, cmid: f.cmid, context_id: f.contextId, user_id: user.id, max: f.max, name: f.name },
                expected: { grade, prior },
            },
        ],
        prior_state: { grade: prior },
        untrusted_fields: ["payload_preview.forum.name", "payload_preview.participant.name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de un foro del curso con calificación del foro completo (en puntos)."),
    participant_id: z.number().int().positive(),
    grade: z.number().min(0).max(100).nullable().describe("Nota en puntos (hasta 2 decimales); null = limpiar la nota."),
    notify_student: z.boolean().optional().describe("Mandarle un mensaje al estudiante (por defecto no). Sólo si el perfil permite notificarle (cuentas de prueba del sandbox, ADR-115)."),
};

export const forumGradeIntent: WriteIntent<typeof shape> = {
    name: "forum_grade",
    title: "Plan: calificar el foro completo de un participante",
    description: "Arma el plan para poner (o limpiar) la nota del foro completo de UN participante, sin mensaje al estudiante salvo notify_student (sólo cuentas de prueba del sandbox). Sólo foros con calificación por puntos. No escribe.",
    inputShape: shape,
    capability: "grade_forum",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const t = ctx.read.session.transport;
        const mod = (await t.call("core_course_get_contents", { courseid: input.course_id }, ContentsSchema)).flatMap((s) => s.modules).find((m) => m.id === input.course_module_id);
        if (!mod || mod.modname !== "forum" || !mod.contextid) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${input.course_module_id} no es un foro del curso ${input.course_id}.`);
        const forum = (await t.call("mod_forum_get_forums_by_courses", { courseids: [input.course_id] }, ForumsSchema)).find((f) => f.cmid === mod.id);
        const max = forum?.grade_forum ?? 0;
        if (max <= 0) throw new CampusError("WRITE_NOT_ALLOWED", max < 0 ? "El foro se califica con una escala: sólo se admite calificación por puntos." : "El foro no tiene calificación del foro completo.");
        const user = (await t.call("core_enrol_get_enrolled_users", { courseid: input.course_id }, EnrolledUsersSchema)).find((u) => u.id === input.participant_id);
        if (!user) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${input.participant_id} no está matriculado (el panel de Moodle no lo valida).`);
        const grade = input.grade === null ? null : Math.round(input.grade * 100) / 100;
        if (grade !== null && grade > max) throw new CampusError("WRITE_NOT_ALLOWED", `La nota máxima del foro es ${max}.`);
        const prior = await fetchGrade(ctx, mod.contextid, user.id);
        if (prior === grade) throw new CampusError("WRITE_NOT_ALLOWED", "Esa ya es la nota actual.");
        const notify = input.notify_student ?? false;
        if (notify && !mayNotify(ctx.profile.policy, input.course_id, [user.id])) throw new CampusError("WRITE_NOT_ALLOWED", "Notificar a este estudiante no está permitido por el perfil (allow_participant_notifications=false y no es una cuenta de prueba del sandbox, ADR-115).");
        return draftFor(input.course_id, { cmid: mod.id, name: forum?.name ?? mod.name ?? String(mod.id), contextId: mod.contextid, max }, { id: user.id, name: user.fullname ?? null }, prior, grade, null, notify);
    },
    async undo(plan, result) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const it = plan.items[0]!;
        const t = it.target;
        const f = { cmid: Number(t.cmid), name: String(t.name), contextId: Number(t.context_id), max: Number(t.max) };
        return { kind: "plan", draft: draftFor(plan.course_id, f, { id: Number(t.user_id), name: null }, it.expected.grade as number | null, it.expected.prior as number | null, result.action_id) };
    },
};
