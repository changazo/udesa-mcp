import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, STUDENT_A } from "../fixtures/fake-moodle.js";
import { W2_ASSIGN_CMID } from "../fixtures/fake-w2.js";
import { SyntheticAssignOverrides } from "../fixtures/fake-assign-override.js";
import { QUIZ_ID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-099: editar excepciones existentes de cuestionarios y tareas. Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["quiz_override", "assign_override"] } } });
    return { h, q: new SyntheticQuizzes(h.fake, h.w2), a: new SyntheticAssignOverrides(h.fake, h.w2) };
}
const run = async (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan("override_edit", { course_id: COURSE, ...input }, "test")).plan_id, h.confirmer, "test");
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
const at = (s: string) => Date.parse(`${s}:00-03:00`) / 1000;

describe("editar excepciones existentes (ADR-099)", () => {
    it("cuestionario: cambia intentos y cierre, quita el tiempo y CONSERVA la contraseña; deshacer", async () => {
        const { h, q } = await harness();
        q.overrides.push({ id: 3100, quiz: QUIZ_ID, userid: STUDENT_A, groupid: null, timeopen: null, timeclose: null, timelimit: 2700, attempts: 3, password: "clave" });
        const r = await run(h, { quiz_id: QUIZ_ID, override_id: 3100, attempts: 5, close: "2027-02-01T20:00", time_limit_minutes: null });
        expect(r.status).toBe("aplicado_verificado");
        expect(q.overrides[0]).toMatchObject({ attempts: 5, timeclose: at("2027-02-01T20:00"), timelimit: null, password: "clave" });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(q.overrides[0]).toMatchObject({ attempts: 3, timeclose: null, timelimit: 2700, password: "clave" });
    });

    it("tarea: cambia entrega y límite; deshacer; validaciones", async () => {
        const { h, a } = await harness();
        a.overrides.push({ id: 210, cmid: W2_ASSIGN_CMID, userid: STUDENT_A, allowsubmissionsfromdate: 0, duedate: at("2027-01-10T23:59"), cutoffdate: 0 });
        const r = await run(h, { course_module_id: W2_ASSIGN_CMID, override_id: 210, due: "2027-01-15T23:59", cutoff: "2027-01-20T23:59" });
        expect(r.status).toBe("aplicado_verificado");
        expect(a.overrides[0]).toMatchObject({ id: 210, duedate: at("2027-01-15T23:59"), cutoffdate: at("2027-01-20T23:59") });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(a.overrides[0]).toMatchObject({ duedate: at("2027-01-10T23:59"), cutoffdate: 0 });
        const plan = (input: Record<string, unknown>) => h.app.engine.plan("override_edit", { course_id: COURSE, ...input }, "test");
        expect((await errOf(plan({ course_module_id: W2_ASSIGN_CMID, override_id: 210, due: "2027-01-15T23:59", cutoff: "2027-01-12T23:59" }))).message).toMatch(/límite/);
        expect((await errOf(plan({ course_module_id: W2_ASSIGN_CMID, override_id: 210, attempts: 2 }))).message).toMatch(/cuestionarios/);
        expect((await errOf(plan({ course_module_id: W2_ASSIGN_CMID, override_id: 999, due: "2027-01-15T23:59" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan({ quiz_id: QUIZ_ID, course_module_id: W2_ASSIGN_CMID, override_id: 210 }))).message).toMatch(/uno de los dos/);
    });

    it("si Moodle no guarda, sin_efecto", async () => {
        const { h, a } = await harness();
        a.overrides.push({ id: 211, cmid: W2_ASSIGN_CMID, userid: STUDENT_A, allowsubmissionsfromdate: 0, duedate: at("2027-01-10T23:59"), cutoffdate: 0 });
        a.noopEdit = true;
        const r = await run(h, { course_module_id: W2_ASSIGN_CMID, override_id: 211, due: "2027-01-15T23:59" }).catch((e: CampusError) => e.details?.result as { status: string });
        expect(r.status).toBe("sin_efecto");
    });
});
