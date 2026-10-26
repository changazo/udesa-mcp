import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { bankModule, parseImportCategories } from "./questions.js";
import { quizOf, slotsOf } from "./quiz-slots.js";

/**
 * W6 · Estructura de cuestionarios, segunda parte (directiva §8.10; investigación [C] §7; ADR-072):
 * - Preguntas ALEATORIAS: `/mod/quiz/edit.php` con `addrandom` (camino que SÍ chequea intentos con
 *   check_can_be_edited; el AJAX mod_quiz_add_random_questions no lo hace). Deshacer: quitar los slots.
 * - Nota máxima de UN slot: AJAX `mod_quiz_update_slots`. Reescala los intentos existentes y cambia
 *   notas en el libro de calificaciones: el plan la rechaza si el cuestionario tiene intentos.
 * Intentos: la página de edición muestra el aviso «cannoteditafterattempts» (div statusdisplay con el
 * enlace al informe) cuando el cuestionario tiene intentos de estudiantes (no cuenta vistas previas).
 */

/** true si la página de edición avisa que el cuestionario ya tiene intentos; página irreconocible → null. */
export function editPageHasAttempts(html: string): boolean | null {
    if (!/id="page-mod-quiz-edit"|\/mod\/quiz\/edit\.php|class="[^"]*mod-quiz-edit-content/.test(html)) return null;
    return [...html.matchAll(/<div[^>]*class="[^"]*\bstatusdisplay\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].some((m) => /\/mod\/quiz\/report\.php/.test(m[1]!));
}

export async function quizHasAttempts(ctx: IntentContext, cmid: number): Promise<boolean> {
    const r = editPageHasAttempts(await ctx.web.readPage("quiz_edit_page", { cmid: String(cmid) }));
    if (r === null) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció la página de edición del cuestionario (no se puede saber si tiene intentos).");
    return r;
}

const key = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join(",");

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, quiz, slot] = k.split(":");
        const slots = await slotsOf(ctx, Number(quiz));
        if (kind === "qslots") out[k] = key(slots.map((s) => s.slot_id));
        else if (kind === "qmax") out[k] = String(slots.find((s) => s.slot_id === Number(slot))?.max_mark ?? null);
        else out[k] = null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const slots = await slotsOf(ctx, Number(t.quiz_id));
    if (item.call.fn === "quiz_add_random") {
        const prior = new Set(item.expected.prior_slot_ids as number[]);
        const fresh = slots.filter((s) => !prior.has(s.slot_id));
        const ok = fresh.filter((s) => s.kind === "aleatoria" && s.random_rule?.category_id === Number(t.category_id) && (s.random_rule.include_subcategories ?? false) === item.expected.recurse);
        if (!fresh.length) return { outcome: "sin_efecto", checked: ["slots"], differences: [{ field: "slots aleatorios", expected: item.expected.count, observed: 0 }] };
        const differences = [
            ...(ok.length === item.expected.count ? [] : [{ field: "slots aleatorios con esa regla", expected: item.expected.count, observed: ok.length }]),
            ...(fresh.length === ok.length ? [] : [{ field: "otros slots nuevos", expected: 0, observed: fresh.length - ok.length }]),
        ];
        return { outcome: differences.length ? "difiere" : "coincide", checked: ["cantidad", "categoría", "subcategorías"], differences, moodle_ids: { slots: fresh.length } };
    }
    if (item.call.fn === "quiz_remove_slot") {
        const still = slots.some((s) => s.slot_id === Number(t.slot_id));
        return still ? { outcome: "sin_efecto", checked: ["slot"], differences: [{ field: "slot", expected: "quitado", observed: "sigue" }] } : { outcome: "coincide", checked: ["slot"], differences: [] };
    }
    const s = slots.find((x) => x.slot_id === Number(t.slot_id));
    const now = s?.max_mark ?? null;
    if (now === item.expected.max_mark) return { outcome: "coincide", checked: ["maxmark"], differences: [] };
    return { outcome: now === item.expected.prior ? "sin_efecto" : "difiere", checked: ["maxmark"], differences: [{ field: "maxmark", expected: item.expected.max_mark, observed: now }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };

// ---------- preguntas aleatorias ----------

const randomShape = {
    course_id: z.number().int().positive(),
    quiz_id: z.number().int().positive(),
    category_id: z.number().int().positive().describe("Categoría del banco de donde salen las preguntas."),
    count: z.number().int().min(1).max(20).describe("Cantidad de preguntas aleatorias (un slot cada una)."),
    include_subcategories: z.boolean().optional().describe("Incluir subcategorías (por defecto no)."),
    bank_course_module_id: z.number().int().positive().optional().describe("Banco de la categoría: el cuestionario (por defecto) o un «Banco de preguntas» del curso."),
};

export const quizAddRandomIntent: WriteIntent<typeof randomShape> = {
    name: "quiz_add_random",
    title: "Plan: agregar preguntas aleatorias a un cuestionario",
    description: "Arma el plan para agregar N slots de pregunta aleatoria (de una categoría del banco) al final de un cuestionario. Moodle no lo permite si el cuestionario ya tiene intentos. No escribe.",
    inputShape: randomShape,
    capability: "edit_quiz",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const quiz = await quizOf(ctx, input.course_id, input.quiz_id);
        const bank = await bankModule(ctx, input.course_id, input.bank_course_module_id ?? quiz.coursemodule);
        const { categories } = parseImportCategories(await ctx.web.readPage("question_import_form", { cmid: String(bank.id) }));
        const cat = categories.find((c) => c.category_id === input.category_id);
        if (!cat) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La categoría ${input.category_id} no es del banco «${bank.name ?? bank.id}».`, { details: { categories: categories.map((c) => ({ category_id: c.category_id, label: c.label })) } });
        if (await quizHasAttempts(ctx, quiz.coursemodule)) throw new CampusError("WRITE_NOT_ALLOWED", "El cuestionario ya tiene intentos: Moodle no permite cambiar sus preguntas.");
        const slots = await slotsOf(ctx, quiz.id);
        const recurse = input.include_subcategories ?? false;
        const draft: PlanDraft = {
            intent: "quiz_add_random",
            capability: "edit_quiz",
            course_id: input.course_id,
            base_risk: "R2",
            summary: `Agregar ${input.count} pregunta(s) aleatoria(s) de «${cat.label}»${recurse ? " (con subcategorías)" : ""} al final del cuestionario «${quiz.name ?? quiz.id}».`,
            payload_preview: { quiz: { quiz_id: quiz.id, name: quiz.name ?? null, current_slots: slots.length }, bank: { course_module_id: bank.id, name: bank.name ?? null }, category: { category_id: cat.category_id, label: cat.label }, count: input.count, include_subcategories: recurse },
            side_effects: ["Cada intento NUEVO recibe preguntas al azar de esa categoría. Recalcula la nota máxima total.", "Sin notificaciones."],
            preconditions: { description: "La estructura del cuestionario no cambió desde el plan.", versions: { [`qslots:${quiz.id}`]: key(slots.map((s) => s.slot_id)) } },
            undo: { kind: "exacto", how: "Quitar los slots aleatorios agregados.", until: null },
            warnings: [],
            items: [
                {
                    item_id: "i1",
                    description: `${input.count} aleatoria(s) de la categoría ${cat.category_id}`,
                    call: { kind: "form", fn: "quiz_add_random", params: { query: { cmid: String(quiz.coursemodule) }, fields: { addrandom: "1", categoryid: String(cat.category_id), randomcount: String(input.count), recurse: recurse ? "1" : "0", addonpage: "0" } } },
                    target: { course_id: input.course_id, quiz_id: quiz.id, category_id: cat.category_id },
                    expected: { count: input.count, recurse, prior_slot_ids: slots.map((s) => s.slot_id) },
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.quiz.name", "payload_preview.bank.name", "payload_preview.category.label"],
            teacher_text: {},
            undo_of: null,
        };
        return draft;
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const it = plan.items[0]!;
        const quizId = Number(it.target.quiz_id);
        const prior = new Set(it.expected.prior_slot_ids as number[]);
        const fresh = (await slotsOf(ctx, quizId)).filter((s) => !prior.has(s.slot_id) && s.kind === "aleatoria" && s.random_rule?.category_id === Number(it.target.category_id));
        if (!fresh.length) return { kind: "ninguno", reason: "No se encontraron los slots aleatorios agregados." };
        return {
            kind: "plan",
            draft: {
                intent: "quiz_add_random",
                capability: "edit_quiz",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: quitar ${fresh.length} slot(s) aleatorio(s) del cuestionario ${quizId}.`,
                payload_preview: { remove_slots: fresh.map((s) => s.slot_id) },
                side_effects: ["Quita los slots (las preguntas del banco no cambian). Si ya hay intentos, Moodle lo rechaza."],
                preconditions: { description: "Sin precondición: cada slot se verifica al releer.", versions: {} },
                undo: { kind: "ninguno", how: "Se pueden volver a agregar.", until: null },
                warnings: [],
                items: fresh.map((s, i) => ({
                    item_id: `i${i + 1}`,
                    description: `Quitar el slot ${s.slot_id}`,
                    call: { kind: "form" as const, fn: "quiz_remove_slot", params: { query: {}, fields: { quizid: String(quizId), class: "resource", action: "DELETE", id: String(s.slot_id) } } },
                    target: { course_id: plan.course_id, quiz_id: quizId, slot_id: s.slot_id },
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

// ---------- nota máxima de un slot ----------

const maxShape = {
    course_id: z.number().int().positive(),
    quiz_id: z.number().int().positive(),
    slot_id: z.number().int().positive().describe("slot_id (de campus_get_quiz_structure)."),
    max_mark: z.number().min(0).max(100).describe("Nota máxima de esa pregunta (hasta 2 decimales)."),
};

function maxDraft(courseId: number, quiz: { id: number; name: string | null }, slotId: number, label: string, prior: number | null, mark: number, undoOf: string | null): PlanDraft {
    return {
        intent: "quiz_slot_maxmark",
        capability: "edit_quiz",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Nota máxima de «${label}» (slot ${slotId}) en «${quiz.name ?? quiz.id}»: ${prior ?? "?"} → ${mark}.`,
        payload_preview: { quiz_id: quiz.id, slot_id: slotId, question: label, before: prior, after: mark },
        side_effects: ["Cambia la nota máxima total del cuestionario (sumgrades). El cuestionario no tiene intentos: no se reescala ninguna nota."],
        preconditions: { description: "La nota máxima del slot no cambió desde el plan.", versions: { [`qmax:${quiz.id}:${slotId}`]: String(prior) } },
        undo: { kind: "exacto", how: `Volver a ${prior}.`, until: null },
        warnings: [],
        items: [
            {
                item_id: "i1",
                description: `Nota máxima ${mark} en el slot ${slotId}`,
                call: { kind: "ajax", fn: "mod_quiz_update_slots", params: { quizid: quiz.id, slots: [{ id: slotId, maxmark: mark }] } },
                target: { course_id: courseId, quiz_id: quiz.id, slot_id: slotId, label, quiz_name: quiz.name ?? "" },
                expected: { max_mark: mark, prior },
            },
        ],
        prior_state: { max_mark: prior },
        untrusted_fields: ["payload_preview.question"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const quizSlotMaxmarkIntent: WriteIntent<typeof maxShape> = {
    name: "quiz_slot_maxmark",
    title: "Plan: cambiar la nota máxima de una pregunta del cuestionario",
    description: "Arma el plan para cambiar la nota máxima de UN slot de un cuestionario. Se rechaza si el cuestionario tiene intentos (Moodle reescalaría notas de estudiantes). No escribe.",
    inputShape: maxShape,
    capability: "edit_quiz",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const quiz = await quizOf(ctx, input.course_id, input.quiz_id);
        const s = (await slotsOf(ctx, quiz.id)).find((x) => x.slot_id === input.slot_id);
        if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El slot ${input.slot_id} no es del cuestionario ${quiz.id}.`);
        if (await quizHasAttempts(ctx, quiz.coursemodule)) throw new CampusError("WRITE_NOT_ALLOWED", "El cuestionario tiene intentos: cambiar la nota máxima reescalaría notas de estudiantes. No se admite.");
        const mark = Math.round(input.max_mark * 100) / 100;
        if (s.max_mark === mark) throw new CampusError("WRITE_NOT_ALLOWED", "Esa ya es la nota máxima del slot.");
        return maxDraft(input.course_id, { id: quiz.id, name: quiz.name ?? null }, s.slot_id, s.name ?? String(s.slot_id), s.max_mark, mark, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const it = plan.items[0]!;
        const t = it.target;
        const prior = it.expected.prior as number | null;
        if (prior === null) return { kind: "ninguno", reason: "No se conoce la nota máxima anterior." };
        const quiz = await quizOf(ctx, plan.course_id, Number(t.quiz_id));
        if (await quizHasAttempts(ctx, quiz.coursemodule)) return { kind: "ninguno", reason: "El cuestionario ya tiene intentos: volver atrás reescalaría notas." };
        return { kind: "plan", draft: maxDraft(plan.course_id, { id: quiz.id, name: quiz.name ?? null }, Number(t.slot_id), String(t.label), it.expected.max_mark as number, prior, result.action_id) };
    },
};
