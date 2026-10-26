import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { checkWriteAjax } from "../../src/write/functions.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { W2_ASSIGN_CMID } from "../fixtures/fake-w2.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const CAPS = ["course_visibility", "move_content", "rename_content"];
const harness = async () => {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: CAPS } } });
    // Una segunda tarea en la sección 1, para probar posiciones.
    h.w2.assignments.push({ id: 802, cmid: 9102, name: "TP 2", section: 1, visible: true, duedate: 0, allowsubmissionsfromdate: 0, cutoffdate: 0, gradingduedate: 0, timemodified: 1 });
    return h;
};
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
const ajax = (h: WriteHarness, method: string) => h.fake.web.requests.filter((r) => r.path === "/lib/ajax/service.php" && (JSON.parse(r.body ?? "[]") as { methodname: string }[])[0]?.methodname === method);
const assign = (h: WriteHarness, cmid: number) => h.w2.assignments.find((a) => a.cmid === cmid)!;

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

async function undo(h: WriteHarness, actionId: string) {
    const u = await h.app.engine.planUndo(actionId, "test");
    if (!u.undoable) throw new Error(u.reason);
    return exec(h, u.plan.plan_id);
}

describe("W4 · mostrar u ocultar (§8.9)", () => {
    it("ocultar una actividad: una llamada cm_hide, verificada; deshacer la muestra", async () => {
        const h = await harness();
        const r = await exec(h, (await plan(h, "visibility", { course_module_ids: [W2_ASSIGN_CMID], visible: false })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(assign(h, W2_ASSIGN_CMID).visible).toBe(false);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(assign(h, W2_ASSIGN_CMID).visible).toBe(true);
        expect(ajax(h, "core_courseformat_update_course")).toHaveLength(2);
    });

    it("ocultar una sección oculta sus actividades (advertido) y mostrarla restaura la visibilidad previa; la General no se oculta", async () => {
        const h = await harness();
        assign(h, 9102).visible = false;
        const p = await plan(h, "visibility", { section_numbers: [1], visible: false });
        expect(p.warnings.join(" ")).toMatch(/oculta también sus 2 actividad/);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect([assign(h, W2_ASSIGN_CMID).visible, assign(h, 9102).visible]).toEqual([false, false]);
        await undo(h, r.action_id);
        expect([assign(h, W2_ASSIGN_CMID).visible, assign(h, 9102).visible]).toEqual([true, false]);
        expect((await errOf(plan(h, "visibility", { section_numbers: [0], visible: false }))).code).toBe("WRITE_NOT_ALLOWED");
    });

    it("ya en ese estado → nada que escribir; actividad ajena → RESOURCE_OUT_OF_SCOPE; Moodle que no cambia nada → sin_efecto", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "visibility", { course_module_ids: [W2_ASSIGN_CMID], visible: true }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "visibility", { course_module_ids: [123], visible: false }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        const p = await plan(h, "visibility", { course_module_ids: [W2_ASSIGN_CMID], visible: false });
        h.w2.layoutNoop = true;
        expect((await exec(h, p.plan_id)).status).toBe("sin_efecto");
    });
});

describe("W4 · mover (§8.9)", () => {
    it("mover al final de otra sección y deshacer vuelve al lugar exacto (antes de la siguiente)", async () => {
        const h = await harness();
        const r = await exec(h, (await plan(h, "move_activity", { course_module_id: W2_ASSIGN_CMID, to_section: 2 })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(assign(h, W2_ASSIGN_CMID).section).toBe(2);
        await undo(h, r.action_id);
        const s1 = h.w2.assignments.filter((a) => a.section === 1).map((a) => a.cmid);
        expect(s1).toEqual([W2_ASSIGN_CMID, 9102]);
    });

    it("mover a una sección oculta: advertido; y la verificación lo refleja (la actividad queda oculta)", async () => {
        const h = await harness();
        h.w2.sections[3]!.visible = false;
        const p = await plan(h, "move_activity", { course_module_id: 9102, to_section: 3 });
        expect(p.warnings.join(" ")).toMatch(/OCULTAR la actividad/);
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(assign(h, 9102).visible).toBe(false);
    });

    it("sección inexistente (no se crean) o referencia en otra sección: rechazos en el plan", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "move_activity", { course_module_id: W2_ASSIGN_CMID, to_section: 9 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "move_activity", { course_module_id: W2_ASSIGN_CMID, to_section: 2, before_course_module_id: 9102 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "move_activity", { course_module_id: 9102, to_section: 1 }))).code).toBe("WRITE_NOT_ALLOWED");
    });
});

describe("W4 · renombrar (§8.9)", () => {
    it("actividad: core_course/activityname; sección: componente del formato (format_topics); deshacer vuelve al nombre anterior", async () => {
        const h = await harness();
        const r = await exec(h, (await plan(h, "rename", { course_module_id: W2_ASSIGN_CMID, name: "TP 1 (renombrado)" })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const s = await exec(h, (await plan(h, "rename", { section_number: 2, name: "Unidad 2" })).plan_id);
        expect(s.status).toBe("aplicado_verificado");
        const calls = ajax(h, "core_update_inplace_editable").map((x) => (JSON.parse(x.body!) as { args: Record<string, unknown> }[])[0]!.args);
        expect(calls.map((a) => [a.component, a.itemtype])).toEqual([
            ["core_course", "activityname"],
            ["format_topics", "sectionname"],
        ]);
        await undo(h, r.action_id);
        await undo(h, s.action_id);
        expect(assign(h, W2_ASSIGN_CMID).name).toBe("TP sintético");
        expect(h.w2.sections[2]!.name).toBe("Tema 2");
    });

    it("nombre vacío (Moodle lo ignoraría en silencio) o igual: rechazos en el plan", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "rename", { course_module_id: W2_ASSIGN_CMID, name: "   " }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "rename", { course_module_id: W2_ASSIGN_CMID, name: "TP sintético" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "rename", { course_module_id: W2_ASSIGN_CMID, section_number: 1, name: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
    });
});

describe("W4 · allowlist", () => {
    it("sólo tuplas cerradas: ni acciones libres de update_course ni inplace_editable con otro itemtype o componente", () => {
        const code = (m: string, a: Record<string, unknown>) => {
            try {
                checkWriteAjax(m, a);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        expect(code("core_courseformat_update_course", { action: "cm_hide", courseid: 1, ids: [2] })).toBe("OK");
        expect(code("core_courseformat_update_course", { action: "cm_stealth", courseid: 1, ids: [2] })).toBe("POLICY_DENIED");
        // Duplicar se habilitó en ADR-082, de a una actividad.
        expect(code("core_courseformat_update_course", { action: "cm_duplicate", courseid: 1, ids: [2] })).toBe("OK");
        expect(code("core_courseformat_update_course", { action: "cm_duplicate", courseid: 1, ids: [2, 3] })).toBe("POLICY_DENIED");
        expect(code("core_courseformat_update_course", { action: "cm_hide", courseid: 1, ids: [2, 3] })).toBe("POLICY_DENIED");
        expect(code("core_courseformat_update_course", { action: "cm_move", courseid: 1, ids: [2], targetsectionid: 5 })).toBe("OK");
        expect(code("core_courseformat_update_course", { action: "cm_move", courseid: 1, ids: [2], targetsectionid: 5, targetcmid: 3 })).toBe("POLICY_DENIED");
        expect(code("core_update_inplace_editable", { component: "core_course", itemtype: "activityname", itemid: "5", value: "x" })).toBe("OK");
        expect(code("core_update_inplace_editable", { component: "core_user", itemtype: "user_roles", itemid: "5", value: "[3]" })).toBe("POLICY_DENIED");
        expect(code("core_update_inplace_editable", { component: "core_group", itemtype: "user_groups", itemid: "5", value: "[]" })).toBe("POLICY_DENIED");
        expect(code("core_update_inplace_editable", { component: "core_user", itemtype: "activityname", itemid: "5", value: "x" })).toBe("POLICY_DENIED");
        expect(code("core_update_inplace_editable", { component: "format_topics", itemtype: "sectionname", itemid: "5", value: "" })).toBe("POLICY_DENIED");
    });
});
