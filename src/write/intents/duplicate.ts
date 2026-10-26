import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * W6 · Duplicar una actividad (ADR-082): AJAX `core_courseformat_update_course` con `cm_duplicate`
 * (copia de seguridad y restauración del módulo, sin datos de usuarios), en la misma sección.
 * - La copia queda con la visibilidad del original: el plan lo dice y es R2 si el original es visible.
 * - Turnitin y LTI no se duplican (servicios externos); las subsecciones tampoco.
 * - Verificación: aparece un módulo nuevo del mismo tipo en la misma sección. Deshacer: borrar la copia.
 */

const ContentsSchema = z.array(
    z.object({
        section: z.number().nullable().optional(),
        modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional(), visible: z.number().nullable().optional() })).default([]),
    }),
);
const EXCLUDED = new Set(["turnitintooltwo", "lti", "subsection"]);

async function modules(ctx: IntentContext, courseId: number) {
    return (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules.map((m) => ({ ...m, section: s.section ?? null })));
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid] = k.split(":");
        out[k] = kind === "cm" ? ((await modules(ctx, Number(course))).some((m) => m.id === Number(cmid)) ? 1 : null) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    if ((item.call.params as { action?: string }).action === "cm_delete") {
        const still = (await modules(ctx, plan.course_id)).some((m) => m.id === Number(item.target.cmid));
        return still ? { outcome: "sin_efecto", checked: ["copia"], differences: [{ field: "copia", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["copia"], differences: [] };
    }
    const x = item.expected as { modname: string; section: number; prior_ids: number[] };
    const prior = new Set(x.prior_ids);
    const copy = (await modules(ctx, plan.course_id)).find((m) => !prior.has(m.id) && m.modname === x.modname && m.section === x.section);
    return copy ? { outcome: "coincide", checked: ["copia"], differences: [], moodle_ids: { cmid: copy.id } } : { outcome: "sin_efecto", checked: ["copia"], differences: [{ field: "copia", expected: "creada", observed: "no aparece" }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : "ausente";
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la actividad a duplicar."),
};

export const duplicateActivityIntent: WriteIntent<typeof shape> = {
    name: "duplicate_activity",
    title: "Plan: duplicar una actividad",
    description: "Arma el plan para duplicar una actividad en su misma sección (sin entregas, intentos ni respuestas: sólo la configuración y el contenido). La copia queda con la misma visibilidad que el original. No escribe.",
    inputShape: shape,
    capability: "create_content",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx): Promise<PlanDraft> {
        const mods = await modules(ctx, input.course_id);
        const m = mods.find((x) => x.id === input.course_module_id);
        if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${input.course_module_id} no es del curso ${input.course_id}.`);
        if (EXCLUDED.has(m.modname)) throw new CampusError("WRITE_NOT_ALLOWED", m.modname === "subsection" ? "Una subsección no se duplica por esta vía." : `No se duplica ${m.modname}: depende de un servicio externo.`);
        const visible = m.visible === 1;
        return {
            intent: "duplicate_activity",
            capability: "create_content",
            course_id: input.course_id,
            base_risk: visible ? "R2" : "R1",
            summary: `Duplicar «${m.name ?? m.id}» (${m.modname}) en la sección ${m.section}; la copia queda ${visible ? "VISIBLE" : "oculta"} como el original.`,
            payload_preview: { activity: { course_module_id: m.id, type: m.modname, name: m.name ?? null, section: m.section, visible } },
            side_effects: ["Crea una copia sin datos de usuarios (sin entregas, intentos, respuestas ni posts).", visible ? "La copia es visible para los participantes en cuanto se crea (ocultala con campus_plan_visibility si hace falta)." : "La copia queda oculta, como el original.", "Sin notificaciones."],
            preconditions: { description: "La actividad sigue en el curso.", versions: { [`cm:${input.course_id}:${m.id}`]: 1 } },
            undo: { kind: "compensación", how: "Borrar la copia (papelera).", until: null },
            warnings: ["AJAX de la sesión web del Campus."],
            items: [{ item_id: "i1", description: `Duplicar la actividad ${m.id}`, call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "cm_duplicate", courseid: input.course_id, ids: [m.id] } }, target: { course_id: input.course_id, cmid: m.id }, expected: { modname: m.modname, section: m.section, prior_ids: mods.map((x) => x.id) } }],
            prior_state: {},
            untrusted_fields: ["payload_preview.activity.name"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo(plan, result) {
        const cmid = result.items[0]?.moodle_ids.cmid;
        if (!cmid) return { kind: "ninguno", reason: "No se conoce la copia." };
        return {
            kind: "plan",
            draft: {
                intent: "duplicate_activity",
                capability: "create_content",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar la copia (cmid ${cmid}).`,
                payload_preview: { delete_activity: { cmid } },
                side_effects: ["Va a la papelera del curso (7 días)."],
                preconditions: { description: "La copia sigue en el curso.", versions: { [`cm:${plan.course_id}:${cmid}`]: 1 } },
                undo: { kind: "ninguno", how: "Sólo restaurando desde la papelera, a mano.", until: null },
                warnings: [],
                items: [{ item_id: "i1", description: `Borrar la copia ${cmid}`, call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "cm_delete", courseid: plan.course_id, ids: [cmid] } }, target: { course_id: plan.course_id, cmid }, expected: { deleted: true } }],
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};
