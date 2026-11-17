import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { classifyLabel, normLabel, parseLogTime, zonedToUnix } from "../../src/domain/submission-history.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { ANON_ASSIGN, ASSIGN, ASSIGN_CMID, COURSE, QUIZ_CMID, SITE, STUDENT_A, STUDENT_B, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness, type Harness } from "../fixtures/harness.js";

/**
 * Historial de entregas (ADR-135). Todo sintético: nombres, IDs, horas y descripciones se arman acá
 * con la forma del export real de report/log (9 columnas, hora «dd/mm/aa, HH:MM:SS», descripciones
 * de Moodle en inglés con IDs). Zona del perfil sintético: America/Argentina/Buenos_Aires (-03:00).
 */

const web = (session = WEB_SESSION_OK) => {
    const cookies = [{ name: "MoodleSession", value: session, expires: null }];
    return new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" });
};

const P = STUDENT_A;
const TEACHER = USER_ID;
const NAMES: Record<number, string> = { [STUDENT_A]: "Ana Sintética", [STUDENT_B]: "Beto Sintético", [TEACHER]: "Docente Sintético" };
/** Instante Unix de una hora local de Buenos Aires («AAAA-MM-DD HH:MM:SS»). */
const ba = (local: string) => Date.parse(`${local.replace(" ", "T")}-03:00`) / 1000;

type Kind = "envio" | "texto" | "archivo" | "creado_texto" | "editado_texto" | "registro" | "estado" | "override" | "creacion_modulo" | "modulo_actualizado" | "desconocido";
interface Ev {
    /** Hora local del export: «AAAA-MM-DD HH:MM:SS» (o «HH:MM» con noSeconds). */
    t: string;
    k: Kind;
    actor?: number;
    /** ID de usuario afectado que Moodle escribe en la descripción. */
    related?: number;
    /** Columna «Usuario afectado» (nombre visible): nunca se usa para atribuir. */
    affected?: string;
    cm?: number;
    noSeconds?: boolean;
}

const LANG = {
    es: {
        header: "Hora,Nombre completo del usuario,Usuario afectado,Contexto del evento,Componente,Nombre evento,Descripción,Origen,Dirección IP",
        assign: "Tarea",
        text: "Texto en línea",
        file: "Envíos de archivos",
        sys: "Sistema",
        ev: {
            envio: "Se ha enviado una entrega.",
            texto: "Se ha subido un texto en línea.",
            archivo: "Se ha subido un archivo.",
            creado: "Entrega creada.",
            editado: "Entrega actualizada.",
            estado: "El estado de la entrega ha sido actualizado.",
            override: "Anulación de tarea  creada",
            creacion_modulo: "Módulo del curso visto",
            modulo_actualizado: "Módulo del curso actualizado",
            desconocido: "Algo inesperado ocurrió",
        },
    },
    en: {
        header: "Time,User full name,Affected user,Event context,Component,Event name,Description,Origin,IP address",
        assign: "Assignment",
        text: "Online text submissions",
        file: "File submissions",
        sys: "System",
        ev: {
            envio: "A submission has been submitted.",
            texto: "An online text has been uploaded.",
            archivo: "A file has been uploaded.",
            creado: "Submission created.",
            editado: "Submission updated.",
            estado: "The status of the submission has been updated.",
            override: "Assignment override created",
            creacion_modulo: "Course module created",
            modulo_actualizado: "Course module updated",
            desconocido: "Something unexpected happened",
        },
    },
} as const;

function csvRow(e: Ev, lang: keyof typeof LANG): string {
    const L = LANG[lang];
    const actor = e.actor ?? P;
    const cm = e.cm ?? ASSIGN_CMID;
    const rel = e.related !== undefined ? ` for the user with id '${e.related}'` : "";
    const [comp, name, desc] = (
        {
            envio: [L.assign, L.ev.envio, `The user with id '${actor}' has submitted the submission with id '101'${rel} for the assignment with course module id '${cm}'.`],
            texto: [L.text, L.ev.texto, `The user with id '${actor}' has saved an online text with id '101' in the assignment activity with course module id '${cm}'.`],
            archivo: [L.file, L.ev.archivo, `The user with id '${actor}' has uploaded a file to the submission with id '101' in the assignment activity with course module id '${cm}'.`],
            creado_texto: [L.text, L.ev.creado, `The user with id '${actor}' created an online text submission with '3' words in the assignment with course module id '${cm}'.`],
            editado_texto: [L.text, L.ev.editado, `The user with id '${actor}' updated an online text submission with '9' words in the assignment with course module id '${cm}'.`],
            registro: [L.assign, L.ev.creado, `The user with id '${actor}' created a submission with id '101' in the assignment with course module id '${cm}'.`],
            estado: [L.assign, L.ev.estado, `The user with id '${actor}' has updated the status of the submission with id '101'${rel} to the status 'draft'.`],
            override: [L.assign, L.ev.override, `The user with id '${actor}' created the override with id '7' for the assign with course module id '${cm}'${rel}.`],
            creacion_modulo: [L.sys, L.ev.creacion_modulo, `The user with id '${actor}' created the 'assign' activity with course module id '${cm}'.`],
            modulo_actualizado: [L.sys, L.ev.modulo_actualizado, `The user with id '${actor}' updated the 'assign' activity with course module id '${cm}'.`],
            desconocido: [L.assign, L.ev.desconocido, `The user with id '${actor}' did something with course module id '${cm}'.`],
        } as const
    )[e.k];
    const [date, time] = e.t.split(" ") as [string, string];
    const [y, mo, d] = date.split("-");
    const timeText = `${d}/${mo}/${y!.slice(2)}, ${e.noSeconds ? time.slice(0, 5) : time}`;
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return [q(timeText), NAMES[actor] ?? "Otra Persona", e.affected ?? "-", q("Tarea: TP1 sintético"), q(comp), q(name), q(desc), "web", "10.9.8.7"].join(",");
}

/** Sirve report/log como el Campus: con `user` filtra por actor; orden descendente por defecto. */
function serveLogs(h: Harness, events: Ev[], opts: { lang?: keyof typeof LANG; order?: "desc" | "asc" } = {}) {
    const lang = opts.lang ?? "es";
    h.fake.web.pages.set("/report/log/index.php", (q) => {
        const sel = events
            .map((e, i) => ({ e, i }))
            .filter(({ e }) => (q.user ? (e.actor ?? P) === Number(q.user) : true))
            .filter(({ e }) => !q.modid || (e.cm ?? ASSIGN_CMID) === Number(q.modid) || e.k === "creacion_modulo");
        // Como Moodle: por hora y, en el mismo segundo, por orden de registro (el arreglo es ese orden).
        const sorted = [...sel].sort((a, b) => a.e.t.localeCompare(b.e.t) || a.i - b.i).map(({ e }) => e);
        if (opts.order !== "asc") sorted.reverse();
        return { body: [LANG[lang].header, ...sorted.map((e) => csvRow(e, lang))].join("\r\n"), contentType: "text/csv; charset=UTF-8" };
    });
}

/** Fechas efectivas y última modificación (ancla) del participante, como las devolvería Moodle. */
function assignState(h: Harness, s: { due: number; open?: number; cutoff?: number; extension?: number; anchor: number | null }) {
    h.fake.overrides.set("mod_assign_get_participant", (p) => ({
        id: Number(p.userid),
        fullname: "NO-EXPONER",
        submitted: true,
        requiregrading: false,
        grantedextension: s.extension !== undefined,
        blindmarking: false,
        allowsubmissionsfromdate: s.open ?? ba("2026-09-01 00:00:00"),
        duedate: s.due,
        cutoffdate: s.cutoff ?? 0,
        duedatestr: "x",
    }));
    h.fake.overrides.set("mod_assign_get_submission_status", (p) => ({
        lastattempt: {
            submission: s.anchor === null ? undefined : { id: 101, userid: Number(p.userid), status: "submitted", timecreated: s.anchor - 86400, timemodified: s.anchor, attemptnumber: 0, plugins: [] },
            locked: false,
            gradingstatus: "notgraded",
            extensionduedate: s.extension ?? null,
        },
        warnings: [],
    }));
}

async function setup(events: Ev[], s: Parameters<typeof assignState>[1], opts: Parameters<typeof serveLogs>[2] = {}) {
    const h = await makeHarness({ webSource: web() });
    serveLogs(h, events, opts);
    assignState(h, s);
    return h;
}
const history = (h: Harness, extra: { cursor?: string; limit?: number } = {}) => h.app.service.getSubmissionHistory({ course_id: COURSE, course_module_id: ASSIGN_CMID, participant_id: P, ...extra });
async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

const DUE = ba("2026-09-20 23:59:00");
const CREATED: Ev = { t: "2026-08-30 10:00:00", k: "creacion_modulo", actor: TEACHER };
/** Envío a las 23:55 (texto + envío) y edición a las 00:30 del día siguiente. */
const SUBMIT_THEN_EDIT: Ev[] = [
    CREATED,
    { t: "2026-09-20 23:54:58", k: "creado_texto" },
    { t: "2026-09-20 23:54:58", k: "texto" },
    { t: "2026-09-20 23:55:00", k: "envio" },
    { t: "2026-09-21 00:30:00", k: "editado_texto" },
    { t: "2026-09-21 00:30:00", k: "texto" },
];
const ANCHOR_EDIT = ba("2026-09-21 00:30:00");

describe("historial de entregas: casos de la directiva", () => {
    it("envío 23:55 y edición 00:30: primer envío en término, edición por separado", async () => {
        const h = await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT });
        const r = await history(h);
        expect(r.data.timing.result).toBe("on_time");
        expect(r.data.first_submission_observed).toMatchObject({ kind: "envio", time_text: "20/09/26, 23:55:00", iso: "2026-09-20T23:55:00-03:00", utc: "2026-09-21T02:55:00Z", precision: "segundo" });
        expect(r.data.first_submission_observed!.attribution).toEqual({ basis: "filtro_nativo_y_descripcion", operator: "participante", operator_user_id: null });
        expect(r.data.last_change_observed).toMatchObject({ iso: "2026-09-21T00:30:00-03:00" });
        expect(r.data.first_content_save_observed).toMatchObject({ kind: "creacion_contenido", iso: "2026-09-20T23:54:58-03:00" });
        expect(r.data.summary).toMatchObject({ submissions_observed: 1, content_saves_observed: 4 });
        expect(r.data.time_zone).toMatchObject({ verified: true, date_order: "día/mes/año" });
        expect(r.data.timing.observed_difference).toEqual({ min_seconds: -240, max_seconds: -240 });
        // Dos descargas: actor = participante (filtro nativo) y toda la actividad (cambios).
        const reqs = h.fake.web.requests.filter((x) => x.path === "/report/log/index.php");
        expect(reqs.map((x) => x.query)).toEqual([
            { id: String(COURSE), chooselog: "1", logreader: "logstore_standard", download: "csv", user: String(P), modid: String(ASSIGN_CMID), modaction: "cud" },
            { id: String(COURSE), chooselog: "1", logreader: "logstore_standard", download: "csv", modid: String(ASSIGN_CMID), modaction: "cud" },
        ]);
        // Sin IP, nombres ni descripciones crudas.
        const out = JSON.stringify(r);
        for (const leak of ["10.9.8.7", "Ana Sintética", "Docente Sintético", "The user with id", "NO-EXPONER"]) expect(out).not.toContain(leak);
    });

    it("registro creado el día anterior, primer guardado 00:29:16 y envío 00:29:19: nunca se usa la creación ni el guardado como envío", async () => {
        const evs: Ev[] = [
            CREATED,
            { t: "2026-09-19 18:00:00", k: "registro" },
            { t: "2026-09-20 00:29:16", k: "creado_texto" },
            { t: "2026-09-20 00:29:16", k: "texto" },
            { t: "2026-09-20 00:29:19", k: "envio" },
        ];
        const h = await setup(evs, { due: DUE, anchor: ba("2026-09-20 00:29:19") });
        const r = await history(h);
        expect(r.data.first_submission_observed).toMatchObject({ kind: "envio", local: "2026-09-20T00:29:19" });
        expect(r.data.first_content_save_observed).toMatchObject({ local: "2026-09-20T00:29:16" });
        expect(r.data.timeline[0]).toMatchObject({ kind: "creacion_registro", local: "2026-09-19T18:00:00" });
        expect(r.data.timing.result).toBe("on_time");
    });

    it("23:59:00 frente a vencimiento 23:59:00 es en término; 23:59:03 es tarde sólo con cobertura previa", async () => {
        const at = (t: string): Ev[] => [CREATED, { t, k: "texto" }, { t, k: "envio" }];
        const ok = await history(await setup(at("2026-09-20 23:59:00"), { due: DUE, anchor: DUE }));
        expect(ok.data.timing.result).toBe("on_time");
        expect(ok.data.timing.observed_difference).toEqual({ min_seconds: 0, max_seconds: 0 });

        const late = await history(await setup(at("2026-09-20 23:59:03"), { due: DUE, anchor: DUE + 3 }));
        expect(late.data.timing.result).toBe("late");
        expect(late.data.timing.observed_difference).toEqual({ min_seconds: 3, max_seconds: 3 });
        expect(late.data.summary.prior_interval_covered).toBe(true);

        // Mismo envío sin evidencia de que el registro conserve el período previo (ni creación ni eventos antes de la apertura).
        const noPrior = await history(await setup(at("2026-09-20 23:59:03").slice(1), { due: DUE, anchor: DUE + 3, open: ba("2026-09-10 00:00:00") }));
        expect(noPrior.data.timing.result).toBe("unknown");
        expect(noPrior.data.timing.reason).toMatch(/no se puede descartar uno anterior/);
        expect(noPrior.data.timing.observed_difference).toEqual({ min_seconds: 3, max_seconds: 3 });
        expect(noPrior.data.summary.prior_interval_covered).toBe(false);

        // Un evento conservado anterior a la apertura también prueba la cobertura.
        const before: Ev[] = [{ t: "2026-09-09 12:00:00", k: "modulo_actualizado", actor: TEACHER }, ...at("2026-09-20 23:59:03").slice(1)];
        expect((await history(await setup(before, { due: DUE, anchor: DUE + 3, open: ba("2026-09-10 00:00:00") }))).data.timing.result).toBe("late");
    });

    it("sin evento explícito de envío: se expone el guardado, nunca se afirma un primer envío ni una tardanza", async () => {
        const evs: Ev[] = [CREATED, { t: "2026-09-21 10:00:00", k: "archivo" }];
        const r = await history(await setup(evs, { due: DUE, anchor: ba("2026-09-21 10:00:00") }));
        expect(r.data.first_submission_observed).toBeNull();
        expect(r.data.first_content_save_observed).toMatchObject({ kind: "carga_archivo" });
        expect(r.data.timing.result).toBe("unknown");
        expect(r.data.timing.reason).toMatch(/No se observó un evento explícito/);
    });

    it("historial truncado (el registro de la actividad supera el tope): cobertura parcial y sin tardanza comprobada", async () => {
        const evs: Ev[] = [CREATED, { t: "2026-09-21 10:00:00", k: "texto" }, { t: "2026-09-21 10:00:00", k: "envio" }];
        const h = await setup(evs, { due: DUE, anchor: ba("2026-09-21 10:00:00") });
        const filler = Array.from({ length: 20_001 }, () => csvRow({ t: "2026-09-15 10:00:00", k: "texto", actor: STUDENT_B }, "es"));
        h.fake.web.pages.set("/report/log/index.php", (q) => ({
            body: [LANG.es.header, ...(q.user ? evs.slice(1).reverse().map((e) => csvRow(e, "es")) : filler)].join("\r\n"),
            contentType: "text/csv",
        }));
        const r = await history(h);
        expect(r.data.first_submission_observed).toMatchObject({ kind: "envio" });
        expect(r.data.timing.result).toBe("unknown");
        expect(r.data.timing.reason).toMatch(/registro completo de la actividad/);
        expect(r.coverage.complete).toBe(false);
        expect(r.warnings.join(" ")).toMatch(/No se pudo leer el registro completo/);
    });

    it("prórroga: compara con el vencimiento efectivo, no con la fecha de corte ni la general", async () => {
        const ext = ba("2026-09-22 23:59:00");
        const evs: Ev[] = [CREATED, { t: "2026-09-22 10:00:00", k: "texto" }, { t: "2026-09-22 10:00:00", k: "envio" }];
        const r = await history(await setup(evs, { due: DUE, cutoff: ba("2026-09-21 12:00:00"), extension: ext, anchor: ba("2026-09-22 10:00:00") }));
        expect(r.data.timing.result).toBe("on_time");
        expect(r.data.applicable_due.due!.unix).toBe(ext);
        expect(r.data.applicable_due.extension).toMatchObject({ granted: true });
        expect(r.data.applicable_due.cutoff!.unix).toBe(ba("2026-09-21 12:00:00"));
        expect(r.data.applicable_due.compared_against).toBe("vencimiento_efectivo_actual");
    });

    it("prórroga indicada sin fecha: vencimiento desconocido → unknown", async () => {
        const h = await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT });
        h.fake.overrides.set("mod_assign_get_participant", (p) => ({ id: Number(p.userid), submitted: true, requiregrading: false, grantedextension: true, blindmarking: false, allowsubmissionsfromdate: 0, duedate: DUE, cutoffdate: 0, duedatestr: "x" }));
        const r = await history(h);
        expect(r.data.timing.result).toBe("unknown");
        expect(r.data.timing.reason).toMatch(/Vencimiento efectivo desconocido/);
    });

    it("sin vencimiento confirmado por Moodle: no_due_date", async () => {
        const r = await history(await setup(SUBMIT_THEN_EDIT, { due: 0, anchor: ANCHOR_EDIT }));
        expect(r.data.timing.result).toBe("no_due_date");
        expect(r.data.first_submission_observed).not.toBeNull();
    });

    it("export en una zona distinta de la del perfil: no se infiere el instante", async () => {
        // El export muestra horas de Madrid (+02:00 en septiembre) y el perfil dice Buenos Aires.
        const evs: Ev[] = [CREATED, { t: "2026-09-21 04:55:00", k: "texto" }, { t: "2026-09-21 04:55:00", k: "envio" }];
        const r = await history(await setup(evs, { due: DUE, anchor: ba("2026-09-20 23:55:00") }));
        expect(r.data.time_zone.verified).toBe(false);
        expect(r.data.first_submission_observed).toMatchObject({ time_text: "21/09/26, 04:55:00", iso: null, utc: null, local: "2026-09-21T04:55:00" });
        expect(r.data.timing.result).toBe("unknown");
        expect(r.data.timing.reason).toMatch(/zona del export no está verificada/);
    });

    it("export sin segundos: decide sólo si todo el minuto cae del mismo lado del vencimiento", async () => {
        const at = (t: string): Ev[] => [CREATED, { t, k: "texto", noSeconds: true }, { t, k: "envio", noSeconds: true }];
        const borde = await history(await setup(at("2026-09-20 23:59:00"), { due: DUE, anchor: DUE + 20 }));
        expect(borde.data.first_submission_observed).toMatchObject({ precision: "minuto", iso: "2026-09-20T23:59-03:00" });
        expect(borde.data.timing.result).toBe("unknown");
        expect(borde.data.timing.observed_difference).toEqual({ min_seconds: 0, max_seconds: 59 });
        const antes = await history(await setup(at("2026-09-20 23:58:00"), { due: DUE, anchor: DUE - 40 }));
        expect(antes.data.timing.result).toBe("on_time");
    });

    it("sin registro de entrega (sin ancla): no se verifica la zona ni se crea el registro", async () => {
        const h = await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: null });
        h.fake.withoutSubmission.add(P);
        const r = await history(h);
        expect(h.fake.createdSubmissions).toEqual([]);
        expect(r.data.time_zone.verified).toBe(false);
        expect(r.data.timing.result).toBe("unknown");
        expect(r.data.current_status).toBeNull();
    });
});

describe("atribución", () => {
    it("evento de otro alumno, docente por otro sin ID, etiqueta desconocida: nada se atribuye por nombre", async () => {
        const evs: Ev[] = [
            CREATED,
            // Otro alumno entrega antes (su propia acción): se ignora.
            { t: "2026-09-20 20:00:00", k: "envio", actor: STUDENT_B },
            // Docente envía «por» alguien: el nombre visible es el del participante, pero no hay ID.
            { t: "2026-09-20 21:00:00", k: "envio", actor: TEACHER, affected: "Ana Sintética" },
            // Docente revierte con ID explícito del participante: acción delegada atribuible.
            { t: "2026-09-21 09:00:00", k: "estado", actor: TEACHER, related: P, affected: "Ana Sintética" },
            // Etiqueta desconocida del participante: nunca es un envío.
            { t: "2026-09-20 22:00:00", k: "desconocido" },
            { t: "2026-09-21 10:00:00", k: "texto" },
            { t: "2026-09-21 10:00:00", k: "envio" },
        ];
        const r = await history(await setup(evs, { due: DUE, anchor: ba("2026-09-21 10:00:00") }));
        expect(r.data.first_submission_observed).toMatchObject({ local: "2026-09-21T10:00:00", attribution: { operator: "participante" } });
        const delegated = r.data.timeline.find((e) => e.kind === "cambio_estado")!;
        expect(delegated.attribution).toEqual({ basis: "descripcion_usuario_afectado", operator: "otro_usuario", operator_user_id: TEACHER });
        expect(r.data.timeline.find((e) => e.kind === "desconocido")).toMatchObject({ label: { event_name: "Algo inesperado ocurrió", evidence: null } });
        expect(r.data.summary).toMatchObject({ delegated_events: 1, non_attributable_candidates: 1, other_participants_events_ignored: 1, submissions_observed: 1 });
        // Posterior al vencimiento, pero con candidatos ambiguos antes: no se afirma la tardanza.
        expect(r.data.timing.result).toBe("unknown");
        expect(r.data.timing.reason).toMatch(/no atribuible\(s\) o desconocido\(s\)/);
        expect(r.data.timing.observed_difference!.min_seconds).toBe(ba("2026-09-21 10:00:00") - DUE);
    });

    it("envío delegado con ID explícito del participante cuenta, marcando al operador", async () => {
        const evs: Ev[] = [CREATED, { t: "2026-09-20 23:00:00", k: "envio", actor: TEACHER, related: P, affected: "Ana Sintética" }];
        const r = await history(await setup(evs, { due: DUE, anchor: ba("2026-09-20 23:00:00") }));
        expect(r.data.first_submission_observed).toMatchObject({ download: "actividad", attribution: { operator: "otro_usuario", operator_user_id: TEACHER } });
        expect(r.data.timing.result).toBe("on_time");
    });

    it("evento propio que la descripción ubica en otra tarea: inconsistente, no se usa", async () => {
        const evs: Ev[] = [CREATED, { t: "2026-09-20 20:00:00", k: "envio" }, { t: "2026-09-20 20:00:00", k: "envio" }];
        const h = await setup(evs, { due: DUE, anchor: ba("2026-09-20 20:00:00") });
        // La descarga filtrada trae una fila cuya descripción habla de otra actividad.
        h.fake.web.pages.set("/report/log/index.php", (q) => ({
            body: [LANG.es.header, ...(q.user ? [csvRow({ t: "2026-09-20 20:00:00", k: "envio", cm: 7777 }, "es")] : [csvRow(CREATED, "es")])].join("\r\n"),
            contentType: "text/csv",
        }));
        const r = await history(h);
        expect(r.data.first_submission_observed).toBeNull();
        expect(r.data.summary.inconsistent_own_events).toBe(1);
    });

    it("tarea grupal: no soportada, sin consultar registros", async () => {
        const h = await makeHarness({ webSource: web() });
        h.fake.overrides.set("mod_assign_get_assignments", () => ({
            courses: [{ id: COURSE, assignments: [{ id: ASSIGN, cmid: ASSIGN_CMID, course: COURSE, name: "TP grupal", duedate: DUE, cutoffdate: 0, teamsubmission: 1, blindmarking: 0, revealidentities: 0 }] }],
            warnings: [],
        }));
        const e = await history(h).catch((x) => x as CampusError);
        expect(e.code).toBe("UNSUPPORTED_CONTENT");
        expect(e.message).toMatch(/grupal/);
        expect(h.fake.web.requests.filter((x) => x.path === "/report/log/index.php")).toHaveLength(0);
    });

    it("tarea anónima, actividad que no es tarea, participante ajeno: errores explícitos antes de leer registros", async () => {
        const h = await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT });
        expect(ANON_ASSIGN).toBeGreaterThan(0);
        expect(await codeOf(h.app.service.getSubmissionHistory({ course_id: COURSE, course_module_id: 9102, participant_id: P }))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.getSubmissionHistory({ course_id: COURSE, course_module_id: QUIZ_CMID, participant_id: P }))).toBe("UNSUPPORTED_CONTENT");
        expect(await codeOf(h.app.service.getSubmissionHistory({ course_id: COURSE, course_module_id: 123456, participant_id: P }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.getSubmissionHistory({ course_id: COURSE, course_module_id: ASSIGN_CMID, participant_id: 999 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.web.requests.filter((x) => x.path === "/report/log/index.php")).toHaveLength(0);
    });
});

describe("formato, orden, páginas y errores", () => {
    const semantic = (r: Awaited<ReturnType<typeof history>>) => ({
        timing: r.data.timing.result,
        first: r.data.first_submission_observed?.utc,
        save: r.data.first_content_save_observed?.utc,
        last: r.data.last_change_observed?.utc,
        kinds: r.data.timeline.map((e) => e.kind),
        summary: r.data.summary,
    });

    it("CSV en español e inglés y orden descendente o ascendente: mismo resultado semántico", async () => {
        const es = await history(await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT }, { lang: "es" }));
        const en = await history(await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT }, { lang: "en" }));
        const asc = await history(await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT }, { order: "asc" }));
        expect(semantic(en)).toEqual(semantic(es));
        expect(semantic(asc)).toEqual(semantic(es));
        expect(es.data.timeline.map((e) => e.local)).toEqual([...es.data.timeline.map((e) => e.local)].sort());
        expect(en.data.first_submission_observed!.label).toEqual({ component: "Assignment", event_name: "A submission has been submitted.", language: "en", evidence: "fuente_moodle" });
        expect(es.data.first_submission_observed!.label.evidence).toBe("sin_confirmar");
        expect(es.warnings.join(" ")).toMatch(/no se confirmaron contra un export real/);
    });

    it("varias páginas: los resúmenes cubren todo lo recuperado; el cursor está atado al historial", async () => {
        const h = await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT });
        const p1 = await history(h, { limit: 2 });
        expect(p1.data.timeline).toHaveLength(2);
        expect(p1.data.timeline_total).toBe(5);
        expect(p1.coverage).toMatchObject({ complete: false, has_more: true });
        expect(p1.data.last_change_observed).toMatchObject({ iso: "2026-09-21T00:30:00-03:00" }); // fuera de la primera página
        const all = [...p1.data.timeline];
        let cursor = p1.coverage.next_cursor;
        while (cursor) {
            const p = await history(h, { limit: 2, cursor });
            expect(p.data.timing).toEqual(p1.data.timing);
            all.push(...p.data.timeline);
            cursor = p.coverage.next_cursor;
        }
        expect(all.map((e) => e.local)).toEqual((await history(h)).data.timeline.map((e) => e.local));
        expect(await codeOf(h.app.service.getSubmissionHistory({ course_id: COURSE, course_module_id: ASSIGN_CMID, participant_id: STUDENT_B, limit: 2, cursor: p1.coverage.next_cursor! }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("sesión web vencida, permiso denegado o CSV inválido: error estructurado, nunca «sin eventos»", async () => {
        const expired = await makeHarness({ webSource: web("vencida00000000000000000") });
        assignState(expired, { due: DUE, anchor: ANCHOR_EDIT });
        expect(await codeOf(history(expired))).toBe("AUTH_REQUIRED");

        const h = await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT });
        h.fake.web.pages.set("/report/log/index.php", () => ({ body: '<html><body><div class="box errorbox">Sin permiso</div></body></html>' }));
        expect(await codeOf(history(h))).toBe("MOODLE_PERMISSION_DENIED");
        h.fake.web.pages.set("/report/log/index.php", () => ({ body: "a,b,c\n1,2,3", contentType: "text/csv" }));
        expect(await codeOf(history(h))).toBe("UNEXPECTED_RESPONSE");
        // La segunda descarga también: un permiso denegado ahí no se degrada a cobertura parcial.
        h.fake.web.pages.set("/report/log/index.php", (q) => (q.user ? { body: LANG.es.header, contentType: "text/csv" } : { body: '<html><body><div class="box errorbox">Sin permiso</div></body></html>' }));
        expect(await codeOf(history(h))).toBe("MOODLE_PERMISSION_DENIED");
    });

    it("sin rol docente: POLICY_DENIED sin red web", async () => {
        const h = await setup(SUBMIT_THEN_EDIT, { due: DUE, anchor: ANCHOR_EDIT });
        expect(await codeOf(h.app.service.getSubmissionHistory({ course_id: 7777, course_module_id: ASSIGN_CMID, participant_id: P }))).toBe("POLICY_DENIED");
        expect(h.fake.web.requests).toHaveLength(0);
    });
});

describe("tabla de etiquetas y horas", () => {
    it("coincidencia exacta por componente + evento (es/en); normaliza espacios y punto final", () => {
        expect(classifyLabel("Tarea", "Se ha enviado una entrega.")).toMatchObject({ kind: "envio", language: "es" });
        expect(classifyLabel("Assignment", "A submission has been submitted.")).toMatchObject({ kind: "envio", language: "en", evidence: "fuente_moodle" });
        expect(classifyLabel("Tarea", "Anulación de tarea  actualizada")).toMatchObject({ kind: "excepcion_fechas", evidence: "export_real" });
        // Mismo evento en otro componente o con texto parecido: no es envío.
        expect(classifyLabel("Cuestionario", "Se ha enviado una entrega.")).toBeNull();
        expect(classifyLabel("Tarea", "Se ha enviado una entrega de prueba")).toBeNull();
        expect(classifyLabel("Texto en línea", "Entrega creada.")!.kind).toBe("creacion_contenido");
        expect(classifyLabel("Tarea", "Entrega creada.")!.kind).toBe("creacion_registro");
        expect(normLabel("  Entrega   actualizada. ")).toBe("Entrega actualizada");
    });

    it("hora del export: segundos reales, sin segundos inventados, fechas imposibles rechazadas", () => {
        expect(parseLogTime("28/10/26, 00:57:32", "dmy")).toEqual({ y: 2026, mo: 10, d: 28, h: 0, mi: 57, s: 32 });
        expect(parseLogTime("28/10/26, 00:57", "dmy")!.s).toBeNull();
        expect(parseLogTime("28/10/26, 00:57:32", "mdy")).toBeNull();
        expect(parseLogTime("31/02/26, 10:00:00", "dmy")).toBeNull();
        expect(parseLogTime("ayer 10:00", "dmy")).toBeNull();
        // Hora local inexistente o repetida por cambio de horario: sin instante.
        expect(zonedToUnix(Date.UTC(2026, 2, 8, 2, 30) / 1000, "America/New_York")).toBeNull();
        expect(zonedToUnix(Date.UTC(2026, 10, 1, 1, 30) / 1000, "America/New_York")).toBeNull();
        expect(zonedToUnix(Date.UTC(2026, 8, 20, 23, 59) / 1000, "America/Argentina/Buenos_Aires")).toBe(DUE);
    });
});
