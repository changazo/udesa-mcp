import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, NOW_UNIX, USER_ID } from "../fixtures/fake-moodle.js";
import { ATT_CMID } from "../fixtures/fake-attendance.js";
import { W2_GROUP } from "../fixtures/fake-w2.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-089: aprobar entradas de glosario, editar sesiones de asistencia y eventos. Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_activity_entries", "take_attendance", "calendar_event"] } } });
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

describe("aprobar y editar existentes (ADR-089)", () => {
    it("aprobar una entrada pendiente de glosario; deshacer la vuelve a pendiente; ya aprobada se rechaza", async () => {
        const { h, acts } = await harness();
        const g = acts.add({ kind: "glossary", name: "Glosario", intro: "", entries: [{ id: 70, concept: "Átomo", definition: "<p>Unidad</p>", approved: false }] });
        const p = await h.app.engine.plan("glossary_entry", { course_id: COURSE, course_module_id: g.id, operation: "approve", entry_id: 70 }, "test");
        expect(p.side_effects.join(" ")).toMatch(/avisar al autor/);
        const r = await h.app.engine.execute(p.plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(g.entries![0]!.approved).toBe(true);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(g.entries![0]!.approved).toBe(false);
        expect((await errOf(h.app.engine.plan("glossary_entry", { course_id: COURSE, course_module_id: g.id, operation: "unapprove", entry_id: 70 }, "test"))).message).toMatch(/ya está/);
    });

    it("si Moodle no cambia el estado, el resultado es sin_efecto", async () => {
        const { h, acts } = await harness();
        const g = acts.add({ kind: "glossary", name: "Glosario", intro: "", entries: [{ id: 71, concept: "Ion", definition: "<p>x</p>", approved: false }] });
        acts.noop = true;
        const r = await run(h, "glossary_entry", { course_module_id: g.id, operation: "approve", entry_id: 71 }).catch((e: CampusError) => e.details?.result as { status: string });
        expect(r.status).toBe("sin_efecto");
    });

    it("cambiar fecha, horario y descripción de una sesión de asistencia; deshacer; horario inválido rechazado", async () => {
        const { h } = await harness();
        const s = [...h.att.sessions.values()].find((x) => x.cmid === ATT_CMID)!;
        const before = { date: s.date, start: s.start, end: s.end };
        const r = await run(h, "attendance_session_edit", { course_module_id: ATT_CMID, session_id: s.id, date: "2026-11-03", start: "10:15", end: "11:45", description: "Clase **práctica**" });
        expect(r.status).toBe("aplicado_verificado");
        expect(s).toMatchObject({ date: "2026-11-03", start: "10:15", end: "11:45", description: "<p>Clase <strong>práctica</strong></p>" });
        expect(h.att.posts.at(-1)).not.toHaveProperty("studentscanmark");
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(s).toMatchObject(before);
        expect((await errOf(h.app.engine.plan("attendance_session_edit", { course_id: COURSE, course_module_id: ATT_CMID, session_id: s.id, start: "12:00", end: "11:00" }, "test"))).message).toMatch(/Horario/);
        expect((await errOf(h.app.engine.plan("attendance_session_edit", { course_id: COURSE, course_module_id: ATT_CMID, session_id: 999999, start: "09:00" }, "test"))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("sesión: si el plugin no guarda, sin_efecto", async () => {
        const { h } = await harness();
        const s = [...h.att.sessions.values()].find((x) => x.cmid === ATT_CMID)!;
        h.att.silentNoop = true;
        const r = await run(h, "attendance_session_edit", { course_module_id: ATT_CMID, session_id: s.id, start: "07:05" }).catch((e: CampusError) => e.details?.result as { status: string });
        expect(r.status).toBe("sin_efecto");
    });

    it("editar nombre, inicio y duración de un evento de grupo; deshacer; los de actividad se rechazan", async () => {
        const { h } = await harness();
        const start = NOW_UNIX - (NOW_UNIX % 60) + 10 * 86_400;
        h.w2.events.set(7001, { id: 7001, name: "Consulta &amp; repaso", description: "<p>Traer dudas</p>", courseid: COURSE, groupid: W2_GROUP, userid: USER_ID, repeatid: 0, eventtype: "group", timestart: start, timeduration: 3600 });
        h.w2.events.set(7002, { id: 7002, name: "Entrega", description: "", courseid: COURSE, groupid: 0, userid: USER_ID, repeatid: 0, eventtype: "due", timestart: start, timeduration: 0 });
        const r = await run(h, "calendar_event_edit", { event_id: 7001, name: "Consulta final", start: "2026-12-01T18:30", duration_minutes: 90 });
        expect(r.status).toBe("aplicado_verificado");
        const fd = new URLSearchParams(h.fake.callsOf("core_calendar_submit_create_update_form").at(-1)!.params.formdata);
        expect(Object.fromEntries(fd)).toMatchObject({ id: "7001", eventtype: "group", groupcourseid: String(COURSE), groupid: String(W2_GROUP), "timestart[hour]": "18", "timestart[minute]": "30", duration: "2", timedurationminutes: "90", "description[text]": "<p>Traer dudas</p>" });
        expect(h.w2.events.get(7001)).toMatchObject({ name: "Consulta final", timeduration: 5400 });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(h.w2.events.get(7001)).toMatchObject({ name: "Consulta & repaso", timestart: start, timeduration: 3600 });
        expect((await errOf(h.app.engine.plan("calendar_event_edit", { course_id: COURSE, event_id: 7002, name: "X" }, "test"))).message).toMatch(/actividad|due/);
    });

    it("el validador sólo admite EDITAR eventos de curso o de grupo", async () => {
        const { isWriteCallAllowed } = await import("../../src/write/functions.js").then((m) => ({ isWriteCallAllowed: (m as Record<string, unknown>).WRITE_FUNCTIONS as Record<string, { validate: (f: [string, string][]) => string | null }> }));
        const v = isWriteCallAllowed.core_calendar_submit_create_update_form!.validate;
        const base = "_qf__core_calendar_local_event_forms_update=1&name=X&timestart%5Bday%5D=1&timestart%5Bmonth%5D=12&timestart%5Byear%5D=2026&timestart%5Bhour%5D=9&timestart%5Bminute%5D=0&description%5Btext%5D=&description%5Bformat%5D=1&duration=0";
        expect(v([["formdata", `id=5&${base}&eventtype=course&courseid=1`]])).toBeNull();
        expect(v([["formdata", `${base}&eventtype=course&courseid=1`]])).not.toBeNull();
        expect(v([["formdata", `id=5&${base}&eventtype=user`]])).not.toBeNull();
        expect(v([["formdata", `id=5&${base}&eventtype=course&courseid=1&repeat=1`]])).not.toBeNull();
        expect(v([["formdata", `id=5&${base}&eventtype=group&groupcourseid=1`]])).not.toBeNull();
    });
});
