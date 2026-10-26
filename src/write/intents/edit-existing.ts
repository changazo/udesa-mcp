import { z } from "zod";
import { CampusError } from "../../errors.js";
import { htmlToText } from "../../domain/html.js";
import { formatLocal } from "../../util/time.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml, type TextFormat } from "../text.js";
import { parseFormFields } from "../web.js";
import { sessionsOf } from "./attendance.js";
import { eventOf } from "./calendar-delete.js";
import { selector } from "./edit-dates.js";
import { fieldOf, stableHtml } from "./modform.js";
import { parseLocalDateTime } from "./w2.js";

/**
 * Editar elementos EXISTENTES que antes sólo se creaban o borraban (ADR-089):
 * - Sesiones de asistencia: `/mod/attendance/sessions.php?action=2` (formulario updatesession). Fecha,
 *   horario y descripción; el resto del formulario (modo de marcado, evento de calendario…) se reenvía
 *   tal cual. Verificación releyendo el mismo formulario.
 * - Eventos de calendario de curso o de grupo: `core_calendar_submit_create_update_form` con el `id`
 *   del evento (el formulario de edición del calendario, por servicio web). Nombre, descripción, inicio
 *   y duración; el tipo y el grupo no cambian. Verificación por `core_calendar_get_calendar_event_by_id`.
 * Deshacer: volver a los valores anteriores. Sin notificaciones.
 */

// ---------- sesiones de asistencia ----------

const SESSION_FORM = "_qf__mod_attendance_form_updatesession";

interface SessionValues {
    date: string;
    start: string;
    end: string;
    description_html: string;
}

/** Los valores actuales de la sesión según su formulario de edición, o null si no se reconoce. */
async function sessionForm(ctx: IntentContext, cmid: number, sessionId: number): Promise<SessionValues | null> {
    const f = parseFormFields(await ctx.web.readPage("attendance_session_form", { id: String(cmid), action: "2", sessionid: String(sessionId) }), SESSION_FORM);
    if (!f || fieldOf(f, "sessionid") !== String(sessionId)) return null;
    const get = (n: string) => fieldOf(f, n) ?? "";
    const two = (n: string) => get(n).padStart(2, "0");
    return {
        date: `${get("sessiondate[year]")}-${two("sessiondate[month]")}-${two("sessiondate[day]")}`,
        start: `${two("sestime[starthour]")}:${two("sestime[startminute]")}`,
        end: `${two("sestime[endhour]")}:${two("sestime[endminute]")}`,
        description_html: stableHtml(get("sdescription[text]")),
    };
}

const sessionSnap = (v: SessionValues | null) => (v ? JSON.stringify([v.date, v.start, v.end, comparable(v.description_html)]) : null);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// ---------- eventos de calendario ----------

type CalEvent = NonNullable<Awaited<ReturnType<typeof eventOf>>>;
const eventSnap = (e: CalEvent | null) => (e ? JSON.stringify([htmlToText(e.name ?? ""), e.timestart ?? 0, e.timeduration ?? 0, comparable(e.description)]) : null);

// ---------- comunes ----------

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, a, b] = k.split(":");
        if (kind === "attsession") out[k] = sessionSnap(await sessionForm(ctx, Number(a), Number(b)));
        else if (kind === "calevent") out[k] = eventSnap(await eventOf(ctx, Number(a)));
        else out[k] = null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    if (item.call.fn === "core_calendar_submit_create_update_form" && (data as { validationerror?: unknown } | null)?.validationerror) return { ok: false, reason: "Moodle rechazó los datos del formulario del evento (validationerror)." };
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as Record<string, unknown> & { prior: Record<string, unknown> };
    let now: Record<string, unknown> | null;
    if (item.call.fn === "attendance_session_update") {
        const v = await sessionForm(ctx, Number(item.target.cmid), Number(item.target.session_id));
        now = v && { date: v.date, start: v.start, end: v.end, description_text: comparable(v.description_html) };
    } else {
        const e = await eventOf(ctx, Number(item.target.event_id));
        now = e && { name: htmlToText(e.name ?? ""), timestart: e.timestart ?? 0, timeduration: e.timeduration ?? 0, description_text: comparable(e.description) };
    }
    const fields = Object.keys(x.prior);
    if (!now) return { outcome: "difiere", checked: fields, differences: [{ field: "elemento", expected: "existe", observed: "no aparece" }] };
    const differences: Difference[] = fields.filter((f) => now[f] !== x[f]).map((f) => ({ field: f, expected: x[f], observed: now[f] }));
    if (!differences.length) return { outcome: "coincide", checked: fields, differences };
    return { outcome: fields.every((f) => now[f] === x.prior[f]) ? "sin_efecto" : "difiere", checked: fields, differences };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };
const applied = (r: { outcome: string } | undefined) => !!r && (r.outcome === "verificado" || r.outcome === "con_diferencias");

// ---------- editar una sesión de asistencia ----------

interface SessionReq {
    course_id: number;
    course_module_id: number;
    session_id: number;
    date?: string;
    start?: string;
    end?: string;
    description?: string;
    description_html?: string;
}

async function buildSession(input: SessionReq, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const sessions = await sessionsOf(ctx, input.course_module_id);
    if (!sessions.some((s) => s.session_id === input.session_id)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La asistencia ${input.course_module_id} no tiene la sesión ${input.session_id}.`);
    const cur = await sessionForm(ctx, input.course_module_id, input.session_id);
    if (!cur) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció el formulario de edición de la sesión.");
    const html = input.description_html ?? (input.description !== undefined ? toHtml(input.description, "markdown") : undefined);
    const next: SessionValues = { date: input.date ?? cur.date, start: input.start ?? cur.start, end: input.end ?? cur.end, description_html: html ?? cur.description_html };
    if (minutes(next.end) <= minutes(next.start) || minutes(next.start) >= 24 * 60 || minutes(next.end) >= 24 * 60 || Number(next.start.slice(3)) > 59 || Number(next.end.slice(3)) > 59) throw new CampusError("WRITE_NOT_ALLOWED", "Horario inválido: el fin tiene que ser posterior al inicio.");
    if (sessionSnap(next) === sessionSnap(cur)) throw new CampusError("WRITE_NOT_ALLOWED", "La sesión ya está así.");
    if (sessions.some((s) => s.session_id !== input.session_id && s.date === next.date && s.start_time === next.start)) throw new CampusError("WRITE_NOT_ALLOWED", "Ya hay otra sesión ese día a esa hora.");
    const [y, mo, d] = next.date.split("-").map(Number) as [number, number, number];
    const two = (hhmm: string) => [String(Number(hhmm.slice(0, 2))), String(Number(hhmm.slice(3, 5)))];
    const [sh, sm] = two(next.start);
    const [eh, em] = two(next.end);
    const fields: Record<string, string> = {
        "sessiondate[day]": String(d),
        "sessiondate[month]": String(mo),
        "sessiondate[year]": String(y),
        "sestime[starthour]": sh!,
        "sestime[startminute]": sm!,
        "sestime[endhour]": eh!,
        "sestime[endminute]": em!,
        ...(html !== undefined ? { "sdescription[text]": html, "sdescription[format]": "1" } : {}),
    };
    const pick = (v: SessionValues) => ({ date: v.date, start: v.start, end: v.end, description_text: comparable(v.description_html) });
    return {
        intent: "attendance_session_edit",
        capability: "take_attendance",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Cambiar la sesión de asistencia ${input.session_id} (${cur.date} ${cur.start}-${cur.end}) a ${next.date} ${next.start}-${next.end}${html !== undefined ? ", con descripción nueva" : ""}.`,
        payload_preview: { session_id: input.session_id, before: cur, after: next },
        side_effects: ["Los participantes ven la sesión con la fecha y el horario nuevos; si tiene evento de calendario, Moodle lo mueve.", "Lo ya registrado en la sesión se conserva.", "Sin notificaciones."],
        preconditions: { description: "La sesión no cambió desde el plan.", versions: { [`attsession:${input.course_module_id}:${input.session_id}`]: sessionSnap(cur) } },
        undo: { kind: "compensación", how: "Volver a la fecha, el horario y la descripción anteriores.", until: null },
        warnings: [],
        items: [
            {
                item_id: "i1",
                description: `Editar la sesión ${input.session_id}`,
                call: { kind: "form", fn: "attendance_session_update", params: { query: { id: String(input.course_module_id), action: "2", sessionid: String(input.session_id) }, fields } },
                target: { course_id: input.course_id, cmid: input.course_module_id, session_id: input.session_id },
                expected: { ...pick(next), prior: pick(cur) },
            },
        ],
        prior_state: { ...cur },
        untrusted_fields: ["payload_preview.before.description_html"],
        teacher_text: input.description ? { description: input.description } : {},
        undo_of: undoOf,
    };
}

const sessionShape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la asistencia."),
    session_id: z.number().int().positive().describe("Sesión (sale de campus_list_attendance_sessions)."),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fecha nueva AAAA-MM-DD (zona del perfil)."),
    start: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Inicio nuevo HH:MM."),
    end: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Fin nuevo HH:MM."),
    description: z.string().max(2_000).optional().describe("Descripción nueva (Markdown)."),
};

export const editAttendanceSessionIntent: WriteIntent<typeof sessionShape> = {
    name: "attendance_session_edit",
    title: "Plan: cambiar fecha, horario o descripción de una sesión de asistencia",
    description: "Arma el plan para cambiar la fecha, el horario o la descripción de UNA sesión existente (lo registrado se conserva). No escribe.",
    inputShape: sessionShape,
    capability: "take_attendance",
    synthetic_only: false,
    ...common,
    plan: async (input, ctx) => {
        if (input.date === undefined && input.start === undefined && input.end === undefined && input.description === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá date, start, end o description.");
        return buildSession(input, ctx, null);
    },
    async undo(plan, result, ctx) {
        if (!applied(result.items[0])) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const t = plan.items[0]!.target;
        const p = plan.prior_state as unknown as SessionValues;
        return { kind: "plan", draft: await buildSession({ course_id: plan.course_id, course_module_id: Number(t.cmid), session_id: Number(t.session_id), date: p.date, start: p.start, end: p.end, description_html: p.description_html }, ctx, result.action_id) };
    },
};

// ---------- editar un evento de calendario ----------

interface EventReq {
    course_id: number;
    event_id: number;
    name?: string;
    description?: string;
    description_format?: TextFormat;
    description_html?: string;
    start?: string;
    timestart?: number;
    duration_minutes?: number;
}

async function buildEvent(input: EventReq, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const tz = ctx.profile.read_profile.timezone;
    const e = await eventOf(ctx, input.event_id);
    if (!e || e.courseid !== input.course_id) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El evento ${input.event_id} no es del curso ${input.course_id}.`);
    if (e.modulename || (e.eventtype !== "course" && e.eventtype !== "group")) throw new CampusError("WRITE_NOT_ALLOWED", `Es un evento de tipo ${e.modulename ? `actividad (${e.modulename})` : e.eventtype}: se cambia con las fechas de la actividad, no por esta vía.`);
    const allowed = z.object({ allowedeventtypes: z.array(z.string()).default([]) }).parse(await ctx.transport.call("core_calendar_get_allowed_event_types", { courseid: input.course_id })).allowedeventtypes;
    if (!allowed.includes(e.eventtype)) throw new CampusError("MOODLE_PERMISSION_DENIED", `La cuenta no puede editar eventos de tipo ${e.eventtype} en este curso.`);
    const html = input.description_html ?? (input.description !== undefined ? toHtml(input.description, input.description_format ?? "markdown") : undefined);
    if (html === undefined && /pluginfile\.php/.test(e.description ?? "")) throw new CampusError("WRITE_NOT_ALLOWED", "La descripción del evento tiene imágenes o archivos: para editarlo hay que reescribir la descripción (description).");
    let start = input.timestart ?? e.timestart ?? 0;
    if (input.start !== undefined) {
        const s = parseLocalDateTime(input.start, tz);
        if (s === null) throw new CampusError("WRITE_NOT_ALLOWED", "start debe ser AAAA-MM-DDTHH:MM (zona del perfil) o ISO 8601 con zona.");
        start = s;
    }
    if (start % 60) throw new CampusError("WRITE_NOT_ALLOWED", "El formulario del calendario trabaja de a minutos: el inicio no puede tener segundos.");
    const cur = { name: htmlToText(e.name ?? ""), description_html: e.description ?? "", timestart: e.timestart ?? 0, timeduration: e.timeduration ?? 0 };
    const next = { name: input.name?.trim() ?? cur.name, description_html: html ?? cur.description_html, timestart: start, timeduration: input.duration_minutes !== undefined ? input.duration_minutes * 60 : cur.timeduration };
    if (!next.name) throw new CampusError("WRITE_NOT_ALLOWED", "El nombre no puede quedar vacío.");
    if (next.timeduration % 60) throw new CampusError("WRITE_NOT_ALLOWED", "La duración actual no es de minutos enteros: indicá duration_minutes.");
    const pick = (v: typeof cur) => ({ name: v.name, timestart: v.timestart, timeduration: v.timeduration, description_text: comparable(v.description_html) });
    if (JSON.stringify(pick(next)) === JSON.stringify(pick(cur))) throw new CampusError("WRITE_NOT_ALLOWED", "El evento ya está así.");
    const ts = selector("timestart", next.timestart, tz);
    delete ts["timestart[enabled]"];
    const form: Record<string, string> = {
        id: String(e.id),
        _qf__core_calendar_local_event_forms_update: "1",
        name: next.name,
        ...ts,
        eventtype: e.eventtype,
        ...(e.eventtype === "group" ? { groupcourseid: String(input.course_id), groupid: String(e.groupid ?? 0) } : { courseid: String(input.course_id) }),
        "description[text]": next.description_html,
        "description[format]": "1",
        duration: next.timeduration ? "2" : "0",
        ...(next.timeduration ? { timedurationminutes: String(next.timeduration / 60) } : {}),
    };
    const local = (u: number) => formatLocal(new Date(u * 1000), tz).slice(0, 16);
    return {
        intent: "calendar_event_edit",
        capability: "calendar_event",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Editar el evento «${cur.name}» (${local(cur.timestart)})${e.groupid ? ` del grupo ${e.groupid}` : ""}: ${[next.name !== cur.name ? `nombre «${next.name}»` : "", next.timestart !== cur.timestart ? `inicio ${local(next.timestart)}` : "", next.timeduration !== cur.timeduration ? `duración ${next.timeduration / 60} min` : "", html !== undefined ? "descripción nueva" : ""].filter(Boolean).join(", ")}.`,
        payload_preview: { event_id: e.id, type: e.eventtype, group_id: e.groupid || null, part_of_series: !!e.repeatid, before: { ...cur, start_local: local(cur.timestart) }, after: { ...next, start_local: local(next.timestart) } },
        side_effects: ["Cambia en el calendario de los participantes del curso o del grupo. Sin notificaciones.", ...(e.repeatid ? ["Es parte de una serie: sólo se edita esta ocurrencia."] : [])],
        preconditions: { description: "El evento no cambió desde el plan.", versions: { [`calevent:${e.id}`]: eventSnap(e) } },
        undo: { kind: "compensación", how: "Volver al nombre, la descripción, el inicio y la duración anteriores.", until: null },
        warnings: [],
        items: [
            {
                item_id: "i1",
                description: `Editar el evento ${e.id}`,
                call: { fn: "core_calendar_submit_create_update_form", params: { formdata: new URLSearchParams(form).toString() } },
                target: { course_id: input.course_id, event_id: e.id },
                expected: { ...pick(next), prior: pick(cur) },
            },
        ],
        prior_state: cur,
        untrusted_fields: ["payload_preview.before"],
        teacher_text: Object.fromEntries(Object.entries({ name: input.name, description: input.description }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const eventShape = {
    course_id: z.number().int().positive(),
    event_id: z.number().int().positive().describe("Evento del curso o de un grupo (sale de campus_list_events)."),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(10_000).optional(),
    description_format: z.enum(["markdown", "html", "texto"]).optional(),
    start: z.string().max(40).optional().describe("Inicio nuevo: AAAA-MM-DDTHH:MM en la zona del perfil, o ISO 8601 con zona."),
    duration_minutes: z.number().int().min(0).max(10_080).optional().describe("Duración nueva en minutos (0 = sin duración)."),
};

export const editCalendarEventIntent: WriteIntent<typeof eventShape> = {
    name: "calendar_event_edit",
    title: "Plan: editar un evento del calendario del curso o de un grupo",
    description: "Arma el plan para cambiar nombre, descripción, inicio o duración de UNA ocurrencia de un evento de curso o de grupo (no los de actividades; el tipo y el grupo no cambian). No escribe.",
    inputShape: eventShape,
    capability: "calendar_event",
    synthetic_only: false,
    ...common,
    plan: async (input, ctx) => {
        if (input.name === undefined && input.description === undefined && input.start === undefined && input.duration_minutes === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá name, description, start o duration_minutes.");
        return buildEvent(input, ctx, null);
    },
    async undo(plan, result, ctx) {
        if (!applied(result.items[0])) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const p = plan.prior_state as { name: string; description_html: string; timestart: number; timeduration: number };
        return { kind: "plan", draft: await buildEvent({ course_id: plan.course_id, event_id: Number(plan.items[0]!.target.event_id), name: p.name, description_html: p.description_html, timestart: p.timestart, duration_minutes: p.timeduration / 60 }, ctx, result.action_id) };
    },
};

export const EDIT_EXISTING_INTENTS = [editAttendanceSessionIntent, editCalendarEventIntent];
