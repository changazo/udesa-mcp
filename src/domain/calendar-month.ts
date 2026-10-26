import { z } from "zod";

/**
 * Eventos de GRUPO del calendario (ADR-083). `core_calendar_get_calendar_events` con `groupids` responde
 * «nopermissions» para los grupos de los que la cuenta docente no es miembro (sin acceso a todos los
 * grupos) y los omite en silencio; la vista mensual del calendario sí los muestra, como en la web.
 * Esta función recorre los meses del rango y devuelve los eventos de grupo del curso.
 */

const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
export const MonthEventSchema = z.object({
    id: z.number().int(),
    name: opt(z.string()),
    description: opt(z.string()),
    descriptionformat: opt(z.number()),
    groupid: opt(z.number()),
    userid: opt(z.number()),
    repeatid: opt(z.number()),
    eventtype: opt(z.string()),
    modulename: opt(z.string()),
    instance: opt(z.number()),
    timestart: opt(z.number()),
    timeduration: opt(z.number()),
    visible: opt(z.number()),
    course: opt(z.object({ id: z.number() }).passthrough()),
});
export const MonthlyViewSchema = z.object({ weeks: z.array(z.object({ days: z.array(z.object({ events: z.array(MonthEventSchema).default([]) }).passthrough()).default([]) }).passthrough()).default([]) });
export type MonthEvent = z.infer<typeof MonthEventSchema>;

type Call = (fn: "core_calendar_get_calendar_monthly_view", params: { year: number; month: number; courseid: number }, schema: typeof MonthlyViewSchema) => Promise<z.infer<typeof MonthlyViewSchema>>;

/** Eventos de grupo del curso entre `from` y `to` (unix), sin repetir. A lo sumo 14 meses. */
export async function groupEventsInRange(call: Call, courseId: number, from: number, to: number): Promise<MonthEvent[]> {
    const out = new Map<number, MonthEvent>();
    const start = new Date((from - 86_400) * 1000);
    const end = new Date((to + 86_400) * 1000);
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth() + 1;
    for (let n = 0; n < 14 && (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth() + 1)); n++) {
        const view = await call("core_calendar_get_calendar_monthly_view", { year: y, month: m, courseid: courseId }, MonthlyViewSchema);
        for (const w of view.weeks) for (const d of w.days) for (const e of d.events) {
            if (e.eventtype === "group" && (e.course?.id ?? courseId) === courseId && (e.timestart ?? 0) >= from && (e.timestart ?? 0) <= to) out.set(e.id, e);
        }
        m++;
        if (m > 12) {
            m = 1;
            y++;
        }
    }
    return [...out.values()];
}
