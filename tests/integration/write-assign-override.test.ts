import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseOverrideIds } from "../../src/write/intents/assign-override.js";
import { COURSE, STUDENT_A, STUDENT_B } from "../fixtures/fake-moodle.js";
import { DUE, W2_ASSIGN_CMID } from "../fixtures/fake-w2.js";
import { SyntheticAssignOverrides } from "../fixtures/fake-assign-override.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["assign_override"] } } });
    return { h, o: new SyntheticAssignOverrides(h.fake, h.w2) };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("assign_override", { course_id: COURSE, course_module_id: W2_ASSIGN_CMID, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
const local = (unix: number) => new Date(unix * 1000 - 3 * 3600_000).toISOString().slice(0, 16);
const minute = (unix: number) => Math.floor(unix / 60) * 60;

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("excepción de una tarea para un participante (§8.8, ADR-066)", () => {
    it("crea con vencimiento propio (el resto, el de la tarea); verificado por el formulario; deshacer la borra", async () => {
        const { h, o } = await harness();
        const due = minute(DUE + 3 * 86_400);
        const p = await plan(h, { participant_id: STUDENT_A, due: local(due) });
        expect(p.risk).toBe("R2");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(o.overrides).toHaveLength(1);
        expect(o.overrides[0]).toMatchObject({ userid: STUDENT_A, duedate: due });
        expect(r.moodle_ids.override_id).toEqual([o.overrides[0]!.id]);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(o.overrides).toHaveLength(0);
    });

    it("si el participante ya tiene excepción se rechaza (Moodle la fusionaría y borraría); la de otro no molesta", async () => {
        const { h, o } = await harness();
        o.overrides.push({ id: 1, cmid: W2_ASSIGN_CMID, userid: STUDENT_A, allowsubmissionsfromdate: 0, duedate: DUE + 86_400, cutoffdate: 0 });
        expect((await errOf(plan(h, { participant_id: STUDENT_A, due: local(DUE + 2 * 86_400) }))).message).toMatch(/ya tiene una excepción \(1\)/);
        expect((await exec(h, (await plan(h, { participant_id: STUDENT_B, due: local(DUE + 2 * 86_400) })).plan_id)).status).toBe("aplicado_verificado");
        expect(o.overrides.map((x) => x.userid).sort()).toEqual([STUDENT_A, STUDENT_B].sort());
    });

    it("rechazos: sin fechas, iguales a la tarea, no matriculado, orden, tarea ajena", async () => {
        const { h } = await harness();
        const code = async (i: Record<string, unknown>) => (await errOf(plan(h, i))).code;
        expect(await code({ participant_id: STUDENT_A })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ participant_id: STUDENT_A, due: local(DUE) })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ participant_id: 999_999, due: local(DUE + 86_400) })).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await code({ participant_id: STUDENT_A, due: local(DUE + 86_400), cutoff: local(DUE) })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ participant_id: STUDENT_A, due: local(DUE + 86_400), course_module_id: 4242 })).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("Moodle guarda otra fecha → aplicado_con_diferencias", async () => {
        const { h, o } = await harness();
        o.shiftDue = 3600;
        expect((await exec(h, (await plan(h, { participant_id: STUDENT_A, due: local(DUE + 86_400) })).plan_id)).status).toBe("aplicado_con_diferencias");
    });

    it("la lista: «no hay» → []; el enlace de alta (cmid=) no cuenta como id; página irreconocible → null", () => {
        expect(parseOverrideIds(`<a href="/mod/assign/overrideedit.php?action=adduser&amp;cmid=5">x</a><div role="main">Actualmente no hay anulaciones.</div>`)).toEqual([]);
        expect(parseOverrideIds(`<div role="main"><a href="/mod/assign/overrideedit.php?action=adduser&amp;cmid=5">x</a><a href="/mod/assign/overrideedit.php?id=7&amp;action=edit">e</a></div>`)).toEqual([7]);
        expect(parseOverrideIds("<html>login</html>")).toBeNull();
    });
});

describe("excepción de una tarea para un grupo (ADR-073)", () => {
    it("addgroup con groupid; la de usuario no cuenta como duplicado; segunda de grupo rechazada; deshacer", async () => {
        const { h, o } = await harness();
        h.fake.overrides.set("core_group_get_course_groups", () => [{ id: 12, courseid: COURSE, name: "Comisión A" }]);
        o.overrides.push({ id: 1, cmid: W2_ASSIGN_CMID, userid: STUDENT_A, allowsubmissionsfromdate: 0, duedate: DUE + 86_400, cutoffdate: 0 });
        const r = await exec(h, (await plan(h, { group_id: 12, due: local(DUE + 2 * 86_400) })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(o.posts.at(-1)).toMatchObject({ action: "addgroup", groupid: "12" });
        expect(o.posts.at(-1)).not.toHaveProperty("userid");
        expect((await errOf(plan(h, { group_id: 12, due: local(DUE + 3 * 86_400) }))).message).toMatch(/El grupo ya tiene/);
        expect((await errOf(plan(h, { group_id: 99, due: local(DUE + 3 * 86_400) }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, { group_id: 12, participant_id: STUDENT_A, due: local(DUE + 3 * 86_400) }))).code).toBe("WRITE_NOT_ALLOWED");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(o.overrides.map((x) => x.id)).toEqual([1]);
    });
});

describe("borrar una excepción existente (ADR-084)", () => {
    it("borra la excepción de un participante; una inexistente se rechaza", async () => {
        const { h, o } = await harness();
        const add = await exec(h, (await plan(h, { participant_id: STUDENT_A, due: local(minute(DUE + 3 * 86_400)) })).plan_id);
        const id = add.moodle_ids.override_id![0]!;
        const del = (input: Record<string, unknown>) => h.app.engine.plan("assign_override_delete", { course_id: COURSE, course_module_id: W2_ASSIGN_CMID, ...input }, "test");
        const r = await exec(h, (await del({ override_id: id, kind: "user" })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(o.overrides).toHaveLength(0);
        await expect(del({ override_id: 4242, kind: "user" })).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
    });
});
