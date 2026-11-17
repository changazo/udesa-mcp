import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { htmlFeatures } from "../../src/write/html-patch.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { HORARIOS } from "../fixtures/html-horarios.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * ADR-137 y ADR-138 contra el Moodle sintético: tablas, enlaces y componentes en resúmenes de sección,
 * etiquetas, páginas, descripciones y capítulos de libro.
 */

const SECTION_ID = 101;
const LABEL = 9821;
const PAGE = 9822;
const BOOK = 9823;
const ASSIGN = 9824;
const CHAPTER = 77;
const MEET = "https://meet.google.com/tzg-yemr-aqq";
const NEW_MEET = "https://meet.google.com/nue-vo00-sala";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Textos guardados; `display` simula lo que Moodle muestra a los estudiantes (por defecto, igual a lo guardado). */
async function harness(display: (html: string) => string = (x) => x) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["rename_content", "edit_activity", "manage_activity_entries"] } } });
    const s = {
        section: `<p>Clases: <a href="${MEET}">Meet</a></p>`,
        label: HORARIOS,
        pageIntro: "<p>Guía</p>",
        page: `<table><tbody><tr><td>Clase</td><td>Día</td></tr><tr><td>Teórica</td><td><span style="color: #333;">Lunes</span></td></tr></tbody></table><p>Link: ${MEET}</p>`,
        assign: `<p>Entregá por <a href="${MEET}">${MEET}</a></p>`,
        chapter: '<table class="t"><tbody><tr><td>Tema</td><td>Semana</td></tr><tr><td>Listas</td><td>3</td></tr><tr><td>Diccionarios</td><td>4</td></tr></tbody></table>',
    };
    const posts: Record<string, string>[] = [];
    const prev = h.fake.overrides.get("core_course_get_contents")!;
    h.fake.overrides.set("core_course_get_contents", (p) => (prev(p) as { id: number }[]).map((x) => ({ ...x, summary: x.id === SECTION_ID ? display(s.section) : "" })));
    h.w2.extraModules.push(
        { id: LABEL, modname: "label", name: "Horarios", section: 1, visible: true, get description() { return display(s.label); } } as never,
        { id: PAGE, modname: "page", name: "Guía", section: 1, visible: true, get description() { return display(s.pageIntro); } } as never,
        { id: BOOK, modname: "book", name: "Apunte", section: 1, visible: true, description: "" },
        { id: ASSIGN, modname: "assign", name: "TP1", section: 1, visible: true, get description() { return display(s.assign); } } as never,
    );
    h.fake.overrides.set("mod_page_get_pages_by_courses", () => ({ pages: [{ id: 1, coursemodule: PAGE, course: COURSE, name: "Guía", intro: display(s.pageIntro), content: display(s.page) }], warnings: [] }));
    let draft = 7000;
    const form = (action: string, hidden: Record<string, string>, qf: string, areas: Record<string, string>) =>
        `<html><body><form action="${SITE}${action}" method="post">${Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join("")}<input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="${qf}" value="1"><input type="text" name="name" value="Nombre"><input type="hidden" name="itemid" value="${++draft}">${Object.entries(areas).map(([k, v]) => `<textarea name="${k}[text]">${esc(v.replace(/@@PLUGINFILE@@\//g, `${SITE}/draftfile.php/5/user/draft/${draft}/`))}</textarea><input type="hidden" name="${k}[format]" value="1">`).join("")}<input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton" value="Guardar"><input type="submit" name="submitbutton2" value="Guardar y volver"></form></body></html>`;
    h.fake.web.pages.set("/course/editsection.php", (q, req) => {
        if (req.method === "GET") return { body: form("/course/editsection.php", { id: String(q.id) }, "_qf__editsection_form", { summary_editor: s.section }) };
        const b = new URLSearchParams(req.body ?? "");
        posts.push(Object.fromEntries(b));
        s.section = b.get("summary_editor[text]")!;
        return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
    });
    const modedit = h.fake.web.pages.get("/course/modedit.php")!;
    h.fake.web.pages.set("/course/modedit.php", (q, req) => {
        const b = new URLSearchParams(req.body ?? "");
        const cm = Number(q.update ?? b.get("update"));
        const kind = cm === LABEL ? "label" : cm === PAGE ? "page" : cm === ASSIGN ? "assign" : null;
        if (!kind) return modedit(q, req);
        if (req.method === "GET") {
            const areas = kind === "label" ? { introeditor: s.label } : kind === "page" ? { introeditor: s.pageIntro, page: s.page } : { introeditor: s.assign };
            return { body: form("/course/modedit.php", { update: String(cm) }, `_qf__mod_${kind}_mod_form`, areas) };
        }
        posts.push(Object.fromEntries(b));
        if (kind === "label") s.label = b.get("introeditor[text]")!;
        if (kind === "assign") s.assign = b.get("introeditor[text]")!;
        if (kind === "page") {
            s.pageIntro = b.get("introeditor[text]") ?? s.pageIntro;
            s.page = b.get("page[text]") ?? s.page;
        }
        return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
    });
    h.fake.web.pages.set("/mod/book/edit.php", (q, req) => {
        if (req.method === "GET") return Number(q.id) === CHAPTER && Number(q.cmid) === BOOK ? { body: form("/mod/book/edit.php", { cmid: String(q.cmid), id: String(q.id) }, "_qf__book_chapter_edit_form", { content_editor: s.chapter }) } : { status: 404, body: "no" };
        const b = new URLSearchParams(req.body ?? "");
        posts.push(Object.fromEntries(b));
        s.chapter = b.get("content_editor[text]")!;
        return { status: 303, body: null, headers: { location: `${SITE}/mod/book/view.php?id=${BOOK}` } };
    });
    return { h, s, posts };
}

const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}
async function undo(h: WriteHarness, actionId: string) {
    const u = await h.app.engine.planUndo(actionId, "test");
    if (!u.undoable) throw new Error(u.reason);
    return exec(h, u.plan.plan_id);
}

describe("campus_plan_patch_table (ADR-137)", () => {
    it("celdas de una etiqueta: sólo esas cambian; POST con formato 1 y sin notificar; deshacer exacto", async () => {
        const { h, s, posts } = await harness();
        const p = await plan(h, "patch_table", {
            target: { kind: "label", course_module_id: LABEL },
            table_match: { headers_contain: ["Clase", "Profesor", "Día"] },
            set_cells: [{ row_match: { Clase: "Consultas" }, column: "Día", expected_text: "Martes (extraordinario)", replacement_text: "Miércoles" }],
        });
        expect(p.payload_preview).toMatchObject({ target: "texto de la etiqueta 9821", changes: [{ column: "Día", before: "Martes (extraordinario)", after: "Miércoles" }] });
        const r = await exec(h, p.plan_id);
        expect(r.status, JSON.stringify(r.differences)).toBe("aplicado_verificado");
        expect(posts[0]).toMatchObject({ "introeditor[format]": "1", name: "Nombre" });
        expect(posts[0]).not.toHaveProperty("coursecontentnotification");
        expect(s.label).toBe(HORARIOS.slice(0, HORARIOS.lastIndexOf("Martes")) + "Miércoles" + HORARIOS.slice(HORARIOS.lastIndexOf("Martes") + "Martes (extraordinario)".length));
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(s.label).toBe(HORARIOS);
    });

    it("agregar una fila al contenido de una página copia su formato; quitar una fila de un capítulo de libro", async () => {
        const { h, s } = await harness();
        const add = await exec(h, (await plan(h, "patch_table", { target: { kind: "page_content", course_module_id: PAGE }, table_match: { headers_contain: ["Clase", "Día"] }, add_row: { values: { Clase: "Consultas", Día: "Miércoles" } } })).plan_id);
        expect(add.status).toBe("aplicado_verificado");
        expect(s.page).toContain('<tr><td>Consultas</td><td><span style="color: #333;">Miércoles</span></td></tr>');
        expect(s.pageIntro).toBe("<p>Guía</p>");
        const del = await exec(h, (await plan(h, "patch_table", { target: { kind: "book_chapter", course_module_id: BOOK, chapter_id: CHAPTER }, table_match: { headers_contain: ["Tema", "Semana"] }, delete_row: { row_match: { Tema: "Listas" } } })).plan_id);
        expect(del.status).toBe("aplicado_verificado");
        expect(htmlFeatures(s.chapter).cell_texts).toEqual(["Tema", "Semana", "Diccionarios", "4"]);
        expect((await undo(h, del.action_id)).status).toBe("aplicado_verificado");
        expect(htmlFeatures(s.chapter).cell_texts).toContain("Listas");
    });

    it("una sola operación por plan; precondición obsoleta (sólo cambió un estilo) → PLAN_STALE sin POST", async () => {
        const { h, s, posts } = await harness();
        expect((await errOf(plan(h, "patch_table", { target: { kind: "label", course_module_id: LABEL }, table_match: { headers_contain: ["Clase"] } }))).code).toBe("WRITE_NOT_ALLOWED");
        const p = await plan(h, "patch_table", { target: { kind: "label", course_module_id: LABEL }, table_match: { headers_contain: ["Clase", "Profesor"] }, delete_row: { row_match: { Clase: "Teórica" } } });
        s.label = s.label.replace("color: #000000;", "color: #111111;");
        expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
        expect(posts).toHaveLength(0);
        expect((await errOf(plan(h, "patch_table", { target: { kind: "page_content", course_module_id: LABEL }, table_match: { headers_contain: ["Clase"] }, delete_row: { row_match: { Clase: "x" } } }))).message).toContain("no es una página");
    });
});

describe("campus_plan_replace_link (ADR-137)", () => {
    it("encuentra el enlace en el resumen, la descripción de la tarea y no toca la mención suelta; deshacer restaura todo", async () => {
        const { h, s } = await harness();
        s.label = `<p><a href="${MEET}" class="btn">Sala</a></p>`;
        const p = await plan(h, "replace_link", { old_url: MEET, new_url: NEW_MEET });
        const found = (p.payload_preview as { found: { target: string }[] }).found.map((f) => f.target);
        expect(found.some((f) => f.startsWith("resumen de la sección 1"))).toBe(true);
        expect(found).toEqual(expect.arrayContaining(["texto de la etiqueta 9821", "descripción de «TP1» (assign)"]));
        expect(p.items).toHaveLength(3);
        expect(p.warnings.join(" ")).toContain("texto suelto");
        const r = await exec(h, p.plan_id);
        expect(r.status, JSON.stringify(r.differences)).toBe("aplicado_verificado");
        expect(s.section).toBe(`<p>Clases: <a href="${NEW_MEET}">Meet</a></p>`);
        expect(s.assign).toBe(`<p>Entregá por <a href="${NEW_MEET}">${NEW_MEET}</a></p>`);
        expect(s.label).toBe(`<p><a href="${NEW_MEET}" class="btn">Sala</a></p>`);
        expect(s.page).toContain(`Link: ${MEET}`);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(s.assign).toBe(`<p>Entregá por <a href="${MEET}">${MEET}</a></p>`);
    });

    it("dirección nueva inválida o sin apariciones: rechazo", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, "replace_link", { old_url: MEET, new_url: "javascript:alert(1)" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "replace_link", { old_url: "https://no.example/x", new_url: NEW_MEET }))).message).toContain("No hay enlaces");
    });
});

describe("campus_plan_insert_component (ADR-138)", () => {
    it("un aviso al final del resumen: guardado tal cual y visible para los estudiantes", async () => {
        const { h, s } = await harness();
        const r = await exec(h, (await plan(h, "insert_component", { target: { kind: "section_summary", section_number: 1 }, block: { type: "alert", variant: "warning", title: "Importante", body: "Consultas los **miércoles**." } })).plan_id);
        expect(r.status, JSON.stringify(r.differences)).toBe("aplicado_verificado");
        expect(r.verification.checked).toContain("vista_estudiantes");
        expect(s.section).toBe(`<p>Clases: <a href="${MEET}">Meet</a></p>\n<div class="alert alert-warning" role="alert"><p><strong>Importante</strong></p><p>Consultas los <strong>miércoles</strong>.</p></div>`);
    });

    it("si Moodle quita la clase o el iframe al mostrar, no es aplicado_verificado: dice qué no se ve", async () => {
        const stripClasses = await harness((x) => x.replace(/ class="[^"]*"/g, ""));
        const a = await exec(stripClasses.h, (await plan(stripClasses.h, "insert_component", { target: { kind: "label", course_module_id: LABEL }, block: { type: "alert", body: "x" } })).plan_id);
        expect(a.status).toBe("aplicado_con_diferencias");
        expect(a.differences).toEqual([expect.objectContaining({ field: "vista_estudiantes", expected: "recuadro (div.alert-info)" })]);
        const stripIframes = await harness((x) => x.replace(/<iframe[\s\S]*?<\/iframe>/g, ""));
        const v = await exec(stripIframes.h, (await plan(stripIframes.h, "insert_component", { target: { kind: "description", course_module_id: ASSIGN }, position: "start", block: { type: "video", youtube_url: "https://youtu.be/aqz-KE-bpKQ", title: "Clase" } })).plan_id);
        expect(v.status).toBe("aplicado_con_diferencias");
        expect(v.differences[0]!.expected).toBe("video incrustado (iframe)");
    });
});
