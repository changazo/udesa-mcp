import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { SyntheticGroups, G_EXISTING } from "../fixtures/fake-groups.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

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

describe("resumen de una sección (ADR-076)", () => {
    it("cambia y deshace; el nombre se reenvía tal cual", async () => {
        const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["rename_content"] } } });
        const summaries = new Map<number, string>([[101, "<p>Viejo</p>"]]);
        const posts: Record<string, string>[] = [];
        const prev = h.fake.overrides.get("core_course_get_contents")!;
        h.fake.overrides.set("core_course_get_contents", (p) => (prev(p) as { id: number }[]).map((s) => ({ ...s, summary: summaries.get(s.id) ?? "" })));
        h.fake.web.pages.set("/course/editsection.php", (q, req) => {
            if (req.method === "GET") return { body: `<html><body><form action="${SITE}/course/editsection.php" method="post"><input type="hidden" name="id" value="${q.id}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__editsection_form" value="1"><input type="text" name="name" value="Tema 1"><textarea name="summary_editor[text]">${summaries.get(Number(q.id)) ?? ""}</textarea><input type="hidden" name="summary_editor[format]" value="1"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>` };
            const b = new URLSearchParams(req.body ?? "");
            posts.push(Object.fromEntries(b));
            summaries.set(Number(b.get("id")), b.get("summary_editor[text]") ?? "");
            return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
        });
        const r = await exec(h, (await plan(h, "section_summary", { section_number: 1, summary: "Esta semana: **variables**." })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(posts[0]).toMatchObject({ name: "Tema 1", id: "101" });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(summaries.get(101)).toBe("<p>Viejo</p>");
        expect((await errOf(plan(h, "section_summary", { section_number: 1, summary: "Viejo" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "section_summary", { section_number: 9, summary: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });
});

describe("editar un grupo (ADR-076)", () => {
    async function groupHarness(idnumberEditable = true) {
        const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_groups"] } } });
        const g = new SyntheticGroups(h.fake);
        const create = h.fake.web.pages.get("/group/group.php")!;
        h.fake.web.pages.set("/group/group.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const id = Number(q.id ?? b.get("id") ?? 0);
            if (!id) {
                const r = create(q, req);
                return idnumberEditable || req.method !== "GET" ? r : { ...r, body: String(r.body).replace(/<input type="text" name="idnumber" value="">/, "") };
            }
            const grp = g.groups.find((x) => x.id === id)!;
            if (req.method === "GET") return { body: `<html><body><form action="${SITE}/group/group.php" method="post"><input type="hidden" name="id" value="${id}"><input type="hidden" name="courseid" value="${COURSE}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__group_form" value="1"><input type="text" name="name" value="${grp.name}">${idnumberEditable ? `<input type="text" name="idnumber" value="${grp.idnumber}">` : ""}<textarea name="description_editor[text]">${grp.description}</textarea><input type="hidden" name="description_editor[format]" value="1"><input type="hidden" name="enablemessaging" value="0"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>` };
            grp.name = b.get("name") ?? grp.name;
            if (idnumberEditable) grp.idnumber = b.get("idnumber") ?? grp.idnumber;
            grp.description = b.get("description_editor[text]") ?? grp.description;
            return { status: 303, body: null, headers: { location: `${SITE}/group/index.php?id=${COURSE}` } };
        });
        return { h, g };
    }

    it("nombre, ID y descripción; verificado; deshacer", async () => {
        const { h, g } = await groupHarness();
        const r = await exec(h, (await plan(h, "edit_group", { group_id: G_EXISTING, name: "Comisión 1 (mañana)", idnumber: "c1", description: "Turno **mañana**" })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(g.groups[0]).toMatchObject({ name: "Comisión 1 (mañana)", idnumber: "c1" });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(g.groups[0]).toMatchObject({ name: "Comisión 1", idnumber: "" });
        expect((await errOf(plan(h, "edit_group", { group_id: G_EXISTING, name: "Cohorte (sincronizada)" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "edit_group", { group_id: G_EXISTING }))).code).toBe("WRITE_NOT_ALLOWED");
    });

    it("hallazgo real: sin moodle/course:changeidnumber el formulario no trae idnumber → el plan lo rechaza (editar y crear); sin idnumber, se edita igual", async () => {
        const { h } = await groupHarness(false);
        expect((await errOf(plan(h, "edit_group", { group_id: G_EXISTING, idnumber: "c1" }))).code).toBe("MOODLE_PERMISSION_DENIED");
        expect((await errOf(plan(h, "create_group", { name: "Nuevo", idnumber: "x" }))).code).toBe("MOODLE_PERMISSION_DENIED");
        expect((await exec(h, (await plan(h, "edit_group", { group_id: G_EXISTING, name: "Otro nombre" })).plan_id)).status).toBe("aplicado_verificado");
    });
});
