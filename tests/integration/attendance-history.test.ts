import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseManagedSessions, parseSessionDate, parseSessionTimes } from "../../src/domain/attendance.js";
import { assertWebRoute } from "../../src/web/policy.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { COURSE, SITE, STUDENT_A, STUDENT_B, STUDENT_C, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";

const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
const web = () => new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" });
const CMID = 9403;

/** Fila de manage.php como la arma el plugin 2025122100 (sesión tomada: fecha y hora enlazan a take.php). */
function row(id: number, date: string, time: string, opts: { taken?: boolean; italic?: boolean; type?: string; desc?: string } = {}) {
    const take = `${SITE}/mod/attendance/take.php?id=${CMID}&amp;sessionid=${id}&amp;grouptype=0`;
    const wrap = (s: string) => (opts.taken ? `<a title="Cambiar asistencia" href="${take}"><nobr>${s}</nobr></a>` : opts.italic ? `<i><nobr>${s}</nobr></i>` : `<nobr>${s}</nobr>`);
    return `<tr class=""><td class="cell c0"><input class="attendancesesscheckbox" type="checkbox" value="${id}" name="sessid[]" /></td><td class="cell c1">${wrap(date)}</td><td class="cell c2">${wrap(time)}</td><td class="cell c3">${opts.type ?? "Todos los estudiantes"}</td><td class="cell c4"><div class="text_to_html">${opts.desc ?? "Sesión de Clase Normal"}</div></td><td class="cell c5 lastcol">${opts.taken ? '<img src="x/attendance/1/redo" />' : '<i class="icon fa fa-play"></i>'}</td></tr>`;
}
const MANAGE = `<html><body><div class="attsessions_manage_table"><form><div class="generalbox"><table class="generaltable"><thead><tr><th>x</th></tr></thead><tbody>${[
    row(501, "lun 3 ago 2026", "12AM", { taken: true }),
    row(502, "vie 7 ago 2026", "9AM - 1:15PM", { taken: true, desc: "Problemas" }),
    row(503, "lun 14 sept 2026", "2:30PM - 4PM", { italic: true }),
    row(504, "mié 27 ene 2027", "9AM - 1:15PM"),
].join("")}</tbody></table></div></form></div></body></html>`;

async function setup(page = MANAGE) {
    const h = await makeHarness({ webSource: web() });
    h.fake.web.pages.set("/mod/attendance/manage.php", () => ({ body: page }));
    return h;
}
async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("historial de asistencia (ADR-040)", () => {
    it("lista sesiones por la web y lee cada sesión tomada con el formulario móvil, con totales por alumno", async () => {
        const h = await setup();
        const r = await h.app.service.getAttendance({ course_id: COURSE, include_history: true });
        const hist = r.data.activities[0]!.history!;
        expect(hist).toMatchObject({ sessions_listed: 4, sessions_taken: 3, sessions_in_range: 3, sessions_read: 3 });
        expect(hist.sessions.map((s) => [s.session_id, s.date, s.start_time, s.end_time])).toEqual([
            [501, "2026-08-03", "00:00", null],
            [502, "2026-08-07", "09:00", "13:15"],
            [503, "2026-09-14", "14:30", "16:00"],
        ]);
        expect(hist.sessions[0]!.records).toEqual([
            { participant_id: STUDENT_A, status: "P" },
            { participant_id: STUDENT_B, status: "A" },
            { participant_id: STUDENT_C, status: null },
        ]);
        expect(hist.by_student.find((s) => s.participant_id === STUDENT_A)).toMatchObject({ name: "Ana Sintética", counts: { P: 3 }, sessions_recorded: 3 });
        expect(hist.by_student.find((s) => s.participant_id === STUDENT_C)).toMatchObject({ counts: {}, sessions_recorded: 0 });
        // La lista se pidió con la vista y el tipo de sesión cerrados; nunca «from».
        const req = h.fake.web.requests.find((x) => x.path === "/mod/attendance/manage.php")!;
        expect(req.query).toEqual({ id: String(CMID), view: "5", group: "-1" });
        // Ningún argumento de escritura a la app móvil; una consulta por sesión tomada (más la ventana).
        for (const a of h.fake.mobileArgs) expect(Object.keys(a).filter((k) => /^status/.test(k))).toEqual([]);
        expect(h.fake.mobileArgs.filter((a) => a.sessid && ["501", "502", "503"].includes(a.sessid))).toHaveLength(3);
        expect(r.source).toMatchObject({ adapter: "web_html" });
    });

    it("filtro por fechas y recorte a las más recientes, declarados", async () => {
        const h = await setup();
        const r = await h.app.service.getAttendance({ course_id: COURSE, include_history: true, from: "2026-08-05", to: "2026-12-31" });
        expect(r.data.activities[0]!.history!.sessions.map((s) => s.session_id)).toEqual([502, 503]);
        const r2 = await h.app.service.getAttendance({ course_id: COURSE, include_history: true, max_sessions: 1 });
        expect(r2.data.activities[0]!.history!.sessions.map((s) => s.session_id)).toEqual([503]);
        expect(r2.coverage.complete).toBe(false);
        expect(r2.warnings.join(" ")).toMatch(/más recientes/);
    });

    it("parámetros inválidos o sin include_history se rechazan antes de la red", async () => {
        const h = await setup();
        expect(await codeOf(h.app.service.getAttendance({ course_id: COURSE, include_history: true, from: "3/8/2026" }))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.getAttendance({ course_id: COURSE, from: "2026-08-01" }))).toBe("POLICY_DENIED");
        expect(h.fake.web.requests).toHaveLength(0);
    });

    it("página no reconocida o sin sesión web: error explícito, nunca «sin sesiones»", async () => {
        const h = await setup("<html><body><div>otra cosa</div></body></html>");
        expect(await codeOf(h.app.service.getAttendance({ course_id: COURSE, include_history: true }))).toBe("UNEXPECTED_RESPONSE");
        const h2 = await makeHarness();
        expect(await codeOf(h2.app.service.getAttendance({ course_id: COURSE, include_history: true }))).toBe("AUTH_REQUIRED");
        // Sin historial, la lectura de siempre no necesita sesión web.
        await expect(h2.app.service.getAttendance({ course_id: COURSE })).resolves.toBeTruthy();
    });

    it("filas que parecen sesiones pero no se interpretan: resultado parcial, nunca una lista completa más corta", async () => {
        // Casilla renombrada (cambio de plantilla) y fila con menos columnas.
        const renamed = row(505, "lun 5 oct 2026", "9AM - 1PM", { taken: true }).replace('name="sessid[]"', 'name="sesiones[]"');
        const short = `<tr><td><input type="checkbox" value="506" name="sessid[]" /></td><td>mar 6 oct 2026</td></tr>`;
        const page = MANAGE.replace("</tbody>", `${renamed}${short}</tbody>`);
        expect(parseManagedSessions(page)).toMatchObject({ recognized: true, discarded: 2 });
        expect(parseManagedSessions(MANAGE).discarded).toBe(0);
        const h = await setup(page);
        const r = await h.app.service.getAttendance({ course_id: COURSE, include_history: true });
        expect(r.data.activities[0]!.history!.sessions_listed).toBe(4);
        expect(r.coverage.complete).toBe(false);
        expect(r.warnings.join(" ")).toMatch(/2 filas de la página de sesiones no se pudieron interpretar/);
    });

    it("sesión tomada sin registros reconocidos, o registros sin alumnos: se avisa como formato, no como dato", async () => {
        const h = await setup();
        h.fake.teacherForm = (sessid) => (sessid === 502 ? { otherdata: [] } : null);
        const r = await h.app.service.getAttendance({ course_id: COURSE, include_history: true });
        expect(r.coverage.complete).toBe(false);
        expect(r.warnings.join(" ")).toMatch(/sesión 502 figura como tomada pero no se reconoció ningún registro/);
        // Plantilla reconocida pero sin alumnos interpretables, con registros: no son «alumnos dados de baja».
        const h2 = await setup();
        h2.fake.teacherForm = (sessid) => (sessid === 501 ? { html: '<div class="attendance_mobile_teacher_form">otra plantilla</div>' } : null);
        const r2 = await h2.app.service.getAttendance({ course_id: COURSE, include_history: true });
        expect(r2.coverage.complete).toBe(false);
        expect(r2.warnings.join(" ")).toMatch(/sesión 501 tiene registros pero no se reconoció ningún alumno/);
        expect(r2.warnings.join(" ")).not.toMatch(/ya no están en el padrón/);
    });

    it("historial largo: se omite el detalle de las sesiones más viejas por tamaño, con totales completos", async () => {
        const many = Array.from({ length: 60 }, (_, i) => row(700 + i, `lun ${(i % 28) + 1} ${["ago", "sept", "oct"][Math.floor(i / 28)]} 2026`, "9AM - 11AM", { taken: true })).join("");
        const page = MANAGE.replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${many}</tbody>`);
        const limits = { http_timeout_seconds: 5, max_concurrent_requests: 2, max_pages_per_request: 10, max_file_bytes: 2048, max_text_chars_per_result: 1000 };
        const h = await makeHarness({ webSource: web(), profile: { limits } });
        h.fake.web.pages.set("/mod/attendance/manage.php", () => ({ body: page }));
        const r = await h.app.service.getAttendance({ course_id: COURSE, include_history: true, max_sessions: 120 });
        const hist = r.data.activities[0]!.history!;
        expect(hist.sessions_read).toBe(60);
        const omitted = hist.sessions.filter((s) => s.records_omitted);
        expect(omitted.length).toBeGreaterThan(0);
        expect(omitted.length).toBeLessThan(60);
        // Se omiten las más viejas (la lista va en orden de fecha) y las recientes conservan el detalle.
        expect(hist.sessions.at(-1)!.records_omitted).toBe(false);
        expect(hist.sessions[0]!.records_omitted).toBe(true);
        expect(omitted.every((s) => s.records.length === 0 && Object.keys(s.counts).length > 0)).toBe(true);
        expect(hist.by_student.find((s) => s.participant_id === STUDENT_A)).toMatchObject({ sessions_recorded: 60 });
        expect(r.coverage.complete).toBe(false);
        expect(r.warnings.join(" ")).toMatch(/se omitió el detalle por alumno/);
    });

    it("política: la lista de sesiones sólo admite la vista «todas» y todos los tipos", () => {
        expect(() => assertWebRoute("attendance_sessions", { id: "9403", view: "5", group: "-1" })).not.toThrow();
        expect(() => assertWebRoute("attendance_sessions", { id: "9403", view: "5", group: "-1", from: "block" })).toThrow(/no admitido/);
        expect(() => assertWebRoute("attendance_sessions", { id: "9403", view: "1", group: "-1" })).toThrow(/Valor no admitido/);
    });

    it("fechas y horas: español, inglés y 24 h; lo no reconocido queda null", () => {
        expect(parseSessionDate("lun 3 ago 2026")).toBe("2026-08-03");
        expect(parseSessionDate("Mon 03 Aug 2026")).toBe("2026-08-03");
        expect(parseSessionDate("mié 9 dic. 2026")).toBe("2026-12-09");
        expect(parseSessionDate("sin fecha")).toBeNull();
        expect(parseSessionTimes("9AM - 1:15PM")).toEqual({ start: "09:00", end: "13:15" });
        expect(parseSessionTimes("12AM")).toEqual({ start: "00:00", end: null });
        expect(parseSessionTimes("12PM - 2PM")).toEqual({ start: "12:00", end: "14:00" });
        expect(parseSessionTimes("14:30 - 16:00")).toEqual({ start: "14:30", end: "16:00" });
        expect(parseSessionTimes("9 a. m. - 1 p. m.")).toEqual({ start: "09:00", end: "13:00" });
        expect(parseManagedSessions(MANAGE).sessions.map((s) => s.taken)).toEqual([true, true, true, false]);
    });
});
