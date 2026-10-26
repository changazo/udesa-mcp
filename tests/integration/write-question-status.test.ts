import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { CAT_OTHER, SyntheticQuestionBank } from "../fixtures/fake-qimport.js";
import { QUIZ_CMID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_quiz"] } } });
    new SyntheticQuizzes(h.fake, h.w2);
    const bank = new SyntheticQuestionBank(h.fake);
    bank.questions.push({ id: 9002, category: CAT_OTHER, name: "Suma", qtype: "multichoice" });
    return { h, bank };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("question_status", { course_id: COURSE, bank_course_module_id: QUIZ_CMID, ...input }, "test");
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

describe("estado de una pregunta (§8.10, ADR-068)", () => {
    it("lista → borrador por nombre: verificado (sale del inventario); deshacer vuelve a lista", async () => {
        const { h, bank } = await harness();
        const p = await plan(h, { question_name: "Suma", status: "draft" });
        expect(p.risk).toBe("R2");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(bank.drafts.has(9002)).toBe(true);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(bank.drafts.has(9002)).toBe(false);
    });

    it("borrador → lista por id", async () => {
        const { h, bank } = await harness();
        bank.drafts.add(9002);
        expect((await exec(h, (await plan(h, { question_id: 9002, status: "ready" })).plan_id)).status).toBe("aplicado_verificado");
        expect(bank.drafts.has(9002)).toBe(false);
    });

    it("sin permiso Moodle devuelve status=false → rechazado_por_moodle", async () => {
        const { h, bank } = await harness();
        bank.denyStatus = true;
        expect((await exec(h, (await plan(h, { question_id: 9002, status: "draft" })).plan_id)).status).toBe("rechazado_por_moodle");
    });

    it("rechazos: ya lista, no lista para borrador, nombre inexistente o ambiguo, ambos o ninguno", async () => {
        const { h, bank } = await harness();
        const code = async (i: Record<string, unknown>) => (await errOf(plan(h, i))).code;
        expect(await code({ question_id: 9002, status: "ready" })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ question_id: 123456, status: "draft" })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ question_name: "No existe", status: "draft" })).toBe("RESOURCE_OUT_OF_SCOPE");
        bank.questions.push({ id: 9003, category: CAT_OTHER, name: "Suma", qtype: "truefalse" });
        expect(await code({ question_name: "Suma", status: "draft" })).toBe("AMBIGUOUS_RESOURCE");
        expect(await code({ status: "draft" })).toBe("WRITE_NOT_ALLOWED");
    });
});
