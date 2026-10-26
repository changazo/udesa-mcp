import { describe, expect, it } from "vitest";
import { writeZip } from "../../src/h5p/zip.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { CampusError } from "../../src/errors.js";
import { makeHarness, type Harness } from "../fixtures/harness.js";
import { COURSE, SITE, USER_ID, syntheticProfileJson } from "../fixtures/fake-moodle.js";

/** ADR-079: contenido interno de libros, glosarios, wikis, bases de datos, consultas, lecciones, H5P y carpetas. Datos inventados. */
const CHAPTER_URL = (id: number) => `${SITE}/webservice/pluginfile.php/77/mod_book/chapter/${id}/index.html`;
const modules = [
    { id: 701, modname: "book", name: "Libro", instance: 71, contents: [
        { type: "content", filename: "structure", filepath: "/", content: JSON.stringify([{ title: "Uno", href: "11/index.html", level: 0, hidden: "0", subitems: [{ title: "Uno.a", href: "12/index.html", level: 1, hidden: "1" }] }, { title: "Dos", href: "13/index.html", level: 0, hidden: "0", subitems: [] }]) },
        ...[11, 12, 13].map((id) => ({ type: "file", filename: "index.html", filepath: `/${id}/`, filesize: 0, fileurl: CHAPTER_URL(id) })),
    ] },
    { id: 702, modname: "glossary", name: "Glosario", instance: 72 },
    { id: 703, modname: "wiki", name: "Wiki", instance: 73 },
    { id: 704, modname: "data", name: "Base", instance: 74 },
    { id: 705, modname: "choice", name: "Consulta", instance: 75 },
    { id: 706, modname: "lesson", name: "Lección", instance: 76 },
    { id: 707, modname: "h5pactivity", name: "H5P", instance: 77 },
    { id: 708, modname: "folder", name: "Carpeta", instance: 78, contents: [{ type: "file", filename: "a.pdf", filepath: "/", filesize: 10, fileurl: `${SITE}/webservice/pluginfile.php/78/mod_folder/content/1/a.pdf`, mimetype: "application/pdf" }, { type: "file", filename: "b.txt", filepath: "/sub/", filesize: 3, fileurl: `${SITE}/webservice/pluginfile.php/78/mod_folder/content/1/sub/b.txt`, mimetype: "text/plain" }] },
    { id: 709, modname: "questionnaire", name: "Encuesta", instance: 79 },
    { id: 710, modname: "quiz", name: "Parcial", instance: 80 },
    { id: 711, modname: "label", name: "Etiqueta", instance: 81, description: `<p>${"palabra ".repeat(300)}fin</p>` },
];

const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
async function harness(maxChars?: number, withWeb = false) {
    const web = withWeb ? new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" }) : undefined;
    const h = await makeHarness({ ...(maxChars ? { profile: { limits: { ...(syntheticProfileJson() as { limits: object }).limits, max_text_chars_per_result: maxChars } } } : {}), ...(web ? { webSource: web } : {}) });
    const o = h.fake.overrides;
    const row = (id: number, extra: Record<string, unknown> = {}) => ({ id: id - 630, coursemodule: id, course: COURSE, name: "x", ...extra });
    o.set("core_course_get_contents", () => [{ id: 1, section: 1, name: "S", modules }]);
    o.set("mod_book_get_books_by_courses", () => ({ books: [row(701, { numbering: 1, customtitles: 0, intro: "<p>Leé el <strong>libro</strong></p>", introformat: 1 })], warnings: [] }));
    h.fake.extraFiles.set(`/webservice/pluginfile.php/77/mod_book/chapter/11/index.html`, "<h3>Uno</h3><p>Primer <strong>capítulo</strong>.</p>");
    h.fake.extraFiles.set(`/webservice/pluginfile.php/77/mod_book/chapter/12/index.html`, "<p>Sub oculto.</p>");
    h.fake.extraFiles.set(`/webservice/pluginfile.php/77/mod_book/chapter/13/index.html`, `<p>${"x".repeat(1500)}</p>`);
    o.set("mod_glossary_get_glossaries_by_courses", () => ({ glossaries: [row(702, { allowduplicatedentries: 0, defaultapproval: 1, mainglossary: 0, displayformat: "dictionary" })], warnings: [] }));
    o.set("mod_glossary_get_entries_by_letter", (p) => {
        const all = Array.from({ length: 60 }, (_, i) => ({ id: 900 + i, concept: `T${i}`, definition: `<p>Def ${i}</p>`, definitionformat: 1, userid: 5, userfullname: "Autora Sintética", approved: true, timemodified: 1792450682 }));
        return { count: all.length, entries: all.slice(Number(p.from), Number(p.from) + Number(p.limit)), warnings: [] };
    });
    o.set("mod_glossary_get_entries_to_approve", () => ({ count: 1, entries: [{ id: 990, concept: "Pendiente", definition: "<p>Espera</p>", definitionformat: 1, userid: 6, userfullname: "Estudiante Sintético", approved: false, timemodified: 1792450682 }], warnings: [] }));
    o.set("mod_lesson_get_attempts_overview", () => ({ data: { numofattempts: 1, avescore: 80, highscore: 80, lowscore: 80, avetime: 120, students: [{ id: 6, fullname: "Estudiante Sintético", bestgrade: 80, attempts: [{ try: 0, grade: 80, timestart: 1792450000, timeend: 1792450120, end: 1 }] }] }, warnings: [] }));
    o.set("mod_glossary_get_categories", () => ({ count: 1, categories: [{ id: 3, name: "General", usedynalink: 0 }], warnings: [] }));
    o.set("mod_wiki_get_wikis_by_courses", () => ({ wikis: [row(703, { wikimode: "collaborative", firstpagetitle: "Inicio", defaultformat: "html" })], warnings: [] }));
    o.set("mod_wiki_get_subwikis", () => ({ subwikis: [{ id: 31, wikiid: 73, groupid: "0", userid: 0, canedit: true }], warnings: [] }));
    o.set("mod_wiki_get_subwiki_pages", () => ({ pages: [{ id: 41, title: "Inicio", cachedcontent: "<p>Hola wiki</p>", contentformat: 1, firstpage: true, timemodified: 1792450682 }], warnings: [] }));
    o.set("mod_data_get_databases_by_courses", () => ({ databases: [row(704, { approval: false, comments: true, maxentries: 0, requiredentries: 0 })], warnings: [] }));
    o.set("mod_data_get_fields", () => ({ fields: [{ id: 1, name: "Título", type: "text", required: true }, { id: 2, name: "Texto", type: "textarea", required: false }, { id: 3, name: "Tipo", type: "menu", required: false, param1: "Libro\nArtículo" }], warnings: [] }));
    o.set("mod_data_get_entries", () => ({ entries: [{ id: 51, userid: 6, fullname: "Estudiante Sintético", approved: true, timemodified: 1792450682, contents: [{ fieldid: 1, content: "Uno" }, { fieldid: 2, content: "<p>Texto <em>largo</em></p>", content1: "1" }, { fieldid: 3, content: "Libro" }] }], totalcount: 1, warnings: [] }));
    o.set("mod_choice_get_choices_by_courses", () => ({ choices: [row(705, { allowupdate: true, allowmultiple: false, showresults: 3, publish: false, timeopen: 0, timeclose: 0 })], warnings: [] }));
    o.set("mod_choice_get_choice_results", () => ({ options: [{ id: 1, text: "Sí", maxanswer: 0, numberofuser: 1, percentageamount: 100, userresponses: [{ userid: 6, fullname: "Estudiante Sintético", timemodified: 1 }] }, { id: 2, text: "No", maxanswer: 0, numberofuser: 0, percentageamount: 0, userresponses: [] }], warnings: [] }));
    o.set("mod_lesson_get_lessons_by_courses", () => ({ lessons: [row(706, { usepassword: true, password: "SECRETO-NO", maxattempts: 2, grade: 10, retake: true })], warnings: [] }));
    o.set("mod_lesson_get_pages", () => ({ pages: [{ page: { id: 61, prevpageid: 0, nextpageid: 0, title: "Página 1", contents: "<p>Leé esto</p>", contentsformat: 1, typestring: "Opción múltiple", qtype: 3 }, answerids: [1, 2], jumps: [-1, 0] }], warnings: [] }));
    o.set("mod_h5pactivity_get_h5pactivities_by_courses", () => ({ h5pactivities: [row(707, { grade: 100, grademethod: 1, enabletracking: 1, package: [{ filename: "p.h5p", filesize: 99 }] })], warnings: [] }));
    o.set("mod_h5pactivity_get_results", (p) => (p["attemptids[0]"] === "901" && p.h5pactivityid === "77" ? { activityid: 77, attempts: [{ id: 901, h5pactivityid: 77, userid: 6, attempt: 1, rawscore: 1, maxscore: 2, results: [{ id: 1, attemptid: 901, subcontent: "", timecreated: 1, interactiontype: "choice", description: "<p>¿Capital de Francia?</p>", rawscore: 1, maxscore: 1, completion: 1, success: 1, optionslabel: "Opciones", correctlabel: "Correcta", answerlabel: "Respuesta", track: true, options: [{ description: "París", id: 0, correctanswer: { answer: "París", correct: true }, useranswer: { answer: "París", correct: true } }, { description: "Roma", id: 1 }] }] }], warnings: [] } : { activityid: 77, attempts: [], warnings: [] }));
    o.set("mod_h5pactivity_get_user_attempts", () => ({ activityid: 77, usersattempts: [{ userid: 6, attempts: [{ id: 901, attempt: 1, rawscore: 3, maxscore: 4, duration: 60, completion: 1, success: 0, timemodified: 1792450682 }] }], totalattempts: 1, warnings: [] }));
    o.set("mod_folder_get_folders_by_courses", () => ({ folders: [row(708, { display: 0, showexpanded: 1, showdownloadfolder: 1, forcedownload: 0 })], warnings: [] }));
    return h;
}
const read = (h: Harness, cmid: number, cursor?: string) => h.app.service.getActivityContent({ course_id: COURSE, course_module_id: cmid, ...(cursor ? { cursor } : {}) });
async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("contenido interno de actividades (ADR-079)", () => {
    it("descripción de la actividad y texto completo de una etiqueta (ADR-083)", async () => {
        const h = await harness();
        expect((await read(h, 701)).data).toMatchObject({ description_markdown: "Leé el **libro**", description_truncated: false });
        const l = (await read(h, 711)).data as { text_markdown: string; text_truncated: boolean };
        expect(l.text_markdown.endsWith("fin")).toBe(true);
        expect(l.text_truncated).toBe(false);
    });


    it("libro: capítulos con contenido (incluye ocultos y subcapítulos) y paginado por caracteres", async () => {
        const h = await harness();
        const r = await read(h, 701);
        const d = r.data as { chapters: { chapter_id: number; subchapter: boolean; hidden: boolean; content_markdown: string }[] };
        expect(d.chapters.map((c) => [c.chapter_id, c.subchapter, c.hidden])).toEqual([[11, false, false], [12, true, true], [13, false, false]]);
        expect(d.chapters[0]!.content_markdown).toContain("**capítulo**");
        expect(r.coverage.complete).toBe(true);
        const small = await harness(1000);
        const p1 = await read(small, 701);
        expect(p1.coverage.has_more).toBe(true);
        const p2 = await read(small, 701, p1.coverage.next_cursor!);
        expect((p2.data as { chapters: { chapter_id: number }[] }).chapters.map((c) => c.chapter_id)).toEqual([13]);
    });

    it("glosario: entradas con autor, categorías y cursor; wiki: páginas con contenido", async () => {
        const h = await harness();
        const g = await read(h, 702);
        expect((g.data as { entries: unknown[] }).entries).toHaveLength(50);
        expect(g.coverage.next_cursor).toBe("50");
        const g2 = await read(h, 702, "50");
        expect((g2.data as { entries: { concept: string; author: { name: string } }[] }).entries.map((e) => e.concept)).toHaveLength(10);
        expect(g2.coverage.complete).toBe(true);
        expect(JSON.stringify(g.data)).toContain("Autora Sintética");
        expect((g.data as { pending: { concept: string }[] }).pending).toEqual([expect.objectContaining({ concept: "Pendiente" })]);
        const w = await read(h, 703);
        expect((w.data as { pages: { title: string; content_markdown: string; first_page: boolean }[] }).pages).toEqual([expect.objectContaining({ title: "Inicio", content_markdown: "Hola wiki", first_page: true })]);
    });

    it("base de datos (campos y valores por nombre), consulta (opciones y quién eligió), lección SIN contraseña, H5P y carpeta con file_ref", async () => {
        const h = await harness();
        const db = await read(h, 704);
        expect((db.data as { entries: { values: Record<string, string> }[] }).entries[0]!.values).toEqual({ Título: "Uno", Texto: "Texto *largo*", Tipo: "Libro" });
        expect((db.data as { fields: { options?: string[] }[] }).fields[2]!.options).toEqual(["Libro", "Artículo"]);
        const ch = await read(h, 705);
        expect((ch.data as { options: { text: string; responses: number; responders: { name: string }[] }[] }).options[0]).toMatchObject({ text: "Sí", responses: 1, responders: [{ name: "Estudiante Sintético" }] });
        const l = await read(h, 706);
        expect(JSON.stringify(l)).not.toContain("SECRETO-NO");
        expect((l.data as { settings: { uses_password: boolean } }).settings.uses_password).toBe(true);
        expect((l.data as { attempts: { students: { best_grade: number; attempts: { completed: boolean }[] }[] } }).attempts.students[0]).toMatchObject({ best_grade: 80, attempts: [{ completed: true }] });
        const x = await read(h, 707);
        expect((x.data as { participants: { attempts: { raw_score: number; success: boolean }[] }[] }).participants[0]!.attempts[0]).toMatchObject({ raw_score: 3, success: false });
        const f = await read(h, 708);
        const files = (f.data as { files: { path: string | null; file: { ref: string; name: string } }[] }).files;
        expect(files.map((y) => [y.path, y.file.name])).toEqual([[null, "a.pdf"], ["/sub/", "b.txt"]]);
        expect(files[0]!.file.ref).toMatch(/^file_m\.\d+\.708\./);
    });

    it("ADR-114: H5P generado por el MCP devuelve su esquema para editarlo; uno ajeno, sólo biblioteca y título", async () => {
        const h = await harness();
        const url = `${SITE}/webservice/pluginfile.php/1/mod_h5pactivity/package/0/mcp.h5p`;
        const spec = { type: "question_set", questions: [{ kind: "true_false", question: "¿Sí?", correct: true }] };
        const pkg = (withSpec: boolean) => writeZip([["h5p.json", JSON.stringify({ title: "Repaso", mainLibrary: "H5P.QuestionSet", preloadedDependencies: [{ machineName: "H5P.QuestionSet", majorVersion: 1, minorVersion: 21 }] })], ["content/content.json", "{}"], ...(withSpec ? ([["content/mcp-spec.json", JSON.stringify({ v: 1, content: spec })]] as [string, string][]) : [])]);
        h.fake.overrides.set("mod_h5pactivity_get_h5pactivities_by_courses", () => ({ h5pactivities: [{ id: 77, coursemodule: 707, course: COURSE, name: "x", grade: 100, grademethod: 1, enabletracking: 1, package: [{ filename: "mcp.h5p", filesize: 900, fileurl: url }] }], warnings: [] }));
        h.fake.extraFiles.set(new URL(url).pathname, pkg(true));
        const a = (await read(h, 707)).data as { package_content: Record<string, unknown> };
        expect(a.package_content).toEqual({ main_library: "H5P.QuestionSet 1.21", title: "Repaso", generated_by_mcp: true, spec });
        h.fake.extraFiles.set(new URL(url).pathname, pkg(false));
        const b = await read(h, 707);
        expect((b.data as { package_content: Record<string, unknown> }).package_content).toEqual({ main_library: "H5P.QuestionSet 1.21", title: "Repaso", generated_by_mcp: false });
        expect(b.warnings.join(" ")).toMatch(/no lo generó el MCP/);
    });

    it("tipos con otra herramienta o sin lectura → UNSUPPORTED_CONTENT; actividad ajena → RESOURCE_OUT_OF_SCOPE; no usa funciones *_view_*", async () => {
        const h = await harness();
        expect(await codeOf(read(h, 709))).toBe("AUTH_REQUIRED");
        expect(await codeOf(read(h, 710))).toBe("UNSUPPORTED_CONTENT");
        expect(await codeOf(read(h, 999))).toBe("RESOURCE_OUT_OF_SCOPE");
        for (const cm of [701, 702, 703, 704, 705, 706, 707, 708]) await read(h, cm);
        expect(h.fake.calls.some((c) => /_view_/.test(c.fn))).toBe(false);
    });

    it("H5P: con attempt_id, respuestas por pregunta del intento (ADR-090); intento ajeno o en otro tipo → error", async () => {
        const h = await harness();
        const list = (await read(h, 707)).data as { participants: { attempts: { attempt_id: number }[] }[] };
        expect(list.participants[0]!.attempts[0]!.attempt_id).toBe(901);
        const r = (await h.app.service.getActivityContent({ course_id: COURSE, course_module_id: 707, attempt_id: 901 })).data as Record<string, unknown>;
        expect(r.attempt).toMatchObject({ attempt_id: 901, user_id: 6, raw_score: 1, max_score: 2 });
        expect(r.results).toEqual([expect.objectContaining({ interaction: "choice", question: "¿Capital de Francia?", success: true, options: [{ option: "París", correct_answer: expect.objectContaining({ answer: "París", correct: true }), user_answer: expect.objectContaining({ answer: "París" }) }, { option: "Roma", correct_answer: null, user_answer: null }] })]);
        expect(await codeOf(h.app.service.getActivityContent({ course_id: COURSE, course_module_id: 707, attempt_id: 902 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.getActivityContent({ course_id: COURSE, course_module_id: 701, attempt_id: 901 }))).toBe("UNSUPPORTED_CONTENT");
    });

    it("encuesta: preguntas con id, posición, tipo y nombre desde la página de preguntas (ADR-097)", async () => {
        const h = await harness(undefined, true);
        const row = (id: number, pos: number, type: string, name: string) => `<div class="qn-container"><div class="qnums">posición ${pos}</div><input value="${id}" name="movebutton[${id}]" type="image"><input value="${id}" name="editbutton[${id}]" type="image"> [${type}] (${name})</div>`;
        h.fake.web.pages.set("/mod/questionnaire/questions.php", (q) => ({ body: Number(q.id) === 709 ? `<html><body><form><input type="hidden" name="_qf__mod_questionnaire_questions_form" value="1">${row(32, 1, "Botones de radio", "Sentido &amp; vida")}${row(33, 2, "Cuadro de texto", "mcp")}</form></body></html>` : "<html>no</html>" }));
        const d = (await read(h, 709)).data as { questions: unknown[] };
        expect(d.questions).toEqual([{ question_id: 32, position: 1, type: "Botones de radio", name: "Sentido & vida" }, { question_id: 33, position: 2, type: "Cuadro de texto", name: "mcp" }]);
    });
});

describe("H5P sin rol docente (ADR-123)", () => {
    it("sólo tus intentos, por mod_h5pactivity_get_attempts; el intento de otro no se expone", async () => {
        const h = await harness();
        h.fake.overrides.set("core_user_get_course_user_profiles", () => [{ id: USER_ID, roles: [{ roleid: 5, shortname: "student", name: "student" }] }]);
        h.fake.overrides.set("mod_h5pactivity_get_attempts", (p) => ({ activityid: 77, usersattempts: [{ userid: Number(p["userids[0]"]), attempts: [{ id: 950, attempt: 1, rawscore: 2, maxscore: 4, duration: 30, completion: 1, success: 0, timemodified: 1792450682 }] }], warnings: [] }));
        const r = await read(h, 707);
        const d = r.data as { participants: { user_id: number; attempts: { attempt_id: number }[] }[] };
        expect(d.participants).toEqual([expect.objectContaining({ user_id: USER_ID, attempts: [expect.objectContaining({ attempt_id: 950 })] })]);
        expect(h.fake.callsOf("mod_h5pactivity_get_attempts").at(-1)!.params["userids[0]"]).toBe(String(USER_ID));
        expect(h.fake.callsOf("mod_h5pactivity_get_user_attempts").length).toBe(0);
        expect(await codeOf(h.app.service.getActivityContent({ course_id: COURSE, course_module_id: 707, attempt_id: 901 }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("si Moodle no deja ver los intentos propios, la actividad sale igual con un aviso", async () => {
        const h = await harness();
        h.fake.overrides.set("core_user_get_course_user_profiles", () => [{ id: USER_ID, roles: [{ roleid: 5, shortname: "student", name: "student" }] }]);
        h.fake.overrides.set("mod_h5pactivity_get_attempts", () => ({ exception: "moodle_exception", errorcode: "nopermissiontoviewattempts", message: "No" }));
        const r = await read(h, 707);
        expect(r.warnings.join(" ")).toContain("no te deja ver tus intentos");
    });
});

