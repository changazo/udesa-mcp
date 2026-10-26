import { decodeEntities } from "./html.js";

/**
 * Lectura de la app móvil del plugin mod_attendance (versión 2025122100, plantillas *_latest).
 * Moodle devuelve HTML para la app; de ahí se extrae lo mínimo. Si la estructura cambia, los
 * parsers devuelven listas vacías y el servicio lo informa como formato no reconocido, nunca como
 * «sin asistencia».
 */

export interface WindowSession {
    session_id: number;
    /** Fecha y hora tal como las formatea el Campus (por ejemplo «lun 19 oct 2026, 11:20 - 12:50»). */
    time_text: string | null;
    group: string | null;
}

export interface SessionRoster {
    statuses: { status_id: number; acronym: string }[];
    students: { participant_id: number; name: string | null }[];
    /** Marcadores reconocidos en el HTML (para distinguir «sin alumnos» de «formato desconocido»). */
    recognized: boolean;
}

const text = (s: string | undefined) => {
    const t = decodeEntities((s ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    return t || null;
};

/** Sesiones listadas por mobile_view_activity (ventana del sitio: últimas horas y próximo día). */
export function parseWindowSessions(html: string): WindowSession[] {
    const out: WindowSession[] = [];
    const seen = new Set<number>();
    // Cada sesión: <h2>hora</h2><h3>grupo</h3><h3>estado</h3> y el botón con «sessid: N».
    const chunks = html.split(/<h2>/i).slice(1);
    for (const chunk of chunks) {
        const sid = /\bsessid:\s*(\d{1,12})\b/.exec(chunk);
        if (!sid) continue;
        const id = Number(sid[1]);
        if (seen.has(id)) continue;
        seen.add(id);
        const time = /^([\s\S]*?)<\/h2>/i.exec(chunk)?.[1];
        const h3 = [...chunk.matchAll(/<h3>([\s\S]*?)<\/h3>/gi)].map((m) => text(m[1]));
        out.push({ session_id: id, time_text: text(time), group: h3[0] ?? null });
    }
    return out;
}

/** Estados posibles y alumnos de una sesión, de mobile_teacher_form. */
export function parseSessionRoster(html: string): SessionRoster {
    const statuses = new Map<number, string>();
    for (const m of html.matchAll(/<ion-radio\s+value="(\d{1,12})">([\s\S]*?)<\/ion-radio>/gi)) {
        const id = Number(m[1]);
        if (!statuses.has(id)) statuses.set(id, text(m[2]) ?? String(id));
    }
    const students: SessionRoster["students"] = [];
    const seen = new Set<number>();
    for (const m of html.matchAll(/title="([^"]*)"[\s\S]*?CONTENT_OTHERDATA\.status(\d{1,12})"/g)) {
        const id = Number(m[2]);
        if (seen.has(id)) continue;
        seen.add(id);
        students.push({ participant_id: id, name: text(m[1]) });
    }
    const recognized = /attendance_mobile_teacher_form/.test(html);
    return { statuses: [...statuses].map(([status_id, acronym]) => ({ status_id, acronym })), students, recognized };
}

// ---------- Lista de sesiones (web: mod/attendance/manage.php, vista «todas») ----------

export interface ManagedSession {
    session_id: number;
    /** Fecha como la muestra el Campus (p. ej. «lun 3 ago 2026»). */
    date_text: string | null;
    /** Hora como la muestra el Campus (p. ej. «9AM - 1:15PM»; «12AM» = sesión sin hora). */
    time_text: string | null;
    /** Tipo de sesión: «Todos los estudiantes» o el grupo, como lo muestra el Campus. */
    type_text: string | null;
    description: string | null;
    /** true si la fecha enlaza a «cambiar asistencia» (o aparece en cursiva: tomada, sin permiso de cambiarla). */
    taken: boolean;
    /** Fecha y horas interpretadas (hora local del Campus), o null si el formato no se reconoce. */
    date: string | null;
    start_time: string | null;
    end_time: string | null;
}

const MONTHS: Record<string, number> = {
    ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, sept: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

/** «lun 3 ago 2026» / «Mon 03 Aug 2026» → «2026-08-03». */
export function parseSessionDate(s: string | null): string | null {
    if (!s) return null;
    const m = /(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3,5})\.?\s+(\d{4})/.exec(s);
    if (!m) return null;
    const month = MONTHS[m[2]!.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")];
    const day = Number(m[1]);
    if (!month || day < 1 || day > 31) return null;
    return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** «9AM - 1:15PM» → { start: "09:00", end: "13:15" }; «12AM» → { start: "00:00", end: null }; también 24 h («14:30»). */
export function parseSessionTimes(s: string | null): { start: string | null; end: string | null } {
    if (!s) return { start: null, end: null };
    const times = [...s.matchAll(/(\d{1,2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?/g)]
        .filter((m) => m[3] || m[2])
        .map((m) => {
            let h = Number(m[1]);
            const min = m[2] ? Number(m[2]) : 0;
            const ap = m[3]?.replace(/[\s.]/g, "").toLowerCase();
            if (ap === "am" && h === 12) h = 0;
            else if (ap === "pm" && h < 12) h += 12;
            return h <= 23 && min <= 59 ? `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` : null;
        });
    return { start: times[0] ?? null, end: times[1] ?? null };
}

/**
 * Sesiones de la tabla de manage.php. Estructura no reconocida → recognized=false (nunca «sin sesiones»).
 * `discarded` cuenta las filas que parecen sesiones (enlazan un sessionid o traen la casilla) pero no
 * se pudieron interpretar: si es > 0, la lista puede estar incompleta.
 */
export function parseManagedSessions(html: string): { sessions: ManagedSession[]; recognized: boolean; discarded: number } {
    const start = html.indexOf("attsessions_manage_table");
    if (start < 0) return { sessions: [], recognized: false, discarded: 0 };
    const end = html.indexOf("</table>", start);
    const table = html.slice(start, end < 0 ? undefined : end);
    const sessions: ManagedSession[] = [];
    const seen = new Set<number>();
    let discarded = 0;
    for (const row of table.split(/<tr\b/i).slice(1)) {
        const looksLikeSession = /sessionid=\d|sessid/i.test(row);
        const id = /name="sessid\[\]"[^>]*value="(\d{1,12})"|value="(\d{1,12})"[^>]*name="sessid\[\]"/.exec(row);
        if (!id) {
            if (looksLikeSession) discarded++;
            continue;
        }
        const sid = Number(id[1] ?? id[2]);
        if (seen.has(sid)) continue;
        seen.add(sid);
        const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]!);
        if (cells.length < 5) {
            discarded++;
            continue;
        }
        const dateCell = cells[1] ?? "";
        const takeLink = new RegExp(`take\\.php\\?[^"]*sessionid=${sid}\\b`).test(dateCell);
        const italic = /^\s*<i>/i.test(dateCell);
        const dateText = text(dateCell);
        const timeText = text(cells[2]);
        const times = parseSessionTimes(timeText);
        sessions.push({
            session_id: sid,
            date_text: dateText,
            time_text: timeText,
            type_text: text(cells[3]),
            description: text(cells[4]),
            taken: takeLink || italic,
            date: parseSessionDate(dateText),
            start_time: times.start,
            end_time: times.end,
        });
    }
    return { sessions, recognized: true, discarded };
}

/** otherdata de mobile_teacher_form: «status<userid>» → id de estado registrado. */
export function parseRecordedStatuses(otherdata: unknown): Map<number, number> {
    const out = new Map<number, number>();
    const entries: [string, unknown][] = Array.isArray(otherdata)
        ? otherdata.map((x) => [String((x as { name?: unknown }).name ?? ""), (x as { value?: unknown }).value])
        : Object.entries((otherdata as Record<string, unknown>) ?? {});
    for (const [k, v] of entries) {
        const m = /^status(\d{1,12})$/.exec(k);
        const n = Number(v);
        if (m && Number.isInteger(n) && n > 0) out.set(Number(m[1]), n);
    }
    return out;
}
