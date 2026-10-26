import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import type { FormSubmission } from "../web.js";
import { parseFormFields } from "../web.js";
import { fieldOf, stableHtml } from "./modform.js";

/**
 * W6 · Capítulos de un libro (mod_book; ADR-077), por los formularios del libro:
 * - agregar: `/mod/book/edit.php?cmid&pagenum&subchapter` (después del capítulo indicado o al final);
 * - editar título, nivel o contenido: `/mod/book/edit.php?cmid&id`;
 * - borrar: `/mod/book/delete.php?id&chapterid` con confirm=1 (un capítulo principal se lleva sus
 *   subcapítulos: el plan los lista);
 * - ocultar o mostrar: `/mod/book/show.php` (alterna; el plan parte del estado actual).
 * Lectura: la estructura del libro sale de core_course_get_contents (archivo «structure»); el contenido
 * de un capítulo, de su formulario (ruta `book_chapter_form`). Sin notificaciones.
 * Deshacer: borrar lo agregado; volver a los valores anteriores; volver a alternar; recrear un capítulo
 * borrado sin subcapítulos (compensación: otro id).
 */

const ContentsSchema = z.array(
    z.object({
        modules: z
            .array(
                z.object({
                    id: z.number().int(),
                    modname: z.string(),
                    name: z.string().nullable().optional(),
                    contents: z.array(z.object({ filename: z.string().nullable().optional(), content: z.string().nullable().optional() })).nullable().optional(),
                }),
            )
            .default([]),
    }),
);
const StructureSchema = z.array(
    z.object({ title: z.string(), href: z.string(), level: z.number().int(), hidden: z.union([z.string(), z.number()]).optional(), subitems: z.array(z.object({ title: z.string(), href: z.string(), level: z.number().int(), hidden: z.union([z.string(), z.number()]).optional() })).default([]) }),
);

interface Chapter {
    id: number;
    title: string;
    sub: boolean;
    hidden: boolean;
    /** Posición 1-based en el libro (pagenum). */
    pos: number;
}

async function bookOf(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "book") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es un libro (es ${m.modname}).`);
    const raw = m.contents?.find((c) => c.filename === "structure")?.content;
    let structure: z.infer<typeof StructureSchema> = [];
    if (raw) {
        try {
            structure = StructureSchema.parse(JSON.parse(raw));
        } catch {
            throw new CampusError("UNEXPECTED_RESPONSE", "No se pudo leer la estructura del libro.");
        }
    }
    const chapters: Chapter[] = [];
    const idOf = (href: string) => Number(/^(\d+)\//.exec(href)?.[1] ?? NaN);
    for (const c of structure) {
        chapters.push({ id: idOf(c.href), title: c.title, sub: c.level > 0, hidden: String(c.hidden ?? "0") === "1", pos: chapters.length + 1 });
        for (const s of c.subitems) chapters.push({ id: idOf(s.href), title: s.title, sub: true, hidden: String(s.hidden ?? "0") === "1", pos: chapters.length + 1 });
    }
    if (chapters.some((c) => !Number.isInteger(c.id))) throw new CampusError("UNEXPECTED_RESPONSE", "La estructura del libro trae un capítulo sin id.");
    return { cmid, name: m.name ?? "", chapters };
}

async function chapterForm(ctx: IntentContext, cmid: number, id: number) {
    const f = parseFormFields(await ctx.web.readPage("book_chapter_form", { cmid: String(cmid), id: String(id) }), "_qf__book_chapter_edit_form");
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `No se pudo abrir el capítulo ${id}.`);
    return { title: fieldOf(f, "title") ?? "", sub: fieldOf(f, "subchapter") === "1", content: stableHtml(fieldOf(f, "content_editor[text]") ?? "") };
}

const structureKey = (chapters: Chapter[]) => JSON.stringify(chapters.map((c) => [c.id, c.title, c.sub, c.hidden]));

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid, id] = k.split(":");
        if (kind === "book") out[k] = structureKey((await bookOf(ctx, Number(course), Number(cmid))).chapters);
        else if (kind === "chapter") out[k] = comparable((await chapterForm(ctx, Number(cmid), Number(id))).content);
        else out[k] = null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    if (item.call.fn !== "book_chapter_add") return { ok: true };
    const id = /[?&]chapterid=(\d+)/.exec((data as FormSubmission | null)?.location ?? "")?.[1];
    return id ? { ok: true, moodle_ids: { chapter_id: Number(id) } } : { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const x = item.expected as { action: string; chapter_id?: number; title?: string; sub?: boolean; content_text?: string; hidden?: boolean; prior_ids: number[]; gone?: number[]; prior?: Record<string, unknown> };
    const book = await bookOf(ctx, plan.course_id, Number(item.target.cmid));
    const differences: Difference[] = [];
    const check = (field: string, expected: unknown, observed: unknown) => {
        if (expected !== undefined && expected !== observed) differences.push({ field, expected, observed });
    };
    if (x.action === "move_up" || x.action === "move_down") {
        const now = book.chapters.find((c) => c.id === x.chapter_id)?.pos ?? null;
        const before = (x as { prior_pos?: number }).prior_pos ?? null;
        const ok = now !== null && before !== null && (x.action === "move_up" ? now < before : now > before);
        if (ok) return { outcome: "coincide", checked: ["posición"], differences: [] };
        return { outcome: now === before ? "sin_efecto" : "difiere", checked: ["posición"], differences: [{ field: "posición", expected: x.action === "move_up" ? `< ${before}` : `> ${before}`, observed: now }] };
    }
    if (x.action === "delete") {
        const left = (x.gone ?? []).filter((id) => book.chapters.some((c) => c.id === id));
        if (!left.length) return { outcome: "coincide", checked: ["capítulos"], differences: [] };
        return { outcome: left.length === x.gone!.length ? "sin_efecto" : "difiere", checked: ["capítulos"], differences: [{ field: "capítulos", expected: "borrados", observed: left }] };
    }
    const prior = new Set(x.prior_ids);
    const ch = x.action === "add" ? book.chapters.find((c) => (known.chapter_id ? c.id === known.chapter_id : !prior.has(c.id) && c.title === x.title)) : book.chapters.find((c) => c.id === x.chapter_id);
    if (!ch) return { outcome: "sin_efecto", checked: ["capítulo"], differences: [{ field: "capítulo", expected: x.action === "add" ? "agregado" : "existe", observed: "no aparece" }] };
    const checked = ["title", "subchapter"];
    check("title", x.title, ch.title);
    check("subchapter", x.sub, ch.sub);
    if (x.hidden !== undefined) {
        checked.push("hidden");
        check("hidden", x.hidden, ch.hidden);
    }
    if (x.content_text !== undefined) {
        checked.push("content");
        check("content", x.content_text, comparable((await chapterForm(ctx, Number(item.target.cmid), ch.id)).content));
    }
    const ids = x.action === "add" ? { chapter_id: ch.id } : undefined;
    if (!differences.length) return { outcome: "coincide", checked, differences, ...(ids ? { moodle_ids: ids } : {}) };
    const p = x.prior ?? {};
    const same = x.action !== "add" && differences.every((d) => p[d.field] === d.observed);
    return { outcome: same ? "sin_efecto" : "difiere", checked, differences, ...(ids ? { moodle_ids: ids } : {}) };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

type Action = "add" | "edit" | "delete" | "hide" | "show" | "move_up" | "move_down";
interface Req {
    course_id: number;
    course_module_id: number;
    action: Action;
    chapter_id?: number;
    title?: string;
    content?: string;
    content_html?: string;
    subchapter?: boolean;
    after_chapter_id?: number;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const book = await bookOf(ctx, input.course_id, input.course_module_id);
    const cmid = book.cmid;
    const byId = (id: number | undefined) => {
        const c = book.chapters.find((y) => y.id === id);
        if (!c) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El libro «${book.name}» no tiene el capítulo ${id ?? "(falta chapter_id)"}.`);
        return c;
    };
    const versions: Record<string, string> = { [`book:${input.course_id}:${cmid}`]: structureKey(book.chapters) };
    const priorIds = book.chapters.map((c) => c.id);
    const html = input.content_html ?? (input.content !== undefined ? toHtml(input.content, "markdown") : undefined);
    const title = input.title?.trim();
    if (input.title !== undefined && !title) throw new CampusError("WRITE_NOT_ALLOWED", "El título no puede quedar vacío.");
    let item: PlanItem;
    let summary: string;
    let risk: "R2" | "R3" = "R2";
    let undo: PlanDraft["undo"] = { kind: "compensación", how: "", until: null };
    const preview: Record<string, unknown> = { book: { course_module_id: cmid, name: book.name } };
    let prior: Record<string, unknown> = {};

    if (input.action === "add") {
        if (!title || html === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Para agregar un capítulo hacen falta title y content.");
        const sub = input.subchapter ?? false;
        if (sub && !book.chapters.length) throw new CampusError("WRITE_NOT_ALLOWED", "El primer capítulo de un libro no puede ser un subcapítulo.");
        let pagenum = book.chapters.length;
        if (input.after_chapter_id !== undefined) {
            const after = byId(input.after_chapter_id);
            pagenum = after.pos;
            // Un capítulo principal va después de los subcapítulos del indicado (si no, se los «llevaría»).
            if (!sub) while (pagenum < book.chapters.length && book.chapters[pagenum]!.sub) pagenum++;
        }
        item = {
            item_id: "i1",
            description: `Agregar ${sub ? "el subcapítulo" : "el capítulo"} «${title}»`,
            call: { kind: "form", fn: "book_chapter_add", params: { query: { cmid: String(cmid), pagenum: String(pagenum), subchapter: sub ? "1" : "0" }, fields: { title, subchapter: sub ? "1" : "0", "content_editor[text]": html, "content_editor[format]": "1" } } },
            target: { course_id: input.course_id, cmid },
            expected: { action: "add", title, sub, content_text: comparable(html), prior_ids: priorIds },
        };
        summary = `Agregar ${sub ? "un subcapítulo" : "un capítulo"} «${title}» al libro «${book.name}» (posición ${pagenum + 1}).`;
        Object.assign(preview, { title, subchapter: sub, position: pagenum + 1, content_html: html });
        undo = { kind: "compensación", how: "Borrar el capítulo agregado.", until: null };
    } else {
        const ch = byId(input.chapter_id);
        preview.chapter = { id: ch.id, title: ch.title, subchapter: ch.sub, hidden: ch.hidden };
        if (input.action === "edit") {
            if (title === undefined && html === undefined && input.subchapter === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá title, content o subchapter.");
            if (input.subchapter === true && ch.pos === 1) throw new CampusError("WRITE_NOT_ALLOWED", "El primer capítulo no puede ser un subcapítulo.");
            const form = await chapterForm(ctx, cmid, ch.id);
            versions[`chapter:${input.course_id}:${cmid}:${ch.id}`] = comparable(form.content);
            const fields: Record<string, string> = {};
            const expected: Record<string, unknown> = { action: "edit", chapter_id: ch.id, prior_ids: priorIds };
            prior = { title: ch.title, subchapter: ch.sub, content: comparable(form.content), content_html: form.content };
            if (title !== undefined) Object.assign(fields, { title }) && (expected.title = title);
            if (input.subchapter !== undefined) Object.assign(fields, { subchapter: input.subchapter ? "1" : "0" }) && (expected.sub = input.subchapter);
            if (html !== undefined) Object.assign(fields, { "content_editor[text]": html, "content_editor[format]": "1" }) && (expected.content_text = comparable(html));
            if ((title === undefined || title === ch.title) && (input.subchapter === undefined || input.subchapter === ch.sub) && (html === undefined || comparable(html) === comparable(form.content))) throw new CampusError("WRITE_NOT_ALLOWED", "El capítulo ya está así.");
            expected.prior = { title: ch.title, subchapter: ch.sub, content: comparable(form.content) };
            item = { item_id: "i1", description: `Editar el capítulo ${ch.id}`, call: { kind: "form", fn: "book_chapter_edit", params: { query: { cmid: String(cmid), id: String(ch.id) }, fields } }, target: { course_id: input.course_id, cmid }, expected };
            summary = `Editar el capítulo «${ch.title}» del libro «${book.name}».`;
            Object.assign(preview, { before: { title: ch.title, subchapter: ch.sub, content_html: form.content }, after: { title: title ?? ch.title, subchapter: input.subchapter ?? ch.sub, content_html: html ?? form.content } });
            undo = { kind: "compensación", how: "Volver al título, nivel y contenido anteriores (las imágenes incrustadas pueden no restaurarse igual).", until: null };
        } else if (input.action === "delete") {
            const gone = [ch.id];
            if (!ch.sub) for (let i = ch.pos; i < book.chapters.length && book.chapters[i]!.sub; i++) gone.push(book.chapters[i]!.id);
            const form = gone.length === 1 ? await chapterForm(ctx, cmid, ch.id) : null;
            prior = { title: ch.title, subchapter: ch.sub, content_html: form?.content ?? null, after_chapter_id: ch.pos > 1 ? book.chapters[ch.pos - 2]!.id : null };
            item = { item_id: "i1", description: `Borrar el capítulo ${ch.id}${gone.length > 1 ? ` y ${gone.length - 1} subcapítulo(s)` : ""}`, call: { kind: "form", fn: "book_chapter_delete", params: { query: { id: String(cmid), chapterid: String(ch.id) }, fields: { confirm: "1" } } }, target: { course_id: input.course_id, cmid }, expected: { action: "delete", chapter_id: ch.id, gone, prior_ids: priorIds } };
            summary = `BORRAR el capítulo «${ch.title}» del libro «${book.name}»${gone.length > 1 ? ` con sus ${gone.length - 1} subcapítulo(s)` : ""}.`;
            preview.deletes = gone.map((id) => ({ id, title: book.chapters.find((c) => c.id === id)!.title }));
            risk = "R3";
            undo = gone.length === 1 ? { kind: "compensación", how: "Volver a crear el capítulo con su título y contenido en el mismo lugar (otro id).", until: null } : { kind: "ninguno", how: "Un capítulo con subcapítulos borrado no se recrea automáticamente.", until: null };
        } else if (input.action === "move_up" || input.action === "move_down") {
            const up = input.action === "move_up";
            if (up && ch.pos === 1) throw new CampusError("WRITE_NOT_ALLOWED", "Es el primer capítulo.");
            if (!up && ch.pos === book.chapters.length) throw new CampusError("WRITE_NOT_ALLOWED", "Es el último capítulo.");
            item = { item_id: "i1", description: `Mover el capítulo ${ch.id} ${up ? "arriba" : "abajo"}`, call: { kind: "form", fn: "book_chapter_move", params: { query: { id: String(cmid), chapterid: String(ch.id), up: up ? "1" : "0" }, fields: {} } }, target: { course_id: input.course_id, cmid }, expected: { action: input.action, chapter_id: ch.id, prior_pos: ch.pos, prior_ids: priorIds } };
            summary = `Mover el capítulo «${ch.title}» del libro «${book.name}» un lugar hacia ${up ? "arriba" : "abajo"}.`;
            undo = { kind: "compensación", how: `Moverlo un lugar hacia ${up ? "abajo" : "arriba"}.`, until: null };
        } else {
            const hide = input.action === "hide";
            if (ch.hidden === hide) throw new CampusError("WRITE_NOT_ALLOWED", `El capítulo ya está ${hide ? "oculto" : "visible"}.`);
            item = { item_id: "i1", description: `${hide ? "Ocultar" : "Mostrar"} el capítulo ${ch.id}`, call: { kind: "form", fn: "book_chapter_toggle", params: { query: { id: String(cmid), chapterid: String(ch.id) }, fields: {} } }, target: { course_id: input.course_id, cmid }, expected: { action: input.action, chapter_id: ch.id, title: ch.title, sub: ch.sub, hidden: hide, prior_ids: priorIds, prior: { hidden: ch.hidden } } };
            summary = `${hide ? "Ocultar" : "Mostrar"} el capítulo «${ch.title}» del libro «${book.name}».`;
            undo = { kind: "exacto", how: `Volver a ${hide ? "mostrarlo" : "ocultarlo"}.`, until: null };
        }
    }
    return {
        intent: "book_chapter",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: preview,
        side_effects: [
            input.action === "delete" ? "El capítulo se BORRA (no va a la papelera)." : "Cambia lo que ven los participantes en el libro.",
            ...(input.action === "hide" || input.action === "show" ? ["Ocultar o mostrar un capítulo principal también afecta a sus subcapítulos."] : []),
            "Sin notificaciones.",
        ],
        preconditions: { description: "El libro no cambió desde el plan.", versions },
        undo,
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [item],
        prior_state: prior,
        untrusted_fields: ["payload_preview.book.name", "payload_preview.chapter.title", "payload_preview.before", "payload_preview.deletes"],
        teacher_text: Object.fromEntries(Object.entries({ title, content: html }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid del libro."),
    operation: z.enum(["add", "edit", "delete", "hide", "show", "move_up", "move_down"]).describe("add = agregar; edit = cambiar título, nivel o contenido; delete = borrar (con sus subcapítulos); hide / show = ocultar o mostrar; move_up / move_down = un lugar arriba o abajo (un capítulo principal lleva sus subcapítulos)."),
    chapter_id: z.number().int().positive().optional().describe("Capítulo (edit, delete, hide, show). Los ids salen de campus_get_course (archivos del libro, carpeta /<id>/)."),
    title: z.string().min(1).max(255).optional(),
    content: z.string().min(1).max(200_000).optional().describe("Contenido (Markdown)."),
    subchapter: z.boolean().optional().describe("true = subcapítulo (nivel 2)."),
    after_chapter_id: z.number().int().positive().optional().describe("add: ubicarlo después de este capítulo (por defecto, al final)."),
};

export const bookChapterIntent: WriteIntent<typeof shape> = {
    name: "book_chapter",
    title: "Plan: agregar, editar, borrar, ocultar o mostrar un capítulo de un libro",
    description: "Arma el plan para manejar los capítulos de un libro (mod_book): agregar (operation=add: title, content, subchapter, after_chapter_id), editar, borrar (R3) u ocultar/mostrar. Muestra antes y después. No escribe.",
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
        const x = plan.items[0]!.expected as { action: Action; chapter_id?: number; gone?: number[] };
        const base = { course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid) };
        const p = plan.prior_state as { title?: string; subchapter?: boolean; content_html?: string | null; after_chapter_id?: number | null };
        if (x.action === "add") {
            const id = r.moodle_ids.chapter_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce el capítulo agregado." };
            return { kind: "plan", draft: await build({ ...base, action: "delete", chapter_id: id }, ctx, result.action_id) };
        }
        if (x.action === "edit") return { kind: "plan", draft: await build({ ...base, action: "edit", chapter_id: x.chapter_id, title: p.title, subchapter: p.subchapter, content_html: p.content_html ?? undefined }, ctx, result.action_id) };
        if (x.action === "move_up" || x.action === "move_down") return { kind: "plan", draft: await build({ ...base, action: x.action === "move_up" ? "move_down" : "move_up", chapter_id: x.chapter_id }, ctx, result.action_id) };
        if (x.action === "hide" || x.action === "show") return { kind: "plan", draft: await build({ ...base, action: x.action === "hide" ? "show" : "hide", chapter_id: x.chapter_id }, ctx, result.action_id) };
        if ((x.gone ?? []).length !== 1 || !p.content_html) return { kind: "ninguno", reason: "El capítulo borrado tenía subcapítulos (o no se guardó su contenido): no se recrea automáticamente." };
        return { kind: "plan", draft: await build({ ...base, action: "add", title: p.title, subchapter: p.subchapter, content_html: p.content_html, ...(p.after_chapter_id ? { after_chapter_id: p.after_chapter_id } : {}) }, ctx, result.action_id) };
    },
};
