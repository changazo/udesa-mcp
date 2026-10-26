import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { categoriesOf, glossaryOf } from "./glossary-entries.js";

/**
 * W6 · Categorías de un glosario (ADR-102), por `/mod/glossary/editcategories.php` (no hay servicio web):
 * agregar, renombrar y borrar (las entradas quedan, sin esa categoría). Verificación por
 * `mod_glossary_get_categories`. Deshacer: lo inverso; una categoría borrada se recrea con otro id y sin
 * sus entradas asignadas.
 */

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, gid] = k.split(":");
        out[k] = kind === "gcats" ? JSON.stringify((await categoriesOf(ctx, Number(gid))).map((c) => [c.id, c.name])) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { op: "add" | "rename" | "delete"; glossary_id: number; category_id?: number; name?: string; prior_name?: string; prior_ids?: number[] };
    const cats = await categoriesOf(ctx, x.glossary_id);
    if (x.op === "delete") {
        const still = cats.some((c) => c.id === x.category_id);
        return still ? { outcome: "sin_efecto", checked: ["categoría"], differences: [{ field: "categoría", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["categoría"], differences: [] };
    }
    if (x.op === "add") {
        const fresh = cats.filter((c) => !(x.prior_ids ?? []).includes(c.id));
        const hit = fresh.find((c) => c.name === x.name);
        if (hit && fresh.length === 1) return { outcome: "coincide", checked: ["categoría"], differences: [], moodle_ids: { category_id: hit.id } };
        return { outcome: fresh.length ? "difiere" : "sin_efecto", checked: ["categoría"], differences: [{ field: "categorías nuevas", expected: x.name, observed: fresh.map((c) => c.name) }] };
    }
    const c = cats.find((y) => y.id === x.category_id);
    if (c?.name === x.name) return { outcome: "coincide", checked: ["nombre"], differences: [] };
    return { outcome: c?.name === x.prior_name ? "sin_efecto" : "difiere", checked: ["nombre"], differences: [{ field: "nombre", expected: x.name, observed: c?.name ?? null }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

interface Req {
    course_id: number;
    course_module_id: number;
    action: "add" | "rename" | "delete";
    category_id?: number;
    name?: string;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const g = await glossaryOf(ctx, input.course_id, input.course_module_id);
    const cats = await categoriesOf(ctx, g.id);
    const cat = input.category_id !== undefined ? cats.find((c) => c.id === input.category_id) : undefined;
    if (input.action !== "add" && !cat) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El glosario no tiene la categoría ${input.category_id ?? "(falta category_id)"} (tiene: ${cats.map((c) => `${c.id} = ${c.name}`).join("; ") || "ninguna"}).`);
    const name = input.name?.trim();
    if (input.action !== "delete") {
        if (!name) throw new CampusError("WRITE_NOT_ALLOWED", "Hace falta name.");
        if (cats.some((c) => c.id !== cat?.id && c.name.toLowerCase() === name.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay una categoría «${name}».`);
        if (cat && cat.name === name) throw new CampusError("WRITE_NOT_ALLOWED", "La categoría ya se llama así.");
    }
    const base = { id: String(g.cmid), confirm: "1" };
    let item: PlanItem;
    let summary: string;
    if (input.action === "add") {
        item = { item_id: "i1", description: `Agregar la categoría «${name}»`, call: { kind: "form", fn: "glossary_category_save", params: { query: {}, fields: { ...base, action: "add", name: name!, usedynalink: "0" } } }, target: { course_id: input.course_id, cmid: g.cmid }, expected: { op: "add", glossary_id: g.id, name, prior_ids: cats.map((c) => c.id) } };
        summary = `Agregar la categoría «${name}» al glosario «${g.name}».`;
    } else if (input.action === "rename") {
        item = { item_id: "i1", description: `Renombrar la categoría ${cat!.id}`, call: { kind: "form", fn: "glossary_category_save", params: { query: {}, fields: { ...base, action: "edit", hook: String(cat!.id), name: name!, usedynalink: cat!.usedynalink ? "1" : "0" } } }, target: { course_id: input.course_id, cmid: g.cmid }, expected: { op: "rename", glossary_id: g.id, category_id: cat!.id, name, prior_name: cat!.name } };
        summary = `Renombrar la categoría «${cat!.name}» a «${name}» en el glosario «${g.name}».`;
    } else {
        item = { item_id: "i1", description: `Borrar la categoría ${cat!.id}`, call: { kind: "form", fn: "glossary_category_delete", params: { query: {}, fields: { ...base, action: "delete", hook: String(cat!.id) } } }, target: { course_id: input.course_id, cmid: g.cmid }, expected: { op: "delete", glossary_id: g.id, category_id: cat!.id } };
        summary = `BORRAR la categoría «${cat!.name}» del glosario «${g.name}» (sus entradas quedan, sin esa categoría).`;
    }
    return {
        intent: "glossary_category",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: input.action === "delete" ? "R3" : "R2",
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: { glossary: { course_module_id: g.cmid, name: g.name }, categories: cats.map((c) => ({ category_id: c.id, name: c.name })) },
        side_effects: [input.action === "delete" ? "Las entradas de esa categoría quedan sin ella." : "Cambia cómo se navega el glosario por categorías.", "Sin notificaciones."],
        preconditions: { description: "Las categorías no cambiaron desde el plan.", versions: { [`gcats:${g.id}`]: JSON.stringify(cats.map((c) => [c.id, c.name])) } },
        undo: { kind: "compensación", how: input.action === "add" ? "Borrar la categoría agregada." : input.action === "rename" ? "Volver al nombre anterior." : "Volver a crearla (otro id; sin sus entradas asignadas).", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [item],
        prior_state: cat ? { name: cat.name } : {},
        untrusted_fields: ["payload_preview.glossary.name", "payload_preview.categories"],
        teacher_text: name ? { name } : {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid del glosario."),
    operation: z.enum(["add", "rename", "delete"]),
    category_id: z.number().int().positive().optional().describe("rename, delete (los ids salen de campus_get_activity_content o del error)."),
    name: z.string().min(1).max(255).optional(),
};

export const glossaryCategoryIntent: WriteIntent<typeof shape> = {
    name: "glossary_category",
    title: "Plan: categorías de un glosario",
    description: "Arma el plan para agregar, renombrar o borrar (R3; las entradas quedan) una categoría de un glosario. Para asignar categorías a una entrada: campus_plan_glossary_entry con categories. No escribe.",
    inputShape: shape,
    capability: "manage_activity_entries",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: ({ operation, ...rest }, ctx) => build({ ...rest, action: operation }, ctx, null),
    async undo(plan, result, ctx) {
        const r = result.items[0];
        if (!r || !(r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const x = plan.items[0]!.expected as { op: "add" | "rename" | "delete"; category_id?: number };
        const base = { course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid) };
        const prior = (plan.prior_state as { name?: string }).name;
        if (x.op === "add") {
            const id = r.moodle_ids.category_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce la categoría agregada." };
            return { kind: "plan", draft: await build({ ...base, action: "delete", category_id: id }, ctx, result.action_id) };
        }
        if (x.op === "rename") return { kind: "plan", draft: await build({ ...base, action: "rename", category_id: x.category_id, name: prior }, ctx, result.action_id) };
        return { kind: "plan", draft: await build({ ...base, action: "add", name: prior }, ctx, result.action_id) };
    },
};
