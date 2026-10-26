import { z } from "zod";
import { CampusError } from "../../errors.js";
import { GroupsSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { fieldOf, readModForm } from "./modform.js";

/**
 * W6 · Grupos y cupos de una elección de grupo (mod_choicegroup; ADR-103), por su formulario de edición
 * (`/course/modedit.php?update`): qué grupos se ofrecen (`serializedselectedgroups`), si hay cupo
 * (`limitanswers`) y el cupo de cada grupo (`group_<id>_limit`). El resto del formulario se reenvía tal
 * cual. Verificación releyendo el formulario. Deshacer: los grupos y cupos anteriores.
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));

interface State {
    groups: number[];
    limit_answers: boolean;
    limits: Record<string, number>;
}

async function stateOf(ctx: IntentContext, cmid: number): Promise<State> {
    const f = await readModForm(ctx, cmid, "choicegroup");
    const groups = (fieldOf(f, "serializedselectedgroups") ?? "").split(";").filter(Boolean).map(Number).sort((a, b) => a - b);
    const limits: Record<string, number> = {};
    for (const g of groups) limits[g] = Number(fieldOf(f, `group_${g}_limit`) || 0);
    return { groups, limit_answers: fieldOf(f, "limitanswers") === "1", limits };
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, cmid] = k.split(":");
        out[k] = kind === "cgroup" ? JSON.stringify(await stateOf(ctx, Number(cmid))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { want: State; prior: State };
    const now = await stateOf(ctx, Number(item.target.cmid));
    const keys = ["groups", "limit_answers", "limits"] as const;
    const differences = keys.filter((k) => JSON.stringify(now[k]) !== JSON.stringify(x.want[k])).map((k) => ({ field: k, expected: x.want[k], observed: now[k] }));
    if (!differences.length) return { outcome: "coincide", checked: [...keys], differences };
    return { outcome: JSON.stringify(now) === JSON.stringify(x.prior) ? "sin_efecto" : "difiere", checked: [...keys], differences };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

interface Req {
    course_id: number;
    course_module_id: number;
    groups?: { group_id: number; limit?: number }[];
    limit_answers?: boolean;
    restore?: State;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: input.course_id }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === input.course_module_id);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${input.course_module_id} no es del curso ${input.course_id}.`);
    if (m.modname !== "choicegroup") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${m.id} no es una elección de grupo (es ${m.modname}).`);
    const cur = await stateOf(ctx, m.id);
    let want: State;
    if (input.restore) want = input.restore;
    else {
        if (!input.groups && input.limit_answers === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá groups o limit_answers.");
        const courseGroups = await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: input.course_id }, GroupsSchema);
        const groups = input.groups ? [...new Set(input.groups.map((g) => g.group_id))].sort((a, b) => a - b) : cur.groups;
        const bad = groups.filter((id) => !courseGroups.some((g) => g.id === id && g.courseid === input.course_id));
        if (bad.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Grupos que no son del curso: ${bad.join(", ")}.`);
        if (!groups.length) throw new CampusError("WRITE_NOT_ALLOWED", "La elección necesita al menos un grupo.");
        const limits: Record<string, number> = {};
        for (const g of groups) limits[g] = input.groups?.find((x) => x.group_id === g)?.limit ?? cur.limits[g] ?? 0;
        want = { groups, limit_answers: input.limit_answers ?? (input.groups?.some((g) => g.limit !== undefined) ? true : cur.limit_answers), limits };
    }
    if (JSON.stringify(want) === JSON.stringify(cur)) throw new CampusError("WRITE_NOT_ALLOWED", "La elección de grupo ya está así.");
    const fields: Record<string, string> = { serializedselectedgroups: want.groups.map((g) => `;${g}`).join(""), limitanswers: want.limit_answers ? "1" : "0" };
    for (const g of want.groups) fields[`group_${g}_limit`] = String(want.limits[g] ?? 0);
    return {
        intent: "choicegroup_groups",
        capability: "edit_activity",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Grupos de la elección «${m.name ?? m.id}»: ${want.groups.map((g) => `${g}${want.limit_answers ? ` (cupo ${want.limits[g]})` : ""}`).join(", ")}${want.limit_answers ? "" : ", sin cupos"}.`,
        payload_preview: { activity: { course_module_id: m.id, name: m.name ?? null }, before: cur, after: want },
        side_effects: ["Cambia entre qué grupos eligen los estudiantes y cuántos entran en cada uno; quien ya eligió queda en su grupo.", "Sin notificaciones."],
        preconditions: { description: "La elección no cambió desde el plan.", versions: { [`cgroup:${m.id}`]: JSON.stringify(cur) } },
        undo: { kind: "compensación", how: "Volver a los grupos y cupos anteriores.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus. Abrirlo copia los archivos de la actividad a un borrador privado."],
        items: [{ item_id: "i1", description: `Grupos y cupos de la elección ${m.id}`, call: { kind: "form", fn: "course_modedit_choicegroup_update_groups", params: { query: { update: String(m.id) }, fields } }, target: { course_id: input.course_id, cmid: m.id }, expected: { want, prior: cur } }],
        prior_state: { state: cur },
        untrusted_fields: ["payload_preview.activity.name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la elección de grupo (choicegroup)."),
    groups: z.array(z.strictObject({ group_id: z.number().int().positive(), limit: z.number().int().min(0).max(10_000).optional().describe("Cupo del grupo (con limit_answers).") })).min(1).max(100).optional().describe("Grupos que se ofrecen (reemplaza la lista); los cupos que no se indican se conservan."),
    limit_answers: z.boolean().optional().describe("Activar los cupos por grupo (por defecto se activa si se indica algún limit)."),
};

export const choicegroupGroupsIntent: WriteIntent<typeof shape> = {
    name: "choicegroup_groups",
    title: "Plan: grupos y cupos de una elección de grupo",
    description: "Arma el plan para cambiar qué grupos ofrece una elección de grupo y el cupo de cada uno. Los demás ajustes (inscripción múltiple, resultados) van por campus_plan_activity_settings. No escribe.",
    inputShape: shape,
    capability: "edit_activity",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: (input, ctx) => build(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        return { kind: "plan", draft: await build({ course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid), restore: (plan.prior_state as { state: State }).state }, ctx, result.action_id) };
    },
};
