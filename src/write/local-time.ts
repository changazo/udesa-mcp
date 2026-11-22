import { CampusError } from "../errors.js";

/**
 * Fecha y hora LOCAL del perfil (ADR-143): `YYYY-MM-DDTHH:mm`, sin zona adjunta, convertida con la zona
 * del perfil (no la del proceso Node). Valida calendario real: nada de normalizar el 31 de febrero.
 * Rango admitido por el selector de fecha de Moodle con margen: años 2000–2050.
 */

export interface LocalDateTime {
    /** Lo que escribió el docente, tal cual. */
    local: string;
    /** Instante resuelto (segundos Unix). */
    unix: number;
    /** Instante en UTC, ISO. */
    utc: string;
    /** Campos del date_time_selector de Moodle. */
    parts: { day: number; month: number; year: number; hour: number; minute: number };
}

const RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2050;

/** Desfase (ms) de `tz` en el instante `ms`: hora local − UTC. */
function offsetAt(ms: number, tz: string): number {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}

export function parseLocalDateTime(value: string, tz: string, field: string): LocalDateTime {
    const m = RE.exec(value);
    if (!m) throw new CampusError("WRITE_NOT_ALLOWED", `${field}: usá exactamente AAAA-MM-DDTHH:mm, en la hora local del perfil (${tz}), sin zona horaria.`);
    const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
    if (year < MIN_YEAR || year > MAX_YEAR) throw new CampusError("WRITE_NOT_ALLOWED", `${field}: el año tiene que estar entre ${MIN_YEAR} y ${MAX_YEAR}.`);
    const naive = Date.UTC(year, month - 1, day, hour, minute);
    const back = new Date(naive);
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
        throw new CampusError("WRITE_NOT_ALLOWED", `${field}: «${value}» no es una fecha y hora reales.`);
    }
    // Hora local → instante: dos pasadas por el desfase (cubre cambios de horario).
    let ms = naive - offsetAt(naive, tz);
    ms = naive - offsetAt(ms, tz);
    // Una hora local que no existe (salto de horario) no vuelve igual: se rechaza en lugar de correrla.
    const f = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (f.format(new Date(ms)).replace(" ", "T") !== value) throw new CampusError("WRITE_NOT_ALLOWED", `${field}: «${value}» no existe en ${tz} (cambio de horario).`);
    return { local: value, unix: Math.floor(ms / 1000), utc: new Date(ms).toISOString(), parts: { day, month, year, hour, minute } };
}

/** Instante Unix → `YYYY-MM-DDTHH:mm` en la zona del perfil (para mostrar el estado actual). */
export function formatLocal(unix: number, tz: string): string {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(unix * 1000)).replace(" ", "T");
}

/** Campos del date_time_selector opcional de Moodle (`<prefijo>[enabled]`, `[day]`…). Sin fecha: sólo enabled=0 (se omite al enviar). */
export function selectorFields(prefix: string, d: LocalDateTime | null): Record<string, string> {
    if (!d) return { [`${prefix}[enabled]`]: "0" };
    const p = d.parts;
    return { [`${prefix}[enabled]`]: "1", [`${prefix}[day]`]: String(p.day), [`${prefix}[month]`]: String(p.month), [`${prefix}[year]`]: String(p.year), [`${prefix}[hour]`]: String(p.hour), [`${prefix}[minute]`]: String(p.minute) };
}
