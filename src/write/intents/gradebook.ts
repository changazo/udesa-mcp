import { z } from "zod";
import { GradeItemsSchema } from "../../moodle/schemas.js";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { parseFormFields } from "../web.js";
import { fieldOf, stableHtml } from "./modform.js";

/**
 * W6 · Libro de calificaciones (ADR-096), capacidad `manage_gradebook`, por las páginas clásicas:
 * - Ítems: agregar o editar un ítem MANUAL (`/grade/edit/tree/item.php`, nombre, nota máxima, mínima y de
 *   aprobación, tipo y escala); borrar un ítem manual (`/grade/edit/tree/index.php?action=delete`);
 *   ocultar, mostrar, bloquear o desbloquear cualquier ítem (`/grade/edit/tree/action.php`).
 * - Notas: sobrescribir (o quitar la sobrescritura de) la nota de UN participante en un ítem, excluirla,
 *   ocultarla, bloquearla y su retroalimentación (`/grade/edit/tree/grade.php`). Sin notificaciones.
 * Verificación releyendo el formulario del ítem o de la nota; la lista de ítems sale de
 * `core_grades_get_gradeitems`. Deshacer: los valores anteriores; borrar el ítem agregado.
 */

const ItemsSchema = z.object({ gradeItems: z.array(z.object({ id: z.union([z.string(), z.number()]), itemname: z.string().nullable().optional() })).default([]) });

/** ADR-119: cuántos participantes tienen nota en el ítem (borrarlo con notas es R4). */
async function gradedCount(ctx: IntentContext, courseId: number, itemId: number): Promise<number> {
    const r = await ctx.read.session.transport.call("gradereport_user_get_grade_items", { courseid: courseId, userid: 0 }, GradeItemsSchema);
    return r.usergrades.filter((u) => u.gradeitems.some((g) => g.id === itemId && g.graderaw !== null && g.graderaw !== undefined)).length;
}

async function itemsOf(ctx: IntentContext, courseId: number) {
    return ItemsSchema.parse(await ctx.transport.call("core_grades_get_gradeitems", { courseid: courseId })).gradeItems.map((i) => ({ id: Number(i.id), name: i.itemname ?? "" }));
}

interface ItemForm {
    itemtype: string;
    itemname: string;
    idnumber: string;
    gradetype: string;
    scaleid: string;
    grademax: number | null;
    grademin: number | null;
    gradepass: number | null;
    hidden: boolean;
    locked: boolean;
}
const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v.trim().replace(/\s/g, "").replace(",", ".")));

/** Valor elegido de un select aunque esté deshabilitado (Moodle bloquea el tipo de un ítem con notas). */
function selected(html: string, name: string): string | undefined {
    const sel = new RegExp(`<select\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1];
    if (sel === undefined) return undefined;
    const opts = [...sel.matchAll(/<option\b([^>]*)>/g)];
    const pick = opts.find((o) => /\sselected/.test(` ${o[1]}`)) ?? opts[0];
    return pick ? /value="([^"]*)"/.exec(pick[1]!)?.[1] : undefined;
}

async function itemForm(ctx: IntentContext, courseId: number, itemId: number): Promise<ItemForm | null> {
    const html = await ctx.web.readPage("grade_item_form", { courseid: String(courseId), id: String(itemId) });
    const f = parseFormFields(html, "_qf__edit_item_form");
    if (!f) return null;
    const get = (n: string) => fieldOf(f, n) ?? (n === "gradetype" || n === "scaleid" ? selected(html, n) : undefined);
    const last = (n: string) => f.filter(([k]) => k === n).at(-1)?.[1];
    return {
        itemtype: get("itemtype") ?? "",
        itemname: get("itemname") ?? "",
        idnumber: get("idnumber") ?? "",
        // Con notas, Moodle no dibuja el tipo: si hay nota máxima es «valor».
        gradetype: get("gradetype") ?? (f.some(([n]) => n === "grademax") ? "1" : ""),
        scaleid: get("scaleid") ?? "",
        grademax: num(get("grademax")),
        grademin: num(get("grademin")),
        gradepass: num(get("gradepass")),
        hidden: last("hidden") === "1",
        locked: last("locked") === "1",
    };
}

interface GradeForm {
    /** Ítems de actividades: la nota se SOBRESCRIBE (casilla «overridden»); los manuales no la tienen. */
    canOverride: boolean;
    overridden: boolean;
    finalgrade: string;
    options: { value: string; label: string }[];
    excluded: boolean;
    hidden: boolean;
    locked: boolean;
    feedback: string;
}

async function gradeForm(ctx: IntentContext, courseId: number, itemId: number, userId: number): Promise<GradeForm> {
    const html = await ctx.web.readPage("grade_grade_form", { courseid: String(courseId), itemid: String(itemId), userid: String(userId) });
    const f = parseFormFields(html, "_qf__edit_grade_form");
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció el formulario de la nota (¿el participante no está en el curso?).");
    const get = (n: string) => fieldOf(f, n);
    const last = (n: string) => f.filter(([k]) => k === n).at(-1)?.[1];
    const sel = /<select\b[^>]*name="finalgrade"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    const options = [...sel.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)</g)].map((o) => ({ value: o[1]!, label: o[2]!.trim() })).filter((o) => o.value !== "-1" && o.value !== "" && o.label !== "");
    return { canOverride: /name="overridden"/.test(html), overridden: get("overridden") === "1", finalgrade: get("finalgrade") ?? "", options, excluded: last("excluded") === "1", hidden: get("hidden") === "1", locked: last("locked") === "1", feedback: stableHtml(get("feedback[text]") ?? "") };
}

const gradeSnap = (g: GradeForm) => ({ overridden: g.canOverride ? g.overridden : null, finalgrade: g.options.length ? g.finalgrade : num(g.finalgrade), excluded: g.excluded, hidden: g.hidden, locked: g.locked, feedback: comparable(g.feedback) });
const itemSnap = (i: ItemForm | null) => (i ? { itemname: i.itemname, idnumber: i.idnumber, gradetype: i.gradetype, scaleid: i.gradetype === "2" ? i.scaleid : "", grademax: i.gradetype === "1" ? i.grademax : null, grademin: i.gradetype === "1" ? i.grademin : null, gradepass: i.gradepass, hidden: i.hidden, locked: i.locked } : null);

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, item, user] = k.split(":");
        if (kind === "gbitem") out[k] = JSON.stringify(itemSnap(await itemForm(ctx, Number(course), Number(item))));
        else if (kind === "gbitems") out[k] = (await itemsOf(ctx, Number(course))).map((i) => i.id).sort((a, b) => a - b).join(",");
        else if (kind === "gbgrade") out[k] = JSON.stringify(gradeSnap(await gradeForm(ctx, Number(course), Number(item), Number(user))));
        else out[k] = null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected as { op: string; want?: Record<string, unknown>; prior?: Record<string, unknown> | null; prior_ids?: number[]; name?: string };
    if (x.op === "grade") {
        const now = gradeSnap(await gradeForm(ctx, plan.course_id, Number(t.item_id), Number(t.user_id))) as Record<string, unknown>;
        const keys = Object.keys(x.want!);
        const differences: Difference[] = keys.filter((k) => JSON.stringify(now[k]) !== JSON.stringify(x.want![k])).map((k) => ({ field: k, expected: x.want![k], observed: now[k] }));
        if (!differences.length) return { outcome: "coincide", checked: keys, differences };
        return { outcome: keys.every((k) => JSON.stringify(now[k]) === JSON.stringify(x.prior![k])) ? "sin_efecto" : "difiere", checked: keys, differences };
    }
    if (x.op === "delete") {
        const still = (await itemsOf(ctx, plan.course_id)).some((i) => i.id === Number(t.item_id));
        return still ? { outcome: "sin_efecto", checked: ["ítem"], differences: [{ field: "ítem", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["ítem"], differences: [] };
    }
    let id = Number(t.item_id);
    if (x.op === "add") {
        const prior = new Set(x.prior_ids ?? []);
        const fresh = (await itemsOf(ctx, plan.course_id)).filter((i) => !prior.has(i.id) && i.name === x.name);
        if (fresh.length !== 1) return { outcome: fresh.length ? "difiere" : "sin_efecto", checked: ["ítem"], differences: [{ field: "ítems nuevos", expected: 1, observed: fresh.length }] };
        id = fresh[0]!.id;
    }
    const now = itemSnap(await itemForm(ctx, plan.course_id, id)) as Record<string, unknown> | null;
    if (!now) return { outcome: "difiere", checked: ["ítem"], differences: [{ field: "ítem", expected: "existe", observed: "no se lee" }] };
    const keys = Object.keys(x.want!);
    const differences: Difference[] = keys.filter((k) => JSON.stringify(now[k]) !== JSON.stringify(x.want![k])).map((k) => ({ field: k, expected: x.want![k], observed: now[k] }));
    const ids = x.op === "add" ? { moodle_ids: { item_id: id } } : {};
    if (!differences.length) return { outcome: "coincide", checked: keys, differences, ...ids };
    return { outcome: x.prior && keys.every((k) => JSON.stringify(now[k]) === JSON.stringify(x.prior![k])) ? "sin_efecto" : "difiere", checked: keys, differences, ...ids };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };
const applied = (r: { outcome: string }) => r.outcome === "verificado" || r.outcome === "con_diferencias";
const fmt = (n: number) => String(Math.round(n * 100000) / 100000);

// ---------- ítems ----------

type ItemOp = "add" | "edit" | "delete" | "hide" | "show" | "lock" | "unlock";
interface ItemReq {
    course_id: number;
    action: ItemOp;
    item_id?: number;
    name?: string;
    id_number?: string;
    grade_type?: "value" | "scale" | "text" | "none";
    scale_id?: number;
    max_grade?: number;
    min_grade?: number;
    pass_grade?: number;
    hidden?: boolean;
    /** Deshacer: valores exactos del formulario. */
    restore?: NonNullable<ReturnType<typeof itemSnap>>;
}
const GRADE_TYPES = { none: "0", value: "1", scale: "2", text: "3" } as const;

async function buildItem(input: ItemReq, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const items = await itemsOf(ctx, input.course_id);
    const versions: Record<string, string | null> = {};
    let call: PlanItem["call"];
    let expected: Record<string, unknown>;
    let summary: string;
    let risk: "R2" | "R3" | "R4" = "R2";
    let prior: Record<string, unknown> = {};
    let undo: PlanDraft["undo"] = { kind: "compensación", how: "Volver a los valores anteriores.", until: null };
    const cur = input.action === "add" ? null : await itemForm(ctx, input.course_id, input.item_id ?? 0);
    if (input.action !== "add") {
        const it = items.find((i) => i.id === input.item_id);
        if (!it || !cur) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El ítem de calificación ${input.item_id ?? "(falta item_id)"} no es del curso ${input.course_id}.`);
        versions[`gbitem:${input.course_id}:${it.id}`] = JSON.stringify(itemSnap(cur));
        prior = { item: itemSnap(cur), name: it.name };
    }
    const label = cur ? `«${cur.itemname || input.item_id}»` : `«${input.name}»`;
    if (input.action === "add" || input.action === "edit") {
        if (cur && cur.itemtype !== "manual") throw new CampusError("WRITE_NOT_ALLOWED", `El ítem ${label} es de una actividad (${cur.itemtype}): su nombre y su nota se cambian en la actividad. Acá sólo se oculta o bloquea.`);
        const r = input.restore;
        const fields: Record<string, string> = {};
        const want: Record<string, unknown> = {};
        const set = (field: string, raw: string, key: string, value: unknown) => {
            fields[field] = raw;
            want[key] = value;
        };
        const name = r ? r.itemname : input.name?.trim();
        if (name !== undefined) {
            if (!name) throw new CampusError("WRITE_NOT_ALLOWED", "El nombre no puede quedar vacío.");
            set("itemname", name, "itemname", name);
        } else if (!cur) throw new CampusError("WRITE_NOT_ALLOWED", "Para agregar un ítem hace falta name.");
        if (r ? true : input.id_number !== undefined) set("idnumber", r ? r.idnumber : input.id_number!.trim(), "idnumber", r ? r.idnumber : input.id_number!.trim());
        const type = r ? r.gradetype : input.grade_type ? GRADE_TYPES[input.grade_type] : cur ? undefined : "1";
        if (type !== undefined) set("gradetype", type, "gradetype", type);
        const finalType = type ?? cur?.gradetype ?? "1";
        if (finalType === "2") {
            const scale = r ? r.scaleid : input.scale_id !== undefined ? String(input.scale_id) : cur?.scaleid;
            if (!scale) throw new CampusError("WRITE_NOT_ALLOWED", "Un ítem de escala necesita scale_id.");
            set("scaleid", scale, "scaleid", scale);
        }
        if (finalType === "1") {
            const max = r ? r.grademax : (input.max_grade ?? (cur ? undefined : 100));
            const min = r ? r.grademin : (input.min_grade ?? (cur ? undefined : 0));
            if (max !== undefined && max !== null) set("grademax", fmt(max), "grademax", max);
            if (min !== undefined && min !== null) set("grademin", fmt(min), "grademin", min);
            const lo = (min ?? cur?.grademin ?? 0) as number;
            const hi = (max ?? cur?.grademax ?? 100) as number;
            if (hi <= lo) throw new CampusError("WRITE_NOT_ALLOWED", "La nota máxima tiene que ser mayor que la mínima.");
        }
        const pass = r ? r.gradepass : input.pass_grade;
        if (pass !== undefined && pass !== null) set("gradepass", fmt(pass), "gradepass", pass);
        const hidden = r ? r.hidden : input.hidden;
        if (hidden !== undefined) set("hidden", hidden ? "1" : "0", "hidden", hidden);
        if (cur && Object.keys(want).every((k) => JSON.stringify((itemSnap(cur) as Record<string, unknown>)[k]) === JSON.stringify(want[k]))) throw new CampusError("WRITE_NOT_ALLOWED", "El ítem ya está así.");
        call = { kind: "form", fn: "grade_item_edit", params: { query: { courseid: String(input.course_id), id: String(input.item_id ?? 0) }, fields } };
        expected = { op: input.action, want, prior: cur ? itemSnap(cur) : null, name, prior_ids: items.map((i) => i.id) };
        if (!cur) {
            versions[`gbitems:${input.course_id}`] = items.map((i) => i.id).sort((a, b) => a - b).join(",");
            undo = { kind: "compensación", how: "Borrar el ítem agregado.", until: null };
        }
        summary = cur ? `Editar el ítem de calificación ${label}: ${Object.keys(want).join(", ")}.` : `Agregar el ítem de calificación manual «${name}» (${Object.entries(want).filter(([k]) => k !== "itemname").map(([k, v]) => `${k}=${v}`).join(", ")}).`;
    } else if (input.action === "delete") {
        if (cur!.itemtype !== "manual") throw new CampusError("WRITE_NOT_ALLOWED", `El ítem ${label} es de una actividad: se borra con la actividad, no por esta vía.`);
        call = { kind: "form", fn: "grade_item_delete", params: { query: {}, fields: { id: String(input.course_id), action: "delete", eid: `ig${input.item_id}`, confirm: "1" } } };
        expected = { op: "delete" };
        const graded = await gradedCount(ctx, input.course_id, input.item_id!);
        summary = graded ? `BORRAR el ítem de calificación manual ${label} con las notas de ${graded} participante(s).` : `BORRAR el ítem de calificación manual ${label} (sin notas cargadas).`;
        risk = graded ? "R4" : "R3";
        undo = { kind: "compensación", how: "Volver a crear el ítem con su configuración (otro id, SIN las notas que tenía).", until: null };
    } else {
        // Moodle no bloquea un ítem con notas pendientes de recálculo: abrir el informe del calificador las recalcula.
        if (input.action === "lock") await ctx.web.readPage("grader_report", { id: String(input.course_id) });
        const wantHidden = input.action === "hide" ? true : input.action === "show" ? false : cur!.hidden;
        const wantLocked = input.action === "lock" ? true : input.action === "unlock" ? false : cur!.locked;
        if (wantHidden === cur!.hidden && wantLocked === cur!.locked) throw new CampusError("WRITE_NOT_ALLOWED", `El ítem ${label} ya está ${input.action === "hide" ? "oculto" : input.action === "show" ? "visible" : input.action === "lock" ? "bloqueado" : "desbloqueado"}.`);
        call = { kind: "form", fn: "grade_item_action", params: { query: {}, fields: { id: String(input.course_id), eid: `ig${input.item_id}`, action: input.action } } };
        expected = { op: input.action, want: input.action === "hide" || input.action === "show" ? { hidden: wantHidden } : { locked: wantLocked }, prior: itemSnap(cur) };
        summary = `${{ hide: "Ocultar", show: "Mostrar", lock: "Bloquear", unlock: "Desbloquear" }[input.action]} el ítem de calificación ${label}${input.action === "lock" ? " (nadie puede cambiar sus notas, tampoco desde la actividad)" : input.action === "hide" ? " (los estudiantes dejan de ver esas notas)" : ""}.`;
    }
    return {
        intent: "grade_item",
        capability: "manage_gradebook",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: { item: cur ? { item_id: input.item_id, type: cur.itemtype, ...itemSnap(cur) } : null, after: expected.want ?? null },
        side_effects: ["Cambia el libro de calificaciones del curso (lo que ven los estudiantes, totales y categorías se recalculan).", "Sin notificaciones."],
        preconditions: { description: "El ítem no cambió desde el plan.", versions },
        undo,
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [{ item_id: "i1", description: summary, call, target: { course_id: input.course_id, item_id: input.item_id ?? 0 }, expected }],
        prior_state: prior,
        untrusted_fields: ["payload_preview.item"],
        teacher_text: input.name ? { name: input.name } : {},
        undo_of: undoOf,
    };
}

const itemShape = {
    course_id: z.number().int().positive(),
    operation: z.enum(["add", "edit", "delete", "hide", "show", "lock", "unlock"]).describe("add, edit y delete: ítems MANUALES; hide, show, lock, unlock: cualquier ítem (también los de actividades)."),
    item_id: z.number().int().positive().optional().describe("Ítem (sale de campus_get_grades o del error)."),
    name: z.string().min(1).max(255).optional(),
    id_number: z.string().max(100).optional(),
    grade_type: z.enum(["value", "scale", "text", "none"]).optional().describe("Por defecto value (puntos)."),
    scale_id: z.number().int().positive().optional(),
    max_grade: z.number().min(0).max(10_000).optional(),
    min_grade: z.number().min(0).max(10_000).optional(),
    pass_grade: z.number().min(0).max(10_000).optional(),
    hidden: z.boolean().optional(),
};

export const gradeItemIntent: WriteIntent<typeof itemShape> = {
    name: "grade_item",
    title: "Plan: ítems del libro de calificaciones",
    description: "Arma el plan para agregar, editar o borrar (R3; R4 si tiene notas cargadas, ADR-119) un ítem MANUAL del libro de calificaciones, u ocultar, mostrar, bloquear o desbloquear cualquier ítem. No escribe.",
    inputShape: itemShape,
    capability: "manage_gradebook",
    synthetic_only: false,
    ...common,
    plan: ({ operation, ...rest }, ctx) => buildItem({ ...rest, action: operation }, ctx, null),
    async undo(plan, result, ctx) {
        const r = result.items[0];
        if (!r || !applied(r)) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const x = plan.items[0]!.expected as { op: ItemOp };
        const p = plan.prior_state as { item?: NonNullable<ReturnType<typeof itemSnap>> };
        const base = { course_id: plan.course_id, item_id: Number(plan.items[0]!.target.item_id) };
        const inverse: Partial<Record<ItemOp, ItemOp>> = { hide: "show", show: "hide", lock: "unlock", unlock: "lock" };
        if (x.op === "add") {
            const id = r.moodle_ids.item_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce el ítem agregado." };
            return { kind: "plan", draft: await buildItem({ course_id: plan.course_id, item_id: id, action: "delete" }, ctx, result.action_id) };
        }
        if (inverse[x.op]) return { kind: "plan", draft: await buildItem({ ...base, action: inverse[x.op]! }, ctx, result.action_id) };
        if (x.op === "edit") return { kind: "plan", draft: await buildItem({ ...base, action: "edit", restore: p.item }, ctx, result.action_id) };
        if (!p.item?.gradetype) return { kind: "ninguno", reason: "No se pudo leer el tipo de nota del ítem borrado (con notas, Moodle no lo muestra): recrealo a mano." };
        return { kind: "plan", draft: await buildItem({ course_id: plan.course_id, action: "add", restore: p.item }, ctx, result.action_id) };
    },
};

// ---------- notas ----------

interface GradeReq {
    course_id: number;
    item_id: number;
    participant_id: number;
    grade?: number | string | null;
    excluded?: boolean;
    hidden?: boolean;
    locked?: boolean;
    feedback?: string;
    feedback_html?: string;
    restore?: { overridden: boolean; finalgrade: string; excluded: boolean; hidden: boolean; locked: boolean; feedback_html: string };
}

async function buildGrade(input: GradeReq, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const items = await itemsOf(ctx, input.course_id);
    const it = items.find((i) => i.id === input.item_id);
    if (!it) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El ítem de calificación ${input.item_id} no es del curso ${input.course_id}.`);
    const g = await gradeForm(ctx, input.course_id, it.id, input.participant_id);
    if (g.locked && !(input.locked === false || input.restore)) throw new CampusError("WRITE_NOT_ALLOWED", "La nota está bloqueada: para cambiarla, desbloqueala (locked=false) en el mismo plan.");
    const r = input.restore;
    const fields: Record<string, string> = {};
    const want: Record<string, unknown> = {};
    if (r ? true : input.grade !== undefined) {
        const clear = r ? (g.canOverride ? !r.overridden : r.finalgrade.trim() === "") : input.grade === null;
        if (clear && g.canOverride) {
            fields.overridden = "0";
            want.overridden = false;
        } else if (clear) {
            // Ítem manual: sin nota.
            fields.finalgrade = "";
            want.finalgrade = null;
        } else {
            let raw: string;
            if (r) raw = r.finalgrade;
            else if (g.options.length) {
                const o = g.options.find((s) => (typeof input.grade === "number" ? Number(s.value) === input.grade : s.label.toLowerCase() === String(input.grade).trim().toLowerCase()));
                if (!o) throw new CampusError("WRITE_NOT_ALLOWED", `«${input.grade}» no es un ítem de la escala: ${g.options.map((s) => `${s.value} = ${s.label}`).join("; ")}.`);
                raw = o.value;
            } else {
                const v = typeof input.grade === "number" ? input.grade : Number(String(input.grade).trim().replace(",", "."));
                if (!Number.isFinite(v) || v < 0) throw new CampusError("WRITE_NOT_ALLOWED", `«${input.grade}» no es una nota válida.`);
                raw = fmt(v);
            }
            Object.assign(fields, { ...(g.canOverride ? { overridden: "1" } : {}), finalgrade: raw });
            Object.assign(want, { ...(g.canOverride ? { overridden: true } : {}), finalgrade: g.options.length ? raw : num(raw) });
        }
    }
    const flag = (key: "excluded" | "hidden" | "locked") => {
        const v = r ? r[key] : input[key];
        if (v === undefined) return;
        fields[key] = v ? "1" : "0";
        want[key] = v;
    };
    flag("excluded");
    flag("hidden");
    flag("locked");
    const fb = r ? r.feedback_html : (input.feedback_html ?? (input.feedback !== undefined ? toHtml(input.feedback, "markdown") : undefined));
    if (fb !== undefined) {
        Object.assign(fields, { "feedback[text]": fb, "feedback[format]": "1" });
        want.feedback = comparable(fb);
    }
    const prior = gradeSnap(g) as Record<string, unknown>;
    if (!Object.keys(want).length) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá grade (null = quitar la sobrescritura), excluded, hidden, locked o feedback.");
    if (Object.keys(want).every((k) => JSON.stringify(prior[k]) === JSON.stringify(want[k]))) throw new CampusError("WRITE_NOT_ALLOWED", "La nota ya está así.");
    return {
        intent: "gradebook_grade",
        capability: "manage_gradebook",
        course_id: input.course_id,
        base_risk: "R3",
        summary: `${undoOf ? "Deshacer: " : ""}Nota del participante ${input.participant_id} en «${it.name}»: ${Object.entries(want).map(([k, v]) => `${k}=${typeof v === "string" ? `«${v.slice(0, 40)}»` : v}`).join(", ")}. Sin notificar.`,
        payload_preview: { item: { item_id: it.id, name: it.name }, participant_id: input.participant_id, before: prior, after: { ...prior, ...want }, scale: g.options.length ? g.options : undefined },
        side_effects: ["Cambia la nota del participante en el libro (y los totales). Una nota sobrescrita ya no se actualiza desde la actividad hasta quitar la sobrescritura.", "Sin notificaciones."],
        preconditions: { description: "La nota no cambió desde el plan.", versions: { [`gbgrade:${input.course_id}:${it.id}:${input.participant_id}`]: JSON.stringify(prior) } },
        undo: { kind: "compensación", how: "Volver a la nota, la sobrescritura, las marcas y la retroalimentación anteriores.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [{ item_id: "i1", description: `Nota del participante ${input.participant_id} en el ítem ${it.id}`, call: { kind: "form", fn: "grade_grade_edit", params: { query: { courseid: String(input.course_id), itemid: String(it.id), userid: String(input.participant_id) }, fields } }, target: { course_id: input.course_id, item_id: it.id, user_id: input.participant_id }, expected: { op: "grade", want, prior } }],
        prior_state: { overridden: g.overridden, finalgrade: g.finalgrade, excluded: g.excluded, hidden: g.hidden, locked: g.locked, feedback_html: g.feedback },
        untrusted_fields: ["payload_preview.item.name", "payload_preview.before"],
        teacher_text: input.feedback ? { feedback: input.feedback } : {},
        undo_of: undoOf,
    };
}

const gradeShape = {
    course_id: z.number().int().positive(),
    item_id: z.number().int().positive().describe("Ítem de calificación."),
    participant_id: z.number().int().positive(),
    grade: z.union([z.number(), z.string().max(255), z.null()]).optional().describe("Nota que SOBRESCRIBE la del ítem (número, o el ítem de la escala); null = quitar la sobrescritura (vuelve la de la actividad)."),
    excluded: z.boolean().optional().describe("Excluir la nota de los totales."),
    hidden: z.boolean().optional().describe("Ocultar la nota al participante."),
    locked: z.boolean().optional().describe("Bloquear la nota."),
    feedback: z.string().max(10_000).optional().describe("Retroalimentación del libro (Markdown)."),
};

export const gradebookGradeIntent: WriteIntent<typeof gradeShape> = {
    name: "gradebook_grade",
    title: "Plan: sobrescribir, excluir, ocultar o bloquear una nota del libro",
    description: "Arma el plan para cambiar la nota de UN participante en un ítem del libro de calificaciones: sobrescribirla (o quitar la sobrescritura), excluirla, ocultarla, bloquearla o su retroalimentación. Sin notificaciones. No escribe.",
    inputShape: gradeShape,
    capability: "manage_gradebook",
    synthetic_only: false,
    ...common,
    plan: (input, ctx) => buildGrade(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some(applied)) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const t = plan.items[0]!.target;
        return { kind: "plan", draft: await buildGrade({ course_id: plan.course_id, item_id: Number(t.item_id), participant_id: Number(t.user_id), restore: plan.prior_state as GradeReq["restore"] }, ctx, result.action_id) };
    },
};

export const GRADEBOOK_INTENTS = [gradeItemIntent, gradebookGradeIntent];
