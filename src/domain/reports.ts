import { CampusError } from "../errors.js";
import { decodeEntities } from "./html.js";

/**
 * Parsers de reportes docentes (directiva §9). Separan adquisición de interpretación: reciben el
 * CSV/HTML ya descargado. Una estructura no reconocida es UNEXPECTED_RESPONSE, nunca un vacío.
 */

/** CSV (RFC 4180, como lo escribe dataformat_csv): comillas, comillas duplicadas, CRLF, BOM. */
export function parseCsv(text: string, maxRows = 20_000): string[][] {
    const s = text.replace(/^﻿/, "");
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i]!;
        if (quoted) {
            if (c === '"') {
                if (s[i + 1] === '"') {
                    field += '"';
                    i++;
                } else quoted = false;
            } else field += c;
            continue;
        }
        if (c === '"' && field === "") quoted = true;
        else if (c === ",") {
            row.push(field);
            field = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && s[i + 1] === "\n") i++;
            row.push(field);
            field = "";
            if (row.length > 1 || row[0] !== "") rows.push(row);
            row = [];
            if (rows.length > maxRows) throw new CampusError("INCOMPLETE_RESULT", `El reporte supera ${maxRows} filas; acotá los filtros.`);
        } else field += c;
    }
    if (quoted) throw new CampusError("UNEXPECTED_RESPONSE", "CSV con comillas sin cerrar.");
    if (field !== "" || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

const looksLikeHtml = (t: string) => /^\s*</.test(t) && /<html|<body|<div/i.test(t.slice(0, 2000));

// ---------- Registros del curso (report/log, download=csv) ----------

/**
 * Columnas del reporte de registros de un curso, en el orden que define report_log\table_log
 * (Moodle 5.1): hora, usuario, usuario afectado, contexto, componente, evento, descripción,
 * origen, IP. Se verifica la cantidad exacta y que la última columna tenga forma de IP.
 */
export interface LogEvent {
    row: number;
    time_text: string;
    actor: string | null;
    affected_user: string | null;
    context: string | null;
    component: string | null;
    event_name: string | null;
    description: string | null;
    origin: string | null;
}

export function parseLogCsv(text: string): { header: string[]; events: LogEvent[] } {
    if (looksLikeHtml(text)) throw new CampusError("UNEXPECTED_RESPONSE", "El reporte de registros devolvió una página en lugar de CSV.");
    const rows = parseCsv(text);
    const header = rows[0];
    if (!header || header.length !== 9) throw new CampusError("UNEXPECTED_RESPONSE", "El CSV de registros no tiene las 9 columnas esperadas.");
    const ipLike = /^$|^[\d.:a-fA-F]+$/;
    const data = rows.slice(1);
    if (data.some((r) => r.length !== 9 || !ipLike.test((r[8] ?? "").trim()))) {
        throw new CampusError("UNEXPECTED_RESPONSE", "Las filas del CSV de registros no coinciden con la estructura esperada.");
    }
    const v = (x: string | undefined) => (x === undefined || x.trim() === "" || x.trim() === "-" ? null : x.trim());
    // La IP (columna 9) se descarta: el contrato docente no la necesita.
    const events = data.map((r, i) => ({
        row: i + 1,
        time_text: r[0]!.trim(),
        actor: v(r[1]),
        affected_user: v(r[2]),
        context: v(r[3]),
        component: v(r[4]),
        event_name: v(r[5]),
        description: v(r[6]),
        origin: v(r[7]),
    }));
    return { header, events };
}

// ---------- Participación (report/participation, HTML) ----------

export interface ParticipationRow {
    participant_id: number;
    name: string | null;
    /** null = la fuente informó «No» (sin acciones en el período). */
    actions: number;
}

export function parseParticipationHtml(html: string): { rows: ParticipationRow[]; total: number | null; effective_group: number | null; recognized: boolean } {
    if (/id="page-login-index"|name="logintoken"/.test(html)) throw new CampusError("AUTH_REQUIRED", "La sesión web venció.");
    const hasTable = /class="[^"]*\breporttable\b/.test(html);
    const nothing = /class="[^"]*\b(nothingtodisplay|alert-info)\b/.test(html) && !hasTable;
    const rows: ParticipationRow[] = [];
    if (hasTable) {
        const body = html.slice(html.search(/class="[^"]*\breporttable\b/));
        for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
            const cell = tr[1]!;
            const user = /user\/view\.php\?id=(\d{1,12})(?:&amp;|&)course=\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(cell);
            if (!user) continue;
            const id = Number(user[1]);
            const box = new RegExp(`name="user${id}"[^>]*value="(\\d*)"|value="(\\d*)"[^>]*name="user${id}"`).exec(cell);
            let count: number | null = null;
            if (box) count = Number(box[1] ?? box[2] ?? "") || 0;
            else {
                const m = /\((\d+)\)/.exec(cell.replace(/<[^>]*>/g, " "));
                count = m ? Number(m[1]) : /\b(No)\b/.test(cell.replace(/<[^>]*>/g, " ")) ? 0 : null;
            }
            if (count === null) throw new CampusError("UNEXPECTED_RESPONSE", "Fila de participación sin cantidad interpretable.");
            rows.push({ participant_id: id, name: decodeEntities(user[2]!.replace(/<[^>]*>/g, "")).trim() || null, actions: count });
        }
    }
    const totalMatch = /<h2>\s*(\d+)\s/.exec(html);
    const sel = /<select[^>]*name="group"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
    const selected = sel ? /<option[^>]*value="(\d+)"[^>]*selected/.exec(sel)?.[1] ?? /<option[^>]*selected[^>]*value="(\d+)"/.exec(sel)?.[1] : null;
    return { rows, total: totalMatch ? Number(totalMatch[1]) : null, effective_group: selected !== null && selected !== undefined ? Number(selected) : null, recognized: hasTable || nothing };
}

// ---------- Respuestas de un cuestionario (mod/quiz/report.php?mode=responses, download=csv) ----------

/** Encabezados reconocidos (es / en). Otros idiomas → UNEXPECTED_RESPONSE explícito. */
const H_STATE = /^(Estado|State)$/i;
const H_RESPONSE = /^(Respuesta|Response)\s+(\S+)$/i;
const H_RIGHT = /^(Respuesta correcta|Right answer)\s+(\S+)$/i;
const H_QUESTION = /^(Pregunta|Question)\s+(\S+)$/i;
const H_STARTED = /^(Comenzado el|Started on|Comenzado)$/i;
const H_FINISHED = /^(Completado|Finalizado|Completed|Finished)$/i;
const H_DURATION = /^(Tiempo requerido|Duración|Duration|Time taken)$/i;
const H_GRADE = /^(Calificación|Grade)\b/i;
const H_SURNAME = /^(Apellido\(s\)|Apellidos|Surname|Last name)$/i;
const H_FIRSTNAME = /^(Nombre|First name)$/i;
const H_FULLNAME = /^(Nombre completo|Nombre \/ Apellido\(s\)|Full name|First name \/ Surname)$/i;

export interface ResponsesRow {
    row: number;
    participant_name: string | null;
    state: string | null;
    started_text: string | null;
    finished_text: string | null;
    duration_text: string | null;
    grade_text: string | null;
    slots: { display_number: string; question_summary: string | null; response: string | null; right_answer: string | null }[];
}

export function parseResponsesCsv(text: string): { rows: ResponsesRow[]; omitted_columns: number; slot_numbers: string[] } {
    if (looksLikeHtml(text)) throw new CampusError("UNEXPECTED_RESPONSE", "El reporte de respuestas devolvió una página en lugar de CSV.");
    const rows = parseCsv(text);
    const header = (rows[0] ?? []).map((h) => h.trim());
    const stateIdx = header.findIndex((h) => H_STATE.test(h));
    const slotCols = new Map<string, { q?: number; r?: number; ra?: number }>();
    header.forEach((h, i) => {
        let m: RegExpExecArray | null;
        if ((m = H_RIGHT.exec(h))) slotCols.set(m[2]!, { ...slotCols.get(m[2]!), ra: i });
        else if ((m = H_RESPONSE.exec(h))) slotCols.set(m[2]!, { ...slotCols.get(m[2]!), r: i });
        else if ((m = H_QUESTION.exec(h))) slotCols.set(m[2]!, { ...slotCols.get(m[2]!), q: i });
    });
    if (stateIdx < 1 || slotCols.size === 0) {
        throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció la estructura del CSV de respuestas (encabezados de estado o de respuestas).");
    }
    const idx = (re: RegExp) => header.findIndex((h) => re.test(h));
    const started = idx(H_STARTED);
    const finished = idx(H_FINISHED);
    const duration = idx(H_DURATION);
    const grade = idx(H_GRADE);
    // Nombre: columna completa, o «Nombre» + «Apellido(s)» (como exporta UdeSA). Si no se reconoce, la primera columna.
    const full = idx(H_FULLNAME);
    const first = idx(H_FIRSTNAME);
    const last = idx(H_SURNAME);
    const nameCols = full >= 0 ? [full] : first >= 0 || last >= 0 ? [first, last].filter((x) => x >= 0) : [0];
    const used = new Set<number>([...nameCols, stateIdx, started, finished, duration, grade].filter((x) => x >= 0));
    for (const c of slotCols.values()) for (const i of [c.q, c.r, c.ra]) if (i !== undefined) used.add(i);
    // Columnas no reconocidas (p. ej. email u otros campos de identidad): se descartan.
    const omitted = header.filter((_, i) => !used.has(i)).length;
    const val = (r: string[], i: number) => (i >= 0 && r[i] !== undefined && r[i]!.trim() !== "" && r[i]!.trim() !== "-" ? r[i]!.trim() : null);
    const out = rows
        .slice(1)
        .filter((r) => r.length === header.length)
        .map((r, i) => ({
            row: i + 1,
            participant_name: nameCols.map((c) => val(r, c)).filter(Boolean).join(" ") || null,
            state: val(r, stateIdx),
            started_text: val(r, started),
            finished_text: val(r, finished),
            duration_text: val(r, duration),
            grade_text: val(r, grade),
            slots: [...slotCols.entries()].map(([n, c]) => ({
                display_number: n,
                question_summary: c.q !== undefined ? val(r, c.q) : null,
                response: c.r !== undefined ? val(r, c.r) : null,
                right_answer: c.ra !== undefined ? val(r, c.ra) : null,
            })),
        }));
    if (rows.slice(1).some((r) => r.length !== header.length)) throw new CampusError("UNEXPECTED_RESPONSE", "Filas del CSV de respuestas con cantidad de columnas distinta del encabezado.");
    return { rows: out, omitted_columns: omitted, slot_numbers: [...slotCols.keys()] };
}
