import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { CAT_DEFAULT, CAT_OTHER, SyntheticQuestionBank } from "../fixtures/fake-qimport.js";
import { QUIZ_ID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { SyntheticQuizSlots } from "../fixtures/fake-quiz-slots.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_quiz"] } } });
    new SyntheticQuizzes(h.fake, h.w2);
    const bank = new SyntheticQuestionBank(h.fake);
    bank.questions.push({ id: 9002, category: CAT_DEFAULT, name: "Suma", qtype: "multichoice" }, { id: 9003, category: CAT_OTHER, name: "Capital", qtype: "shortanswer" });
    return { h, bank, quiz: new SyntheticQuizSlots(h.fake, bank) };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("quiz_add_questions", { course_id: COURSE, quiz_id: QUIZ_ID, ...input }, "test");
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

describe("agregar preguntas a un cuestionario (§8.10, ADR-063)", () => {
    it("dos preguntas de distintas categorías del banco: un slot por pregunta, verificado; deshacer quita sólo esos slots", async () => {
        const { h, quiz } = await harness();
        const p = await plan(h, { question_ids: [9002, 9003] });
        expect(p.risk).toBe("R2");
        expect(p.items).toHaveLength(2);
        expect((p.payload_preview as { questions: { name: string }[] }).questions.map((q) => q.name)).toEqual(["Suma", "Capital"]);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(quiz.slots.map((s) => s.qid)).toEqual([9001, 9002, 9003]);
        expect(r.moodle_ids.slot_id).toHaveLength(2);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(quiz.slots.map((s) => s.qid)).toEqual([9001]);
    });

    it("por nombre (p. ej. recién importadas): resuelve ids; nombre inexistente o repetido en el banco se rechaza", async () => {
        const { h, bank, quiz } = await harness();
        const p = await plan(h, { question_names: ["Capital", "Suma"] });
        expect(p.items.map((i) => i.target.question_id)).toEqual([9003, 9002]);
        await exec(h, p.plan_id);
        expect(quiz.slots.map((s) => s.qid)).toEqual([9001, 9003, 9002]);
        expect((await errOf(plan(h, { question_names: ["No existe"] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        bank.questions.push({ id: 9004, category: CAT_OTHER, name: "Existente 1", qtype: "truefalse" });
        expect((await errOf(plan(h, { question_names: ["Existente 1"] }))).code).toBe("AMBIGUOUS_RESOURCE");
        expect((await errOf(plan(h, { question_ids: [9002], question_names: ["Suma"] }))).code).toBe("WRITE_NOT_ALLOWED");
    });

    it("rechazos en el plan: pregunta que ya está, que no está en el banco, repetida en el pedido, cuestionario ajeno", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, { question_ids: [9001] }))).message).toMatch(/ya están/);
        expect((await errOf(plan(h, { question_ids: [123456] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, { question_ids: [9002, 9002] }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { question_ids: [9002], quiz_id: 4242 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("con intentos Moodle rechaza: rechazado_por_moodle, sin slots nuevos", async () => {
        const { h, quiz } = await harness();
        const p = await plan(h, { question_ids: [9002] });
        quiz.hasAttempts = true;
        expect((await exec(h, p.plan_id)).status).toBe("rechazado_por_moodle");
        expect(quiz.slots).toHaveLength(1);
    });

    it("Moodle agrega otra pregunta → aplicado_con_diferencias, nunca «ok»", async () => {
        const { h, quiz } = await harness();
        quiz.wrongQuestion = true;
        expect((await exec(h, (await plan(h, { question_ids: [9002] })).plan_id)).status).toBe("aplicado_con_diferencias");
    });

    it("la estructura cambió entre plan y ejecución → PLAN_STALE", async () => {
        const { h, quiz } = await harness();
        const p = await plan(h, { question_ids: [9002] });
        quiz.slots.push({ id: 999, qid: 9003 });
        expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
    });
});

describe("quitar una pregunta existente (ADR-084)", () => {
    it("quita un slot que no agregó el MCP; con intentos se rechaza", async () => {
        const { h, quiz } = await harness();
        const r = await exec(h, (await h.app.engine.plan("quiz_remove_question", { course_id: COURSE, quiz_id: QUIZ_ID, slot_id: 501 }, "test")).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(quiz.slots).toHaveLength(0);
        quiz.slots.push({ id: 502, qid: 9001 });
        quiz.hasAttempts = true;
        await expect(h.app.engine.plan("quiz_remove_question", { course_id: COURSE, quiz_id: QUIZ_ID, slot_id: 502 }, "test")).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    });
});
