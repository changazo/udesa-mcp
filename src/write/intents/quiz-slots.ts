import { z } from "zod";
import { CampusError } from "../../errors.js";
import { parseGradingPageData } from "../../domain/quiz-structure.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { bankModule, inventory, parseImportCategories } from "./questions.js";

/**
 * W6 · Agregar preguntas del banco a un cuestionario (directiva §8.10; investigación [C] §7, ADR-063).
 * - Una llamada por pregunta: `/mod/quiz/edit.php` con `addquestion=<id>` (POST con sesskey; éxito =
 *   redirección). Moodle rechaza si el cuestionario ya tiene intentos (`check_can_be_edited`).
 * - El plan exige que cada pregunta esté «lista» en una categoría del banco indicado (el del
 *   cuestionario o un banco del curso) y que no esté ya en el cuestionario.
 * - Verificación: estructura releída (`mod_quiz_get_edit_grading_page_data`): aparece un slot nuevo
 *   con esa pregunta.
 * - Deshacer: `/mod/quiz/edit_rest.php` con `action=DELETE` y `class=resource` por slot (también
 *   bloqueado por Moodle si ya hay intentos). Responde 200 con `{"deleted":true}`.
 */

const MAX_QUESTIONS = 50;
const MAX_CATEGORIES = 30;

const QuizzesSchema = z.object({
    quizzes: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), course: z.number().int(), name: z.string().nullable().optional() })).default([]),
});

export async function quizOf(ctx: IntentContext, courseId: number, quizId: number) {
    const q = (await ctx.read.session.transport.call("mod_quiz_get_quizzes_by_courses", { courseids: [courseId] }, QuizzesSchema)).quizzes.find((x) => x.id === quizId && x.course === courseId);
    if (!q) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El cuestionario ${quizId} no es del curso ${courseId}.`);
    return q;
}

/** Slots del cuestionario (estructura de la página de calificación, lectura por AJAX). */
export async function slotsOf(ctx: IntentContext, quizId: number) {
    const web = ctx.read.web;
    if (!web) throw new CampusError("AUTH_REQUIRED", "Esta operación necesita la sesión web del Campus.");
    const op = await web.open();
    try {
        const s = parseGradingPageData(await op.ajax<unknown>("mod_quiz_get_edit_grading_page_data", { quizid: quizId }), quizId);
        return s.sections.flatMap((x) => x.slots);
    } finally {
        await web.afterOperation(op);
    }
}

const key = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join(",");

// ---------- versiones, interpretación y verificación ----------

/** `qslots:<quiz>` = ids de slots del cuestionario (cualquier cambio de estructura invalida el plan). */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, quiz] = k.split(":");
        out[k] = kind === "qslots" ? key((await slotsOf(ctx, Number(quiz))).map((s) => s.slot_id)) : null;
    }
    return out;
}

function interpret(): Interpretation {
    // edit.php redirige y edit_rest.php devuelve {"deleted":true}: el éxito lo decide la relectura.
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const t = item.target;
    const slots = await slotsOf(ctx, Number(t.quiz_id));
    if (item.call.fn === "quiz_add_question") {
        const prior = new Set(item.expected.prior_slot_ids as number[]);
        const added = slots.find((s) => (known.slot_id ? s.slot_id === known.slot_id : !prior.has(s.slot_id)) && s.question_id === Number(t.question_id));
        if (added) return { outcome: "coincide", checked: ["slot", "question_id"], differences: [], moodle_ids: { slot_id: added.slot_id } };
        const anyNew = slots.some((s) => !prior.has(s.slot_id));
        return anyNew
            ? { outcome: "difiere", checked: ["slot", "question_id"], differences: [{ field: "pregunta del slot nuevo", expected: t.question_id, observed: "otra o no identificable" }] }
            : { outcome: "sin_efecto", checked: ["slot"], differences: [{ field: "slot", expected: "agregado", observed: "no aparece" }] };
    }
    // Quitar un slot (deshacer).
    const still = slots.some((s) => s.slot_id === Number(t.slot_id));
    return still ? { outcome: "sin_efecto", checked: ["slot"], differences: [{ field: "slot", expected: "quitado", observed: "sigue" }] } : { outcome: "coincide", checked: ["slot"], differences: [] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

// ---------- agregar preguntas ----------

const shape = {
    course_id: z.number().int().positive(),
    quiz_id: z.number().int().positive().describe("quiz_id (no el cmid) de un cuestionario del curso."),
    question_ids: z.array(z.number().int().positive()).min(1).max(MAX_QUESTIONS).optional().describe("IDs de preguntas del banco, en el orden en que se agregan (al final del cuestionario)."),
    question_names: z.array(z.string().min(1).max(255)).min(1).max(MAX_QUESTIONS).optional().describe("Alternativa a question_ids: nombres exactos de preguntas del banco (p. ej. las recién importadas). Cada nombre tiene que ser único en el banco."),
    bank_course_module_id: z.number().int().positive().optional().describe("Banco donde están las preguntas: el cmid del cuestionario (su banco propio, por defecto) o el de un «Banco de preguntas» del curso."),
};

export const quizAddQuestionsIntent: WriteIntent<typeof shape> = {
    name: "quiz_add_questions",
    title: "Plan: agregar preguntas a un cuestionario",
    description:
        "Arma el plan para agregar preguntas existentes del banco (del propio cuestionario o de un banco del curso) al final de un cuestionario, una por slot, con nota 1. Rechaza preguntas que no están listas en ese banco o que ya están en el cuestionario. Moodle no lo permite si el cuestionario ya tiene intentos. No escribe.",
    inputShape: shape,
    capability: "edit_quiz",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const quiz = await quizOf(ctx, input.course_id, input.quiz_id);
        const bankCmid = input.bank_course_module_id ?? quiz.coursemodule;
        const bank = await bankModule(ctx, input.course_id, bankCmid);
        if (!!input.question_ids === !!input.question_names) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá question_ids o question_names (uno de los dos).");
        const asked: (number | string)[] = input.question_ids ?? input.question_names!.map((n) => n.trim());
        const dup = asked.filter((q, i) => asked.indexOf(q) !== i);
        if (dup.length) throw new CampusError("WRITE_NOT_ALLOWED", `Preguntas repetidas en el pedido: ${[...new Set(dup)].join(", ")}.`);

        // Preguntas «listas» del banco, por categoría (las mismas que ofrece el formulario del banco).
        const { categories } = parseImportCategories(await ctx.web.readPage("question_import_form", { cmid: String(bank.id) }));
        if (!categories.length) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconocieron las categorías del banco.");
        if (categories.length > MAX_CATEGORIES) throw new CampusError("INCOMPLETE_RESULT", `El banco tiene más de ${MAX_CATEGORIES} categorías: no se puede verificar dónde están las preguntas.`);
        const found = new Map<number, { name: string; category: string }>();
        for (const c of categories) for (const q of await inventory(ctx, c.category_id, c.context_id)) found.set(q.id, { name: q.name, category: c.label });
        let ids: number[];
        if (input.question_names) {
            ids = [];
            const unknown: string[] = [];
            const ambiguous: string[] = [];
            for (const name of asked as string[]) {
                const hits = [...found].filter(([, q]) => q.name === name).map(([id]) => id);
                if (!hits.length) unknown.push(name);
                else if (hits.length > 1) ambiguous.push(`«${name}» (ids ${hits.join(", ")})`);
                else ids.push(hits[0]!);
            }
            if (unknown.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `No hay preguntas listas con estos nombres en el banco «${bank.name ?? bank.id}»: ${unknown.join(", ")}.`);
            if (ambiguous.length) throw new CampusError("AMBIGUOUS_RESOURCE", `Nombres repetidos en el banco: ${ambiguous.join("; ")}. Usá question_ids.`);
        } else ids = input.question_ids!;
        const missing = ids.filter((q) => !found.has(q));
        if (missing.length) {
            throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Estas preguntas no están listas en el banco «${bank.name ?? bank.id}» (o son de otro banco, o están en borrador): ${missing.join(", ")}.`);
        }

        const slots = await slotsOf(ctx, quiz.id);
        const already = ids.filter((q) => slots.some((s) => s.question_id === q));
        if (already.length) throw new CampusError("WRITE_NOT_ALLOWED", `Estas preguntas ya están en el cuestionario: ${already.join(", ")}.`);
        const prior = slots.map((s) => s.slot_id);

        const draft: PlanDraft = {
            intent: "quiz_add_questions",
            capability: "edit_quiz",
            course_id: input.course_id,
            base_risk: "R2",
            summary: `Agregar ${ids.length} pregunta(s) al final del cuestionario «${quiz.name ?? quiz.id}» (hoy tiene ${slots.length} slot(s)).`,
            payload_preview: {
                quiz: { quiz_id: quiz.id, course_module_id: quiz.coursemodule, name: quiz.name ?? null, current_slots: slots.length },
                bank: { course_module_id: bank.id, kind: bank.modname, name: bank.name ?? null },
                questions: ids.map((id) => ({ question_id: id, ...found.get(id)! })),
                where: "al final, cada una con nota máxima 1 (versión: siempre la última)",
            },
            side_effects: [
                "Los intentos NUEVOS incluyen las preguntas. Cambia la nota máxima total del cuestionario (sumgrades).",
                "Borra las vistas previas del docente. Sin notificaciones.",
                "Si el cuestionario ya tiene intentos, Moodle lo rechaza.",
            ],
            preconditions: { description: "La estructura del cuestionario no cambió desde el plan.", versions: { [`qslots:${quiz.id}`]: key(prior) } },
            undo: { kind: "exacto", how: "Quitar los slots agregados (mientras el cuestionario no tenga intentos).", until: null },
            warnings: ["Edición por la sesión web del Campus."],
            items: ids.map((qid, i) => ({
                item_id: `i${i + 1}`,
                description: `Agregar la pregunta ${qid} («${found.get(qid)!.name}»)`,
                call: { kind: "form" as const, fn: "quiz_add_question", params: { query: { cmid: String(quiz.coursemodule) }, fields: { addquestion: String(qid), addonpage: "0" } } },
                target: { course_id: input.course_id, quiz_id: quiz.id, question_id: qid },
                expected: { prior_slot_ids: prior },
            })),
            prior_state: { slot_ids: prior },
            untrusted_fields: ["payload_preview.quiz.name", "payload_preview.bank.name", "payload_preview.questions"],
            teacher_text: {},
            undo_of: null,
        };
        return draft;
    },
    async undo(plan, result) {
        const slots = result.items.filter((r) => (r.outcome === "verificado" || r.outcome === "con_diferencias") && r.moodle_ids.slot_id).map((r) => r.moodle_ids.slot_id!);
        if (!slots.length) return { kind: "ninguno", reason: "No se conocen los slots agregados (revisá el cuestionario en el Campus)." };
        const quizId = Number(plan.items[0]!.target.quiz_id);
        return {
            kind: "plan",
            draft: {
                intent: "quiz_add_questions",
                capability: "edit_quiz",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: quitar ${slots.length} slot(s) agregados al cuestionario ${quizId}.`,
                payload_preview: { remove_slots: slots },
                side_effects: ["Quita los slots (las preguntas siguen en el banco). Recalcula la nota máxima total. Si ya hay intentos, Moodle lo rechaza."],
                preconditions: { description: "Sin precondición de estructura: cada slot se verifica al releer.", versions: {} },
                undo: { kind: "ninguno", how: "Se pueden volver a agregar.", until: null },
                warnings: [],
                items: slots.map((slotId, i) => ({
                    item_id: `i${i + 1}`,
                    description: `Quitar el slot ${slotId}`,
                    call: { kind: "form" as const, fn: "quiz_remove_slot", params: { query: {}, fields: { quizid: String(quizId), class: "resource", action: "DELETE", id: String(slotId) } } },
                    target: { course_id: plan.course_id, quiz_id: quizId, slot_id: slotId },
                    expected: { removed: true },
                })),
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};
