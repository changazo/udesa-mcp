import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseXml } from "../../src/documents/xml.js";
import { parseQuestionXml } from "../../src/domain/question-xml.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { COURSE, QUIZ, QUIZ_CMID, SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";
import {
    BANK_CMID,
    CATEGORY,
    FOREIGN_BANK_CMID,
    mountQuestionBank,
    mountQuizOwnBankRule,
    Q_CODERUNNER,
    Q_HIDDEN,
    Q_MULTI,
    Q_TF_SAME_TITLE,
    SUBCATEGORY,
    XML_MULTI,
} from "../fixtures/questions.js";

const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
const web = () => new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" });

async function setup() {
    const h = await makeHarness({ webSource: web() });
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
const base = { course_id: COURSE, bank_course_module_id: BANK_CMID, category_id: CATEGORY };

describe("bancos de preguntas", () => {
    it("lista los bancos del curso por REST, sin sesión web", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listQuestionBanks({ course_id: COURSE });
        expect(r.data.banks).toEqual([{ bank_course_module_id: BANK_CMID, kind: "banco", instance_id: 31, name: "Banco del curso", context_id: 7001, visible: true }]);
    });

    it("ADR-107: el banco propio de un cuestionario del curso (Moodle 5) es del curso, no externo, y se puede inventariar", async () => {
        const h = await setup();
        mountQuizOwnBankRule(h.fake.web, QUIZ_CMID);
        const r = await h.app.service.listQuestionBanks({ course_id: COURSE, include_categories: true });
        expect(r.data.external_bank_references).toEqual([]);
        expect(r.data.banks.find((b) => b.bank_course_module_id === QUIZ_CMID)).toMatchObject({ kind: "cuestionario", context_id: 7101, categories: [{ category_id: 4242, include_subcategories: false, referenced_by: [{ quiz_id: QUIZ, slot_id: 21 }] }] });
        const l = await h.app.service.listQuestions({ course_id: COURSE, bank_course_module_id: QUIZ_CMID, category_id: 4242 });
        expect(l.data.questions.map((q: { question_id: number }) => q.question_id)).toEqual([990]);
    });

    it("con include_categories: categorías de reglas aleatorias; los bancos de otros cursos se informan aparte", async () => {
        const h = await setup();
        const r = await h.app.service.listQuestionBanks({ course_id: COURSE, include_categories: true });
        expect(r.data.banks[0]!.categories).toEqual([{ category_id: CATEGORY, include_subcategories: true, referenced_by: [{ quiz_id: QUIZ, slot_id: 11 }] }]);
        expect(r.data.external_bank_references).toEqual([{ bank_course_module_id: FOREIGN_BANK_CMID, category_id: 555, referenced_by: [{ quiz_id: QUIZ, slot_id: 12 }] }]);
    });
});

describe("inventario de candidatos (§7.1)", () => {
    it("lista candidatos con subcategorías según la regla; dos preguntas con igual título quedan separadas por ID", async () => {
        const h = await setup();
        const r = await h.app.service.listQuestions(base);
        expect(r.data.inventory_kind).toBe("candidatos_aleatorios");
        expect(r.data.include_subcategories).toBe(true);
        expect(r.data.questions.filter((q) => q.name === "Suma").map((q) => [q.question_id, q.category_id])).toEqual([
            [Q_MULTI, CATEGORY],
            [Q_TF_SAME_TITLE, SUBCATEGORY],
        ]);
        expect(r.data.justified_by).toEqual({ quiz_id: QUIZ, slot_id: 11 });
    });

    it("paginación con cursor atado a banco, categoría y límite", async () => {
        const h = await setup();
        const p1 = await h.app.service.listQuestions({ ...base, limit: 2 });
        expect(p1.data.questions).toHaveLength(2);
        expect(p1.coverage.has_more).toBe(true);
        const p2 = await h.app.service.listQuestions({ ...base, limit: 2, cursor: p1.coverage.next_cursor! });
        expect(p2.data.questions.map((q) => q.question_id)).toEqual([Q_HIDDEN, Q_CODERUNNER]);
        expect(p2.coverage.has_more).toBe(false);
        expect(await codeOf(h.app.service.listQuestions({ ...base, limit: 3, cursor: p1.coverage.next_cursor! }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("una categoría sin regla que la justifique, o un banco ajeno, no se listan", async () => {
        const h = await setup();
        expect(await codeOf(h.app.service.listQuestions({ ...base, category_id: 999 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.listQuestions({ ...base, bank_course_module_id: FOREIGN_BANK_CMID, category_id: 555 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.web.requests.some((r) => r.body?.includes("core_question_get_random_question_summaries"))).toBe(false);
    });
});

describe("definición de una pregunta (§7.2, §7.4)", () => {
    it("multichoice: campos comunes, opciones con fracción, archivo embebido como referencia", async () => {
        const h = await setup();
        const r = await h.app.service.getQuestion({ ...base, question_id: Q_MULTI });
        const d = r.data;
        expect(d).toMatchObject({ type: "multichoice", interpretation: "completa", name: "Suma", idnumber: "U2-SUMA", default_grade: 1, penalty: 0.3333333 });
        expect(d.identity).toMatchObject({ question_id: Q_MULTI, bank_course_module_id: BANK_CMID, category_id: CATEGORY, version: null });
        expect(d.question_text!.format).toBe("html");
        expect(d.question_text!.markdown).toContain("**2+2**");
        expect(d.answers.map((a) => [a.text!.original, a.fraction])).toEqual([
            ["4", 1],
            ["5", 0],
        ]);
        expect(d.answers[0]!.feedback!.original).toBe("Correcto & claro");
        expect(d.type_data).toMatchObject({ single: true, shuffle_answers: true, answer_numbering: "abc" });
        expect(d.files).toHaveLength(1);
        expect(d.files[0]).toMatchObject({ name: "diagrama.png", location: "questiontext" });
        expect(JSON.stringify(r)).not.toMatch(/iVBOR/); // nada de base64 en el JSON
        const img = await h.app.service.readFile({ file_ref: d.files[0]!.ref });
        expect(img.data.modality).toBe("image");
        const raw = await h.app.service.readFile({ file_ref: d.raw_xml_ref });
        expect(raw.data.text).toContain("<quiz>");
        expect(r.source).toMatchObject({ adapter: "web_export", operation: "question_export_one" });
        const exp = h.fake.web.requests.find((x) => x.path.endsWith("exportone.php"))!;
        expect(exp.query).toMatchObject({ id: String(Q_MULTI), cmid: String(BANK_CMID) });
    });

    it("pregunta de subcategoría (incluida por la regla) con el mismo título que otra", async () => {
        const h = await setup();
        const r = await h.app.service.getQuestion({ ...base, question_id: Q_TF_SAME_TITLE });
        expect(r.data).toMatchObject({ type: "truefalse", name: "Suma", interpretation: "completa" });
        expect(r.data.identity.category_id).toBe(SUBCATEGORY);
    });

    it("exportación sin preguntas (versión oculta): no se interpreta como inexistente", async () => {
        const h = await setup();
        const e = await h.app.service.getQuestion({ ...base, question_id: Q_HIDDEN }).catch((x) => x as CampusError);
        expect(e.code).toBe("UNSUPPORTED_CONTENT");
        expect(e.message).toMatch(/No significa que no exista/);
    });

    it("tipo sin parser (CodeRunner): parcial, sin interpretar código ni tests, con XML crudo disponible", async () => {
        const h = await setup();
        const r = await h.app.service.getQuestion({ ...base, question_id: Q_CODERUNNER });
        expect(r.data.interpretation).toBe("opaca");
        expect(r.data.answers).toEqual([]);
        expect(r.data.uninterpreted_fields).toEqual(expect.arrayContaining(["coderunnertype", "testcases"]));
        expect(r.coverage.complete).toBe(false);
    });

    it("referencias manipuladas: pregunta fuera de los candidatos, adjunto con otro nombre u ordinal", async () => {
        const h = await setup();
        expect(await codeOf(h.app.service.getQuestion({ ...base, question_id: 9999 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        const r = await h.app.service.getQuestion({ ...base, question_id: Q_MULTI });
        const ref = r.data.files[0]!.ref;
        expect(await codeOf(h.app.service.readFile({ file_ref: ref.replace(/\.[0-9a-f]{8}$/, ".00000000") }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.readFile({ file_ref: ref.replace(`.${Q_MULTI}.1.`, `.${Q_MULTI}.2.`) }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("sesión expirada en medio: AUTH_REQUIRED, no un vacío", async () => {
        const h = await setup();
        h.fake.web.sessions.clear();
        expect(await codeOf(h.app.service.getQuestion({ ...base, question_id: Q_MULTI }))).toBe("AUTH_REQUIRED");
    });
});

describe("XML seguro (§7.5)", () => {
    it("rechaza DTD y entidades, y limita profundidad y nodos", () => {
        expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><quiz>&a;</quiz>')).toThrow(/DTD/);
        expect(() => parseXml("<quiz>&xxe;</quiz>")).toThrow(/entidad/);
        expect(() => parseXml("<a>".repeat(70) + "</a>".repeat(70))).toThrow(/profundidad/);
        expect(() => parseXml(`<quiz>${"<b/>".repeat(60)}</quiz>`, { maxDepth: 64, maxNodes: 50, maxTextChars: 1000 })).toThrow(/nodos/);
        expect(() => parseXml("<quiz><a></quiz>")).toThrow();
    });

    it("los nodos de categoría no son preguntas; XML sin preguntas es una lista vacía declarada", () => {
        const p = parseQuestionXml(XML_MULTI);
        expect(p.category_nodes).toBe(1);
        expect(p.questions).toHaveLength(1);
        expect(parseQuestionXml("<quiz></quiz>").questions).toEqual([]);
        expect(() => parseQuestionXml("<html><body>login</body></html>")).toThrow();
    });

    it("nombres de archivo con rutas no se usan", () => {
        const xml = `<quiz><question type="description"><name><text>D</text></name><questiontext format="html"><text>x</text><file name="../../etc/passwd" path="/" encoding="base64">AAAA</file></questiontext></question></quiz>`;
        expect(parseQuestionXml(xml).questions[0]!.question.files).toEqual([]);
    });
});
