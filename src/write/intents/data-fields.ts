import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { DATA_FIELD_TYPES } from "../functions.js";

/**
 * W6 · Campos de una base de datos (mod_data; ADR-080), por el formulario simple `/mod/data/field.php`
 * (modos add, update y delete; sin servicio web). Con ellos una base creada por el MCP puede recibir
 * entradas (`campus_plan_data_entry`).
 * - Tipos: texto, área de texto, número, URL, menú, botones de opción, casillas, menú múltiple y fecha.
 * - Borrar un campo borra TODOS sus valores en las entradas: R3, el plan cuenta las entradas.
 * - Verificación por `mod_data_get_fields`. Deshacer: borrar el agregado; volver a la definición anterior;
 *   recrear el borrado (compensación: otro id y sin valores).
 */

type FieldType = (typeof DATA_FIELD_TYPES)[number];
const WITH_OPTIONS = new Set<FieldType>(["menu", "radiobutton", "checkbox", "multimenu"]);
const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));
const DatabasesSchema = z.object({ databases: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), name: z.string().nullable().optional() })).default([]) });
const FieldsSchema = z.object({ fields: z.array(z.object({ id: z.number().int(), name: z.string(), type: z.string(), description: z.string().nullable().optional(), required: z.union([z.boolean(), z.number()]).nullable().optional(), param1: z.string().nullable().optional() })).default([]) });
const EntriesSchema = z.object({ totalcount: z.number().nullable().optional(), entries: z.array(z.unknown()).default([]) });

interface FieldDef {
    name: string;
    type: FieldType;
    description: string;
    required: boolean;
    options: string[];
}
type Field = z.infer<typeof FieldsSchema>["fields"][number];
const defOf = (f: Field): FieldDef => ({ name: f.name, type: f.type as FieldType, description: f.description ?? "", required: f.required === true || f.required === 1, options: WITH_OPTIONS.has(f.type as FieldType) ? (f.param1 ?? "").split(/\r?\n/).map((o) => o.trim()).filter(Boolean) : [] });
const key = (d: FieldDef) => JSON.stringify([d.name, d.type, d.description, d.required, d.options]);

async function databaseOf(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "data") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es una base de datos (es ${m.modname}).`);
    const d = DatabasesSchema.parse(await ctx.transport.call("mod_data_get_databases_by_courses", { courseids: [courseId] })).databases.find((x) => x.coursemodule === cmid);
    if (!d) throw new CampusError("UNEXPECTED_RESPONSE", "La base de datos no aparece en mod_data_get_databases_by_courses.");
    const fields = FieldsSchema.parse(await ctx.transport.call("mod_data_get_fields", { databaseid: d.id })).fields;
    return { cmid, id: d.id, name: d.name ?? m.name ?? "", fields };
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid] = k.split(":");
        out[k] = kind === "datafields" ? JSON.stringify((await databaseOf(ctx, Number(course), Number(cmid))).fields.map((f) => [f.id, key(defOf(f))])) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { action: string; field_id?: number; def?: FieldDef; prior_ids: number[]; prior?: FieldDef };
    const db = await databaseOf(ctx, plan.course_id, Number(item.target.cmid));
    if (x.action === "delete") {
        const still = db.fields.some((f) => f.id === x.field_id);
        return still ? { outcome: "sin_efecto", checked: ["campo"], differences: [{ field: "campo", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["campo"], differences: [] };
    }
    const prior = new Set(x.prior_ids);
    const f = x.action === "add" ? db.fields.find((y) => !prior.has(y.id) && y.name === x.def!.name) : db.fields.find((y) => y.id === x.field_id);
    if (!f) return { outcome: "sin_efecto", checked: ["campo"], differences: [{ field: "campo", expected: x.action === "add" ? "agregado" : "existe", observed: "no aparece" }] };
    const now = defOf(f);
    const differences: Difference[] = (["name", "type", "description", "required", "options"] as const).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(x.def![k])).map((k) => ({ field: k, expected: x.def![k], observed: now[k] }));
    const ids = x.action === "add" ? { moodle_ids: { field_id: f.id } } : {};
    if (!differences.length) return { outcome: "coincide", checked: ["name", "type", "description", "required", "options"], differences, ...ids };
    return { outcome: x.prior && key(now) === key(x.prior) ? "sin_efecto" : "difiere", checked: ["name", "type", "description", "required", "options"], differences, ...ids };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

/** Campos del formulario para una definición (los parámetros propios de cada tipo, con los valores por defecto de Moodle). */
function formFields(def: FieldDef): Record<string, string> {
    const out: Record<string, string> = { type: def.type, name: def.name, description: def.description, required: def.required ? "1" : "0" };
    if (WITH_OPTIONS.has(def.type)) out.param1 = def.options.join("\n");
    if (def.type === "textarea") Object.assign(out, { param2: "60", param3: "35", param4: "1", param5: "0" });
    if (def.type === "date") delete out.required;
    return out;
}

type Action = "add" | "edit" | "delete";
interface Req {
    course_id: number;
    course_module_id: number;
    action: Action;
    field_id?: number;
    name?: string;
    type?: FieldType;
    description?: string;
    required?: boolean;
    options?: string[];
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const db = await databaseOf(ctx, input.course_id, input.course_module_id);
    const versions = { [`datafields:${input.course_id}:${db.cmid}`]: JSON.stringify(db.fields.map((f) => [f.id, key(defOf(f))])) };
    const priorIds = db.fields.map((f) => f.id);
    const preview: Record<string, unknown> = { database: { course_module_id: db.cmid, name: db.name }, fields_before: db.fields.map((f) => ({ field_id: f.id, ...defOf(f) })) };
    const nameTaken = (n: string, except?: number) => db.fields.some((f) => f.id !== except && f.name.trim().toLowerCase() === n.trim().toLowerCase());
    const normalize = (d: FieldDef): FieldDef => {
        const name = d.name.trim();
        if (!name) throw new CampusError("WRITE_NOT_ALLOWED", "El nombre del campo no puede quedar vacío.");
        const options = d.options.map((o) => o.trim()).filter(Boolean);
        if (WITH_OPTIONS.has(d.type) && !options.length) throw new CampusError("WRITE_NOT_ALLOWED", `Un campo de tipo ${d.type} necesita options.`);
        if (!WITH_OPTIONS.has(d.type) && d.options.length) throw new CampusError("WRITE_NOT_ALLOWED", `Un campo de tipo ${d.type} no lleva options.`);
        if (new Set(options).size !== options.length) throw new CampusError("WRITE_NOT_ALLOWED", "Hay opciones repetidas.");
        return { ...d, name, options, required: d.type === "date" ? false : d.required };
    };
    let item: PlanItem;
    let summary: string;
    let risk: "R2" | "R3" = "R2";
    let undo: PlanDraft["undo"];
    let prior: Record<string, unknown> = {};
    const warnings: string[] = ["Formulario web: requiere la sesión web del Campus."];
    if (input.action === "add") {
        if (!input.name || !input.type) throw new CampusError("WRITE_NOT_ALLOWED", "Para agregar un campo hacen falta name y type.");
        const def = normalize({ name: input.name, type: input.type, description: input.description ?? "", required: input.required ?? false, options: input.options ?? [] });
        if (nameTaken(def.name)) throw new CampusError("WRITE_NOT_ALLOWED", `La base de datos ya tiene un campo «${def.name}».`);
        item = { item_id: "i1", description: `Agregar el campo «${def.name}» (${def.type})`, call: { kind: "form", fn: "data_field_add", params: { query: {}, fields: { d: String(db.id), mode: "add", ...formFields(def) } } }, target: { course_id: input.course_id, cmid: db.cmid }, expected: { action: "add", def, prior_ids: priorIds } };
        summary = `Agregar el campo «${def.name}» (${def.type}) a la base de datos «${db.name}».`;
        preview.field = def;
        undo = { kind: "compensación", how: "Borrar el campo agregado.", until: null };
    } else {
        const f = db.fields.find((y) => y.id === input.field_id);
        if (!f) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La base de datos «${db.name}» no tiene el campo ${input.field_id ?? "(falta field_id)"}.`);
        const cur = defOf(f);
        if (!(DATA_FIELD_TYPES as readonly string[]).includes(f.type)) throw new CampusError("WRITE_NOT_ALLOWED", `El campo «${f.name}» es de tipo ${f.type}: no se admite por ahora.`);
        prior = { def: cur };
        const entries = EntriesSchema.parse(await ctx.read.session.transport.call("mod_data_get_entries", { databaseid: db.id, returncontents: 0, page: 0, perpage: 1 }, EntriesSchema)).totalcount ?? 0;
        if (input.action === "edit") {
            if (input.type !== undefined && input.type !== cur.type) throw new CampusError("WRITE_NOT_ALLOWED", "El tipo de un campo no se cambia (borralo y creá otro).");
            const def = normalize({ name: input.name ?? cur.name, type: cur.type, description: input.description ?? cur.description, required: input.required ?? cur.required, options: input.options ?? cur.options });
            if (key(def) === key(cur)) throw new CampusError("WRITE_NOT_ALLOWED", "El campo ya está así.");
            if (nameTaken(def.name, f.id)) throw new CampusError("WRITE_NOT_ALLOWED", `La base de datos ya tiene un campo «${def.name}».`);
            const dropped = cur.options.filter((o) => !def.options.includes(o));
            if (dropped.length && entries) warnings.push(`Se quitan opciones (${dropped.join(", ")}) y hay ${entries} entrada(s): los valores con esas opciones quedan huérfanos.`);
            item = { item_id: "i1", description: `Editar el campo ${f.id}`, call: { kind: "form", fn: "data_field_update", params: { query: {}, fields: { d: String(db.id), mode: "update", fid: String(f.id), ...formFields(def) } } }, target: { course_id: input.course_id, cmid: db.cmid }, expected: { action: "edit", field_id: f.id, def, prior: cur, prior_ids: priorIds } };
            summary = `Editar el campo «${cur.name}» de la base de datos «${db.name}».`;
            Object.assign(preview, { before: cur, after: def });
            undo = { kind: "compensación", how: "Volver a la definición anterior.", until: null };
        } else {
            item = { item_id: "i1", description: `Borrar el campo ${f.id}`, call: { kind: "form", fn: "data_field_delete", params: { query: {}, fields: { d: String(db.id), mode: "delete", fid: String(f.id), confirm: "1" } } }, target: { course_id: input.course_id, cmid: db.cmid }, expected: { action: "delete", field_id: f.id, prior_ids: priorIds } };
            summary = `BORRAR el campo «${cur.name}» de la base de datos «${db.name}»${entries ? ` con sus valores en ${entries} entrada(s)` : ""}.`;
            preview.deletes = { field: cur, entries_affected: entries };
            risk = "R3";
            undo = { kind: "compensación", how: "Volver a crear el campo con la misma definición (otro id; los valores borrados no vuelven).", until: null };
        }
    }
    return {
        intent: "data_field",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: preview,
        side_effects: [input.action === "delete" ? "El campo se BORRA con todos sus valores." : "Cambia el formulario de entradas de la base de datos.", "Sin notificaciones."],
        preconditions: { description: "Los campos no cambiaron desde el plan.", versions },
        undo,
        warnings,
        items: [item],
        prior_state: prior,
        untrusted_fields: ["payload_preview.database.name", "payload_preview.fields_before", "payload_preview.before"],
        teacher_text: Object.fromEntries(Object.entries({ name: input.name, description: input.description, options: input.options?.join("\n") }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la base de datos."),
    operation: z.enum(["add", "edit", "delete"]),
    field_id: z.number().int().positive().optional().describe("Campo (edit, delete)."),
    name: z.string().min(1).max(64).optional(),
    type: z.enum(DATA_FIELD_TYPES).optional().describe("add: text, textarea, number, url, menu, radiobutton, checkbox, multimenu o date."),
    description: z.string().max(1000).optional(),
    required: z.boolean().optional().describe("Obligatorio al cargar una entrada (no aplica a date)."),
    options: z.array(z.string().min(1).max(255)).max(100).optional().describe("menu, radiobutton, checkbox y multimenu: las opciones, en orden."),
};

export const dataFieldIntent: WriteIntent<typeof shape> = {
    name: "data_field",
    title: "Plan: agregar, editar o borrar un campo de una base de datos",
    description: "Arma el plan para definir los campos de una base de datos (mod_data): agregar (name, type, options…), editar (nombre, descripción, obligatoriedad, opciones) o borrar (R3: se pierden sus valores). No escribe.",
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
        const x = plan.items[0]!.expected as { action: Action; field_id?: number };
        const p = plan.prior_state as { def?: FieldDef };
        const base = { course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid) };
        if (x.action === "add") {
            const id = r.moodle_ids.field_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce el campo agregado." };
            return { kind: "plan", draft: await build({ ...base, action: "delete", field_id: id }, ctx, result.action_id) };
        }
        if (x.action === "edit") return { kind: "plan", draft: await build({ ...base, action: "edit", field_id: x.field_id, name: p.def!.name, description: p.def!.description, required: p.def!.required, options: p.def!.options.length ? p.def!.options : undefined }, ctx, result.action_id) };
        return { kind: "plan", draft: await build({ ...base, action: "add", ...p.def!, options: p.def!.options }, ctx, result.action_id) };
    },
};
