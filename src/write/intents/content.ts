import { z } from "zod";
import { CampusError } from "../../errors.js";
import { GroupsSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import type { FormSubmission } from "../web.js";
import { describeLocalFiles, type PlanFile } from "../files.js";
import { h5pPackageOf } from "./h5p-package.js";
import { fieldOf, readModForm } from "./modform.js";

/**
 * W6 · Crear contenido por `/course/modedit.php` (directiva §8.9; ADR-064 y ADR-077):
 * - ADR-064: página, enlace (URL), etiqueta (área de texto), archivo (recurso) y foro;
 * - ADR-077: carpeta (con archivos), libro, wiki, glosario, consulta (con opciones), base de datos,
 *   lección, encuesta, elección de grupo, actividad H5P (paquete .h5p) y subsección. Se crean VACÍOS
 *   salvo lo indicado: los capítulos, entradas y páginas se agregan con sus propias herramientas.
 * Mismas reglas que las demás altas:
 * - oculto al crear salvo pedido explícito; `coursecontentnotification` siempre en 0;
 * - la sección tiene que existir (un GET con una sección inexistente la CREA);
 * - el resto de la configuración queda con los valores por defecto del formulario.
 * Los archivos salen de rutas locales que indicó el humano (como los adjuntos, ADR-057): se suben al
 * borrador al ejecutar y entran en el filepicker del formulario. En el remoto no hay archivos.
 * Verificación por relectura: estructura del curso y lo propio de cada tipo. Deshacer: `cm_delete` (papelera).
 */

type Kind = "page" | "url" | "label" | "resource" | "forum" | "folder" | "book" | "wiki" | "glossary" | "choice" | "data" | "lesson" | "questionnaire" | "choicegroup" | "h5pactivity" | "subsection";
const KINDS = ["page", "url", "label", "resource", "forum", "folder", "book", "wiki", "glossary", "choice", "data", "lesson", "questionnaire", "choicegroup", "h5pactivity", "subsection"] as const;
const LABELS: Record<Kind, string> = {
    page: "la página",
    url: "el enlace",
    label: "la etiqueta",
    resource: "el archivo",
    forum: "el foro",
    folder: "la carpeta",
    book: "el libro",
    wiki: "la wiki",
    glossary: "el glosario",
    choice: "la consulta",
    data: "la base de datos",
    lesson: "la lección",
    questionnaire: "la encuesta",
    choicegroup: "la elección de grupo",
    h5pactivity: "la actividad H5P",
    subsection: "la subsección",
};
const ForumsSchema = z.array(z.object({ id: z.number().int(), cmid: z.number().nullable().optional(), course: z.number().int(), forcesubscribe: z.number().nullable().optional(), grade_forum: z.number().nullable().optional() }));
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FOLDER_FILES = 10;
/** El formulario de alta de una consulta sirve 5 opciones; con option_repeats se admiten más. */
const CHOICE_SERVED_SLOTS = 5;

const ContentsSchema = z.array(
    z.object({
        section: z.number().nullable().optional(),
        modules: z
            .array(
                z.object({
                    id: z.number().int().positive(),
                    modname: z.string(),
                    name: z.string().nullable().optional(),
                    visible: z.number().nullable().optional(),
                    description: z.string().nullable().optional(),
                    instance: z.number().nullable().optional(),
                    contents: z.array(z.object({ type: z.string().nullable().optional(), filename: z.string().nullable().optional(), filepath: z.string().nullable().optional(), filesize: z.number().nullable().optional() })).nullable().optional(),
                }),
            )
            .default([]),
    }),
);
const PagesSchema = z.object({ pages: z.array(z.object({ coursemodule: z.number().int(), content: z.string().nullable().optional() })).default([]) });
const UrlsSchema = z.object({ urls: z.array(z.object({ coursemodule: z.number().int(), externalurl: z.string().nullable().optional() })).default([]) });
const ResourcesSchema = z.object({
    resources: z.array(z.object({ coursemodule: z.number().int(), contentfiles: z.array(z.object({ filename: z.string().nullable().optional(), filesize: z.number().nullable().optional() })).default([]) })).default([]),
});
const ChoiceOptionsSchema = z.object({ options: z.array(z.object({ id: z.number().int(), text: z.string().nullable().optional() })).default([]) });
const WikisSchema = z.object({ wikis: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), firstpagetitle: z.string().nullable().optional(), wikimode: z.string().nullable().optional() })).default([]) });

async function contents(ctx: IntentContext, courseId: number) {
    return ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema);
}
const allModules = (c: z.infer<typeof ContentsSchema>) => c.flatMap((s) => s.modules.map((m) => ({ ...m, section: s.section ?? null })));
/** Archivos de una carpeta tal como los lista la estructura del curso («nombre:bytes», ordenados). */
export const folderFiles = (m: { contents?: { type?: string | null; filename?: string | null; filepath?: string | null; filesize?: number | null }[] | null }) =>
    (m.contents ?? [])
        .filter((f) => (f.type ?? "file") === "file")
        .map((f) => `${f.filepath && f.filepath !== "/" ? f.filepath : ""}${f.filename ?? "?"}:${f.filesize ?? "?"}`)
        .sort();

// ---------- versiones, interpretación y verificación ----------

/** `cm:<curso>:<cmid>` (existe). */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, id] = k.split(":");
        out[k] = kind === "cm" ? (allModules(await contents(ctx, Number(course))).some((m) => m.id === Number(id)) ? 1 : null) : null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    const cmid = /\/mod\/[a-z0-9]+\/view\.php\?(?:.*&)?id=(\d+)/.exec((data as FormSubmission | null)?.location ?? "")?.[1];
    return cmid ? { ok: true, moodle_ids: { cmid: Number(cmid) } } : { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const x = item.expected;
    const mods = allModules(await contents(ctx, plan.course_id));
    if (item.call.kind === "ajax") {
        const still = mods.some((m) => m.id === Number(item.target.cmid));
        return still ? { outcome: "sin_efecto", checked: ["actividad"], differences: [{ field: "actividad", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["actividad"], differences: [] };
    }
    const kind = x.kind as Kind;
    const prior = new Set(x.prior_cmids as number[]);
    const m = known.cmid ? mods.find((y) => y.id === known.cmid) : mods.find((y) => y.modname === kind && y.name === x.name && !prior.has(y.id));
    if (!m) return { outcome: "sin_efecto", checked: ["actividad"], differences: [{ field: "actividad", expected: "creada", observed: "no aparece" }] };
    const differences: Difference[] = [];
    const check = (field: string, expected: unknown, observed: unknown) => {
        if (JSON.stringify(expected) !== JSON.stringify(observed)) differences.push({ field, expected, observed });
    };
    check("name", x.name, m.name ?? null);
    check("section", x.section, m.section);
    check("visible", x.visible, m.visible === 1);
    const checked = ["name", "section", "visible"];
    const t = ctx.read.session.transport;
    if (kind === "page") {
        const p = (await t.call("mod_page_get_pages_by_courses", { courseids: [plan.course_id] }, PagesSchema)).pages.find((y) => y.coursemodule === m.id);
        check("content", x.content_text, comparable(p?.content));
        checked.push("content");
    } else if (kind === "url") {
        const u = (await t.call("mod_url_get_urls_by_courses", { courseids: [plan.course_id] }, UrlsSchema)).urls.find((y) => y.coursemodule === m.id);
        check("externalurl", x.url, u?.externalurl ?? null);
        checked.push("externalurl");
    } else if (kind === "label") {
        check("text", x.text, comparable(m.description));
        checked.push("text");
    } else if (kind === "forum") {
        const f = (await t.call("mod_forum_get_forums_by_courses", { courseids: [plan.course_id] }, ForumsSchema)).find((y) => y.cmid === m.id);
        check("forcesubscribe", x.forcesubscribe, f?.forcesubscribe ?? null);
        checked.push("forcesubscribe");
        if (f && f.grade_forum !== undefined && f.grade_forum !== null) {
            check("grade_forum", x.grade_forum, f.grade_forum);
            checked.push("grade_forum");
        }
    } else if (kind === "resource") {
        const r = (await t.call("mod_resource_get_resources_by_courses", { courseids: [plan.course_id] }, ResourcesSchema)).resources.find((y) => y.coursemodule === m.id);
        const f = r?.contentfiles.map((c) => `${c.filename ?? "?"}:${c.filesize ?? "?"}`).join(",") ?? "sin archivo";
        check("file", x.file, f);
        checked.push("file");
    } else if (kind === "folder") {
        check("files", x.files, folderFiles(m));
        checked.push("files");
    } else if (kind === "choice") {
        const o = ChoiceOptionsSchema.parse(await ctx.transport.call("mod_choice_get_choice_options", { choiceid: m.instance ?? 0 }));
        check("options", x.options, o.options.map((y) => y.text ?? ""));
        checked.push("options");
    } else if (kind === "wiki") {
        const w = WikisSchema.parse(await ctx.transport.call("mod_wiki_get_wikis_by_courses", { courseids: [plan.course_id] })).wikis.find((y) => y.coursemodule === m.id);
        check("firstpagetitle", x.first_page_title, w?.firstpagetitle ?? null);
        check("wikimode", x.wiki_mode, w?.wikimode ?? null);
        checked.push("firstpagetitle", "wikimode");
    } else if (kind === "h5pactivity" && x.package !== undefined) {
        // ADR-110: paquete generado por el servidor; se compara nombre y tamaño.
        check("package", x.package, await h5pPackageOf(ctx, plan.course_id, m.id));
        checked.push("package");
    } else if (kind === "choicegroup") {
        const f = await readModForm(ctx, m.id, "choicegroup");
        const groups = (fieldOf(f, "serializedselectedgroups") ?? "").split(";").filter(Boolean).map(Number).sort((a, b) => a - b);
        check("groups", x.group_ids, groups);
        checked.push("groups");
    }
    return { outcome: differences.length ? "difiere" : "coincide", checked, differences, moodle_ids: { cmid: m.id } };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

// ---------- crear ----------

const shape = {
    course_id: z.number().int().positive(),
    type: z
        .enum(KINDS)
        .describe(
            "page = página; url = enlace externo; label = etiqueta (área de texto); resource = archivo; forum = foro general; folder = carpeta (file_paths); book = libro; wiki (first_page_title); glossary = glosario; choice = consulta (options); data = base de datos; lesson = lección; questionnaire = encuesta; choicegroup = elección de grupo (group_ids); h5pactivity = actividad H5P (file_path .h5p); subsection = subsección.",
        ),
    section: z.number().int().min(0).max(200).describe("Número de sección EXISTENTE."),
    name: z.string().min(1).max(255).optional().describe("Nombre (obligatorio salvo en etiquetas, donde por defecto es el comienzo del texto)."),
    intro: z.string().max(10_000).optional().describe("Descripción (Markdown); no aplica a etiquetas ni subsecciones."),
    content: z.string().min(1).max(200_000).optional().describe("page: contenido de la página (Markdown)."),
    external_url: z.string().min(1).max(1900).optional().describe("Para type=url: dirección http(s) del enlace."),
    text: z.string().min(1).max(50_000).optional().describe("label: texto de la etiqueta (Markdown)."),
    file_path: z.string().min(1).max(1000).optional().describe("resource: archivo; h5pactivity: paquete .h5p. Ruta ABSOLUTA del archivo local que indicó el humano (sólo servidor local)."),
    file_paths: z.array(z.string().min(1).max(1000)).min(1).max(MAX_FOLDER_FILES).optional().describe("folder: rutas ABSOLUTAS de los archivos locales (hasta 10; sólo servidor local)."),
    options: z.array(z.string().min(1).max(255)).min(1).max(30).optional().describe("choice: opciones de la consulta, en orden (sin repetir)."),
    first_page_title: z.string().min(1).max(255).optional().describe("wiki: título de la primera página."),
    wiki_mode: z.enum(["collaborative", "individual"]).optional().describe("wiki: colaborativa (por defecto) o individual."),
    group_ids: z.array(z.number().int().positive()).min(1).max(50).optional().describe("choicegroup: grupos del curso entre los que se elige."),
    visible: z.boolean().optional().describe("Por defecto false: se crea oculto."),
    subscription: z.enum(["disabled", "optional"]).optional().describe("forum: suscripción deshabilitada (por defecto: nadie recibe correo) u opcional. Nunca forzada ni automática."),
    whole_forum_grade: z.number().int().min(1).max(100).optional().describe("forum: calificación del foro completo, en puntos (ausente = sin calificación)."),
};

/** Qué parámetro propio exige (o admite) cada tipo. */
const OWN: Record<Kind, readonly (keyof typeof shape)[]> = {
    page: ["content"],
    url: ["external_url"],
    label: ["text"],
    resource: ["file_path"],
    forum: ["subscription", "whole_forum_grade"],
    folder: ["file_paths"],
    book: [],
    wiki: ["first_page_title", "wiki_mode"],
    glossary: [],
    choice: ["options"],
    data: [],
    lesson: [],
    questionnaire: [],
    choicegroup: ["group_ids"],
    h5pactivity: ["file_path"],
    subsection: [],
};
const REQUIRED: Partial<Record<Kind, keyof typeof shape>> = { page: "content", url: "external_url", label: "text", resource: "file_path", folder: "file_paths", wiki: "first_page_title", choice: "options", choicegroup: "group_ids", h5pactivity: "file_path" };
const SPECIFIC = ["content", "external_url", "text", "file_path", "file_paths", "options", "first_page_title", "wiki_mode", "group_ids", "subscription", "whole_forum_grade"] as const;

export const createContentIntent: WriteIntent<typeof shape> = {
    name: "create_content",
    title: "Plan: crear contenido o una actividad (página, enlace, etiqueta, archivo, carpeta, libro, wiki, glosario, consulta…)",
    description:
        "Arma el plan para crear en una sección existente: página (content), enlace (external_url), etiqueta (text), archivo (file_path local), foro, carpeta (file_paths locales), libro, wiki (first_page_title), glosario, consulta (options), base de datos, lección, encuesta, elección de grupo (group_ids), actividad H5P (file_path .h5p local) o subsección. Libros, glosarios, wikis, bases de datos, lecciones y encuestas se crean vacíos. Por defecto oculto y sin notificar. No escribe.",
    inputShape: shape,
    capability: "create_content",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const kind = input.type as Kind;
        // ADR-110: campus_plan_h5p_content pasa el paquete ya generado (no es un parámetro de esta herramienta).
        const generated = (input as { generated_file?: PlanFile }).generated_file;
        const needed = REQUIRED[kind];
        if (needed && input[needed] === undefined && !(kind === "h5pactivity" && generated)) throw new CampusError("WRITE_NOT_ALLOWED", `Para type=${kind} hace falta ${needed}.`);
        const extra: string[] = SPECIFIC.filter((k) => !OWN[kind].includes(k) && input[k] !== undefined);
        if (extra.length) throw new CampusError("WRITE_NOT_ALLOWED", `Para type=${kind} no corresponde: ${extra.join(", ")}.`);
        const c = await contents(ctx, input.course_id);
        if (!c.some((s) => s.section === input.section)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.section} no existe (abrir el formulario la crearía).`);
        const priorCmids = allModules(c).map((m) => m.id);
        const visible = input.visible ?? false;
        if ((kind === "label" || kind === "subsection") && input.intro) throw new CampusError("WRITE_NOT_ALLOWED", kind === "label" ? "Una etiqueta no tiene descripción: usá text." : "Una subsección no tiene descripción (su resumen se cambia con campus_plan_section_summary).");
        const intro = kind !== "label" && input.intro ? toHtml(input.intro, "markdown") : "";

        const fields: Record<string, string> = { visible: visible ? "1" : "0", coursecontentnotification: "0" };
        const expected: Record<string, unknown> = { kind, section: input.section, visible, prior_cmids: priorCmids };
        const preview: Record<string, unknown> = { type: kind, section: input.section, visible, notifications: "ninguna (coursecontentnotification=0)" };
        let uploads: PlanItem["uploads"];
        let name = input.name?.trim() ?? "";
        if (kind !== "label" && !name) throw new CampusError("WRITE_NOT_ALLOWED", "Falta name.");
        if (kind !== "label" && kind !== "subsection") Object.assign(fields, { "introeditor[text]": intro, "introeditor[format]": "1" });
        const maxBytes = Math.min(MAX_FILE_BYTES, ctx.profile.read_profile.limits.max_file_bytes);
        const warnings: string[] = [];

        if (kind === "page") {
            const html = toHtml(input.content!, "markdown");
            Object.assign(fields, { "page[text]": html, "page[format]": "1" });
            expected.content_text = comparable(html);
            preview.content_html = html;
        } else if (kind === "url") {
            let u: URL;
            try {
                u = new URL(input.external_url!.trim());
            } catch {
                throw new CampusError("WRITE_NOT_ALLOWED", "La URL no es válida.");
            }
            if (u.protocol !== "https:" && u.protocol !== "http:") throw new CampusError("WRITE_NOT_ALLOWED", "Sólo URLs http o https.");
            if (u.username || u.password) throw new CampusError("WRITE_NOT_ALLOWED", "La URL no puede llevar usuario ni contraseña.");
            fields.externalurl = u.href;
            expected.url = u.href;
            preview.url = u.href;
        } else if (kind === "label") {
            const html = toHtml(input.text!, "markdown");
            const text = comparable(html);
            if (!text) throw new CampusError("WRITE_NOT_ALLOWED", "El texto queda vacío después de convertirlo.");
            // Nombre por defecto: texto plano (sin marcas de Markdown ni etiquetas), como lo muestra Moodle.
            name ||= html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim().slice(0, 50);
            Object.assign(fields, { "introeditor[text]": html, "introeditor[format]": "1" });
            expected.text = text;
            preview.text_html = html;
        } else if (kind === "forum") {
            const subscribe = input.subscription === "optional" ? 0 : 3;
            const grade = input.whole_forum_grade;
            Object.assign(fields, { type: "general", forcesubscribe: String(subscribe), "grade_forum[modgrade_type]": grade ? "point" : "none", ...(grade ? { "grade_forum[modgrade_point]": String(grade) } : {}), grade_forum_notify: "0" });
            expected.forcesubscribe = subscribe;
            expected.grade_forum = grade ?? 0;
            Object.assign(preview, { forum_type: "general", subscription: subscribe === 3 ? "deshabilitada (nadie recibe correo)" : "opcional", whole_forum_grade: grade ?? "sin calificación", grade_notifications: "no" });
        } else if (kind === "resource" || kind === "h5pactivity") {
            const [file] = generated && kind === "h5pactivity" ? [generated] : describeLocalFiles([input.file_path!], maxBytes, 1);
            if (kind === "h5pactivity" && !/\.h5p$/i.test(file!.filename)) throw new CampusError("WRITE_NOT_ALLOWED", "Una actividad H5P necesita un paquete .h5p.");
            uploads = { field: kind === "resource" ? "files" : "packagefile", files: [file!] };
            if (kind === "resource") expected.file = `${file!.filename}:${file!.size}`;
            preview.file = { filename: file!.filename, bytes: file!.size, sha256: file!.sha256, path: file!.path };
        } else if (kind === "folder") {
            const files = describeLocalFiles(input.file_paths!, maxBytes, MAX_FOLDER_FILES);
            const names = files.map((f) => f.filename);
            if (new Set(names).size !== names.length) throw new CampusError("WRITE_NOT_ALLOWED", "Hay dos archivos con el mismo nombre.");
            uploads = { field: "files", files };
            expected.files = files.map((f) => `${f.filename}:${f.size}`).sort();
            preview.files = files.map((f) => ({ filename: f.filename, bytes: f.size, sha256: f.sha256, path: f.path }));
        } else if (kind === "wiki") {
            const mode = input.wiki_mode ?? "collaborative";
            const title = input.first_page_title!.trim();
            if (!title) throw new CampusError("WRITE_NOT_ALLOWED", "first_page_title no puede quedar vacío.");
            Object.assign(fields, { wikimode: mode, firstpagetitle: title });
            Object.assign(expected, { first_page_title: title, wiki_mode: mode });
            Object.assign(preview, { wiki_mode: mode === "collaborative" ? "colaborativa" : "individual", first_page_title: title });
        } else if (kind === "glossary") {
            fields.mainglossary = "0";
            preview.glossary_type = "secundario";
        } else if (kind === "choice") {
            const options = input.options!.map((o) => o.trim());
            if (options.some((o) => !o)) throw new CampusError("WRITE_NOT_ALLOWED", "Hay una opción vacía.");
            if (new Set(options).size !== options.length) throw new CampusError("WRITE_NOT_ALLOWED", "Hay opciones repetidas.");
            fields.option_repeats = String(Math.max(CHOICE_SERVED_SLOTS, options.length));
            options.forEach((o, i) => {
                fields[`option[${i}]`] = o;
                if (i >= CHOICE_SERVED_SLOTS) Object.assign(fields, { [`limit[${i}]`]: "0", [`optionid[${i}]`]: "0" });
            });
            expected.options = options;
            preview.options = options;
        } else if (kind === "questionnaire") {
            fields.create = "new-0";
            warnings.push("La encuesta se crea sin preguntas: se agregan con campus_plan_questionnaire_question.");
        } else if (kind === "choicegroup") {
            const ids = [...new Set(input.group_ids!)].sort((a, b) => a - b);
            const groups = await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: input.course_id }, GroupsSchema);
            const missing = ids.filter((id) => !groups.some((g) => g.id === id && g.courseid === input.course_id));
            if (missing.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Grupos que no son del curso: ${missing.join(", ")}.`);
            fields.serializedselectedgroups = ids.map((id) => `;${id}`).join("");
            expected.group_ids = ids;
            preview.groups = ids.map((id) => ({ id, name: groups.find((g) => g.id === id)?.name ?? null }));
        }
        if (["book", "data", "lesson"].includes(kind)) warnings.push(`${LABELS[kind][0]!.toUpperCase()}${LABELS[kind].slice(1)} se crea vacío: su contenido se agrega aparte.`);
        fields.name = name;
        expected.name = name;
        preview.name = name;
        if (intro) preview.intro_html = intro;

        const draft: PlanDraft = {
            intent: "create_content",
            capability: "create_content",
            course_id: input.course_id,
            base_risk: visible ? "R2" : "R1",
            summary: `Crear ${LABELS[kind]} «${name}» ${visible ? "VISIBLE" : LABELS[kind].startsWith("la ") ? "oculta" : "oculto"} en la sección ${input.section}.`,
            payload_preview: preview,
            side_effects: [
                visible ? "Visible para los participantes en cuanto se crea." : "Oculto: los estudiantes no lo ven hasta que se muestre.",
                "Sin notificaciones.",
                ...(kind === "subsection" ? ["Crea además una sección delegada (la subsección) dentro de la sección indicada."] : []),
                ...(uploads ? ["Sube los archivos a tu borrador privado del Campus justo antes de crear la actividad."] : []),
            ],
            preconditions: { description: "La sección sigue existiendo.", versions: {} },
            undo: { kind: "compensación", how: "Borrar la actividad (va a la papelera; restaurarla crea otro cmid).", until: null },
            warnings: ["Creación por formulario web: requiere la sesión web del Campus.", ...warnings],
            items: [
                {
                    item_id: "i1",
                    description: `Nuevo ${kind} «${name}» en la sección ${input.section}`,
                    call: { kind: "form", fn: `course_modedit_${kind}_add`, params: { query: { add: kind, course: String(input.course_id), section: String(input.section) }, fields } },
                    target: { course_id: input.course_id, section: input.section },
                    expected,
                    ...(uploads ? { uploads } : {}),
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.groups"],
            teacher_text: Object.fromEntries(Object.entries({ name, intro: input.intro, content: input.content, text: input.text }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
            undo_of: null,
        };
        return draft;
    },
    async undo(plan, result) {
        const r = result.items.find((i) => i.outcome === "verificado" || i.outcome === "con_diferencias" || i.outcome === "desconocido");
        const cmid = r?.moodle_ids.cmid;
        if (!r || !cmid) return { kind: "ninguno", reason: "No se conoce la actividad creada." };
        const name = String(plan.items[0]!.expected.name);
        return {
            kind: "plan",
            draft: {
                intent: "create_content",
                capability: "create_content",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar «${name}» (cmid ${cmid}).`,
                payload_preview: { delete_activity: { cmid, name } },
                side_effects: ["Va a la papelera del curso (7 días)."],
                preconditions: { description: "La actividad sigue en el curso.", versions: { [`cm:${plan.course_id}:${cmid}`]: 1 } },
                undo: { kind: "ninguno", how: "Sólo restaurando desde la papelera, a mano (crea otro cmid).", until: null },
                warnings: [],
                items: [
                    {
                        item_id: "i1",
                        description: `Borrar la actividad ${cmid}`,
                        call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "cm_delete", courseid: plan.course_id, ids: [cmid] } },
                        target: { course_id: plan.course_id, cmid },
                        expected: { deleted: true },
                    },
                ],
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};
