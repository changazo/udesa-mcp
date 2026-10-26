import { z } from "zod";
import { CampusError } from "../../errors.js";
import { formatLocal } from "../../util/time.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * W2+ · Borrar un evento EXISTENTE del calendario del curso o de un grupo (ADR-083). Antes sólo se
 * borraban como deshacer de un evento creado por el MCP.
 * - Lectura por `core_calendar_get_calendar_event_by_id` (también ve los eventos de grupos de los que la
 *   cuenta no es miembro). Sólo eventos de curso o de grupo, sin actividad asociada: los de una tarea o
 *   un cuestionario se mueven cambiando las fechas de la actividad.
 * - De a una ocurrencia (`repeat=0`): una serie se borra ocurrencia por ocurrencia.
 * - Deshacer: volver a crearlo con el mismo nombre, descripción, horario y grupo (otro id), como un plan
 *   de `campus_plan_calendar_event`.
 */

const EventSchema = z.object({
    event: z.object({
        id: z.number().int(),
        name: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        courseid: z.number().nullable().optional(),
        course: z.object({ id: z.number() }).passthrough().nullable().optional(),
        groupid: z.number().nullable().optional(),
        eventtype: z.string().nullable().optional(),
        modulename: z.string().nullable().optional(),
        timestart: z.number().nullable().optional(),
        timeduration: z.number().nullable().optional(),
        repeatid: z.number().nullable().optional(),
    }),
});

/** El evento, o null si ya no existe. */
export async function eventOf(ctx: IntentContext, id: number) {
    try {
        const e = (await ctx.read.session.transport.call("core_calendar_get_calendar_event_by_id", { eventid: id }, EventSchema)).event;
        // El curso llega como objeto (course.id), no como courseid.
        return { ...e, courseid: e.courseid ?? e.course?.id ?? null };
    } catch (e) {
        if (e instanceof CampusError && (e.code === "MOODLE_ERROR" || e.code === "MOODLE_PERMISSION_DENIED" || e.code === "RESOURCE_OUT_OF_SCOPE")) return null;
        throw e;
    }
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, id] = k.split(":");
        const e = kind === "calevent" ? await eventOf(ctx, Number(id)) : null;
        out[k] = e ? JSON.stringify([e.name, e.timestart, e.timeduration, e.groupid]) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const still = await eventOf(ctx, Number(item.target.event_id));
    return still ? { outcome: "sin_efecto", checked: ["evento"], differences: [{ field: "evento", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["evento"], differences: [] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : "ausente";
}

const shape = {
    course_id: z.number().int().positive(),
    event_id: z.number().int().positive().describe("Evento del curso o de un grupo (sale de campus_list_events)."),
};

export const calendarEventDeleteIntent: WriteIntent<typeof shape> = {
    name: "calendar_event_delete",
    title: "Plan: borrar un evento del calendario del curso o de un grupo",
    description: "Arma el plan para borrar UNA ocurrencia de un evento de curso o de grupo (no los de actividades: esos cambian con las fechas de la actividad). Deshacer: volver a crearlo. No escribe.",
    inputShape: shape,
    capability: "calendar_event",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx): Promise<PlanDraft> {
        const e = await eventOf(ctx, input.event_id);
        if (!e || e.courseid !== input.course_id) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El evento ${input.event_id} no es del curso ${input.course_id}.`);
        if (e.modulename || (e.eventtype !== "course" && e.eventtype !== "group")) throw new CampusError("WRITE_NOT_ALLOWED", `Es un evento de tipo ${e.modulename ? `actividad (${e.modulename})` : e.eventtype}: no se borra por esta vía.`);
        const tz = ctx.profile.read_profile.timezone;
        const when = e.timestart ? formatLocal(new Date(e.timestart * 1000), tz) : "?";
        return {
            intent: "calendar_event_delete",
            capability: "calendar_event",
            course_id: input.course_id,
            base_risk: "R2",
            summary: `Borrar el evento «${e.name ?? e.id}» del ${when}${e.groupid ? ` (grupo ${e.groupid})` : ""}.`,
            payload_preview: { event: { event_id: e.id, name: e.name ?? null, start_local: when, duration_minutes: Math.round((e.timeduration ?? 0) / 60), type: e.eventtype, group_id: e.groupid || null, part_of_series: !!e.repeatid } },
            side_effects: ["Desaparece del calendario de los participantes. Sin notificaciones.", ...(e.repeatid ? ["Es parte de una serie: sólo se borra esta ocurrencia."] : [])],
            preconditions: { description: "El evento no cambió desde el plan.", versions: { [`calevent:${e.id}`]: JSON.stringify([e.name, e.timestart, e.timeduration, e.groupid]) } },
            undo: { kind: "compensación", how: "Volver a crearlo con el mismo nombre, descripción, horario y grupo (otro id).", until: null },
            warnings: [],
            items: [{ item_id: "i1", description: `Borrar el evento ${e.id}`, call: { fn: "core_calendar_delete_calendar_events", params: { events: [{ eventid: e.id, repeat: 0 }] } }, target: { course_id: input.course_id, event_id: e.id, timestart: e.timestart ?? 0, group_id: e.groupid ?? 0 }, expected: { deleted: true } }],
            prior_state: { name: e.name ?? "", description: e.description ?? "", timestart: e.timestart ?? 0, timeduration: e.timeduration ?? 0, groupid: e.groupid ?? 0, eventtype: e.eventtype },
            untrusted_fields: ["payload_preview.event.name"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo(plan, result) {
        if (!result.items.some((r) => r.outcome === "verificado")) return { kind: "ninguno", reason: "La acción no borró el evento." };
        const p = plan.prior_state as { name: string; description: string; timestart: number; timeduration: number; groupid: number; eventtype: "course" | "group" };
        return {
            kind: "plan",
            draft: {
                intent: "calendar_event",
                capability: "calendar_event",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: volver a crear el evento «${p.name}».`,
                payload_preview: { name: p.name, start: p.timestart, group_id: p.groupid || null },
                side_effects: ["Visible en el calendario de los participantes del curso o del grupo. Sin notificaciones."],
                preconditions: { description: "Ninguna.", versions: {} },
                undo: { kind: "exacto", how: "Borrarlo.", until: null },
                warnings: [],
                items: [
                    {
                        item_id: "i1",
                        description: `Evento «${p.name}» (1 ocurrencia/s)`,
                        call: { fn: "core_calendar_create_calendar_events", params: { events: [{ name: p.name, description: p.description, format: 1, courseid: plan.course_id, groupid: p.groupid, repeats: 0, eventtype: p.eventtype, timestart: p.timestart, timeduration: p.timeduration, visible: 1 }] } },
                        target: { course_id: plan.course_id },
                        expected: { name: p.name, timestart: p.timestart, timeduration: p.timeduration, eventtype: p.eventtype, groupid: p.groupid, occurrences: 1 },
                    },
                ],
                prior_state: {},
                untrusted_fields: [],
                teacher_text: { name: p.name },
                undo_of: result.action_id,
            },
        };
    },
};
