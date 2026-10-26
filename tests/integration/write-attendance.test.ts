import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { checkWriteRest } from "../../src/write/functions.js";
import { COURSE, SITE, STUDENT_A, STUDENT_B, STUDENT_C } from "../fixtures/fake-moodle.js";
import { ATT_CMID, OTHER_ATT_CMID, ST } from "../fixtures/fake-attendance.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const harness = () => makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["take_attendance", "create_attendance"] } } });
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
const sessionOf = (h: WriteHarness, cmid: number) => [...h.att.sessions.values()].find((s) => s.cmid === cmid)!;

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

describe("W4 · tomar asistencia (§8.7)", () => {
    it("registra por acrónimo, sólo con argumentos admitidos, y lo verifica releyendo el formulario docente", async () => {
        const h = await harness();
        const s = sessionOf(h, ATT_CMID);
        const p = await plan(h, "attendance", { course_module_id: ATT_CMID, session_id: s.id, marks: [{ participant_id: STUDENT_B, status: "p" }] });
        expect(p.risk).toBe("R3");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(s.records.get(STUDENT_B)).toBe(ST.P);
        const call = h.fake.callsOf("tool_mobile_get_content").find((c) => c.params.method === "mobile_view_activity")!;
        const names = Object.entries(call.params).filter(([k]) => /\[name\]$/.test(k)).map(([, v]) => v);
        expect(names.sort()).toEqual(["appversioncode", "cmid", "courseid", "sessid", `status${STUDENT_B}`].sort());
        // Sin estado previo no se puede «borrar» un registro: deshacer declarado como ninguno.
        expect(await h.app.engine.planUndo(r.action_id, "test")).toMatchObject({ undoable: false });
    });

    it("retomar advierte que se borran las observaciones; deshacer vuelve al estado anterior", async () => {
        const h = await harness();
        const s = sessionOf(h, ATT_CMID);
        const p = await plan(h, "attendance", { course_module_id: ATT_CMID, session_id: s.id, marks: [{ participant_id: STUDENT_A, status: "FI" }] });
        expect(p.warnings.join(" ")).toMatch(/borra sus observaciones/);
        expect(p.side_effects.join(" ")).toMatch(/BORRA las observaciones/);
        const r = await exec(h, p.plan_id);
        expect(s.records.get(STUDENT_A)).toBe(ST.FI);
        expect(s.remarks.get(STUDENT_A)).toBe("");
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(s.records.get(STUDENT_A)).toBe(ST.P);
    });

    it("rechazos en el plan: sesión de otra actividad, estado inexistente, alumno fuera del padrón, sin cambios, umbrales de aviso", async () => {
        const h = await harness();
        const s = sessionOf(h, ATT_CMID);
        const other = sessionOf(h, OTHER_ATT_CMID);
        expect((await errOf(plan(h, "attendance", { course_module_id: ATT_CMID, session_id: other.id, marks: [{ participant_id: STUDENT_A, status: "P" }] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "attendance", { course_module_id: ATT_CMID, session_id: s.id, marks: [{ participant_id: STUDENT_B, status: "A" }] }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "attendance", { course_module_id: ATT_CMID, session_id: s.id, marks: [{ participant_id: STUDENT_C, status: "P" }] }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "attendance", { course_module_id: ATT_CMID, session_id: s.id, marks: [{ participant_id: STUDENT_A, status: "P" }] }))).code).toBe("WRITE_NOT_ALLOWED");
        h.att.warningsConfigured = true;
        const e = await errOf(plan(h, "attendance", { course_module_id: ATT_CMID, session_id: s.id, marks: [{ participant_id: STUDENT_B, status: "P" }] }));
        expect(e.message).toMatch(/umbrales de aviso/);
        expect(h.fake.callsOf("tool_mobile_get_content").some((c) => c.params.method === "mobile_view_activity")).toBe(false);
    });

    it("«éxito» sin escribir nada → sin_efecto", async () => {
        const h = await harness();
        const s = sessionOf(h, ATT_CMID);
        h.att.silentNoop = true;
        expect((await exec(h, (await plan(h, "attendance", { course_module_id: ATT_CMID, session_id: s.id, marks: [{ participant_id: STUDENT_B, status: "R" }] })).plan_id)).status).toBe("sin_efecto");
    });

    it("allowlist de escritura: sólo mobile_view_activity con cmid/courseid/sessid/status*; otro método o argumento, rechazado", () => {
        const code = (flat: [string, string][]) => {
            try {
                checkWriteRest("tool_mobile_get_content", flat, SITE);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        const args = (pairs: [string, string][]) => pairs.flatMap(([n, v], i) => [[`args[${i}][name]`, n], [`args[${i}][value]`, v]] as [string, string][]);
        const base: [string, string][] = [["component", "mod_attendance"], ["method", "mobile_view_activity"]];
        expect(code([...base, ...args([["cmid", "1"], ["courseid", "2"], ["sessid", "3"], ["status5", "11"]])])).toBe("OK");
        expect(code([...base, ...args([["cmid", "1"], ["courseid", "2"], ["sessid", "3"]])])).toBe("POLICY_DENIED");
        expect(code([...base, ...args([["cmid", "1"], ["courseid", "2"], ["sessid", "3"], ["status5", "11"], ["remarks5", "x"]])])).toBe("POLICY_DENIED");
        expect(code([["component", "mod_attendance"], ["method", "mobile_teacher_form"], ...args([["cmid", "1"], ["courseid", "2"], ["sessid", "3"], ["status5", "11"]])])).toBe("POLICY_DENIED");
        expect(code([["component", "mod_quiz"], ["method", "mobile_view_activity"], ...args([["cmid", "1"], ["courseid", "2"], ["sessid", "3"], ["status5", "11"]])])).toBe("POLICY_DENIED");
    });
});

describe("W4/W6 · sesiones y módulos de asistencia", () => {
    it("agregar sesión: casillas en 0 se OMITEN (el plugin usa isset); verificada; deshacer la borra", async () => {
        const h = await harness();
        const p = await plan(h, "attendance_session", { course_module_id: ATT_CMID, date: "2026-10-23", start: "10:00", end: "11:30" });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const post = h.att.posts.at(-1)!;
        for (const k of ["addmultiply", "studentscanmark", "autoassignstatus", "calendarevent"]) expect(post, k).not.toHaveProperty(k);
        expect(post).toMatchObject({ "sessiondate[day]": "23", "sestime[endminute]": "30", sessiontype: "0" });
        const created = [...h.att.sessions.values()].find((s) => s.date === "2026-10-23")!;
        expect(r.moodle_ids.session_id).toEqual([created.id]);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(h.att.sessions.has(created.id)).toBe(false);
    });

    it("agregar sesión: horario inválido o duplicado, rechazos en el plan", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "attendance_session", { course_module_id: ATT_CMID, date: "2026-10-23", start: "11:00", end: "10:00" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "attendance_session", { course_module_id: ATT_CMID, date: "2026-10-20", start: "19:00", end: "20:00" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "attendance_session", { course_module_id: 12345, date: "2026-10-23", start: "10:00", end: "11:00" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("lista de sesiones con filas no interpretadas: no se planifica a ciegas (mismo parser que la lectura)", async () => {
        const h = await harness();
        h.att.extraManageRows = `<tr><td><input type="checkbox" value="77" name="sesiones[]" /></td><td><a href="${SITE}/mod/attendance/take.php?id=${ATT_CMID}&amp;sessionid=77">lun 26 oct 2026</a></td><td>10AM - 11AM</td><td>x</td><td>x</td></tr>`;
        expect((await errOf(plan(h, "attendance_session", { course_module_id: ATT_CMID, date: "2026-10-23", start: "10:00", end: "11:30" }))).code).toBe("UNEXPECTED_RESPONSE");
    });

    it("crear el módulo: oculto, sin nota y sin notificar; deshacer lo borra", async () => {
        const h = await harness();
        const p = await plan(h, "create_attendance", { name: "Asistencia nueva", section: 1 });
        expect(p.risk).toBe("R1");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.att.posts.at(-1)).toMatchObject({ coursecontentnotification: "0", visible: "0", "grade[modgrade_type]": "none" });
        const cmid = r.moodle_ids.cmid![0]!;
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(h.w2.extraModules.some((m) => m.id === cmid)).toBe(false);
    });
});

describe("borrar una sesión existente (ADR-084)", () => {
    it("una sesión que no creó el MCP se borra con su propio plan (R3, sin deshacer); una ajena se rechaza", async () => {
        const h = await harness();
        const add = await exec(h, (await plan(h, "attendance_session", { course_module_id: ATT_CMID, date: "2026-10-23", start: "10:00", end: "11:30" })).plan_id);
        const sid = add.moodle_ids.session_id![0]!;
        const p = await plan(h, "attendance_session_delete", { course_module_id: ATT_CMID, session_id: sid });
        expect(p.risk).toBe("R3");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.att.sessions.has(sid)).toBe(false);
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);
        await expect(plan(h, "attendance_session_delete", { course_module_id: ATT_CMID, session_id: 999_999 })).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
        // ADR-119: una sesión con asistencia tomada se borra como R4.
        const taken = (await exec(h, (await plan(h, "attendance_session", { course_module_id: ATT_CMID, date: "2026-10-24", start: "10:00", end: "11:30" })).plan_id)).moodle_ids.session_id![0]!;
        h.att.sessions.get(taken)!.records.set(1, 1);
        expect((await plan(h, "attendance_session_delete", { course_module_id: ATT_CMID, session_id: taken })).risk).toBe("R4");
    });
});
