import { z } from "zod";
import { CampusError } from "../../errors.js";
import { parseQuizLayout, type QuizLayout } from "../../domain/quiz-structure.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { quizHasAttempts } from "./quiz-structure-edit.js";
import { quizOf } from "./quiz-slots.js";

/**
 * W6 · Páginas y secciones de un cuestionario (ADR-091), por la página de edición:
 * - Repaginar (N preguntas por página; 0 = todas en una): `/mod/quiz/edit.php` con `repaginate`.
 * - Salto de página después de un slot: `/mod/quiz/repaginate.php` (`repag` 2 = agregar, 1 = quitar).
 * - Agregar una sección en una página: `/mod/quiz/edit.php?addsectionatpage=N` (Moodle le pone «Nuevo título»).
 * - Cabecera y orden al azar de una sección: `/mod/quiz/edit_rest.php` (`updatesectiontitle`,
 *   `updateshufflequestions`); quitar una sección (sus preguntas pasan a la anterior): `action=DELETE`.
 * Lo que cambia páginas o secciones exige que el cuestionario no tenga intentos (Moodle también lo
 * rechaza). Verificación releyendo la página de edición. Deshacer: la operación inversa; repaginar se
 * deshace volviendo a poner o quitar cada salto de página que cambió.
 */

async function layoutOf(ctx: IntentContext, cmid: number): Promise<QuizLayout> {
    const l = parseQuizLayout(await ctx.web.readPage("quiz_edit_page", { cmid: String(cmid) }));
    if (!l) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció la estructura de la página de edición del cuestionario.");
    return l;
}

const signature = (l: QuizLayout) => JSON.stringify([l.sections.map((s) => [s.section_id, s.heading, s.shuffle, s.first_slot]), l.slots.map((s) => [s.slot_id, s.page, s.section_id])]);
/** true si el slot `n` y el siguiente están en la misma página. */
const joined = (l: QuizLayout, n: number) => l.slots[n - 1]!.page === l.slots[n]?.page;

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, cmid] = k.split(":");
        out[k] = kind === "qlayout" ? signature(await layoutOf(ctx, Number(cmid))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const l = await layoutOf(ctx, Number(item.target.cmid));
    const x = item.expected as Record<string, unknown>;
    const out = (ok: boolean, same: boolean, field: string, expected: unknown, observed: unknown, ids?: Record<string, number>): ItemVerification =>
        ok ? { outcome: "coincide", checked: [field], differences: [], ...(ids ? { moodle_ids: ids } : {}) } : { outcome: same ? "sin_efecto" : "difiere", checked: [field], differences: [{ field, expected, observed }] };
    switch (x.op) {
        case "repaginate": {
            const pages = l.slots.map((s) => s.page);
            const want = x.pages as number[];
            return out(JSON.stringify(pages) === JSON.stringify(want), JSON.stringify(pages) === JSON.stringify(x.prior_pages), "páginas", want, pages);
        }
        case "page_break": {
            const n = Number(x.slot_number);
            if (l.slots[n - 1]?.slot_id !== x.slot_id || !l.slots[n]) return out(false, false, "slot", x.slot_id, l.slots[n - 1]?.slot_id ?? null);
            const breakNow = !joined(l, n);
            return out(breakNow === x.page_break, breakNow !== x.page_break, "salto de página", x.page_break, breakNow);
        }
        case "add_section": {
            const prior = new Set(x.prior_section_ids as number[]);
            const fresh = l.sections.filter((s) => !prior.has(s.section_id));
            if (!fresh.length) return out(false, true, "sección", `nueva en la página ${x.page}`, "no aparece");
            const s = fresh[0]!;
            return out(fresh.length === 1 && s.first_page === x.page, false, "sección", `nueva en la página ${x.page}`, `${fresh.length} nueva(s), en la página ${s.first_page}`, { section_id: s.section_id });
        }
        case "rename_section": {
            const s = l.sections.find((y) => y.section_id === x.section_id);
            return out(s?.heading === x.heading, s?.heading === x.prior, "cabecera", x.heading, s?.heading ?? null);
        }
        case "shuffle_section": {
            const s = l.sections.find((y) => y.section_id === x.section_id);
            return out(s?.shuffle === x.shuffle, s?.shuffle === !x.shuffle, "orden al azar", x.shuffle, s?.shuffle ?? null);
        }
        case "remove_section": {
            const still = l.sections.some((y) => y.section_id === x.section_id);
            return out(!still, still, "sección", "quitada", still ? "sigue" : "quitada");
        }
        default:
            throw new CampusError("UNEXPECTED_RESPONSE", `Sin verificación para ${String(x.op)}.`);
    }
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

/** Páginas de `n` preguntas por página respetando las secciones (cada sección empieza página), como Moodle. */
function paginate(l: QuizLayout, perPage: number): number[] {
    const pages: number[] = [];
    let page = 0;
    let onPage = 0;
    let section = -1;
    for (const s of l.slots) {
        if (s.section_id !== section || (perPage > 0 && onPage >= perPage)) {
            page++;
            onPage = 0;
            section = s.section_id;
        }
        pages.push(page);
        onPage++;
    }
    return pages;
}

/** Ítems de salto de página que llevan de `from` a `to` (mismas preguntas). */
function breakItems(quizId: number, cmid: number, l: QuizLayout, toPages: number[]): PlanItem[] {
    const items: PlanItem[] = [];
    for (let n = 1; n < l.slots.length; n++) {
        const wantBreak = toPages[n - 1] !== toPages[n];
        if (wantBreak === !joined(l, n)) continue;
        items.push({
            item_id: `i${items.length + 1}`,
            description: `${wantBreak ? "Agregar" : "Quitar"} el salto de página después de la pregunta ${n}`,
            call: { kind: "form", fn: "quiz_page_break", params: { query: {}, fields: { quizid: String(quizId), slot: String(n), repag: wantBreak ? "2" : "1" } } },
            target: { cmid, quiz_id: quizId, slot_id: l.slots[n - 1]!.slot_id },
            expected: { op: "page_break", slot_number: n, slot_id: l.slots[n - 1]!.slot_id, page_break: wantBreak },
        });
    }
    return items;
}

type Op = "repaginate" | "page_break" | "add_section" | "rename_section" | "shuffle_section" | "remove_section" | "restore_pages";
interface Req {
    course_id: number;
    quiz_id: number;
    action: Op;
    questions_per_page?: number;
    after_slot_id?: number;
    page_break?: boolean;
    page?: number;
    section_id?: number;
    heading?: string;
    shuffle?: boolean;
    /** Deshacer de repaginar: las páginas anteriores, por slot. */
    pages?: number[];
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const quiz = await quizOf(ctx, input.course_id, input.quiz_id);
    const cmid = quiz.coursemodule;
    const l = await layoutOf(ctx, cmid);
    const structural = input.action !== "rename_section" && input.action !== "shuffle_section";
    if (structural && (await quizHasAttempts(ctx, cmid))) throw new CampusError("WRITE_NOT_ALLOWED", "El cuestionario ya tiene intentos: Moodle no permite cambiar páginas ni secciones.");
    const section = input.section_id !== undefined ? l.sections.find((s) => s.section_id === input.section_id) : undefined;
    if (input.section_id !== undefined && !section) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El cuestionario no tiene la sección ${input.section_id}.`);
    const form = (fn: string, query: Record<string, string>, fields: Record<string, string>) => ({ kind: "form" as const, fn, params: { query, fields } });
    const target = { cmid, quiz_id: quiz.id };
    let items: PlanItem[];
    let summary: string;
    let undo: PlanDraft["undo"] = { kind: "compensación", how: "La operación inversa.", until: null };
    let risk: "R1" | "R2" = "R2";
    const prior: Record<string, unknown> = { pages: l.slots.map((s) => s.page) };
    switch (input.action) {
        case "repaginate":
        case "restore_pages": {
            const pages = input.action === "repaginate" ? paginate(l, input.questions_per_page ?? 0) : input.pages!;
            if (pages.length !== l.slots.length) throw new CampusError("PLAN_STALE", "Las preguntas del cuestionario cambiaron: no se puede volver a la paginación anterior.");
            if (JSON.stringify(pages) === JSON.stringify(l.slots.map((s) => s.page))) throw new CampusError("WRITE_NOT_ALLOWED", "El cuestionario ya está paginado así.");
            if (input.action === "repaginate") {
                items = [{ item_id: "i1", description: `Repaginar: ${input.questions_per_page ? `${input.questions_per_page} por página` : "todas en una página"}`, call: form("quiz_repaginate", { cmid: String(cmid) }, { repaginate: "1", questionsperpage: String(input.questions_per_page ?? 0) }), target, expected: { op: "repaginate", pages, prior_pages: l.slots.map((s) => s.page) } }];
                summary = `Repaginar el cuestionario «${quiz.name ?? quiz.id}» con ${input.questions_per_page ? `${input.questions_per_page} pregunta(s) por página` : "todas las preguntas en una página"} (${Math.max(0, ...l.slots.map((s) => s.page))} → ${Math.max(0, ...pages)} páginas).`;
                undo = { kind: "compensación", how: "Volver a poner o quitar cada salto de página que cambió.", until: null };
            } else {
                items = breakItems(quiz.id, cmid, l, pages);
                summary = `Volver a la paginación anterior del cuestionario «${quiz.name ?? quiz.id}» (${items.length} salto(s) de página).`;
                undo = { kind: "ninguno", how: "Es un deshacer.", until: null };
            }
            break;
        }
        case "page_break": {
            const i = l.slots.findIndex((s) => s.slot_id === input.after_slot_id);
            if (i < 0) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El cuestionario no tiene el slot ${input.after_slot_id ?? "(falta after_slot_id)"}.`);
            const n = i + 1;
            if (n === l.slots.length) throw new CampusError("WRITE_NOT_ALLOWED", "Después de la última pregunta no hay salto de página que cambiar.");
            const want = input.page_break ?? true;
            if (want === !joined(l, n)) throw new CampusError("WRITE_NOT_ALLOWED", want ? "Ya hay un salto de página después de esa pregunta." : "No hay salto de página después de esa pregunta.");
            if (!want && l.slots[n]!.section_id !== l.slots[n - 1]!.section_id) throw new CampusError("WRITE_NOT_ALLOWED", "Ese salto separa dos secciones: cada sección empieza en una página nueva.");
            items = breakItems(quiz.id, cmid, l, l.slots.map((s, k) => (k < n ? s.page : s.page + (want ? 1 : -1))));
            summary = `${want ? "Agregar" : "Quitar"} el salto de página después de la pregunta ${n} del cuestionario «${quiz.name ?? quiz.id}».`;
            risk = "R1";
            break;
        }
        case "add_section": {
            const page = input.page ?? 0;
            const pages = [...new Set(l.slots.map((s) => s.page))];
            if (!pages.includes(page) || page < 2) throw new CampusError("WRITE_NOT_ALLOWED", `La página ${page} no existe o es la primera (páginas: ${pages.join(", ") || "ninguna"}).`);
            if (l.sections.some((s) => s.first_page === page)) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay una sección que empieza en la página ${page}.`);
            items = [{ item_id: "i1", description: `Agregar una sección en la página ${page}`, call: form("quiz_section_add", { cmid: String(cmid), addsectionatpage: String(page) }, {}), target, expected: { op: "add_section", page, prior_section_ids: l.sections.map((s) => s.section_id) } }];
            summary = `Agregar una sección (con la cabecera por defecto de Moodle) que empieza en la página ${page} del cuestionario «${quiz.name ?? quiz.id}». Para nombrarla, rename_section con el section_id que devuelve.`;
            undo = { kind: "compensación", how: "Quitar la sección agregada.", until: null };
            break;
        }
        case "rename_section": {
            const heading = (input.heading ?? "").trim();
            if (heading === section!.heading) throw new CampusError("WRITE_NOT_ALLOWED", "La sección ya tiene esa cabecera.");
            items = [{ item_id: "i1", description: `Cabecera de la sección ${section!.section_id}`, call: form("quiz_section_update", {}, { quizid: String(quiz.id), class: "section", field: "updatesectiontitle", id: String(section!.section_id), newheading: heading }), target, expected: { op: "rename_section", section_id: section!.section_id, heading, prior: section!.heading } }];
            summary = `Cambiar la cabecera de la sección ${section!.section_id} de «${section!.heading || "(sin título)"}» a «${heading || "(sin título)"}».`;
            risk = "R1";
            prior.heading = section!.heading;
            break;
        }
        case "shuffle_section": {
            const shuffle = input.shuffle ?? true;
            if (shuffle === section!.shuffle) throw new CampusError("WRITE_NOT_ALLOWED", `La sección ya ${shuffle ? "baraja" : "no baraja"} sus preguntas.`);
            items = [{ item_id: "i1", description: `Orden al azar de la sección ${section!.section_id}`, call: form("quiz_section_update", {}, { quizid: String(quiz.id), class: "section", field: "updateshufflequestions", id: String(section!.section_id), newshuffle: shuffle ? "1" : "0" }), target, expected: { op: "shuffle_section", section_id: section!.section_id, shuffle } }];
            summary = `${shuffle ? "Barajar" : "Dejar de barajar"} las preguntas de la sección «${section!.heading || section!.section_id}» (vale para los intentos nuevos).`;
            risk = "R1";
            break;
        }
        case "remove_section": {
            if (l.sections[0]?.section_id === section!.section_id) throw new CampusError("WRITE_NOT_ALLOWED", "La primera sección no se puede quitar.");
            items = [{ item_id: "i1", description: `Quitar la sección ${section!.section_id}`, call: form("quiz_section_delete", {}, { quizid: String(quiz.id), class: "section", action: "DELETE", id: String(section!.section_id) }), target, expected: { op: "remove_section", section_id: section!.section_id } }];
            summary = `Quitar la sección «${section!.heading || "(sin título)"}» (sus preguntas pasan a la sección anterior; no se borra ninguna pregunta).`;
            undo = { kind: "compensación", how: "Volver a agregar una sección en la misma página (otro id, con la cabecera por defecto; la cabecera y el orden al azar se restauran aparte).", until: null };
            Object.assign(prior, { heading: section!.heading, shuffle: section!.shuffle, first_page: section!.first_page });
            break;
        }
    }
    return {
        intent: "quiz_layout",
        capability: "edit_quiz",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: { quiz: { quiz_id: quiz.id, course_module_id: cmid, name: quiz.name ?? null }, sections: l.sections, slots: l.slots.map((s) => ({ slot_id: s.slot_id, number: s.number, page: s.page, section_id: s.section_id })) },
        side_effects: ["Cambia cómo ven el cuestionario los estudiantes en sus intentos NUEVOS.", "Moodle borra las vistas previas del cuestionario. Sin notificaciones."],
        preconditions: { description: "Las páginas y secciones del cuestionario no cambiaron desde el plan.", versions: { [`qlayout:${cmid}`]: signature(l) } },
        undo,
        warnings: [],
        items,
        prior_state: prior,
        untrusted_fields: ["payload_preview.quiz.name", "payload_preview.sections"],
        teacher_text: input.heading ? { heading: input.heading } : {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    quiz_id: z.number().int().positive().describe("quiz_id (sale de campus_list_quizzes)."),
    operation: z
        .enum(["repaginate", "page_break", "add_section", "rename_section", "shuffle_section", "remove_section"])
        .describe("repaginate (questions_per_page; 0 = todas en una página); page_break (after_slot_id, page_break true = agregar, false = quitar); add_section (page: la página donde empieza, no la primera); rename_section (section_id, heading); shuffle_section (section_id, shuffle); remove_section (section_id; no la primera)."),
    questions_per_page: z.number().int().min(0).max(50).optional(),
    after_slot_id: z.number().int().positive().optional().describe("slot_id de campus_get_quiz_structure."),
    page_break: z.boolean().optional(),
    page: z.number().int().min(2).max(1000).optional(),
    section_id: z.number().int().positive().optional().describe("Sale de la vista previa de un plan anterior (payload_preview.sections)."),
    heading: z.string().max(1000).optional().describe("Cabecera de la sección (vacía = sin título)."),
    shuffle: z.boolean().optional(),
};

export const quizLayoutIntent: WriteIntent<typeof shape> = {
    name: "quiz_layout",
    title: "Plan: páginas y secciones de un cuestionario",
    description: "Arma el plan para repaginar, poner o quitar un salto de página, agregar, renombrar o quitar una sección, o barajar sus preguntas. Lo estructural exige que no haya intentos. La vista previa lista secciones (section_id) y slots con su página. No escribe.",
    inputShape: shape,
    capability: "edit_quiz",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: ({ operation, ...rest }, ctx) => build({ ...rest, action: operation }, ctx, null),
    async undo(plan, result, ctx) {
        const done = result.items.filter((r) => r.outcome === "verificado" || r.outcome === "con_diferencias");
        if (!done.length) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const x = plan.items[0]!.expected as { op: string; section_id?: number; shuffle?: boolean; page_break?: boolean; slot_id?: number };
        const p = plan.prior_state as { pages: number[]; heading?: string; shuffle?: boolean; first_page?: number };
        const base = { course_id: plan.course_id, quiz_id: Number(plan.items[0]!.target.quiz_id) };
        switch (x.op) {
            case "repaginate":
            case "page_break":
                return { kind: "plan", draft: await build({ ...base, action: "restore_pages", pages: p.pages }, ctx, result.action_id) };
            case "add_section": {
                const id = done[0]!.moodle_ids.section_id;
                if (!id) return { kind: "ninguno", reason: "No se conoce la sección agregada." };
                return { kind: "plan", draft: await build({ ...base, action: "remove_section", section_id: id }, ctx, result.action_id) };
            }
            case "rename_section":
                return { kind: "plan", draft: await build({ ...base, action: "rename_section", section_id: x.section_id, heading: p.heading ?? "" }, ctx, result.action_id) };
            case "shuffle_section":
                return { kind: "plan", draft: await build({ ...base, action: "shuffle_section", section_id: x.section_id, shuffle: !x.shuffle }, ctx, result.action_id) };
            default:
                if (!p.first_page) return { kind: "ninguno", reason: "No se conoce la página donde empezaba la sección." };
                return { kind: "plan", draft: await build({ ...base, action: "add_section", page: p.first_page }, ctx, result.action_id) };
        }
    },
};
