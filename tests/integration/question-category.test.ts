import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseQuestionXml } from "../../src/domain/question-xml.js";
import { assertWebRoute } from "../../src/web/policy.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { COURSE, SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";
import { BANK_CMID, CATEGORY, CATEGORY_EXPORT_PATH, mountQuestionBank, mountRandomRule, Q_CODERUNNER, Q_HIDDEN, Q_MULTI, Q_TF_SAME_TITLE, XML_CATEGORY } from "../fixtures/questions.js";

const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
const web = () => new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" });
const base = { course_id: COURSE, bank_course_module_id: BANK_CMID, category_id: CATEGORY };

/** Presupuesto de texto como el del perfil real (30 000); el sintético por defecto es 3000. */
async function setup(maxTextChars = 30_000) {
    const limits = { http_timeout_seconds: 5, max_concurrent_requests: 2, max_pages_per_request: 10, max_file_bytes: 2048, max_text_chars_per_result: maxTextChars };
    const h = await makeHarness({ webSource: web(), profile: { limits } });
    mountQuestionBank(h.fake.web);
    return h;
}
async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("exportación por categoría (§7.3)", () => {
    it("regla con subcategorías: exporta todo, reconcilia con el inventario y declara lo que no coincide", async () => {
        const h = await setup();
        const r = await h.app.service.getQuestionCategory(base);
        expect(r.data.scope).toEqual({ requested: "categoria_y_subcategorias", delivered: "categoria_y_subcategorias", category_path: null });
        expect(r.data.questions.map((q) => [q.name, q.type, q.inventory_question_id, q.inventory_match])).toEqual([
            ["Suma", "multichoice", Q_MULTI, "unico"],
            ["Doble", "coderunner", Q_CODERUNNER, "unico"],
            ["Borrador nuevo", "essay", null, "sin_candidato"],
            ["Suma", "truefalse", Q_TF_SAME_TITLE, "unico"],
        ]);
        expect(r.data.questions[3]!.category_path).toBe("$module$/top/Por defecto en Banco/Unidad 2/Sub");
        expect(r.data.reconciliation).toEqual({
            inventory_candidates: 4,
            inventory_read: 4,
            exported_in_scope: 4,
            matched_unique: 3,
            ambiguous: 0,
            exported_without_candidate: 1,
            candidates_not_exported: 1,
            candidates_not_exported_ids: [Q_HIDDEN],
        });
        expect(r.coverage.detail!.omitted![1]).toMatchObject({ count: 1 });
        expect(r.source).toMatchObject({ adapter: "web_export", operation: "question_export_category" });
        // Una sola exportación, con contexto y categoría verificados en la ruta y sin sesskey.
        const exp = h.fake.web.requests.filter((x) => x.path.startsWith("/pluginfile.php"));
        expect(exp).toHaveLength(1);
        expect(exp[0]!.path).toBe(CATEGORY_EXPORT_PATH);
        expect(exp[0]!.query).toEqual({ forcedownload: "1" });
        // Nada de base64 en el JSON; los adjuntos sólo tienen ref para preguntas con candidato único.
        expect(JSON.stringify(r)).not.toMatch(/iVBOR/);
        const file = r.data.questions[0]!.files[0]!;
        expect(file).toMatchObject({ name: "diagrama.png", location: "questiontext" });
        const img = await h.app.service.readFile({ file_ref: file.ref! });
        expect(img.data.modality).toBe("image");
    });

    it("regla sin subcategorías: aísla la categoría por la ruta que identifica el inventario", async () => {
        const h = await setup();
        mountRandomRule(h.fake.web, false);
        const r = await h.app.service.getQuestionCategory(base);
        expect(r.data.scope).toEqual({ requested: "solo_categoria", delivered: "solo_categoria", category_path: "$module$/top/Por defecto en Banco/Unidad 2" });
        expect(r.data.questions.map((q) => q.name)).toEqual(["Suma", "Doble", "Borrador nuevo"]);
        expect(r.coverage.complete).toBe(true);
    });

    it("si no se puede aislar la categoría, falla cerrado: no entrega subcategorías que la regla no autoriza", async () => {
        const h = await setup();
        mountRandomRule(h.fake.web, false);
        h.fake.web.ajax.set("core_question_get_random_question_summaries", () => ({ totalcount: 0, questions: [] }));
        const e = await h.app.service.getQuestionCategory(base).catch((x) => x);
        expect(e).toBeInstanceOf(CampusError);
        expect(e.code).toBe("POLICY_DENIED");
        expect(e.message).toMatch(/no se pudo aislar/);
        expect(JSON.stringify(e)).not.toMatch(/Sub/);
    });

    it("tipos que qformat_xml renombra (matching, cloze) se normalizan al qtype del inventario", () => {
        const xml = `<?xml version="1.0"?><quiz><question type="matching"><name><text>Pares</text></name><questiontext format="html"><text>Uní</text></questiontext><shuffleanswers>1</shuffleanswers><subquestion format="html"><text>A</text><answer><text>1</text></answer></subquestion></question><question type="cloze"><name><text>Huecos</text></name><questiontext format="html"><text>{1:SA:=x}</text></questiontext></question></quiz>`;
        const qs = parseQuestionXml(xml).questions.map((q) => q.question);
        expect(qs.map((q) => q.type)).toEqual(["match", "multianswer"]);
        expect(qs[0]!.interpretation).not.toBe("opaca");
    });

    it("la página respeta el presupuesto de texto del perfil (al menos una pregunta) y sigue con el cursor", async () => {
        const h = await setup(1000);
        const p1 = await h.app.service.getQuestionCategory({ ...base, limit: 50 });
        const n = p1.data.questions.length;
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThan(4);
        expect(p1.coverage.truncation_reason).toMatch(/caracteres por resultado/);
        const p2 = await h.app.service.getQuestionCategory({ ...base, limit: 50, cursor: p1.coverage.next_cursor! });
        expect(p2.data.questions[0]!.position).toBe(n + 1);
    });

    it("paginación con cursor propio; un cursor de otra lectura no sirve", async () => {
        const h = await setup();
        const p1 = await h.app.service.getQuestionCategory({ ...base, limit: 3 });
        expect(p1.data.questions.map((q) => q.position)).toEqual([1, 2, 3]);
        const p2 = await h.app.service.getQuestionCategory({ ...base, limit: 3, cursor: p1.coverage.next_cursor! });
        expect(p2.data.questions.map((q) => q.position)).toEqual([4]);
        const inv = await h.app.service.listQuestions({ ...base, limit: 3 });
        expect(await codeOf(h.app.service.getQuestionCategory({ ...base, limit: 3, cursor: inv.coverage.next_cursor! }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("errores explícitos: página de error, HTML sin XML, categoría no justificada", async () => {
        const h = await setup();
        h.fake.web.pages.set(CATEGORY_EXPORT_PATH, () => ({ body: '<html><body><div class="box errorbox alert alert-danger">No hay preguntas para exportar</div></body></html>' }));
        const e = await h.app.service.getQuestionCategory(base).catch((x) => x as CampusError);
        expect(e.code).toBe("MOODLE_PERMISSION_DENIED");
        expect(e.message).toMatch(/exportación de la categoría/);
        h.fake.web.pages.set(CATEGORY_EXPORT_PATH, () => ({ body: "esto no es XML", contentType: "application/xml" }));
        expect(await codeOf(h.app.service.getQuestionCategory(base))).toBe("UNEXPECTED_RESPONSE");
        expect(await codeOf(h.app.service.getQuestionCategory({ ...base, category_id: 999 }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("política: contexto y categoría sólo como enteros; sin otros parámetros", () => {
        expect(() => assertWebRoute("question_export_category", { contextid: "7001", categoryid: "333", forcedownload: "1" })).not.toThrow();
        expect(() => assertWebRoute("question_export_category", { contextid: "7001/../../x", categoryid: "333", forcedownload: "1" })).toThrow(/Valor no admitido/);
        expect(() => assertWebRoute("question_export_category", { contextid: "7001", categoryid: "333", forcedownload: "1", format: "gift" })).toThrow(/no admitido/);
        expect(() => assertWebRoute("question_export_category", { contextid: "7001", categoryid: "333" })).toThrow(/Falta/);
    });

    it("el parser asigna a cada pregunta la ruta del último nodo de categoría", () => {
        const p = parseQuestionXml(XML_CATEGORY);
        expect(p.category_paths).toHaveLength(3);
        expect(p.questions.map((q) => q.category_path)).toEqual([
            "$module$/top/Por defecto en Banco/Unidad 2",
            "$module$/top/Por defecto en Banco/Unidad 2",
            "$module$/top/Por defecto en Banco/Unidad 2",
            "$module$/top/Por defecto en Banco/Unidad 2/Sub",
        ]);
    });
});
