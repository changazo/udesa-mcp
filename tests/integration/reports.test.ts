import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseCsv, parseLogCsv, parseResponsesCsv } from "../../src/domain/reports.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { COURSE, QUIZ, QUIZ_CMID, SITE, STUDENT_A, STUDENT_B, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";

const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
const web = () => new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" });

const LOG_CSV = [
    "Hora,Nombre completo del usuario,Usuario afectado,Contexto del evento,Componente,Nombre evento,Descripción,Origen,Dirección IP",
    '"19/10/26, 11:20",Ana Sintética,-,Cuestionario: Quiz 1,Cuestionario,Intento enviado,"El usuario con id \'601\' envió, con coma",web,10.1.2.3',
    '"19/10/26, 11:05",Ana Sintética,-,Cuestionario: Quiz 1,Cuestionario,Intento enviado,Mismo texto,web,10.1.2.3',
    '"19/10/26, 11:05",Ana Sintética,-,Cuestionario: Quiz 1,Cuestionario,Intento enviado,Mismo texto,web,10.1.2.3',
].join("\r\n");

const RESP_CSV = [
    "Nombre / Apellido(s),Dirección de correo,Estado,Comenzado el,Completado,Tiempo requerido,\"Calificación/10,00\",Respuesta 1,Respuesta correcta 1,Respuesta 2,Respuesta correcta 2",
    'Ana Sintética,ana@campus.example.test,Finalizado,"19 de octubre de 2026  11:00","19 de octubre de 2026  11:20",20 minutos,"7,50",4,4,"def f(x):\n    return 2*x",def f(x): return 2*x',
    'Ana Sintética,ana@campus.example.test,Finalizado,"18 de octubre de 2026  10:00","18 de octubre de 2026  10:30",30 minutos,"5,00",5,4,-,def f(x): return 2*x',
].join("\n");

function participationHtml(group: number | null, rows: [number, string, number][]) {
    const opts = [`<option value="0"${group === 0 ? " selected" : ""}>Todos</option>`, `<option value="1"${group === 1 ? " selected" : ""}>Comisión A</option>`, `<option value="2"${group === 2 ? " selected" : ""}>Comisión B</option>`].join("");
    const trs = rows
        .map(([id, name, n]) => `<tr><td class="cell c0"><a href="${SITE}/user/view.php?id=${id}&amp;course=${COURSE}">${name}</a></td><td class="cell c1">${n ? `Sí (${n})` : "No"}</td><td><input type="checkbox" name="user${id}" value="${n || ""}"></td></tr>`)
        .join("");
    return `<html><body><form><select name="group">${opts}</select></form><h2>${rows.length} Estudiantes</h2><table class="table generaltable reporttable"><thead><tr><th>Usuario</th><th>Todas las acciones</th></tr></thead><tbody>${trs}</tbody></table></body></html>`;
}

async function setup() {
    const h = await makeHarness({ webSource: web() });
    h.fake.web.pages.set("/report/log/index.php", () => ({ body: LOG_CSV, contentType: "text/csv; charset=UTF-8" }));
    h.fake.web.pages.set("/report/participation/index.php", (q) => ({ body: participationHtml(q.group ? Number(q.group) : 0, [[STUDENT_A, "Ana Sintética", 3], [STUDENT_B, "Beto &amp; Cía", 0]]) }));
    h.fake.web.pages.set("/mod/quiz/report.php", () => ({ body: RESP_CSV, contentType: "text/csv" }));
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

describe("registros del curso (§9.1)", () => {
    it("eventos sin IP, con filtros efectivos y paginación local; filas iguales no se deduplican", async () => {
        const h = await setup();
        const r = await h.app.service.getCourseReport({ course_id: COURSE, kind: "logs", date: "2026-10-19", limit: 2 });
        expect(r.data.total_rows).toBe(3);
        expect(r.data.events).toHaveLength(2);
        expect(r.data.events[0]).toMatchObject({ row: 1, actor: "Ana Sintética", affected_user: null, event_name: "Intento enviado", origin: "web" });
        expect(r.data.events[0]!.description).toContain("con coma");
        expect(JSON.stringify(r)).not.toContain("10.1.2.3");
        const req = h.fake.web.requests.find((x) => x.path === "/report/log/index.php")!;
        expect(req.query).toMatchObject({ id: String(COURSE), chooselog: "1", download: "csv", logreader: "logstore_standard" });
        expect(req.query.date).toMatch(/^\d+$/);
        const p2 = await h.app.service.getCourseReport({ course_id: COURSE, kind: "logs", date: "2026-10-19", limit: 2, cursor: r.coverage.next_cursor! });
        expect(p2.data.events.map((e) => e.row)).toEqual([3]);
        expect(await codeOf(h.app.service.getCourseReport({ course_id: COURSE, kind: "logs", date: "2026-10-18", limit: 2, cursor: r.coverage.next_cursor! }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("parámetros de otra variante, día mal formado o actividad ajena se rechazan antes de la red", async () => {
        const h = await setup();
        expect(await codeOf(h.app.service.getCourseReport({ course_id: COURSE, kind: "logs", role: "student" }))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.getCourseReport({ course_id: COURSE, kind: "logs", date: "2026-10-19T10:00:00Z" }))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.getCourseReport({ course_id: COURSE, kind: "logs", course_module_id: 123456 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.web.requests).toHaveLength(0);
    });

    it("HTML inesperado o permisos insuficientes no producen un vacío", async () => {
        const h = await setup();
        h.fake.web.pages.set("/report/log/index.php", () => ({ body: '<html><body><div class="box errorbox">Sin permiso</div></body></html>' }));
        expect(await codeOf(h.app.service.getCourseReport({ course_id: COURSE, kind: "logs" }))).toBe("MOODLE_PERMISSION_DENIED");
        h.fake.web.pages.set("/report/log/index.php", () => ({ body: "<html><body><div>otra cosa</div></body></html>", contentType: "text/csv" }));
        expect(await codeOf(h.app.service.getCourseReport({ course_id: COURSE, kind: "logs" }))).toBe("UNEXPECTED_RESPONSE");
        expect(() => parseLogCsv("a,b,c\n1,2,3")).toThrow(/9 columnas/);
        expect(parseLogCsv(LOG_CSV.split("\r\n")[0]!).events).toEqual([]); // tabla vacía válida
    });
});

describe("participación (§9.2)", () => {
    it("filas con ID y cantidad; «No» = 0 acciones; grupo efectivo verificado", async () => {
        const h = await setup();
        const r = await h.app.service.getCourseReport({ course_id: COURSE, kind: "participation", course_module_id: QUIZ_CMID, since: "2026-10-01", action: "post", group_id: 1 });
        expect(r.data.rows).toEqual([
            { participant_id: STUDENT_A, name: "Ana Sintética", actions: 3 },
            { participant_id: STUDENT_B, name: "Beto & Cía", actions: 0 },
        ]);
        expect(r.data.effective_group).toBe(1);
        const req = h.fake.web.requests.find((x) => x.path === "/report/participation/index.php")!;
        expect(req.query).toMatchObject({ instanceid: String(QUIZ_CMID), roleid: "5", action: "post", group: "1" });
    });

    it("si el Campus aplica otro grupo (residual de sesión), no se devuelven esas filas", async () => {
        const h = await setup();
        h.fake.web.pages.set("/report/participation/index.php", () => ({ body: participationHtml(2, [[STUDENT_A, "Ana", 1]]) }));
        const e = await h.app.service.getCourseReport({ course_id: COURSE, kind: "participation", course_module_id: QUIZ_CMID, group_id: 1 }).catch((x) => x as CampusError);
        expect(e.code).toBe("UNEXPECTED_RESPONSE");
        expect(e.message).toMatch(/otro grupo/);
    });

    it("sin actividad: se exige course_module_id", async () => {
        const h = await setup();
        expect(await codeOf(h.app.service.getCourseReport({ course_id: COURSE, kind: "participation" }))).toBe("POLICY_DENIED");
    });
});

describe("respuestas y estadísticas de cuestionarios (§9.3, §9.4)", () => {
    it("una fila por intento, sin fusionar por nombre; descarta columnas de identidad; datos localizados como texto", async () => {
        const h = await setup();
        const r = await h.app.service.getQuizReport({ course_id: COURSE, quiz_id: QUIZ, kind: "responses" });
        expect(r.data.rows).toHaveLength(2);
        expect(r.data.rows.map((x) => x.participant_name)).toEqual(["Ana Sintética", "Ana Sintética"]);
        expect(r.data.rows[0]!.grade_text).toBe("7,50");
        expect(r.data.rows[0]!.slots[1]).toEqual({ display_number: "2", question_summary: null, response: "def f(x):\n    return 2*x", right_answer: "def f(x): return 2*x" });
        expect(r.data.rows[1]!.slots[1]!.response).toBeNull();
        expect(JSON.stringify(r)).not.toContain("@campus.example.test");
        expect(r.coverage.detail!.omitted![0]).toMatchObject({ count: 1 });
        expect(r.data.population).toEqual({ attempts: "enrolled_with", which_tries: "last", only_graded: false });
        const req = h.fake.web.requests.find((x) => x.path === "/mod/quiz/report.php")!;
        expect(req.query).toMatchObject({ id: String(QUIZ_CMID), mode: "responses", download: "csv", resp: "1", right: "1" });
        expect(Object.keys(req.query)).not.toContain("regrade");
    });

    it("estadísticas: bloqueadas por política sin emitir red", async () => {
        const h = await setup();
        expect(await codeOf(h.app.service.getQuizReport({ course_id: COURSE, quiz_id: QUIZ, kind: "statistics" }))).toBe("POLICY_DENIED");
        expect(h.fake.web.requests).toHaveLength(0);
    });

    it("nombre en dos columnas (Apellido(s) + Nombre) y columnas de identidad descartadas", () => {
        const csv = [
            'Apellido(s),Nombre,Dirección de correo,Departamento,Estado,Comenzado,Finalizado,Duración,"Calificación/100,00",Respuesta 1,Respuesta correcta 1',
            'Sintética,Ana,ana@x.test,Depto,Finalizado,a,b,c,"80,00",4,4',
            "Sintético,Beto,,Depto,,a,,,,-,4",
        ].join("\n");
        const p = parseResponsesCsv(csv);
        expect(p.rows.map((r) => r.participant_name)).toEqual(["Ana Sintética", "Beto Sintético"]);
        expect(p.omitted_columns).toBe(2);
        expect(p.rows[1]!.state).toBeNull();
        expect(JSON.stringify(p)).not.toContain("ana@x.test");
    });

    it("encabezados no reconocidos → error explícito", () => {
        expect(() => parseResponsesCsv("Name,Status,Antwort 1\nA,B,C")).toThrow(/estructura/);
        expect(parseCsv('a,"b ""c""",d\r\n1,2,3')).toEqual([["a", 'b "c"', "d"], ["1", "2", "3"]]);
    });
});
