import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { parseFormFields } from "../web.js";
import { fieldOf, stableHtml } from "./modform.js";
import { parseQuestionnaireQuestions } from "../../domain/questionnaire.js";

/**
 * W6 · Preguntas de una encuesta (mod_questionnaire; ADR-097), por las páginas del plugin
 * (`/mod/questionnaire/questions.php`; no hay servicio web):
 * - lista: el formulario principal (botones `editbutton[<qid>]` en el orden de la encuesta);
 * - agregar: `?action=question&type_id=N`; editar: `?action=question&qid=N` (formulario
 *   edit_question_form: nombre, obligatoria, enunciado, opciones una por línea, length y precise);
 * - borrar: `?delq=<qid>` (el plugin la marca como borrada);
 * - mover (ADR-101): `?moveq=<qid>` sirve la lista con botones «colocar aquí» (`moveherebutton[<posición>]`).
 * Tipos: sí/no, cuadro de texto, texto amplio, botones de radio, casillas, lista desplegable, escala
 * Likert, fecha, numérico y descripción. Verificación releyendo el formulario de la pregunta.
 * Deshacer: borrar la agregada; volver a lo anterior; volver a crear una borrada (otro id; sus
 * respuestas no vuelven).
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));
export const QUESTION_TYPES = { yesno: 1, text: 2, essay: 3, radio: 4, checkbox: 5, dropdown: 6, rate: 8, date: 9, numeric: 10, label: 100 } as const;
type QType = keyof typeof QUESTION_TYPES;
const WITH_CHOICES: QType[] = ["radio", "checkbox", "dropdown", "rate"];

interface Question {
    id: number;
    type: QType;
    name: string;
    required: boolean;
    content_html: string;
    choices: string[];
    length: number;
    precise: number;
}

async function moduleOf(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "questionnaire") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es una encuesta (es ${m.modname}).`);
    return { cmid, name: m.name ?? "" };
}

/** Preguntas en el orden de la encuesta (id, posición, tipo y nombre). */
async function questionRows(ctx: IntentContext, cmid: number) {
    const rows = parseQuestionnaireQuestions(await ctx.web.readPage("questionnaire_questions", { id: String(cmid) }));
    if (!rows) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció la página de preguntas de la encuesta.");
    return rows;
}
const questionIds = async (ctx: IntentContext, cmid: number) => (await questionRows(ctx, cmid)).map((r) => r.question_id);

async function readQuestion(ctx: IntentContext, cmid: number, qid: number): Promise<Question | null> {
    const f = parseFormFields(await ctx.web.readPage("questionnaire_question_form", { id: String(cmid), qid: String(qid), action: "question" }), "_qf__mod_questionnaire_edit_question_form");
    if (!f || fieldOf(f, "qid") !== String(qid)) return null;
    const get = (n: string) => fieldOf(f, n) ?? "";
    const typeId = Number(get("type_id"));
    const type = (Object.keys(QUESTION_TYPES) as QType[]).find((t) => QUESTION_TYPES[t] === typeId);
    if (!type) throw new CampusError("WRITE_NOT_ALLOWED", `La pregunta ${qid} es de un tipo que no se maneja por esta vía (type_id ${typeId}).`);
    return { id: qid, type, name: get("name"), required: get("required") === "y", content_html: stableHtml(get("content[text]")), choices: get("allchoices").split(/\r?\n/).map((x) => x.trim()).filter(Boolean), length: Number(get("length") || 0), precise: Number(get("precise") || 0) };
}

const norm = (q: Question | null) => (q ? { type: q.type, name: q.name, required: q.required, content: comparable(q.content_html), choices: q.choices, length: q.length, precise: q.precise } : null);

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, cmid, qid] = k.split(":");
        if (kind === "qnrids") out[k] = (await questionIds(ctx, Number(cmid))).join(",");
        else if (kind === "qnrq") out[k] = JSON.stringify(norm(await readQuestion(ctx, Number(cmid), Number(qid))));
        else out[k] = null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const cmid = Number(item.target.cmid);
    const x = item.expected as { op: "add" | "edit" | "delete" | "move"; qid?: number; position?: number; prior_position?: number; want?: ReturnType<typeof norm>; prior?: ReturnType<typeof norm>; prior_ids?: number[] };
    const ids = await questionIds(ctx, cmid);
    if (x.op === "move") {
        const pos = ids.indexOf(x.qid!) + 1;
        if (pos === x.position) return { outcome: "coincide", checked: ["posición"], differences: [] };
        return { outcome: pos === x.prior_position ? "sin_efecto" : "difiere", checked: ["posición"], differences: [{ field: "posición", expected: x.position, observed: pos || null }] };
    }
    if (x.op === "delete") return ids.includes(x.qid!) ? { outcome: "sin_efecto", checked: ["pregunta"], differences: [{ field: "pregunta", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["pregunta"], differences: [] };
    let qid = x.qid;
    if (x.op === "add") {
        const fresh = ids.filter((i) => !(x.prior_ids ?? []).includes(i));
        if (fresh.length !== 1) return { outcome: fresh.length ? "difiere" : "sin_efecto", checked: ["pregunta"], differences: [{ field: "preguntas nuevas", expected: 1, observed: fresh.length }] };
        qid = fresh[0]!;
    }
    const now = norm(await readQuestion(ctx, cmid, qid!)) as Record<string, unknown> | null;
    if (!now) return { outcome: "difiere", checked: ["pregunta"], differences: [{ field: "pregunta", expected: "existe", observed: "no se lee" }] };
    const want = x.want as Record<string, unknown>;
    const keys = Object.keys(want);
    const differences: Difference[] = keys.filter((k) => JSON.stringify(now[k]) !== JSON.stringify(want[k])).map((k) => ({ field: k, expected: want[k], observed: now[k] }));
    const moodleIds = x.op === "add" ? { moodle_ids: { question_id: qid! } } : {};
    if (!differences.length) return { outcome: "coincide", checked: keys, differences, ...moodleIds };
    return { outcome: x.prior && JSON.stringify(now) === JSON.stringify(x.prior) ? "sin_efecto" : "difiere", checked: keys, differences, ...moodleIds };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

interface Req {
    course_id: number;
    course_module_id: number;
    action: "add" | "edit" | "delete" | "move";
    question_id?: number;
    position?: number;
    type?: QType;
    name?: string;
    question?: string;
    question_html?: string;
    required?: boolean;
    choices?: string[];
    length?: number;
    precise?: number;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const m = await moduleOf(ctx, input.course_id, input.course_module_id);
    const rows = await questionRows(ctx, m.cmid);
    const ids = rows.map((r) => r.question_id);
    const versions: Record<string, string | null> = { [`qnrids:${m.cmid}`]: ids.join(",") };
    const cur = input.action === "add" ? null : input.question_id && ids.includes(input.question_id) ? await readQuestion(ctx, m.cmid, input.question_id) : null;
    if (input.action !== "add") {
        if (!cur) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La encuesta «${m.name}» no tiene la pregunta ${input.question_id ?? "(falta question_id)"}.`);
        versions[`qnrq:${m.cmid}:${cur.id}`] = JSON.stringify(norm(cur));
    }
    let item: PlanItem;
    let summary: string;
    let risk: "R2" | "R3" = "R2";
    let undo: PlanDraft["undo"];
    if (input.action === "move") {
        const from = ids.indexOf(cur!.id) + 1;
        const to = input.position ?? 0;
        if (to < 1 || to > ids.length) throw new CampusError("WRITE_NOT_ALLOWED", `position va de 1 a ${ids.length}.`);
        if (to === from) throw new CampusError("WRITE_NOT_ALLOWED", `La pregunta ya está en la posición ${to}.`);
        item = { item_id: "i1", description: `Mover la pregunta ${cur!.id} a la posición ${to}`, call: { kind: "form", fn: "questionnaire_question_move", params: { query: { id: String(m.cmid), moveq: String(cur!.id) }, fields: { [`moveherebutton[${to}]`]: String(ids[to - 1]) } } }, target: { course_id: input.course_id, cmid: m.cmid }, expected: { op: "move", qid: cur!.id, position: to, prior_position: from } };
        summary = `Mover la pregunta «${cur!.name || cur!.id}» de la posición ${from} a la ${to} en la encuesta «${m.name}».`;
        undo = { kind: "compensación", how: "Volverla a su posición anterior.", until: null };
    } else if (input.action === "delete") {
        item = { item_id: "i1", description: `Borrar la pregunta ${cur!.id}`, call: { kind: "form", fn: "questionnaire_question_delete", params: { query: {}, fields: { id: String(m.cmid), delq: String(cur!.id) } } }, target: { course_id: input.course_id, cmid: m.cmid }, expected: { op: "delete", qid: cur!.id } };
        summary = `BORRAR la pregunta «${cur!.name || cur!.id}» (${cur!.type}) de la encuesta «${m.name}».`;
        risk = "R3";
        undo = { kind: "compensación", how: "Volver a crearla igual (otro id; las respuestas que tenía no vuelven).", until: null };
    } else {
        const type = cur?.type ?? input.type;
        if (!type) throw new CampusError("WRITE_NOT_ALLOWED", "Para agregar una pregunta hace falta type.");
        if (cur && input.type && input.type !== cur.type) throw new CampusError("WRITE_NOT_ALLOWED", `La pregunta es de tipo ${cur.type}: el tipo no se cambia.`);
        const html = input.question_html ?? (input.question !== undefined ? toHtml(input.question, "markdown") : cur?.content_html);
        if (!html || !comparable(html)) throw new CampusError("WRITE_NOT_ALLOWED", "Hace falta question (el enunciado).");
        const choices = input.choices ? input.choices.map((c) => c.trim()).filter(Boolean) : (cur?.choices ?? []);
        if (WITH_CHOICES.includes(type) && !choices.length) throw new CampusError("WRITE_NOT_ALLOWED", `Una pregunta de tipo ${type} necesita choices (una opción por elemento).`);
        if (!WITH_CHOICES.includes(type) && input.choices) throw new CampusError("WRITE_NOT_ALLOWED", `Una pregunta de tipo ${type} no tiene opciones.`);
        if (choices.some((c) => /[\r\n]/.test(c))) throw new CampusError("WRITE_NOT_ALLOWED", "Cada opción va en una sola línea.");
        const next: Question = { id: cur?.id ?? 0, type, name: input.name?.trim() ?? cur?.name ?? "", required: input.required ?? cur?.required ?? false, content_html: html, choices, length: input.length ?? cur?.length ?? 0, precise: input.precise ?? cur?.precise ?? 0 };
        const want = norm(next);
        if (cur && JSON.stringify(want) === JSON.stringify(norm(cur))) throw new CampusError("WRITE_NOT_ALLOWED", "La pregunta ya está así.");
        const fields: Record<string, string> = { name: next.name, required: next.required ? "y" : "n", "content[text]": next.content_html, "content[format]": "1", length: String(next.length), precise: String(next.precise), ...(WITH_CHOICES.includes(type) ? { allchoices: choices.join("\n") } : {}) };
        if (type === "label") delete fields.required;
        item = cur
            ? { item_id: "i1", description: `Editar la pregunta ${cur.id}`, call: { kind: "form", fn: "questionnaire_question_edit", params: { query: { id: String(m.cmid), qid: String(cur.id), action: "question" }, fields } }, target: { course_id: input.course_id, cmid: m.cmid }, expected: { op: "edit", qid: cur.id, want, prior: norm(cur) } }
            : { item_id: "i1", description: `Agregar una pregunta (${type})`, call: { kind: "form", fn: "questionnaire_question_add", params: { query: { id: String(m.cmid), action: "question", type_id: String(QUESTION_TYPES[type]) }, fields } }, target: { course_id: input.course_id, cmid: m.cmid }, expected: { op: "add", want, prior_ids: ids } };
        summary = cur ? `Editar la pregunta «${cur.name || cur.id}» (${type}) de la encuesta «${m.name}».` : `Agregar una pregunta de tipo ${type}${next.name ? ` («${next.name}»)` : ""} al final de la encuesta «${m.name}»${choices.length ? ` con ${choices.length} opción(es)` : ""}.`;
        undo = { kind: "compensación", how: cur ? "Volver a la pregunta anterior." : "Borrar la pregunta agregada.", until: null };
    }
    return {
        intent: "questionnaire_question",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: { questionnaire: { course_module_id: m.cmid, name: m.name, questions: rows }, before: cur ? norm(cur) : null },
        side_effects: [input.action === "delete" ? "La pregunta deja de aparecer; sus respuestas quedan inaccesibles." : "Cambia lo que responden los participantes (las respuestas ya enviadas no se recalculan).", "Sin notificaciones."],
        preconditions: { description: "Las preguntas de la encuesta no cambiaron desde el plan.", versions },
        undo,
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [item],
        prior_state: cur ? { question: cur } : {},
        untrusted_fields: ["payload_preview.questionnaire.name", "payload_preview.questionnaire.questions", "payload_preview.before"],
        teacher_text: Object.fromEntries(Object.entries({ name: input.name, question: input.question }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la encuesta (questionnaire)."),
    operation: z.enum(["add", "edit", "delete", "move"]).describe("add = al final; edit = cambiar una existente (no su tipo); delete = borrar (R3); move = a otra posición (position)."),
    position: z.number().int().min(1).max(500).optional().describe("move: posición nueva (1 = primera)."),
    question_id: z.number().int().positive().optional().describe("edit, delete: la pregunta (sale de campus_get_activity_content sobre la encuesta)."),
    type: z.enum(["yesno", "text", "essay", "radio", "checkbox", "dropdown", "rate", "date", "numeric", "label"]).optional().describe("add: yesno, text (cuadro de texto), essay (texto amplio), radio, checkbox, dropdown, rate (escala Likert), date, numeric o label (descripción)."),
    name: z.string().max(255).optional().describe("Nombre corto de la pregunta (para los informes)."),
    question: z.string().min(1).max(20_000).optional().describe("Enunciado (Markdown)."),
    required: z.boolean().optional(),
    choices: z.array(z.string().min(1).max(500)).max(50).optional().describe("radio, checkbox, dropdown y rate: las opciones (en rate, los ítems a calificar)."),
    length: z.number().int().min(0).max(1000).optional().describe("Según el tipo: ancho del cuadro de texto, columnas del texto amplio, mínimo de casillas, alineación de los botones (0 vertical, 1 horizontal), cantidad de columnas de la escala, dígitos del numérico."),
    precise: z.number().int().min(0).max(1000).optional().describe("Según el tipo: largo máximo del texto, filas del texto amplio, máximo de casillas, tipo de escala, decimales del numérico."),
};

export const questionnaireQuestionIntent: WriteIntent<typeof shape> = {
    name: "questionnaire_question",
    title: "Plan: agregar, editar, mover o borrar una pregunta de una encuesta",
    description: "Arma el plan para agregar una pregunta al final de una encuesta (questionnaire), editar una existente (enunciado, nombre, obligatoria, opciones) o borrarla (R3). No escribe.",
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
        const x = plan.items[0]!.expected as { op: "add" | "edit" | "delete" | "move"; qid?: number; prior_position?: number };
        const base = { course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid) };
        if (x.op === "add") {
            const id = r.moodle_ids.question_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce la pregunta agregada." };
            return { kind: "plan", draft: await build({ ...base, action: "delete", question_id: id }, ctx, result.action_id) };
        }
        if (x.op === "move") return { kind: "plan", draft: await build({ ...base, action: "move", question_id: x.qid, position: x.prior_position }, ctx, result.action_id) };
        const q = (plan.prior_state as { question?: Question }).question!;
        const restore = { type: q.type, name: q.name, question_html: q.content_html, required: q.required, ...(WITH_CHOICES.includes(q.type) ? { choices: q.choices } : {}), length: q.length, precise: q.precise };
        if (x.op === "edit") return { kind: "plan", draft: await build({ ...base, action: "edit", question_id: x.qid, ...restore }, ctx, result.action_id) };
        return { kind: "plan", draft: await build({ ...base, action: "add", ...restore }, ctx, result.action_id) };
    },
};
