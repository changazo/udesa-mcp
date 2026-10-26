import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";

/**
 * W6 · Entradas de una base de datos (mod_data; ADR-077), por servicio web: `mod_data_add_entry`,
 * `mod_data_update_entry` y `mod_data_delete_entry`, sin grupo. Campos admitidos: texto, área de texto
 * (Markdown → HTML), número, URL, menú y botones de opción (el valor tiene que ser una de sus opciones).
 * Moodle valida los campos obligatorios y devuelve avisos por campo (fieldnotifications) sin crear nada.
 * Verificación por `mod_data_get_entry`. Deshacer: borrar la agregada; volver a los valores anteriores;
 * volver a agregar una borrada (compensación: otro id, sin comentarios ni calificaciones).
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));
const DatabasesSchema = z.object({ databases: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), name: z.string().nullable().optional() })).default([]) });
const FieldsSchema = z.object({ fields: z.array(z.object({ id: z.number().int(), name: z.string(), type: z.string(), required: z.boolean().nullable().optional(), param1: z.string().nullable().optional() })).default([]) });
const EntrySchema = z.object({ entry: z.object({ id: z.number().int(), dataid: z.number().int(), approved: z.union([z.boolean(), z.number()]).nullable().optional(), contents: z.array(z.object({ fieldid: z.number().int(), content: z.string().nullable().optional() })).default([]) }) });
const SUPPORTED = new Set(["text", "textarea", "number", "url", "menu", "radiobutton", "checkbox", "multimenu", "date"]);
const MULTI = new Set(["checkbox", "multimenu"]);
/** Fecha de un campo «date»: Moodle guarda el mediodía local del día (unix); acá, AAAA-MM-DD. */
const dateOf = (v: string) => (/^\d+$/.test(v.trim()) ? new Date(Number(v) * 1000).toISOString().slice(0, 10) : v.trim());
/** Opciones elegidas: Moodle las guarda unidas por «##». */
const optionsOf = (v: string) => v.split("##").map((o) => o.trim()).filter(Boolean);

type Field = z.infer<typeof FieldsSchema>["fields"][number];

async function databaseOf(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "data") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es una base de datos (es ${m.modname}).`);
    const d = DatabasesSchema.parse(await ctx.transport.call("mod_data_get_databases_by_courses", { courseids: [courseId] })).databases.find((x) => x.coursemodule === cmid);
    if (!d) throw new CampusError("UNEXPECTED_RESPONSE", "La base de datos no aparece en mod_data_get_databases_by_courses.");
    const fields = FieldsSchema.parse(await ctx.transport.call("mod_data_get_fields", { databaseid: d.id })).fields;
    return { cmid, id: d.id, name: d.name ?? m.name ?? "", fields };
}

/** Contenido por campo (texto comparable), o null si la entrada ya no existe. */
async function entryOf(ctx: IntentContext, id: number) {
    try {
        const e = EntrySchema.parse(await ctx.transport.call("mod_data_get_entry", { entryid: id, returncontents: 1 })).entry;
        return { id: e.id, dataid: e.dataid, approved: e.approved === true || e.approved === 1, raw: Object.fromEntries(e.contents.map((c) => [String(c.fieldid), c.content ?? ""])) as Record<string, string> };
    } catch (e) {
        if (e instanceof CampusError && (e.code === "MOODLE_REJECTED" || e.code === "MOODLE_PERMISSION_DENIED")) return null;
        throw e;
    }
}

const norm = (f: Field | undefined, v: string) => (f?.type === "textarea" ? comparable(v) : f && MULTI.has(f.type) ? [...optionsOf(v)].sort().join("##") : f?.type === "date" ? dateOf(v) : v.trim());

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, id] = k.split(":");
        if (kind !== "dentry") {
            out[k] = null;
            continue;
        }
        const e = await entryOf(ctx, Number(id));
        out[k] = e ? JSON.stringify(Object.entries(e.raw).map(([f, v]) => [f, comparable(v)]).sort()) : null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    const d = (data ?? {}) as { newentryid?: unknown; updated?: unknown; result?: unknown; fieldnotifications?: { fieldname?: string; notification?: string }[]; generalnotifications?: string[] };
    const notes = [...(d.generalnotifications ?? []), ...(d.fieldnotifications ?? []).map((n) => `${n.fieldname ?? "?"}: ${n.notification ?? ""}`)].join(" · ");
    if (item.call.fn === "mod_data_add_entry") {
        const id = Number(d.newentryid);
        return Number.isInteger(id) && id > 0 ? { ok: true, moodle_ids: { entry_id: id } } : { ok: false, reason: `Moodle no creó la entrada${notes ? `: ${notes}` : ""}.` };
    }
    if (item.call.fn === "mod_data_update_entry" && d.updated === false) return { ok: false, reason: `Moodle no actualizó la entrada${notes ? `: ${notes}` : ""}.` };
    if (item.call.fn === "mod_data_delete_entry" && d.result === false) return { ok: false, reason: "Moodle no borró la entrada." };
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const x = item.expected as { action: string; entry_id?: number; values?: Record<string, string>; types: Record<string, string>; prior?: Record<string, string> };
    const id = x.action === "add" ? known.entry_id : x.entry_id;
    const e = id ? await entryOf(ctx, id) : null;
    if (x.action === "approve" || x.action === "unapprove") {
        const want = x.action === "approve";
        if (!e) return { outcome: "sin_efecto", checked: ["aprobada"], differences: [{ field: "entrada", expected: "existe", observed: "no aparece" }] };
        return e.approved === want ? { outcome: "coincide", checked: ["aprobada"], differences: [] } : { outcome: "sin_efecto", checked: ["aprobada"], differences: [{ field: "aprobada", expected: want, observed: e.approved }] };
    }
    if (x.action === "delete") return e ? { outcome: "sin_efecto", checked: ["entrada"], differences: [{ field: "entrada", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["entrada"], differences: [] };
    if (!e) return { outcome: x.action === "add" && !id ? "difiere" : "sin_efecto", checked: ["entrada"], differences: [{ field: "entrada", expected: "existe", observed: "no aparece" }] };
    const differences: Difference[] = [];
    for (const [fid, want] of Object.entries(x.values ?? {})) {
        const got = norm({ type: x.types[fid] ?? "text" } as Field, e.raw[fid] ?? "");
        if (got !== want) differences.push({ field: `campo ${fid}`, expected: want, observed: got });
    }
    const checked = Object.keys(x.values ?? {}).map((f) => `campo ${f}`);
    const ids = x.action === "add" ? { moodle_ids: { entry_id: e.id } } : {};
    if (!differences.length) return { outcome: "coincide", checked, differences, ...ids };
    const same = x.action === "edit" && Object.entries(x.prior ?? {}).every(([fid, v]) => norm({ type: x.types[fid] ?? "text" } as Field, e.raw[fid] ?? "") === v);
    return { outcome: same ? "sin_efecto" : "difiere", checked, differences, ...ids };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    // Sin el id que devuelve Moodle no se puede ubicar una entrada nueva con certeza.
    if (item.call.fn === "mod_data_add_entry") return "desconocido";
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

type Action = "add" | "edit" | "delete" | "approve" | "unapprove";
interface Req {
    course_id: number;
    course_module_id: number;
    action: Action;
    entry_id?: number;
    values?: Record<string, string>;
    /** Deshacer: valores crudos por id de campo (HTML en áreas de texto). */
    raw_by_id?: Record<string, string>;
}

function rowsFor(fields: Field[], byId: Record<string, string>) {
    const data: { fieldid: number; subfield: string; value: string }[] = [];
    for (const [fid, v] of Object.entries(byId)) {
        const f = fields.find((y) => String(y.id) === fid)!;
        if (f.type === "date") {
            const [y, m, d] = dateOf(v).split("-").map(Number);
            data.push({ fieldid: f.id, subfield: "day", value: JSON.stringify(d) }, { fieldid: f.id, subfield: "month", value: JSON.stringify(m) }, { fieldid: f.id, subfield: "year", value: JSON.stringify(y) });
            continue;
        }
        data.push({ fieldid: f.id, subfield: "", value: JSON.stringify(MULTI.has(f.type) ? optionsOf(v) : v) });
        if (f.type === "textarea") data.push({ fieldid: f.id, subfield: "content1", value: JSON.stringify("1") });
    }
    return data;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const db = await databaseOf(ctx, input.course_id, input.course_module_id);
    const types = Object.fromEntries(db.fields.map((f) => [String(f.id), f.type]));
    // Valores pedidos (por nombre de campo) → crudos por id de campo.
    const raw: Record<string, string> = { ...(input.raw_by_id ?? {}) };
    for (const [name, value] of Object.entries(input.values ?? {})) {
        const f = db.fields.find((y) => y.name === name);
        if (!f) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La base de datos no tiene el campo «${name}». Campos: ${db.fields.map((y) => y.name).join(", ") || "ninguno"}.`);
        if (!SUPPORTED.has(f.type)) throw new CampusError("WRITE_NOT_ALLOWED", `El campo «${name}» es de tipo ${f.type}: no se admite por ahora.`);
        let v = value.trim();
        if (f.type === "textarea") v = toHtml(value, "markdown");
        else if (f.type === "number" && !/^-?\d+([.,]\d+)?$/.test(v)) throw new CampusError("WRITE_NOT_ALLOWED", `«${name}» tiene que ser un número.`);
        else if (f.type === "url" && !/^https?:\/\/\S+$/.test(v)) throw new CampusError("WRITE_NOT_ALLOWED", `«${name}» tiene que ser una URL http(s).`);
        else if (MULTI.has(f.type)) {
            // Varias opciones: separadas por renglón o por «##» (como las guarda Moodle).
            const chosen = value.split(/\r?\n|##/).map((o) => o.trim()).filter(Boolean);
            const allowed = (f.param1 ?? "").split(/\r?\n/).map((o) => o.trim());
            const bad = chosen.filter((o) => !allowed.includes(o));
            if (!chosen.length || bad.length) throw new CampusError("WRITE_NOT_ALLOWED", `«${name}»: opciones válidas: ${allowed.join(" | ")}.`);
            v = [...new Set(chosen)].join("##");
        } else if (f.type === "date") {
            const ok = /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
            if (!ok) throw new CampusError("WRITE_NOT_ALLOWED", `«${name}» tiene que ser una fecha AAAA-MM-DD.`);
        } else if ((f.type === "menu" || f.type === "radiobutton") && !(f.param1 ?? "").split(/\r?\n/).map((o) => o.trim()).includes(v)) throw new CampusError("WRITE_NOT_ALLOWED", `«${name}» tiene que ser una de sus opciones: ${(f.param1 ?? "").split(/\r?\n/).join(" | ")}.`);
        raw[String(f.id)] = v;
    }
    const preview: Record<string, unknown> = { database: { course_module_id: db.cmid, name: db.name } };
    const named = (byId: Record<string, string>) => Object.fromEntries(Object.entries(byId).map(([fid, v]) => [db.fields.find((f) => String(f.id) === fid)?.name ?? fid, v]));
    const expectedValues = Object.fromEntries(Object.entries(raw).map(([fid, v]) => [fid, norm(db.fields.find((f) => String(f.id) === fid), v)]));
    let item: PlanItem;
    let summary: string;
    let risk: "R2" | "R3" = "R2";
    let undo: PlanDraft["undo"];
    let prior: Record<string, unknown> = {};
    const versions: Record<string, string | null> = {};
    if (input.action === "add") {
        if (!Object.keys(raw).length) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá values (por nombre de campo).");
        const missing = db.fields.filter((f) => f.required && !raw[String(f.id)]);
        if (missing.length) throw new CampusError("WRITE_NOT_ALLOWED", `Faltan campos obligatorios: ${missing.map((f) => f.name).join(", ")}.`);
        item = { item_id: "i1", description: "Agregar una entrada", call: { kind: "rest", fn: "mod_data_add_entry", params: { databaseid: db.id, data: rowsFor(db.fields, raw) } }, target: { course_id: input.course_id, cmid: db.cmid }, expected: { action: "add", values: expectedValues, types } };
        summary = `Agregar una entrada a la base de datos «${db.name}».`;
        preview.values = named(raw);
        undo = { kind: "compensación", how: "Borrar la entrada agregada.", until: null };
    } else {
        const e = input.entry_id ? await entryOf(ctx, input.entry_id) : null;
        if (!e || e.dataid !== db.id) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La base de datos «${db.name}» no tiene la entrada ${input.entry_id ?? "(falta entry_id)"}.`);
        versions[`dentry:${e.id}`] = JSON.stringify(Object.entries(e.raw).map(([f, v]) => [f, comparable(v)]).sort());
        preview.entry = { id: e.id, values: named(e.raw) };
        prior = { raw_by_id: e.raw };
        if (input.action === "approve" || input.action === "unapprove") {
            const want = input.action === "approve";
            if (e.approved === want) throw new CampusError("WRITE_NOT_ALLOWED", `La entrada ya está ${want ? "aprobada" : "sin aprobar"}.`);
            item = { item_id: "i1", description: `${want ? "Aprobar" : "Desaprobar"} la entrada ${e.id}`, call: { kind: "rest", fn: "mod_data_approve_entry", params: { entryid: e.id, approve: want ? 1 : 0 } }, target: { course_id: input.course_id, cmid: db.cmid }, expected: { action: input.action, entry_id: e.id, types } };
            summary = `${want ? "Aprobar" : "Desaprobar"} la entrada ${e.id} de la base de datos «${db.name}».`;
            undo = { kind: "exacto", how: want ? "Desaprobarla." : "Aprobarla.", until: null };
        } else if (input.action === "edit") {
            if (!Object.keys(raw).length) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá values (por nombre de campo).");
            const changed = Object.fromEntries(Object.entries(raw).filter(([fid, v]) => norm(db.fields.find((f) => String(f.id) === fid), v) !== norm(db.fields.find((f) => String(f.id) === fid), e.raw[fid] ?? "")));
            if (!Object.keys(changed).length) throw new CampusError("WRITE_NOT_ALLOWED", "La entrada ya tiene esos valores.");
            const priorVals = Object.fromEntries(Object.keys(changed).map((fid) => [fid, norm(db.fields.find((f) => String(f.id) === fid), e.raw[fid] ?? "")]));
            item = { item_id: "i1", description: `Editar la entrada ${e.id}`, call: { kind: "rest", fn: "mod_data_update_entry", params: { entryid: e.id, data: rowsFor(db.fields, changed) } }, target: { course_id: input.course_id, cmid: db.cmid }, expected: { action: "edit", entry_id: e.id, values: Object.fromEntries(Object.keys(changed).map((fid) => [fid, expectedValues[fid]!])), types, prior: priorVals } };
            summary = `Editar la entrada ${e.id} de la base de datos «${db.name}».`;
            preview.after = named(changed);
            prior = { raw_by_id: Object.fromEntries(Object.keys(changed).map((fid) => [fid, e.raw[fid] ?? ""])) };
            undo = { kind: "compensación", how: "Volver a los valores anteriores.", until: null };
        } else {
            item = { item_id: "i1", description: `Borrar la entrada ${e.id}`, call: { kind: "rest", fn: "mod_data_delete_entry", params: { entryid: e.id } }, target: { course_id: input.course_id, cmid: db.cmid }, expected: { action: "delete", entry_id: e.id, types } };
            summary = `BORRAR la entrada ${e.id} de la base de datos «${db.name}».`;
            risk = "R3";
            undo = { kind: "compensación", how: "Volver a agregarla con los mismos valores (otro id; sin archivos, comentarios ni calificaciones).", until: null };
        }
    }
    return {
        intent: "data_entry",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: preview,
        side_effects: [input.action === "delete" ? "La entrada se BORRA con sus archivos, comentarios y calificaciones." : "Cambia lo que ven los participantes en la base de datos.", "Sin mensajes."],
        preconditions: { description: "La entrada no cambió desde el plan.", versions },
        undo,
        warnings: [],
        items: [item],
        prior_state: prior,
        untrusted_fields: ["payload_preview.database.name", "payload_preview.entry"],
        teacher_text: Object.fromEntries(Object.entries(input.values ?? {}).map(([k, v]) => [`campo ${k}`, v])),
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la base de datos."),
    operation: z.enum(["add", "edit", "delete", "approve", "unapprove"]).describe("approve / unapprove: aprobar o desaprobar una entrada (bases con aprobación)."),
    entry_id: z.number().int().positive().optional().describe("Entrada (edit, delete, approve, unapprove)."),
    values: z.record(z.string().min(1).max(255), z.string().max(100_000)).optional().describe("Valores por NOMBRE de campo (texto, área de texto en Markdown, número, URL, menú, botones de opción)."),
};

export const dataEntryIntent: WriteIntent<typeof shape> = {
    name: "data_entry",
    title: "Plan: agregar, editar o borrar una entrada de una base de datos",
    description: "Arma el plan para agregar (values por nombre de campo), editar o borrar (R3) una entrada de una base de datos (mod_data). Muestra antes y después. No escribe.",
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
        const p = plan.prior_state as { raw_by_id?: Record<string, string> };
        const base = { course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid) };
        if (x.action === "add") {
            const id = r.moodle_ids.entry_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce la entrada agregada." };
            return { kind: "plan", draft: await build({ ...base, action: "delete", entry_id: id }, ctx, result.action_id) };
        }
        if (x.action === "approve" || x.action === "unapprove") return { kind: "plan", draft: await build({ ...base, action: x.action === "approve" ? "unapprove" : "approve", entry_id: x.entry_id }, ctx, result.action_id) };
        if (x.action === "edit") return { kind: "plan", draft: await build({ ...base, action: "edit", entry_id: x.entry_id, raw_by_id: p.raw_by_id }, ctx, result.action_id) };
        return { kind: "plan", draft: await build({ ...base, action: "add", raw_by_id: Object.fromEntries(Object.entries(p.raw_by_id ?? {}).filter(([, v]) => v !== "")) }, ctx, result.action_id) };
    },
};
