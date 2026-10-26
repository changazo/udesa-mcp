/**
 * Banco de preguntas SINTÉTICO para tests (IDs y textos inventados). Se monta sobre FakeWeb.
 */
import { PNG_1X1 } from "./documents.js";
import { QUIZ, SITE } from "./fake-moodle.js";
import type { FakeWeb } from "./fake-web.js";

export const BANK_CMID = 9601;
export const BANK_CONTEXT = 7001;
export const CATEGORY = 333;
export const SUBCATEGORY = 334;
export const FOREIGN_BANK_CMID = 8888;

export const Q_MULTI = 4601;
export const Q_TF_SAME_TITLE = 4602;
export const Q_HIDDEN = 4603;
export const Q_CODERUNNER = 4604;

const png64 = Buffer.from(PNG_1X1).toString("base64");

export const XML_MULTI = `<?xml version="1.0" encoding="UTF-8"?>
<quiz>
  <question type="category"><category><text>$course$/top/Unidad 2</text></category></question>
  <question type="multichoice">
    <name><text>Suma</text></name>
    <questiontext format="html"><text><![CDATA[<p>¿Cuánto es <b>2+2</b>?</p><img src="@@PLUGINFILE@@/diagrama.png">]]></text>
      <file name="diagrama.png" path="/" encoding="base64">${png64}</file>
    </questiontext>
    <generalfeedback format="html"><text><![CDATA[<p>Repasá sumas.</p>]]></text></generalfeedback>
    <defaultgrade>1.0000000</defaultgrade>
    <penalty>0.3333333</penalty>
    <hidden>0</hidden>
    <idnumber>U2-SUMA</idnumber>
    <single>true</single>
    <shuffleanswers>true</shuffleanswers>
    <answernumbering>abc</answernumbering>
    <correctfeedback format="html"><text>Bien</text></correctfeedback>
    <partiallycorrectfeedback format="html"><text>Casi</text></partiallycorrectfeedback>
    <incorrectfeedback format="html"><text>No</text></incorrectfeedback>
    <answer fraction="100" format="html"><text>4</text><feedback format="html"><text>Correcto &amp; claro</text></feedback></answer>
    <answer fraction="0" format="html"><text>5</text><feedback format="html"><text></text></feedback></answer>
    <hint format="html"><text>Contá con los dedos</text></hint>
  </question>
</quiz>`;

export const XML_TF = `<?xml version="1.0" encoding="UTF-8"?>
<quiz><question type="truefalse"><name><text>Suma</text></name><questiontext format="plain_text"><text>2+2=4</text></questiontext><defaultgrade>1</defaultgrade><penalty>1</penalty><hidden>0</hidden>
<answer fraction="100" format="moodle_auto_format"><text>true</text><feedback format="html"><text>Sí</text></feedback></answer>
<answer fraction="0" format="moodle_auto_format"><text>false</text><feedback format="html"><text>No</text></feedback></answer></question></quiz>`;

/** Exportación válida sin preguntas: Moodle omite versiones ocultas. */
export const XML_EMPTY = `<?xml version="1.0" encoding="UTF-8"?><quiz></quiz>`;

export const XML_CODERUNNER = `<?xml version="1.0" encoding="UTF-8"?>
<quiz><question type="coderunner"><name><text>Doble</text></name><questiontext format="html"><text><![CDATA[<p>Escribí doble(x)</p>]]></text></questiontext>
<defaultgrade>2</defaultgrade><penalty>0</penalty><hidden>0</hidden><coderunnertype>python3</coderunnertype><answer>def doble(x): return 2*x</answer>
<testcases><testcase><testcode><text>print(doble(2))</text></testcode><expected><text>4</text></expected></testcase></testcases></question></quiz>`;

/** Ruta de la exportación por categoría (pluginfile) de la categoría del fixture. */
export const CATEGORY_EXPORT_PATH = `/pluginfile.php/${BANK_CONTEXT}/question/export/${CATEGORY}/xml/withcategories/withcontexts/categoria-${CATEGORY}.xml`;

/**
 * Exportación de la categoría 333 con su subcategoría 334, como la arma Moodle: nodos de categoría
 * (incluida una categoría padre vacía), última versión de cada entrada (un borrador sin candidato),
 * sin la pregunta oculta. Mismo multichoice que XML_MULTI (con su imagen embebida).
 */
export const XML_CATEGORY = `<?xml version="1.0" encoding="UTF-8"?>
<quiz>
  <question type="category"><category><text>$module$/top/Por defecto en Banco</text></category><info format="html"><text></text></info><idnumber></idnumber></question>
  <question type="category"><category><text>$module$/top/Por defecto en Banco/Unidad 2</text></category><info format="html"><text></text></info><idnumber></idnumber></question>
  ${XML_MULTI.replace(/^[\s\S]*?<question type="multichoice">/, '<question type="multichoice">').replace(/<\/quiz>\s*$/, "")}
  <question type="coderunner"><name><text>Doble</text></name><questiontext format="html"><text><![CDATA[<p>Escribí doble(x)</p>]]></text></questiontext><defaultgrade>2</defaultgrade><penalty>0</penalty><hidden>0</hidden><coderunnertype>python3</coderunnertype></question>
  <question type="essay"><name><text>Borrador nuevo</text></name><questiontext format="html"><text><![CDATA[<p>Explicá</p>]]></text></questiontext><defaultgrade>1</defaultgrade><penalty>0</penalty><hidden>0</hidden><responseformat>editor</responseformat></question>
  <question type="category"><category><text>$module$/top/Por defecto en Banco/Unidad 2/Sub</text></category><info format="html"><text></text></info><idnumber></idnumber></question>
  <question type="truefalse"><name><text>Suma</text></name><questiontext format="plain_text"><text>2+2=4</text></questiontext><defaultgrade>1</defaultgrade><penalty>1</penalty><hidden>0</hidden>
    <answer fraction="100" format="moodle_auto_format"><text>true</text><feedback format="html"><text>Sí</text></feedback></answer>
    <answer fraction="0" format="moodle_auto_format"><text>false</text><feedback format="html"><text>No</text></feedback></answer></question>
</quiz>`;

const SUMMARIES = [
    { id: Q_MULTI, category: CATEGORY, parent: 0, name: "Suma", qtype: "multichoice" },
    { id: Q_TF_SAME_TITLE, category: SUBCATEGORY, parent: 0, name: "Suma", qtype: "truefalse" },
    { id: Q_HIDDEN, category: CATEGORY, parent: 0, name: "Oculta en el banco", qtype: "essay" },
    { id: Q_CODERUNNER, category: CATEGORY, parent: 0, name: "Doble", qtype: "coderunner" },
];

const randomSlot = (bank: number, cat: number, sub: boolean, slotId: number) => {
    const filter = encodeURIComponent(JSON.stringify({ category: { jointype: 1, values: [String(cat)], filteroptions: { includesubcategories: sub } } }));
    return { id: slotId, displaynumber: String(slotId), displayname: `<a data-action="editrandomquestion" href="#">x</a> Aleatoria <a class="mod_quiz_random_qbank_link" href="${SITE}/question/edit.php?cmid=${bank}&amp;filter=${filter}">ver</a>`, maxmark: "1,00", choices: [] };
};

export function mountQuestionBank(web: FakeWeb) {
    web.ajax.set("mod_quiz_get_edit_grading_page_data", (a) =>
        JSON.stringify({
            quizid: a.quizid,
            sections: a.quizid === QUIZ ? [{ displayname: "S", slots: [randomSlot(BANK_CMID, CATEGORY, true, 11), randomSlot(FOREIGN_BANK_CMID, 555, false, 12)] }] : [],
            gradeitems: [],
        }),
    );
    web.ajax.set("core_question_get_random_question_summaries", (a) => {
        if (a.contextid !== BANK_CONTEXT) throw Object.assign(new Error("Contexto inválido"), { errorcode: "invalidcontext" });
        const all = SUMMARIES.filter((q) => q.category === a.categoryid || (a.includesubcategories === true && a.categoryid === CATEGORY && q.category === SUBCATEGORY));
        const offset = Number(a.offset);
        const limit = Number(a.limit);
        return { totalcount: all.length, questions: all.slice(offset, offset + limit) };
    });
    web.pages.set("/question/bank/exporttoxml/exportone.php", (q) => {
        if (q.cmid !== String(BANK_CMID)) return { body: '<html><body><div class="box errorbox alert alert-danger">Sin permiso</div></body></html>' };
        const xml = { [Q_MULTI]: XML_MULTI, [Q_TF_SAME_TITLE]: XML_TF, [Q_HIDDEN]: XML_EMPTY, [Q_CODERUNNER]: XML_CODERUNNER }[Number(q.id)];
        return xml ? { body: xml, contentType: "application/xml" } : { body: '<html><body><div class="box errorbox">No existe</div></body></html>' };
    });
    web.pages.set(CATEGORY_EXPORT_PATH, () => ({ body: XML_CATEGORY, contentType: "application/xml" }));
}

/** ADR-107: regla aleatoria sobre el banco propio del cuestionario (Moodle 5), contexto 7101. */
export function mountQuizOwnBankRule(web: FakeWeb, quizCmid: number) {
    web.ajax.set("mod_quiz_get_edit_grading_page_data", (a) =>
        JSON.stringify({ quizid: a.quizid, sections: a.quizid === QUIZ ? [{ displayname: "S", slots: [randomSlot(quizCmid, 4242, false, 21)] }] : [], gradeitems: [] }),
    );
    web.ajax.set("core_question_get_random_question_summaries", (a) => {
        if (a.contextid !== 7101 || a.categoryid !== 4242) throw Object.assign(new Error("Contexto inválido"), { errorcode: "invalidcontext" });
        return { totalcount: 1, questions: [{ id: 990, category: 4242, parent: 0, name: "Propia", qtype: "truefalse" }] };
    });
}

/** Reemplaza las reglas aleatorias del cuestionario (para probar reglas sin subcategorías). */
export function mountRandomRule(web: FakeWeb, includeSubcategories: boolean) {
    web.ajax.set("mod_quiz_get_edit_grading_page_data", (a) =>
        JSON.stringify({ quizid: a.quizid, sections: a.quizid === QUIZ ? [{ displayname: "S", slots: [randomSlot(BANK_CMID, CATEGORY, includeSubcategories, 11)] }] : [], gradeitems: [] }),
    );
}
