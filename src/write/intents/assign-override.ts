import { z } from "zod";
import { CampusError } from "../../errors.js";
import { AssignmentsSchema, EnrolledUsersSchema, GroupsSchema } from "../../moodle/schemas.js";
import { formatLocal } from "../../util/time.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { parseFormFields } from "../web.js";
import { parseLocalDateTime } from "./w2.js";

/**
 * W6 · Override de una TAREA para un participante (directiva §8.8; investigación [T] §18; ADR-066).
 * No hay servicio web: formulario `/mod/assign/overrideedit.php?action=adduser`.
 * - Moodle FUSIONA un override nuevo con uno existente del mismo usuario y borra el anterior: sólo
 *   se admite crear cuando el participante no tiene override (se averigua leyendo la lista
 *   `overrides.php` y el formulario de cada override).
 * - Una fecha no indicada queda igual a la de la tarea (Moodle la guarda como null).
 * - Verificación: el override nuevo aparece en la lista y su formulario tiene el usuario y las fechas.
 * - Deshacer: `/mod/assign/overridedelete.php` con `confirm=1` (POST con sesskey).
 * Sin mensajes a estudiantes.
 */

const KEYS = { open: "allowsubmissionsfromdate", due: "duedate", cutoff: "cutoffdate" } as const;
type Key = (typeof KEYS)[keyof typeof KEYS];

async function assignment(ctx: IntentContext, courseId: number, cmid: number) {
    const a = (await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [courseId] }, AssignmentsSchema)).courses.find((c) => c.id === courseId)?.assignments.find((x) => x.cmid === cmid);
    if (!a) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es una tarea del curso ${courseId}.`);
    return { id: a.id, cmid, name: a.name ?? String(cmid), values: { allowsubmissionsfromdate: a.allowsubmissionsfromdate ?? 0, duedate: a.duedate ?? 0, cutoffdate: a.cutoffdate ?? 0 } as Record<Key, number> };
}

/** Ids de overrides de usuario de la tarea (lista web). «No hay» explícito → []; página irreconocible → error. */
export function parseOverrideIds(html: string): number[] | null {
    const i = html.indexOf('role="main"');
    if (i < 0) return null;
    const main = html.slice(i);
    const ids = [...main.matchAll(/\/mod\/assign\/override(?:edit|delete)\.php\?(?:[^"]*&(?:amp;)?)?id=(\d+)/g)].map((m) => Number(m[1]));
    return [...new Set(ids)].sort((a, b) => a - b);
}

/** Usuario y fechas de un override (formulario de edición). */
export function parseOverrideForm(html: string, tz: string): { userid: number | null; groupid: number | null; values: Record<Key, number> } | null {
    const fields = parseFormFields(html, "_qf__assign_override_form");
    if (!fields) return null;
    const get = (k: string) => fields.filter(([n]) => n === k).map(([, v]) => v).at(-1);
    const values = {} as Record<Key, number>;
    for (const k of Object.values(KEYS)) {
        if (get(`${k}[enabled]`) !== "1") {
            values[k] = 0;
            continue;
        }
        const p = (x: string) => String(get(`${k}[${x}]`) ?? "0").padStart(2, "0");
        values[k] = parseLocalDateTime(`${get(`${k}[year]`)}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}`, tz) ?? -1;
    }
    const id = (k: string) => {
        const n = Number(get(k));
        return Number.isInteger(n) && n > 0 ? n : null;
    };
    return { userid: id("userid"), groupid: id("groupid"), values };
}

export async function overrideIds(ctx: IntentContext, cmid: number, mode: "user" | "group" = "user") {
    const ids = parseOverrideIds(await ctx.web.readPage("assign_overrides", { cmid: String(cmid), mode }));
    if (!ids) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció la lista de excepciones de la tarea.");
    return ids;
}

export async function overrideForm(ctx: IntentContext, id: number) {
    const f = parseOverrideForm(await ctx.web.readPage("assign_override_form", { id: String(id) }), ctx.profile.read_profile.timezone);
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `No se reconoció el formulario de la excepción ${id}.`);
    return f;
}

function selector(key: string, unix: number, tz: string): Record<string, string> {
    if (!unix) return { [`${key}[enabled]`]: "0" };
    const l = formatLocal(new Date(unix * 1000), tz);
    return {
        [`${key}[enabled]`]: "1",
        [`${key}[day]`]: String(Number(l.slice(8, 10))),
        [`${key}[month]`]: String(Number(l.slice(5, 7))),
        [`${key}[year]`]: l.slice(0, 4),
        [`${key}[hour]`]: String(Number(l.slice(11, 13))),
        [`${key}[minute]`]: String(Number(l.slice(14, 16))),
    };
}

// ---------- versiones, interpretación y verificación ----------

/** `aovr:<cmid>[:group]` = ids de overrides de usuario (o de grupo) de la tarea. */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, cmid, mode] = k.split(":");
        out[k] = kind === "aovr" ? (await overrideIds(ctx, Number(cmid), mode === "group" ? "group" : "user")).join(",") : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const t = item.target;
    const mode = t.group_id ? "group" : "user";
    const ids = await overrideIds(ctx, Number(t.cmid), mode);
    if (item.call.fn === "assign_override_delete") {
        return ids.includes(Number(t.override_id)) ? { outcome: "sin_efecto", checked: ["excepción"], differences: [{ field: "excepción", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["excepción"], differences: [] };
    }
    const prior = new Set(item.expected.prior_ids as number[]);
    const fresh = known.override_id ? [known.override_id] : ids.filter((id) => !prior.has(id));
    for (const id of fresh) {
        const f = await overrideForm(ctx, id);
        if (mode === "group" ? f.groupid !== Number(t.group_id) : f.userid !== Number(t.user_id)) continue;
        const want = item.expected.values as Record<Key, number>;
        const differences: Difference[] = (Object.keys(want) as Key[]).filter((k) => Math.floor(f.values[k] / 60) !== Math.floor(want[k] / 60)).map((k) => ({ field: k, expected: want[k], observed: f.values[k] }));
        return { outcome: differences.length ? "difiere" : "coincide", checked: [mode === "group" ? "grupo" : "usuario", ...Object.keys(want)], differences, moodle_ids: { override_id: id } };
    }
    return { outcome: "sin_efecto", checked: ["excepción"], differences: [{ field: "excepción", expected: "creada", observed: "no aparece" }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

// ---------- intención ----------

const date = z.string().max(40).optional();
const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de una tarea del curso."),
    participant_id: z.number().int().positive().optional().describe("Participante matriculado."),
    group_id: z.number().int().positive().optional().describe("Alternativa a participant_id: excepción para un GRUPO del curso."),
    open: date.describe("Apertura de entregas para ese participante (AAAA-MM-DDTHH:MM local). Ausente = la de la tarea."),
    due: date.describe("Vencimiento para ese participante. Ausente = el de la tarea."),
    cutoff: date.describe("Fecha límite para ese participante. Ausente = la de la tarea."),
};

export const assignOverrideIntent: WriteIntent<typeof shape> = {
    name: "assign_override",
    title: "Plan: excepción de fechas de una tarea para un participante",
    description:
        "Arma el plan para crear una excepción (override) de una tarea para UN participante (participant_id) o UN grupo (group_id): apertura, vencimiento y fecha límite propias. Sólo si no tiene una (Moodle fusionaría y borraría la anterior). Para una simple prórroga del vencimiento también existe campus_plan_extension. No escribe.",
    inputShape: shape,
    capability: "assign_override",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const tz = ctx.profile.read_profile.timezone;
        const a = await assignment(ctx, input.course_id, input.course_module_id);
        if ((input.participant_id === undefined) === (input.group_id === undefined)) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá participant_id o group_id (uno de los dos).");
        let who: { kind: "user" | "group"; id: number; name: string | null };
        if (input.group_id !== undefined) {
            const g = (await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: input.course_id }, GroupsSchema)).find((x) => x.id === input.group_id && x.courseid === input.course_id);
            if (!g) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El grupo ${input.group_id} no es del curso.`);
            who = { kind: "group", id: g.id, name: g.name ?? null };
        } else {
            const u = (await ctx.read.session.transport.call("core_enrol_get_enrolled_users", { courseid: input.course_id }, EnrolledUsersSchema)).find((x) => x.id === input.participant_id);
            if (!u) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${input.participant_id} no está matriculado en el curso.`);
            who = { kind: "user", id: u.id, name: u.fullname ?? null };
        }
        const mode = who.kind;
        if (input.open === undefined && input.due === undefined && input.cutoff === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá al menos una fecha (open, due o cutoff).");
        const values = { ...a.values };
        for (const k of ["open", "due", "cutoff"] as const) {
            const raw = input[k];
            if (raw === undefined) continue;
            const unix = parseLocalDateTime(raw, tz);
            if (unix === null) throw new CampusError("WRITE_NOT_ALLOWED", `${k}: fecha inválida (${raw}). Usá AAAA-MM-DDTHH:MM.`);
            values[KEYS[k]] = Math.floor(unix / 60) * 60;
        }
        if ((Object.keys(values) as Key[]).every((k) => Math.floor(values[k] / 60) === Math.floor(a.values[k] / 60))) throw new CampusError("WRITE_NOT_ALLOWED", "Las fechas pedidas son las de la tarea: no hace falta una excepción.");
        if (values.allowsubmissionsfromdate && values.duedate && values.duedate < values.allowsubmissionsfromdate) throw new CampusError("WRITE_NOT_ALLOWED", "El vencimiento no puede ser anterior a la apertura.");
        if (values.duedate && values.cutoffdate && values.cutoffdate < values.duedate) throw new CampusError("WRITE_NOT_ALLOWED", "La fecha límite no puede ser anterior al vencimiento.");

        const ids = await overrideIds(ctx, a.cmid, mode);
        for (const id of ids) {
            const f = await overrideForm(ctx, id);
            if (mode === "group" ? f.groupid === who.id : f.userid === who.id) throw new CampusError("WRITE_NOT_ALLOWED", `${mode === "group" ? "El grupo" : "El participante"} ya tiene una excepción (${id}) en esta tarea: Moodle la fusionaría y borraría. Editala en el Campus o deshacé la anterior.`);
        }
        const show = (v: number) => (v ? formatLocal(new Date(v * 1000), tz).slice(0, 16) : "sin fecha");
        const draft: PlanDraft = {
            intent: "assign_override",
            capability: "assign_override",
            course_id: input.course_id,
            base_risk: "R2",
            summary: `Excepción en la tarea «${a.name}» para ${mode === "group" ? "el grupo" : "el participante"} ${who.id}: apertura ${show(values.allowsubmissionsfromdate)}, vencimiento ${show(values.duedate)}, límite ${show(values.cutoffdate)}.`,
            payload_preview: {
                assignment: { course_module_id: a.cmid, name: a.name, dates: Object.fromEntries((Object.keys(a.values) as Key[]).map((k) => [k, show(a.values[k])])) },
                [mode === "group" ? "group" : "participant"]: { id: who.id, name: who.name },
                override: Object.fromEntries((Object.keys(values) as Key[]).map((k) => [k, show(values[k])])),
                timezone: tz,
            },
            side_effects: [mode === "group" ? "Cambia las fechas de esa tarea para los miembros del grupo (una excepción de usuario tiene prioridad), y su calendario." : "Cambia las fechas de esa tarea sólo para ese participante, y su calendario.", "Sin mensajes."],
            preconditions: { description: "Las excepciones de la tarea no cambiaron desde el plan.", versions: { [`aovr:${a.cmid}:${mode}`]: ids.join(",") } },
            undo: { kind: "exacto", how: "Borrar la excepción creada.", until: null },
            warnings: ["Formulario web: requiere la sesión web del Campus."],
            items: [
                {
                    item_id: "i1",
                    description: `Excepción para ${mode === "group" ? "el grupo" : "el participante"} ${who.id}`,
                    call: {
                        kind: "form",
                        fn: "assign_override_add",
                        params: { query: { action: mode === "group" ? "addgroup" : "adduser", cmid: String(a.cmid) }, fields: { [mode === "group" ? "groupid" : "userid"]: String(who.id), ...(Object.keys(values) as Key[]).reduce((acc, k) => ({ ...acc, ...selector(k, values[k], tz) }), {} as Record<string, string>) } },
                    },
                    target: { course_id: input.course_id, cmid: a.cmid, [mode === "group" ? "group_id" : "user_id"]: who.id } as Record<string, number>,
                    expected: { values, prior_ids: ids },
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.assignment.name", "payload_preview.participant.name", "payload_preview.group.name"],
            teacher_text: {},
            undo_of: null,
        };
        return draft;
    },
    async undo(plan, result) {
        const r = result.items.find((i) => i.outcome === "verificado" || i.outcome === "con_diferencias");
        const id = r?.moodle_ids.override_id;
        if (!id) return { kind: "ninguno", reason: "No se conoce la excepción creada." };
        const cmid = Number(plan.items[0]!.target.cmid);
        return {
            kind: "plan",
            draft: {
                intent: "assign_override",
                capability: "assign_override",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar la excepción ${id} de la tarea ${cmid}.`,
                payload_preview: { delete_override: id },
                side_effects: ["El participante vuelve a las fechas de la tarea (o a su prórroga, si tiene)."],
                preconditions: { description: "Sin precondición: la relectura verifica.", versions: {} },
                undo: { kind: "ninguno", how: "Se puede volver a crear.", until: null },
                warnings: [],
                items: [
                    {
                        item_id: "i1",
                        description: `Borrar la excepción ${id}`,
                        call: { kind: "form", fn: "assign_override_delete", params: { query: {}, fields: { id: String(id), confirm: "1" } } },
                        target: { course_id: plan.course_id, cmid, override_id: id, ...(plan.items[0]!.target.group_id ? { group_id: Number(plan.items[0]!.target.group_id) } : {}) },
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
