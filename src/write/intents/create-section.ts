import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanItem } from "../plan.js";

/**
 * W6 · Agregar una sección vacía al final del curso (`core_courseformat_update_course` con
 * `section_add`; investigación [C] §1; ADR-067). El nombre se pone después con campus_plan_rename.
 * Deshacer: `section_delete` de esa sección, sólo si sigue vacía.
 */

const ContentsSchema = z.array(z.object({ id: z.number().int().positive(), section: z.number().nullable().optional(), name: z.string().nullable().optional(), modules: z.array(z.object({ id: z.number().int() })).default([]) }));

async function contents(ctx: IntentContext, courseId: number) {
    return ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema);
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    const c = await contents(ctx, plan.course_id);
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, id] = k.split(":");
        if (kind === "sections") out[k] = c.map((s) => s.id).sort((a, b) => a - b).join(",");
        else if (kind === "sectionmods") {
            const s = c.find((x) => x.id === Number(id));
            out[k] = s ? s.modules.length : null;
        } else out[k] = null;
    }
    return out;
}

/**
 * La respuesta de section_add trae el estado de TODAS las secciones: no sirve para saber cuál se creó
 * (tomar la primera dio la sección 0 en la prueba real). La sección nueva sale sólo de la relectura.
 */
function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const c = await contents(ctx, plan.course_id);
    if ((item.call.params as { action?: string }).action === "section_delete") {
        const still = c.some((s) => s.id === Number(item.target.section_id));
        return still ? { outcome: "sin_efecto", checked: ["sección"], differences: [{ field: "sección", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["sección"], differences: [] };
    }
    const prior = new Set(item.expected.prior_section_ids as number[]);
    const fresh = c.filter((s) => !prior.has(s.id));
    if (!fresh.length) return { outcome: "sin_efecto", checked: ["sección"], differences: [{ field: "sección", expected: "creada", observed: "no aparece" }] };
    if (fresh.length > 1) return { outcome: "difiere", checked: ["sección"], differences: [{ field: "secciones nuevas", expected: 1, observed: fresh.length }] };
    return { outcome: "coincide", checked: ["sección"], differences: [], moodle_ids: { section_id: fresh[0]!.id, section_number: fresh[0]!.section ?? 0 } };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const shape = { course_id: z.number().int().positive() };

export const createSectionIntent: WriteIntent<typeof shape> = {
    name: "create_section",
    title: "Plan: agregar una sección al final del curso",
    description: "Arma el plan para agregar UNA sección vacía al final del curso (visible, con el nombre por defecto; para nombrarla, campus_plan_rename). No escribe.",
    inputShape: shape,
    capability: "create_section",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const c = await contents(ctx, input.course_id);
        const ids = c.map((s) => s.id).sort((a, b) => a - b);
        return {
            intent: "create_section",
            capability: "create_section",
            course_id: input.course_id,
            base_risk: "R1",
            summary: `Agregar una sección vacía al final del curso (hoy tiene ${c.length} sección(es), contando subsecciones).`,
            payload_preview: { position: "al final", name: "por defecto (cambiala con campus_plan_rename)" },
            side_effects: ["Una sección vacía visible: no cambia nada para los estudiantes hasta que tenga contenido.", "Sin notificaciones."],
            preconditions: { description: "Las secciones no cambiaron desde el plan.", versions: { [`sections:${input.course_id}`]: ids.join(",") } },
            undo: { kind: "exacto", how: "Borrar la sección mientras siga vacía.", until: null },
            warnings: [],
            items: [{ item_id: "i1", description: "Agregar una sección al final", call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "section_add", courseid: input.course_id } }, target: { course_id: input.course_id }, expected: { prior_section_ids: ids } }],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo(plan, result, ctx) {
        const id = result.items.find((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")?.moodle_ids.section_id;
        if (!id) return { kind: "ninguno", reason: "No se conoce la sección creada." };
        const s = (await contents(ctx, plan.course_id)).find((x) => x.id === id);
        if (!s) return { kind: "ninguno", reason: "La sección ya no existe." };
        if (s.modules.length) return { kind: "ninguno", reason: `La sección ya tiene ${s.modules.length} actividad(es): borrarla es R4 (campus_plan_delete_content).` };
        return {
            kind: "plan",
            draft: {
                intent: "create_section",
                capability: "create_section",
                course_id: plan.course_id,
                base_risk: "R2",
                summary: `Deshacer: borrar la sección vacía ${s.section} (id ${id}).`,
                payload_preview: { delete_section: { id, number: s.section, name: s.name ?? null } },
                side_effects: ["Borra la sección (vacía). Las secciones siguientes se renumeran."],
                preconditions: { description: "La sección sigue vacía.", versions: { [`sectionmods:${id}`]: 0 } },
                undo: { kind: "ninguno", how: "Se puede volver a agregar.", until: null },
                warnings: [],
                items: [{ item_id: "i1", description: `Borrar la sección ${id}`, call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "section_delete", courseid: plan.course_id, ids: [id] } }, target: { course_id: plan.course_id, section_id: id }, expected: { deleted: true } }],
                prior_state: {},
                untrusted_fields: [],
                teacher_text: {},
                undo_of: result.action_id,
            },
        };
    },
};
