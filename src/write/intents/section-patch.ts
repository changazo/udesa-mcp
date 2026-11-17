import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { htmlSignature, patchTableCell, structureDifferences, type CellPatchResult } from "../html-patch.js";
import { textHash } from "../text.js";
import { parseFormFields } from "../web.js";
import { stableHtml } from "./modform.js";

/**
 * ADR-136 · Edición puntual del resumen de una sección: cambia el texto de UNA celda de una tabla existente
 * sin reconstruir el HTML. El agente no manda HTML: el servidor lee el resumen tal como está guardado (el
 * formulario `/course/editsection.php`, no la salida filtrada de core_course_get_contents), cambia sólo ese
 * nodo de texto (html-patch.ts) y lo reenvía con formato HTML.
 * - Precondición: hash del HTML guardado (cualquier cambio de atributos, enlaces o imágenes invalida el plan).
 * - Verificación: firma estructural del HTML releído contra la esperada; perder una tabla, un atributo o el
 *   texto de otra celda nunca es `aplicado_verificado`.
 * - Deshacer: el HTML anterior completo, con la misma verificación.
 */

const SectionsSchema = z.array(z.object({ id: z.number().int(), section: z.number().nullable().optional(), name: z.string().nullable().optional() }));
const QF = "_qf__editsection_form";

async function sectionOf(ctx: IntentContext, courseId: number, number: number) {
    const s = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, SectionsSchema)).find((x) => x.section === number);
    if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${number} no existe en el curso ${courseId}.`);
    return { id: s.id, number, name: s.name ?? "" };
}

/** El resumen guardado, con las URLs de borrador normalizadas (cambian en cada apertura del formulario). */
async function storedSummary(ctx: IntentContext, sectionId: number): Promise<string> {
    const f = parseFormFields(await ctx.web.readPage("editsection_form", { id: String(sectionId) }), QF);
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `No se reconoció el formulario de la sección ${sectionId}.`);
    const get = (n: string) => f.find(([k]) => k === n)?.[1];
    const format = get("summary_editor[format]");
    if (format !== undefined && format !== "1") throw new CampusError("WRITE_NOT_ALLOWED", `El resumen de la sección está guardado en otro formato (${format}), no HTML: no se edita en el lugar.`);
    return stableHtml(get("summary_editor[text]") ?? "");
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, , id] = k.split(":");
        out[k] = kind === "sechtml" ? textHash(await storedSummary(ctx, Number(id))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { html: string; prior_html: string };
    const now = await storedSummary(ctx, Number(item.target.section_id));
    const sig = JSON.stringify(htmlSignature(now));
    if (sig === JSON.stringify(htmlSignature(x.html))) return { outcome: "coincide", checked: ["html_estructura", "atributos", "textos"], differences: [] };
    const unchanged = sig === JSON.stringify(htmlSignature(x.prior_html));
    return { outcome: unchanged ? "sin_efecto" : "difiere", checked: ["html_estructura", "atributos", "textos"], differences: unchanged ? [{ field: "html", expected: "celda cambiada", observed: "resumen sin cambios" }] : structureDifferences(x.html, now) };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

function draft(courseId: number, s: { id: number; number: number; name: string }, before: string, after: string, change: CellPatchResult | null, undoOf: string | null): PlanDraft {
    return {
        intent: "patch_section_summary",
        capability: "rename_content",
        course_id: courseId,
        base_risk: "R2",
        summary: change
            ? `Cambiar UNA celda del resumen de la sección ${s.number} «${s.name}»: ${change.column} «${change.before}» → «${change.after}».`
            : `Deshacer: volver al resumen anterior de la sección ${s.number} «${s.name}» (HTML completo).`,
        payload_preview: change
            ? {
                  section: { id: s.id, number: s.number, name: s.name },
                  table: change.table,
                  row: change.row,
                  column: change.column,
                  before: change.before,
                  after: change.after,
                  diff: { offset: change.offset, before_fragment: change.before_fragment, after_fragment: change.after_fragment },
                  rest: "El resto del resumen (otras celdas, filas, tablas, enlaces, imágenes, estilos y atributos) se conserva byte a byte; se comprobó antes de enviar.",
              }
            : { section: { id: s.id, number: s.number, name: s.name }, restore_html: after },
        side_effects: ["Cambia el texto que los estudiantes ven al principio de la sección. Sin notificaciones."],
        preconditions: { description: "El HTML guardado del resumen no cambió desde el plan (también atributos, enlaces e imágenes).", versions: { [`sechtml:${courseId}:${s.id}`]: textHash(before) } },
        undo: { kind: "compensación", how: "Volver al HTML anterior completo.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [
            {
                item_id: "i1",
                description: change ? `Celda ${change.column} de la fila ${change.row.index} (tabla ${change.table.index}) de la sección ${s.number}` : `Resumen anterior de la sección ${s.number}`,
                call: { kind: "form", fn: "course_section_edit", params: { query: { id: String(s.id) }, fields: { "summary_editor[text]": after, "summary_editor[format]": "1" } } },
                target: { course_id: courseId, section_id: s.id, section_number: s.number },
                expected: { html: after, prior_html: before },
            },
        ],
        prior_state: { summary_html: before },
        untrusted_fields: ["payload_preview.section.name", "payload_preview.table", "payload_preview.row", "payload_preview.diff", "payload_preview.restore_html"],
        teacher_text: change ? { replacement_text: change.after } : {},
        undo_of: undoOf,
    };
}

const cellText = z.string().min(1).max(500);
const shape = {
    course_id: z.number().int().positive(),
    section_number: z.number().int().min(0).max(200).describe("Número de la sección (0 = General)."),
    table_match: z.object({ headers_contain: z.array(cellText).min(1).max(10).describe("Textos de encabezado que tiene la tabla (pueden estar en <td>).") }),
    row_match: z.record(cellText, cellText).describe("Columna → texto exacto de la celda en la fila buscada (todas tienen que cumplirse; una sola fila)."),
    column: cellText.describe("Encabezado de la columna cuya celda cambia."),
    expected_text: cellText.describe("Texto actual exacto de esa celda (protege contra editar otra)."),
    replacement_text: z.string().min(1).max(500).describe("Texto nuevo, como texto plano (se escapa; no admite HTML ni saltos de línea)."),
};

export const patchSectionSummaryIntent: WriteIntent<typeof shape> = {
    name: "patch_section_summary",
    title: "Plan: cambiar UNA celda de una tabla en el resumen de una sección (sin tocar el resto)",
    description:
        "Arma el plan para cambiar el texto de UNA celda de una tabla que ya está en el resumen de una sección, conservando byte a byte el resto (otras celdas, enlaces, imágenes, estilos). La tabla se ubica por sus encabezados, la fila por los textos de otras columnas y la columna por su encabezado; expected_text tiene que coincidir con el texto actual. Rechaza ante cualquier ambigüedad. Para reemplazar el resumen completo, campus_plan_section_summary. No escribe.",
    inputShape: shape,
    capability: "rename_content",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const s = await sectionOf(ctx, input.course_id, input.section_number);
        const before = await storedSummary(ctx, s.id);
        const change = patchTableCell(before, { headers_contain: input.table_match.headers_contain, row_match: input.row_match, column: input.column, expected_text: input.expected_text, replacement_text: input.replacement_text });
        return draft(input.course_id, s, before, change.html, change, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const t = plan.items[0]!.target;
        const s = await sectionOf(ctx, plan.course_id, Number(t.section_number));
        if (s.id !== Number(t.section_id)) return { kind: "ninguno", reason: "La sección cambió de número (se agregaron o borraron secciones)." };
        return { kind: "plan", draft: draft(plan.course_id, s, await storedSummary(ctx, s.id), (plan.prior_state as { summary_html: string }).summary_html, null, result.action_id) };
    },
};
