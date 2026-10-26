import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-085: reordenar secciones y capítulos, editar agrupamientos, aprobar entradas. Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["move_content", "manage_groups", "manage_activity_entries"] } } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    return { h, acts };
}
const run = async (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test")).plan_id, h.confirmer, "test");
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

describe("reordenar y aprobar (ADR-085)", () => {
    it("mover una sección después de otra (se renumeran); deshacer vuelve al orden; la General no se mueve", async () => {
        const { h } = await harness();
        const ids = () => h.w2.sections.map((s) => s.id);
        expect(ids()).toEqual([100, 101, 102, 103]);
        const r = await run(h, "move_section", { section_number: 3, after_section_number: 1 });
        expect(r.status).toBe("aplicado_verificado");
        expect(ids()).toEqual([100, 101, 103, 102]);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(ids()).toEqual([100, 101, 102, 103]);
        expect((await errOf(h.app.engine.plan("move_section", { course_id: COURSE, section_number: 2, after_section_number: 1 }, "test"))).message).toMatch(/ya está/);
    });

    it("mover un capítulo arriba y deshacer; el primero no sube", async () => {
        const { h, acts } = await harness();
        const b = acts.add({ kind: "book", name: "Libro", intro: "", chapters: [{ id: 1, title: "Uno", sub: false, hidden: false, content: "" }, { id: 2, title: "Dos", sub: false, hidden: false, content: "" }] });
        const r = await run(h, "book_chapter", { course_module_id: b.id, operation: "move_up", chapter_id: 2 });
        expect(r.status).toBe("aplicado_verificado");
        expect(b.chapters!.map((c) => c.id)).toEqual([2, 1]);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(b.chapters!.map((c) => c.id)).toEqual([1, 2]);
        expect((await errOf(h.app.engine.plan("book_chapter", { course_id: COURSE, course_module_id: b.id, operation: "move_up", chapter_id: 1 }, "test"))).message).toMatch(/primer/);
    });

    it("desaprobar y aprobar una entrada de base de datos; ya en ese estado se rechaza", async () => {
        const { h, acts } = await harness();
        const d = acts.add({ kind: "data", name: "DB", intro: "", fields: [{ id: 1, name: "T", type: "text", required: false }], records: [{ id: 50, values: { 1: "x" }, approved: true }] });
        const r = await run(h, "data_entry", { course_module_id: d.id, operation: "unapprove", entry_id: 50 });
        expect(r.status).toBe("aplicado_verificado");
        expect(d.records![0]!.approved).toBe(false);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(d.records![0]!.approved).toBe(true);
        expect((await errOf(h.app.engine.plan("data_entry", { course_id: COURSE, course_module_id: d.id, operation: "approve", entry_id: 50 }, "test"))).message).toMatch(/ya está/);
    });

    it("editar nombre y descripción de un agrupamiento; deshacer; nombre repetido rechazado", async () => {
        const { h } = await harness();
        const groupings = [
            { id: 31, courseid: COURSE, name: "Comisiones", idnumber: "", description: "<p>Vieja</p>" },
            { id: 32, courseid: COURSE, name: "Turnos", idnumber: "", description: "" },
        ];
        h.fake.overrides.set("core_group_get_course_groupings", () => groupings);
        h.fake.web.pages.set("/group/grouping.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const g = groupings.find((x) => x.id === Number(q.id ?? b.get("id")))!;
            if (req.method === "GET") return { body: `<html><body><form action="${SITE}/group/grouping.php" method="post"><input type="hidden" name="id" value="${g.id}"><input type="hidden" name="courseid" value="${COURSE}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__grouping_form" value="1"><input type="text" name="name" value="${g.name}"><textarea name="description_editor[text]">${g.description}</textarea><input type="hidden" name="description_editor[format]" value="1"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>` };
            Object.assign(g, { name: b.get("name") ?? g.name, description: b.get("description_editor[text]") ?? g.description });
            return { status: 303, body: null, headers: { location: `${SITE}/group/groupings.php?id=${COURSE}` } };
        });
        const r = await run(h, "edit_grouping", { grouping_id: 31, name: "Comisiones 2026", description: "Para **TP**" });
        expect(r.status).toBe("aplicado_verificado");
        expect(groupings[0]).toMatchObject({ name: "Comisiones 2026", description: "<p>Para <strong>TP</strong></p>" });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(groupings[0]).toMatchObject({ name: "Comisiones", description: "<p>Vieja</p>" });
        expect((await errOf(h.app.engine.plan("edit_grouping", { course_id: COURSE, grouping_id: 31, name: "turnos" }, "test"))).message).toMatch(/Ya hay/);
    });
});
