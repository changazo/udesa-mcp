import { z } from "zod";
import { CampusError } from "../errors.js";
import type { Profile } from "../config/profile.js";
import type { AllowedFunction } from "../moodle/functions.js";
import type { ParamValue } from "../moodle/serialize.js";
import { sourceDate } from "../util/time.js";
import { sliceText, sourceToText } from "./html.js";
import { parseQuestionnaireQuestions } from "./questionnaire.js";
import { H5pContentSpec } from "../h5p/content-types.js";
import { readZipDirectory, readZipEntry } from "../documents/zip.js";

/**
 * Lectura del contenido INTERNO de las actividades (ADR-079), por tipo y con funciones de lectura del
 * servicio móvil (ninguna `*_view_*`):
 * - libro: capítulos con su contenido (archivo `index.html` de cada capítulo);
 * - glosario: entradas y categorías;
 * - wiki: páginas de cada subwiki con su contenido;
 * - base de datos: campos y entradas;
 * - consulta: configuración, opciones y quién eligió cada una;
 * - lección: páginas (sin la contraseña de la lección);
 * - actividad H5P: paquete e intentos por participante;
 * - carpeta: configuración y archivos (con file_ref).
 * Los demás tipos tienen su propia herramienta o no tienen lectura por el servicio: se dice cuál.
 */

const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
const str = opt(z.string());
const num = opt(z.number());
const bool = opt(z.union([z.boolean(), z.number()]));

const ModulesSchema = z.array(
    z.object({
        section: num,
        modules: z
            .array(
                z.object({
                    id: z.number().int(),
                    modname: z.string(),
                    name: str,
                    instance: num,
                    description: str,
                    contents: opt(z.array(z.object({ type: str, filename: str, filepath: str, filesize: num, fileurl: str, content: str, mimetype: str, timemodified: num }).passthrough())),
                }),
            )
            .default([]),
    }),
);
const BooksSchema = z.object({ books: z.array(z.object({ id: z.number(), coursemodule: z.number(), course: z.number(), name: str, intro: str, introformat: num, numbering: num, customtitles: num, navstyle: num })).default([]) });
const StructureSchema = z.array(z.object({ title: z.string(), href: z.string(), level: z.number(), hidden: z.union([z.string(), z.number()]).optional(), subitems: z.array(z.object({ title: z.string(), href: z.string(), level: z.number(), hidden: z.union([z.string(), z.number()]).optional() })).default([]) }));
const GlossariesSchema = z.object({ glossaries: z.array(z.object({ id: z.number(), coursemodule: z.number(), course: z.number(), name: str, intro: str, introformat: num, displayformat: str, allowduplicatedentries: num, allowcomments: num, defaultapproval: num, mainglossary: num })).default([]) });
const GlossaryEntriesSchema = z.object({ count: num, entries: z.array(z.object({ id: z.number(), concept: z.string(), definition: str, definitionformat: num, userid: num, userfullname: str, approved: bool, timecreated: num, timemodified: num, aliases: opt(z.array(z.object({ alias: str }).passthrough())), attachments: opt(z.array(z.object({ filename: str }).passthrough())) }).passthrough()).default([]) });
const LessonAttemptsSchema = z.object({
    data: opt(
        z.object({
            numofattempts: num,
            avescore: num,
            highscore: num,
            lowscore: num,
            avetime: num,
            students: opt(z.array(z.object({ id: z.number(), fullname: str, bestgrade: num, attempts: z.array(z.object({ try: num, grade: num, timestart: num, timeend: num, end: num }).passthrough()).default([]) }).passthrough())),
        }).passthrough(),
    ),
});
const GlossaryCategoriesSchema = z.object({ count: num, categories: z.array(z.object({ id: z.number(), name: str, usedynalink: num })).default([]) });
const WikisSchema = z.object({ wikis: z.array(z.object({ id: z.number(), coursemodule: z.number(), course: z.number(), name: str, intro: str, introformat: num, wikimode: str, firstpagetitle: str, defaultformat: str, forceformat: num })).default([]) });
const SubwikisSchema = z.object({ subwikis: z.array(z.object({ id: z.number(), groupid: z.union([z.string(), z.number()]), userid: z.number(), canedit: bool })).default([]) });
const SubwikiPagesSchema = z.object({ pages: z.array(z.object({ id: z.number(), title: z.string(), cachedcontent: str, contentformat: num, timecreated: num, timemodified: num, firstpage: bool, pageviews: num })).default([]) });
const DatabasesSchema = z.object({ databases: z.array(z.object({ id: z.number(), coursemodule: z.number(), course: z.number(), name: str, intro: str, introformat: num, approval: bool, comments: bool, maxentries: num, requiredentries: num, timeavailablefrom: num, timeavailableto: num })).default([]) });
const DataFieldsSchema = z.object({ fields: z.array(z.object({ id: z.number(), name: z.string(), type: z.string(), description: str, required: bool, param1: str })).default([]) });
const DataEntriesSchema = z.object({
    entries: z.array(z.object({ id: z.number(), userid: num, fullname: str, groupid: num, timecreated: num, timemodified: num, approved: bool, contents: opt(z.array(z.object({ fieldid: z.number(), content: str, content1: str, files: opt(z.array(z.object({ filename: str }).passthrough())) }).passthrough())) })).default([]),
    totalcount: num,
});
const ChoicesSchema = z.object({ choices: z.array(z.object({ id: z.number(), coursemodule: z.number(), course: z.number(), name: str, intro: str, introformat: num, publish: bool, showresults: num, display: num, allowupdate: bool, allowmultiple: bool, showunanswered: bool, limitanswers: bool, timeopen: num, timeclose: num, showpreview: bool })).default([]) });
const ChoiceResultsSchema = z.object({ options: z.array(z.object({ id: z.number(), text: str, maxanswer: num, numberofuser: num, percentageamount: num, userresponses: opt(z.array(z.object({ userid: num, fullname: str, timemodified: num }).passthrough())) })).default([]) });
const LessonsSchema = z.object({ lessons: z.array(z.object({ id: z.number(), coursemodule: z.number(), course: z.number(), name: str, intro: str, introformat: num, practice: bool, retake: bool, maxattempts: num, timelimit: num, available: num, deadline: num, grade: num, usepassword: bool, custom: bool, review: bool, modattempts: bool })).default([]) });
const LessonPagesSchema = z.object({ pages: z.array(z.object({ page: z.object({ id: z.number(), prevpageid: num, nextpageid: num, title: str, contents: str, contentsformat: num, typestring: str, qtype: num }), answerids: opt(z.array(z.number())), jumps: opt(z.array(z.number())) })).default([]) });
const H5PActivitiesSchema = z.object({ h5pactivities: z.array(z.object({ id: z.number(), coursemodule: z.number(), course: z.number(), name: str, intro: str, introformat: num, grade: num, grademethod: num, enabletracking: num, package: opt(z.array(z.object({ filename: str, filesize: num, fileurl: str }).passthrough())) })).default([]) });
const H5PAttemptsSchema = z.object({ usersattempts: z.array(z.object({ userid: z.number(), attempts: z.array(z.object({ attempt: num, rawscore: num, maxscore: num, duration: num, completion: num, success: num, scaled: num, timemodified: num }).passthrough()).default([]) })).default([]), totalattempts: num });
const AnswerSchema = z.object({ answer: str, correct: opt(z.boolean()), incorrect: opt(z.boolean()), text: opt(z.boolean()), checked: opt(z.boolean()), unchecked: opt(z.boolean()), pass: opt(z.boolean()), fail: opt(z.boolean()) }).passthrough();
const H5PResultsSchema = z.object({
    attempts: z
        .array(
            z.object({
                id: z.number(),
                userid: num,
                attempt: num,
                rawscore: num,
                maxscore: num,
                results: z
                    .array(
                        z.object({
                            id: num,
                            subcontent: str,
                            interactiontype: str,
                            description: str,
                            rawscore: num,
                            maxscore: num,
                            duration: num,
                            completion: num,
                            success: num,
                            optionslabel: str,
                            correctlabel: str,
                            answerlabel: str,
                            track: opt(z.boolean()),
                            options: opt(z.array(z.object({ description: str, id: num, correctanswer: opt(AnswerSchema), useranswer: opt(AnswerSchema) }).passthrough())),
                        }).passthrough(),
                    )
                    .default([]),
            }).passthrough(),
        )
        .default([]),
});
const FoldersSchema = z.object({ folders: z.array(z.object({ id: z.number(), coursemodule: z.number(), course: z.number(), name: str, intro: str, introformat: num, display: num, showexpanded: num, showdownloadfolder: num, forcedownload: num })).default([]) });

/** Lo que el servicio le presta a este lector (helpers privados del CampusService). */
export interface ActivityContentDeps {
    profile: Profile;
    /**
     * Rol docente o superior de la cuenta en el curso (ADR-122). Sin él no se piden los datos de terceros
     * que sólo ve el docente (entradas por aprobar, intentos de lecciones, preguntas de encuestas) y de
     * H5P se exponen sólo los intentos propios (ADR-123).
     */
    teacher: boolean;
    /** userid de la cuenta verificada. */
    selfId: number;
    call<S extends z.ZodTypeAny>(fn: AllowedFunction, params: Record<string, ParamValue>, schema: S): Promise<z.infer<S>>;
    download(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string | null }>;
    /** file_ref de un archivo del contenido de un módulo (el mismo localizador que campus_get_course). */
    moduleFileRef(cmid: number, name: string, url: string, mime: string | null, bytes: number | null, filepath: string | null): { ref: string; name: string; mime_type: string | null; bytes: number | null; source_url: string | null } | null;
    /** Página web de sólo lectura (ruta de WEB_ROUTES); sin sesión web, AUTH_REQUIRED (ADR-097). */
    webPage?(route: "questionnaire_questions", params: Record<string, string>): Promise<string>;
}

export interface ActivityContentInput {
    course_id: number;
    course_module_id: number;
    cursor?: string;
    /** Actividad H5P: intento cuyas respuestas por pregunta se leen (ADR-090). */
    attempt_id?: number;
}

/** Otras herramientas para los tipos que no se leen acá. */
const ELSEWHERE: Record<string, string> = {
    forum: "campus_list_announcements y campus_get_discussion",
    assign: "campus_list_assignments, campus_get_submission y campus_get_activity_settings",
    quiz: "campus_get_quiz_structure, campus_get_quiz_attempts y campus_get_activity_settings",
    page: "campus_get_page",
    resource: "campus_list_resources y campus_read_file",
    url: "campus_list_resources",
    attendance: "campus_get_attendance y campus_list_attendance_sessions",
    choicegroup: "campus_list_groups",
};
const NO_SERVICE = new Set(["hvp", "lti", "subjectattendance", "turnitintooltwo", "subsection"]);
const PAGE = 50;

const idOfHref = (href: string) => Number(/^(\d+)\//.exec(href)?.[1] ?? NaN);
const truthy = (v: boolean | number | null | undefined) => v === true || v === 1;

export async function readActivityContent(d: ActivityContentDeps, input: ActivityContentInput, at: Date) {
    const courseId = input.course_id;
    const tz = d.profile.timezone;
    const contents = await d.call("core_course_get_contents", { courseid: courseId }, ModulesSchema);
    const m = contents.flatMap((s) => s.modules).find((x) => x.id === input.course_module_id);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${input.course_module_id} no es del curso ${courseId}.`);
    if (ELSEWHERE[m.modname]) throw new CampusError("UNSUPPORTED_CONTENT", `Para ${m.modname} usá ${ELSEWHERE[m.modname]}.`);
    if (input.attempt_id !== undefined && m.modname !== "h5pactivity") throw new CampusError("UNSUPPORTED_CONTENT", "attempt_id sólo aplica a actividades H5P (h5pactivity).");
    if (NO_SERVICE.has(m.modname)) throw new CampusError("UNSUPPORTED_CONTENT", `El servicio móvil no ofrece una lectura del contenido de ${m.modname}. Su descripción y fechas están en campus_get_course.`);
    const offset = Math.max(0, Number(input.cursor ?? 0) || 0);
    const budget = d.profile.limits.max_text_chars_per_result;
    const wsfns = ["core_course_get_contents"];
    const warnings: string[] = [];
    const base = { course_id: courseId, course_module_id: m.id, type: m.modname, name: m.name ?? null };
    let data: Record<string, unknown>;
    let next: number | null = null;
    let total: number | null = null;
    const instanceOf = <T extends { coursemodule: number; course: number; intro?: string | null; introformat?: number | null }>(rows: T[], what: string) => {
        const r = rows.find((x) => x.coursemodule === m.id && x.course === courseId);
        if (!r) throw new CampusError("UNEXPECTED_RESPONSE", `${what} no aparece en la lista del curso.`);
        // Descripción (consigna) de la actividad: el servicio la trae aunque no se muestre en la página del curso.
        const d = sliceText(sourceToText(r.intro, r.introformat ?? 1), 0, 8000);
        description = { description_markdown: d.text, description_truncated: d.truncated };
        return r;
    };
    let description: { description_markdown: string; description_truncated: boolean } = { description_markdown: "", description_truncated: false };

    switch (m.modname) {
        case "book": {
            const b = instanceOf((await d.call("mod_book_get_books_by_courses", { courseids: [courseId] }, BooksSchema)).books, "El libro");
            wsfns.push("mod_book_get_books_by_courses");
            const raw = m.contents?.find((c) => c.filename === "structure")?.content;
            const structure = raw ? StructureSchema.parse(JSON.parse(raw)) : [];
            const flat = structure.flatMap((c) => [{ ...c, sub: c.level > 0 }, ...c.subitems.map((s) => ({ ...s, sub: true }))]);
            total = flat.length;
            const chapters: Record<string, unknown>[] = [];
            let used = 0;
            for (let i = offset; i < flat.length; i++) {
                const c = flat[i]!;
                const id = idOfHref(c.href);
                const file = m.contents?.find((f) => f.filepath === `/${id}/` && f.filename === "index.html");
                let text = "";
                if (file?.fileurl) {
                    const { bytes } = await d.download(file.fileurl, d.profile.limits.max_file_bytes);
                    text = sourceToText(new TextDecoder().decode(bytes), 1);
                }
                if (chapters.length && used + text.length > budget) {
                    next = i;
                    break;
                }
                const slice = sliceText(text, 0, budget);
                used += slice.text.length;
                chapters.push({ chapter_id: id, position: i + 1, title: c.title, subchapter: c.sub, hidden: String(c.hidden ?? "0") === "1", content_markdown: slice.text, content_truncated: slice.truncated });
            }
            data = { ...base, settings: { numbering: b.numbering ?? null, custom_titles: truthy(b.customtitles) }, chapters_total: flat.length, chapters };
            if (offset === 0 && !flat.length) warnings.push("El libro no tiene capítulos.");
            break;
        }
        case "glossary": {
            const g = instanceOf((await d.call("mod_glossary_get_glossaries_by_courses", { courseids: [courseId] }, GlossariesSchema)).glossaries, "El glosario");
            const [entries, cats] = await Promise.all([
                d.call("mod_glossary_get_entries_by_letter", { id: g.id, letter: "ALL", from: offset, limit: PAGE }, GlossaryEntriesSchema),
                d.call("mod_glossary_get_categories", { id: g.id }, GlossaryCategoriesSchema),
            ]);
            // Entradas pendientes de aprobación (ADR-085): sólo lectura; aprobarlas puede avisar al autor y no se ofrece.
            const pending = d.teacher ? await d.call("mod_glossary_get_entries_to_approve", { id: g.id, letter: "ALL", from: 0, limit: PAGE }, GlossaryEntriesSchema) : { count: 0, entries: [] };
            wsfns.push("mod_glossary_get_glossaries_by_courses", "mod_glossary_get_entries_by_letter", "mod_glossary_get_categories", ...(d.teacher ? ["mod_glossary_get_entries_to_approve"] : []));
            if (!d.teacher) warnings.push("Sin rol docente: las entradas pendientes de aprobación (de otros participantes) no se consultan.");
            total = entries.count ?? entries.entries.length;
            if (offset + entries.entries.length < total) next = offset + entries.entries.length;
            data = {
                ...base,
                settings: { main_glossary: truthy(g.mainglossary), allow_duplicates: truthy(g.allowduplicatedentries), allow_comments: truthy(g.allowcomments), entries_approved_by_default: truthy(g.defaultapproval), display_format: g.displayformat ?? null },
                categories: cats.categories.map((c) => ({ category_id: c.id, name: c.name ?? null })),
                pending_total: pending.count ?? pending.entries.length,
                pending: pending.entries.map((e) => ({ entry_id: e.id, concept: e.concept, definition_markdown: sliceText(sourceToText(e.definition, e.definitionformat), 0, 1500).text, author: { user_id: e.userid ?? null, name: e.userfullname ?? null }, modified: sourceDate(e.timemodified ?? null, tz) })),
                entries_total: total,
                entries: entries.entries.map((e) => ({
                    entry_id: e.id,
                    concept: e.concept,
                    definition_markdown: sourceToText(e.definition, e.definitionformat),
                    aliases: (e.aliases ?? []).map((a) => a.alias).filter(Boolean),
                    attachments: (e.attachments ?? []).map((a) => a.filename).filter(Boolean),
                    author: { user_id: e.userid ?? null, name: e.userfullname ?? null },
                    approved: e.approved === undefined || e.approved === null ? null : truthy(e.approved),
                    modified: sourceDate(e.timemodified ?? null, tz),
                })),
            };
            if ((pending.count ?? pending.entries.length) > PAGE) warnings.push(`Hay más de ${PAGE} entradas pendientes: se muestran las primeras.`);
            break;
        }
        case "wiki": {
            const w = instanceOf((await d.call("mod_wiki_get_wikis_by_courses", { courseids: [courseId] }, WikisSchema)).wikis, "La wiki");
            const subs = (await d.call("mod_wiki_get_subwikis", { wikiid: w.id }, SubwikisSchema)).subwikis;
            wsfns.push("mod_wiki_get_wikis_by_courses", "mod_wiki_get_subwikis", "mod_wiki_get_subwiki_pages");
            const pages: Record<string, unknown>[] = [];
            let index = 0;
            let used = 0;
            outer: for (const s of subs.filter((x) => x.id > 0)) {
                const list = (await d.call("mod_wiki_get_subwiki_pages", { wikiid: w.id, groupid: Number(s.groupid), userid: s.userid }, SubwikiPagesSchema)).pages;
                for (const p of list) {
                    if (index++ < offset) continue;
                    const text = sourceToText(p.cachedcontent, p.contentformat ?? 1);
                    if (pages.length && used + text.length > budget) {
                        next = index - 1;
                        break outer;
                    }
                    const slice = sliceText(text, 0, budget);
                    used += slice.text.length;
                    pages.push({ page_id: p.id, subwiki: { group_id: Number(s.groupid), user_id: s.userid || null }, title: p.title, first_page: truthy(p.firstpage), content_markdown: slice.text, content_truncated: slice.truncated, modified: sourceDate(p.timemodified ?? null, tz) });
                }
            }
            data = { ...base, settings: { mode: w.wikimode ?? null, first_page_title: w.firstpagetitle ?? null, default_format: w.defaultformat ?? null }, subwikis: subs.length, pages };
            if (subs.some((s) => s.id <= 0)) warnings.push("Hay subwikis que todavía no existen (nadie entró): no tienen páginas.");
            warnings.push("El contenido es el HTML renderizado por Moodle (puede incluir un índice de encabezados).");
            break;
        }
        case "data": {
            const db = instanceOf((await d.call("mod_data_get_databases_by_courses", { courseids: [courseId] }, DatabasesSchema)).databases, "La base de datos");
            const perpage = 25;
            const [fields, entries] = await Promise.all([
                d.call("mod_data_get_fields", { databaseid: db.id }, DataFieldsSchema),
                d.call("mod_data_get_entries", { databaseid: db.id, returncontents: 1, page: Math.floor(offset / perpage), perpage }, DataEntriesSchema),
            ]);
            wsfns.push("mod_data_get_databases_by_courses", "mod_data_get_fields", "mod_data_get_entries");
            const byId = new Map(fields.fields.map((f) => [f.id, f]));
            total = entries.totalcount ?? entries.entries.length;
            const start = Math.floor(offset / perpage) * perpage;
            if (start + entries.entries.length < total) next = start + entries.entries.length;
            data = {
                ...base,
                settings: { requires_approval: truthy(db.approval), comments: truthy(db.comments), max_entries: db.maxentries ?? null, required_entries: db.requiredentries ?? null, available_from: sourceDate(db.timeavailablefrom || null, tz), available_to: sourceDate(db.timeavailableto || null, tz) },
                fields: fields.fields.map((f) => ({ field_id: f.id, name: f.name, type: f.type, required: truthy(f.required), ...(f.type === "menu" || f.type === "radiobutton" || f.type === "checkbox" || f.type === "multimenu" ? { options: (f.param1 ?? "").split(/\r?\n/).filter(Boolean) } : {}) })),
                entries_total: total,
                entries: entries.entries.map((e) => ({
                    entry_id: e.id,
                    author: { user_id: e.userid ?? null, name: e.fullname ?? null },
                    approved: e.approved === undefined || e.approved === null ? null : truthy(e.approved),
                    modified: sourceDate(e.timemodified ?? null, tz),
                    values: Object.fromEntries(
                        (e.contents ?? []).map((c) => {
                            const f = byId.get(c.fieldid);
                            const files = (c.files ?? []).map((x) => x.filename).filter(Boolean);
                            const v = f?.type === "textarea" ? sourceToText(c.content, Number(c.content1 ?? 1)) : files.length ? files.join(", ") : (c.content ?? "");
                            return [f?.name ?? String(c.fieldid), v];
                        }),
                    ),
                })),
            };
            if (!fields.fields.length) warnings.push("La base de datos no tiene campos definidos.");
            break;
        }
        case "choice": {
            const c = instanceOf((await d.call("mod_choice_get_choices_by_courses", { courseids: [courseId] }, ChoicesSchema)).choices, "La consulta");
            const results = await d.call("mod_choice_get_choice_results", { choiceid: c.id }, ChoiceResultsSchema);
            wsfns.push("mod_choice_get_choices_by_courses", "mod_choice_get_choice_results");
            const show = ["no mostrar", "después de responder", "después de cerrar", "siempre"];
            data = {
                ...base,
                settings: { allow_update: truthy(c.allowupdate), allow_multiple: truthy(c.allowmultiple), limit_answers: truthy(c.limitanswers), results_shown_to_students: show[c.showresults ?? 0] ?? null, publish_names: truthy(c.publish), open: sourceDate(c.timeopen || null, tz), close: sourceDate(c.timeclose || null, tz) },
                options: results.options.map((o) => ({
                    option_id: o.id,
                    text: o.text ?? "",
                    max_answers: o.maxanswer || null,
                    responses: o.numberofuser ?? (o.userresponses ?? []).length,
                    percentage: o.percentageamount ?? null,
                    responders: (o.userresponses ?? []).map((u) => ({ user_id: u.userid ?? null, name: u.fullname ?? null })),
                })),
            };
            break;
        }
        case "lesson": {
            const l = instanceOf((await d.call("mod_lesson_get_lessons_by_courses", { courseids: [courseId] }, LessonsSchema)).lessons, "La lección");
            const pages = (await d.call("mod_lesson_get_pages", { lessonid: l.id }, LessonPagesSchema)).pages;
            const overview = d.teacher ? (await d.call("mod_lesson_get_attempts_overview", { lessonid: l.id }, LessonAttemptsSchema)).data : null;
            wsfns.push("mod_lesson_get_lessons_by_courses", "mod_lesson_get_pages", ...(d.teacher ? ["mod_lesson_get_attempts_overview"] : []));
            if (!d.teacher) warnings.push("Sin rol docente: los intentos de los participantes no se consultan (attempts=null).");
            data = {
                ...base,
                // Nunca la contraseña: sólo si la usa.
                settings: { practice: truthy(l.practice), retake: truthy(l.retake), max_attempts: l.maxattempts ?? null, time_limit_seconds: l.timelimit || null, available: sourceDate(l.available || null, tz), deadline: sourceDate(l.deadline || null, tz), max_grade: l.grade ?? null, uses_password: truthy(l.usepassword), custom_scoring: truthy(l.custom), review: truthy(l.review) },
                attempts: overview
                    ? {
                          total: overview.numofattempts ?? null,
                          average_score: overview.avescore ?? null,
                          high_score: overview.highscore ?? null,
                          low_score: overview.lowscore ?? null,
                          average_time_seconds: overview.avetime ?? null,
                          students: (overview.students ?? []).map((st) => ({ user_id: st.id, name: st.fullname ?? null, best_grade: st.bestgrade ?? null, attempts: st.attempts.map((a) => ({ try: a.try ?? null, grade: a.grade ?? null, start: sourceDate(a.timestart ?? null, tz), end: sourceDate(a.timeend ?? null, tz), completed: a.end === 1 })) })),
                      }
                    : d.teacher
                      ? { total: 0, students: [] }
                      : null,
                pages: pages.map((p) => ({ page_id: p.page.id, title: p.page.title ?? null, type: p.page.typestring ?? null, previous_page_id: p.page.prevpageid || null, next_page_id: p.page.nextpageid || null, contents_markdown: sliceText(sourceToText(p.page.contents, p.page.contentsformat ?? 1), 0, 4000).text, answers: (p.answerids ?? []).length, jumps: p.jumps ?? [] })),
            };
            warnings.push("Contenido de cada página recortado a 4000 caracteres; las respuestas se cuentan, no se transcriben.");
            break;
        }
        case "h5pactivity": {
            const h = instanceOf((await d.call("mod_h5pactivity_get_h5pactivities_by_courses", { courseids: [courseId] }, H5PActivitiesSchema)).h5pactivities, "La actividad H5P");
            if (input.attempt_id !== undefined) {
                // ADR-090: respuestas por pregunta de UN intento (mod_h5pactivity_get_results).
                const r = await d.call("mod_h5pactivity_get_results", { h5pactivityid: h.id, attemptids: [input.attempt_id] }, H5PResultsSchema);
                wsfns.push("mod_h5pactivity_get_h5pactivities_by_courses", "mod_h5pactivity_get_results");
                const a = r.attempts.find((x) => x.id === input.attempt_id);
                if (!a) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad H5P no tiene el intento ${input.attempt_id} (o la cuenta no puede revisarlo).`);
                if (!d.teacher && a.userid !== d.selfId) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "El intento no es tuyo; sin rol docente no se expone.");
                const answer = (x: z.infer<typeof AnswerSchema> | null | undefined) => (x ? { answer: x.answer ? sourceToText(x.answer, 1) : null, correct: x.correct ?? null, incorrect: x.incorrect ?? null, checked: x.checked ?? null, pass: x.pass ?? null, fail: x.fail ?? null } : null);
                data = {
                    ...base,
                    attempt: { attempt_id: a.id, user_id: a.userid ?? null, attempt: a.attempt ?? null, raw_score: a.rawscore ?? null, max_score: a.maxscore ?? null },
                    results: a.results.map((x) => ({
                        result_id: x.id ?? null,
                        // La pregunta principal no tiene subcontent; las internas (p. ej. de un Question Set), sí.
                        subcontent: x.subcontent || null,
                        interaction: x.interactiontype ?? null,
                        question: x.description ? sliceText(sourceToText(x.description, 1), 0, 2000).text : null,
                        raw_score: x.rawscore ?? null,
                        max_score: x.maxscore ?? null,
                        success: x.success === null || x.success === undefined ? null : x.success === 1,
                        completed: x.completion === null || x.completion === undefined ? null : x.completion === 1,
                        duration_seconds: x.duration ?? null,
                        tracked: x.track ?? null,
                        labels: { options: x.optionslabel ?? null, correct: x.correctlabel ?? null, answer: x.answerlabel ?? null },
                        options: (x.options ?? []).map((o) => ({ option: o.description ? sliceText(sourceToText(o.description, 1), 0, 500).text : null, correct_answer: answer(o.correctanswer), user_answer: answer(o.useranswer) })),
                    })),
                };
                warnings.push("Respuestas de un participante (👤): usalas sólo para la tarea docente pedida. Textos de preguntas recortados a 2000 caracteres y de opciones a 500.");
                break;
            }
            // get_user_attempts es el reporte docente (mod/h5pactivity:reviewattempts); sin rol docente, los
            // propios salen de get_attempts, como en la app. Si la actividad no deja verlos, se informa y el resto sale igual.
            let attempts: z.infer<typeof H5PAttemptsSchema> | null;
            if (d.teacher) attempts = await d.call("mod_h5pactivity_get_user_attempts", { h5pactivityid: h.id }, H5PAttemptsSchema);
            else {
                try {
                    const own = await d.call("mod_h5pactivity_get_attempts", { h5pactivityid: h.id, userids: [d.selfId] }, H5PAttemptsSchema);
                    attempts = { totalattempts: null, usersattempts: own.usersattempts.filter((u) => u.userid === d.selfId) };
                    warnings.push("Sin rol docente: sólo tus intentos (los de otros participantes no se exponen).");
                } catch (e) {
                    if (!(e instanceof CampusError) || !(e.code === "MOODLE_ERROR" || e.code === "MOODLE_PERMISSION_DENIED")) throw e;
                    attempts = null;
                    warnings.push(`Moodle no te deja ver tus intentos en esta actividad (${e.moodleErrorcode ?? e.code}); lo decide su configuración. El resto de la actividad se muestra igual.`);
                }
            }
            wsfns.push("mod_h5pactivity_get_h5pactivities_by_courses", d.teacher ? "mod_h5pactivity_get_user_attempts" : "mod_h5pactivity_get_attempts");
            const methods = ["", "nota más alta", "promedio", "último intento", "primer intento"];
            data = {
                ...base,
                settings: { max_grade: h.grade ?? null, grade_method: methods[h.grademethod ?? 0] || null, tracking: truthy(h.enabletracking) },
                package: (h.package ?? []).map((f) => ({ filename: f.filename ?? null, bytes: f.filesize ?? null })),
                package_content: await h5pPackageContent(d, h.package ?? [], warnings),
                attempts_total: attempts?.totalattempts ?? null,
                participants: (attempts?.usersattempts ?? []).map((u) => ({
                    user_id: u.userid,
                    attempts: u.attempts.map((a) => ({ attempt_id: (a as { id?: number }).id ?? null, attempt: a.attempt ?? null, raw_score: a.rawscore ?? null, max_score: a.maxscore ?? null, duration_seconds: a.duration ?? null, completed: a.completion === null || a.completion === undefined ? null : a.completion === 1, success: a.success === null || a.success === undefined ? null : a.success === 1, modified: sourceDate(a.timemodified ?? null, tz) })),
                })),
            };
            warnings.push("Participantes por user_id: los nombres salen de campus_list_participants. Las respuestas por pregunta de un intento se piden con attempt_id.");
            break;
        }
        case "questionnaire": {
            // ADR-097: no hay servicio web; la lista sale de la página de preguntas (sesión web).
            if (!d.teacher) throw new CampusError("POLICY_DENIED", `En el curso ${courseId} tu rol no es docente: la página de preguntas de la encuesta es una vista de edición y no se consulta.`);
            if (!d.webPage) throw new CampusError("AUTH_REQUIRED", "Leer las preguntas de una encuesta necesita la sesión web del Campus.");
            const rows = parseQuestionnaireQuestions(await d.webPage("questionnaire_questions", { id: String(m.id) }));
            if (!rows) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció la página de preguntas de la encuesta.");
            data = { ...base, questions: rows };
            warnings.push("Preguntas en el orden de la encuesta: id, posición, tipo y nombre. El enunciado y las opciones de cada una están en su formulario (campus_plan_questionnaire_question los muestra en la vista previa). Las respuestas no se leen por acá.");
            break;
        }
        case "folder": {
            const f = instanceOf((await d.call("mod_folder_get_folders_by_courses", { courseids: [courseId] }, FoldersSchema)).folders, "La carpeta");
            wsfns.push("mod_folder_get_folders_by_courses");
            const files = (m.contents ?? []).filter((c) => (c.type ?? "file") === "file" && c.fileurl);
            data = {
                ...base,
                settings: { display: f.display === 1 ? "en la página del curso" : "en una página aparte", show_expanded: truthy(f.showexpanded), download_button: truthy(f.showdownloadfolder), force_download: truthy(f.forcedownload) },
                files: files.map((c) => ({ path: c.filepath && c.filepath !== "/" ? c.filepath : null, file: d.moduleFileRef(m.id, c.filename ?? "archivo", c.fileurl!, c.mimetype ?? null, c.filesize ?? null, c.filepath ?? null) })).filter((x) => x.file),
            };
            break;
        }
        case "label": {
            // Texto completo de la etiqueta (campus_get_course lo recorta).
            const t = sliceText(sourceToText(m.description, 1), 0, budget);
            data = { ...base, text_markdown: t.text, text_truncated: t.truncated };
            break;
        }
        default:
            throw new CampusError("UNSUPPORTED_CONTENT", `Las actividades de tipo ${m.modname} no tienen una lectura de contenido.`);
    }
    if (m.modname !== "label") data = { ...data, ...description };
    return {
        data,
        wsfunctions: wsfns,
        coverage: {
            complete: next === null,
            consistency: "best_effort" as const,
            pages_read: 1,
            has_more: next !== null,
            next_cursor: next === null ? null : String(next),
            truncation_reason: next === null ? null : "Hay más elementos: pedí cursor=next_cursor.",
            ...(total !== null ? { detail: { scope: { total, offset } } } : {}),
        },
        warnings,
        source_url: `${d.profile.site_url}/mod/${m.modname}/view.php?id=${m.id}`,
        at,
    };
}

/**
 * Contenido del paquete de una actividad H5P (ADR-114): biblioteca principal y título (`h5p.json`) y,
 * si lo generó el MCP, el esquema tipado (`content/mcp-spec.json`) para editarlo con
 * campus_plan_h5p_content (operation=replace). El paquete es dato no confiable: se valida el esquema.
 */
async function h5pPackageContent(d: ActivityContentDeps, files: { filename?: string | null; filesize?: number | null; fileurl?: string | null }[], warnings: string[]) {
    const f = files[0];
    if (!f?.fileurl) return null;
    const max = Math.min(d.profile.limits.max_file_bytes, 20 * 1024 * 1024);
    if (f.filesize && f.filesize > max) {
        warnings.push(`El paquete pesa ${f.filesize} bytes: no se abrió para leer su contenido.`);
        return null;
    }
    const { bytes } = await d.download(f.fileurl, max);
    const entries = readZipDirectory(bytes);
    const json = (name: string): unknown => {
        const e = entries.find((x) => x.name === name);
        if (!e) return null;
        try {
            return JSON.parse(new TextDecoder().decode(readZipEntry(bytes, e, 2 * 1024 * 1024)));
        } catch {
            return null;
        }
    };
    const h5p = (json("h5p.json") ?? {}) as { mainLibrary?: unknown; title?: unknown; preloadedDependencies?: { machineName?: unknown; majorVersion?: unknown; minorVersion?: unknown }[] };
    const main = (h5p.preloadedDependencies ?? []).find((x) => x.machineName === h5p.mainLibrary);
    const raw = json("content/mcp-spec.json") as { content?: unknown } | null;
    const spec = raw ? H5pContentSpec.safeParse(raw.content) : null;
    if (spec?.success) warnings.push("package_content.spec es el esquema con que el MCP generó este contenido: para editarlo, modificalo y usá campus_plan_h5p_content con operation=replace.");
    else if (raw) warnings.push("El paquete trae un esquema del MCP que no es válido para esta versión: no se devuelve.");
    else warnings.push("Este paquete no lo generó el MCP: no hay esquema para editarlo; se puede reemplazar entero con campus_plan_h5p_content.");
    return {
        main_library: typeof h5p.mainLibrary === "string" ? `${h5p.mainLibrary}${main ? ` ${main.majorVersion}.${main.minorVersion}` : ""}` : null,
        title: typeof h5p.title === "string" ? h5p.title.slice(0, 255) : null,
        generated_by_mcp: !!spec?.success,
        ...(spec?.success ? { spec: spec.data } : {}),
    };
}
