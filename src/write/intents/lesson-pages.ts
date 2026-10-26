import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { parseFormFields } from "../web.js";
import { LESSON_PAGE_FORMS } from "../functions.js";
import { fieldOf, stableHtml } from "./modform.js";
import { QUESTION_TYPES, readQuestion, recreateQuestionDraft, type Question } from "./lesson-questions.js";

/**
 * W6 · Páginas de una lección (mod_lesson; ADR-081), por los formularios de la lección:
 * - agregar una página de CONTENIDO (`/mod/lesson/editpage.php?qtype=20`) después de otra, con un botón
 *   que lleva a la página siguiente (las de pregunta, con campus_plan_lesson_question, ADR-092);
 * - editar el título o el contenido de cualquier página (`editpage.php?edit=1`, un formulario por tipo;
 *   respuestas y saltos se reenvían tal cual);
 * - borrar una página (`lesson.php?action=delete`): R3, se pierden sus respuestas y los intentos en ella.
 * Lectura: `mod_lesson_get_pages` (orden por la cadena prev/next) y el formulario de la página para el
 * contenido tal como se guardó. Deshacer: borrar la agregada; volver al título y contenido anteriores;
 * recrear una página de contenido borrada (compensación: otro id, botón por defecto).
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));
const LessonsSchema = z.object({ lessons: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), course: z.number().int(), name: z.string().nullable().optional(), maxanswers: z.number().nullable().optional() })).default([]) });
const PagesSchema = z.object({
    pages: z.array(z.object({ page: z.object({ id: z.number().int(), prevpageid: z.number().nullable().optional(), nextpageid: z.number().nullable().optional(), title: z.string().nullable().optional(), contents: z.string().nullable().optional(), qtype: z.number().nullable().optional(), typestring: z.string().nullable().optional() }) })).default([]),
});
/** qtype de Moodle → formulario de edición. */
export const FORM_OF: Record<number, (typeof LESSON_PAGE_FORMS)[number]> = { 1: "shortanswer", 2: "truefalse", 3: "multichoice", 5: "matching", 8: "numerical", 10: "essay", 20: "branchtable", 21: "endofbranch", 30: "cluster", 31: "endofcluster" };
const CONTENT_PAGE = 20;

export interface Page {
    id: number;
    title: string;
    contents: string;
    qtype: number;
    type: string;
    pos: number;
}

export async function lessonOf(ctx: IntentContext, courseId: number, cmid: number) {
    const t = ctx.read.session.transport;
    const m = (await t.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "lesson") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es una lección (es ${m.modname}).`);
    const l = (await t.call("mod_lesson_get_lessons_by_courses", { courseids: [courseId] }, LessonsSchema)).lessons.find((x) => x.coursemodule === cmid && x.course === courseId);
    if (!l) throw new CampusError("UNEXPECTED_RESPONSE", "La lección no aparece en mod_lesson_get_lessons_by_courses.");
    const raw = (await t.call("mod_lesson_get_pages", { lessonid: l.id }, PagesSchema)).pages.map((p) => p.page);
    // Orden de la lección: la cadena desde la página sin anterior.
    const byId = new Map(raw.map((p) => [p.id, p]));
    const ordered: typeof raw = [];
    let cur = raw.find((p) => !p.prevpageid);
    while (cur && !ordered.includes(cur)) {
        ordered.push(cur);
        cur = cur.nextpageid ? byId.get(cur.nextpageid) : undefined;
    }
    for (const p of raw) if (!ordered.includes(p)) ordered.push(p);
    const pages: Page[] = ordered.map((p, i) => ({ id: p.id, title: p.title ?? "", contents: p.contents ?? "", qtype: p.qtype ?? 0, type: p.typestring ?? "", pos: i + 1 }));
    return { cmid, id: l.id, name: l.name ?? m.name ?? "", pages, maxanswers: l.maxanswers ?? null };
}

async function pageForm(ctx: IntentContext, cmid: number, page: Page) {
    const form = FORM_OF[page.qtype];
    if (!form) throw new CampusError("WRITE_NOT_ALLOWED", `Las páginas de tipo «${page.type}» no se editan por ahora.`);
    const f = parseFormFields(await ctx.web.readPage("lesson_page_form", { id: String(cmid), pageid: String(page.id), edit: "1" }), `_qf__lesson_add_page_form_${form}`);
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `No se pudo abrir la página ${page.id} de la lección.`);
    return { form, title: fieldOf(f, "title") ?? "", contents: stableHtml(fieldOf(f, "contents_editor[text]") ?? "") };
}

export const pagesKey = (pages: Page[]) => JSON.stringify(pages.map((p) => [p.id, p.title, comparable(p.contents)]));

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid] = k.split(":");
        out[k] = kind === "lessonpages" ? pagesKey((await lessonOf(ctx, Number(course), Number(cmid))).pages) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { action: string; page_id?: number; title?: string; contents_text?: string; prior_ids: number[]; prior?: { title: string; contents_text: string } };
    const l = await lessonOf(ctx, plan.course_id, Number(item.target.cmid));
    if (x.action === "delete") {
        const still = l.pages.some((p) => p.id === x.page_id);
        return still ? { outcome: "sin_efecto", checked: ["página"], differences: [{ field: "página", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["página"], differences: [] };
    }
    const prior = new Set(x.prior_ids);
    const p = x.action === "add" ? l.pages.find((y) => !prior.has(y.id) && y.title === x.title) : l.pages.find((y) => y.id === x.page_id);
    if (!p) return { outcome: "sin_efecto", checked: ["página"], differences: [{ field: "página", expected: x.action === "add" ? "agregada" : "existe", observed: "no aparece" }] };
    const now = { title: p.title, contents_text: comparable(p.contents) };
    const differences: Difference[] = (["title", "contents_text"] as const).filter((k) => x[k] !== undefined && x[k] !== now[k]).map((k) => ({ field: k, expected: x[k], observed: now[k] }));
    const ids = x.action === "add" ? { moodle_ids: { page_id: p.id } } : {};
    if (!differences.length) return { outcome: "coincide", checked: ["title", "contents_text"], differences, ...ids };
    const same = x.prior && now.title === x.prior.title && now.contents_text === x.prior.contents_text;
    return { outcome: same ? "sin_efecto" : "difiere", checked: ["title", "contents_text"], differences, ...ids };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

type Action = "add" | "edit" | "delete";
interface Req {
    course_id: number;
    course_module_id: number;
    action: Action;
    page_id?: number;
    title?: string;
    content?: string;
    content_html?: string;
    after_page_id?: number;
    button?: string;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const l = await lessonOf(ctx, input.course_id, input.course_module_id);
    const versions = { [`lessonpages:${input.course_id}:${l.cmid}`]: pagesKey(l.pages) };
    const priorIds = l.pages.map((p) => p.id);
    const html = input.content_html ?? (input.content !== undefined ? toHtml(input.content, "markdown") : undefined);
    const title = input.title?.trim();
    if (input.title !== undefined && !title) throw new CampusError("WRITE_NOT_ALLOWED", "El título no puede quedar vacío.");
    const preview: Record<string, unknown> = { lesson: { course_module_id: l.cmid, name: l.name }, pages_before: l.pages.map((p) => ({ page_id: p.id, position: p.pos, title: p.title, type: p.type })) };
    let item: PlanItem;
    let summary: string;
    let risk: "R2" | "R3" = "R2";
    let undo: PlanDraft["undo"];
    let prior: Record<string, unknown> = {};
    if (input.action === "add") {
        if (!title || html === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Para agregar una página hacen falta title y content.");
        const after = input.after_page_id !== undefined ? l.pages.find((p) => p.id === input.after_page_id) : l.pages.at(-1);
        if (input.after_page_id !== undefined && !after) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La lección no tiene la página ${input.after_page_id}.`);
        const button = (input.button ?? "Continuar").trim() || "Continuar";
        item = {
            item_id: "i1",
            description: `Agregar la página de contenido «${title}»`,
            call: { kind: "form", fn: "lesson_page_add", params: { query: { id: String(l.cmid), pageid: String(after?.id ?? 0), qtype: "20", firstpage: after ? "0" : "1" }, fields: { title, "contents_editor[text]": html, "contents_editor[format]": "1", "answer_editor[0]": button, "jumpto[0]": "-1" } } },
            target: { course_id: input.course_id, cmid: l.cmid },
            expected: { action: "add", title, contents_text: comparable(html), prior_ids: priorIds },
        };
        summary = `Agregar la página de contenido «${title}» a la lección «${l.name}»${after ? ` después de «${after.title}»` : " (primera página)"}.`;
        Object.assign(preview, { title, content_html: html, button, after_page_id: after?.id ?? null });
        undo = { kind: "compensación", how: "Borrar la página agregada.", until: null };
    } else {
        const p = l.pages.find((y) => y.id === input.page_id);
        if (!p) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La lección «${l.name}» no tiene la página ${input.page_id ?? "(falta page_id)"}.`);
        preview.page = { page_id: p.id, title: p.title, type: p.type };
        if (input.action === "edit") {
            if (title === undefined && html === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá title o content.");
            const form = await pageForm(ctx, l.cmid, p);
            const next = { title: title ?? form.title, html: html ?? form.contents };
            if (next.title === form.title && comparable(next.html) === comparable(form.contents)) throw new CampusError("WRITE_NOT_ALLOWED", "La página ya está así.");
            prior = { title: form.title, content_html: form.contents };
            const fields: Record<string, string> = {};
            if (title !== undefined) fields.title = title;
            if (html !== undefined) Object.assign(fields, { "contents_editor[text]": html, "contents_editor[format]": "1" });
            item = {
                item_id: "i1",
                description: `Editar la página ${p.id}`,
                call: { kind: "form", fn: `lesson_page_edit_${form.form}`, params: { query: { id: String(l.cmid), pageid: String(p.id), edit: "1" }, fields } },
                target: { course_id: input.course_id, cmid: l.cmid },
                expected: { action: "edit", page_id: p.id, ...(title !== undefined ? { title } : {}), ...(html !== undefined ? { contents_text: comparable(html) } : {}), prior: { title: form.title, contents_text: comparable(p.contents) } },
            };
            summary = `Editar la página «${p.title}» de la lección «${l.name}».`;
            Object.assign(preview, { before: { title: form.title, content_html: form.contents }, after: { title: next.title, content_html: next.html } });
            undo = { kind: "compensación", how: "Volver al título y contenido anteriores (las imágenes incrustadas pueden no restaurarse igual).", until: null };
        } else {
            const form = p.qtype === CONTENT_PAGE ? await pageForm(ctx, l.cmid, p) : null;
            const question = Object.values(QUESTION_TYPES).includes(p.qtype as never) ? await readQuestion(ctx, l.cmid, p) : null;
            const idx = l.pages.indexOf(p);
            prior = { qtype: p.qtype, title: p.title, content_html: form?.contents ?? null, after_page_id: idx > 0 ? l.pages[idx - 1]!.id : null, ...(question ? { question } : {}) };
            item = {
                item_id: "i1",
                description: `Borrar la página ${p.id}`,
                call: { kind: "form", fn: "lesson_page_delete", params: { query: { id: String(l.cmid), action: "delete", pageid: String(p.id) }, fields: {} } },
                target: { course_id: input.course_id, cmid: l.cmid },
                expected: { action: "delete", page_id: p.id, prior_ids: priorIds },
            };
            summary = `BORRAR la página «${p.title}» (${p.type}) de la lección «${l.name}».`;
            risk = "R3";
            undo =
                p.qtype === CONTENT_PAGE
                    ? { kind: "compensación", how: "Volver a crear la página de contenido con su título y contenido (otro id; un único botón a la página siguiente).", until: null }
                    : question
                      ? { kind: "compensación", how: "Volver a crear la página de pregunta con su enunciado y respuestas (otro id; los intentos registrados en ella no vuelven).", until: null }
                      : { kind: "ninguno", how: "Las páginas de este tipo no se recrean automáticamente.", until: null };
        }
    }
    return {
        intent: "lesson_page",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: preview,
        side_effects: [input.action === "delete" ? "La página se BORRA con sus respuestas y los intentos registrados en ella." : "Cambia lo que ven los estudiantes en la lección.", "Sin notificaciones."],
        preconditions: { description: "Las páginas de la lección no cambiaron desde el plan.", versions },
        undo,
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [item],
        prior_state: prior,
        untrusted_fields: ["payload_preview.lesson.name", "payload_preview.pages_before", "payload_preview.page", "payload_preview.before"],
        teacher_text: Object.fromEntries(Object.entries({ title, content: html, button: input.button }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la lección."),
    operation: z.enum(["add", "edit", "delete"]).describe("add = página de contenido nueva; edit = título o contenido de cualquier página; delete = borrar (R3)."),
    page_id: z.number().int().positive().optional().describe("Página (edit, delete). Los ids salen de campus_get_activity_content."),
    title: z.string().min(1).max(255).optional(),
    content: z.string().min(1).max(200_000).optional().describe("Contenido (Markdown)."),
    after_page_id: z.number().int().positive().optional().describe("add: después de esta página (por defecto, al final)."),
    button: z.string().min(1).max(255).optional().describe("add: texto del botón que lleva a la página siguiente (por defecto «Continuar»)."),
};

export const lessonPageIntent: WriteIntent<typeof shape> = {
    name: "lesson_page",
    title: "Plan: agregar, editar o borrar una página de una lección",
    description: "Arma el plan para agregar una página de contenido a una lección (title, content, after_page_id, button), editar el título o el contenido de cualquier página, o borrar una página (R3). No escribe.",
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
        const x = plan.items[0]!.expected as { action: Action; page_id?: number };
        const p = plan.prior_state as { qtype?: number; title?: string; content_html?: string | null; after_page_id?: number | null };
        const base = { course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid) };
        if (x.action === "add") {
            const id = r.moodle_ids.page_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce la página agregada." };
            return { kind: "plan", draft: await build({ ...base, action: "delete", page_id: id }, ctx, result.action_id) };
        }
        if (x.action === "edit") return { kind: "plan", draft: await build({ ...base, action: "edit", page_id: x.page_id, title: p.title, content_html: p.content_html ?? undefined }, ctx, result.action_id) };
        const q = (plan.prior_state as { question?: Question }).question;
        if (q) return { kind: "plan", draft: await recreateQuestionDraft(plan.course_id, base.course_module_id, q, p.after_page_id ?? null, ctx, result.action_id) };
        if (p.qtype !== CONTENT_PAGE || !p.content_html) return { kind: "ninguno", reason: "La página borrada no era de contenido ni de pregunta (o no se guardó su contenido): no se recrea automáticamente." };
        return { kind: "plan", draft: await build({ ...base, action: "add", title: p.title, content_html: p.content_html, ...(p.after_page_id ? { after_page_id: p.after_page_id } : {}) }, ctx, result.action_id) };
    },
};
