import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { W2_GROUP } from "../fixtures/fake-w2.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-103: grupos y cupos de una elección de grupo. Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_activity"] } } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    const c = acts.add({ kind: "choicegroup", name: "Elección", intro: "", groups: [W2_GROUP] });
    return { h, acts, c };
}
const run = async (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan("choicegroup_groups", { course_id: COURSE, ...input }, "test")).plan_id, h.confirmer, "test");
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("grupos y cupos de una elección de grupo (ADR-103)", () => {
    it("agrega un grupo con cupos, deshace y vuelve a la lista anterior", async () => {
        const { h, c } = await harness();
        const r = await run(h, { course_module_id: c.id, groups: [{ group_id: W2_GROUP, limit: 3 }, { group_id: 13, limit: 5 }] });
        expect(r.status).toBe("aplicado_verificado");
        expect(c).toMatchObject({ groups: [W2_GROUP, 13], limitanswers: true, limits: { [W2_GROUP]: 3, 13: 5 } });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await h.app.engine.execute(u.plan.plan_id, h.confirmer, "test")).status).toBe("aplicado_verificado");
        expect(c).toMatchObject({ groups: [W2_GROUP], limitanswers: false });
    });

    it("sólo desactivar cupos conserva los grupos y sus cupos", async () => {
        const { h, c } = await harness();
        await run(h, { course_module_id: c.id, groups: [{ group_id: W2_GROUP, limit: 4 }] });
        const r = await run(h, { course_module_id: c.id, limit_answers: false });
        expect(r.status).toBe("aplicado_verificado");
        expect(c).toMatchObject({ groups: [W2_GROUP], limitanswers: false, limits: { [W2_GROUP]: 4 } });
    });

    it("rechaza grupos ajenos, otra actividad y cambios nulos", async () => {
        const { h, acts, c } = await harness();
        expect((await errOf(h.app.engine.plan("choicegroup_groups", { course_id: COURSE, course_module_id: c.id, groups: [{ group_id: 999 }] }, "test"))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        const other = acts.add({ kind: "choice", name: "Consulta", intro: "", options: [] });
        expect((await errOf(h.app.engine.plan("choicegroup_groups", { course_id: COURSE, course_module_id: other.id, limit_answers: true }, "test"))).message).toMatch(/no es una elección de grupo/);
        expect((await errOf(h.app.engine.plan("choicegroup_groups", { course_id: COURSE, course_module_id: c.id, groups: [{ group_id: W2_GROUP }] }, "test"))).message).toMatch(/ya está así/);
    });
});
