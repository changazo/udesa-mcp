/**
 * Fechas de Moodle: segundos Unix. `0`, null o ausente significan "sin fecha", nunca 1970 (DATA-02).
 */
export interface SourceDate {
    /** Valor tal como lo dio Moodle. */
    unix: number;
    iso_utc: string;
    /** Presentación en la zona del perfil, con offset. */
    local: string;
}

export function sourceDate(unix: unknown, timeZone: string): SourceDate | null {
    if (typeof unix !== "number" || !Number.isFinite(unix) || unix <= 0) return null;
    const d = new Date(unix * 1000);
    return { unix, iso_utc: d.toISOString(), local: formatLocal(d, timeZone) };
}

export function formatLocal(d: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const offset = get("timeZoneName").replace("GMT", "") || "+00:00";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

export function isValidTimeZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Interpreta `since` a segundos Unix. Una fecha sola (AAAA-MM-DD) es la medianoche en la zona del
 * perfil; una fecha-hora sin offset se rechaza para no adivinar la zona.
 */
export function parseSince(value: string, timeZone: string): number | null {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
        const [y, m, d] = dateOnly.slice(1).map(Number) as [number, number, number];
        const utcGuess = Date.UTC(y, m - 1, d);
        if (Number.isNaN(utcGuess)) return null;
        const offset = formatLocal(new Date(utcGuess), timeZone).slice(19); // "+HH:MM" / "-HH:MM"
        const ms = Date.parse(`${value}T00:00:00${offset}`);
        return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
