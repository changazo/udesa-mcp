import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { editPageHasAttempts } from "../../src/write/intents/quiz-structure-edit.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { CAT_DEFAULT, SyntheticQuestionBank } from "../fixtures/fake-qimport.js";
import { QUIZ_ID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { SyntheticQuizSlots } from "../fixtures/fake-quiz-slots.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_quiz"] } } });
    new SyntheticQuizzes(h.fake, h.w2);
    const bank = new SyntheticQuestionBank(h.fake);
    return { h, quiz: new SyntheticQuizSlots(h.fake, bank) };
}
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, quiz_id: QUIZ_ID, ...input }, "test");
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

describe("preguntas aleatorias (ADR-072)", () => {
    it("N slots de una categoría del banco; verificados por la regla; deshacer quita sólo esos", async () => {
        const { h, quiz } = await harness();
        const r = await exec(h, (await plan(h, "quiz_add_random", { category_id: CAT_DEFAULT, count: 2, include_subcategories: true })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(quiz.slots.filter((s) => s.random)).toHaveLength(2);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(quiz.slots).toHaveLength(1);
    });

    it("con intentos se rechaza en el plan; categoría ajena también", async () => {
        const { h, quiz } = await harness();
        expect((await errOf(plan(h, "quiz_add_random", { category_id: 4242, count: 1 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        quiz.hasAttempts = true;
        expect((await errOf(plan(h, "quiz_add_random", { category_id: CAT_DEFAULT, count: 1 }))).message).toMatch(/intentos/);
    });
});

describe("nota máxima de un slot (ADR-072)", () => {
    it("cambia y deshace; con intentos se rechaza (reescalaría notas); Moodle no aplica → sin_efecto", async () => {
        const { h, quiz } = await harness();
        const r = await exec(h, (await plan(h, "quiz_slot_maxmark", { slot_id: 501, max_mark: 2.5 })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(quiz.slots[0]!.max).toBe(2.5);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(quiz.slots[0]!.max).toBe(1);
        expect((await errOf(plan(h, "quiz_slot_maxmark", { slot_id: 999, max_mark: 2 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "quiz_slot_maxmark", { slot_id: 501, max_mark: 1 }))).code).toBe("WRITE_NOT_ALLOWED");
        quiz.maxNoop = true;
        expect((await exec(h, (await plan(h, "quiz_slot_maxmark", { slot_id: 501, max_mark: 3 })).plan_id)).status).toBe("sin_efecto");
        quiz.hasAttempts = true;
        expect((await errOf(plan(h, "quiz_slot_maxmark", { slot_id: 501, max_mark: 4 }))).message).toMatch(/intentos/);
    });

    it("detección de intentos: el enlace a Resultados de la navegación no cuenta; sólo el aviso statusdisplay", () => {
        const nav = `<body id="page-mod-quiz-edit"><a href="/mod/quiz/report.php?id=5&amp;mode=overview">Resultados</a>`;
        expect(editPageHasAttempts(nav)).toBe(false);
        expect(editPageHasAttempts(`${nav}<div class="statusdisplay">x <a href="/mod/quiz/report.php?id=5&amp;mode=overview">Intentos: 2</a></div>`)).toBe(true);
        expect(editPageHasAttempts("<html>login</html>")).toBeNull();
    });
});
