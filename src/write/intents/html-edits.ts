import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { addRow, checkLinkUrl, deleteRow, insertFragment, patchCells, replaceLinks } from "../html-ops.js";
import { ComponentSchema, renderComponent } from "../components.js";
import { htmlSignature, structureDifferences } from "../html-patch.js";
import { readStored, resolveTarget, submitFields, TargetSchema, type ResolvedTarget, type TargetRef } from "../html-targets.js";
import { textHash } from "../text.js";

/**
 * ADR-137 · Ediciones en el lugar de textos enriquecidos guardados (resúmenes de sección, etiquetas, páginas,
 * descripciones y capítulos de libro), con la mecánica de ADR-136: el servidor lee el HTML tal como está
 * guardado, cambia sólo lo pedido (html-ops.ts) y verifica la estructura completa al releer.
 * - Precondición: hash del HTML guardado de cada texto tocado.
 * - Verificación: firma estructural del HTML releído; además, para lo que tiene que VERSE (componentes,
 *   ADR-138), que la salida que reciben los estudiantes conserve lo pedido.
 * - Deshacer: el HTML anterior completo de cada texto.
 */

/** Lo que tiene que aparecer en la salida que ven los estudiantes (Moodle puede filtrar al mostrar). */
export interface DisplayRequirement {
    tag: string;
    class?: string;
    attr?: string;
    min: number;
    label: string;
}

export interface HtmlEntry {
    t: ResolvedTarget;
    before: string;
    after: string;
    description: string;
    display?: DisplayRequirement[];
}

function displayMissing(html: string, reqs: DisplayRequirement[]): string[] {
    return reqs.filter((r) => countMatches(html, r) < r.min).map((r) => r.label);
}

function countMatches(html: string, r: DisplayRequirement): number {
    const tags = [...html.matchAll(new RegExp(`<${r.tag}\\b([^>]*)>`, "gi"))].map((m) => m[1] ?? "");
    return tags.filter((a) => (!r.class || new RegExp(`class="[^"]*\\b${r.class.replace(/[-]/g, "\\-")}\\b`).test(a)) && (!r.attr || new RegExp(`\\b${r.attr}=`).test(a))).length;
}

export function htmlDraft(o: { intent: string; courseId: number; summary: string; preview: Record<string, unknown>; entries: HtmlEntry[]; warnings?: string[]; teacherText?: Record<string, string>; undoOf: string | null; risk?: "R2" | "R3"; sideEffects?: string[] }): PlanDraft {
    const caps = [...new Set(o.entries.map((e) => e.t.capability))];
    return {
        intent: o.intent,
        capability: caps.length === 1 ? caps[0]! : "edit_activity",
        course_id: o.courseId,
        base_risk: o.risk ?? "R2",
        summary: o.summary,
        payload_preview: o.preview,
        side_effects: [...(o.sideEffects ?? []), "Cambia lo que ven los estudiantes en esos textos. El resto de cada texto y de cada formulario se reenvía tal cual. Sin notificaciones."],
        preconditions: { description: "El HTML guardado de cada texto no cambió desde el plan (también atributos, enlaces e imágenes).", versions: Object.fromEntries(o.entries.map((e) => [e.t.key, textHash(e.before)])) },
        undo: { kind: "compensación", how: "Volver al HTML anterior completo de cada texto.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus. Abrir cada formulario copia sus imágenes a tu borrador privado.", ...(o.warnings ?? [])],
        items: o.entries.map((e, i) => ({
            item_id: `i${i + 1}`,
            description: e.description,
            call: { kind: "form", fn: e.t.submit.fn, params: { query: e.t.submit.query, fields: submitFields(e.t, e.after) } },
            target: { course_id: o.courseId, html_target: e.t.ref as unknown as string },
            expected: { html: e.after, prior_html: e.before, ...(e.display?.length ? { display: e.display } : {}) },
        })),
        prior_state: { entries: o.entries.map((e) => ({ ref: e.t.ref, html: e.before })) },
        untrusted_fields: ["payload_preview"],
        teacher_text: o.teacherText ?? {},
        undo_of: o.undoOf,
    };
}

const refOf = (item: PlanItem) => item.target.html_target as unknown as TargetRef;

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string> = {};
    for (const item of plan.items) {
        const t = await resolveTarget(ctx, plan.course_id, refOf(item));
        out[t.key] = textHash(await readStored(ctx, t));
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { html: string; prior_html: string; display?: DisplayRequirement[] };
    const t = await resolveTarget(ctx, plan.course_id, refOf(item));
    const now = await readStored(ctx, t);
    const checked = ["html_estructura", "atributos", "textos"];
    const sig = JSON.stringify(htmlSignature(now));
    if (sig !== JSON.stringify(htmlSignature(x.html))) {
        const unchanged = sig === JSON.stringify(htmlSignature(x.prior_html));
        return { outcome: unchanged ? "sin_efecto" : "difiere", checked, differences: unchanged ? [{ field: "html", expected: "texto cambiado", observed: "sin cambios" }] : structureDifferences(x.html, now) };
    }
    // Guardado tal cual; además, que Moodle lo MUESTRE (puede quitar clases o elementos al mostrar).
    if (x.display?.length && t.display) {
        const missing = displayMissing(await t.display(ctx), x.display);
        checked.push("vista_estudiantes");
        if (missing.length) return { outcome: "difiere", checked, differences: missing.map((m): Difference => ({ field: "vista_estudiantes", expected: m, observed: "Moodle no lo muestra (lo quita al mostrar)" })) };
    }
    return { outcome: "coincide", checked, differences: [] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

/** Deshacer común: el HTML anterior completo de cada texto que se tocó. */
async function undoHtml(intent: string, plan: Plan, result: { items: { item_id: string; outcome: string }[]; action_id: string }, ctx: IntentContext) {
    const touched = new Set(result.items.filter((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido").map((r) => r.item_id));
    if (!touched.size) return { kind: "ninguno" as const, reason: "La acción no aplicó cambios." };
    const prior = (plan.prior_state as { entries: { ref: TargetRef; html: string }[] }).entries;
    const entries: HtmlEntry[] = [];
    for (const [i, p] of prior.entries()) {
        if (!touched.has(`i${i + 1}`)) continue;
        const t = await resolveTarget(ctx, plan.course_id, p.ref);
        entries.push({ t, before: await readStored(ctx, t), after: p.html, description: `Volver al ${t.label} anterior` });
    }
    return { kind: "plan" as const, draft: htmlDraft({ intent, courseId: plan.course_id, summary: `Deshacer: volver al HTML anterior de ${entries.length} texto(s).`, preview: { restore: entries.map((e) => ({ target: e.t.label, html: e.after })) }, entries, undoOf: result.action_id }) };
}

export const htmlEditCommon = { readVersions, interpret, verify, reconcile };
export { undoHtml };

// ---------- tablas ----------

const text = z.string().min(1).max(500);
const rowMatch = z.record(text, text).describe("Columna → texto exacto de la celda (todas tienen que cumplirse; una sola fila).");
const tableShape = {
    course_id: z.number().int().positive(),
    target: TargetSchema,
    table_match: z.object({ headers_contain: z.array(text).min(1).max(10).describe("Encabezados que tiene la tabla (pueden estar en <td>).") }),
    set_cells: z.array(z.object({ row_match: rowMatch, column: text, expected_text: text, replacement_text: text })).min(1).max(20).optional().describe("Cambiar el texto de una o más celdas (cada una con su texto actual exacto)."),
    add_row: z.object({ values: z.record(text, z.string().max(500)).describe("Columna → texto de la fila nueva (las que faltan quedan vacías)."), after_row_match: rowMatch.optional().describe("Fila después de la cual se agrega y cuyo formato se copia (por defecto, la última).") }).optional(),
    delete_row: z.object({ row_match: rowMatch }).optional().describe("Quitar UNA fila de datos."),
};

export const patchTableIntent: WriteIntent<typeof tableShape> = {
    name: "patch_table",
    title: "Plan: editar una tabla existente en un texto (celdas, agregar o quitar una fila) sin tocar el resto",
    description:
        "Arma el plan para editar una tabla que ya está en un resumen de sección, una etiqueta, una página, una descripción o un capítulo de libro: cambiar celdas (set_cells), agregar una fila copiando el formato de otra (add_row) o quitar una fila (delete_row); una sola de las tres. La tabla se ubica por sus encabezados y las filas por los textos de sus celdas. Todo lo demás del texto queda byte a byte. Rechaza ante cualquier ambigüedad. No escribe.",
    inputShape: tableShape,
    capability: "edit_activity",
    synthetic_only: false,
    ...htmlEditCommon,
    async plan(input, ctx) {
        const ops = [input.set_cells, input.add_row, input.delete_row].filter((x) => x !== undefined);
        if (ops.length !== 1) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá exactamente una operación: set_cells, add_row o delete_row.");
        const t = await resolveTarget(ctx, input.course_id, input.target);
        const before = await readStored(ctx, t);
        const headers = input.table_match.headers_contain;
        let after: string;
        let preview: Record<string, unknown>;
        let summary: string;
        if (input.set_cells) {
            const r = patchCells(before, headers, input.set_cells);
            after = r.html;
            preview = { target: t.label, table: r.table, changes: r.changes };
            summary = `Cambiar ${r.changes.length} celda(s) de una tabla del ${t.label}: ${r.changes.map((c) => `${c.column} «${c.before}» → «${c.after}»`).join("; ")}.`;
        } else if (input.add_row) {
            const r = addRow(before, headers, input.add_row.values, input.add_row.after_row_match);
            after = r.html;
            preview = { target: t.label, table: r.table, template_row: r.template_row, new_row: r.new_row, inserted_html: r.after_fragment };
            summary = `Agregar una fila a una tabla del ${t.label} (formato de la fila ${r.template_row.index}): ${Object.entries(r.new_row).filter(([, v]) => v).map(([k, v]) => `${k}=«${v}»`).join(", ")}.`;
        } else {
            const r = deleteRow(before, headers, input.delete_row!.row_match);
            after = r.html;
            preview = { target: t.label, table: r.table, deleted_row: r.deleted_row, removed_html: r.before_fragment };
            summary = `Quitar la fila ${r.deleted_row.index} (${r.deleted_row.cells.join(" | ")}) de una tabla del ${t.label}.`;
        }
        preview.rest = "El resto del texto (otras celdas, filas, tablas, enlaces, imágenes, estilos y atributos) se conserva byte a byte; se comprobó antes de enviar.";
        return htmlDraft({ intent: "patch_table", courseId: input.course_id, summary, preview, entries: [{ t, before, after, description: `Tabla del ${t.label}` }], undoOf: null });
    },
    async undo(plan, result, ctx) {
        return undoHtml("patch_table", plan, result, ctx);
    },
};

// ---------- enlaces ----------

const ContentsSchema = z.array(
    z.object({
        section: z.number().nullable().optional(),
        summary: z.string().nullable().optional(),
        modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional(), description: z.string().nullable().optional() })).default([]),
    }),
);
const PagesSchema = z.object({ pages: z.array(z.object({ coursemodule: z.number().int(), content: z.string().nullable().optional() })).default([]) });

const linkShape = {
    course_id: z.number().int().positive(),
    old_url: z.string().min(8).max(1900).describe("Dirección actual EXACTA de los enlaces."),
    new_url: z.string().min(8).max(1900).describe("Dirección nueva (http(s) o mailto)."),
    section_number: z.number().int().min(0).max(200).optional().describe("Limitar a una sección (su resumen y sus actividades)."),
};

export const replaceLinkIntent: WriteIntent<typeof linkShape> = {
    name: "replace_link",
    title: "Plan: cambiar la dirección de un enlace en todo el curso (resúmenes, etiquetas, páginas, descripciones)",
    description:
        "Arma el plan para cambiar el destino de los enlaces que apuntan EXACTAMENTE a old_url (p. ej. un link de Meet o de Drive que cambió) en los resúmenes de sección, etiquetas, contenido de páginas y descripciones del curso (o de una sección). Cambia sólo el atributo href (y el texto, si el texto visible era la propia dirección); el resto de cada texto queda byte a byte. Lista cada aparición y avisa las menciones de la dirección como texto suelto, que no cambia. Los capítulos de libros no se recorren. No escribe.",
    inputShape: linkShape,
    capability: "edit_activity",
    synthetic_only: false,
    ...htmlEditCommon,
    async plan(input, ctx) {
        const oldUrl = input.old_url.trim();
        const newUrl = checkLinkUrl(input.new_url);
        if (oldUrl === newUrl) throw new CampusError("WRITE_NOT_ALLOWED", "La dirección nueva es igual a la actual.");
        // Candidatos baratos por los servicios (la dirección puede venir con & escapado); después, el texto guardado.
        const has = (html: string | null | undefined) => !!html && (html.includes(oldUrl) || html.includes(oldUrl.replace(/&/g, "&amp;")));
        const sections = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: input.course_id }, ContentsSchema)).filter((s) => input.section_number === undefined || s.section === input.section_number);
        if (input.section_number !== undefined && !sections.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.section_number} no existe.`);
        const pages = (await ctx.read.session.transport.call("mod_page_get_pages_by_courses", { courseids: [input.course_id] }, PagesSchema)).pages;
        const refs: TargetRef[] = [];
        for (const s of sections) {
            if (has(s.summary)) refs.push({ kind: "section_summary", section_number: s.section ?? 0 });
            for (const m of s.modules) {
                if (has(m.description)) refs.push({ kind: m.modname === "label" ? "label" : "description", course_module_id: m.id });
                if (m.modname === "page" && has(pages.find((p) => p.coursemodule === m.id)?.content)) refs.push({ kind: "page_content", course_module_id: m.id });
            }
        }
        const entries: HtmlEntry[] = [];
        const found: Record<string, unknown>[] = [];
        let mentions = 0;
        for (const ref of refs) {
            const t = await resolveTarget(ctx, input.course_id, ref).catch((e: unknown) => (e instanceof CampusError && e.code === "WRITE_NOT_ALLOWED" ? null : Promise.reject(e)));
            if (!t) continue;
            const before = await readStored(ctx, t);
            const r = replaceLinks(before, oldUrl, newUrl);
            mentions += r.plain_text_mentions;
            if (!r.hits.length) continue;
            entries.push({ t, before, after: r.html, description: `${r.hits.length} enlace(s) en el ${t.label}` });
            found.push({ target: t.label, links: r.hits.map((h) => ({ text: h.text, text_replaced: h.text_replaced })) });
        }
        if (!entries.length) throw new CampusError("WRITE_NOT_ALLOWED", `No hay enlaces que apunten exactamente a esa dirección${input.section_number !== undefined ? ` en la sección ${input.section_number}` : " en el curso"}${mentions ? ` (aparece ${mentions} vez/veces como texto suelto, que no se cambia)` : ""}.`);
        const total = found.reduce((n, f) => n + (f.links as unknown[]).length, 0);
        return htmlDraft({
            intent: "replace_link",
            courseId: input.course_id,
            summary: `Cambiar ${total} enlace(s) en ${entries.length} texto(s): ${oldUrl} → ${newUrl}.`,
            preview: { old_url: oldUrl, new_url: newUrl, found, rest: "Sólo cambia el href (y el texto, si era la propia dirección); el resto de cada texto se conserva byte a byte." },
            entries,
            warnings: [...(mentions ? [`La dirección aparece ${mentions} vez/veces como texto suelto (no como enlace): eso no se cambia.`] : []), "Los capítulos de libros no se recorren: si el enlace está en un libro, cambialo con campus_plan_patch_table o a mano."],
            teacherText: { new_url: newUrl },
            undoOf: null,
        });
    },
    async undo(plan, result, ctx) {
        return undoHtml("replace_link", plan, result, ctx);
    },
};

// ---------- componentes (ADR-138) ----------

const componentShape = {
    course_id: z.number().int().positive(),
    target: TargetSchema,
    position: z.enum(["end", "start"]).default("end").describe("Dónde agregarlo: al final (por defecto) o al principio del texto."),
    block: ComponentSchema.describe("El componente: su tipo (type) y sus textos."),
};

export const insertComponentIntent: WriteIntent<typeof componentShape> = {
    name: "insert_component",
    title: "Plan: agregar un componente visual (aviso, tarjeta, botón, desplegable, columnas, tabla, video) a un texto",
    description:
        "Arma el plan para agregar al principio o al final de un resumen de sección, una etiqueta, una página, una descripción o un capítulo de libro un componente con esquema cerrado: alert (recuadro de aviso: info, warning, success, danger), card (tarjeta con botón opcional), button (botón-enlace), details (desplegable), columns (dos columnas), table (tabla con encabezados) o video (YouTube). Los textos van en Markdown; el servidor arma el HTML con las clases del tema. El resto del texto queda byte a byte. La verificación comprueba también que el Campus MUESTRE el componente. No escribe.",
    inputShape: componentShape,
    capability: "edit_activity",
    synthetic_only: false,
    ...htmlEditCommon,
    async plan(input, ctx) {
        const t = await resolveTarget(ctx, input.course_id, input.target);
        const before = await readStored(ctx, t);
        // Los valores por defecto del esquema (variante, posición) también cuando se llama sin pasar por el MCP.
        const position = input.position ?? "end";
        const c = renderComponent(ComponentSchema.parse(input.block));
        const after = insertFragment(before, c.html, position);
        return htmlDraft({
            intent: "insert_component",
            courseId: input.course_id,
            summary: `Agregar ${c.label} ${position === "end" ? "al final" : "al principio"} del ${t.label}.`,
            preview: { target: t.label, position, block: input.block, block_html: c.html, must_display: c.display.map((d) => d.label), rest: "El resto del texto se conserva byte a byte." },
            entries: [{ t, before, after, description: `${c.label} en el ${t.label}`, display: c.display }],
            teacherText: { block: JSON.stringify(input.block).slice(0, 5_000) },
            undoOf: null,
        });
    },
    async undo(plan, result, ctx) {
        return undoHtml("insert_component", plan, result, ctx);
    },
};

export const HTML_EDIT_INTENTS = [patchTableIntent, replaceLinkIntent, insertComponentIntent];
