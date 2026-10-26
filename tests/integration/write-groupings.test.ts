import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseGroupingMembers } from "../../src/write/intents/groupings.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** Agrupamientos sintéticos: grouping.php (alta y borrado) y assign.php con el formato real (ids con punto, relleno vacío). */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_groups"] } } });
    const groups = [{ id: 12, courseid: COURSE, name: "Comisión A" }, { id: 13, courseid: COURSE, name: "Comisión B" }];
    const groupings: { id: number; courseid: number; name: string; idnumber: string; members: number[] }[] = [];
    let seq = 2900;
    const state = { addNoop: false };
    h.fake.overrides.set("core_group_get_course_groups", () => groups);
    h.fake.overrides.set("core_group_get_course_groupings", () => groupings.map(({ members: _m, ...g }) => g));
    h.fake.web.pages.set("/group/grouping.php", (q, req) => {
        const b = new URLSearchParams(req.body ?? "");
        if (req.method === "GET") return { body: `<html><body><form action="${SITE}/group/grouping.php" method="post"><input type="hidden" name="id" value=""><input type="hidden" name="courseid" value="${q.courseid}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__grouping_form" value="1"><input type="text" name="name" value=""><input type="text" name="idnumber" value=""><textarea name="description_editor[text]"></textarea><input type="hidden" name="description_editor[format]" value="1"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>` };
        if (b.get("delete") === "1" && b.get("confirm") === "1" && b.get("sesskey") === WEB_SESSKEY) {
            const i = groupings.findIndex((g) => g.id === Number(b.get("id")));
            if (i >= 0) groupings.splice(i, 1);
            return { status: 303, body: null, headers: { location: `${SITE}/group/groupings.php?id=${COURSE}` } };
        }
        groupings.push({ id: seq++, courseid: Number(b.get("courseid")), name: b.get("name") ?? "", idnumber: b.get("idnumber") ?? "", members: [] });
        return { status: 303, body: null, headers: { location: `${SITE}/group/groupings.php?id=${COURSE}` } };
    });
    h.fake.web.pages.set("/group/assign.php", (q, req) => {
        const g = groupings.find((x) => x.id === Number(q.id))!;
        if (req.method === "POST") {
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("add") && !state.addNoop) g.members.push(...b.getAll("addselect[]").map(Number));
            if (b.get("remove")) g.members = g.members.filter((m) => !b.getAll("removeselect[]").map(Number).includes(m));
        }
        const opt = (ids: number[]) => (ids.length ? ids.map((i) => `<option value="${i}." title="g">${groups.find((x) => x.id === i)!.name}</option>`).join("") : "<option>&nbsp;</option>");
        return { body: `<html><body><form id="assignform" method="post" action=""><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><select name="removeselect[]" id="removeselect" multiple>${opt(g.members)}</select><input name="add" type="submit"><input name="remove" type="submit"><select name="addselect[]" id="addselect" multiple>${opt(groups.map((x) => x.id).filter((i) => !g.members.includes(i)))}</select></form></body></html>` };
    });
    return { h, groupings, state };
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

describe("agrupamientos (ADR-074)", () => {
    it("crear, poner y quitar grupos (un POST por grupo), deshacer; con grupos no se borra", async () => {
        const { h, groupings } = await harness();
        const c = await exec(h, (await plan(h, "create_grouping", { name: "Turno mañana" })).plan_id);
        expect(c.status).toBe("aplicado_verificado");
        const gid = c.moodle_ids.grouping_id![0]!;
        const m = await exec(h, (await plan(h, "grouping_groups", { grouping_id: gid, group_ids: [12, 13] })).plan_id);
        expect(m.status).toBe("aplicado_verificado");
        expect(m.items).toHaveLength(2);
        expect(groupings[0]!.members.sort()).toEqual([12, 13]);
        expect((await h.app.engine.planUndo(c.action_id, "test")).undoable).toBe(false);
        const u = await h.app.engine.planUndo(m.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(groupings[0]!.members).toEqual([]);
        const d = await h.app.engine.planUndo(c.action_id, "test");
        if (!d.undoable) throw new Error(d.reason);
        expect((await exec(h, d.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(groupings).toHaveLength(0);
    });

    it("Moodle no agrega → sin_efecto; rechazos: nombre repetido, grupo ajeno, sin cambios", async () => {
        const { h, state } = await harness();
        const gid = (await exec(h, (await plan(h, "create_grouping", { name: "T" })).plan_id)).moodle_ids.grouping_id![0]!;
        expect((await errOf(plan(h, "create_grouping", { name: "t" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "grouping_groups", { grouping_id: gid, group_ids: [99] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "grouping_groups", { grouping_id: gid, group_ids: [] }))).code).toBe("WRITE_NOT_ALLOWED");
        state.addNoop = true;
        expect((await exec(h, (await plan(h, "grouping_groups", { grouping_id: gid, group_ids: [12] })).plan_id)).status).toBe("sin_efecto");
    });

    it("parser: ids con punto, relleno vacío ignorado; una opción irreconocible NO se lee como «sin grupos»", () => {
        const sel = (inner: string) => `<select name="removeselect[]" id="removeselect">${inner}</select>`;
        expect(parseGroupingMembers(sel(`<option value="12345." title="x">E</option><option value="12346.">C</option>`))).toEqual([12345, 12346]);
        expect(parseGroupingMembers(sel("<option>&nbsp;</option>"))).toEqual([]);
        expect(parseGroupingMembers(sel(`<option value="g12345">E</option>`))).toBeNull();
        expect(parseGroupingMembers("<html>login</html>")).toBeNull();
    });
});
