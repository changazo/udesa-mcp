import { z } from "zod";
import { CampusError } from "../errors.js";
import { DESCRIPTION_KINDS } from "./functions.js";
import type { IntentContext } from "./intent.js";
import type { WriteCapability } from "./policy.js";
import { parseFormFields } from "./web.js";
import { stableHtml } from "./intents/modform.js";

/**
 * ADR-137: dónde está guardado cada texto enriquecido que se puede editar en el lugar, cómo se lee tal como
 * está guardado (el formulario de Moodle, no la salida filtrada de los servicios), con qué formulario se guarda
 * y cómo lo ven los estudiantes (la salida de los servicios, para comprobar que Moodle lo muestra).
 */

export const TARGET_KINDS = ["section_summary", "label", "page_content", "description", "book_chapter"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const TargetSchema = z.object({
    kind: z.enum(TARGET_KINDS).describe("section_summary = resumen de una sección; label = texto de una etiqueta; page_content = contenido de una página; description = descripción de una actividad; book_chapter = contenido de un capítulo de libro."),
    section_number: z.number().int().min(0).max(200).optional().describe("section_summary: número de sección (0 = General)."),
    course_module_id: z.number().int().positive().optional().describe("label, page_content, description, book_chapter: cmid."),
    chapter_id: z.number().int().positive().optional().describe("book_chapter: id del capítulo."),
});
export type TargetRef = z.infer<typeof TargetSchema>;

/** Tipos con formulario de descripción (`course_modedit_<tipo>_update_text`). */
const DESCRIBABLE = new Set<string>(["assign", "quiz", "forum", "page", "url", ...DESCRIPTION_KINDS]);

const ContentsSchema = z.array(
    z.object({
        id: z.number().int(),
        section: z.number().nullable().optional(),
        name: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
        modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional(), description: z.string().nullable().optional() })).default([]),
    }),
);
const PagesSchema = z.object({ pages: z.array(z.object({ coursemodule: z.number().int(), content: z.string().nullable().optional() })).default([]) });

export interface ResolvedTarget {
    ref: TargetRef;
    course_id: number;
    /** Clave de la precondición (hash del HTML guardado). */
    key: string;
    label: string;
    capability: WriteCapability;
    form: { page: string; query: Record<string, string>; qf: string; field: string; format: string };
    submit: { fn: string; query: Record<string, string>; extra: Record<string, string> };
    /** Cómo lo muestra Moodle a los estudiantes (null: sin lectura de la vista). */
    display: ((ctx: IntentContext) => Promise<string>) | null;
}

async function contents(ctx: IntentContext, courseId: number) {
    return ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema);
}

export async function resolveTarget(ctx: IntentContext, courseId: number, ref: TargetRef): Promise<ResolvedTarget> {
    const c = await contents(ctx, courseId);
    if (ref.kind === "section_summary") {
        if (ref.section_number === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Para section_summary hace falta section_number.");
        const s = c.find((x) => x.section === ref.section_number);
        if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${ref.section_number} no existe en el curso ${courseId}.`);
        return {
            ref,
            course_id: courseId,
            key: `html:${courseId}:section:${s.id}`,
            label: `resumen de la sección ${ref.section_number} «${s.name ?? ""}»`,
            capability: "rename_content",
            form: { page: "editsection_form", query: { id: String(s.id) }, qf: "_qf__editsection_form", field: "summary_editor[text]", format: "summary_editor[format]" },
            submit: { fn: "course_section_edit", query: { id: String(s.id) }, extra: {} },
            display: async (x) => (await contents(x, courseId)).find((y) => y.id === s.id)?.summary ?? "",
        };
    }
    if (!ref.course_module_id) throw new CampusError("WRITE_NOT_ALLOWED", `Para ${ref.kind} hace falta course_module_id.`);
    const m = c.flatMap((s) => s.modules).find((x) => x.id === ref.course_module_id);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${ref.course_module_id} no es del curso ${courseId}.`);
    const name = m.name ?? "";
    const moduleDisplay = async (x: IntentContext) => (await contents(x, courseId)).flatMap((s) => s.modules).find((y) => y.id === m.id)?.description ?? "";
    const modedit = (field: string, format: string) => ({ page: "modedit_form", query: { update: String(m.id) }, qf: `_qf__mod_${m.modname}_mod_form`, field, format });
    if (ref.kind === "label") {
        if (m.modname !== "label") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${m.id} no es una etiqueta (es ${m.modname}).`);
        return { ref, course_id: courseId, key: `html:${courseId}:label:${m.id}`, label: `texto de la etiqueta ${m.id}`, capability: "edit_activity", form: modedit("introeditor[text]", "introeditor[format]"), submit: { fn: "course_modedit_label_update_text", query: { update: String(m.id) }, extra: { coursecontentnotification: "0" } }, display: moduleDisplay };
    }
    if (ref.kind === "page_content") {
        if (m.modname !== "page") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${m.id} no es una página (es ${m.modname}).`);
        return {
            ref,
            course_id: courseId,
            key: `html:${courseId}:page:${m.id}`,
            label: `contenido de la página «${name}»`,
            capability: "edit_activity",
            form: modedit("page[text]", "page[format]"),
            submit: { fn: "course_modedit_page_update_text", query: { update: String(m.id) }, extra: { coursecontentnotification: "0" } },
            display: async (x) => (await x.read.session.transport.call("mod_page_get_pages_by_courses", { courseids: [courseId] }, PagesSchema)).pages.find((p) => p.coursemodule === m.id)?.content ?? "",
        };
    }
    if (ref.kind === "description") {
        if (m.modname === "label") throw new CampusError("WRITE_NOT_ALLOWED", "El texto de una etiqueta es kind: label.");
        if (!DESCRIBABLE.has(m.modname)) throw new CampusError("WRITE_NOT_ALLOWED", `Las actividades de tipo ${m.modname} no tienen descripción editable por esta vía.`);
        return { ref, course_id: courseId, key: `html:${courseId}:desc:${m.id}`, label: `descripción de «${name}» (${m.modname})`, capability: "edit_activity", form: modedit("introeditor[text]", "introeditor[format]"), submit: { fn: `course_modedit_${m.modname}_update_text`, query: { update: String(m.id) }, extra: { coursecontentnotification: "0" } }, display: moduleDisplay };
    }
    if (m.modname !== "book") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${m.id} no es un libro (es ${m.modname}).`);
    if (!ref.chapter_id) throw new CampusError("WRITE_NOT_ALLOWED", "Para book_chapter hace falta chapter_id.");
    const q = { cmid: String(m.id), id: String(ref.chapter_id) };
    return { ref, course_id: courseId, key: `html:${courseId}:chapter:${m.id}.${ref.chapter_id}`, label: `capítulo ${ref.chapter_id} del libro «${name}»`, capability: "manage_activity_entries", form: { page: "book_chapter_form", query: q, qf: "_qf__book_chapter_edit_form", field: "content_editor[text]", format: "content_editor[format]" }, submit: { fn: "book_chapter_edit", query: q, extra: {} }, display: null };
}

/** El texto tal como está guardado, con las URLs de borrador normalizadas (cambian en cada apertura). Sólo HTML. */
export async function readStored(ctx: IntentContext, t: ResolvedTarget): Promise<string> {
    const f = parseFormFields(await ctx.web.readPage(t.form.page, t.form.query), t.form.qf);
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `No se reconoció el formulario del ${t.label}.`);
    const get = (n: string) => f.find(([k]) => k === n)?.[1];
    const format = get(t.form.format);
    if (format !== undefined && format !== "1") throw new CampusError("WRITE_NOT_ALLOWED", `El ${t.label} está guardado en otro formato (${format}), no HTML: no se edita en el lugar.`);
    const text = get(t.form.field);
    if (text === undefined) throw new CampusError("UNEXPECTED_RESPONSE", `El formulario no trae el ${t.label}.`);
    return stableHtml(text);
}

/** Campos del POST que guardan `html` en ese texto (formato HTML, sin notificaciones). */
export function submitFields(t: ResolvedTarget, html: string): Record<string, string> {
    return { [t.form.field]: html, [t.form.format]: "1", ...t.submit.extra };
}
