import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { resultError } from "../../src/write/engine.js";
import { checkWriteRest } from "../../src/write/functions.js";
import { COURSE, SITE, STUDENT_A, STUDENT_B, STUDENT_C } from "../fixtures/fake-moodle.js";
import { W2_ASSIGN } from "../fixtures/fake-w2.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const harness = (policy: Record<string, unknown> = {}) => makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["grade_submission"] }, ...policy } });
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("grade", { course_id: COURSE, assignment_id: W2_ASSIGN, ...input }, "test");
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

describe("W3 · calificar y devolver (§8.6)", () => {
    it("campos peligrosos explícitos (intento, applytoall, addattempt, notificación) y coma decimal; verificado; R3", async () => {
        const h = await harness();
        const p = await plan(h, { participant_id: STUDENT_A, grade: "7,5", feedback_comment: "Muy **bien**." });
        expect(p.risk).toBe("R3");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.w2.gradingForms[0]).toMatchObject({ grade: "7.5", attemptnumber: "0", applytoall: "0", addattempt: "0", sendstudentnotifications: "0", "assignfeedbackcomments_editor[text]": "<p>Muy <strong>bien</strong>.</p>" });
        expect(h.w2.grades.get(STUDENT_A)?.grade).toBe(7.5);
    });

    it("sin comentario nuevo se reenvía el vigente; deshacer vuelve a la nota y devolución anteriores", async () => {
        const h = await harness();
        await exec(h, (await plan(h, { participant_id: STUDENT_A, grade: 6, feedback_comment: "Primera devolución" })).plan_id);
        const p = await plan(h, { participant_id: STUDENT_A, grade: 8 });
        expect(p.warnings.join(" ")).toMatch(/Se reenvía el comentario/);
        const r = await exec(h, p.plan_id);
        expect(h.w2.gradingForms[1]!["assignfeedbackcomments_editor[text]"]).toBe("<p>Primera devolución</p>");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(h.w2.grades.get(STUDENT_A)?.grade).toBe(6);
    });

    it("primera nota: el deshacer se declara «ninguno» (Moodle guardaría 0 en vez de «sin nota»)", async () => {
        const h = await harness();
        const p = await plan(h, { participant_id: STUDENT_B, grade: 5 });
        expect(p.undo.kind).toBe("ninguno");
        expect(p.warnings.join(" ")).toMatch(/no tiene entrega/);
        const r = await exec(h, p.plan_id);
        expect(await h.app.engine.planUndo(r.action_id, "test")).toMatchObject({ undoable: false });
    });

    it("rechazos en el plan: fuera de rango, no numérica, no participante, nota bloqueada, notificar sin permiso del perfil, workflow", async () => {
        const h = await harness();
        expect((await errOf(plan(h, { participant_id: STUDENT_A, grade: 11 }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { participant_id: STUDENT_A, grade: "diez" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { participant_id: STUDENT_C, grade: 5 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, { participant_id: STUDENT_A, grade: 5, notify_student: true }))).code).toBe("WRITE_NOT_ALLOWED");
        h.w2.gradeLocked = true;
        expect((await errOf(plan(h, { participant_id: STUDENT_A, grade: 5 }))).code).toBe("WRITE_NOT_ALLOWED");
        h.w2.gradeLocked = false;
        h.w2.assignments[0]!.markingworkflow = 1;
        expect((await errOf(plan(h, { participant_id: STUDENT_A, grade: 5 }))).code).toBe("WRITE_NOT_ALLOWED");
        expect(h.w2.gradingForms).toHaveLength(0);
    });

    it("«couldnotsavegrade» → rechazado; Moodle que no guarda nada → sin_efecto", async () => {
        const h = await harness();
        const p = await plan(h, { participant_id: STUDENT_A, grade: 5 });
        h.fake.overrides.set("mod_assign_submit_grading_form", () => [{ item: "assign", warningcode: "couldnotsavegrade", message: "Form validation failed." }]);
        expect(resultError(await exec(h, p.plan_id))?.code).toBe("MOODLE_REJECTED");
        const h2 = await harness();
        h2.w2.gradingNoop = true;
        expect((await exec(h2, (await plan(h2, { participant_id: STUDENT_A, grade: 5 })).plan_id)).status).toBe("sin_efecto");
    });

    it("allowlist: jsonformdata sin intento, con applytoall=1, con campos extra o sin comillas JSON se rechaza", () => {
        const code = (qs: string, raw = false) => {
            try {
                checkWriteRest("mod_assign_submit_grading_form", [["assignmentid", "1"], ["userid", "2"], ["jsonformdata", raw ? qs : JSON.stringify(qs)]], SITE);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        const ok = "grade=5&attemptnumber=0&applytoall=0&addattempt=0&sendstudentnotifications=0";
        expect(code(ok)).toBe("OK");
        expect(code(ok, true)).toBe("POLICY_DENIED");
        expect(code("grade=5&applytoall=0&addattempt=0&sendstudentnotifications=0")).toBe("POLICY_DENIED");
        expect(code(ok.replace("applytoall=0", "applytoall=1"))).toBe("POLICY_DENIED");
        expect(code(`${ok}&workflowstate=released`)).toBe("POLICY_DENIED");
        expect(code(`${ok}&advancedgrading[criteria][1][levelid]=2`)).toBe("POLICY_DENIED");
    });
});
