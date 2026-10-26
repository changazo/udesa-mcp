import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { parseFormFields } from "../web.js";
import { fieldOf } from "./modform.js";

/**
 * W6 · Entradas de un glosario (ADR-077), por servicio web: `mod_glossary_add_entry`,
 * `mod_glossary_update_entry` y `mod_glossary_delete_entry`. Las entradas de la cuenta docente quedan
 * aprobadas; no hay mensajes. ADR-089: aprobar o desaprobar por `/mod/glossary/approve.php` (aprobar
 * puede avisar al autor; el dueño lo aceptó). Verificación por `mod_glossary_get_entry_by_id`.
 * Deshacer: borrar la agregada; volver al concepto y la definición anteriores; volver a agregar una
 * borrada (compensación: otro id, sin sus comentarios ni calificaciones).
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));
const GlossariesSchema = z.object({ glossaries: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), name: z.string().nullable().optional(), allowduplicatedentries: z.number().nullable().optional() })).default([]) });
const EntrySchema = z.object({ id: z.number().int(), glossaryid: z.number().int(), concept: z.string(), definition: z.string().nullable().optional(), approved: z.union([z.boolean(), z.number()]).nullable().optional(), userid: z.number().nullable().optional() });
const EntriesSchema = z.object({ count: z.number().nullable().optional(), entries: z.array(EntrySchema).default([]) });

export async function glossaryOf(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "glossary") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es un glosario (es ${m.modname}).`);
    const g = GlossariesSchema.parse(await ctx.transport.call("mod_glossary_get_glossaries_by_courses", { courseids: [courseId] })).glossaries.find((x) => x.coursemodule === cmid);
    if (!g) throw new CampusError("UNEXPECTED_RESPONSE", "El glosario no aparece en mod_glossary_get_glossaries_by_courses.");
    return { cmid, id: g.id, name: g.name ?? m.name ?? "", duplicates: (g.allowduplicatedentries ?? 0) === 1 };
}

/** La entrada, o null si ya no existe (Moodle responde con una excepción). */
async function entryOf(ctx: IntentContext, id: number) {
    try {
        return z.object({ entry: EntrySchema }).parse(await ctx.transport.call("mod_glossary_get_entry_by_id", { id })).entry;
    } catch (e) {
        if (e instanceof CampusError && (e.code === "MOODLE_REJECTED" || e.code === "MOODLE_PERMISSION_DENIED")) return null;
        throw e;
    }
}

/**
 * Alias, categorías y enlace automático de una entrada (formulario de edición; el servicio web no los
 * devuelve). OJO (ADR-102): mod_glossary_update_entry BORRA y reescribe alias y categorías con lo que
 * recibe; al editar se reenvían siempre los actuales.
 */
interface Extras {
    aliases: string[];
    categories: number[];
    usedynalink: string;
    casesensitive: string;
    fullmatch: string;
}
async function extrasOf(ctx: IntentContext, cmid: number, entryId: number): Promise<Extras> {
    const f = parseFormFields(await ctx.web.readPage("glossary_entry_form", { cmid: String(cmid), id: String(entryId) }), "_qf__mod_glossary_entry_form");
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `No se reconoció el formulario de la entrada ${entryId}.`);
    const last = (n: string) => f.filter(([k]) => k === n).at(-1)?.[1] ?? "0";
    return {
        aliases: (fieldOf(f, "aliases") ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
        categories: f.filter(([k]) => k === "categories[]").map(([, v]) => Number(v)).filter((v) => v > 0).sort((a, b) => a - b),
        usedynalink: last("usedynalink"),
        casesensitive: last("casesensitive"),
        fullmatch: last("fullmatch"),
    };
}
const extrasOptions = (x: Extras) => [
    { name: "aliases", value: x.aliases.join("\n") },
    { name: "categories", value: x.categories.join(",") },
    { name: "usedynalink", value: x.usedynalink === "1" ? "1" : "0" },
    { name: "casesensitive", value: x.casesensitive === "1" ? "1" : "0" },
    { name: "fullmatch", value: x.fullmatch === "1" ? "1" : "0" },
];

const CategoriesSchema = z.object({ categories: z.array(z.object({ id: z.number().int(), name: z.string(), usedynalink: z.union([z.boolean(), z.number()]).nullable().optional() })).default([]) });
/** Categorías del glosario (lectura del núcleo). */
export async function categoriesOf(ctx: IntentContext, glossaryId: number) {
    return (await ctx.read.session.transport.call("mod_glossary_get_categories", { id: glossaryId }, CategoriesSchema)).categories;
}

async function entries(ctx: IntentContext, glossaryId: number) {
    const all: z.infer<typeof EntrySchema>[] = [];
    for (let from = 0; from < 2000; from += 200) {
        const page = EntriesSchema.parse(await ctx.transport.call("mod_glossary_get_entries_by_letter", { id: glossaryId, letter: "ALL", from, limit: 200 }));
        all.push(...page.entries);
        if (page.entries.length < 200) break;
    }
    return all;
}

const approvedOf = (e: { approved?: boolean | number | null }) => (e.approved === undefined || e.approved === null ? true : Boolean(Number(e.approved)));
const snap = (e: { concept: string; definition?: string | null; approved?: boolean | number | null } | null) => (e ? JSON.stringify([e.concept, comparable(e.definition), approvedOf(e)]) : null);

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, id] = k.split(":");
        out[k] = kind === "gentry" ? snap(await entryOf(ctx, Number(id))) : null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    if (item.call.fn !== "mod_glossary_add_entry") return { ok: true };
    const id = Number((data as { entryid?: unknown } | null)?.entryid);
    return Number.isInteger(id) && id > 0 ? { ok: true, moodle_ids: { entry_id: id } } : { ok: false, reason: "Moodle no devolvió la entrada creada." };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const x = item.expected as { action: string; entry_id?: number; concept?: string; definition_text?: string; glossary_id: number; prior_ids?: number[]; prior?: { concept: string; definition_text: string }; aliases?: string[]; categories?: number[] };
    if (x.action === "approve" || x.action === "unapprove") {
        const e = await entryOf(ctx, Number(x.entry_id));
        if (!e) return { outcome: "difiere", checked: ["approved"], differences: [{ field: "entrada", expected: "existe", observed: "no aparece" }] };
        const want = x.action === "approve";
        return approvedOf(e) === want ? { outcome: "coincide", checked: ["approved"], differences: [] } : { outcome: "sin_efecto", checked: ["approved"], differences: [{ field: "approved", expected: want, observed: !want }] };
    }
    if (x.action === "delete") {
        const e = await entryOf(ctx, Number(x.entry_id));
        return e ? { outcome: "sin_efecto", checked: ["entrada"], differences: [{ field: "entrada", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["entrada"], differences: [] };
    }
    let e = x.action === "add" ? (known.entry_id ? await entryOf(ctx, known.entry_id) : null) : await entryOf(ctx, Number(x.entry_id));
    if (x.action === "add" && !e && !known.entry_id) {
        const prior = new Set(x.prior_ids ?? []);
        e = (await entries(ctx, x.glossary_id)).find((y) => !prior.has(y.id) && y.concept === x.concept) ?? null;
    }
    if (!e) return { outcome: "sin_efecto", checked: ["entrada"], differences: [{ field: "entrada", expected: "existe", observed: "no aparece" }] };
    const now = { concept: e.concept, definition_text: comparable(e.definition) };
    const differences: Difference[] = [];
    for (const f of ["concept", "definition_text"] as const) if (x[f] !== undefined && x[f] !== now[f]) differences.push({ field: f, expected: x[f], observed: now[f] });
    if (x.aliases !== undefined || x.categories !== undefined) {
        const ex = await extrasOf(ctx, Number(item.target.cmid), e.id);
        if (x.aliases !== undefined && JSON.stringify([...ex.aliases].sort()) !== JSON.stringify([...x.aliases].sort())) differences.push({ field: "aliases", expected: x.aliases, observed: ex.aliases });
        if (x.categories !== undefined && JSON.stringify(ex.categories) !== JSON.stringify(x.categories)) differences.push({ field: "categories", expected: x.categories, observed: ex.categories });
    }
    if (x.action === "add" && e.approved !== undefined && e.approved !== null && !e.approved) differences.push({ field: "approved", expected: true, observed: false });
    const ids = x.action === "add" ? { moodle_ids: { entry_id: e.id } } : {};
    const checked = ["concept", "definition_text", ...(x.aliases !== undefined ? ["aliases"] : []), ...(x.categories !== undefined ? ["categories"] : [])];
    if (!differences.length) return { outcome: "coincide", checked, differences, ...ids };
    const same = x.action === "edit" && x.prior && now.concept === x.prior.concept && now.definition_text === x.prior.definition_text;
    return { outcome: same ? "sin_efecto" : "difiere", checked, differences, ...ids };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

type Action = "add" | "edit" | "delete" | "approve" | "unapprove";
interface Req {
    course_id: number;
    course_module_id: number;
    action: Action;
    entry_id?: number;
    concept?: string;
    definition?: string;
    definition_html?: string;
    aliases?: string[];
    categories?: number[];
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const g = await glossaryOf(ctx, input.course_id, input.course_module_id);
    const concept = input.concept?.trim();
    if (input.concept !== undefined && !concept) throw new CampusError("WRITE_NOT_ALLOWED", "El concepto no puede quedar vacío.");
    const html = input.definition_html ?? (input.definition !== undefined ? toHtml(input.definition, "markdown") : undefined);
    if (html !== undefined && !comparable(html)) throw new CampusError("WRITE_NOT_ALLOWED", "La definición no puede quedar vacía.");
    const preview: Record<string, unknown> = { glossary: { course_module_id: g.cmid, name: g.name } };
    if (input.categories?.length) {
        const cats = await categoriesOf(ctx, g.id);
        const bad = input.categories.filter((c) => !cats.some((x) => x.id === c));
        if (bad.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Categorías que el glosario no tiene: ${bad.join(", ")} (tiene: ${cats.map((c) => `${c.id} = ${c.name}`).join("; ") || "ninguna"}).`);
    }
    let item: PlanItem;
    let summary: string;
    let prior: Record<string, unknown> = {};
    const versions: Record<string, string | null> = {};
    let risk: "R2" | "R3" = "R2";
    let undo: PlanDraft["undo"];
    if (input.action === "add") {
        if (!concept || html === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Para agregar una entrada hacen falta concept y definition.");
        const all = await entries(ctx, g.id);
        if (!g.duplicates && all.some((e) => e.concept.trim().toLowerCase() === concept.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `El glosario ya tiene «${concept}» y no admite entradas repetidas.`);
        item = {
            item_id: "i1",
            description: `Agregar «${concept}» al glosario`,
            call: { kind: "rest", fn: "mod_glossary_add_entry", params: { glossaryid: g.id, concept, definition: html, definitionformat: 1, ...(input.aliases || input.categories ? { options: extrasOptions({ aliases: input.aliases ?? [], categories: input.categories ?? [], usedynalink: "0", casesensitive: "0", fullmatch: "0" }).filter((o) => (o.name === "aliases" && input.aliases) || (o.name === "categories" && input.categories)) } : {}) } },
            target: { course_id: input.course_id, cmid: g.cmid },
            expected: { action: "add", glossary_id: g.id, concept, definition_text: comparable(html), prior_ids: all.map((e) => e.id), ...(input.aliases ? { aliases: input.aliases } : {}), ...(input.categories ? { categories: input.categories } : {}) },
        };
        summary = `Agregar la entrada «${concept}» al glosario «${g.name}».`;
        Object.assign(preview, { concept, definition_html: html });
        undo = { kind: "compensación", how: "Borrar la entrada agregada.", until: null };
    } else {
        const e = input.entry_id ? await entryOf(ctx, input.entry_id) : null;
        if (!e || e.glossaryid !== g.id) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El glosario «${g.name}» no tiene la entrada ${input.entry_id ?? "(falta entry_id)"}.`);
        versions[`gentry:${e.id}`] = snap(e);
        preview.entry = { id: e.id, concept: e.concept, definition_html: e.definition ?? "" };
        // Alias y categorías actuales: se reenvían al editar y se guardan para el deshacer (ADR-102).
        const ex = input.action === "edit" || input.action === "delete" ? await extrasOf(ctx, g.cmid, e.id) : null;
        prior = { concept: e.concept, definition_html: e.definition ?? "", ...(ex ? { aliases: ex.aliases, categories: ex.categories } : {}) };
        if (input.action === "approve" || input.action === "unapprove") {
            const want = input.action === "approve";
            if (approvedOf(e) === want) throw new CampusError("WRITE_NOT_ALLOWED", `La entrada «${e.concept}» ya está ${want ? "aprobada" : "pendiente de aprobación"}.`);
            item = {
                item_id: "i1",
                description: `${want ? "Aprobar" : "Desaprobar"} la entrada ${e.id}`,
                call: { kind: "form", fn: "glossary_entry_approve", params: { query: { eid: String(e.id), newstate: want ? "1" : "0", mode: "approval" }, fields: {} } },
                target: { course_id: input.course_id, cmid: g.cmid },
                expected: { action: input.action, glossary_id: g.id, entry_id: e.id },
            };
            summary = `${want ? "Aprobar" : "Desaprobar (volver a pendiente)"} la entrada «${e.concept}» del glosario «${g.name}».`;
            undo = { kind: "compensación", how: want ? "Volver a dejarla pendiente." : "Volver a aprobarla.", until: null };
        } else if (input.action === "edit") {
            if (concept === undefined && html === undefined && !input.aliases && !input.categories) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá concept, definition, aliases o categories.");
            const next = { concept: concept ?? e.concept, html: html ?? e.definition ?? "" };
            const nextEx: Extras = { ...ex!, aliases: input.aliases ?? ex!.aliases, categories: input.categories ? [...input.categories].sort((a, b) => a - b) : ex!.categories };
            if (next.concept === e.concept && comparable(next.html) === comparable(e.definition) && JSON.stringify(nextEx) === JSON.stringify(ex)) throw new CampusError("WRITE_NOT_ALLOWED", "La entrada ya está así.");
            item = {
                item_id: "i1",
                description: `Editar la entrada ${e.id}`,
                call: { kind: "rest", fn: "mod_glossary_update_entry", params: { entryid: e.id, concept: next.concept, definition: next.html, definitionformat: 1, options: extrasOptions(nextEx) } },
                target: { course_id: input.course_id, cmid: g.cmid },
                expected: { action: "edit", glossary_id: g.id, entry_id: e.id, concept: next.concept, definition_text: comparable(next.html), aliases: nextEx.aliases, categories: nextEx.categories, prior: { concept: e.concept, definition_text: comparable(e.definition) } },
            };
            summary = `Editar la entrada «${e.concept}» del glosario «${g.name}».`;
            preview.after = { concept: next.concept, definition_html: next.html };
            undo = { kind: "compensación", how: "Volver al concepto y la definición anteriores.", until: null };
        } else {
            item = {
                item_id: "i1",
                description: `Borrar la entrada ${e.id}`,
                call: { kind: "rest", fn: "mod_glossary_delete_entry", params: { entryid: e.id } },
                target: { course_id: input.course_id, cmid: g.cmid },
                expected: { action: "delete", glossary_id: g.id, entry_id: e.id },
            };
            summary = `BORRAR la entrada «${e.concept}» del glosario «${g.name}».`;
            risk = "R3";
            undo = { kind: "compensación", how: "Volver a agregarla con el mismo concepto y definición (otro id; sin sus comentarios ni calificaciones).", until: null };
        }
    }
    return {
        intent: "glossary_entry",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: preview,
        side_effects:
            input.action === "approve"
                ? ["La entrada pasa a verse para todos los participantes.", "Moodle puede avisar al autor de la entrada que fue aprobada (aceptado por el dueño en esta etapa)."]
                : input.action === "unapprove"
                  ? ["La entrada deja de verse para los participantes (queda pendiente de aprobación).", "Sin mensajes."]
                  : [input.action === "delete" ? "La entrada se BORRA con sus comentarios y calificaciones." : "Cambia lo que ven los participantes en el glosario (y los enlaces automáticos si están activos).", "Sin mensajes."],
        preconditions: { description: "La entrada no cambió desde el plan.", versions },
        undo,
        warnings: [],
        items: [item],
        prior_state: prior,
        untrusted_fields: ["payload_preview.glossary.name", "payload_preview.entry"],
        teacher_text: Object.fromEntries(Object.entries({ concept, definition: html }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid del glosario."),
    operation: z.enum(["add", "edit", "delete", "approve", "unapprove"]).describe("add, edit, delete; approve = aprobar una entrada pendiente (Moodle puede avisar al autor); unapprove = volverla a pendiente."),
    entry_id: z.number().int().positive().optional().describe("Entrada (edit, delete, approve, unapprove)."),
    concept: z.string().min(1).max(255).optional().describe("Concepto (término)."),
    definition: z.string().min(1).max(100_000).optional().describe("Definición (Markdown)."),
    aliases: z.array(z.string().min(1).max(255)).max(20).optional().describe("Alias de la entrada (reemplaza todos; [] = sin alias). Al editar sin indicarlos, se conservan."),
    categories: z.array(z.number().int().positive()).max(20).optional().describe("Ids de categorías del glosario (reemplaza todas; [] = ninguna). Salen de campus_get_activity_content."),
};

export const glossaryEntryIntent: WriteIntent<typeof shape> = {
    name: "glossary_entry",
    title: "Plan: agregar, editar, borrar, aprobar o desaprobar una entrada de un glosario",
    description: "Arma el plan para agregar (concept, definition), editar, borrar (R3), aprobar o desaprobar una entrada de un glosario. Las pendientes se ven en campus_get_activity_content. Muestra antes y después. No escribe.",
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
        const x = plan.items[0]!.expected as { action: Action; entry_id?: number };
        const p = plan.prior_state as { concept?: string; definition_html?: string; aliases?: string[]; categories?: number[] };
        const base = { course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid) };
        if (x.action === "add") {
            const id = r.moodle_ids.entry_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce la entrada agregada." };
            return { kind: "plan", draft: await build({ ...base, action: "delete", entry_id: id }, ctx, result.action_id) };
        }
        if (x.action === "approve" || x.action === "unapprove") return { kind: "plan", draft: await build({ ...base, action: x.action === "approve" ? "unapprove" : "approve", entry_id: x.entry_id }, ctx, result.action_id) };
        const extras = { ...(p.aliases ? { aliases: p.aliases } : {}), ...(p.categories ? { categories: p.categories } : {}) };
        if (x.action === "edit") return { kind: "plan", draft: await build({ ...base, action: "edit", entry_id: x.entry_id, concept: p.concept, definition_html: p.definition_html, ...extras }, ctx, result.action_id) };
        return { kind: "plan", draft: await build({ ...base, action: "add", concept: p.concept, definition_html: p.definition_html, ...(p.aliases?.length ? { aliases: p.aliases } : {}), ...(p.categories?.length ? { categories: p.categories } : {}) }, ctx, result.action_id) };
    },
};
