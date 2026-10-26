import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { QNR_CMID, SyntheticQuestionnaire } from "../fixtures/fake-questionnaire.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-097: preguntas de una encuesta (mod_questionnaire). Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_activity_entries"] } } });
    h.w2.extraModules.push({ id: QNR_CMID, modname: "questionnaire", name: "Encuesta", section: 1, visible: true });
    return { h, q: new SyntheticQuestionnaire(h.fake) };
}
const run = async (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan("questionnaire_question", { course_id: COURSE, course_module_id: QNR_CMID, ...input }, "test")).plan_id, h.confirmer, "test");
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

describe("preguntas de encuestas (ADR-097)", () => {
    it("agregar una de radio con opciones (el plugin responde 200); deshacer la borra", async () => {
        const { h, q } = await harness();
        const r = await run(h, { operation: "add", type: "radio", name: "color", question: "¿Qué **color**?", required: true, choices: ["Rojo", "Verde"] });
        expect(r.status).toBe("aplicado_verificado");
        expect(q.questions.at(-1)).toMatchObject({ type: 4, name: "color", required: "y", content: "<p>¿Qué <strong>color</strong>?</p>", choices: "Rojo\nVerde" });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(q.questions.map((x) => x.id)).toEqual([32]);
    });

    it("editar una existente y deshacer; borrar y recrear con el deshacer; validaciones", async () => {
        const { h, q } = await harness();
        const e = await run(h, { operation: "edit", question_id: 32, name: "Sentido 2", required: false, choices: ["Uno", "Dos", "Tres"] });
        expect(e.status).toBe("aplicado_verificado");
        expect(q.questions[0]).toMatchObject({ name: "Sentido 2", required: "n", choices: "Uno\nDos\nTres" });
        expect((await undo(h, e.action_id)).status).toBe("aplicado_verificado");
        expect(q.questions[0]).toMatchObject({ name: "Sentido", required: "y", choices: "Uno\nDos" });
        const d = await run(h, { operation: "delete", question_id: 32 });
        expect(d.status).toBe("aplicado_verificado");
        expect(q.questions).toHaveLength(0);
        expect((await undo(h, d.action_id)).status).toBe("aplicado_verificado");
        expect(q.questions[0]).toMatchObject({ type: 4, name: "Sentido", choices: "Uno\nDos" });
        const plan = (input: Record<string, unknown>) => h.app.engine.plan("questionnaire_question", { course_id: COURSE, course_module_id: QNR_CMID, ...input }, "test");
        expect((await errOf(plan({ operation: "add", type: "dropdown", question: "x" }))).message).toMatch(/choices/);
        expect((await errOf(plan({ operation: "add", type: "text", question: "x", choices: ["a"] }))).message).toMatch(/no tiene opciones/);
        expect((await errOf(plan({ operation: "edit", question_id: 999, name: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("si el plugin no guarda, sin_efecto", async () => {
        const { h, q } = await harness();
        q.noop = true;
        const r = await run(h, { operation: "edit", question_id: 32, name: "Otro" }).catch((x: CampusError) => x.details?.result as { status: string });
        expect(r.status).toBe("sin_efecto");
    });

    it("mover una pregunta a otra posición (ADR-101); deshacer la devuelve; posición inválida rechazada", async () => {
        const { h, q } = await harness();
        q.questions.push({ id: 33, type: 1, name: "B", required: "n", content: "<p>b</p>", choices: "", length: "0", precise: "0" }, { id: 34, type: 1, name: "C", required: "n", content: "<p>c</p>", choices: "", length: "0", precise: "0" });
        const r = await run(h, { operation: "move", question_id: 34, position: 1 });
        expect(r.status).toBe("aplicado_verificado");
        expect(q.questions.map((x) => x.id)).toEqual([34, 32, 33]);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(q.questions.map((x) => x.id)).toEqual([32, 33, 34]);
        expect((await errOf(h.app.engine.plan("questionnaire_question", { course_id: COURSE, course_module_id: QNR_CMID, operation: "move", question_id: 34, position: 3 }, "test"))).message).toMatch(/ya está/);
        expect((await errOf(h.app.engine.plan("questionnaire_question", { course_id: COURSE, course_module_id: QNR_CMID, operation: "move", question_id: 34, position: 9 }, "test"))).message).toMatch(/1 a 3/);
    });
});
