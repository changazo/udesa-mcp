import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseQuizLayout } from "../../src/domain/quiz-structure.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticQuestionBank } from "../fixtures/fake-qimport.js";
import { QUIZ_ID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { SyntheticQuizSlots } from "../fixtures/fake-quiz-slots.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-091: páginas y secciones de un cuestionario. Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_quiz"] } } });
    new SyntheticQuizzes(h.fake, h.w2);
    const bank = new SyntheticQuestionBank(h.fake);
    const quiz = new SyntheticQuizSlots(h.fake, bank);
    quiz.slots.push({ id: 502, qid: 9001 }, { id: 503, qid: 9001 }, { id: 504, qid: 9001 });
    return { h, quiz };
}
const run = async (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan("quiz_layout", { course_id: COURSE, quiz_id: QUIZ_ID, ...input }, "test")).plan_id, h.confirmer, "test");
async function undo(h: WriteHarness, actionId: string) {
    const u = await h.app.engine.planUndo(actionId, "test");
    if (!u.undoable) throw new Error(u.reason);
    return h.app.engine.execute(u.plan.plan_id, h.confirmer, "test");
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

describe("páginas y secciones de cuestionarios (ADR-091)", () => {
    it("parser: secciones con cabecera (vacía si está oculta), orden al azar, páginas y slots", () => {
        const html = `<body id="page-mod-quiz-edit"><li id="section-1" class="section main"><span class="instancesection visually-hidden">Sección sin título</span><input type="checkbox" id="shuffle-1" value="1" /><li class="pagenumber activity page" id="page-1"></li><li class="activity slot" id="slot-10"></li><li class="activity slot" id="slot-11"></li></li><li id="section-2" class="section main"><span class="instancesection">Parte &amp; 2</span><input type="checkbox" id="shuffle-2" value="1" checked="checked" /><li class="pagenumber page" id="page-2"></li><li class="activity slot" id="slot-12"></li></li></body>`;
        expect(parseQuizLayout(html)).toEqual({
            sections: [
                { section_id: 1, heading: "", shuffle: false, first_slot: 1, first_page: 1 },
                { section_id: 2, heading: "Parte & 2", shuffle: true, first_slot: 3, first_page: 2 },
            ],
            slots: [
                { slot_id: 10, number: 1, page: 1, section_id: 1 },
                { slot_id: 11, number: 2, page: 1, section_id: 1 },
                { slot_id: 12, number: 3, page: 2, section_id: 2 },
            ],
        });
        expect(parseQuizLayout("<html>otra página</html>")).toBeNull();
    });

    it("repaginar con 2 por página; deshacer vuelve a una por página con saltos individuales", async () => {
        const { h, quiz } = await harness();
        const r = await run(h, { operation: "repaginate", questions_per_page: 2 });
        expect(r.status).toBe("aplicado_verificado");
        expect([...quiz.joined].sort()).toEqual([501, 503]);
        const u = await undo(h, r.action_id);
        expect(u.status).toBe("aplicado_verificado");
        expect(quiz.joined.size).toBe(0);
        expect(h.fake.web.requests.filter((x) => x.path === "/mod/quiz/repaginate.php").length).toBe(2);
        expect((await errOf(h.app.engine.plan("quiz_layout", { course_id: COURSE, quiz_id: QUIZ_ID, operation: "repaginate", questions_per_page: 1 }, "test"))).message).toMatch(/ya está paginado/);
    });

    it("quitar y poner un salto de página; con intentos se rechaza", async () => {
        const { h, quiz } = await harness();
        const r = await run(h, { operation: "page_break", after_slot_id: 502, page_break: false });
        expect(r.status).toBe("aplicado_verificado");
        expect(quiz.joined.has(502)).toBe(true);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(quiz.joined.has(502)).toBe(false);
        expect((await errOf(h.app.engine.plan("quiz_layout", { course_id: COURSE, quiz_id: QUIZ_ID, operation: "page_break", after_slot_id: 504, page_break: true }, "test"))).message).toMatch(/última/);
        quiz.hasAttempts = true;
        expect((await errOf(h.app.engine.plan("quiz_layout", { course_id: COURSE, quiz_id: QUIZ_ID, operation: "page_break", after_slot_id: 502, page_break: false }, "test"))).message).toMatch(/intentos/);
    });

    it("agregar una sección, nombrarla, barajarla y quitarla; deshacer cada paso; la primera no se quita", async () => {
        const { h, quiz } = await harness();
        const add = await run(h, { operation: "add_section", page: 3 });
        expect(add.status).toBe("aplicado_verificado");
        const id = quiz.sections[1]!.id;
        expect(add.moodle_ids.section_id).toEqual([id]);
        const ren = await run(h, { operation: "rename_section", section_id: id, heading: "Parte B" });
        expect(ren.status).toBe("aplicado_verificado");
        expect(quiz.sections[1]!.heading).toBe("Parte B");
        const sh = await run(h, { operation: "shuffle_section", section_id: id, shuffle: true });
        expect(sh.status).toBe("aplicado_verificado");
        expect((await undo(h, sh.action_id)).status).toBe("aplicado_verificado");
        expect(quiz.sections[1]!.shuffle).toBe(false);
        expect((await undo(h, ren.action_id)).status).toBe("aplicado_verificado");
        expect(quiz.sections[1]!.heading).toBe("");
        expect((await errOf(h.app.engine.plan("quiz_layout", { course_id: COURSE, quiz_id: QUIZ_ID, operation: "page_break", after_slot_id: 502, page_break: false }, "test"))).message).toMatch(/dos secciones/);
        expect((await errOf(h.app.engine.plan("quiz_layout", { course_id: COURSE, quiz_id: QUIZ_ID, operation: "remove_section", section_id: 700 }, "test"))).message).toMatch(/primera/);
        expect((await undo(h, add.action_id)).status).toBe("aplicado_verificado");
        expect(quiz.sections.map((s) => s.id)).toEqual([700]);
        expect((await errOf(h.app.engine.plan("quiz_layout", { course_id: COURSE, quiz_id: QUIZ_ID, operation: "add_section", page: 1 }, "test"))).message).toMatch(/primera/);
    });

    it("si Moodle no aplica el cambio, sin_efecto", async () => {
        const { h, quiz } = await harness();
        quiz.layoutNoop = true;
        const r = await run(h, { operation: "repaginate", questions_per_page: 0 }).catch((e: CampusError) => e.details?.result as { status: string });
        expect(r.status).toBe("sin_efecto");
    });

    it("campus_get_quiz_structure con include_layout agrega página y sección de cada slot", async () => {
        const { h } = await harness();
        const r = await h.app.read.service.getQuizStructure({ course_id: COURSE, quiz_id: QUIZ_ID, include_layout: true });
        const d = r.data as { sections: { slots: { slot_id: number; page: number; section_id: number }[] }[]; layout: { sections: { section_id: number }[]; pages: number } };
        expect(d.layout).toMatchObject({ pages: 4, sections: [{ section_id: 700 }] });
        expect(d.sections[0]!.slots.map((s) => [s.slot_id, s.page, s.section_id])).toEqual([[501, 1, 700], [502, 2, 700], [503, 3, 700], [504, 4, 700]]);
    });
});
