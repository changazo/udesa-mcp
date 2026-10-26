import { z } from "zod";
import { groupEventsInRange } from "../../domain/calendar-month.js";
import { CampusError } from "../../errors.js";
import { hasSubmissionRecord, readUserFlags } from "../../domain/submission-guard.js";
import { AssignmentsSchema, AssignParticipantsSchema, CommentsSchema, GroupsSchema, SubmissionStatusSchema } from "../../moodle/schemas.js";
import { formatLocal } from "../../util/time.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, UndoDraft, WriteIntent } from "../intent.js";
import type { Difference, ExecutionResult, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml, type TextFormat } from "../text.js";

/**
 * W2 · Bajo riesgo, SIN notificaciones (directiva §8.2, §8.4 y §8.5; investigación [F] §4–§5 y
 * [T] §13–§14). Evento de calendario del curso o de un grupo, prórroga, bloqueo de entregas y
 * comentario de entrega. Ninguna de estas funciones envía mensajes según el código auditado.
 * Los mensajes privados (§8.3) quedan afuera a pedido del dueño: notifican siempre.
 */

const optStr = z.string().nullable().optional();
const optNum = z.number().nullable().optional();

const EventsSchema = z.object({
    events: z.array(
        z.object({
            id: z.number().int().positive(),
            name: optStr,
            description: optStr,
            courseid: optNum,
            groupid: optNum,
            userid: optNum,
            repeatid: optNum,
            eventtype: optStr,
            timestart: optNum,
            timeduration: optNum,
            modulename: optStr,
        }),
    ),
});
type EventRow = z.infer<typeof EventsSchema>["events"][number];
const AllowedTypesSchema = z.object({ allowedeventtypes: z.array(z.string()).default([]) });

const WEEK = 7 * 86_400;

// ---------- lecturas ----------

async function me(ctx: IntentContext) {
    return (await ctx.read.session.verified()).info.userid;
}

/** Fecha y hora local del perfil (AAAA-MM-DDTHH:MM) o ISO 8601 con zona → segundos Unix. */
export function parseLocalDateTime(value: string, tz: string): number | null {
    const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value);
    if (local) {
        const [y, mo, d, h, mi] = local.slice(1).map(Number) as [number, number, number, number, number];
        const guess = Date.UTC(y, mo - 1, d, h, mi);
        if (Number.isNaN(guess)) return null;
        const offset = formatLocal(new Date(guess), tz).slice(19);
        const ms = Date.parse(`${value.replace(" ", "T")}:00${offset}`);
        return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

async function courseEvents(ctx: IntentContext, courseId: number, from: number, to: number, groupId: number): Promise<EventRow[]> {
    const res = await ctx.read.session.transport.call(
        "core_calendar_get_calendar_events",
        { events: { courseids: [courseId], ...(groupId > 0 ? { groupids: [groupId] } : {}) }, options: { userevents: false, siteevents: false, timestart: from, timeend: to } },
        EventsSchema,
    );
    const rows: EventRow[] = res.events.filter((e) => e.courseid === courseId && !e.modulename);
    // Eventos de grupo (ADR-083): si la cuenta no es miembro del grupo, sólo los muestra la vista mensual.
    if (groupId > 0) {
        const month = await groupEventsInRange((fn, params, schema) => ctx.read.session.transport.call(fn, params, schema), courseId, from, to);
        for (const e of month) {
            if (e.groupid !== groupId || rows.some((r) => r.id === e.id)) continue;
            rows.push({ id: e.id, name: e.name, description: e.description, courseid: e.course?.id ?? courseId, groupid: e.groupid, userid: e.userid, repeatid: e.repeatid, eventtype: e.eventtype, timestart: e.timestart, timeduration: e.timeduration, modulename: e.modulename });
        }
    }
    return rows;
}

async function assignmentOf(ctx: IntentContext, courseId: number, assignmentId: number) {
    const res = await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [courseId] }, AssignmentsSchema);
    const a = res.courses.find((c) => c.id === courseId)?.assignments.find((x) => x.id === assignmentId);
    if (!a) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La tarea ${assignmentId} no es del curso ${courseId}.`);
    return a;
}

async function participantsOf(ctx: IntentContext, assignmentId: number) {
    return ctx.read.session.transport.call(
        "mod_assign_list_participants",
        { assignid: assignmentId, groupid: 0, filter: "", skip: 0, limit: 0, onlyids: false, includeenrolments: false, tablesort: false },
        AssignParticipantsSchema,
    );
}

/** Prórroga y bloqueo (mod_assign_get_user_flags): nunca por get_submission_status, que crea entregas (ADR-051). */
async function flagsOf(ctx: IntentContext, assignmentId: number, userId: number) {
    return readUserFlags(ctx.read.session.transport, assignmentId, userId);
}

/** Entrega existente del participante. Sin registro no se llama a get_submission_status, que lo crearía (ADR-051). */
async function submissionOf(ctx: IntentContext, assignmentId: number, team: boolean, userId: number) {
    if (!hasSubmissionRecord(await participantsOf(ctx, assignmentId), userId, team)) return { submissionId: null, status: null };
    const s = await ctx.read.session.transport.call("mod_assign_get_submission_status", { assignid: assignmentId, userid: userId }, SubmissionStatusSchema);
    const sub = team ? (s.lastattempt?.teamsubmission ?? s.lastattempt?.submission) : s.lastattempt?.submission;
    return { submissionId: sub?.id || null, status: sub?.status ?? null };
}

async function commentsOf(ctx: IntentContext, cmid: number, submissionId: number) {
    return (
        await ctx.read.session.transport.call(
            "core_comment_get_comments",
            { contextlevel: "module", instanceid: cmid, component: "assignsubmission_comments", itemid: submissionId, area: "submission_comments", page: 0 },
            CommentsSchema,
        )
    ).comments;
}

/** Participantes de la tarea pedidos, validados: matriculados y con permiso de entregar (lista de Moodle). */
async function resolveParticipants(ctx: IntentContext, assignmentId: number, ids: number[]) {
    if (new Set(ids).size !== ids.length) throw new CampusError("WRITE_NOT_ALLOWED", "Hay participantes repetidos.");
    const list = await participantsOf(ctx, assignmentId);
    return ids.map((id) => {
        const p = list.find((x) => x.id === id);
        if (!p) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${id} no puede entregar en esta tarea (no figura en sus participantes).`);
        return { id, name: p.fullname ?? null };
    });
}

// ---------- versiones ----------

/**
 * `allowed:<curso>` · `event:<curso>:<evento>:<inicio>:<grupo>` · `ext:<tarea>:<usuario>` ·
 * `lock:<tarea>:<usuario>` · `comment:<cmid>:<entrega>:<comentario>`.
 */
async function readW2Versions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const key of Object.keys(plan.preconditions.versions)) {
        const [k, ...rest] = key.split(":");
        const [a, b, c, d] = rest.map(Number);
        if (k === "allowed") out[key] = (await allowedTypes(ctx, a!)).sort().join(",");
        else if (k === "event") out[key] = (await courseEvents(ctx, a!, c! - 60, c! + 60, d!)).some((e) => e.id === b) ? 1 : null;
        else if (k === "ext") out[key] = (await flagsOf(ctx, a!, b!)).extension;
        else if (k === "lock") out[key] = (await flagsOf(ctx, a!, b!)).locked ? 1 : 0;
        else if (k === "comment") out[key] = (await commentsOf(ctx, a!, b!)).some((x) => x.id === c) ? 1 : null;
        else out[key] = null;
    }
    return out;
}

async function allowedTypes(ctx: IntentContext, courseId: number) {
    return AllowedTypesSchema.parse(await ctx.transport.call("core_calendar_get_allowed_event_types", { courseid: courseId })).allowedeventtypes;
}

// ---------- interpretación y verificación por función ----------

function warningsOf(data: unknown): string | null {
    // Algunas funciones devuelven la lista de avisos como raíz (save_user_extensions, lock); otras, en «warnings».
    const isWarning = (x: unknown) => !!x && typeof x === "object" && "warningcode" in x;
    const w = Array.isArray(data) ? data.filter(isWarning) : data && typeof data === "object" ? (data as { warnings?: unknown }).warnings : undefined;
    if (!Array.isArray(w) || !w.length) return null;
    return w.map((x) => (x && typeof x === "object" && "warningcode" in x ? String((x as { warningcode: unknown }).warningcode) : "aviso")).join(", ");
}

function interpretW2(item: PlanItem, data: unknown): Interpretation {
    const warn = warningsOf(data);
    if (warn) return { ok: false, reason: `Moodle devolvió avisos: ${warn}.` };
    if (item.call.fn === "core_calendar_create_calendar_events") {
        const events = (data as { events?: { id?: number }[] } | null)?.events ?? [];
        // Sin permiso, Moodle no lanza excepción: omite el evento (y avisa). Sin eventos = rechazo.
        if (!events.length || !events[0]?.id) return { ok: false, reason: "Moodle no creó ningún evento." };
        return { ok: true, moodle_ids: { event_id: events[0].id } };
    }
    if (item.call.fn === "core_comment_add_comments") {
        const first = Array.isArray(data) ? (data[0] as { id?: number } | undefined) : undefined;
        return first?.id ? { ok: true, moodle_ids: { comment_id: first.id } } : { ok: false, reason: "Moodle no devolvió el comentario creado." };
    }
    return { ok: true };
}

const diff = (field: string, expected: unknown, observed: unknown): Difference[] => (expected === observed ? [] : [{ field, expected, observed }]);

async function verifyW2(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected;
    switch (item.call.fn) {
        case "core_calendar_create_calendar_events": {
            const start = Number(x.timestart);
            const occ = Number(x.occurrences);
            const rows = await courseEvents(ctx, plan.course_id, start - 60, start + (occ - 1) * WEEK + 86_400, Number(x.groupid));
            const mine = await me(ctx);
            const first = known.event_id
                ? rows.find((e) => e.id === known.event_id)
                : rows.find((e) => e.name === x.name && e.timestart === start && e.userid === mine && e.eventtype === x.eventtype);
            if (!first) return { outcome: "sin_efecto", checked: ["evento"], differences: [{ field: "evento", expected: "creado", observed: "no aparece en el calendario" }] };
            const series = rows.filter((e) => e.id === first.id || (first.repeatid && e.repeatid === first.repeatid) || e.repeatid === first.id);
            const differences = [
                ...diff("name", x.name, first.name ?? null),
                ...diff("timestart", start, first.timestart ?? null),
                ...diff("timeduration", x.timeduration, first.timeduration ?? 0),
                ...diff("eventtype", x.eventtype, first.eventtype ?? null),
                ...diff("groupid", x.groupid, first.groupid ?? 0),
                ...diff("occurrences", occ, series.length),
            ];
            return { outcome: differences.length ? "difiere" : "coincide", checked: ["name", "timestart", "timeduration", "eventtype", "groupid", "occurrences"], differences, moodle_ids: { event_id: first.id } };
        }
        case "core_calendar_delete_calendar_events": {
            const start = Number(t.timestart);
            const still = (await courseEvents(ctx, plan.course_id, start - 60, start + 60, Number(t.group_id))).some((e) => e.id === Number(t.event_id));
            return still ? { outcome: "sin_efecto", checked: ["evento"], differences: [{ field: "evento", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["evento"], differences: [] };
        }
        case "mod_assign_save_user_extensions": {
            const s = await flagsOf(ctx, Number(t.assignment_id), Number(t.user_id));
            if (s.extension === x.extension) return { outcome: "coincide", checked: ["extensionduedate"], differences: [] };
            return { outcome: s.extension === x.prior ? "sin_efecto" : "difiere", checked: ["extensionduedate"], differences: [{ field: "extensionduedate", expected: x.extension, observed: s.extension }] };
        }
        case "mod_assign_lock_submissions":
        case "mod_assign_unlock_submissions": {
            const s = await flagsOf(ctx, Number(t.assignment_id), Number(t.user_id));
            return s.locked === x.locked ? { outcome: "coincide", checked: ["locked"], differences: [] } : { outcome: "sin_efecto", checked: ["locked"], differences: [{ field: "locked", expected: x.locked, observed: s.locked }] };
        }
        case "core_comment_add_comments": {
            const list = await commentsOf(ctx, Number(t.cmid), Number(t.submission_id));
            const mine = await me(ctx);
            const c = known.comment_id ? list.find((x2) => x2.id === known.comment_id) : list.find((x2) => x2.userid === mine && comparable(x2.content) === x.content_text && (x2.timecreated ?? 0) >= Math.floor(Date.parse(plan.created_at) / 1000) - 120);
            if (!c) return { outcome: "sin_efecto", checked: ["comentario"], differences: [{ field: "comentario", expected: "creado", observed: "no aparece" }] };
            const differences = [...diff("content", x.content_text, comparable(c.content)), ...diff("userid", mine, c.userid ?? null)];
            return { outcome: differences.length ? "difiere" : "coincide", checked: ["content", "userid"], differences, moodle_ids: { comment_id: c.id } };
        }
        case "core_comment_delete_comments": {
            const still = (await commentsOf(ctx, Number(t.cmid), Number(t.submission_id))).some((c) => c.id === Number(t.comment_id));
            return still ? { outcome: "sin_efecto", checked: ["comentario"], differences: [{ field: "comentario", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["comentario"], differences: [] };
        }
        default:
            throw new CampusError("UNEXPECTED_RESPONSE", `Sin verificación para ${item.call.fn}.`);
    }
}

async function reconcileW2(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verifyW2(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions: readW2Versions, interpret: interpretW2, verify: verifyW2, reconcile: reconcileW2 };
const appliedItems = (plan: Plan, result: ExecutionResult) =>
    result.items.filter((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido").map((r) => ({ r, item: plan.items.find((i) => i.item_id === r.item_id)! }));

const courseId = z.number().int().positive().describe("ID del curso.");

// ---------- evento de calendario ----------

const eventShape = {
    course_id: courseId,
    name: z.string().min(1).max(255),
    description: z.string().max(10_000).optional(),
    description_format: z.enum(["markdown", "html", "texto"]).optional(),
    start: z.string().max(40).describe("Inicio: AAAA-MM-DDTHH:MM en la zona del perfil, o ISO 8601 con zona."),
    duration_minutes: z.number().int().min(0).max(10_080).optional(),
    group_id: z.number().int().positive().optional().describe("Evento de un grupo del curso; ausente = todo el curso."),
    occurrences: z.number().int().min(1).max(20).optional().describe("Repeticiones semanales (1 = sin repetir; máximo 20)."),
};

export const calendarEventIntent: WriteIntent<typeof eventShape> = {
    name: "calendar_event",
    title: "Plan: crear un evento de calendario",
    description: "Arma el plan para crear un evento del curso (o de un grupo), opcionalmente semanal. No escribe. Moodle no notifica eventos de calendario; los ven los participantes.",
    inputShape: eventShape,
    capability: "calendar_event",
    synthetic_only: false,
    ...common,

    async plan(input, ctx) {
        const tz = ctx.profile.read_profile.timezone;
        const start = parseLocalDateTime(input.start, tz);
        if (start === null) throw new CampusError("WRITE_NOT_ALLOWED", "start debe ser AAAA-MM-DDTHH:MM (zona del perfil) o ISO 8601 con zona.");
        const allowed = await allowedTypes(ctx, input.course_id);
        const type = input.group_id ? "group" : "course";
        if (!allowed.includes(type)) throw new CampusError("MOODLE_PERMISSION_DENIED", `La cuenta no puede crear eventos de tipo ${type} en este curso (tipos permitidos: ${allowed.join(", ") || "ninguno"}).`);
        const course = (await ctx.read.scope.resolve()).courses.find((c) => c.course_id === input.course_id);
        if (course?.startdate && start < course.startdate) throw new CampusError("WRITE_NOT_ALLOWED", "El inicio es anterior al inicio del curso.");
        let groupName: string | null = null;
        if (input.group_id) {
            const groups = await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: input.course_id }, GroupsSchema);
            const g = groups.find((x) => x.id === input.group_id && x.courseid === input.course_id);
            if (!g) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El grupo ${input.group_id} no es del curso.`);
            groupName = g.name ?? null;
        }
        const occurrences = input.occurrences ?? 1;
        const duration = (input.duration_minutes ?? 0) * 60;
        const format: TextFormat = input.description_format ?? "markdown";
        const html = input.description ? toHtml(input.description, format) : "";
        const local = (u: number) => formatLocal(new Date(u * 1000), tz);
        return {
            intent: "calendar_event",
            capability: "calendar_event",
            course_id: input.course_id,
            base_risk: "R2",
            summary: `Crear el evento «${input.name}» para ${input.group_id ? `el grupo «${groupName ?? input.group_id}»` : "todo el curso"}, el ${local(start)}${occurrences > 1 ? `, ${occurrences} semanas seguidas` : ""}.`,
            payload_preview: {
                name: input.name,
                description_html: html,
                type,
                group: input.group_id ? { group_id: input.group_id, name: groupName } : "todo el curso",
                start_local: local(start),
                duration_minutes: duration / 60,
                occurrences,
                last_start_local: local(start + (occurrences - 1) * WEEK),
                visible: true,
            },
            side_effects: ["Visible en el calendario de los participantes del curso o del grupo.", "Sin correos ni notificaciones (el núcleo no notifica eventos de calendario)."],
            preconditions: { description: "La cuenta sigue pudiendo crear ese tipo de evento.", versions: { [`allowed:${input.course_id}`]: allowed.slice().sort().join(",") } },
            undo: { kind: "exacto", how: "Borrar cada ocurrencia, de a una.", until: null },
            warnings: occurrences > 1 ? ["Las repeticiones se calculan sumando 7 días en la zona horaria de la cuenta."] : [],
            items: [
                {
                    item_id: "i1",
                    description: `Evento «${input.name}» (${occurrences} ocurrencia/s)`,
                    call: {
                        fn: "core_calendar_create_calendar_events",
                        params: {
                            events: [{ name: input.name, description: html, format: 1, courseid: input.course_id, groupid: input.group_id ?? 0, repeats: occurrences > 1 ? occurrences : 0, eventtype: type, timestart: start, timeduration: duration, visible: 1 }],
                        },
                    },
                    target: { course_id: input.course_id },
                    expected: { name: input.name, timestart: start, timeduration: duration, eventtype: type, groupid: input.group_id ?? 0, occurrences },
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.group.name"],
            teacher_text: { name: input.name, ...(input.description ? { description: input.description } : {}) },
            undo_of: null,
        };
    },

    async undo(plan, result, ctx) {
        const applied = appliedItems(plan, result);
        if (!applied.length) return { kind: "ninguno", reason: "La acción no creó eventos." };
        const x = applied[0]!.item.expected;
        const start = Number(x.timestart);
        const groupId = Number(x.groupid);
        const rows = await courseEvents(ctx, plan.course_id, start - 60, start + (Number(x.occurrences) - 1) * WEEK + 86_400, groupId);
        const firstId = applied[0]!.r.moodle_ids.event_id;
        const first = rows.find((e) => e.id === firstId) ?? rows.find((e) => e.name === x.name && e.timestart === start);
        if (!first) return { kind: "ninguno", reason: "Los eventos ya no están en el calendario." };
        const series = rows.filter((e) => e.id === first.id || (first.repeatid && e.repeatid === first.repeatid) || e.repeatid === first.id).sort((a, b) => (b.timestart ?? 0) - (a.timestart ?? 0));
        const versions: Record<string, number> = {};
        const items: PlanItem[] = series.map((e, i) => {
            versions[`event:${plan.course_id}:${e.id}:${e.timestart}:${groupId}`] = 1;
            return {
                item_id: `i${i + 1}`,
                description: `Borrar el evento ${e.id} (${formatLocal(new Date((e.timestart ?? 0) * 1000), ctx.profile.read_profile.timezone)})`,
                call: { fn: "core_calendar_delete_calendar_events", params: { events: [{ eventid: e.id, repeat: 0 }] } },
                target: { course_id: plan.course_id, event_id: e.id, timestart: e.timestart ?? 0, group_id: groupId },
                expected: { deleted: true },
            };
        });
        return {
            kind: "plan",
            draft: {
                intent: "calendar_event",
                capability: "calendar_event",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar ${items.length} ocurrencia/s del evento «${x.name}».`,
                payload_preview: { delete_events: series.map((e) => e.id) },
                side_effects: ["Borra los eventos del calendario (irreversible). Sin notificaciones."],
                preconditions: { description: "Los eventos siguen existiendo.", versions },
                undo: { kind: "ninguno", how: "El borrado no se puede deshacer.", until: null },
                warnings: [],
                items,
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};

// ---------- prórroga ----------

const extensionShape = {
    course_id: courseId,
    assignment_id: z.number().int().positive().describe("assignment_id (no el course_module_id)."),
    participant_ids: z.array(z.number().int().positive()).min(1).max(30),
    until: z.string().max(40).optional().describe("Nueva fecha límite: AAAA-MM-DDTHH:MM (zona del perfil) o ISO 8601 con zona."),
    remove: z.boolean().optional().describe("true = quitar la prórroga."),
};

type ExtensionInput = { course_id: number; assignment_id: number; participants: { id: number; date: number }[] };

async function buildExtension(input: ExtensionInput, ctx: IntentContext, undoOf: string | null, warnings: string[]): Promise<PlanDraft> {
    const a = await assignmentOf(ctx, input.course_id, input.assignment_id);
    const people = await resolveParticipants(ctx, a.id, input.participants.map((p) => p.id));
    const tz = ctx.profile.read_profile.timezone;
    const local = (u: number) => (u ? formatLocal(new Date(u * 1000), tz) : "sin prórroga");
    const versions: Record<string, number> = {};
    const prior: Record<string, number> = {};
    const items: PlanItem[] = [];
    for (const p of input.participants) {
        const s = await flagsOf(ctx, a.id, p.id);
        versions[`ext:${a.id}:${p.id}`] = s.extension;
        prior[String(p.id)] = s.extension;
        if (s.extension === p.date) continue;
        items.push({
            item_id: `i${items.length + 1}`,
            description: `Participante ${p.id}: ${local(s.extension)} → ${local(p.date)}`,
            call: { fn: "mod_assign_save_user_extensions", params: { assignmentid: a.id, userids: [p.id], dates: [p.date] } },
            target: { course_id: input.course_id, assignment_id: a.id, user_id: p.id },
            expected: { extension: p.date, prior: s.extension },
        });
    }
    if (!items.length) throw new CampusError("WRITE_NOT_ALLOWED", "Las prórrogas ya están así: no hay nada que escribir.");
    return {
        intent: "extension",
        capability: "grant_extension",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}prórroga en «${a.name ?? a.id}» para ${items.length} participante/s.`,
        payload_preview: {
            assignment: { assignment_id: a.id, name: a.name ?? null, due_local: a.duedate ? local(a.duedate) : null, cutoff_local: a.cutoffdate ? local(a.cutoffdate) : null },
            changes: input.participants.map((p) => ({ participant_id: p.id, name: people.find((x) => x.id === p.id)?.name ?? null, from: local(prior[String(p.id)] ?? 0), to: local(p.date) })),
        },
        side_effects: ["Evento extension_granted y evento de calendario personal del participante.", "No envía mensajes. No recalcula penalizaciones ya aplicadas."],
        preconditions: { description: "La prórroga de cada participante no cambió desde el plan.", versions },
        undo: { kind: "exacto", how: "Volver a la prórroga anterior (o quitarla).", until: null },
        warnings,
        items,
        prior_state: { extensions: prior },
        untrusted_fields: ["payload_preview.assignment.name", "payload_preview.changes[].name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const extensionIntent: WriteIntent<typeof extensionShape> = {
    name: "extension",
    title: "Plan: dar o quitar una prórroga",
    description: "Arma el plan para dar (o quitar) una prórroga a participantes de una tarea del curso. No escribe. Moodle no envía mensajes por prórrogas.",
    inputShape: extensionShape,
    capability: "grant_extension",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        if ((input.until === undefined) === !input.remove) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá until o remove=true (uno de los dos).");
        const warnings: string[] = [];
        let date = 0;
        if (input.until !== undefined) {
            const t = parseLocalDateTime(input.until, ctx.profile.read_profile.timezone);
            if (t === null) throw new CampusError("WRITE_NOT_ALLOWED", "until debe ser AAAA-MM-DDTHH:MM (zona del perfil) o ISO 8601 con zona.");
            const a = await assignmentOf(ctx, input.course_id, input.assignment_id);
            // Moodle la rechaza con un aviso si es anterior al vencimiento o a «permitir entregas desde».
            if (a.duedate && t < a.duedate) throw new CampusError("WRITE_NOT_ALLOWED", "La prórroga es anterior al vencimiento de la tarea.");
            if (a.allowsubmissionsfromdate && t < a.allowsubmissionsfromdate) throw new CampusError("WRITE_NOT_ALLOWED", "La prórroga es anterior a «permitir entregas desde».");
            if (a.cutoffdate && t > a.cutoffdate) warnings.push("La prórroga supera la fecha de corte: Moodle lo permite y la entrega queda abierta hasta la prórroga.");
            if (!a.duedate && !a.cutoffdate) warnings.push("La tarea no tiene vencimiento ni fecha de corte: la prórroga no cambia nada visible.");
            date = t;
        }
        return buildExtension({ course_id: input.course_id, assignment_id: input.assignment_id, participants: input.participant_ids.map((id) => ({ id, date })) }, ctx, null, warnings);
    },
    async undo(plan, result, ctx) {
        const applied = appliedItems(plan, result);
        if (!applied.length) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const prior = (plan.prior_state as { extensions: Record<string, number> }).extensions;
        return {
            kind: "plan",
            draft: await buildExtension(
                { course_id: plan.course_id, assignment_id: Number(applied[0]!.item.target.assignment_id), participants: applied.map(({ item }) => ({ id: Number(item.target.user_id), date: prior[String(item.target.user_id)] ?? 0 })) },
                ctx,
                result.action_id,
                [],
            ),
        };
    },
};

// ---------- bloqueo de entregas ----------

const lockShape = {
    course_id: courseId,
    assignment_id: z.number().int().positive(),
    participant_ids: z.array(z.number().int().positive()).min(1).max(30),
    locked: z.boolean().describe("true bloquea la entrega (el participante no puede modificarla); false desbloquea."),
};

async function buildLock(input: { course_id: number; assignment_id: number; participant_ids: number[]; locked: boolean }, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const a = await assignmentOf(ctx, input.course_id, input.assignment_id);
    const people = await resolveParticipants(ctx, a.id, input.participant_ids);
    const versions: Record<string, number> = {};
    const items: PlanItem[] = [];
    for (const id of input.participant_ids) {
        const s = await flagsOf(ctx, a.id, id);
        versions[`lock:${a.id}:${id}`] = s.locked ? 1 : 0;
        if (s.locked === input.locked) continue;
        items.push({
            item_id: `i${items.length + 1}`,
            description: `${input.locked ? "Bloquear" : "Desbloquear"} la entrega del participante ${id}`,
            call: { fn: input.locked ? "mod_assign_lock_submissions" : "mod_assign_unlock_submissions", params: { assignmentid: a.id, userids: [id] } },
            target: { course_id: input.course_id, assignment_id: a.id, user_id: id },
            expected: { locked: input.locked },
        });
    }
    if (!items.length) throw new CampusError("WRITE_NOT_ALLOWED", "Las entregas ya están en ese estado: no hay nada que escribir.");
    return {
        intent: "submission_lock",
        capability: "lock_submissions",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}${input.locked ? "bloquear" : "desbloquear"} ${items.length} entrega/s en «${a.name ?? a.id}».`,
        payload_preview: { assignment: { assignment_id: a.id, name: a.name ?? null }, locked: input.locked, participants: people.filter((p) => items.some((i) => i.target.user_id === p.id)) },
        side_effects: [input.locked ? "El participante no puede modificar su entrega hasta que se desbloquee." : "El participante puede volver a modificar su entrega.", "No afecta la calificación. Sin mensajes."],
        preconditions: { description: "El bloqueo de cada entrega no cambió desde el plan.", versions },
        undo: { kind: "exacto", how: "La operación inversa.", until: null },
        warnings: [],
        items,
        prior_state: {},
        untrusted_fields: ["payload_preview.assignment.name", "payload_preview.participants[].name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const submissionLockIntent: WriteIntent<typeof lockShape> = {
    name: "submission_lock",
    title: "Plan: bloquear o desbloquear entregas",
    description: "Arma el plan para bloquear o desbloquear la entrega de participantes de una tarea del curso. No escribe. Sin mensajes.",
    inputShape: lockShape,
    capability: "lock_submissions",
    synthetic_only: false,
    ...common,
    plan: (input, ctx) => buildLock(input, ctx, null),
    async undo(plan, result, ctx) {
        const applied = appliedItems(plan, result);
        if (!applied.length) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const locked = applied[0]!.item.expected.locked === true;
        return { kind: "plan", draft: await buildLock({ course_id: plan.course_id, assignment_id: Number(applied[0]!.item.target.assignment_id), participant_ids: applied.map(({ item }) => Number(item.target.user_id)), locked: !locked }, ctx, result.action_id) };
    },
};

// ---------- comentario de entrega ----------

const commentShape = {
    course_id: courseId,
    assignment_id: z.number().int().positive(),
    participant_id: z.number().int().positive(),
    text: z.string().min(1).max(2_000).describe("Texto del comentario (se guarda como texto de Moodle, sin HTML)."),
};

export const submissionCommentIntent: WriteIntent<typeof commentShape> = {
    name: "submission_comment",
    title: "Plan: comentar una entrega",
    description: "Arma el plan para agregar un comentario a la entrega de un participante (visible para el participante). No escribe. Sin notificaciones del núcleo.",
    inputShape: commentShape,
    capability: "submission_comment",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const a = await assignmentOf(ctx, input.course_id, input.assignment_id);
        const [person] = await resolveParticipants(ctx, a.id, [input.participant_id]);
        const s = await submissionOf(ctx, a.id, a.teamsubmission === 1, input.participant_id);
        if (!s.submissionId) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "El participante no tiene una entrega en esta tarea: no hay dónde comentar.");
        const text = input.text.replace(/\r\n?/g, "\n").trim();
        if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new CampusError("WRITE_NOT_ALLOWED", "El texto tiene caracteres de control.");
        return {
            intent: "submission_comment",
            capability: "submission_comment",
            course_id: input.course_id,
            base_risk: "R2",
            summary: `Comentar la entrega del participante ${input.participant_id} en «${a.name ?? a.id}».`,
            payload_preview: {
                assignment: { assignment_id: a.id, name: a.name ?? null },
                participant: person,
                submission: { submission_id: s.submissionId, status: s.status },
                text,
                component: "assignsubmission_comments / submission_comments",
            },
            side_effects: ["Visible para el participante (y para quien pueda ver la entrega).", "Sin notificaciones del núcleo."],
            preconditions: { description: "Sin precondiciones de versión: es una creación.", versions: {} },
            undo: { kind: "exacto", how: "Borrar el comentario. Si el participante ya lo leyó, eso no se deshace.", until: null },
            warnings: [],
            items: [
                {
                    item_id: "i1",
                    description: `Comentario en la entrega ${s.submissionId}`,
                    call: {
                        fn: "core_comment_add_comments",
                        params: { comments: [{ contextlevel: "module", instanceid: a.cmid, component: "assignsubmission_comments", content: text, itemid: s.submissionId, area: "submission_comments" }] },
                    },
                    target: { course_id: input.course_id, cmid: a.cmid, submission_id: s.submissionId, user_id: input.participant_id },
                    expected: { content_text: comparable(toHtml(text, "texto")) },
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.assignment.name", "payload_preview.participant.name"],
            teacher_text: { text },
            undo_of: null,
        };
    },
    async undo(plan, result): Promise<UndoDraft> {
        const applied = appliedItems(plan, result);
        const commentId = applied[0]?.r.moodle_ids.comment_id;
        if (!applied.length || !commentId) return { kind: "ninguno", reason: "No se conoce el comentario creado." };
        const t = applied[0]!.item.target;
        return {
            kind: "plan",
            draft: {
                intent: "submission_comment",
                capability: "submission_comment",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar el comentario ${commentId}.`,
                payload_preview: { delete_comment: commentId },
                side_effects: ["Borra el comentario (irreversible)."],
                preconditions: { description: "El comentario sigue existiendo.", versions: { [`comment:${t.cmid}:${t.submission_id}:${commentId}`]: 1 } },
                undo: { kind: "ninguno", how: "El borrado no se puede deshacer.", until: null },
                warnings: [],
                items: [
                    {
                        item_id: "i1",
                        description: `Borrar el comentario ${commentId}`,
                        call: { fn: "core_comment_delete_comments", params: { comments: [commentId] } },
                        target: { ...t, comment_id: commentId },
                        expected: { deleted: true },
                    },
                ],
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};

export const W2_INTENTS = [calendarEventIntent, extensionIntent, submissionLockIntent, submissionCommentIntent];
