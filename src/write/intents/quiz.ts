import { z } from "zod";
import { CampusError } from "../../errors.js";
import { EnrolledUsersSchema, GroupsSchema, QuizOverridesSchema } from "../../moodle/schemas.js";
import { formatLocal } from "../../util/time.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanItem } from "../plan.js";
import { toHtml } from "../text.js";
import type { FormSubmission } from "../web.js";
import { parseLocalDateTime } from "./w2.js";

/**
 * Cuestionarios: crear uno vacío por formulario (W6 adelantada, ADR-056) y overrides por estudiante
 * (directiva §8.8, W4; investigación [T] §20).
 * - Override: AJAX `mod_quiz_save_overrides`, SÓLO alta de un override nuevo para un usuario. Una
 *   actualización es un reemplazo completo y borraría la contraseña del override, que no se lee a
 *   propósito: si ya existe, se rechaza. Los overrides no visibles se descartan EN SILENCIO: se
 *   verifica que vuelva exactamente un id y que la relectura lo muestre.
 * - Deshacer: `mod_quiz_delete_overrides` (irreversible) o `cm_delete` del cuestionario.
 */

const QuizzesSchema = z.object({
    quizzes: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), course: z.number().int(), name: z.string().nullable().optional(), timeopen: z.number().nullable().optional(), timeclose: z.number().nullable().optional(), timelimit: z.number().nullable().optional(), attempts: z.number().nullable().optional() })).default([]),
});
const ContentsSchema = z.array(z.object({ section: z.number().nullable().optional(), modules: z.array(z.object({ id: z.number().int().positive(), modname: z.string(), visible: z.number().nullable().optional() })).default([]) }));

async function quizzesOf(ctx: IntentContext, courseId: number) {
    return (await ctx.read.session.transport.call("mod_quiz_get_quizzes_by_courses", { courseids: [courseId] }, QuizzesSchema)).quizzes.filter((q) => q.course === courseId);
}

export async function overridesOf(ctx: IntentContext, quizId: number) {
    const web = ctx.read.web;
    if (!web) throw new CampusError("AUTH_REQUIRED", "Los overrides de cuestionarios necesitan la sesión web del Campus.");
    const op = await web.open();
    try {
        const parsed = QuizOverridesSchema.safeParse(await op.ajax<unknown>("mod_quiz_get_overrides", { quizid: quizId }));
        if (!parsed.success) throw new CampusError("UNEXPECTED_RESPONSE", "La lista de overrides no tiene la forma esperada.");
        return parsed.data.overrides; // la contraseña se descarta en la proyección
    } finally {
        await web.afterOperation(op);
    }
}

const local = (ctx: IntentContext, u: number | null | undefined) => (u ? formatLocal(new Date(u * 1000), ctx.profile.read_profile.timezone) : "sin fecha");

function dateFields(key: string, unix: number, tz: string): Record<string, string> {
    if (!unix) return { [`${key}[enabled]`]: "0" };
    const l = formatLocal(new Date(unix * 1000), tz);
    return { [`${key}[enabled]`]: "1", [`${key}[day]`]: String(Number(l.slice(8, 10))), [`${key}[month]`]: String(Number(l.slice(5, 7))), [`${key}[year]`]: l.slice(0, 4), [`${key}[hour]`]: String(Number(l.slice(11, 13))), [`${key}[minute]`]: String(Number(l.slice(14, 16))) };
}

// ---------- motor común ----------

/** `override:<quiz>:<user>` / `goverride:<quiz>:<grupo>` → id o null · `cm:<curso>:<cmid>` → 1 o null. */
async function readVersions(plan: Plan, ctx: IntentContext) {
    const out: Record<string, string | number | null> = {};
    for (const key of Object.keys(plan.preconditions.versions)) {
        const [k, a, b] = key.split(":");
        if (k === "override") out[key] = (await overridesOf(ctx, Number(a))).find((o) => o.userid === Number(b))?.id ?? null;
        else if (k === "goverride") out[key] = (await overridesOf(ctx, Number(a))).find((o) => o.groupid === Number(b))?.id ?? null;
        else if (k === "cm") {
            const c = await ctx.read.session.transport.call("core_course_get_contents", { courseid: Number(a) }, ContentsSchema);
            out[key] = c.some((s) => s.modules.some((m) => m.id === Number(b))) ? 1 : null;
        } else out[key] = null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    if (item.call.kind === "form") {
        const cmid = /\/mod\/quiz\/view\.php\?(?:.*&)?id=(\d+)/.exec((data as FormSubmission | null)?.location ?? "")?.[1];
        return cmid ? { ok: true, moodle_ids: { cmid: Number(cmid) } } : { ok: true };
    }
    if (item.call.fn === "mod_quiz_save_overrides") {
        const ids = (data as { ids?: unknown } | null)?.ids;
        // Un override no visible se descarta sin aviso: la lista de ids pierde la correspondencia.
        if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "number") return { ok: false, reason: `Moodle devolvió ${Array.isArray(ids) ? ids.length : 0} ids para 1 override (descarte silencioso).` };
        return { ok: true, moodle_ids: { override_id: ids[0] } };
    }
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected;
    if (item.call.fn === "mod_quiz_save_overrides") {
        const o = (await overridesOf(ctx, Number(t.quiz_id))).find((y) => (t.group_id ? y.groupid === Number(t.group_id) : y.userid === Number(t.user_id)));
        if (!o) return { outcome: "sin_efecto", checked: ["override"], differences: [{ field: "override", expected: "creado", observed: "no existe" }] };
        const differences: Difference[] = [];
        for (const f of ["timeopen", "timeclose", "timelimit", "attempts"] as const) {
            if (x[f] !== undefined && (o[f] ?? null) !== x[f]) differences.push({ field: f, expected: x[f], observed: o[f] ?? null });
        }
        return { outcome: differences.length ? "difiere" : "coincide", checked: ["timeopen", "timeclose", "timelimit", "attempts"], differences, moodle_ids: { override_id: o.id } };
    }
    if (item.call.fn === "mod_quiz_delete_overrides") {
        const still = (await overridesOf(ctx, Number(t.quiz_id))).some((o) => o.id === Number(t.override_id));
        return still ? { outcome: "sin_efecto", checked: ["override"], differences: [{ field: "override", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["override"], differences: [] };
    }
    if (item.call.fn === "core_courseformat_update_course") {
        const c = await ctx.read.session.transport.call("core_course_get_contents", { courseid: plan.course_id }, ContentsSchema);
        const still = c.some((s) => s.modules.some((m) => m.id === Number(t.cmid)));
        return still ? { outcome: "sin_efecto", checked: ["actividad"], differences: [{ field: "actividad", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["actividad"], differences: [] };
    }
    // Alta del cuestionario.
    const quizzes = await quizzesOf(ctx, plan.course_id);
    const q = known.cmid ? quizzes.find((y) => y.coursemodule === known.cmid) : quizzes.find((y) => y.name === x.name && !(x.prior_cmids as number[]).includes(y.coursemodule));
    if (!q) return { outcome: "sin_efecto", checked: ["cuestionario"], differences: [{ field: "cuestionario", expected: "creado", observed: "no aparece" }] };
    const c = await ctx.read.session.transport.call("core_course_get_contents", { courseid: plan.course_id }, ContentsSchema);
    const sec = c.find((s) => s.modules.some((m) => m.id === q.coursemodule));
    const mod = sec?.modules.find((m) => m.id === q.coursemodule);
    const differences: Difference[] = [];
    const cmp = (field: string, exp: unknown, obs: unknown) => {
        if (exp !== obs) differences.push({ field, expected: exp, observed: obs });
    };
    cmp("name", x.name, q.name ?? null);
    cmp("timeopen", x.timeopen, q.timeopen ?? 0);
    cmp("timeclose", x.timeclose, q.timeclose ?? 0);
    cmp("timelimit", x.timelimit, q.timelimit ?? 0);
    cmp("attempts", x.attempts, q.attempts ?? 0);
    cmp("section", x.section, sec?.section ?? null);
    cmp("visible", x.visible, mod ? mod.visible === 1 : null);
    return { outcome: differences.length ? "difiere" : "coincide", checked: ["name", "timeopen", "timeclose", "timelimit", "attempts", "section", "visible"], differences, moodle_ids: { cmid: q.coursemodule, quiz_id: q.id } };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };
const applied = (r: { outcome: string }) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido";

// ---------- crear el cuestionario ----------

const createShape = {
    course_id: z.number().int().positive(),
    name: z.string().min(1).max(255),
    intro: z.string().max(10_000).optional(),
    section: z.number().int().min(0).max(200),
    visible: z.boolean().optional().describe("Por defecto false: se crea oculto."),
    open: z.string().max(40).optional().describe("Apertura (AAAA-MM-DDTHH:MM local o ISO con zona). Ausente = sin fecha."),
    close: z.string().max(40).optional().describe("Cierre. Ausente = sin fecha."),
    time_limit_minutes: z.number().int().min(0).max(1440).optional().describe("0 o ausente = sin límite."),
    attempts: z.number().int().min(0).max(10).optional().describe("0 o ausente = ilimitados."),
};

export const createQuizIntent: WriteIntent<typeof createShape> = {
    name: "create_quiz",
    title: "Plan: crear un cuestionario",
    description: "Arma el plan para crear un cuestionario VACÍO (sin preguntas) en una sección existente; por defecto oculto y sin notificar. No escribe.",
    inputShape: createShape,
    capability: "create_quiz",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const tz = ctx.profile.read_profile.timezone;
        const c = await ctx.read.session.transport.call("core_course_get_contents", { courseid: input.course_id }, ContentsSchema);
        if (!c.some((s) => s.section === input.section)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.section} no existe (abrir el formulario la crearía).`);
        const when = (v: string | undefined, label: string) => {
            if (v === undefined) return 0;
            const t = parseLocalDateTime(v, tz);
            if (t === null) throw new CampusError("WRITE_NOT_ALLOWED", `${label}: usá AAAA-MM-DDTHH:MM o ISO 8601 con zona.`);
            return t;
        };
        const timeopen = when(input.open, "open");
        const timeclose = when(input.close, "close");
        if (timeopen && timeclose && timeclose <= timeopen) throw new CampusError("WRITE_NOT_ALLOWED", "El cierre tiene que ser posterior a la apertura.");
        const visible = input.visible ?? false;
        const minutes = input.time_limit_minutes ?? 0;
        const attempts = input.attempts ?? 0;
        const html = input.intro ? toHtml(input.intro, "markdown") : "";
        const fields: Record<string, string> = {
            name: input.name,
            "introeditor[text]": html,
            "introeditor[format]": "1",
            visible: visible ? "1" : "0",
            coursecontentnotification: "0",
            "timelimit[enabled]": minutes ? "1" : "0",
            "timelimit[number]": String(minutes),
            "timelimit[timeunit]": "60",
            attempts: String(attempts),
            ...dateFields("timeopen", timeopen, tz),
            ...dateFields("timeclose", timeclose, tz),
        };
        const prior = c.flatMap((s) => s.modules.map((m) => m.id));
        return {
            intent: "create_quiz",
            capability: "create_quiz",
            course_id: input.course_id,
            base_risk: visible ? "R2" : "R1",
            summary: `Crear el cuestionario vacío «${input.name}» ${visible ? "VISIBLE" : "oculto"} en la sección ${input.section}.`,
            payload_preview: { name: input.name, intro_html: html, section: input.section, visible, open: local(ctx, timeopen), close: local(ctx, timeclose), time_limit_minutes: minutes || "sin límite", attempts: attempts || "ilimitados", questions: "ninguna (se agregan aparte)", notifications: "ninguna", other_settings: "valores por defecto del formulario del sitio" },
            side_effects: ["Crea el cuestionario, su ítem de calificación y sus eventos de apertura y cierre.", "Crea la categoría de preguntas por defecto del cuestionario.", "Sin notificaciones."],
            preconditions: { description: "La sección sigue existiendo.", versions: {} },
            undo: { kind: "compensación", how: "Borrar el cuestionario (papelera; restaurarlo crea otro cmid).", until: null },
            warnings: ["Creación por formulario web: requiere la sesión web del Campus."],
            items: [
                {
                    item_id: "i1",
                    description: `Nuevo cuestionario «${input.name}»`,
                    call: { kind: "form", fn: "course_modedit_quiz_add", params: { query: { add: "quiz", course: String(input.course_id), section: String(input.section) }, fields } },
                    target: { course_id: input.course_id, section: input.section },
                    expected: { name: input.name, timeopen, timeclose, timelimit: minutes * 60, attempts, section: input.section, visible, prior_cmids: prior },
                },
            ],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: { name: input.name },
            undo_of: null,
        };
    },
    async undo(plan, result) {
        const cmid = result.items.find(applied)?.moodle_ids.cmid;
        if (!cmid) return { kind: "ninguno", reason: "No se conoce el cuestionario creado." };
        return {
            kind: "plan",
            draft: {
                intent: "create_quiz",
                capability: "create_quiz",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar el cuestionario (cmid ${cmid}).`,
                payload_preview: { delete_activity: cmid },
                side_effects: ["Va a la papelera (7 días) con sus intentos, si los hubiera."],
                preconditions: { description: "El cuestionario sigue en el curso.", versions: { [`cm:${plan.course_id}:${cmid}`]: 1 } },
                undo: { kind: "ninguno", how: "Sólo restaurando desde la papelera, a mano.", until: null },
                warnings: [],
                items: [{ item_id: "i1", description: `Borrar el cuestionario ${cmid}`, call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "cm_delete", courseid: plan.course_id, ids: [cmid] } }, target: { course_id: plan.course_id, cmid }, expected: { deleted: true } }],
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};

// ---------- override por estudiante ----------

const overrideShape = {
    course_id: z.number().int().positive(),
    quiz_id: z.number().int().positive(),
    participant_id: z.number().int().positive().optional(),
    group_id: z.number().int().positive().optional().describe("Alternativa a participant_id: excepción para un GRUPO del curso."),
    open: z.string().max(40).optional(),
    close: z.string().max(40).optional(),
    time_limit_minutes: z.number().int().min(1).max(1440).optional(),
    attempts: z.number().int().min(0).max(20).optional().describe("0 = ilimitados."),
};

export const quizOverrideIntent: WriteIntent<typeof overrideShape> = {
    name: "quiz_override",
    title: "Plan: excepción de un cuestionario para un estudiante o un grupo",
    description: "Arma el plan para dar a UN estudiante (participant_id) o a UN grupo (group_id) otras fechas, tiempo o intentos en un cuestionario del curso (override nuevo). No escribe. Sin notificaciones.",
    inputShape: overrideShape,
    capability: "quiz_override",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const q = (await quizzesOf(ctx, input.course_id)).find((y) => y.id === input.quiz_id);
        if (!q) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El cuestionario ${input.quiz_id} no es del curso.`);
        if ((input.participant_id === undefined) === (input.group_id === undefined)) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá participant_id o group_id (uno de los dos).");
        let who: { kind: "user" | "group"; id: number; name: string | null };
        if (input.group_id !== undefined) {
            const g = (await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: input.course_id }, GroupsSchema)).find((x) => x.id === input.group_id && x.courseid === input.course_id);
            if (!g) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El grupo ${input.group_id} no es del curso.`);
            who = { kind: "group", id: g.id, name: g.name ?? null };
        } else {
            // Moodle no verifica la matrícula del usuario: se verifica acá.
            const users = await ctx.read.session.transport.call("core_enrol_get_enrolled_users", { courseid: input.course_id }, EnrolledUsersSchema);
            const person = users.find((u) => u.id === input.participant_id);
            if (!person) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El usuario ${input.participant_id} no está matriculado en el curso.`);
            who = { kind: "user", id: person.id, name: person.fullname ?? null };
        }
        const existing = (await overridesOf(ctx, q.id)).find((o) => (who.kind === "group" ? o.groupid === who.id : o.userid === who.id));
        if (existing) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay un override para ese ${who.kind === "group" ? "grupo" : "estudiante"} (id ${existing.id}). Actualizarlo es un reemplazo completo que borraría su contraseña: borralo primero (deshaciendo su alta) o editalo desde la web.`);
        const tz = ctx.profile.read_profile.timezone;
        const when = (v: string | undefined, label: string) => {
            if (v === undefined) return undefined;
            const t = parseLocalDateTime(v, tz);
            if (t === null) throw new CampusError("WRITE_NOT_ALLOWED", `${label}: usá AAAA-MM-DDTHH:MM o ISO 8601 con zona.`);
            return t;
        };
        const timeopen = when(input.open, "open");
        const timeclose = when(input.close, "close");
        const timelimit = input.time_limit_minutes !== undefined ? input.time_limit_minutes * 60 : undefined;
        if (timeopen === undefined && timeclose === undefined && timelimit === undefined && input.attempts === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá al menos una excepción (apertura, cierre, tiempo o intentos).");
        const effOpen = timeopen ?? q.timeopen ?? 0;
        const effClose = timeclose ?? q.timeclose ?? 0;
        if (effOpen && effClose && effClose <= effOpen) throw new CampusError("WRITE_NOT_ALLOWED", "El cierre tiene que ser posterior a la apertura.");
        const override: Record<string, number> = who.kind === "group" ? { groupid: who.id } : { userid: who.id };
        if (timeopen !== undefined) override.timeopen = timeopen;
        if (timeclose !== undefined) override.timeclose = timeclose;
        if (timelimit !== undefined) override.timelimit = timelimit;
        if (input.attempts !== undefined) override.attempts = input.attempts;
        return {
            intent: "quiz_override",
            capability: "quiz_override",
            course_id: input.course_id,
            base_risk: "R3",
            summary: `Excepción en «${q.name ?? q.id}» para ${who.kind === "group" ? "el grupo" : "el participante"} ${who.id}.`,
            payload_preview: {
                quiz: { quiz_id: q.id, name: q.name ?? null, open: local(ctx, q.timeopen), close: local(ctx, q.timeclose), time_limit_minutes: (q.timelimit ?? 0) / 60, attempts: q.attempts ?? 0 },
                [who.kind === "group" ? "group" : "participant"]: { id: who.id, name: who.name },
                override: { open: timeopen !== undefined ? local(ctx, timeopen) : "(igual que el cuestionario)", close: timeclose !== undefined ? local(ctx, timeclose) : "(igual)", time_limit_minutes: timelimit !== undefined ? timelimit / 60 : "(igual)", attempts: input.attempts ?? "(igual)", password: "(ninguna)" },
            },
            side_effects: [`Cambia fechas, tiempo o intentos sólo para ${who.kind === "group" ? "los miembros del grupo (un override de usuario tiene prioridad)" : "ese estudiante"}; actualiza el calendario y los intentos abiertos.`, "Sin notificaciones."],
            preconditions: { description: "Sigue sin override.", versions: { [`${who.kind === "group" ? "goverride" : "override"}:${q.id}:${who.id}`]: null } },
            undo: { kind: "exacto", how: "Borrar el override (el estudiante vuelve a la configuración general).", until: null },
            warnings: [],
            items: [
                {
                    item_id: "i1",
                    description: `Override ${who.kind === "group" ? "del grupo" : "del participante"} ${who.id}`,
                    call: { kind: "ajax", fn: "mod_quiz_save_overrides", params: { data: { quizid: q.id, overrides: [override] } } },
                    target: { course_id: input.course_id, quiz_id: q.id, [who.kind === "group" ? "group_id" : "user_id"]: who.id } as Record<string, number>,
                    expected: { timeopen, timeclose, timelimit, attempts: input.attempts },
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.quiz.name", "payload_preview.participant.name", "payload_preview.group.name"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo(plan, result) {
        const id = result.items.find(applied)?.moodle_ids.override_id;
        if (!id) return { kind: "ninguno", reason: "No se conoce el override creado." };
        const t = plan.items[0]!.target;
        return {
            kind: "plan",
            draft: {
                intent: "quiz_override",
                capability: "quiz_override",
                course_id: plan.course_id,
                base_risk: "R3",
                summary: `Deshacer: borrar el override ${id}.`,
                payload_preview: { delete_override: id },
                side_effects: ["El estudiante vuelve a la configuración general del cuestionario."],
                preconditions: { description: "El override sigue existiendo.", versions: { [t.group_id ? `goverride:${t.quiz_id}:${t.group_id}` : `override:${t.quiz_id}:${t.user_id}`]: id } },
                undo: { kind: "ninguno", how: "Borrar un override es irreversible (se puede recrear).", until: null },
                warnings: [],
                items: [{ item_id: "i1", description: `Borrar el override ${id}`, call: { kind: "ajax", fn: "mod_quiz_delete_overrides", params: { data: { quizid: Number(t.quiz_id), ids: [id] } } }, target: { ...t, override_id: id }, expected: { deleted: true } }],
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};

export const QUIZ_INTENTS = [createQuizIntent, quizOverrideIntent];
