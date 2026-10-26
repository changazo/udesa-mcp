import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import { CampusError } from "../../errors.js";
import { parseQuestionXml } from "../../domain/question-xml.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { describeLocalFiles } from "../files.js";

/**
 * W6 · Importar preguntas (directiva §8.10; investigación [C] §6.2, ADR-059).
 * - Formulario `/question/bank/importquestions/import.php` del banco de un cuestionario o de un módulo
 *   «Banco de preguntas» del curso. El archivo (GIFT o Moodle XML) lo indicó el humano con una ruta
 *   local; se sube al borrador al ejecutar y entra como `newfile`.
 * - Moodle NO deduplica: el plan compara los nombres del archivo con el inventario de la categoría y
 *   rechaza los repetidos. `catfromfile` y `contextfromfile` quedan en 0 (no crea categorías).
 * - Éxito: la página con el botón «Continuar» a /question/edit.php (HTTP 200, sin redirección).
 * - Verificación: inventario de la categoría antes y después (candidatos de selección aleatoria: las
 *   preguntas de tipo «descripción» no aparecen ahí).
 * - Deshacer: borrar las preguntas nuevas (delete.php confirmado con md5 de la lista).
 */

const MAX_QUESTIONS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FORMATS = { gift: [".txt", ".gift"], xml: [".xml"] } as const;
type Format = keyof typeof FORMATS;

const ModulesSchema = z.array(z.object({ section: z.number().nullable().optional(), modules: z.array(z.object({ id: z.number().int().positive(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));

export async function bankModule(ctx: IntentContext, courseId: number, cmid: number) {
    const mods = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ModulesSchema)).flatMap((s) => s.modules);
    const m = mods.find((x) => x.id === cmid);
    if (!m || (m.modname !== "quiz" && m.modname !== "qbank")) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El módulo ${cmid} no es un cuestionario ni un banco de preguntas del curso ${courseId}.`);
    return m;
}

/** Categorías que ofrece el formulario de importación: value «catid,contextid», texto y la elegida por defecto. */
export function parseImportCategories(html: string): { categories: { category_id: number; context_id: number; label: string }[]; selected: string | null } {
    const sel = /<select[^>]*name="category"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    if (!sel) return { categories: [], selected: null };
    const categories: { category_id: number; context_id: number; label: string }[] = [];
    let selected: string | null = null;
    for (const m of sel[1]!.matchAll(/<option([^>]*)value="(\d+),(\d+)"([^>]*)>([\s\S]*?)<\/option>/g)) {
        categories.push({ category_id: Number(m[2]), context_id: Number(m[3]), label: m[5]!.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() });
        if (/\bselected\b/.test(m[1]! + m[4]!)) selected = `${m[2]},${m[3]}`;
    }
    return { categories, selected: selected ?? (categories[0] ? `${categories[0].category_id},${categories[0].context_id}` : null) };
}

/** Nombres de las preguntas del archivo. GIFT: cada pregunta tiene que traer «::nombre::». */
export function questionNames(content: string, format: Format): string[] {
    if (format === "xml") return parseQuestionXml(content).questions.map((q) => (q.question.name ?? "").trim());
    const blocks = content
        .replace(/^﻿/, "")
        .split(/\r?\n\s*\r?\n/)
        .map((b) => b.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l) && !/^\s*\$CATEGORY:/.test(l)).join("\n").trim())
        .filter(Boolean);
    return blocks.map((b, i) => {
        const m = /^::((?:\\:|[^:])+)::/.exec(b);
        if (!m) throw new CampusError("WRITE_NOT_ALLOWED", `La pregunta GIFT n.º ${i + 1} no tiene nombre (::nombre::): hace falta para no duplicar preguntas.`);
        return m[1]!.replace(/\\(.)/g, "$1").trim();
    });
}

export async function inventory(ctx: IntentContext, categoryId: number, contextId: number): Promise<{ id: number; name: string }[]> {
    const web = ctx.read.web;
    if (!web) throw new CampusError("AUTH_REQUIRED", "Esta operación necesita la sesión web del Campus.");
    const op = await web.open();
    try {
        const out: { id: number; name: string }[] = [];
        for (let offset = 0; offset < 5000; offset += 200) {
            const res = await op.ajax<{ totalcount?: unknown; questions?: unknown }>("core_question_get_random_question_summaries", { categoryid: categoryId, includesubcategories: false, tagids: [], contextid: contextId, limit: 200, offset });
            if (!res || typeof res.totalcount !== "number" || !Array.isArray(res.questions)) throw new CampusError("UNEXPECTED_RESPONSE", "El inventario de la categoría no tiene el formato esperado.");
            for (const q of res.questions as { id?: unknown; name?: unknown }[]) out.push({ id: Number(q.id), name: typeof q.name === "string" ? q.name.trim() : "" });
            if (offset + 200 >= res.totalcount || !(res.questions as unknown[]).length) return out;
        }
        throw new CampusError("INCOMPLETE_RESULT", "La categoría tiene demasiadas preguntas para inventariarla.");
    } finally {
        await web.afterOperation(op);
    }
}

// ---------- versiones, interpretación y verificación ----------

/** `qinv:<categoría>:<contexto>` = cantidad de preguntas · `qids:<categoría>:<contexto>:<ids>` = cuántas de esas siguen. */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, cat, ctxId, ids] = k.split(":");
        const inv = await inventory(ctx, Number(cat), Number(ctxId));
        if (kind === "qinv") out[k] = inv.length;
        else if (kind === "qids") {
            const want = new Set((ids ?? "").split(",").map(Number));
            out[k] = inv.filter((q) => want.has(q.id)).length;
        } else out[k] = null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected;
    const t = item.target;
    const inv = await inventory(ctx, Number(t.category_id), Number(t.context_id));
    if (item.call.fn === "question_import") {
        const prior = new Set(x.prior_ids as number[]);
        const names = new Set(x.names as string[]);
        const added = inv.filter((q) => !prior.has(q.id));
        const matching = added.filter((q) => names.has(q.name));
        if (!added.length) return { outcome: "sin_efecto", checked: ["preguntas"], differences: [{ field: "preguntas nuevas", expected: names.size, observed: 0 }] };
        const differences = [
            ...(matching.length === (x.count as number) ? [] : [{ field: "preguntas nuevas con los nombres del archivo", expected: x.count, observed: matching.length }]),
            ...(added.length === matching.length ? [] : [{ field: "otras preguntas nuevas", expected: 0, observed: added.length - matching.length }]),
        ];
        return { outcome: differences.length ? "difiere" : "coincide", checked: ["cantidad", "nombres"], differences, moodle_ids: { questions: matching.length, category_id: Number(t.category_id) } };
    }
    // Borrado (deshacer).
    const ids = new Set(x.question_ids as number[]);
    const still = inv.filter((q) => ids.has(q.id)).length;
    if (!still) return { outcome: "coincide", checked: ["preguntas"], differences: [] };
    return { outcome: still === ids.size ? "sin_efecto" : "difiere", checked: ["preguntas"], differences: [{ field: "preguntas que siguen", expected: 0, observed: still }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

// ---------- importar ----------

const importShape = {
    course_id: z.number().int().positive(),
    bank_course_module_id: z.number().int().positive().describe("cmid del cuestionario (su banco propio) o de un «Banco de preguntas» del curso."),
    file_path: z.string().min(1).max(1000).describe("Ruta ABSOLUTA del archivo GIFT (.txt/.gift) o Moodle XML (.xml) que indicó el humano. En GIFT, cada pregunta con ::nombre::."),
    category_id: z.number().int().positive().optional().describe("Categoría de destino del banco; por defecto, la que propone el formulario."),
};

export const questionImportIntent: WriteIntent<typeof importShape> = {
    name: "question_import",
    title: "Plan: importar preguntas a un banco",
    description:
        "Arma el plan para importar preguntas (GIFT o Moodle XML, desde un archivo local indicado por el humano) a una categoría del banco de un cuestionario o de un banco del curso. Rechaza nombres que ya están en la categoría (Moodle no deduplica) y no crea categorías. No escribe ni agrega las preguntas a ningún cuestionario.",
    inputShape: importShape,
    capability: "import_questions",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const bank = await bankModule(ctx, input.course_id, input.bank_course_module_id);
        const ext = extname(input.file_path).toLowerCase();
        const format = (Object.keys(FORMATS) as Format[]).find((f) => (FORMATS[f] as readonly string[]).includes(ext));
        if (!format) throw new CampusError("WRITE_NOT_ALLOWED", "Formato no admitido: usá GIFT (.txt o .gift) o Moodle XML (.xml).");
        const [file] = describeLocalFiles([input.file_path], MAX_FILE_BYTES, 1);
        const content = readFileSync(file!.path, "utf8");
        if (createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex") !== file!.sha256) throw new CampusError("WRITE_NOT_ALLOWED", "El archivo tiene que estar en UTF-8.");
        let names: string[];
        try {
            names = questionNames(content, format);
        } catch (e) {
            if (e instanceof CampusError && e.code === "WRITE_NOT_ALLOWED") throw e;
            throw new CampusError("WRITE_NOT_ALLOWED", `No se pudo leer el archivo como ${format.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!names.length) throw new CampusError("WRITE_NOT_ALLOWED", "El archivo no tiene preguntas.");
        if (names.length > MAX_QUESTIONS) throw new CampusError("WRITE_NOT_ALLOWED", `Como máximo ${MAX_QUESTIONS} preguntas por importación.`);
        if (names.some((n) => !n)) throw new CampusError("WRITE_NOT_ALLOWED", "Hay preguntas sin nombre: hace falta para no duplicar.");
        const dupInFile = names.filter((n, i) => names.indexOf(n) !== i);
        if (dupInFile.length) throw new CampusError("WRITE_NOT_ALLOWED", `Nombres repetidos dentro del archivo: ${[...new Set(dupInFile)].join(", ")}.`);

        const { categories, selected } = parseImportCategories(await ctx.web.readPage("question_import_form", { cmid: String(bank.id) }));
        if (!categories.length || !selected) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconocieron las categorías del formulario de importación.");
        const cat = input.category_id ? categories.find((c) => c.category_id === input.category_id) : categories.find((c) => `${c.category_id},${c.context_id}` === selected);
        if (!cat) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La categoría ${input.category_id} no es una categoría de ese banco.`, { details: { categories: categories.map((c) => ({ category_id: c.category_id, label: c.label })) } });
        const inv = await inventory(ctx, cat.category_id, cat.context_id);
        const existing = new Set(inv.map((q) => q.name));
        const clash = names.filter((n) => existing.has(n));
        if (clash.length) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay preguntas con estos nombres en la categoría (Moodle las duplicaría): ${clash.slice(0, 20).join(", ")}${clash.length > 20 ? "…" : ""}.`);

        return {
            intent: "question_import",
            capability: "import_questions",
            course_id: input.course_id,
            base_risk: "R1",
            summary: `Importar ${names.length} pregunta(s) ${format.toUpperCase()} de «${file!.filename}» a la categoría «${cat.label}» del ${bank.modname === "quiz" ? "banco del cuestionario" : "banco"} «${bank.name ?? bank.id}».`,
            payload_preview: {
                bank: { course_module_id: bank.id, kind: bank.modname, name: bank.name ?? null },
                category: { category_id: cat.category_id, label: cat.label },
                file: { filename: file!.filename, bytes: file!.size, sha256: file!.sha256, path: file!.path, format },
                questions: names,
                options: { catfromfile: false, contextfromfile: false, matchgrades: "error", stoponerror: true },
            },
            side_effects: [
                `Crea ${names.length} pregunta(s) en el banco. No las agrega a ningún cuestionario.`,
                "Si un cuestionario saca preguntas aleatorias de esa categoría, los intentos NUEVOS pueden recibirlas.",
                "Sube el archivo a tu borrador privado del Campus justo antes de importar. Sin notificaciones.",
            ],
            preconditions: { description: "La categoría no cambió desde el plan.", versions: { [`qinv:${cat.category_id}:${cat.context_id}`]: inv.length } },
            undo: { kind: "exacto", how: "Borrar las preguntas importadas (las que ya se usaron en intentos quedan ocultas en lugar de borrarse).", until: null },
            warnings: ["Importación por formulario web: requiere la sesión web del Campus.", "Moodle detiene la importación ante el primer error del archivo (stoponerror)."],
            items: [
                {
                    item_id: "i1",
                    description: `Importar ${names.length} pregunta(s) a la categoría ${cat.category_id}`,
                    call: {
                        kind: "form",
                        fn: "question_import",
                        params: { query: { cmid: String(bank.id) }, fields: { format, category: `${cat.category_id},${cat.context_id}`, catfromfile: "0", contextfromfile: "0", matchgrades: "error", stoponerror: "1" } },
                    },
                    target: { course_id: input.course_id, cmid: bank.id, category_id: cat.category_id, context_id: cat.context_id },
                    expected: { names, count: names.length, prior_ids: inv.map((q) => q.id) },
                    uploads: { field: "newfile", files: [file!] },
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.bank.name", "payload_preview.category.label"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const item = plan.items[0]!;
        const t = item.target;
        const prior = new Set(item.expected.prior_ids as number[]);
        const names = new Set(item.expected.names as string[]);
        const ids = (await inventory(ctx, Number(t.category_id), Number(t.context_id))).filter((q) => !prior.has(q.id) && names.has(q.name)).map((q) => q.id).sort((a, b) => a - b);
        if (!ids.length) return { kind: "ninguno", reason: "No se encontraron en la categoría las preguntas importadas." };
        const list = ids.join(",");
        const draft: PlanDraft = {
            intent: "question_import",
            capability: "import_questions",
            course_id: plan.course_id,
            base_risk: "R2",
            summary: `Deshacer: borrar las ${ids.length} pregunta(s) importadas de la categoría ${t.category_id}.`,
            payload_preview: { delete_questions: ids },
            side_effects: ["Borra las preguntas (todas sus versiones). Las que ya se usaron en intentos quedan ocultas.", "Si se agregaron a un cuestionario después de importarlas, sus huecos quedan rotos."],
            preconditions: { description: "Las preguntas siguen en la categoría.", versions: { [`qids:${t.category_id}:${t.context_id}:${list}`]: ids.length } },
            undo: { kind: "ninguno", how: "El borrado no se puede deshacer (se puede volver a importar el archivo).", until: null },
            warnings: [],
            items: [
                {
                    item_id: "i1",
                    description: `Borrar ${ids.length} pregunta(s)`,
                    call: {
                        kind: "form",
                        fn: "question_delete",
                        params: { query: {}, fields: { deleteselected: list, confirm: createHash("md5").update(list).digest("hex"), cmid: String(t.cmid), deleteall: "1", returnurl: `/question/edit.php?cmid=${t.cmid}` } },
                    },
                    target: { course_id: plan.course_id, cmid: Number(t.cmid), category_id: Number(t.category_id), context_id: Number(t.context_id) },
                    expected: { question_ids: ids },
                },
            ],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: {},
            undo_of: result.action_id,
        };
        return { kind: "plan", draft };
    },
};
