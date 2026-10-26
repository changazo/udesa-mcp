import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, NOW_UNIX, USER_ID } from "../fixtures/fake-moodle.js";
import { W2_GROUP } from "../fixtures/fake-w2.js";
import { makeWriteHarness } from "../fixtures/write-harness.js";

/** ADR-083: eventos de grupos ajenos (sólo por la vista mensual), borrar un evento existente y guardas de Turnitin. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["calendar_event", "delete_content", "rename_content"] } } });
    const start = NOW_UNIX + 10 * 86_400;
    h.w2.events.set(7001, { id: 7001, name: "Consulta del grupo", description: "<p>Traer dudas</p>", courseid: COURSE, groupid: W2_GROUP, userid: USER_ID, repeatid: 0, eventtype: "group", timestart: start, timeduration: 3600 });
    h.w2.events.set(7002, { id: 7002, name: "Entrega TP", description: "", courseid: COURSE, groupid: 0, userid: USER_ID, repeatid: 0, eventtype: "due", timestart: start, timeduration: 0 });
    return { h, start };
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

describe("eventos de grupo y borrar eventos existentes (ADR-083)", () => {
    it("campus_list_events ve el evento de un grupo del que la cuenta no es miembro (vista mensual)", async () => {
        const { h } = await harness();
        const r = await h.app.read.service.listEvents({ course_id: COURSE });
        const ev = (r.data as { events: { event_id: number; type: string; group_id: number | null }[] }).events.find((e) => e.event_id === 7001);
        expect(ev).toMatchObject({ type: "group", group_id: W2_GROUP });
        expect(h.fake.callsOf("core_calendar_get_calendar_monthly_view").length).toBeGreaterThan(0);
    });

    it("borrar un evento de grupo existente; deshacer lo vuelve a crear igual; los de actividad se rechazan", async () => {
        const { h, start } = await harness();
        const p = await h.app.engine.plan("calendar_event_delete", { course_id: COURSE, event_id: 7001 }, "test");
        const r = await h.app.engine.execute(p.plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(h.w2.events.has(7001)).toBe(false);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await h.app.engine.execute(u.plan.plan_id, h.confirmer, "test")).status).toBe("aplicado_verificado");
        const back = [...h.w2.events.values()].find((e) => e.name === "Consulta del grupo")!;
        expect(back).toMatchObject({ groupid: W2_GROUP, eventtype: "group", timestart: start, timeduration: 3600, description: "<p>Traer dudas</p>" });
        expect((await errOf(h.app.engine.plan("calendar_event_delete", { course_id: COURSE, event_id: 7002 }, "test"))).message).toMatch(/actividad|due/);
        expect((await errOf(h.app.engine.plan("calendar_event_delete", { course_id: COURSE, event_id: 9999 }, "test"))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("Turnitin: ni borrar ni renombrar; tampoco borrar una sección que lo contiene", async () => {
        const { h } = await harness();
        h.w2.extraModules.push({ id: 7101, modname: "turnitintooltwo", name: "TII", section: 2, visible: true });
        expect((await errOf(h.app.engine.plan("delete_content", { course_id: COURSE, course_module_id: 7101, confirm_name: "TII" }, "test"))).message).toMatch(/Turnitin/);
        expect((await errOf(h.app.engine.plan("rename", { course_id: COURSE, course_module_id: 7101, name: "Otro" }, "test"))).message).toMatch(/Turnitin/);
        const section = h.w2.sections.find((s) => s.section === 2)!;
        expect((await errOf(h.app.engine.plan("delete_content", { course_id: COURSE, section_number: 2, confirm_name: section.name }, "test"))).message).toMatch(/Turnitin/);
    });
});
