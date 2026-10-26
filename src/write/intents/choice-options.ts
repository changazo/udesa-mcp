import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { fieldOf, readModForm } from "./modform.js";

/**
 * W6 · Opciones de una consulta (mod_choice; ADR-077): agregar, renombrar y quitar, por
 * `/course/modedit.php?update=<cmid>` (el resto de la configuración se reenvía tal cual).
 * - Moodle borra una opción existente cuando llega con texto vacío, CON sus respuestas: el plan sólo
 *   quita opciones sin respuestas. Renombrar una opción con respuestas cambia lo que eligieron: se avisa.
 * - Las opciones nuevas ocupan los espacios vacíos del formulario y, si hacen falta más, `option_repeats`.
 * - Verificación por `mod_choice_get_choice_options` (textos en orden de creación). Deshacer: compensación
 *   (nombres anteriores, quitar las agregadas, volver a agregar las quitadas, que quedan sin respuestas).
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional(), instance: z.number().nullable().optional() })).default([]) }));
const OptionsSchema = z.object({ options: z.array(z.object({ id: z.number().int(), text: z.string().nullable().optional(), countanswers: z.number().nullable().optional(), maxanswers: z.number().nullable().optional() })).default([]) });
const MAX_OPTIONS = 30;

interface Current {
    cmid: number;
    name: string;
    choiceid: number;
    repeats: number;
    slots: { index: number; id: number; text: string }[];
    options: { id: number; text: string; answers: number; limit: number }[];
}

async function current(ctx: IntentContext, courseId: number, cmid: number): Promise<Current> {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "choice") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es una consulta (es ${m.modname}).`);
    const f = await readModForm(ctx, cmid, "choice");
    const repeats = Number(fieldOf(f, "option_repeats") ?? "0");
    if (!Number.isInteger(repeats) || repeats < 1) throw new CampusError("UNEXPECTED_RESPONSE", "El formulario de la consulta no trae sus opciones.");
    const slots = Array.from({ length: repeats }, (_, i) => ({ index: i, id: Number(fieldOf(f, `optionid[${i}]`) ?? "0"), text: (fieldOf(f, `option[${i}]`) ?? "").trim() }));
    const o = OptionsSchema.parse(await ctx.transport.call("mod_choice_get_choice_options", { choiceid: m.instance ?? 0 }));
    return { cmid, name: m.name ?? "", choiceid: m.instance ?? 0, repeats, slots, options: o.options.map((x) => ({ id: x.id, text: (x.text ?? "").trim(), answers: x.countanswers ?? 0, limit: x.maxanswers ?? 0 })) };
}

const snapshot = (c: Current) => JSON.stringify(c.options.map((o) => [o.id, o.text, o.answers]));

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid] = k.split(":");
        out[k] = kind === "choiceopts" ? snapshot(await current(ctx, Number(course), Number(cmid))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const c = await current(ctx, plan.course_id, Number(item.target.cmid));
    const now = c.options.map((o) => o.text);
    const want = item.expected.options as string[];
    const prior = item.expected.prior_options as string[];
    // Límites por opción (ADR-083): se comparan los pedidos, por el texto final.
    const limits = (item.expected.limits ?? {}) as Record<string, number>;
    const badLimits = Object.entries(limits).filter(([t, n]) => (c.options.find((o) => o.text === t)?.limit ?? -1) !== n);
    if (JSON.stringify(now) === JSON.stringify(want) && !badLimits.length) return { outcome: "coincide", checked: ["options", ...(Object.keys(limits).length ? ["limits"] : [])], differences: [] };
    if (JSON.stringify(now) === JSON.stringify(want)) return { outcome: Object.keys(item.expected.prior_limits ?? {}).every((t) => (c.options.find((o) => o.text === t)?.limit ?? -1) === (item.expected.prior_limits as Record<string, number>)[t]) && JSON.stringify(now) === JSON.stringify(prior) ? "sin_efecto" : "difiere", checked: ["options", "limits"], differences: badLimits.map(([t, n]) => ({ field: `límite de «${t}»`, expected: n, observed: c.options.find((o) => o.text === t)?.limit ?? null })) };
    return { outcome: JSON.stringify(now) === JSON.stringify(prior) ? "sin_efecto" : "difiere", checked: ["options"], differences: [{ field: "options", expected: want, observed: now }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

interface Change {
    add: string[];
    rename: { from: string; to: string }[];
    remove: string[];
    /** Máximo de respuestas por opción (texto FINAL → n; 0 = sin límite). Sólo cuenta con limit_answers activo. */
    limits?: Record<string, number>;
}

function build(courseId: number, c: Current, ch: Change, undoOf: string | null): PlanDraft {
    const texts = c.options.map((o) => o.text);
    if (new Set(texts).size !== texts.length) throw new CampusError("AMBIGUOUS_RESOURCE", "La consulta tiene opciones repetidas: no se pueden identificar por su texto.");
    const slotOf = (text: string) => {
        const s = c.slots.find((x) => x.id > 0 && x.text === text);
        if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La consulta no tiene la opción «${text}».`);
        return s;
    };
    const fields: Record<string, string> = { coursecontentnotification: "0" };
    const touched = new Set<string>();
    const final = new Map(c.options.map((o) => [o.id, o.text] as [number, string | null]));
    /** Texto final → índice del formulario. */
    const indexOf = new Map(c.slots.filter((x) => x.id > 0).map((x) => [x.text, x.index]));
    const warnings: string[] = [];
    for (const r of ch.rename) {
        const to = r.to.trim();
        if (!to) throw new CampusError("WRITE_NOT_ALLOWED", "Un nombre nuevo no puede quedar vacío (para quitar, usá remove).");
        if (touched.has(r.from)) throw new CampusError("WRITE_NOT_ALLOWED", `La opción «${r.from}» aparece dos veces en el pedido.`);
        touched.add(r.from);
        const s = slotOf(r.from);
        if (to === r.from) throw new CampusError("WRITE_NOT_ALLOWED", `«${r.from}» ya se llama así.`);
        fields[`option[${s.index}]`] = to;
        final.set(s.id, to);
        indexOf.delete(r.from);
        indexOf.set(to, s.index);
        const answers = c.options.find((o) => o.id === s.id)?.answers ?? 0;
        if (answers) warnings.push(`«${r.from}» tiene ${answers} respuesta(s): quienes la eligieron quedan con «${to}».`);
    }
    for (const text of ch.remove) {
        if (touched.has(text)) throw new CampusError("WRITE_NOT_ALLOWED", `La opción «${text}» aparece dos veces en el pedido.`);
        touched.add(text);
        const s = slotOf(text);
        const answers = c.options.find((o) => o.id === s.id)?.answers ?? 0;
        if (answers) throw new CampusError("WRITE_NOT_ALLOWED", `«${text}» tiene ${answers} respuesta(s): quitarla las borraría. No se admite.`);
        fields[`option[${s.index}]`] = "";
        final.set(s.id, null);
        indexOf.delete(text);
    }
    const free = c.slots.filter((s) => s.id === 0).map((s) => s.index);
    let next = c.repeats;
    for (const raw of ch.add) {
        const text = raw.trim();
        if (!text) throw new CampusError("WRITE_NOT_ALLOWED", "Una opción nueva no puede quedar vacía.");
        const i = free.shift() ?? next++;
        fields[`option[${i}]`] = text;
        indexOf.set(text, i);
        if (i >= c.repeats) Object.assign(fields, { [`limit[${i}]`]: "0", [`optionid[${i}]`]: "0" });
    }
    const result = [...[...final.entries()].filter(([, t]) => t !== null).map(([, t]) => t as string), ...ch.add.map((t) => t.trim())];
    if (!result.length) throw new CampusError("WRITE_NOT_ALLOWED", "La consulta no puede quedar sin opciones.");
    if (result.length > MAX_OPTIONS) throw new CampusError("WRITE_NOT_ALLOWED", `Hasta ${MAX_OPTIONS} opciones.`);
    if (new Set(result).size !== result.length) throw new CampusError("WRITE_NOT_ALLOWED", "Las opciones quedarían repetidas.");
    fields.option_repeats = String(next);
    const limits: Record<string, number> = {};
    const priorLimits: Record<string, number> = {};
    for (const [text, n] of Object.entries(ch.limits ?? {})) {
        const i = indexOf.get(text.trim());
        if (i === undefined) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `No hay una opción «${text}» después del cambio.`);
        const old = c.options.find((o) => o.text === text.trim());
        if (old && old.limit === n) continue;
        if (old && n > 0 && old.answers > n) throw new CampusError("WRITE_NOT_ALLOWED", `«${text}» ya tiene ${old.answers} respuesta(s): el límite no puede ser menor.`);
        fields[`limit[${i}]`] = String(n);
        limits[text.trim()] = n;
        if (old) priorLimits[old.text] = old.limit;
    }
    if (!ch.add.length && !ch.rename.length && !ch.remove.length && !Object.keys(limits).length) throw new CampusError("WRITE_NOT_ALLOWED", "Los límites pedidos ya son los actuales.");
    const what = [ch.add.length ? `agregar ${ch.add.length}` : null, ch.rename.length ? `renombrar ${ch.rename.length}` : null, ch.remove.length ? `quitar ${ch.remove.length}` : null, Object.keys(limits).length ? `límites de ${Object.keys(limits).length}` : null].filter(Boolean).join(", ");
    return {
        intent: "choice_options",
        capability: "edit_activity",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Opciones de la consulta «${c.name}»: ${what}.`,
        payload_preview: { activity: { course_module_id: c.cmid, name: c.name }, before: c.options.map((o) => ({ text: o.text, answers: o.answers })), after: result, add: ch.add, rename: ch.rename, remove: ch.remove, limits, prior_limits: priorLimits },
        side_effects: ["Cambia las opciones que ven los participantes. El resto de la configuración se reenvía tal cual. Sin notificación.", ...(ch.remove.length ? ["Las opciones quitadas se borran (no tenían respuestas)."] : [])],
        preconditions: { description: "Las opciones y sus respuestas no cambiaron desde el plan.", versions: { [`choiceopts:${courseId}:${c.cmid}`]: snapshot(c) } },
        undo: { kind: "compensación", how: "Volver a los nombres anteriores, quitar las opciones agregadas (si siguen sin respuestas) y volver a agregar las quitadas.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus.", ...warnings],
        items: [
            {
                item_id: "i1",
                description: `Opciones de la consulta ${c.cmid}: ${what}`,
                call: { kind: "form", fn: "course_modedit_choice_update_options", params: { query: { update: String(c.cmid) }, fields } },
                target: { course_id: courseId, cmid: c.cmid },
                expected: { options: result, prior_options: c.options.map((o) => o.text), limits, prior_limits: priorLimits },
            },
        ],
        prior_state: { options: c.options.map((o) => o.text) },
        untrusted_fields: ["payload_preview.activity.name", "payload_preview.before"],
        teacher_text: { options: [...ch.add, ...ch.rename.map((r) => r.to)].join("\n") },
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la consulta (mod_choice)."),
    add: z.array(z.string().min(1).max(255)).max(MAX_OPTIONS).optional().describe("Opciones nuevas (al final)."),
    rename: z.array(z.object({ from: z.string().min(1).max(255), to: z.string().min(1).max(255) })).max(MAX_OPTIONS).optional().describe("Renombrar: texto actual EXACTO → texto nuevo."),
    remove: z.array(z.string().min(1).max(255)).max(MAX_OPTIONS).optional().describe("Quitar por texto exacto (sólo opciones sin respuestas)."),
    limits: z.record(z.string().min(1).max(255), z.number().int().min(0).max(100_000)).optional().describe("Máximo de respuestas por opción (texto final → n; 0 = sin límite). Sólo rige con limit_answers activo (campus_plan_activity_settings)."),
};

export const choiceOptionsIntent: WriteIntent<typeof shape> = {
    name: "choice_options",
    title: "Plan: agregar, renombrar o quitar opciones de una consulta",
    description: "Arma el plan para cambiar las opciones de una consulta (mod_choice): agregar al final, renombrar (texto exacto → nuevo) o quitar opciones SIN respuestas. Muestra antes y después. No escribe.",
    inputShape: shape,
    capability: "edit_activity",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const ch: Change = { add: input.add ?? [], rename: input.rename ?? [], remove: input.remove ?? [], limits: input.limits };
        if (!ch.add.length && !ch.rename.length && !ch.remove.length && !Object.keys(input.limits ?? {}).length) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá add, rename, remove o limits.");
        return build(input.course_id, await current(ctx, input.course_id, input.course_module_id), ch, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const p = plan.payload_preview as { add: string[]; rename: { from: string; to: string }[]; remove: string[]; prior_limits?: Record<string, number> };
        const c = await current(ctx, plan.course_id, Number(plan.items[0]!.target.cmid));
        return { kind: "plan", draft: build(plan.course_id, c, { add: p.remove, rename: p.rename.map((r) => ({ from: r.to, to: r.from })), remove: p.add.map((t) => t.trim()), limits: Object.fromEntries(Object.entries(p.prior_limits ?? {}).map(([t, n]) => [p.rename.find((r) => r.from === t)?.from ?? t, n])) }, result.action_id) };
    },
};
