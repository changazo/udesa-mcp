import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { checkWriteAjax } from "../../src/write/functions.js";
import { COURSE, STUDENT_A, STUDENT_B } from "../fixtures/fake-moodle.js";
import { G_EXISTING, G_PROTECTED, SyntheticGroups } from "../fixtures/fake-groups.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_groups"] } } });
    return { h, g: new SyntheticGroups(h.fake) };
}
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
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

describe("crear un grupo (§8.11, ADR-058)", () => {
    it("vacío, sin mensajería ni clave; verificado; deshacer lo borra", async () => {
        const { h, g } = await harness();
        const p = await plan(h, "create_group", { name: "Comisión 2", idnumber: "c2", description: "Turno **tarde**" });
        expect(p.risk).toBe("R1");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(g.posts.at(-1)).toMatchObject({ name: "Comisión 2", idnumber: "c2", enablemessaging: "0", enrolmentkey: "" });
        const id = r.moodle_ids.group_id![0]!;
        expect(g.groups.some((x) => x.id === id)).toBe(true);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(g.groups.some((x) => x.id === id)).toBe(false);
    });

    it("nombre o ID repetidos se rechazan en el plan", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, "create_group", { name: "comisión 1" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "create_group", { name: "Otra", idnumber: "coh" }))).code).toBe("WRITE_NOT_ALLOWED");
    });

    it("con miembros, el deshacer no borra (sería R4)", async () => {
        const { h, g } = await harness();
        const r = await exec(h, (await plan(h, "create_group", { name: "Comisión 3" })).plan_id);
        g.members.get(STUDENT_A)!.add(r.moodle_ids.group_id![0]!);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        expect(u.undoable).toBe(false);
        if (!u.undoable) expect(u.reason).toMatch(/R4/);
    });
});

describe("borrar un grupo (ADR-108)", () => {
    const harnessDel = async () => {
        const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_groups", "delete_content"] } } });
        return { h, g: new SyntheticGroups(h.fake) };
    };

    it("con miembros: R4 con confirm_name; borrado verificado; deshacer recrea el grupo vacío con su descripción", async () => {
        const { h, g } = await harnessDel();
        g.groups.find((x) => x.id === G_EXISTING)!.description = "<p>Turno mañana</p>";
        expect((await errOf(plan(h, "delete_group", { group_id: G_EXISTING, confirm_name: "comisión 1" }))).message).toMatch(/no coincide/);
        const p = await plan(h, "delete_group", { group_id: G_EXISTING, confirm_name: "Comisión 1" });
        expect(p.risk).toBe("R4");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(g.groups.some((x) => x.id === G_EXISTING)).toBe(false);
        expect(g.members.get(STUDENT_A)!.size).toBe(0);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect(u.plan.summary).toMatch(new RegExp(`volver a agregar a 1 miembro\\(s\\): ${STUDENT_A}`));
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(g.groups.find((x) => x.name === "Comisión 1")).toMatchObject({ description: "<p>Turno mañana</p>" });
    });

    it("varios grupos de una vez y un agrupamiento con sus grupos (ADR-119): uno por ítem, cada uno con su nombre; sin deshacer automático", async () => {
        const { h, g } = await harnessDel();
        const g2 = (await exec(h, (await plan(h, "create_group", { name: "Comisión 2" })).plan_id)).moodle_ids.group_id![0]!;
        expect((await errOf(plan(h, "delete_group", { groups: [{ group_id: G_EXISTING, confirm_name: "Comisión 1" }, { group_id: g2, confirm_name: "otra" }] }))).message).toMatch(/no coincide/);
        const p = await plan(h, "delete_group", { groups: [{ group_id: G_EXISTING, confirm_name: "Comisión 1" }, { group_id: g2, confirm_name: "Comisión 2" }] });
        expect(p.risk).toBe("R4");
        expect(p.summary).toBe("BORRAR 2 grupo(s) («Comisión 1», «Comisión 2»), con 1 pertenencia(s) de participantes.");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(g.groups.some((x) => x.id === G_EXISTING || x.id === g2)).toBe(false);
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);

        // Agrupamiento con un grupo vacío: R3; se borran el grupo y el agrupamiento.
        const g3 = (await exec(h, (await plan(h, "create_group", { name: "Comisión 3" })).plan_id)).moodle_ids.group_id![0]!;
        const groupings = [{ id: 8653, courseid: COURSE, name: "Turno noche", idnumber: "", members: [g3] }];
        h.fake.overrides.set("core_group_get_course_groupings", () => groupings.map(({ members: _m, ...x }) => x));
        h.fake.web.pages.set("/group/assign.php", (q) => {
            const gr = groupings.find((x) => x.id === Number(q.id));
            const opts = (gr?.members ?? []).map((i) => `<option value="${i}.">g</option>`).join("") || "<option>&nbsp;</option>";
            return { body: `<html><body><form id="assignform" method="post" action=""><select name="removeselect[]" id="removeselect" multiple>${opts}</select></form></body></html>` };
        });
        h.fake.web.pages.set("/group/grouping.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("delete") === "1" && b.get("confirm") === "1") groupings.splice(groupings.findIndex((x) => x.id === Number(b.get("id"))), 1);
            return { status: 303, body: null, headers: { location: `https://campus.example.test/group/groupings.php?id=${COURSE}` } };
        });
        expect((await errOf(plan(h, "delete_group", { grouping_id: 8653, confirm_name: "turno noche" }))).message).toMatch(/agrupamiento/);
        const q = await plan(h, "delete_group", { grouping_id: 8653, confirm_name: "Turno noche" });
        expect(q.risk).toBe("R3");
        expect(q.items.map((i) => i.function)).toEqual(["course_group_delete", "course_grouping_delete"]);
        const r2 = await exec(h, q.plan_id);
        expect(r2.status).toBe("aplicado_verificado");
        expect(groupings).toHaveLength(0);
        expect(g.groups.some((x) => x.id === g3)).toBe(false);
    });

    it("vacío: R3; sin la capacidad de borrado, rechazado; grupo ajeno, fuera de alcance", async () => {
        const { h, g } = await harnessDel();
        g.members.get(STUDENT_A)!.clear();
        expect((await plan(h, "delete_group", { group_id: G_EXISTING, confirm_name: "Comisión 1" })).risk).toBe("R3");
        expect((await errOf(plan(h, "delete_group", { group_id: 999, confirm_name: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        const { h: h2 } = await harness();
        expect((await errOf(plan(h2, "delete_group", { group_id: G_EXISTING, confirm_name: "Comisión 1" }))).code).toBe("WRITE_NOT_ALLOWED");
    });
});

describe("grupos de un participante (§8.11)", () => {
    it("reemplaza el conjunto: plan con antes y después; verificado; deshacer restaura", async () => {
        const { h, g } = await harness();
        const created = await exec(h, (await plan(h, "create_group", { name: "Comisión 2" })).plan_id);
        const g2 = created.moodle_ids.group_id![0]!;
        const p = await plan(h, "group_members", { participant_id: STUDENT_A, group_ids: [g2] });
        const pv = p.payload_preview as { added: number[]; removed: number[] };
        expect(pv).toMatchObject({ added: [g2], removed: [G_EXISTING] });
        expect(p.risk).toBe("R2");
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(g.groupsOf(STUDENT_A)).toEqual([g2]);
        const u = await h.app.engine.planUndo((await h.app.engine.listActions()).actions.at(-1)!.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(g.groupsOf(STUDENT_A)).toEqual([G_EXISTING]);
    });

    it("membresía protegida: Moodle no la quita → aplicado_con_diferencias", async () => {
        const { h } = await harness();
        const r = await exec(h, (await plan(h, "group_members", { participant_id: STUDENT_B, group_ids: [G_EXISTING] })).plan_id);
        expect(r.status).toBe("aplicado_con_diferencias");
    });

    it("rechazos: no matriculado, grupo ajeno, sin cambios", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, "group_members", { participant_id: 999_999, group_ids: [] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "group_members", { participant_id: STUDENT_A, group_ids: [12345] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "group_members", { participant_id: STUDENT_A, group_ids: [G_EXISTING] }))).code).toBe("WRITE_NOT_ALLOWED");
        void G_PROTECTED;
    });

    it("allowlist: user_groups con itemid curso:usuario y arreglo de ids", () => {
        const code = (a: Record<string, unknown>) => {
            try {
                checkWriteAjax("core_update_inplace_editable", a);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        expect(code({ component: "core_group", itemtype: "user_groups", itemid: "1:2", value: "[3,4]" })).toBe("OK");
        expect(code({ component: "core_group", itemtype: "user_groups", itemid: "2", value: "[3]" })).toBe("POLICY_DENIED");
        expect(code({ component: "core_group", itemtype: "user_groups", itemid: "1:2", value: '["x"]' })).toBe("POLICY_DENIED");
        expect(code({ component: "core_user", itemtype: "user_groups", itemid: "1:2", value: "[3]" })).toBe("POLICY_DENIED");
        expect(code({ component: "core_user", itemtype: "user_roles", itemid: "1:2", value: "[3]" })).toBe("POLICY_DENIED");
    });
});
