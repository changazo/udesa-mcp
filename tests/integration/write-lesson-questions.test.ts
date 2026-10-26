import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-092: páginas de pregunta de lecciones. Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_activity_entries"] } } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    const le = acts.add({ kind: "lesson", name: "Lección", intro: "", dates: {}, lessonPages: [{ id: 62, title: "Intro", contents: "<p>Hola</p>", qtype: 20, answers: ["Seguir"] }] });
    return { h, acts, le };
}
const run = async (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan("lesson_question", { course_id: COURSE, ...input }, "test")).plan_id, h.confirmer, "test");
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

describe("páginas de pregunta de lecciones (ADR-092)", () => {
    it("agregar opción múltiple con respuestas, retroalimentación, saltos y puntajes; deshacer la borra", async () => {
        const { h, le } = await harness();
        const r = await run(h, {
            course_module_id: le.id,
            operation: "add",
            question_type: "multichoice",
            title: "Suma",
            question: "¿Cuánto es **2+2**?",
            answers: [{ text: "4", correct: true, feedback: "¡Bien!" }, { text: "5", feedback: "No" }, { text: "Ir al final", jump: "end", score: 0 }],
        });
        expect(r.status).toBe("aplicado_verificado");
        const pg = le.lessonPages!.find((x) => x.title === "Suma")!;
        expect(pg.qtype).toBe(3);
        expect(pg.form).toMatchObject({ "answer_editor[0][text]": "4", "jumpto[0]": "-1", "score[0]": "1", "response_editor[0][text]": "<p>¡Bien!</p>", "answer_editor[1][text]": "5", "jumpto[1]": "0", "score[1]": "0", "jumpto[2]": "-9", "answer_editor[3][text]": "", qoption: "0" });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(le.lessonPages!.some((x) => x.title === "Suma")).toBe(false);
    });

    it("editar las respuestas (las que sobran se vacían); deshacer vuelve a las anteriores; el tipo no cambia", async () => {
        const { h, le } = await harness();
        const add = await run(h, { course_module_id: le.id, operation: "add", question_type: "shortanswer", title: "Capital", question: "Capital de Francia", case_sensitive: true, answers: [{ text: "París", correct: true }, { text: "Paris", correct: true }, { text: "Lyon" }] });
        expect(add.status).toBe("aplicado_verificado");
        const id = add.moodle_ids.page_id![0]!;
        const pg = le.lessonPages!.find((x) => x.id === id)!;
        expect(pg.form).toMatchObject({ "answer_editor[0]": "París", qoption: "1" });
        const ed = await run(h, { course_module_id: le.id, operation: "edit", page_id: id, answers: [{ text: "París", correct: true, feedback: "Sí" }] });
        expect(ed.status).toBe("aplicado_verificado");
        expect(pg.form).toMatchObject({ "answer_editor[0]": "París", "answer_editor[1]": "", "answer_editor[2]": "" });
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect(pg.form).toMatchObject({ "answer_editor[1]": "Paris", "answer_editor[2]": "Lyon" });
        expect((await errOf(h.app.engine.plan("lesson_question", { course_id: COURSE, course_module_id: le.id, operation: "edit", page_id: id, question_type: "numerical", answers: [{ text: "1" }] }, "test"))).message).toMatch(/no se cambia/);
        expect((await errOf(h.app.engine.plan("lesson_question", { course_id: COURSE, course_module_id: le.id, operation: "edit", page_id: 62, answers: [{ text: "1" }] }, "test"))).message).toMatch(/no es de pregunta/);
    });

    it("emparejamiento, ensayo y numérica; validaciones (pares, número, salto a otra lección)", async () => {
        const { h, le } = await harness();
        const m = await run(h, { course_module_id: le.id, operation: "add", question_type: "matching", title: "Pares", question: "Uní", pairs: [{ question: "Perro", answer: "Ladra" }, { question: "Gato", answer: "Maúlla" }], correct_feedback: "Bien", wrong_feedback: "Mal" });
        expect(m.status).toBe("aplicado_verificado");
        expect(le.lessonPages!.find((x) => x.title === "Pares")!.form).toMatchObject({ "answer_editor[2][text]": "Perro", "response_editor[2]": "Ladra", "answer_editor[0][text]": "<p>Bien</p>", "jumpto[0]": "-1", "answer_editor[4][text]": "" });
        const e = await run(h, { course_module_id: le.id, operation: "add", question_type: "essay", title: "Ensayo", question: "Contá", jump: "end", score: 5 });
        expect(e.status).toBe("aplicado_verificado");
        expect(le.lessonPages!.find((x) => x.title === "Ensayo")!.form).toMatchObject({ "jumpto[0]": "-9", "score[0]": "5" });
        const n = await run(h, { course_module_id: le.id, operation: "add", question_type: "numerical", title: "Num", question: "Un número entre 1 y 3", answers: [{ text: "1:3", correct: true, jump: 62 }] });
        expect(n.status).toBe("aplicado_verificado");
        const plan = (input: Record<string, unknown>) => h.app.engine.plan("lesson_question", { course_id: COURSE, course_module_id: le.id, operation: "add", title: "X", question: "Y", ...input }, "test");
        expect((await errOf(plan({ question_type: "matching", pairs: [{ question: "a", answer: "b" }] }))).message).toMatch(/2/);
        expect((await errOf(plan({ question_type: "numerical", answers: [{ text: "dos" }] }))).message).toMatch(/número/);
        expect((await errOf(plan({ question_type: "multichoice", answers: [{ text: "a", jump: 999 }] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan({ question_type: "truefalse", answers: [{ text: "V" }] }))).message).toMatch(/Entre 2 y 2/);
    });

    it("borrar una página de pregunta: el deshacer la recrea con sus respuestas", async () => {
        const { h, le } = await harness();
        const add = await run(h, { course_module_id: le.id, operation: "add", question_type: "truefalse", title: "VF", question: "El agua moja", answers: [{ text: "Verdadero", correct: true }, { text: "Falso" }] });
        const id = add.moodle_ids.page_id![0]!;
        const del = await h.app.engine.execute((await h.app.engine.plan("lesson_page", { course_id: COURSE, course_module_id: le.id, operation: "delete", page_id: id }, "test")).plan_id, h.confirmer, "test");
        expect(del.status).toBe("aplicado_verificado");
        const u = await undo(h, del.action_id);
        expect(u.status).toBe("aplicado_verificado");
        const again = le.lessonPages!.find((x) => x.title === "VF")!;
        expect(again.id).not.toBe(id);
        expect(again.form).toMatchObject({ "answer_editor[0][text]": "Verdadero", "jumpto[0]": "-1", "answer_editor[1][text]": "Falso", "jumpto[1]": "0" });
    });
});
