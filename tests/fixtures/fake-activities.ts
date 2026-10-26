/**
 * Actividades sintéticas CON ESTADO para ADR-077: descripción por modedit.php de cualquier tipo,
 * opciones de una consulta, archivos de carpetas y recursos (borrador servido por el formulario),
 * altas de más tipos, capítulos de libro (edit/delete/show.php), páginas de wiki, entradas de glosario
 * y de base de datos (servicios web). Datos inventados.
 */
import { COURSE, SITE, USER_ID, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";
import type { SyntheticW2 } from "./fake-w2.js";

type File = { filename: string; filesize: number };
interface Mod {
    id: number;
    kind: string;
    name: string;
    intro: string;
    instance: number;
    section: number;
    visible: boolean;
    files?: File[];
    options?: { id: number; text: string; answers: number; limit?: number }[];
    groups?: number[];
    /** Actividad LTI: herramienta, parámetros personalizados y nota (ADR-117). */
    lti?: { typeid: number; custom: string; grade: number; acceptgrades: boolean };
    /** Elección de grupo: cupos activados y cupo por grupo. */
    limitanswers?: boolean;
    limits?: Record<number, number>;
    chapters?: { id: number; title: string; sub: boolean; hidden: boolean; content: string }[];
    wiki?: { mode: string; first: string; subwiki: number | null; pages: { id: number; title: string; content: string }[]; subs?: { id: number | null; group: number; user: number; pages: { id: number; title: string; content: string }[] }[] };
    entries?: { id: number; concept: string; definition: string; approved?: boolean; aliases?: string[]; categories?: number[] }[];
    glossaryCategories?: { id: number; name: string }[];
    fields?: { id: number; name: string; type: string; required: boolean; param1?: string; description?: string }[];
    records?: { id: number; values: Record<number, string>; approved?: boolean }[];
    /** Fechas (unix; 0 = deshabilitada) y límite de tiempo en segundos, según el tipo. */
    dates?: Record<string, number>;
    /** Páginas de una lección, en orden (qtype 20 = contenido, 3 = opción múltiple). */
    lessonPages?: { id: number; title: string; contents: string; qtype: number; answers: string[]; form?: Record<string, string> }[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const exception = (errorcode: string) => ({ exception: "moodle_exception", errorcode, message: errorcode });

export class SyntheticActivities {
    readonly mods = new Map<number, Mod>();
    readonly drafts = new Map<number, File[]>();
    readonly posts: { path: string; body: Record<string, string> }[] = [];
    /** Moodle no guarda los cambios del formulario de edición (para probar sin_efecto). */
    noop = false;
    private seq = 7000;
    private draftSeq = 555_000;

    constructor(
        fake: FakeMoodle,
        private readonly w2: SyntheticW2,
    ) {
        // Borradores: upload.php (nuevo o dentro de uno existente) y borrar archivos de un borrador.
        fake.upload = (form) => {
            const files = [...form.entries()].filter(([k]) => k.startsWith("file_")).map(([, v]) => v as globalThis.File);
            const into = Number(form.get("itemid") ?? 0);
            const itemid = into > 0 ? into : this.draftSeq++;
            const d = this.drafts.get(itemid) ?? [];
            d.push(...files.map((f) => ({ filename: f.name, filesize: f.size })));
            this.drafts.set(itemid, d);
            return files.map((f) => ({ filename: f.name, filepath: "/", itemid, userid: USER_ID }));
        };
        const o = fake.overrides;
        o.set("core_files_delete_draft_files", (p) => {
            const d = this.drafts.get(Number(p.draftitemid)) ?? [];
            for (const [k, v] of Object.entries(p)) {
                if (!k.endsWith("[filename]")) continue;
                const i = d.findIndex((f) => f.filename === v);
                if (i >= 0) d.splice(i, 1);
            }
            return { parentpaths: [], warnings: [] };
        });
        const byKind = (kind: string) => [...this.mods.values()].filter((m) => m.kind === kind);
        /** options[i][name|value] de una llamada REST → { nombre: valor }. */
        const optionsOf = (p: Record<string, string>) => Object.fromEntries(Object.keys(p).filter((k) => /^options\[\d+\]\[name\]$/.test(k)).map((k) => [p[k]!, p[k.replace("[name]", "[value]")] ?? ""]));
        // Consultas.
        o.set("mod_choice_get_choice_options", (p) => {
            const m = byKind("choice").find((x) => x.instance === Number(p.choiceid));
            return m ? { options: m.options!.map((x) => ({ id: x.id, text: x.text, maxanswers: x.limit ?? 0, countanswers: x.answers })), warnings: [] } : exception("invalidrecord");
        });
        // Glosarios.
        o.set("mod_glossary_get_glossaries_by_courses", () => ({ glossaries: byKind("glossary").map((m) => ({ id: m.instance, coursemodule: m.id, course: COURSE, name: m.name, allowduplicatedentries: 0 })), warnings: [] }));
        const glossaryEntry = (id: number) => {
            for (const m of byKind("glossary")) {
                const e = m.entries!.find((x) => x.id === id);
                if (e) return { m, e };
            }
            return null;
        };
        o.set("mod_glossary_get_entry_by_id", (p) => {
            const f = glossaryEntry(Number(p.id));
            return f ? { entry: { id: f.e.id, glossaryid: f.m.instance, userid: USER_ID, concept: f.e.concept, definition: f.e.definition, approved: f.e.approved ?? true }, warnings: [] } : exception("invalidrecord");
        });
        o.set("mod_glossary_get_entries_by_letter", (p) => {
            const m = byKind("glossary").find((x) => x.instance === Number(p.id));
            return { count: m?.entries!.length ?? 0, entries: (m?.entries ?? []).map((e) => ({ id: e.id, glossaryid: m!.instance, concept: e.concept, definition: e.definition, approved: true })), warnings: [] };
        });
        o.set("mod_glossary_add_entry", (p) => {
            const m = byKind("glossary").find((x) => x.instance === Number(p.glossaryid));
            if (!m) return exception("invalidrecord");
            const id = this.seq++;
            const opt = optionsOf(p);
            m.entries!.push({ id, concept: String(p.concept), definition: String(p.definition), aliases: (opt.aliases ?? "").split("\n").filter(Boolean), categories: (opt.categories ?? "").split(",").filter(Boolean).map(Number) });
            return { entryid: id, warnings: [] };
        });
        o.set("mod_glossary_update_entry", (p) => {
            const f = glossaryEntry(Number(p.entryid));
            if (!f) return exception("invalidrecord");
            // Como Moodle: alias y categorías se BORRAN y se reescriben con lo recibido (ADR-102).
            const opt = optionsOf(p);
            if (!this.noop) Object.assign(f.e, { concept: String(p.concept), definition: String(p.definition), aliases: (opt.aliases ?? "").split("\n").filter(Boolean), categories: (opt.categories ?? "").split(",").filter(Boolean).map(Number) });
            return { result: true, warnings: [] };
        });
        o.set("mod_glossary_delete_entry", (p) => {
            const f = glossaryEntry(Number(p.entryid));
            if (!f) return exception("invalidrecord");
            f.m.entries!.splice(f.m.entries!.indexOf(f.e), 1);
            return { result: true, warnings: [] };
        });
        o.set("mod_glossary_get_categories", (p) => {
            const m = byKind("glossary").find((x) => x.instance === Number(p.id));
            const cats = m?.glossaryCategories ?? [];
            return { count: cats.length, categories: cats.map((c) => ({ id: c.id, glossaryid: m!.instance, name: c.name, usedynalink: false })), warnings: [] };
        });
        fake.web.pages.set("/mod/glossary/edit.php", (q) => {
            const f = glossaryEntry(Number(q.id));
            if (!f) return { body: "<html><body>no</body></html>" };
            const cats = (f.m.glossaryCategories ?? []).map((c) => `<option value="${c.id}"${f.e.categories?.includes(c.id) ? " selected" : ""}>${c.name}</option>`).join("");
            return { body: `<html><body><form method="post"><input type="hidden" name="usedynalink" value="0"><input type="hidden" name="id" value="${f.e.id}"><input type="hidden" name="_qf__mod_glossary_entry_form" value="1"><input type="text" name="concept" value="${esc(f.e.concept)}"><textarea name="aliases">${esc((f.e.aliases ?? []).join("\n"))}</textarea>${cats ? `<select name="categories[]" multiple>${cats}</select>` : ""}</form></body></html>` };
        });
        fake.web.pages.set("/mod/glossary/editcategories.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const m = this.mods.get(Number(b.get("id")));
            if (!m || req.method !== "POST" || b.get("sesskey") !== WEB_SESSKEY || b.get("confirm") !== "1") return { body: "<html><body>no</body></html>" };
            m.glossaryCategories ??= [];
            if (!this.noop) {
                if (b.get("action") === "add") m.glossaryCategories.push({ id: this.seq++, name: b.get("name") ?? "" });
                const c = m.glossaryCategories.find((x) => x.id === Number(b.get("hook")));
                if (b.get("action") === "edit" && c) c.name = b.get("name") ?? c.name;
                if (b.get("action") === "delete" && c) m.glossaryCategories.splice(m.glossaryCategories.indexOf(c), 1);
            }
            // Como Moodle: responde con la lista de categorías (200).
            return { body: `<html><body id="page-mod-glossary-editcategories">categorías</body></html>` };
        });
        fake.web.pages.set("/mod/glossary/approve.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const f = glossaryEntry(Number(q.eid));
            if (!f || req.method !== "POST" || b.get("sesskey") !== WEB_SESSKEY) return { body: "<html><body>no</body></html>" };
            if (!this.noop) f.e.approved = q.newstate === "1";
            return { status: 303, body: null, headers: { location: `${SITE}/mod/glossary/view.php?id=${f.m.id}&mode=approval` } };
        });
        // Wikis.
        o.set("mod_wiki_get_wikis_by_courses", () => ({ wikis: byKind("wiki").map((m) => ({ id: m.instance, coursemodule: m.id, course: COURSE, name: m.name, wikimode: m.wiki!.mode, firstpagetitle: m.wiki!.first })), warnings: [] }));
        // Subwikis: el único de una colaborativa sin grupos, o los de `subs` (por grupo o participante; id null = aún no creado).
        const subsOf = (m: Mod) => m.wiki!.subs ?? [{ get id() { return m.wiki!.subwiki; }, set id(v) { m.wiki!.subwiki = v; }, group: 0, user: 0, pages: m.wiki!.pages }];
        const allPages = () => byKind("wiki").flatMap((m) => subsOf(m).flatMap((s) => s.pages));
        o.set("mod_wiki_get_subwikis", (p) => {
            const m = byKind("wiki").find((x) => x.instance === Number(p.wikiid));
            return { subwikis: m ? subsOf(m).map((s) => ({ id: s.id ?? 0, wikiid: m.instance, groupid: String(s.group), userid: s.user, canedit: true })) : [], warnings: [] };
        });
        o.set("mod_wiki_get_subwiki_pages", (p) => {
            const m = byKind("wiki").find((x) => x.instance === Number(p.wikiid));
            const s = m ? subsOf(m).find((x) => x.group === Number(p.groupid ?? 0) && x.user === Number(p.userid ?? 0)) : undefined;
            // Moodle renderiza el HTML: un índice delante del contenido.
            return { pages: (s?.pages ?? []).map((x) => ({ id: x.id, subwikiid: s!.id ?? 0, title: x.title, cachedcontent: `<div class="toc">Índice</div>${x.content}`, firstpage: x.title === m!.wiki!.first, caneditpage: true })), warnings: [] };
        });
        o.set("mod_wiki_new_page", (p) => {
            let sub: ReturnType<typeof subsOf>[number] | undefined;
            for (const m of byKind("wiki")) sub ??= subsOf(m).find((s) => (p.subwikiid ? s.id === Number(p.subwikiid) : m.instance === Number(p.wikiid) && s.group === Number(p.groupid) && s.user === Number(p.userid)));
            if (!sub) return exception("invalidrecord");
            sub.id ??= this.seq++;
            const id = this.seq++;
            sub.pages.push({ id, title: String(p.title), content: String(p.content) });
            return { pageid: id, warnings: [] };
        });
        o.set("mod_wiki_edit_page", (p) => {
            const pg = allPages().find((x) => x.id === Number(p.pageid));
            if (!pg) return exception("invalidrecord");
            if (!this.noop) pg.content = String(p.content);
            return { pageid: pg.id, warnings: [] };
        });
        fake.web.pages.set("/mod/wiki/admin.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            if (req.method === "POST" && b.get("sesskey") === WEB_SESSKEY && q.option === "1") {
                for (const m of byKind("wiki")) {
                    m.wiki!.pages = m.wiki!.pages.filter((x) => x.id !== Number(q.delete));
                    for (const s of m.wiki!.subs ?? []) s.pages = s.pages.filter((x) => x.id !== Number(q.delete));
                }
                this.posts.push({ path: "wiki/admin", body: { ...q } });
            }
            return { body: `<html><body id="page-mod-wiki-admin">admin</body></html>` };
        });
        // Bases de datos.
        o.set("mod_data_get_databases_by_courses", () => ({ databases: byKind("data").map((m) => ({ id: m.instance, coursemodule: m.id, course: COURSE, name: m.name, ...(m.dates ?? {}) })), warnings: [] }));
        o.set("mod_choice_get_choices_by_courses", () => ({ choices: byKind("choice").map((m) => ({ id: m.instance, coursemodule: m.id, course: COURSE, name: m.name, ...(m.dates ?? {}) })), warnings: [] }));
        o.set("mod_h5pactivity_get_h5pactivities_by_courses", () => ({ h5pactivities: byKind("h5pactivity").map((m) => ({ id: m.instance, coursemodule: m.id, course: COURSE, name: m.name, package: (m.files ?? []).map((f) => ({ filename: f.filename, filepath: "/", filesize: f.filesize })) })), warnings: [] }));
        o.set("mod_lesson_get_lessons_by_courses", () => ({ lessons: byKind("lesson").map((m) => ({ id: m.instance, coursemodule: m.id, course: COURSE, name: m.name, ...(m.dates ?? {}) })), warnings: [] }));
        o.set("mod_data_get_fields", (p) => ({ fields: (byKind("data").find((x) => x.instance === Number(p.databaseid))?.fields ?? []).map((f) => ({ description: "", ...f, dataid: Number(p.databaseid) })), warnings: [] }));
        o.set("mod_data_get_entries", (p) => {
            const m = byKind("data").find((x) => x.instance === Number(p.databaseid));
            return { entries: [], totalcount: m?.records!.length ?? 0, warnings: [] };
        });
        const record = (id: number) => {
            for (const m of byKind("data")) {
                const r = m.records!.find((x) => x.id === id);
                if (r) return { m, r };
            }
            return null;
        };
        const values = (p: Record<string, string>) => {
            const out: Record<number, string> = {};
            const dates: Record<number, { day?: number; month?: number; year?: number }> = {};
            for (const [k, v] of Object.entries(p)) {
                const i = /^data\[(\d+)\]\[value\]$/.exec(k)?.[1];
                if (i === undefined) continue;
                const fid = Number(p[`data[${i}][fieldid]`]);
                const sub = p[`data[${i}][subfield]`] ?? "";
                const val = JSON.parse(v) as unknown;
                // Casillas y menú múltiple: un arreglo (Moodle lo guarda unido por «##»).
                if (sub === "") out[fid] = Array.isArray(val) ? val.join("##") : String(val);
                // Fecha: día, mes y año en subcampos; Moodle guarda el mediodía local (UTC-3 → 15:00 UTC).
                if (["day", "month", "year"].includes(sub)) (dates[fid] ??= {})[sub] = Number(val);
            }
            for (const [fid, d] of Object.entries(dates)) out[Number(fid)] = String(Date.UTC(d.year!, d.month! - 1, d.day!, 15, 0) / 1000);
            return out;
        };
        o.set("mod_data_get_entry", (p) => {
            const f = record(Number(p.entryid));
            return f ? { entry: { id: f.r.id, dataid: f.m.instance, userid: USER_ID, approved: f.r.approved ?? true, contents: Object.entries(f.r.values).map(([fieldid, content]) => ({ id: 1, fieldid: Number(fieldid), recordid: f.r.id, content })) }, warnings: [] } : exception("invalidrecord");
        });
        o.set("mod_data_add_entry", (p) => {
            const m = byKind("data").find((x) => x.instance === Number(p.databaseid));
            if (!m) return exception("invalidrecord");
            const v = values(p);
            const missing = m.fields!.filter((f) => f.required && !v[f.id]);
            if (missing.length) return { newentryid: 0, generalnotifications: [], fieldnotifications: missing.map((f) => ({ fieldname: f.name, notification: "Requerido" })), warnings: [] };
            const id = this.seq++;
            m.records!.push({ id, values: v });
            return { newentryid: id, generalnotifications: [], fieldnotifications: [], warnings: [] };
        });
        o.set("mod_data_update_entry", (p) => {
            const f = record(Number(p.entryid));
            if (!f) return exception("invalidrecord");
            if (!this.noop) Object.assign(f.r.values, values(p));
            return { updated: true, generalnotifications: [], fieldnotifications: [], warnings: [] };
        });
        o.set("mod_data_approve_entry", (p) => {
            const f = record(Number(p.entryid));
            if (!f) return exception("invalidrecord");
            if (!this.noop) f.r.approved = p.approve === "1";
            return { status: true, warnings: [] };
        });
        o.set("mod_data_delete_entry", (p) => {
            const f = record(Number(p.entryid));
            if (!f) return exception("invalidrecord");
            f.m.records!.splice(f.m.records!.indexOf(f.r), 1);
            return { result: true, warnings: [] };
        });

        // Campos de bases de datos: formulario simple, responde 200 con la lista de campos.
        fake.web.pages.set("/mod/data/field.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const page = { body: `<html><body id="page-mod-data-field-">campos</body></html>` };
            if (req.method !== "POST" || b.get("sesskey") !== WEB_SESSKEY) return page;
            const m = byKind("data").find((x) => x.instance === Number(b.get("d")));
            if (!m) return { body: `<html><body><div class="box errorbox alert alert-danger"><p class="errormessage">No existe</p></div></body></html>` };
            this.posts.push({ path: "data/field", body: Object.fromEntries(b) });
            const def = () => ({ name: b.get("name") ?? "", type: b.get("type") ?? "text", required: b.get("required") === "1", description: b.get("description") ?? "", ...(b.has("param1") ? { param1: b.get("param1")! } : {}) });
            if (this.noop) return page;
            if (b.get("mode") === "add" && !m.fields!.some((f) => f.name === b.get("name"))) m.fields!.push({ id: this.seq++, ...def() });
            if (b.get("mode") === "update") Object.assign(m.fields!.find((f) => f.id === Number(b.get("fid")))!, def());
            if (b.get("mode") === "delete" && b.get("confirm") === "1") {
                const fid = Number(b.get("fid"));
                m.fields = m.fields!.filter((f) => f.id !== fid);
                for (const r of m.records!) delete r.values[fid];
            }
            return page;
        });

        // Páginas de lecciones.
        o.set("mod_lesson_get_pages", (q) => {
            const m = byKind("lesson").find((x) => x.instance === Number(q.lessonid));
            const ps = m?.lessonPages ?? [];
            return { pages: ps.map((pg, i) => ({ page: { id: pg.id, prevpageid: ps[i - 1]?.id ?? 0, nextpageid: ps[i + 1]?.id ?? 0, title: pg.title, contents: `<div class="no-overflow">${pg.contents}</div>`, contentsformat: 1, qtype: pg.qtype, typestring: ({ 20: "Contenido", 3: "Opción múltiple", 2: "Verdadero/Falso", 1: "Respuesta corta", 8: "Numérica", 10: "Ensayo", 5: "Emparejamiento" } as Record<number, string>)[pg.qtype] ?? "?" }, answerids: pg.answers.map((_, j) => j + 1), jumps: pg.answers.map(() => -1) })), warnings: [] };
        });
        fake.web.pages.set("/mod/lesson/editpage.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const m = this.mods.get(Number(q.id ?? b.get("id")));
            if (!m?.lessonPages) return { body: "<html><body>no</body></html>" };
            const forms: Record<number, string> = { 20: "branchtable", 3: "multichoice", 2: "truefalse", 1: "shortanswer", 8: "numerical", 10: "essay", 5: "matching" };
            if (req.method === "GET") {
                const pg = q.edit === "1" ? m.lessonPages.find((x) => x.id === Number(q.pageid)) : undefined;
                const qtype = pg?.qtype ?? Number(q.qtype);
                const qf = `_qf__lesson_add_page_form_${forms[qtype]}`;
                // Páginas de pregunta: el formulario real de cada tipo (4 respuestas por página, como el sandbox).
                const f = pg?.form ?? {};
                const v = (k: string, d = "") => esc(f[k] ?? d);
                const jump = (i: number) => `<select name="jumpto[${i}]">${[...new Set(["0", "-1", "-40", "-9", ...m.lessonPages!.map((x) => String(x.id)), f[`jumpto[${i}]`] ?? (i ? "0" : "-1")])].map((o) => `<option value="${o}"${o === (f[`jumpto[${i}]`] ?? (i ? "0" : "-1")) ? " selected" : ""}>${o}</option>`).join("")}</select><input type="text" name="score[${i}]" value="${v(`score[${i}]`, i ? "0" : "1")}">`;
                const editor = (name: string) => `<textarea name="${name}[text]">${v(`${name}[text]`)}</textarea><input type="hidden" name="${name}[format]" value="1">`;
                const opt = qtype === 3 || qtype === 1 ? `<input type="checkbox" name="qoption" value="1"${f.qoption === "1" ? " checked" : ""}>` : "";
                let answers: string;
                if (qtype === 2 || qtype === 3) answers = Array.from({ length: qtype === 2 ? 2 : 4 }, (_, i) => editor(`answer_editor[${i}]`) + editor(`response_editor[${i}]`) + jump(i)).join("");
                else if (qtype === 1 || qtype === 8) answers = Array.from({ length: 4 }, (_, i) => `<input type="text" name="answer_editor[${i}]" value="${v(`answer_editor[${i}]`)}">` + editor(`response_editor[${i}]`) + jump(i)).join("");
                else if (qtype === 10) answers = jump(0);
                else if (qtype === 5) answers = [0, 1].map((i) => editor(`answer_editor[${i}]`) + jump(i)).join("") + [2, 3, 4, 5].map((i) => editor(`answer_editor[${i}]`) + `<input type="text" name="response_editor[${i}]" value="${v(`response_editor[${i}]`)}">`).join("");
                else answers = (pg?.answers ?? [""]).map((a, i) => `<input type="text" name="answer_editor[${i}]" value="${esc(a)}"><input type="hidden" name="jumpto[${i}]" value="-1">`).join("");
                answers = opt + answers;
                return { body: `<html><body><form action="${SITE}/mod/lesson/editpage.php" method="post"><input type="hidden" name="id" value="${m.id}"><input type="hidden" name="pageid" value="${q.pageid}"><input type="hidden" name="qtype" value="${pg?.qtype ?? q.qtype}">${q.edit ? '<input type="hidden" name="edit" value="1">' : ""}<input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="${qf}" value="1"><input type="text" name="title" value="${esc(pg?.title ?? "")}"><textarea name="contents_editor[text]">${esc(pg?.contents ?? "")}</textarea><input type="hidden" name="contents_editor[format]" value="1">${answers}<input type="submit" name="submitbutton" value="Guardar"></form></body></html>` };
            }
            if (b.get("sesskey") !== WEB_SESSKEY) return { body: "<html><body>sesskey</body></html>" };
            this.posts.push({ path: "lesson/editpage", body: Object.fromEntries(b) });
            const back = { status: 303, body: null, headers: { location: `${SITE}/mod/lesson/edit.php?id=${m.id}` } };
            if (this.noop) return back;
            const qform = () => ({ ...Object.fromEntries([...b].filter(([k]) => /^(answer_editor|response_editor|jumpto|score)\[/.test(k) && !/\[(format|itemid)\]$/.test(k))), qoption: b.get("qoption") ?? "0" });
            if (b.get("edit") === "1") {
                const pg = m.lessonPages.find((x) => x.id === Number(b.get("pageid")))!;
                Object.assign(pg, { title: b.get("title") ?? pg.title, contents: b.get("contents_editor[text]") ?? pg.contents, answers: pg.answers.map((a, i) => b.get(`answer_editor[${i}]`) ?? a) });
                if (pg.qtype !== 20) pg.form = { ...pg.form, ...qform() };
                return back;
            }
            const after = m.lessonPages.findIndex((x) => x.id === Number(b.get("pageid")));
            const qtype = Number(b.get("qtype") ?? q.qtype ?? 20);
            m.lessonPages.splice(after + 1, 0, { id: this.seq++, title: b.get("title") ?? "", contents: b.get("contents_editor[text]") ?? "", qtype, answers: [b.get("answer_editor[0]") ?? ""], ...(qtype !== 20 ? { form: qform() } : {}) });
            return back;
        });
        fake.web.pages.set("/mod/lesson/lesson.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const m = this.mods.get(Number(q.id));
            if (!m?.lessonPages || b.get("sesskey") !== WEB_SESSKEY || q.action !== "delete") return { body: "<html><body>no</body></html>" };
            m.lessonPages = m.lessonPages.filter((x) => x.id !== Number(q.pageid));
            return { status: 303, body: null, headers: { location: `${SITE}/mod/lesson/edit.php?id=${m.id}` } };
        });

        // Formularios de actividades.
        const modedit = fake.web.pages.get("/course/modedit.php")!;
        fake.web.pages.set("/course/modedit.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const updating = this.mods.get(Number(q.update ?? b.get("update") ?? 0));
            const adding = req.method === "GET" ? q.add : b.get("add");
            const kind = updating?.kind ?? adding;
            const known = ["folder", "resource", "book", "wiki", "glossary", "data", "lesson", "lti", "hvp", "choicegroup", "choice", "questionnaire", "h5pactivity", "attendance", "subjectattendance", "subsection"];
            if (!kind || !known.includes(kind) || (!updating && !adding) || (adding && !["folder", "book", "wiki", "glossary", "choice", "data", "lesson", "questionnaire", "choicegroup", "h5pactivity", "subsection", "lti"].includes(adding))) return modedit(q, req);
            const qf = `_qf__mod_${kind}_mod_form`;
            if (req.method === "GET") return { body: this.form(kind, qf, updating ?? null, q) };
            if (b.get("sesskey") !== WEB_SESSKEY || b.get(qf) !== "1") return { body: "<html><body>nope</body></html>" };
            this.posts.push({ path: "modedit", body: Object.fromEntries(b) });
            if (updating) {
                if (!this.noop) this.apply(updating, b);
                return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
            }
            const m: Mod = { id: this.seq++, kind, name: b.get("name") ?? "", intro: b.get("introeditor[text]") ?? "", instance: this.seq++, section: Number(b.get("section")), visible: b.get("visible") === "1" };
            if (kind === "folder" || kind === "h5pactivity") m.files = [...(this.drafts.get(Number(b.get(kind === "folder" ? "files" : "packagefile"))) ?? [])];
            if (kind === "choice") m.options = [];
            if (kind === "wiki") m.wiki = { mode: b.get("wikimode") ?? "collaborative", first: b.get("firstpagetitle") ?? "", subwiki: null, pages: [] };
            if (kind === "glossary") m.entries = [];
            if (kind === "data") Object.assign(m, { fields: [], records: [] });
            if (kind === "book") m.chapters = [];
            if (kind === "lti") m.lti = { typeid: Number(b.get("typeid")), custom: b.get("instructorcustomparameters") ?? "", grade: Number(b.get("grade[modgrade_point]")), acceptgrades: b.get("instructorchoiceacceptgrades") === "1" };
            this.apply(m, b, true);
            this.register(m);
            return { status: 303, body: null, headers: { location: kind === "subsection" ? `${SITE}/course/view.php?id=${COURSE}` : `${SITE}/mod/${kind}/view.php?id=${m.id}` } };
        });

        // Capítulos de libros.
        fake.web.pages.set("/mod/book/edit.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const m = this.mods.get(Number(q.cmid ?? b.get("cmid")));
            if (!m?.chapters) return { body: "<html><body>no</body></html>" };
            if (req.method === "GET") {
                const ch = q.id ? m.chapters.find((c) => c.id === Number(q.id)) : undefined;
                return {
                    body: `<html><body><form action="${SITE}/mod/book/edit.php" method="post"><input type="hidden" name="id" value="${ch?.id ?? ""}"><input type="hidden" name="cmid" value="${m.id}"><input type="hidden" name="pagenum" value="${ch ? m.chapters.indexOf(ch) + 1 : Number(q.pagenum) + 1}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__book_chapter_edit_form" value="1"><input type="text" name="title" value="${esc(ch?.title ?? "")}"><input type="checkbox" name="subchapter" value="1"${ch?.sub || q.subchapter === "1" ? " checked" : ""}><textarea name="content_editor[text]">${esc(ch?.content ?? "")}</textarea><input type="hidden" name="content_editor[format]" value="1"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>`,
                };
            }
            if (b.get("sesskey") !== WEB_SESSKEY) return { body: "<html><body>sesskey</body></html>" };
            this.posts.push({ path: "book/edit", body: Object.fromEntries(b) });
            const id = Number(b.get("id") || 0);
            if (id) {
                const ch = m.chapters.find((c) => c.id === id)!;
                if (!this.noop) Object.assign(ch, { title: b.get("title") ?? ch.title, sub: b.get("subchapter") === "1", content: b.get("content_editor[text]") ?? ch.content });
                this.syncBook(m);
                return { status: 303, body: null, headers: { location: `${SITE}/mod/book/view.php?id=${m.id}&chapterid=${id}` } };
            }
            const nid = this.seq++;
            m.chapters.splice(Number(b.get("pagenum")) - 1, 0, { id: nid, title: b.get("title") ?? "", sub: b.get("subchapter") === "1", hidden: false, content: b.get("content_editor[text]") ?? "" });
            this.syncBook(m);
            return { status: 303, body: null, headers: { location: `${SITE}/mod/book/view.php?id=${m.id}&chapterid=${nid}` } };
        });
        fake.web.pages.set("/mod/book/delete.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const m = this.mods.get(Number(q.id));
            if (!m?.chapters || b.get("sesskey") !== WEB_SESSKEY || b.get("confirm") !== "1") return { body: "<html><body>no</body></html>" };
            const i = m.chapters.findIndex((c) => c.id === Number(q.chapterid));
            let n = 1;
            if (!m.chapters[i]!.sub) while (m.chapters[i + n]?.sub) n++;
            m.chapters.splice(i, n);
            this.syncBook(m);
            return { status: 303, body: null, headers: { location: `${SITE}/mod/book/view.php?id=${m.id}` } };
        });
        fake.web.pages.set("/mod/book/move.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const m = this.mods.get(Number(q.id));
            const i = m?.chapters?.findIndex((c) => c.id === Number(q.chapterid)) ?? -1;
            if (!m?.chapters || i < 0 || b.get("sesskey") !== WEB_SESSKEY) return { body: "<html><body>no</body></html>" };
            const j = q.up === "1" ? i - 1 : i + 1;
            if (!this.noop && j >= 0 && j < m.chapters.length) [m.chapters[i], m.chapters[j]] = [m.chapters[j]!, m.chapters[i]!];
            this.syncBook(m);
            return { status: 303, body: null, headers: { location: `${SITE}/mod/book/view.php?id=${m.id}` } };
        });
        fake.web.pages.set("/mod/book/show.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const m = this.mods.get(Number(q.id));
            const ch = m?.chapters?.find((c) => c.id === Number(q.chapterid));
            if (!ch || b.get("sesskey") !== WEB_SESSKEY) return { body: "<html><body>no</body></html>" };
            ch.hidden = !ch.hidden;
            this.syncBook(m!);
            return { status: 303, body: null, headers: { location: `${SITE}/mod/book/view.php?id=${m!.id}` } };
        });
    }

    /** Agrega una actividad existente (como las del sandbox). */
    add(m: Omit<Mod, "id" | "instance" | "section" | "visible"> & Partial<Pick<Mod, "id" | "instance" | "section">>): Mod {
        const mod: Mod = { id: m.id ?? this.seq++, instance: m.instance ?? this.seq++, section: m.section ?? 1, visible: true, ...m };
        this.register(mod);
        return mod;
    }

    private register(m: Mod) {
        this.mods.set(m.id, m);
        this.w2.extraModules.push({ id: m.id, modname: m.kind, name: m.name, section: m.section, visible: m.visible, instance: m.instance, contents: [] });
        this.syncFiles(m);
        if (m.chapters) this.syncBook(m);
    }

    private entry(m: Mod) {
        return this.w2.extraModules.find((x) => x.id === m.id)!;
    }

    private syncFiles(m: Mod) {
        // Como Moodle: la estructura del curso no trae el paquete de una actividad H5P.
        if (m.files && m.kind !== "h5pactivity") this.entry(m).contents = m.files.map((f) => ({ type: "file", filename: f.filename, filepath: "/", filesize: f.filesize }));
    }

    private syncBook(m: Mod) {
        const structure: { title: string; href: string; level: number; hidden: string; subitems: unknown[] }[] = [];
        for (const c of m.chapters!) {
            const item = { title: c.title, href: `${c.id}/index.html`, level: c.sub ? 1 : 0, hidden: c.hidden ? "1" : "0", subitems: [] as unknown[] };
            if (c.sub && structure.length) structure[structure.length - 1]!.subitems.push(item);
            else structure.push(item);
        }
        this.entry(m).contents = [{ type: "content", filename: "structure", filepath: "/", filesize: 0, content: JSON.stringify(structure) }, ...m.chapters!.map((c) => ({ type: "file", filename: "index.html", filepath: `/${c.id}/`, filesize: 0, content: c.title }))];
    }

    private apply(m: Mod, b: URLSearchParams, creating = false) {
        if (b.has("introeditor[text]")) m.intro = b.get("introeditor[text]")!;
        // Selectores de fecha: sin la casilla, la fecha queda deshabilitada (como en Moodle). Hora local UTC-3.
        if (m.dates) {
            for (const k of Object.keys(m.dates)) {
                if (k === "timelimit") {
                    if (b.has("timelimit[number]") || !b.has("timelimit[enabled]")) m.dates.timelimit = b.get("timelimit[enabled]") === "1" ? Number(b.get("timelimit[number]")) * 60 : 0;
                    continue;
                }
                const on = b.get(`${k}[enabled]`) === "1";
                const n = (f: string) => Number(b.get(`${k}[${f}]`));
                m.dates[k] = on ? Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") + 3, n("minute")) / 1000 : 0;
            }
        }
        if (m.kind === "choice") {
            const repeats = Number(b.get("option_repeats") ?? 0);
            for (let i = 0; i < repeats; i++) {
                const text = (b.get(`option[${i}]`) ?? "").trim();
                const id = Number(b.get(`optionid[${i}]`) ?? 0);
                const o = m.options!.find((x) => x.id === id);
                const limit = b.get(`limit[${i}]`);
                if (o && text) Object.assign(o, { text, ...(limit !== null ? { limit: Number(limit) } : {}) });
                else if (o) m.options!.splice(m.options!.indexOf(o), 1);
                else if (text) m.options!.push({ id: this.seq++, text, answers: 0, limit: Number(limit ?? 0) });
            }
            m.options!.sort((a, c) => a.id - c.id);
        }
        if (m.kind === "choicegroup" && b.has("serializedselectedgroups")) {
            m.groups = b.get("serializedselectedgroups")!.split(";").filter(Boolean).map(Number);
            m.limitanswers = b.get("limitanswers") === "1";
            m.limits = Object.fromEntries(m.groups.map((g) => [g, Number(b.get(`group_${g}_limit`) || 0)]));
        }
        if ((m.kind === "folder" || m.kind === "resource") && !creating && b.has("files")) {
            m.files = [...(this.drafts.get(Number(b.get("files"))) ?? [])];
            this.syncFiles(m);
        }
        if (m.kind === "h5pactivity" && !creating && b.has("packagefile")) m.files = [...(this.drafts.get(Number(b.get("packagefile"))) ?? [])];
    }

    /** Formulario de alta o edición con los valores actuales (como lo serviría Moodle). */
    private form(kind: string, qf: string, m: Mod | null, q: Record<string, string>) {
        const draft = (files: File[]) => {
            const id = this.draftSeq++;
            this.drafts.set(id, files.map((f) => ({ ...f })));
            return id;
        };
        let extra = "";
        if (kind === "choice") {
            const opts = m?.options ?? [];
            const repeats = m ? opts.length + 2 : 5;
            extra += `<input type="hidden" name="option_repeats" value="${repeats}">`;
            for (let i = 0; i < repeats; i++) extra += `<input type="hidden" name="optionid[${i}]" value="${opts[i]?.id ?? 0}"><input type="text" name="option[${i}]" value="${esc(opts[i]?.text ?? "")}"><input type="text" name="limit[${i}]" value="0">`;
        }
        if (kind === "folder" || kind === "resource") extra += `<input type="hidden" name="files" value="${draft(m?.files ?? [])}">`;
        if (kind === "h5pactivity") extra += `<input type="hidden" name="packagefile" value="${draft(m?.files ?? [])}">`;
        if (kind === "wiki") extra += `<select name="wikimode"><option value="collaborative" selected>c</option><option value="individual">i</option></select><input type="text" name="firstpagetitle" value="${esc(m?.wiki?.first ?? "")}">`;
        if (kind === "glossary") extra += `<select name="mainglossary"><option value="0" selected>no</option><option value="1">sí</option></select>`;
        if (kind === "questionnaire") extra += `<input type="radio" name="create" value="new-0" checked><input type="radio" name="create" value="private-1">`;
        if (kind === "choicegroup") {
            extra += `<input type="hidden" name="serializedselectedgroups" value="${(m?.groups ?? []).map((g) => `;${g}`).join("")}">`;
            extra += `<select name="limitanswers"><option value="0"${m?.limitanswers ? "" : " selected"}>no</option><option value="1"${m?.limitanswers ? " selected" : ""}>sí</option></select>`;
            // Como Moodle: un campo de cupo por grupo del curso (vacío si nunca se fijó).
            for (const g of new Set([...(m?.groups ?? []), 12, 13])) extra += `<input type="text" name="group_${g}_limit" value="${m?.limits?.[g] ?? ""}">`;
        }
        if (kind === "lti") extra += `<input type="hidden" name="typeid" value="${q.typeid ?? ""}"><textarea name="instructorcustomparameters"></textarea><input type="hidden" name="instructorchoiceacceptgrades" value="0"><select name="grade[modgrade_type]"><option value="none" selected>n</option><option value="point">p</option></select><input type="text" name="grade[modgrade_point]" value="100">`;
        if (kind === "hvp") extra += `<input type="hidden" name="h5pparams" value="{&quot;params&quot;:{}}">`;
        if (m?.dates) {
            for (const [k, v] of Object.entries(m.dates)) {
                if (k === "timelimit") {
                    extra += `<input type="checkbox" name="timelimit[enabled]" value="1"${v ? " checked" : ""}><input type="text" name="timelimit[number]" value="${Math.round(v / 60)}"><input type="hidden" name="timelimit[timeunit]" value="60">`;
                    continue;
                }
                const d = new Date((v || 1_800_000_000) * 1000 - 3 * 3600_000);
                extra += `<input type="checkbox" name="${k}[enabled]" value="1"${v ? " checked" : ""}>` + [["day", d.getUTCDate()], ["month", d.getUTCMonth() + 1], ["year", d.getUTCFullYear()], ["hour", d.getUTCHours()], ["minute", d.getUTCMinutes()]].map(([f, x]) => `<input type="hidden" name="${k}[${f}]" value="${x}">`).join("");
            }
        }
        const intro = kind === "subsection" ? "" : `<textarea name="introeditor[text]">${esc(m?.intro ?? "")}</textarea><input type="hidden" name="introeditor[format]" value="1">`;
        const where = m ? `<input type="hidden" name="update" value="${m.id}">` : `<input type="hidden" name="add" value="${kind}"><input type="hidden" name="course" value="${q.course}"><input type="hidden" name="section" value="${q.section}">`;
        return `<html><body><form action="${SITE}/course/modedit.php" method="post">${where}<input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="${qf}" value="1"><input type="text" name="name" value="${esc(m?.name ?? "")}">${intro}${extra}<select name="visible"><option value="1" selected>1</option><option value="0">0</option></select><input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton" value="Guardar y mostrar"><input type="submit" name="submitbutton2" value="Guardar"></form></body></html>`;
    }
}
