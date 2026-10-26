import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseGradingPageData, parseLocalizedMark } from "../../src/domain/quiz-structure.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { COURSE, OTHER_COURSE, QUIZ, SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";

const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
const web = () => new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" });

const fixed = (qid: number, name: string) =>
    `<a title="Editar pregunta ${name}" href="${SITE}/question/bank/editquestion/question.php?returnurl=%2Fmod%2Fquiz%2Fedit.php&amp;cmid=9301&amp;id=${qid}"><img class="icon activityicon" alt="Opción múltiple" title="Opción múltiple" src="x"><span class="instancename"><span class="questionname">${name}</span> <span class="questiontext">¿Cuánto es 2+2?</span></span></a>`;
const random = (bank: number, cat: number, sub: boolean) => {
    const filter = encodeURIComponent(JSON.stringify({ category: { jointype: 1, values: [String(cat)], filteroptions: { includesubcategories: sub } }, qtagids: { jointype: 1, values: [] } }));
    return `<a href="${SITE}/mod/quiz/edit.php" data-action="editrandomquestion" data-slotid="77"><img class="icon activityicon" alt="Aleatoria" title="Aleatoria" src="x"></a> Aleatoria (Unidad 2) <a href="${SITE}/question/edit.php?cmid=${bank}&amp;filter=${filter}" class="mod_quiz_random_qbank_link">Ver preguntas</a>`;
};

/** Página de calificación sintética: dos secciones, slots con IDs no consecutivos, puntaje localizado. */
export const GRADING_PAGE = JSON.stringify({
    quizid: QUIZ,
    hasgradeitems: true,
    gradeitems: [{ id: 5, displayname: "Teoría", isused: true, summarks: "3,50" }],
    sections: [
        {
            displayname: "Parte A",
            slots: [
                { id: 101, displaynumber: "1", displayname: fixed(4501, "Suma &amp; resta"), maxmark: "1,50", choices: [{ id: 0, isselected: false }, { id: 5, isselected: true }] },
                { id: 205, displaynumber: "2", displayname: random(9601, 333, true), maxmark: "2,00", choices: [{ id: 0, isselected: true }] },
            ],
        },
        {
            displayname: "Parte B",
            slots: [{ id: 999, displaynumber: "i", displayname: `<img class="icon activityicon" title="Ensayo" src="x"><span class="instancename">Sin permiso de edición</span>`, maxmark: "1.234,5", choices: [] }],
        },
    ],
});

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("estructura del cuestionario (§8)", () => {
    it("interpreta secciones, slots fijos, aleatorios y no resueltos, con puntajes localizados", async () => {
        const h = await makeHarness({ webSource: web() });
        h.fake.web.ajax.set("mod_quiz_get_edit_grading_page_data", (a) => (a.quizid === QUIZ ? GRADING_PAGE : "{}"));
        const r = await h.app.service.getQuizStructure({ course_id: COURSE, quiz_id: QUIZ });
        const [a, b] = r.data.sections;
        expect(a!.name).toBe("Parte A");
        expect(a!.slots[0]).toMatchObject({ slot_id: 101, display_number: "1", position: 1, kind: "fija", question_id: 4501, name: "Suma & resta", text_snippet: "¿Cuánto es 2+2?", question_type_label: "Opción múltiple", max_mark_raw: "1,50", max_mark: 1.5, grade_item_id: 5 });
        expect(a!.slots[1]).toMatchObject({ slot_id: 205, kind: "aleatoria", question_id: null, random_rule: { bank_course_module_id: 9601, category_id: 333, include_subcategories: true, other_conditions: ["qtagids"] }, max_mark: 2, grade_item_id: null });
        expect(a!.slots[1]!.name).toBe("Aleatoria (Unidad 2)");
        expect(b!.slots[0]).toMatchObject({ slot_id: 999, display_number: "i", kind: "no_resuelta", question_id: null, max_mark: 1234.5 });
        expect(r.data.grade_items).toEqual([{ grade_item_id: 5, name: "Teoría", used: true, sum_marks_raw: "3,50" }]);
        expect(r.coverage.detail!.unknown_fields).toEqual(["page", "question_version", "question_id"]);
        expect(r.source).toMatchObject({ adapter: "web_html", operation: "ajax:mod_quiz_get_edit_grading_page_data", wsfunctions: [] });
        // Nunca se pidió la página de edición.
        expect(h.fake.web.requests.some((x) => x.path.includes("/mod/quiz/edit.php"))).toBe(false);
    });

    it("un cuestionario de otro curso se rechaza antes de la sesión web", async () => {
        const h = await makeHarness({ webSource: web() });
        expect(await codeOf(h.app.service.getQuizStructure({ course_id: COURSE, quiz_id: 12345 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.getQuizStructure({ course_id: OTHER_COURSE, quiz_id: QUIZ }))).toBe("POLICY_DENIED");
        expect(h.fake.web.requests).toHaveLength(0);
    });

    it("estructura desconocida u otro cuestionario no producen un vacío válido", () => {
        expect(() => parseGradingPageData("<html>login</html>", QUIZ)).toThrow(/JSON/);
        expect(() => parseGradingPageData(JSON.stringify({ foo: 1 }), QUIZ)).toThrow(/formato/);
        expect(() => parseGradingPageData(JSON.stringify({ quizid: 1, sections: [] }), QUIZ)).toThrow(/otro cuestionario/);
        expect(parseGradingPageData(JSON.stringify({ quizid: QUIZ, sections: [] }), QUIZ).sections).toEqual([]);
    });

    it("sin sesión web: AUTH_REQUIRED explícito, las demás lecturas siguen", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getQuizStructure({ course_id: COURSE, quiz_id: QUIZ }))).toBe("AUTH_REQUIRED");
        await expect(h.app.service.listQuizzes(COURSE)).resolves.toBeTruthy();
    });

    it("puntajes: coma decimal, miles y valores no numéricos", () => {
        expect(parseLocalizedMark("1,50")).toBe(1.5);
        expect(parseLocalizedMark("2.00")).toBe(2);
        expect(parseLocalizedMark("1.234,5")).toBe(1234.5);
        expect(parseLocalizedMark("-")).toBeNull();
        expect(parseLocalizedMark(null)).toBeNull();
    });
});
