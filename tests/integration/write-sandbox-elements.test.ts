import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { W2_GROUP } from "../fixtures/fake-w2.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-077: los elementos del sandbox (descripción, opciones, archivos, altas, capítulos, entradas y páginas). */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_activity", "create_content", "manage_activity_entries"] } } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    return { h, acts };
}
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
async function run(h: WriteHarness, intent: string, input: Record<string, unknown>) {
    return exec(h, (await plan(h, intent, input)).plan_id);
}
async function undo(h: WriteHarness, actionId: string) {
    const u = await h.app.engine.planUndo(actionId, "test");
    if (!u.undoable) throw new Error(u.reason);
    return exec(h, u.plan.plan_id);
}
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}
function localFiles(names: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "mcp-act-"));
    return names.map((n, i) => {
        const p = join(dir, n);
        writeFileSync(p, `contenido ${i} de ${n}`);
        return p;
    });
}

describe("descripción de cualquier actividad con descripción estándar (ADR-077)", () => {
    it("carpeta, libro y H5P: se lee y se verifica por el formulario; el resto vuelve intacto; sin notificar; deshacer", async () => {
        const { h, acts } = await harness();
        for (const kind of ["folder", "book", "hvp"]) {
            const m = acts.add({ kind, name: `Mi ${kind}`, intro: "<p>Vieja</p>", ...(kind === "folder" ? { files: [{ filename: "a.pdf", filesize: 10 }] } : {}) });
            const r = await run(h, "edit_activity_text", { course_module_id: m.id, description: "Nueva **consigna**." });
            expect(r.status).toBe("aplicado_verificado");
            expect(m.intro).toContain("<strong>consigna</strong>");
            expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
            expect(m.intro).toBe("<p>Vieja</p>");
            if (kind === "folder") expect(m.files).toEqual([{ filename: "a.pdf", filesize: 10 }]);
        }
        const posts = acts.posts.filter((p) => p.path === "modedit").map((p) => p.body);
        expect(posts.every((p) => !("coursecontentnotification" in p))).toBe(true);
        expect(posts.find((p) => p._qf__mod_hvp_mod_form)).toMatchObject({ h5pparams: '{"params":{}}' });
    });

    it("Turnitin y tipos sin descripción editable se rechazan; sin cambios en Moodle → sin_efecto", async () => {
        const { h, acts } = await harness();
        h.w2.extraModules.push({ id: 6001, modname: "turnitintooltwo", name: "TII", section: 1, visible: true }, { id: 6002, modname: "scorm", name: "S", section: 1, visible: true });
        expect((await errOf(plan(h, "edit_activity_text", { course_module_id: 6001, description: "x" }))).message).toMatch(/Turnitin/);
        expect((await errOf(plan(h, "edit_activity_text", { course_module_id: 6002, description: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
        const m = acts.add({ kind: "glossary", name: "G", intro: "", entries: [] });
        acts.noop = true;
        expect((await run(h, "edit_activity_text", { course_module_id: m.id, description: "Algo" })).status).toBe("sin_efecto");
    });
});

describe("opciones de una consulta (ADR-077)", () => {
    it("agregar más que los espacios libres, renombrar y quitar; deshacer vuelve al original", async () => {
        const { h, acts } = await harness();
        const m = acts.add({ kind: "choice", name: "Consulta", intro: "", options: [{ id: 1, text: "A", answers: 2 }, { id: 2, text: "B", answers: 0 }] });
        const r = await run(h, "choice_options", { course_module_id: m.id, add: ["C", "D", "E"], rename: [{ from: "A", to: "A1" }], remove: ["B"] });
        expect(r.status).toBe("aplicado_verificado");
        expect(m.options!.map((o) => o.text)).toEqual(["A1", "C", "D", "E"]);
        const post = acts.posts.at(-1)!.body;
        expect(post.option_repeats).toBe("5");
        expect(post["optionid[4]"]).toBe("0");
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(m.options!.map((o) => o.text)).toEqual(["A", "B"]);
        expect(m.options!.find((o) => o.text === "A")!.answers).toBe(2);
    });

    it("rechazos: quitar una opción con respuestas, opción inexistente, resultado repetido o vacío; aviso al renombrar con respuestas", async () => {
        const { h, acts } = await harness();
        const m = acts.add({ kind: "choice", name: "Consulta", intro: "", options: [{ id: 1, text: "A", answers: 2 }, { id: 2, text: "B", answers: 0 }] });
        expect((await errOf(plan(h, "choice_options", { course_module_id: m.id, remove: ["A"] }))).message).toMatch(/respuesta/);
        expect((await errOf(plan(h, "choice_options", { course_module_id: m.id, remove: ["Z"] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "choice_options", { course_module_id: m.id, add: ["B"] }))).message).toMatch(/repetidas/);
        expect((await errOf(plan(h, "choice_options", { course_module_id: m.id }))).code).toBe("WRITE_NOT_ALLOWED");
        const p = await plan(h, "choice_options", { course_module_id: m.id, rename: [{ from: "A", to: "Otra" }] });
        expect(p.warnings.join(" ")).toMatch(/2 respuesta/);
    });
});

describe("archivos de carpetas y recursos (ADR-077)", () => {
    it("carpeta: agregar en el borrador que sirve el formulario (los demás quedan), deshacer quita lo agregado; quitar es R3 sin deshacer", async () => {
        const { h, acts } = await harness();
        const m = acts.add({ kind: "folder", name: "Carpeta", intro: "", files: [{ filename: "a.pdf", filesize: 10 }, { filename: "b.pdf", filesize: 20 }] });
        const [c] = localFiles(["c.txt"]);
        const r = await run(h, "activity_files", { course_module_id: m.id, add_file_paths: [c] });
        expect(r.status).toBe("aplicado_verificado");
        expect(m.files!.map((f) => f.filename).sort()).toEqual(["a.pdf", "b.pdf", "c.txt"]);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(m.files!.map((f) => f.filename).sort()).toEqual(["a.pdf", "b.pdf"]);
        const p = await plan(h, "activity_files", { course_module_id: m.id, remove_filenames: ["b.pdf"] });
        expect(p.risk).toBe("R3");
        const d = await exec(h, p.plan_id);
        expect(d.status).toBe("aplicado_verificado");
        expect(m.files!.map((f) => f.filename)).toEqual(["a.pdf"]);
        expect((await h.app.engine.planUndo(d.action_id, "test")).undoable).toBe(false);
    });

    it("recurso: reemplazar su archivo; rechazos (nombre repetido, archivo inexistente, carpeta vacía, tipo equivocado)", async () => {
        const { h, acts } = await harness();
        const res = acts.add({ kind: "resource", name: "Apunte", intro: "", files: [{ filename: "viejo.pdf", filesize: 10 }] });
        const [nuevo, a2, extra] = localFiles(["nuevo.txt", "a.pdf", "x.txt"]);
        expect((await run(h, "activity_files", { course_module_id: res.id, add_file_paths: [nuevo] })).status).toBe("aplicado_verificado");
        expect(res.files!.map((f) => f.filename)).toEqual(["nuevo.txt"]);
        expect((await errOf(plan(h, "activity_files", { course_module_id: res.id, remove_filenames: ["nuevo.txt"] }))).code).toBe("WRITE_NOT_ALLOWED");
        const folder = acts.add({ kind: "folder", name: "Carpeta", intro: "", files: [{ filename: "a.pdf", filesize: 10 }] });
        expect((await errOf(plan(h, "activity_files", { course_module_id: folder.id, add_file_paths: [a2] }))).message).toMatch(/mismo nombre|Ya hay/);
        expect((await errOf(plan(h, "activity_files", { course_module_id: folder.id, remove_filenames: ["zzz.pdf"] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "activity_files", { course_module_id: folder.id, remove_filenames: ["a.pdf"] }))).message).toMatch(/vacía/);
        const book = acts.add({ kind: "book", name: "Libro", intro: "", chapters: [] });
        expect((await errOf(plan(h, "activity_files", { course_module_id: book.id, add_file_paths: [extra] }))).code).toBe("WRITE_NOT_ALLOWED");
    });

    it("H5P (ADR-104): reemplazar el paquete en `packagefile`, verificado por el servicio de H5P; sólo .h5p; R3 sin deshacer", async () => {
        const { h, acts } = await harness();
        const m = acts.add({ kind: "h5pactivity", name: "H5P", intro: "", files: [{ filename: "viejo.h5p", filesize: 10 }] });
        const [pkg, txt] = localFiles(["nuevo.h5p", "nuevo.txt"]);
        const p = await plan(h, "activity_files", { course_module_id: m.id, add_file_paths: [pkg] });
        expect(p.risk).toBe("R3");
        expect(p.items[0]!.function).toBe("course_modedit_h5pactivity_update_files");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(m.files!.map((f) => f.filename)).toEqual(["nuevo.h5p"]);
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);
        expect((await errOf(plan(h, "activity_files", { course_module_id: m.id, add_file_paths: [txt] }))).message).toMatch(/\.h5p/);
    });
});

describe("altas de más tipos (ADR-077)", () => {
    it("carpeta con archivos, consulta con 7 opciones, wiki, elección de grupo, libro, subsección y H5P; ocultos y sin notificar; deshacer borra", async () => {
        const { h, acts } = await harness();
        const [a, b, pkg] = localFiles(["a.txt", "b.txt", "x.h5p"]);
        const cases: Record<string, unknown>[] = [
            { type: "folder", name: "Carpeta", file_paths: [a, b] },
            { type: "choice", name: "Consulta", options: ["1", "2", "3", "4", "5", "6", "7"] },
            { type: "wiki", name: "Wiki", first_page_title: "Portada", wiki_mode: "individual" },
            { type: "choicegroup", name: "Elección", group_ids: [13, W2_GROUP] },
            { type: "book", name: "Libro", intro: "Hola" },
            { type: "subsection", name: "Sub" },
            { type: "h5pactivity", name: "H5P", file_path: pkg },
        ];
        for (const c of cases) {
            const r = await run(h, "create_content", { section: 1, ...c });
            expect(r.status, String(c.type)).toBe("aplicado_verificado");
            const m = [...acts.mods.values()].find((x) => x.name === c.name)!;
            expect(m.visible).toBe(false);
            if (c.type === "folder") expect(m.files!.map((f) => f.filename).sort()).toEqual(["a.txt", "b.txt"]);
            if (c.type === "choice") expect(m.options!).toHaveLength(7);
            if (c.type === "choicegroup") expect(m.groups).toEqual([W2_GROUP, 13].sort((x, y) => x - y));
            if (c.type === "wiki") expect(m.wiki).toMatchObject({ mode: "individual", first: "Portada" });
            expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
            expect(h.w2.extraModules.some((x) => x.id === m.id)).toBe(false);
        }
        expect(acts.posts.filter((p) => p.path === "modedit").every((p) => !("coursecontentnotification" in p.body))).toBe(true);
    });

    it("rechazos: parámetro de otro tipo, falta el propio, opciones repetidas, grupo ajeno, paquete que no es .h5p, descripción en subsección", async () => {
        const { h } = await harness();
        const [txt] = localFiles(["x.txt"]);
        expect((await errOf(plan(h, "create_content", { section: 1, type: "book", name: "L", options: ["a"] }))).message).toMatch(/no corresponde/);
        expect((await errOf(plan(h, "create_content", { section: 1, type: "wiki", name: "W" }))).message).toMatch(/first_page_title/);
        expect((await errOf(plan(h, "create_content", { section: 1, type: "choice", name: "C", options: ["a", "a"] }))).message).toMatch(/repetidas/);
        expect((await errOf(plan(h, "create_content", { section: 1, type: "choicegroup", name: "E", group_ids: [99] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "create_content", { section: 1, type: "h5pactivity", name: "H", file_path: txt }))).message).toMatch(/\.h5p/);
        expect((await errOf(plan(h, "create_content", { section: 1, type: "subsection", name: "S", intro: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
    });
});

describe("capítulos de libros (ADR-077)", () => {
    it("agregar (y subcapítulo después), editar, ocultar/mostrar, borrar con subcapítulos; deshacer de cada uno", async () => {
        const { h, acts } = await harness();
        const m = acts.add({ kind: "book", name: "Libro", intro: "", chapters: [{ id: 501, title: "Uno", sub: false, hidden: false, content: "<p>1</p>" }, { id: 502, title: "Dos", sub: false, hidden: false, content: "<p>2</p>" }] });
        const add = await run(h, "book_chapter", { course_module_id: m.id, operation: "add", title: "Uno y medio", content: "Medio", after_chapter_id: 501 });
        expect(add.status).toBe("aplicado_verificado");
        const id = add.moodle_ids.chapter_id![0]!;
        expect(m.chapters!.map((c) => c.title)).toEqual(["Uno", "Uno y medio", "Dos"]);
        const sub = await run(h, "book_chapter", { course_module_id: m.id, operation: "add", title: "Sub", content: "S", subchapter: true, after_chapter_id: id });
        expect(m.chapters!.map((c) => [c.title, c.sub])).toEqual([["Uno", false], ["Uno y medio", false], ["Sub", true], ["Dos", false]]);
        const ed = await run(h, "book_chapter", { course_module_id: m.id, operation: "edit", chapter_id: 501, title: "Uno bis", content: "**Nuevo**" });
        expect(ed.status).toBe("aplicado_verificado");
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect(m.chapters![0]).toMatchObject({ title: "Uno", content: "<p>1</p>" });
        const hide = await run(h, "book_chapter", { course_module_id: m.id, operation: "hide", chapter_id: 502 });
        expect(m.chapters!.at(-1)!.hidden).toBe(true);
        expect((await undo(h, hide.action_id)).status).toBe("aplicado_verificado");
        expect(m.chapters!.at(-1)!.hidden).toBe(false);
        const p = await plan(h, "book_chapter", { course_module_id: m.id, operation: "delete", chapter_id: id });
        expect(p.risk).toBe("R3");
        expect((p.payload_preview as { deletes: unknown[] }).deletes).toHaveLength(2);
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(m.chapters!.map((c) => c.title)).toEqual(["Uno", "Dos"]);
        expect(sub.status).toBe("aplicado_verificado");
        // Un capítulo sin subcapítulos borrado se recrea en el mismo lugar.
        const del = await run(h, "book_chapter", { course_module_id: m.id, operation: "delete", chapter_id: 502 });
        expect((await undo(h, del.action_id)).status).toBe("aplicado_verificado");
        expect(m.chapters!.map((c) => [c.title, c.content])).toEqual([["Uno", "<p>1</p>"], ["Dos", "<p>2</p>"]]);
    });

    it("rechazos: primer capítulo como subcapítulo, capítulo inexistente, sin cambios, ya oculto", async () => {
        const { h, acts } = await harness();
        const empty = acts.add({ kind: "book", name: "Vacío", intro: "", chapters: [] });
        expect((await errOf(plan(h, "book_chapter", { course_module_id: empty.id, operation: "add", title: "S", content: "x", subchapter: true }))).code).toBe("WRITE_NOT_ALLOWED");
        const m = acts.add({ kind: "book", name: "Libro", intro: "", chapters: [{ id: 501, title: "Uno", sub: false, hidden: true, content: "<p>1</p>" }] });
        expect((await errOf(plan(h, "book_chapter", { course_module_id: m.id, operation: "edit", chapter_id: 999, title: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "book_chapter", { course_module_id: m.id, operation: "edit", chapter_id: 501, title: "Uno" }))).message).toMatch(/ya está/);
        expect((await errOf(plan(h, "book_chapter", { course_module_id: m.id, operation: "hide", chapter_id: 501 }))).message).toMatch(/oculto/);
    });
});

describe("entradas de glosario, páginas de wiki y entradas de base de datos (ADR-077)", () => {
    it("glosario: agregar, editar, borrar (R3) y sus deshacer; concepto repetido rechazado", async () => {
        const { h, acts } = await harness();
        const g = acts.add({ kind: "glossary", name: "Glosario", intro: "", entries: [{ id: 801, concept: "Vida", definition: "<p>Eso</p>" }] });
        expect((await errOf(plan(h, "glossary_entry", { course_module_id: g.id, operation: "add", concept: "vida", definition: "x" }))).message).toMatch(/ya tiene/);
        const add = await run(h, "glossary_entry", { course_module_id: g.id, operation: "add", concept: "Término", definition: "Def **uno**" });
        expect(add.status).toBe("aplicado_verificado");
        const id = add.moodle_ids.entry_id![0]!;
        const ed = await run(h, "glossary_entry", { course_module_id: g.id, operation: "edit", entry_id: id, definition: "Def dos" });
        expect(ed.status).toBe("aplicado_verificado");
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect(g.entries!.find((e) => e.id === id)!.definition).toContain("<strong>uno</strong>");
        const p = await plan(h, "glossary_entry", { course_module_id: g.id, operation: "delete", entry_id: 801 });
        expect(p.risk).toBe("R3");
        const del = await exec(h, p.plan_id);
        expect(del.status).toBe("aplicado_verificado");
        expect((await undo(h, del.action_id)).status).toBe("aplicado_verificado");
        expect(g.entries!.map((e) => e.concept).sort()).toEqual(["Término", "Vida"]);
        expect((await undo(h, add.action_id)).status).toBe("aplicado_verificado");
        expect(g.entries!.map((e) => e.concept)).toEqual(["Vida"]);
    });

    it("wiki: agregar (sin subwiki todavía), editar (el HTML renderizado trae índice), borrar; la primera página no se borra; individual sin user_id rechazada", async () => {
        const { h, acts } = await harness();
        const w = acts.add({ kind: "wiki", name: "Wiki", intro: "", wiki: { mode: "collaborative", first: "Inicio", subwiki: null, pages: [] } });
        const first = await run(h, "wiki_page", { course_module_id: w.id, operation: "add", title: "Inicio", content: "Bienvenida" });
        expect(first.status).toBe("aplicado_verificado");
        const add = await run(h, "wiki_page", { course_module_id: w.id, operation: "add", title: "Tema 1", content: "Texto **uno**" });
        const id = add.moodle_ids.page_id![0]!;
        const ed = await run(h, "wiki_page", { course_module_id: w.id, operation: "edit", page_id: id, content: "Texto dos" });
        expect(ed.status).toBe("aplicado_verificado");
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect((await errOf(plan(h, "wiki_page", { course_module_id: w.id, operation: "delete", page_id: first.moodle_ids.page_id![0]! }))).message).toMatch(/primera página/);
        expect((await errOf(plan(h, "wiki_page", { course_module_id: w.id, operation: "add", title: "tema 1", content: "x" }))).message).toMatch(/ya tiene/);
        const del = await undo(h, add.action_id);
        expect(del.status).toBe("aplicado_verificado");
        expect(w.wiki!.pages.map((p) => p.title)).toEqual(["Inicio"]);
        const ind = acts.add({ kind: "wiki", name: "Individual", intro: "", wiki: { mode: "individual", first: "Inicio", subwiki: null, pages: [] } });
        expect((await errOf(plan(h, "wiki_page", { course_module_id: ind.id, operation: "add", title: "x", content: "y" }))).message).toMatch(/individual: indicá user_id/);
    });

    it("base de datos: valores por nombre de campo (texto, área de texto, menú); obligatorio faltante y opción inválida rechazados; editar y borrar con deshacer", async () => {
        const { h, acts } = await harness();
        const d = acts.add({ kind: "data", name: "DB", intro: "", fields: [{ id: 11, name: "Title", type: "text", required: true }, { id: 12, name: "Content", type: "textarea", required: false }, { id: 13, name: "Tipo", type: "menu", required: false, param1: "Libro\nArtículo" }, { id: 14, name: "Foto", type: "picture", required: false }], records: [] });
        expect((await errOf(plan(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Content: "x" } }))).message).toMatch(/obligatorios: Title/);
        expect((await errOf(plan(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Title: "t", Tipo: "Video" } }))).message).toMatch(/opciones/);
        expect((await errOf(plan(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Title: "t", Foto: "x" } }))).message).toMatch(/picture/);
        expect((await errOf(plan(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Nope: "t" } }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        const add = await run(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Title: "Uno", Content: "Texto **uno**", Tipo: "Libro" } });
        expect(add.status).toBe("aplicado_verificado");
        const id = add.moodle_ids.entry_id![0]!;
        expect(d.records![0]!.values).toMatchObject({ 11: "Uno", 13: "Libro" });
        const ed = await run(h, "data_entry", { course_module_id: d.id, operation: "edit", entry_id: id, values: { Content: "Texto dos", Title: "Uno" } });
        expect(ed.status).toBe("aplicado_verificado");
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect(d.records![0]!.values[12]).toContain("<strong>uno</strong>");
        const del = await undo(h, add.action_id);
        expect(del.status).toBe("aplicado_verificado");
        expect(d.records).toEqual([]);
    });
});

describe("campos de bases de datos (ADR-080)", () => {
    it("agregar (menú con opciones), editar, usarlo en una entrada, borrar (R3, cuenta entradas) y recrear; los deshacer", async () => {
        const { h, acts } = await harness();
        const d = acts.add({ kind: "data", name: "DB", intro: "", fields: [{ id: 11, name: "Title", type: "text", required: false }], records: [] });
        const add = await run(h, "data_field", { course_module_id: d.id, operation: "add", name: "Tipo", type: "menu", options: ["Libro", "Artículo"], description: "Fuente" });
        expect(add.status).toBe("aplicado_verificado");
        const fid = add.moodle_ids.field_id![0]!;
        expect(d.fields!.find((f) => f.id === fid)).toMatchObject({ type: "menu", param1: "Libro\nArtículo", description: "Fuente" });
        const ed = await run(h, "data_field", { course_module_id: d.id, operation: "edit", field_id: fid, options: ["Libro", "Artículo", "Video"], required: true });
        expect(ed.status).toBe("aplicado_verificado");
        expect((await run(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Title: "x", Tipo: "Video" } })).status).toBe("aplicado_verificado");
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect(d.fields!.find((f) => f.id === fid)).toMatchObject({ required: false, param1: "Libro\nArtículo" });
        const p = await plan(h, "data_field", { course_module_id: d.id, operation: "delete", field_id: fid });
        expect(p.risk).toBe("R3");
        expect(p.summary).toMatch(/1 entrada/);
        const del = await exec(h, p.plan_id);
        expect(del.status).toBe("aplicado_verificado");
        expect(d.records![0]!.values[fid]).toBeUndefined();
        const back = await undo(h, del.action_id);
        expect(back.status).toBe("aplicado_verificado");
        expect(d.fields!.map((f) => f.name)).toEqual(["Title", "Tipo"]);
        const ta = await run(h, "data_field", { course_module_id: d.id, operation: "add", name: "Notas", type: "textarea" });
        expect(acts.posts.at(-1)!.body).toMatchObject({ param2: "60", param3: "35", param4: "1", mode: "add" });
        expect((await undo(h, ta.action_id)).status).toBe("aplicado_verificado");
    });

    it("rechazos: nombre repetido, menú sin opciones, opciones en un tipo que no las lleva, cambiar el tipo, sin cambios; sin efecto → sin_efecto", async () => {
        const { h, acts } = await harness();
        const d = acts.add({ kind: "data", name: "DB", intro: "", fields: [{ id: 11, name: "Title", type: "text", required: false }], records: [] });
        expect((await errOf(plan(h, "data_field", { course_module_id: d.id, operation: "add", name: "title", type: "text" }))).message).toMatch(/ya tiene/);
        expect((await errOf(plan(h, "data_field", { course_module_id: d.id, operation: "add", name: "M", type: "menu" }))).message).toMatch(/options/);
        expect((await errOf(plan(h, "data_field", { course_module_id: d.id, operation: "add", name: "N", type: "number", options: ["a"] }))).message).toMatch(/no lleva/);
        expect((await errOf(plan(h, "data_field", { course_module_id: d.id, operation: "edit", field_id: 11, type: "number" }))).message).toMatch(/tipo/);
        expect((await errOf(plan(h, "data_field", { course_module_id: d.id, operation: "edit", field_id: 11, name: "Title" }))).message).toMatch(/ya está/);
        acts.noop = true;
        expect((await run(h, "data_field", { course_module_id: d.id, operation: "edit", field_id: 11, name: "Título" })).status).toBe("sin_efecto");
    });
});

describe("fechas de consultas, lecciones y bases de datos (ADR-080)", () => {
    it("habilitar, mover y deshabilitar; el límite de una lección; deshacer vuelve atrás; rechazos", async () => {
        const { h, acts } = await harness();
        const ch = acts.add({ kind: "choice", name: "Consulta", intro: "", options: [{ id: 1, text: "A", answers: 0 }], dates: { timeopen: 0, timeclose: 0 } });
        const r = await run(h, "edit_dates", { course_module_id: ch.id, open: "2026-11-02T08:00", close: "2026-11-20T23:59" });
        expect(r.status).toBe("aplicado_verificado");
        expect(ch.dates).toEqual({ timeopen: Date.UTC(2026, 10, 2, 11, 0) / 1000, timeclose: Date.UTC(2026, 10, 21, 2, 59) / 1000 });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(ch.dates).toEqual({ timeopen: 0, timeclose: 0 });
        const le = acts.add({ kind: "lesson", name: "Lección", intro: "", dates: { available: 0, deadline: Date.UTC(2026, 11, 1, 3, 0) / 1000, timelimit: 0 } });
        const l = await run(h, "edit_dates", { course_module_id: le.id, close: null, time_limit_minutes: 45 });
        expect(l.status).toBe("aplicado_verificado");
        expect(le.dates).toMatchObject({ deadline: 0, timelimit: 2700 });
        expect((await undo(h, l.action_id)).status).toBe("aplicado_verificado");
        expect(le.dates).toMatchObject({ deadline: Date.UTC(2026, 11, 1, 3, 0) / 1000, timelimit: 0 });
        const db = acts.add({ kind: "data", name: "DB", intro: "", fields: [], records: [], dates: { timeavailablefrom: 0, timeavailableto: 0 } });
        expect((await run(h, "edit_dates", { course_module_id: db.id, open: "2026-11-01T00:00" })).status).toBe("aplicado_verificado");
        expect((await errOf(plan(h, "edit_dates", { course_module_id: db.id, time_limit_minutes: 5 }))).message).toMatch(/no corresponde/);
        expect((await errOf(plan(h, "edit_dates", { course_module_id: ch.id, open: "2026-11-10T00:00", close: "2026-11-09T00:00" }))).message).toMatch(/posterior/);
        expect(acts.posts.filter((p) => p.path === "modedit").every((p) => !("coursecontentnotification" in p.body))).toBe(true);
    });
});

describe("páginas de lecciones (ADR-081)", () => {
    it("agregar contenido después de una página, editar (respuestas intactas), borrar (R3) y recrear; los deshacer", async () => {
        const { h, acts } = await harness();
        const le = acts.add({ kind: "lesson", name: "Lección", intro: "", dates: {}, lessonPages: [{ id: 61, title: "Pregunta", contents: "<p>¿2+2?</p>", qtype: 3, answers: ["4", "5"], form: { "answer_editor[0][text]": "4", "jumpto[0]": "-1", "score[0]": "1", "answer_editor[1][text]": "5", "jumpto[1]": "0", "score[1]": "0" } }, { id: 62, title: "Fin", contents: "<p>Chau</p>", qtype: 20, answers: ["Seguir"] }] });
        const add = await run(h, "lesson_page", { course_module_id: le.id, operation: "add", title: "Intro", content: "Leé **esto**", after_page_id: 61 });
        expect(add.status).toBe("aplicado_verificado");
        const id = add.moodle_ids.page_id![0]!;
        expect(le.lessonPages!.map((p) => p.title)).toEqual(["Pregunta", "Intro", "Fin"]);
        expect(acts.posts.at(-1)!.body).toMatchObject({ "answer_editor[0]": "Continuar", "jumpto[0]": "-1", qtype: "20" });
        const ed = await run(h, "lesson_page", { course_module_id: le.id, operation: "edit", page_id: 61, title: "Pregunta 1" });
        expect(ed.status).toBe("aplicado_verificado");
        expect(le.lessonPages![0]).toMatchObject({ title: "Pregunta 1", answers: ["4", "5"], contents: "<p>¿2+2?</p>" });
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect(le.lessonPages![0]!.title).toBe("Pregunta");
        const p = await plan(h, "lesson_page", { course_module_id: le.id, operation: "delete", page_id: id });
        expect(p.risk).toBe("R3");
        const del = await exec(h, p.plan_id);
        expect(del.status).toBe("aplicado_verificado");
        expect((await undo(h, del.action_id)).status).toBe("aplicado_verificado");
        expect(le.lessonPages!.map((x) => x.title)).toEqual(["Pregunta", "Intro", "Fin"]);
        const q = await run(h, "lesson_page", { course_module_id: le.id, operation: "delete", page_id: 61 });
        // ADR-092: una página de pregunta borrada se recrea con sus respuestas.
        expect((await undo(h, q.action_id)).status).toBe("aplicado_verificado");
        expect(le.lessonPages!.find((x) => x.title === "Pregunta")!.form).toMatchObject({ "answer_editor[0][text]": "4", "answer_editor[1][text]": "5" });
    });

    it("rechazos: página ajena, sin cambios, título vacío; lección vacía → primera página", async () => {
        const { h, acts } = await harness();
        const le = acts.add({ kind: "lesson", name: "Vacía", intro: "", dates: {}, lessonPages: [] });
        const first = await run(h, "lesson_page", { course_module_id: le.id, operation: "add", title: "Primera", content: "Hola" });
        expect(first.status).toBe("aplicado_verificado");
        expect(acts.posts.at(-1)!.body).toMatchObject({ pageid: "0" });
        expect((await errOf(plan(h, "lesson_page", { course_module_id: le.id, operation: "edit", page_id: 999, title: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "lesson_page", { course_module_id: le.id, operation: "edit", page_id: first.moodle_ids.page_id![0]!, title: "Primera" }))).message).toMatch(/ya está/);
    });
});

describe("valores de casillas, menú múltiple y fecha; límites por opción (ADR-083)", () => {
    it("entradas con casillas (varias opciones), menú múltiple y fecha; editar y deshacer", async () => {
        const { h, acts } = await harness();
        const d = acts.add({ kind: "data", name: "DB", intro: "", fields: [{ id: 21, name: "Temas", type: "checkbox", required: false, param1: "Álgebra\nCálculo\nLógica" }, { id: 22, name: "Fecha", type: "date", required: false }, { id: 23, name: "Niveles", type: "multimenu", required: false, param1: "Inicial\nMedio" }], records: [] });
        const add = await run(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Temas: "Álgebra\nLógica", Fecha: "2026-11-15", Niveles: "Medio" } });
        expect(add.status).toBe("aplicado_verificado");
        expect(d.records![0]!.values).toMatchObject({ 21: "Álgebra##Lógica", 22: String(Date.UTC(2026, 10, 15, 15, 0) / 1000), 23: "Medio" });
        const ed = await run(h, "data_entry", { course_module_id: d.id, operation: "edit", entry_id: add.moodle_ids.entry_id![0]!, values: { Fecha: "2026-12-01", Temas: "Cálculo" } });
        expect(ed.status).toBe("aplicado_verificado");
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect(d.records![0]!.values[21]).toBe("Álgebra##Lógica");
        expect((await errOf(plan(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Temas: "Física" } }))).message).toMatch(/opciones válidas/);
        expect((await errOf(plan(h, "data_entry", { course_module_id: d.id, operation: "add", values: { Fecha: "2026-02-30" } }))).message).toMatch(/AAAA-MM-DD/);
    });

    it("límites por opción con el texto final (también de una opción nueva); no menor que las respuestas; deshacer", async () => {
        const { h, acts } = await harness();
        const m = acts.add({ kind: "choice", name: "Consulta", intro: "", options: [{ id: 1, text: "A", answers: 3, limit: 0 }, { id: 2, text: "B", answers: 0, limit: 0 }] });
        const r = await run(h, "choice_options", { course_module_id: m.id, add: ["C"], limits: { A: 10, C: 4 } });
        expect(r.status).toBe("aplicado_verificado");
        expect(m.options!.map((o) => [o.text, o.limit])).toEqual([["A", 10], ["B", 0], ["C", 4]]);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(m.options!.map((o) => [o.text, o.limit])).toEqual([["A", 0], ["B", 0]]);
        expect((await errOf(plan(h, "choice_options", { course_module_id: m.id, limits: { A: 2 } }))).message).toMatch(/ya tiene 3/);
        expect((await errOf(plan(h, "choice_options", { course_module_id: m.id, limits: { B: 0 } }))).message).toMatch(/ya son los actuales/);
    });
});
