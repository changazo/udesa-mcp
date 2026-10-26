import { z } from "zod";
import { CampusError } from "../../errors.js";
import { GroupingsSchema, GroupsSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { assertIdnumberEditable } from "./idnumber.js";

/**
 * W6 · Ediciones chicas (ADR-076):
 * - Resumen de una sección: formulario `/course/editsection.php?id=<sección>` (sólo el resumen; el
 *   nombre se cambia con campus_plan_rename). Verificación por core_course_get_contents.
 * - Editar un grupo existente (nombre, número de ID, descripción): formulario `/group/group.php?id&courseid`.
 *   Verificación por core_group_get_course_groups.
 * Deshacer: los valores anteriores (compensación). Sin notificaciones.
 */

const SectionsSchema = z.array(z.object({ id: z.number().int(), section: z.number().nullable().optional(), name: z.string().nullable().optional(), summary: z.string().nullable().optional() }));

async function sectionOf(ctx: IntentContext, courseId: number, number: number) {
    const s = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, SectionsSchema)).find((x) => x.section === number);
    if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${number} no existe en el curso ${courseId}.`);
    return s;
}
async function groupOf(ctx: IntentContext, courseId: number, groupId: number) {
    const g = (await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: courseId }, GroupsSchema)).find((x) => x.id === groupId && x.courseid === courseId);
    if (!g) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El grupo ${groupId} no es del curso ${courseId}.`);
    return g;
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, id] = k.split(":");
        if (kind === "secsummary") out[k] = comparable((await sectionOf(ctx, Number(course), Number(id))).summary);
        else if (kind === "groupdata") {
            const g = await groupOf(ctx, Number(course), Number(id));
            out[k] = JSON.stringify([g.name ?? "", g.idnumber ?? "", comparable(g.description)]);
        } else out[k] = null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected as Record<string, string>;
    const prior = item.expected.prior as unknown as Record<string, string>;
    let now: Record<string, string>;
    if (item.call.fn === "course_section_edit") now = { summary_text: comparable((await sectionOf(ctx, plan.course_id, Number(t.section_number))).summary) };
    else {
        const g = await groupOf(ctx, plan.course_id, Number(t.group_id));
        now = { name: g.name ?? "", idnumber: g.idnumber ?? "", description_text: comparable(g.description) };
    }
    const fields = Object.keys(now).filter((k) => x[k] !== undefined);
    const differences: Difference[] = fields.filter((k) => now[k] !== x[k]).map((k) => ({ field: k, expected: x[k], observed: now[k] }));
    if (!differences.length) return { outcome: "coincide", checked: fields, differences };
    return { outcome: fields.every((k) => now[k] === prior[k]) ? "sin_efecto" : "difiere", checked: fields, differences };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };

// ---------- resumen de sección ----------

function sectionDraft(courseId: number, s: { id: number; section: number; name: string; summary: string }, html: string, undoOf: string | null): PlanDraft {
    return {
        intent: "section_summary",
        capability: "rename_content",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Cambiar el resumen de la sección ${s.section} «${s.name}».`,
        payload_preview: { section: { id: s.id, number: s.section, name: s.name }, before_html: s.summary, after_html: html },
        side_effects: ["Cambia el texto que los estudiantes ven al principio de la sección. Sin notificaciones."],
        preconditions: { description: "El resumen no cambió desde el plan.", versions: { [`secsummary:${courseId}:${s.section}`]: comparable(s.summary) } },
        undo: { kind: "compensación", how: "Volver al resumen anterior (tal como lo devolvía Moodle).", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [
            {
                item_id: "i1",
                description: `Resumen de la sección ${s.section}`,
                call: { kind: "form", fn: "course_section_edit", params: { query: { id: String(s.id) }, fields: { "summary_editor[text]": html, "summary_editor[format]": "1" } } },
                target: { course_id: courseId, section_id: s.id, section_number: s.section },
                expected: { summary_text: comparable(html), prior: { summary_text: comparable(s.summary) } as unknown as string },
            },
        ],
        prior_state: { summary_html: s.summary },
        untrusted_fields: ["payload_preview.section.name", "payload_preview.before_html"],
        teacher_text: { summary: html },
        undo_of: undoOf,
    };
}

const sectionShape = {
    course_id: z.number().int().positive(),
    section_number: z.number().int().min(0).max(200),
    summary: z.string().max(20_000).describe("Nuevo resumen (Markdown). \"\" lo vacía."),
};

export const sectionSummaryIntent: WriteIntent<typeof sectionShape> = {
    name: "section_summary",
    title: "Plan: cambiar el resumen de una sección",
    description: "Arma el plan para cambiar el resumen (texto al principio) de una sección del curso. Para el nombre, campus_plan_rename. No escribe.",
    inputShape: sectionShape,
    capability: "rename_content",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const s = await sectionOf(ctx, input.course_id, input.section_number);
        const html = input.summary === "" ? "" : toHtml(input.summary, "markdown");
        if (comparable(html) === comparable(s.summary)) throw new CampusError("WRITE_NOT_ALLOWED", "Ese ya es el resumen de la sección.");
        return sectionDraft(input.course_id, { id: s.id, section: s.section ?? input.section_number, name: s.name ?? "", summary: s.summary ?? "" }, html, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const t = plan.items[0]!.target;
        const s = await sectionOf(ctx, plan.course_id, Number(t.section_number));
        if (s.id !== Number(t.section_id)) return { kind: "ninguno", reason: "La sección cambió de número (se agregaron o borraron secciones)." };
        return { kind: "plan", draft: sectionDraft(plan.course_id, { id: s.id, section: s.section ?? 0, name: s.name ?? "", summary: s.summary ?? "" }, (plan.prior_state as { summary_html: string }).summary_html, result.action_id) };
    },
};

// ---------- editar un grupo ----------

function groupDraft(courseId: number, g: { id: number; name: string; idnumber: string; description: string }, to: { name: string; idnumber: string; descriptionHtml: string }, undoOf: string | null): PlanDraft {
    const expected: Record<string, unknown> = { name: to.name, idnumber: to.idnumber, description_text: comparable(to.descriptionHtml), prior: { name: g.name, idnumber: g.idnumber, description_text: comparable(g.description) } };
    return {
        intent: "edit_group",
        capability: "manage_groups",
        course_id: courseId,
        base_risk: "R1",
        summary: `${undoOf ? "Deshacer: " : ""}Editar el grupo ${g.id} «${g.name}»${to.name !== g.name ? ` → «${to.name}»` : ""}.`,
        payload_preview: { group_id: g.id, before: { name: g.name, idnumber: g.idnumber, description_html: g.description }, after: { name: to.name, idnumber: to.idnumber, description_html: to.descriptionHtml } },
        side_effects: ["Cambia cómo se ve el grupo; los miembros y el acceso no cambian. Sin notificaciones."],
        preconditions: { description: "El grupo no cambió desde el plan.", versions: { [`groupdata:${courseId}:${g.id}`]: JSON.stringify([g.name, g.idnumber, comparable(g.description)]) } },
        undo: { kind: "compensación", how: "Volver a los valores anteriores.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [
            {
                item_id: "i1",
                description: `Editar el grupo ${g.id}`,
                call: { kind: "form", fn: "course_group_update", params: { query: { id: String(g.id), courseid: String(courseId) }, fields: { name: to.name, idnumber: to.idnumber, "description_editor[text]": to.descriptionHtml, "description_editor[format]": "1" } } },
                target: { course_id: courseId, group_id: g.id },
                expected,
            },
        ],
        prior_state: { name: g.name, idnumber: g.idnumber, description_html: g.description },
        untrusted_fields: ["payload_preview.before"],
        teacher_text: { name: to.name },
        undo_of: undoOf,
    };
}

const groupShape = {
    course_id: z.number().int().positive(),
    group_id: z.number().int().positive(),
    name: z.string().min(1).max(254).optional(),
    idnumber: z.string().max(100).optional(),
    description: z.string().max(5_000).optional().describe("Markdown; \"\" la vacía."),
};

export const editGroupIntent: WriteIntent<typeof groupShape> = {
    name: "edit_group",
    title: "Plan: editar un grupo (nombre, ID, descripción)",
    description: "Arma el plan para cambiar el nombre, el número de ID o la descripción de un grupo del curso. Los miembros no cambian (para eso, campus_plan_group_members). No escribe.",
    inputShape: groupShape,
    capability: "manage_groups",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const g = await groupOf(ctx, input.course_id, input.group_id);
        const cur = { id: g.id, name: g.name ?? "", idnumber: g.idnumber ?? "", description: g.description ?? "" };
        const to = { name: input.name?.trim() ?? cur.name, idnumber: input.idnumber?.trim() ?? cur.idnumber, descriptionHtml: input.description === undefined ? cur.description : input.description === "" ? "" : toHtml(input.description, "markdown") };
        if (to.name === cur.name && to.idnumber === cur.idnumber && comparable(to.descriptionHtml) === comparable(cur.description)) throw new CampusError("WRITE_NOT_ALLOWED", "No hay cambios.");
        const others = (await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: input.course_id }, GroupsSchema)).filter((x) => x.id !== g.id);
        if (others.some((x) => (x.name ?? "").trim().toLowerCase() === to.name.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay otro grupo «${to.name}».`);
        if (to.idnumber && others.some((x) => x.idnumber === to.idnumber)) throw new CampusError("WRITE_NOT_ALLOWED", `El número de ID «${to.idnumber}» ya lo usa otro grupo.`);
        if (to.idnumber !== cur.idnumber) await assertIdnumberEditable(ctx, "group_form_edit", { id: String(g.id), courseid: String(input.course_id) }, "_qf__group_form", "los grupos");
        return groupDraft(input.course_id, cur, to, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const prior = plan.prior_state as { name: string; idnumber: string; description_html: string };
        const g = await groupOf(ctx, plan.course_id, Number(plan.items[0]!.target.group_id));
        return { kind: "plan", draft: groupDraft(plan.course_id, { id: g.id, name: g.name ?? "", idnumber: g.idnumber ?? "", description: g.description ?? "" }, { name: prior.name, idnumber: prior.idnumber, descriptionHtml: prior.description_html }, result.action_id) };
    },
};

// ---------- editar un agrupamiento (ADR-085) ----------

async function groupingOf(ctx: IntentContext, courseId: number, id: number) {
    const g = (await ctx.read.session.transport.call("core_group_get_course_groupings", { courseid: courseId }, GroupingsSchema)).find((x) => x.id === id && x.courseid === courseId);
    if (!g) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El agrupamiento ${id} no es del curso ${courseId}.`);
    return { id: g.id, name: g.name ?? "", description: g.description ?? "" };
}

function groupingDraft(courseId: number, g: { id: number; name: string; description: string }, to: { name: string; descriptionHtml: string }, undoOf: string | null): PlanDraft {
    return {
        intent: "edit_grouping",
        capability: "manage_groups",
        course_id: courseId,
        base_risk: "R1",
        summary: `${undoOf ? "Deshacer: " : ""}Editar el agrupamiento ${g.id} «${g.name}»${to.name !== g.name ? ` → «${to.name}»` : ""}.`,
        payload_preview: { grouping_id: g.id, before: { name: g.name, description_html: g.description }, after: { name: to.name, description_html: to.descriptionHtml } },
        side_effects: ["Cambia cómo se ve el agrupamiento; sus grupos no cambian. Sin notificaciones."],
        preconditions: { description: "El agrupamiento no cambió desde el plan.", versions: { [`groupingdata:${courseId}:${g.id}`]: JSON.stringify([g.name, comparable(g.description)]) } },
        undo: { kind: "compensación", how: "Volver a los valores anteriores.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [
            {
                item_id: "i1",
                description: `Editar el agrupamiento ${g.id}`,
                call: { kind: "form", fn: "course_grouping_update", params: { query: { id: String(g.id), courseid: String(courseId) }, fields: { name: to.name, "description_editor[text]": to.descriptionHtml, "description_editor[format]": "1" } } },
                target: { course_id: courseId, grouping_id: g.id },
                expected: { name: to.name, description_text: comparable(to.descriptionHtml), prior: { name: g.name, description_text: comparable(g.description) } },
            },
        ],
        prior_state: { name: g.name, description_html: g.description },
        untrusted_fields: ["payload_preview.before"],
        teacher_text: { name: to.name },
        undo_of: undoOf,
    };
}

async function groupingVerify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const g = await groupingOf(ctx, plan.course_id, Number(item.target.grouping_id));
    const x = item.expected as { name: string; description_text: string; prior: { name: string; description_text: string } };
    const now = { name: g.name, description_text: comparable(g.description) };
    const differences: Difference[] = (["name", "description_text"] as const).filter((k) => now[k] !== x[k]).map((k) => ({ field: k, expected: x[k], observed: now[k] }));
    if (!differences.length) return { outcome: "coincide", checked: ["name", "description_text"], differences };
    return { outcome: now.name === x.prior.name && now.description_text === x.prior.description_text ? "sin_efecto" : "difiere", checked: ["name", "description_text"], differences };
}

const groupingShape = {
    course_id: z.number().int().positive(),
    grouping_id: z.number().int().positive(),
    name: z.string().min(1).max(254).optional(),
    description: z.string().max(5_000).optional().describe("Markdown; \"\" la vacía."),
};

export const editGroupingIntent: WriteIntent<typeof groupingShape> = {
    name: "edit_grouping",
    title: "Plan: editar un agrupamiento (nombre, descripción)",
    description: "Arma el plan para cambiar el nombre o la descripción de un agrupamiento. Sus grupos no cambian (para eso, campus_plan_grouping_groups). No escribe.",
    inputShape: groupingShape,
    capability: "manage_groups",
    synthetic_only: false,
    async readVersions(plan, ctx) {
        const out: Record<string, string | null> = {};
        for (const k of Object.keys(plan.preconditions.versions)) {
            const [kind, course, id] = k.split(":");
            if (kind !== "groupingdata") {
                out[k] = null;
                continue;
            }
            const g = await groupingOf(ctx, Number(course), Number(id));
            out[k] = JSON.stringify([g.name, comparable(g.description)]);
        }
        return out;
    },
    interpret,
    verify: groupingVerify,
    async reconcile(item, plan, ctx) {
        const v = await groupingVerify(item, plan, ctx);
        return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
    },
    async plan(input, ctx) {
        const g = await groupingOf(ctx, input.course_id, input.grouping_id);
        const to = { name: input.name?.trim() ?? g.name, descriptionHtml: input.description === undefined ? g.description : input.description === "" ? "" : toHtml(input.description, "markdown") };
        if (to.name === g.name && comparable(to.descriptionHtml) === comparable(g.description)) throw new CampusError("WRITE_NOT_ALLOWED", "No hay cambios.");
        const others = (await ctx.read.session.transport.call("core_group_get_course_groupings", { courseid: input.course_id }, GroupingsSchema)).filter((x) => x.id !== g.id);
        if (others.some((x) => (x.name ?? "").trim().toLowerCase() === to.name.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay otro agrupamiento «${to.name}».`);
        return groupingDraft(input.course_id, g, to, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const prior = plan.prior_state as { name: string; description_html: string };
        const g = await groupingOf(ctx, plan.course_id, Number(plan.items[0]!.target.grouping_id));
        return { kind: "plan", draft: groupingDraft(plan.course_id, g, { name: prior.name, descriptionHtml: prior.description_html }, result.action_id) };
    },
};

export const SMALL_EDIT_INTENTS = [sectionSummaryIntent, editGroupIntent, editGroupingIntent];
