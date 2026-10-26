import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * W4+ · Reordenar secciones (ADR-085): AJAX `core_courseformat_update_course` con `section_move_after`
 * (una sección por llamada, después de otra). La General (0) no se mueve y las subsecciones se mueven
 * con su actividad (campus_plan_move_activity). Verificación: la sección queda justo después de la
 * indicada. Deshacer: volver a ponerla después de la que tenía antes.
 */

const ContentsSchema = z.array(z.object({ id: z.number().int(), section: z.number().nullable().optional(), name: z.string().nullable().optional(), component: z.string().nullable().optional() }));

async function sections(ctx: IntentContext, courseId: number) {
    // Sólo las principales, en el orden del curso (las delegadas de subsecciones van al final y se excluyen).
    return (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).filter((s) => !s.component);
}
const orderKey = (list: { id: number }[]) => list.map((s) => s.id).join(",");

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course] = k.split(":");
        out[k] = kind === "sectionorder" ? orderKey(await sections(ctx, Number(course))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const list = await sections(ctx, plan.course_id);
    const i = list.findIndex((s) => s.id === Number(item.target.section_id));
    const after = i > 0 ? list[i - 1]!.id : null;
    if (after === Number(item.expected.after_section_id)) return { outcome: "coincide", checked: ["orden"], differences: [] };
    const prior = item.expected.prior_order as string;
    return { outcome: orderKey(list) === prior ? "sin_efecto" : "difiere", checked: ["orden"], differences: [{ field: "sección anterior", expected: item.expected.after_section_id, observed: after }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

async function build(ctx: IntentContext, courseId: number, sectionId: number, afterId: number, undoOf: string | null): Promise<PlanDraft> {
    const list = await sections(ctx, courseId);
    const s = list.find((x) => x.id === sectionId);
    const target = list.find((x) => x.id === afterId);
    if (!s || !target) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "La sección o la de referencia no existe en el curso.");
    if ((s.section ?? 0) === 0) throw new CampusError("WRITE_NOT_ALLOWED", "La sección General (0) no se mueve.");
    if (s.id === target.id) throw new CampusError("WRITE_NOT_ALLOWED", "Una sección no puede ir después de sí misma.");
    const i = list.indexOf(s);
    if (list[i - 1]?.id === target.id) throw new CampusError("WRITE_NOT_ALLOWED", "La sección ya está ahí.");
    const priorAfter = list[i - 1]!.id;
    return {
        intent: "move_section",
        capability: "move_content",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Mover la sección ${s.section} «${s.name ?? ""}» después de la ${target.section} «${target.name ?? ""}».`,
        payload_preview: { section: { id: s.id, number: s.section, name: s.name ?? null }, after: { id: target.id, number: target.section, name: target.name ?? null }, order_before: list.map((x) => ({ number: x.section, name: x.name ?? null })) },
        side_effects: ["Las secciones se renumeran: los números cambian (los nombres y el contenido no). Sin notificaciones."],
        preconditions: { description: "El orden de las secciones no cambió desde el plan.", versions: { [`sectionorder:${courseId}`]: orderKey(list) } },
        undo: { kind: "exacto", how: "Volver a ponerla después de la sección que tenía antes.", until: null },
        warnings: ["AJAX de la sesión web del Campus."],
        items: [{ item_id: "i1", description: `Mover la sección ${s.id} después de la ${target.id}`, call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "section_move_after", courseid: courseId, ids: [s.id], targetsectionid: target.id } }, target: { course_id: courseId, section_id: s.id }, expected: { after_section_id: target.id, prior_after_section_id: priorAfter, prior_order: orderKey(list) } }],
        prior_state: { prior_after_section_id: priorAfter },
        untrusted_fields: ["payload_preview.section.name", "payload_preview.after.name", "payload_preview.order_before"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    section_number: z.number().int().min(1).max(200).describe("Sección a mover (no la 0)."),
    after_section_number: z.number().int().min(0).max(200).describe("Ponerla después de esta sección (0 = primera, después de General)."),
};

export const moveSectionIntent: WriteIntent<typeof shape> = {
    name: "move_section",
    title: "Plan: reordenar una sección",
    description: "Arma el plan para mover una sección del curso (con todo su contenido) después de otra. Las secciones se renumeran. No escribe.",
    inputShape: shape,
    capability: "move_content",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const list = await sections(ctx, input.course_id);
        const s = list.find((x) => x.section === input.section_number);
        const t = list.find((x) => x.section === input.after_section_number);
        if (!s || !t) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `No existe la sección ${!s ? input.section_number : input.after_section_number}.`);
        return build(ctx, input.course_id, s.id, t.id, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const it = plan.items[0]!;
        return { kind: "plan", draft: await build(ctx, plan.course_id, Number(it.target.section_id), Number((plan.prior_state as { prior_after_section_id: number }).prior_after_section_id), result.action_id) };
    },
};
