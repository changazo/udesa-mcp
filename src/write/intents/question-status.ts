import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { bankModule, inventory, parseImportCategories } from "./questions.js";

/**
 * W6 · Estado de una pregunta del banco: lista ↔ borrador (directiva §8.10; investigación [C] §6.1;
 * ADR-068). AJAX `qbank_editquestion_set_status` (sin permiso devuelve status=false sin excepción).
 * - Pasar a borrador cambia lo que reciben los intentos NUEVOS de cuestionarios con «siempre la
 *   última versión» y de las reglas aleatorias; los intentos existentes no cambian.
 * - El inventario del banco sólo lista preguntas «listas»: la pregunta tiene que estar lista para
 *   pasarla a borrador (por id o nombre); para volver a «lista» se usa el id (una en borrador no
 *   figura en el inventario, y Moodle valida el permiso sobre la pregunta).
 * - Verificación: aparece (lista) o desaparece (borrador) del inventario de su categoría.
 * - Deshacer: el estado anterior.
 */

async function categoriesOf(ctx: IntentContext, bankCmid: number) {
    const { categories } = parseImportCategories(await ctx.web.readPage("question_import_form", { cmid: String(bankCmid) }));
    if (!categories.length) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconocieron las categorías del banco.");
    if (categories.length > 30) throw new CampusError("INCOMPLETE_RESULT", "El banco tiene más de 30 categorías.");
    return categories;
}

/** Dónde está «lista» la pregunta (o null si no figura entre las listas). */
async function locate(ctx: IntentContext, bankCmid: number, questionId: number) {
    for (const c of await categoriesOf(ctx, bankCmid)) {
        const q = (await inventory(ctx, c.category_id, c.context_id)).find((x) => x.id === questionId);
        if (q) return { category_id: c.category_id, context_id: c.context_id, name: q.name, label: c.label };
    }
    return null;
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, bank, qid] = k.split(":");
        out[k] = kind === "qready" ? ((await locate(ctx, Number(bank), Number(qid))) ? "ready" : "no_lista") : null;
    }
    return out;
}

function interpret(_item: PlanItem, data: unknown): Interpretation {
    const d = (data && typeof data === "object" ? data : {}) as { status?: unknown; error?: unknown };
    return d.status === false ? { ok: false, reason: `Moodle no cambió el estado${typeof d.error === "string" && d.error ? `: ${d.error}` : " (sin permiso sobre la pregunta)"}.` } : { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const ready = (await locate(ctx, Number(t.bank_cmid), Number(t.question_id))) !== null;
    const want = item.expected.status === "ready";
    if (ready === want) return { outcome: "coincide", checked: ["estado"], differences: [] };
    return { outcome: "sin_efecto", checked: ["estado"], differences: [{ field: "estado", expected: item.expected.status, observed: ready ? "ready" : "no lista" }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : "ausente";
}

function draftFor(courseId: number, bankCmid: number, questionId: number, name: string | null, status: "ready" | "draft", undoOf: string | null): PlanDraft {
    return {
        intent: "question_status",
        capability: "edit_quiz",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Pasar la pregunta ${questionId}${name ? ` («${name}»)` : ""} a ${status === "ready" ? "LISTA" : "BORRADOR"}.`,
        payload_preview: { question_id: questionId, name, bank_course_module_id: bankCmid, new_status: status },
        side_effects: [
            status === "draft"
                ? "Los intentos NUEVOS de cuestionarios que usan «siempre la última versión» o reglas aleatorias dejan de recibir esta versión. Los intentos existentes no cambian."
                : "La pregunta vuelve a estar disponible para intentos nuevos y reglas aleatorias.",
            "Sin notificaciones.",
        ],
        preconditions: { description: "El estado de la pregunta no cambió desde el plan.", versions: { [`qready:${bankCmid}:${questionId}`]: status === "draft" ? "ready" : "no_lista" } },
        undo: { kind: "exacto", how: `Volver a ${status === "draft" ? "lista" : "borrador"}.`, until: null },
        warnings: [],
        items: [
            {
                item_id: "i1",
                description: `Estado de la pregunta ${questionId} → ${status}`,
                call: { kind: "ajax", fn: "qbank_editquestion_set_status", params: { questionid: questionId, status } },
                target: { course_id: courseId, bank_cmid: bankCmid, question_id: questionId },
                expected: { status },
            },
        ],
        prior_state: {},
        untrusted_fields: ["payload_preview.name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    bank_course_module_id: z.number().int().positive().describe("cmid del cuestionario (su banco propio) o de un «Banco de preguntas» del curso."),
    question_id: z.number().int().positive().optional(),
    question_name: z.string().min(1).max(255).optional().describe("Alternativa a question_id para pasar a borrador una pregunta lista (nombre único en el banco)."),
    status: z.enum(["ready", "draft"]).describe("ready = lista; draft = borrador."),
};

export const questionStatusIntent: WriteIntent<typeof shape> = {
    name: "question_status",
    title: "Plan: pasar una pregunta a lista o a borrador",
    description: "Arma el plan para cambiar el estado de una pregunta del banco (lista ↔ borrador). En borrador deja de entrar en los intentos nuevos. No escribe.",
    inputShape: shape,
    capability: "edit_quiz",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const bank = await bankModule(ctx, input.course_id, input.bank_course_module_id);
        if ((input.question_id === undefined) === (input.question_name === undefined)) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá question_id o question_name (uno de los dos).");
        let id = input.question_id;
        let name: string | null = null;
        if (input.question_name !== undefined) {
            const hits: { id: number; name: string }[] = [];
            for (const c of await categoriesOf(ctx, bank.id)) hits.push(...(await inventory(ctx, c.category_id, c.context_id)).filter((q) => q.name === input.question_name!.trim()));
            if (!hits.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `No hay una pregunta lista llamada «${input.question_name}» en el banco (para volver a lista una en borrador, usá question_id).`);
            if (hits.length > 1) throw new CampusError("AMBIGUOUS_RESOURCE", `Hay ${hits.length} preguntas con ese nombre: ${hits.map((h) => h.id).join(", ")}. Usá question_id.`);
            id = hits[0]!.id;
            name = hits[0]!.name;
        }
        const where = await locate(ctx, bank.id, id!);
        if (where) name = where.name;
        if (input.status === "draft" && !where) throw new CampusError("WRITE_NOT_ALLOWED", `La pregunta ${id} no está lista en este banco (ya en borrador, de otro banco o inexistente).`);
        if (input.status === "ready" && where) throw new CampusError("WRITE_NOT_ALLOWED", `La pregunta ${id} ya está lista.`);
        return draftFor(input.course_id, bank.id, id!, name, input.status, null);
    },
    async undo(plan, result) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const t = plan.items[0]!.target;
        const back = plan.items[0]!.expected.status === "draft" ? "ready" : "draft";
        const name = (plan.payload_preview as { name?: string | null }).name ?? null;
        return { kind: "plan", draft: draftFor(plan.course_id, Number(t.bank_cmid), Number(t.question_id), name, back, result.action_id) };
    },
};
