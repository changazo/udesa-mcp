import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { parseFormFields } from "../web.js";
import { FORM_OF, lessonOf, pagesKey, type Page } from "./lesson-pages.js";
import { fieldOf, stableHtml } from "./modform.js";

/**
 * W6 · Páginas de PREGUNTA de una lección (ADR-092), por los formularios de la lección
 * (`/mod/lesson/editpage.php`, uno por tipo): opción múltiple, verdadero/falso, respuesta corta,
 * numérica, ensayo y emparejamiento. Agregar (después de otra página) y editar (título, enunciado,
 * respuestas con su retroalimentación, salto y puntaje). Al editar, las respuestas que no se indican se
 * vacían y Moodle las borra.
 * Lectura y verificación: el formulario de edición de la página (lo que quedó guardado).
 * Deshacer: borrar la agregada; volver a las respuestas anteriores. Sin notificaciones.
 */

export const QUESTION_TYPES = { shortanswer: 1, truefalse: 2, multichoice: 3, matching: 5, numerical: 8, essay: 10 } as const;
type QType = keyof typeof QUESTION_TYPES;
/** Tipos cuya respuesta es un editor (HTML); en los demás es texto plano. */
const EDITOR_ANSWERS: QType[] = ["multichoice", "truefalse"];

const JUMPS: Record<string, string> = { this: "0", next: "-1", previous: "-40", end: "-9" };
const JUMP_NAMES: Record<string, string> = Object.fromEntries(Object.entries(JUMPS).map(([k, v]) => [v, k]));

interface Answer {
    text: string;
    feedback: string;
    jump: string;
    score: number;
}
/** Contenido de una página de pregunta, normalizado para comparar y para reenviar. */
interface Question {
    type: QType;
    title: string;
    html: string;
    option: boolean;
    answers: Answer[];
    /** Emparejamiento: pares pregunta → respuesta. */
    pairs: { question: string; answer: string }[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** La página de pregunta tal como está guardada (formulario de edición). */
async function readQuestion(ctx: IntentContext, cmid: number, page: Page): Promise<Question> {
    const form = FORM_OF[page.qtype];
    const type = (Object.keys(QUESTION_TYPES) as QType[]).find((t) => QUESTION_TYPES[t] === page.qtype);
    if (!form || !type) throw new CampusError("WRITE_NOT_ALLOWED", `La página ${page.id} no es de pregunta (es «${page.type}»).`);
    const f = parseFormFields(await ctx.web.readPage("lesson_page_form", { id: String(cmid), pageid: String(page.id), edit: "1" }), `_qf__lesson_add_page_form_${form}`);
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `No se pudo abrir la página ${page.id} de la lección.`);
    const get = (n: string) => fieldOf(f, n);
    const slots = [...new Set(f.map(([n]) => /^jumpto\[(\d+)\]$/.exec(n)?.[1]).filter((x): x is string => !!x).map(Number))].sort((a, b) => a - b);
    const ans = (i: number) => stableHtml(get(`answer_editor[${i}][text]`) ?? get(`answer_editor[${i}]`) ?? "");
    const resp = (i: number) => stableHtml(get(`response_editor[${i}][text]`) ?? get(`response_editor[${i}]`) ?? "");
    const q: Question = { type, title: get("title") ?? "", html: stableHtml(get("contents_editor[text]") ?? ""), option: get("qoption") === "1", answers: [], pairs: [] };
    if (type === "matching") {
        for (const i of [0, 1]) q.answers.push({ text: ans(i), feedback: "", jump: get(`jumpto[${i}]`) ?? "0", score: Number(get(`score[${i}]`) ?? 0) });
        for (let i = 2; get(`answer_editor[${i}][text]`) !== undefined; i++) if (comparable(ans(i)) || resp(i).trim()) q.pairs.push({ question: ans(i), answer: resp(i) });
    } else if (type === "essay") {
        q.answers.push({ text: "", feedback: "", jump: get("jumpto[0]") ?? "-1", score: Number(get("score[0]") ?? 1) });
    } else {
        // Respuestas con texto (las vacías no existen). El índice «otras respuestas» (enableotheranswers) no se toca.
        for (const i of slots) if (get(`answer_editor[${i}][text]`) !== undefined || get(`answer_editor[${i}]`) !== undefined) if (comparable(ans(i)) || ans(i).trim()) q.answers.push({ text: ans(i), feedback: resp(i), jump: get(`jumpto[${i}]`) ?? "0", score: Number(get(`score[${i}]`) ?? 0) });
    }
    return q;
}

/** Forma comparable (texto sin HTML) de una pregunta. */
const norm = (q: Question) => ({
    title: q.title,
    question: comparable(q.html),
    option: q.type === "multichoice" || q.type === "shortanswer" ? q.option : null,
    answers: q.answers.map((a) => ({ text: comparable(a.text) || a.text.trim(), feedback: comparable(a.feedback), jump: a.jump, score: a.score })),
    pairs: q.pairs.map((p) => ({ question: comparable(p.question), answer: p.answer.trim() })),
});

/** Campos del formulario para dejar la pregunta así; `slots` = respuestas que admite la lección. */
function fieldsOf(q: Question, slots: number): Record<string, string> {
    const out: Record<string, string> = { title: q.title, "contents_editor[text]": q.html, "contents_editor[format]": "1" };
    if (q.type === "multichoice" || q.type === "shortanswer") out.qoption = q.option ? "1" : "0";
    const editor = EDITOR_ANSWERS.includes(q.type);
    if (q.type === "essay") return Object.assign(out, { "jumpto[0]": q.answers[0]!.jump, "score[0]": String(q.answers[0]!.score) });
    if (q.type === "matching") {
        q.answers.slice(0, 2).forEach((a, i) => Object.assign(out, { [`answer_editor[${i}][text]`]: a.text, [`answer_editor[${i}][format]`]: "1", [`jumpto[${i}]`]: a.jump, [`score[${i}]`]: String(a.score) }));
        for (let i = 0; i < slots; i++) {
            const p = q.pairs[i];
            Object.assign(out, { [`answer_editor[${i + 2}][text]`]: p?.question ?? "", [`answer_editor[${i + 2}][format]`]: "1", [`response_editor[${i + 2}]`]: p?.answer ?? "" });
        }
        return out;
    }
    for (let i = 0; i < slots; i++) {
        const a = q.answers[i];
        if (editor) Object.assign(out, { [`answer_editor[${i}][text]`]: a?.text ?? "", [`answer_editor[${i}][format]`]: "1" });
        else out[`answer_editor[${i}]`] = a?.text ?? "";
        Object.assign(out, { [`response_editor[${i}][text]`]: a?.feedback ?? "", [`response_editor[${i}][format]`]: "1", [`jumpto[${i}]`]: a?.jump ?? "0", [`score[${i}]`]: String(a?.score ?? 0) });
    }
    return out;
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid, page] = k.split(":");
        if (kind === "lessonpages") out[k] = pagesKey((await lessonOf(ctx, Number(course), Number(cmid))).pages);
        else if (kind === "lessonq") {
            const l = await lessonOf(ctx, Number(course), Number(cmid));
            const p = l.pages.find((x) => x.id === Number(page));
            out[k] = p ? JSON.stringify(norm(await readQuestion(ctx, l.cmid, p))) : null;
        } else out[k] = null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { action: "add" | "edit"; page_id?: number; title: string; want: ReturnType<typeof norm>; prior?: ReturnType<typeof norm>; prior_ids?: number[] };
    const l = await lessonOf(ctx, plan.course_id, Number(item.target.cmid));
    const prior = new Set(x.prior_ids ?? []);
    const p = x.action === "add" ? l.pages.find((y) => !prior.has(y.id) && y.title === x.title) : l.pages.find((y) => y.id === x.page_id);
    if (!p) return { outcome: x.action === "add" ? "sin_efecto" : "difiere", checked: ["página"], differences: [{ field: "página", expected: x.action === "add" ? "agregada" : "existe", observed: "no aparece" }] };
    const now = norm(await readQuestion(ctx, l.cmid, p));
    const keys = Object.keys(x.want) as (keyof typeof now)[];
    const differences: Difference[] = keys.filter((k) => JSON.stringify(now[k]) !== JSON.stringify(x.want[k])).map((k) => ({ field: k, expected: x.want[k], observed: now[k] }));
    const ids = x.action === "add" ? { moodle_ids: { page_id: p.id } } : {};
    if (!differences.length) return { outcome: "coincide", checked: keys, differences, ...ids };
    return { outcome: x.prior && JSON.stringify(now) === JSON.stringify(x.prior) ? "sin_efecto" : "difiere", checked: keys, differences, ...ids };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

// ---------- entrada ----------

const jumpSchema = z.union([z.enum(["this", "next", "previous", "end"]), z.number().int().positive()]).describe("this = esta página, next = siguiente, previous = anterior, end = fin de la lección, o el page_id de una página de la lección.");
const answerSchema = z.strictObject({
    text: z.string().min(1).max(1_000).describe("Respuesta (texto). En numérica: un número o un rango «mín:máx»."),
    feedback: z.string().max(5_000).optional().describe("Retroalimentación (Markdown)."),
    correct: z.boolean().optional().describe("Atajo: correcta = salta a la siguiente con 1 punto; incorrecta = se queda en la página con 0. jump y score lo pisan."),
    jump: jumpSchema.optional(),
    score: z.number().int().min(-100).max(100).optional(),
});
type AnswerIn = z.infer<typeof answerSchema>;

interface Req {
    course_id: number;
    course_module_id: number;
    action: "add" | "edit";
    page_id?: number;
    after_page_id?: number;
    question_type?: QType;
    title?: string;
    question?: string;
    multiple_answers?: boolean;
    case_sensitive?: boolean;
    answers?: AnswerIn[];
    pairs?: { question: string; answer: string }[];
    correct_feedback?: string;
    wrong_feedback?: string;
    jump?: z.infer<typeof jumpSchema>;
    score?: number;
    /** Deshacer: la pregunta completa a restaurar (ya normalizada para reenviar). */
    restore?: Question;
}

function jumpOf(j: z.infer<typeof jumpSchema> | undefined, fallback: string, pageIds: Set<number>): string {
    if (j === undefined) return fallback;
    if (typeof j === "number") {
        if (!pageIds.has(j)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El salto apunta a la página ${j}, que no es de esta lección.`);
        return String(j);
    }
    return JUMPS[j]!;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const l = await lessonOf(ctx, input.course_id, input.course_module_id);
    const slots = l.maxanswers && l.maxanswers > 0 ? l.maxanswers : 4;
    const pageIds = new Set(l.pages.map((p) => p.id));
    const versions: Record<string, string | null> = { [`lessonpages:${input.course_id}:${l.cmid}`]: pagesKey(l.pages) };
    const page = input.action === "edit" ? l.pages.find((p) => p.id === input.page_id) : undefined;
    if (input.action === "edit" && !page) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La lección «${l.name}» no tiene la página ${input.page_id ?? "(falta page_id)"}.`);
    const cur = page ? await readQuestion(ctx, l.cmid, page) : null;
    if (page && cur) versions[`lessonq:${input.course_id}:${l.cmid}:${page.id}`] = JSON.stringify(norm(cur));
    const type: QType = cur?.type ?? input.question_type ?? (() => { throw new CampusError("WRITE_NOT_ALLOWED", "Para agregar hace falta question_type."); })();
    if (cur && input.question_type && input.question_type !== cur.type) throw new CampusError("WRITE_NOT_ALLOWED", `La página es de tipo ${cur.type}: el tipo no se cambia.`);
    let q: Question;
    if (input.restore) q = input.restore;
    else {
        const title = input.title?.trim() ?? cur?.title;
        const html = input.question !== undefined ? toHtml(input.question, "markdown") : cur?.html;
        if (!title || !html || !comparable(html)) throw new CampusError("WRITE_NOT_ALLOWED", "Hacen falta title y question (el enunciado).");
        q = { type, title, html, option: cur?.option ?? false, answers: cur?.answers ?? [], pairs: cur?.pairs ?? [] };
        if (input.multiple_answers !== undefined) {
            if (type !== "multichoice") throw new CampusError("WRITE_NOT_ALLOWED", "multiple_answers sólo vale para opción múltiple.");
            q.option = input.multiple_answers;
        }
        if (input.case_sensitive !== undefined) {
            if (type !== "shortanswer") throw new CampusError("WRITE_NOT_ALLOWED", "case_sensitive sólo vale para respuesta corta.");
            q.option = input.case_sensitive;
        }
        if (type === "essay") {
            if (input.answers || input.pairs) throw new CampusError("WRITE_NOT_ALLOWED", "Un ensayo no tiene respuestas: sólo jump y score.");
            q.answers = [{ text: "", feedback: "", jump: jumpOf(input.jump, cur?.answers[0]?.jump ?? "-1", pageIds), score: input.score ?? cur?.answers[0]?.score ?? 1 }];
        } else if (type === "matching") {
            if (input.answers) throw new CampusError("WRITE_NOT_ALLOWED", "El emparejamiento usa pairs (y correct_feedback, wrong_feedback), no answers.");
            if (input.pairs) {
                if (input.pairs.length < 2 || input.pairs.length > slots) throw new CampusError("WRITE_NOT_ALLOWED", `Entre 2 y ${slots} pares (lo que admite la lección).`);
                q.pairs = input.pairs.map((p) => ({ question: esc(p.question.trim()), answer: p.answer.trim() }));
            }
            const fb = (s: string | undefined, prev: Answer | undefined, jump: string, score: number): Answer => ({ text: s !== undefined ? toHtml(s, "markdown") : (prev?.text ?? ""), feedback: "", jump: prev?.jump ?? jump, score: prev?.score ?? score });
            q.answers = [fb(input.correct_feedback, cur?.answers[0], "-1", 1), fb(input.wrong_feedback, cur?.answers[1], "0", 0)];
            if (q.pairs.length < 2) throw new CampusError("WRITE_NOT_ALLOWED", "Hacen falta al menos 2 pares (pairs).");
        } else if (input.answers) {
            const min = type === "truefalse" ? 2 : 1;
            const max = type === "truefalse" ? 2 : slots;
            if (input.answers.length < min || input.answers.length > max) throw new CampusError("WRITE_NOT_ALLOWED", `Entre ${min} y ${max} respuestas (${type === "truefalse" ? "verdadero/falso: la primera y la segunda" : "lo que admite la lección"}).`);
            const editor = EDITOR_ANSWERS.includes(type);
            q.answers = input.answers.map((a) => {
                if (type === "numerical" && !/^-?\d+([.,]\d+)?(:-?\d+([.,]\d+)?)?$/.test(a.text.trim())) throw new CampusError("WRITE_NOT_ALLOWED", `«${a.text}» no es un número ni un rango «mín:máx».`);
                const correct = a.correct ?? false;
                return { text: editor ? esc(a.text.trim()) : a.text.trim(), feedback: a.feedback ? toHtml(a.feedback, "markdown") : "", jump: jumpOf(a.jump, correct ? "-1" : "0", pageIds), score: a.score ?? (correct ? 1 : 0) };
            });
        } else if (!cur) throw new CampusError("WRITE_NOT_ALLOWED", "Hacen falta answers.");
        if (!q.answers.length && type !== "matching") throw new CampusError("WRITE_NOT_ALLOWED", "Hacen falta answers.");
    }
    if (type !== "matching" && !q.answers.length) throw new CampusError("WRITE_NOT_ALLOWED", "La página no tiene respuestas reconocibles.");
    if (type === "matching" && q.pairs.length < 2) throw new CampusError("WRITE_NOT_ALLOWED", "Hacen falta al menos 2 pares (pairs).");
    const want = norm(q);
    if (cur && JSON.stringify(want) === JSON.stringify(norm(cur))) throw new CampusError("WRITE_NOT_ALLOWED", "La página ya está así.");
    const form = FORM_OF[QUESTION_TYPES[type]]!;
    const fields = fieldsOf(q, slots);
    let item: PlanItem;
    let summary: string;
    if (input.action === "add") {
        const after = input.after_page_id !== undefined ? l.pages.find((p) => p.id === input.after_page_id) : l.pages.at(-1);
        if (input.after_page_id !== undefined && !after) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La lección no tiene la página ${input.after_page_id}.`);
        item = {
            item_id: "i1",
            description: `Agregar la página de pregunta «${q.title}» (${type})`,
            call: { kind: "form", fn: `lesson_question_add_${form}`, params: { query: { id: String(l.cmid), pageid: String(after?.id ?? 0), qtype: String(QUESTION_TYPES[type]), firstpage: after ? "0" : "1" }, fields } },
            target: { course_id: input.course_id, cmid: l.cmid },
            expected: { action: "add", title: q.title, want, prior_ids: [...pageIds] },
        };
        summary = `Agregar la página de pregunta «${q.title}» (${type}) a la lección «${l.name}»${after ? ` después de «${after.title}»` : " (primera página)"}.`;
    } else {
        item = {
            item_id: "i1",
            description: `Editar la pregunta de la página ${page!.id}`,
            call: { kind: "form", fn: `lesson_page_edit_${form}`, params: { query: { id: String(l.cmid), pageid: String(page!.id), edit: "1" }, fields } },
            target: { course_id: input.course_id, cmid: l.cmid },
            expected: { action: "edit", page_id: page!.id, title: q.title, want, prior: norm(cur!) },
        };
        summary = `Editar la página de pregunta «${cur!.title}» (${type}) de la lección «${l.name}».`;
    }
    const show = (x: ReturnType<typeof norm>) => ({ ...x, answers: x.answers.map((a) => ({ ...a, jump: JUMP_NAMES[a.jump] ?? `página ${a.jump}` })) });
    return {
        intent: "lesson_question",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: { lesson: { course_module_id: l.cmid, name: l.name, answers_per_page: slots }, ...(cur ? { before: show(norm(cur)) } : {}), after: show(want) },
        side_effects: ["Cambia lo que ven y responden los estudiantes en la lección; los intentos ya hechos no se recalculan.", ...(cur ? ["Las respuestas que no se indican se borran."] : []), "Sin notificaciones."],
        preconditions: { description: "Las páginas de la lección no cambiaron desde el plan.", versions },
        undo: { kind: "compensación", how: input.action === "add" ? "Borrar la página agregada." : "Volver al enunciado y las respuestas anteriores.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [item],
        prior_state: cur ? { question: cur } : {},
        untrusted_fields: ["payload_preview.lesson.name", "payload_preview.before"],
        teacher_text: Object.fromEntries(Object.entries({ title: input.title, question: input.question }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

/** Plan para recrear una página de pregunta borrada (deshacer de campus_plan_lesson_page). */
export async function recreateQuestionDraft(courseId: number, cmid: number, q: Question, afterPageId: number | null, ctx: IntentContext, undoOf: string): Promise<PlanDraft> {
    return build({ course_id: courseId, course_module_id: cmid, action: "add", question_type: q.type, ...(afterPageId ? { after_page_id: afterPageId } : {}), restore: q }, ctx, undoOf);
}
export { readQuestion, type Question };

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la lección."),
    operation: z.enum(["add", "edit"]).describe("add = página de pregunta nueva; edit = cambiar enunciado o respuestas de una existente (para borrarla: campus_plan_lesson_page)."),
    page_id: z.number().int().positive().optional().describe("edit: la página (sale de campus_get_activity_content)."),
    after_page_id: z.number().int().positive().optional().describe("add: después de esta página (por defecto, al final)."),
    question_type: z.enum(["multichoice", "truefalse", "shortanswer", "numerical", "essay", "matching"]).optional().describe("add: tipo de pregunta."),
    title: z.string().min(1).max(255).optional(),
    question: z.string().min(1).max(100_000).optional().describe("Enunciado (Markdown)."),
    multiple_answers: z.boolean().optional().describe("Opción múltiple: admite varias respuestas correctas."),
    case_sensitive: z.boolean().optional().describe("Respuesta corta: distingue mayúsculas."),
    answers: z.array(answerSchema).min(1).max(20).optional().describe("Opción múltiple, verdadero/falso (dos: la primera y la segunda), respuesta corta, numérica. Al editar, reemplaza TODAS las respuestas."),
    pairs: z.array(z.strictObject({ question: z.string().min(1).max(1_000), answer: z.string().min(1).max(255) })).max(20).optional().describe("Emparejamiento: pares pregunta → respuesta."),
    correct_feedback: z.string().max(5_000).optional().describe("Emparejamiento: retroalimentación si acierta."),
    wrong_feedback: z.string().max(5_000).optional().describe("Emparejamiento: retroalimentación si no acierta."),
    jump: jumpSchema.optional().describe("Ensayo: a dónde va después (por defecto, la siguiente)."),
    score: z.number().int().min(-100).max(100).optional().describe("Ensayo: puntaje."),
};

export const lessonQuestionIntent: WriteIntent<typeof shape> = {
    name: "lesson_question",
    title: "Plan: agregar o editar una página de pregunta de una lección",
    description: "Arma el plan para agregar una página de pregunta (opción múltiple, verdadero/falso, respuesta corta, numérica, ensayo, emparejamiento) o editar el enunciado y las respuestas (con retroalimentación, salto y puntaje) de una existente. No escribe.",
    inputShape: shape,
    capability: "manage_activity_entries",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: ({ operation, ...rest }, ctx) => build({ ...rest, action: operation }, ctx, null),
    async undo(plan, result, ctx) {
        const r = result.items[0];
        if (!r || !(r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const x = plan.items[0]!.expected as { action: "add" | "edit"; page_id?: number };
        const cmid = Number(plan.items[0]!.target.cmid);
        if (x.action === "add") {
            const id = r.moodle_ids.page_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce la página agregada." };
            const { lessonPageIntent } = await import("./lesson-pages.js");
            const draft = await lessonPageIntent.plan({ course_id: plan.course_id, course_module_id: cmid, operation: "delete", page_id: id }, ctx);
            return { kind: "plan", draft: { ...draft, summary: `Deshacer: ${draft.summary}`, undo_of: result.action_id } };
        }
        const prior = (plan.prior_state as { question?: Question }).question;
        if (!prior) return { kind: "ninguno", reason: "No se guardó la pregunta anterior." };
        return { kind: "plan", draft: await build({ course_id: plan.course_id, course_module_id: cmid, action: "edit", page_id: x.page_id, restore: prior }, ctx, result.action_id) };
    },
};
