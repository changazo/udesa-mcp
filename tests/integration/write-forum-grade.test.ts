import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { checkWriteAjax } from "../../src/write/functions.js";
import { COURSE, STUDENT_A } from "../fixtures/fake-moodle.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const CM = 9302;
const CTX = 8652;
async function harness(max = 10, notifiable: number[] = []) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["grade_forum"] }, notifiable_user_ids: notifiable } });
    h.w2.extraModules.push({ id: CM, modname: "forum", name: "Debate", section: 1, visible: true, contextid: CTX });
    h.fake.overrides.set("mod_forum_get_forums_by_courses", () => [{ id: 3302, cmid: CM, course: COURSE, name: "Debate", grade_forum: max }]);
    const grades = new Map<number, number>();
    const stores: Record<string, unknown>[] = [];
    const state = { noop: false };
    h.fake.web.ajax.set("core_grades_grader_gradingpanel_point_fetch", (a) => {
        if (a.contextid !== CTX) throw Object.assign(new Error("ctx"), { errorcode: "invalidcontext" });
        const g = grades.get(Number(a.gradeduserid));
        return { templatename: "x", hasgrade: g !== undefined, grade: { grade: g ?? null, maxgrade: max }, warnings: [] };
    });
    h.fake.web.ajax.set("core_grades_grader_gradingpanel_point_store", (a) => {
        stores.push(a);
        const m = /^grade=(.*)$/.exec(String(a.formdata))!;
        if (!state.noop) {
            if (m[1] === "") grades.delete(Number(a.gradeduserid));
            else grades.set(Number(a.gradeduserid), Number(m[1]));
        }
        return { templatename: "x", hasgrade: grades.has(Number(a.gradeduserid)), grade: {}, warnings: [] };
    });
    return { h, grades, stores, state };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("forum_grade", { course_id: COURSE, course_module_id: CM, participant_id: STUDENT_A, ...input }, "test");
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

describe("calificar el foro completo (ADR-070)", () => {
    it("pone la nota sin notificar (notifyuser=false); verificada; deshacer la limpia", async () => {
        const { h, grades, stores } = await harness();
        const p = await plan(h, { grade: 7.5 });
        expect(p.risk).toBe("R3");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(grades.get(STUDENT_A)).toBe(7.5);
        expect(stores[0]).toMatchObject({ notifyuser: false, formdata: "grade=7.5", component: "mod_forum", itemname: "forum" });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(grades.has(STUDENT_A)).toBe(false);
        expect(stores[1]).toMatchObject({ formdata: "grade=" });
    });

    it("rechazos: foro sin calificación o con escala, nota mayor al máximo, igual a la actual, no matriculado", async () => {
        expect((await errOf(plan((await harness(0)).h, { grade: 5 }))).message).toMatch(/no tiene calificación/);
        expect((await errOf(plan((await harness(-3)).h, { grade: 5 }))).message).toMatch(/escala/);
        const { h, grades } = await harness();
        expect((await errOf(plan(h, { grade: 11 }))).code).toBe("WRITE_NOT_ALLOWED");
        grades.set(STUDENT_A, 4);
        expect((await errOf(plan(h, { grade: 4 }))).message).toMatch(/ya es la nota/);
        expect((await errOf(plan(h, { grade: 4, participant_id: 999_999 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("Moodle no guarda → sin_efecto", async () => {
        const { h, state } = await harness();
        state.noop = true;
        expect((await exec(h, (await plan(h, { grade: 3 })).plan_id)).status).toBe("sin_efecto");
    });

    it("aviso al estudiante (ADR-120): sólo a una cuenta de prueba del sandbox; notifyuser=true", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, { grade: 6, notify_student: true }))).message).toMatch(/no está permitido/);
        const t = await harness(10, [STUDENT_A]);
        const p = await plan(t.h, { grade: 6, notify_student: true });
        expect(p.payload_preview).toMatchObject({ notify_student: true });
        expect((await exec(t.h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(t.stores[0]).toMatchObject({ notifyuser: true });
    });

    it("allowlist: notifyuser no booleano, otro componente o formdata con más campos, rechazados", () => {
        const code = (a: Record<string, unknown>) => {
            try {
                checkWriteAjax("core_grades_grader_gradingpanel_point_store", a);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        const base = { component: "mod_forum", contextid: 5, itemname: "forum", gradeduserid: 7, notifyuser: false, formdata: "grade=3" };
        expect(code(base)).toBe("OK");
        expect(code({ ...base, notifyuser: "true" })).toBe("POLICY_DENIED");
        expect(code({ ...base, component: "mod_assign" })).toBe("POLICY_DENIED");
        expect(code({ ...base, formdata: "grade=3&feedback=x" })).toBe("POLICY_DENIED");
    });
});
