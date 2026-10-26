import { z } from "zod";
import { CampusError } from "../../errors.js";
import { AssignmentsSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { DESCRIPTION_KINDS } from "../functions.js";
import { fieldOf, readModForm, stableHtml } from "./modform.js";

/**
 * W6 · Editar la descripción (consigna) de tareas, cuestionarios, foros y páginas, el contenido de las
 * páginas y la nota máxima de las tareas (pedido del dueño; ADR-075).
 * - `/course/modedit.php?update=<cmid>` con una spec por tipo: se reenvía la configuración actual y se
 *   pisan SÓLO los campos pedidos. `coursecontentnotification` siempre en 0.
 * - Nota máxima de una tarea: sólo si nadie tiene nota (con notas, Moodle pide elegir si reescalar y
 *   las notas cambiarían de sentido). Calificación por puntos.
 * - Verificación por servicio web (intro, contenido, nota). Deshacer: los valores anteriores tal como
 *   los devolvía Moodle (compensación; las imágenes incrustadas pueden no restaurarse igual).
 * - ADR-077: la descripción de CUALQUIER actividad con descripción estándar (carpeta, archivo, libro,
 *   wiki, glosario, base de datos, lección, LTI, H5P, consulta, elección de grupo, encuesta, asistencia…):
 *   se lee y se verifica por el propio formulario (`modedit_form`). Turnitin no: guardarlo sincroniza
 *   con el servicio externo.
 */

type FormKind = (typeof DESCRIPTION_KINDS)[number];
type Kind = "assign" | "quiz" | "forum" | "page" | "url" | "label" | FormKind;
const WS_KINDS = ["assign", "quiz", "forum", "page", "url", "label"];
const isFormKind = (k: string): k is FormKind => (DESCRIPTION_KINDS as readonly string[]).includes(k);
const ANY = z.array(z.object({}).passthrough());

interface Current {
    kind: Kind;
    cmid: number;
    name: string;
    intro: string;
    content?: string;
    grade?: number;
    /** Sólo enlaces. */
    url?: string;
    instance: number;
}

async function current(ctx: IntentContext, courseId: number, cmid: number): Promise<Current> {
    const t = ctx.read.session.transport;
    const mods = (await t.call("core_course_get_contents", { courseid: courseId }, z.array(z.object({ modules: z.array(z.object({ id: z.number(), modname: z.string(), name: z.string().nullable().optional(), description: z.string().nullable().optional(), instance: z.number().nullable().optional() })).default([]) })))).flatMap((s) => s.modules);
    const m = mods.find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname === "turnitintooltwo") throw new CampusError("WRITE_NOT_ALLOWED", "Turnitin no se edita: guardar su configuración la sincroniza con el servicio externo de Turnitin.");
    if (!WS_KINDS.includes(m.modname) && !isFormKind(m.modname)) throw new CampusError("WRITE_NOT_ALLOWED", `Las actividades de tipo ${m.modname} no tienen una descripción editable por esta vía.`);
    const kind = m.modname as Kind;
    if (isFormKind(kind)) {
        // Sin función de lectura con la descripción: el propio formulario (ADR-077).
        const f = await readModForm(ctx, cmid, kind);
        return { kind, cmid, name: fieldOf(f, "name") ?? m.name ?? "", intro: stableHtml(fieldOf(f, "introeditor[text]") ?? ""), instance: m.instance ?? 0 };
    }
    // Etiqueta: su texto es la descripción del módulo (no hay función de lectura propia en la allowlist).
    if (kind === "label") return { kind, cmid, name: m.name ?? "", intro: m.description ?? "", instance: m.instance ?? 0 };
    if (kind === "assign") {
        const a = (await t.call("mod_assign_get_assignments", { courseids: [courseId] }, AssignmentsSchema)).courses.find((c) => c.id === courseId)?.assignments.find((x) => x.cmid === cmid);
        if (!a) throw new CampusError("UNEXPECTED_RESPONSE", "La tarea no aparece en mod_assign_get_assignments.");
        return { kind, cmid, name: a.name ?? m.name ?? "", intro: a.intro ?? "", grade: a.grade ?? 0, instance: a.id };
    }
    const list = async (fn: string, field: string) => {
        const raw = (await t.call(fn as "mod_quiz_get_quizzes_by_courses", { courseids: [courseId] }, z.union([ANY, z.record(z.string(), z.unknown())]))) as unknown;
        const arr = (Array.isArray(raw) ? raw : (raw as Record<string, unknown>)[field]) as Record<string, unknown>[] | undefined;
        const row = (arr ?? []).find((x) => Number(x.coursemodule ?? x.cmid) === cmid);
        if (!row) throw new CampusError("UNEXPECTED_RESPONSE", `La actividad no aparece en ${fn}.`);
        return row;
    };
    if (kind === "quiz") {
        const q = await list("mod_quiz_get_quizzes_by_courses", "quizzes");
        return { kind, cmid, name: String(q.name ?? ""), intro: String(q.intro ?? ""), instance: Number(q.id) };
    }
    if (kind === "forum") {
        const f = await list("mod_forum_get_forums_by_courses", "forums");
        return { kind, cmid, name: String(f.name ?? ""), intro: String(f.intro ?? ""), instance: Number(f.id) };
    }
    if (kind === "url") {
        const u = await list("mod_url_get_urls_by_courses", "urls");
        return { kind, cmid, name: String(u.name ?? ""), intro: String(u.intro ?? ""), url: String(u.externalurl ?? ""), instance: Number(u.id) };
    }
    const p = await list("mod_page_get_pages_by_courses", "pages");
    return { kind, cmid, name: String(p.name ?? ""), intro: String(p.intro ?? ""), content: String(p.content ?? ""), instance: Number(p.id) };
}

const snapshot = (c: Current) => JSON.stringify({ intro: comparable(c.intro), content: c.content === undefined ? null : comparable(c.content), grade: c.grade ?? null, url: c.url ?? null });

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid] = k.split(":");
        out[k] = kind === "acttext" ? snapshot(await current(ctx, Number(course), Number(cmid))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const c = await current(ctx, plan.course_id, Number(item.target.cmid));
    const x = item.expected as { intro_text?: string; content_text?: string; grade?: number; url?: string; prior: { intro_text: string; content_text: string | null; grade: number | null; url: string | null } };
    const now = { intro_text: comparable(c.intro), content_text: c.content === undefined ? null : comparable(c.content), grade: c.grade ?? null, url: c.url ?? null };
    const differences: Difference[] = [];
    const checked: string[] = [];
    const cmp = (field: "intro_text" | "content_text" | "grade" | "url", want: unknown) => {
        if (want === undefined) return;
        checked.push(field);
        if (now[field] !== want) differences.push({ field, expected: want, observed: now[field] });
    };
    cmp("intro_text", x.intro_text);
    cmp("content_text", x.content_text);
    cmp("grade", x.grade);
    cmp("url", x.url);
    if (!differences.length) return { outcome: "coincide", checked, differences };
    const unchanged = checked.every((f) => now[f as keyof typeof now] === x.prior[f as keyof typeof x.prior]);
    return { outcome: unchanged ? "sin_efecto" : "difiere", checked, differences };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

function draftFor(courseId: number, c: Current, change: { introHtml?: string; contentHtml?: string; grade?: number; url?: string }, undoOf: string | null): PlanDraft {
    const fields: Record<string, string> = { coursecontentnotification: "0" };
    const expected: Record<string, unknown> = { prior: { intro_text: comparable(c.intro), content_text: c.content === undefined ? null : comparable(c.content), grade: c.grade ?? null, url: c.url ?? null } };
    const preview: Record<string, unknown> = { activity: { course_module_id: c.cmid, type: c.kind, name: c.name } };
    if (change.introHtml !== undefined) {
        Object.assign(fields, { "introeditor[text]": change.introHtml, "introeditor[format]": "1" });
        expected.intro_text = comparable(change.introHtml);
        preview[c.kind === "label" ? "text" : "description"] = { before_html: c.intro, after_html: change.introHtml };
    }
    if (change.url !== undefined) {
        fields.externalurl = change.url;
        expected.url = change.url;
        preview.external_url = { before: c.url ?? null, after: change.url };
    }
    if (change.contentHtml !== undefined) {
        Object.assign(fields, { "page[text]": change.contentHtml, "page[format]": "1" });
        expected.content_text = comparable(change.contentHtml);
        preview.content = { before_html: c.content ?? "", after_html: change.contentHtml };
    }
    if (change.grade !== undefined) {
        Object.assign(fields, { "grade[modgrade_type]": "point", "grade[modgrade_point]": String(change.grade) });
        expected.grade = change.grade;
        preview.max_grade = { before: c.grade ?? null, after: change.grade };
    }
    const what = [change.introHtml !== undefined ? (c.kind === "label" ? "texto" : "descripción") : null, change.url !== undefined ? "dirección" : null, change.contentHtml !== undefined ? "contenido" : null, change.grade !== undefined ? `nota máxima ${c.grade} → ${change.grade}` : null].filter(Boolean).join(", ");
    return {
        intent: "edit_activity_text",
        capability: "edit_activity",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Editar en «${c.name}» (${c.kind}): ${what}.`,
        payload_preview: preview,
        side_effects: [
            "Cambia lo que ven los estudiantes en la actividad. El resto de la configuración se reenvía tal cual.",
            ...(change.grade !== undefined ? ["Cambia la nota máxima del ítem de calificación (nadie tiene nota todavía: no se reescala nada)."] : []),
            "Sin notificación de cambio de contenido (coursecontentnotification=0).",
        ],
        preconditions: { description: "La actividad no cambió desde el plan.", versions: { [`acttext:${courseId}:${c.cmid}`]: snapshot(c) } },
        undo: { kind: "compensación", how: "Volver a los valores anteriores (tal como los devolvía Moodle; imágenes incrustadas pueden no restaurarse igual).", until: null },
        warnings: ["Edición por formulario web: requiere la sesión web del Campus. Abrirlo copia los archivos del módulo a tu borrador privado."],
        items: [
            {
                item_id: "i1",
                description: `Editar ${what} de la actividad ${c.cmid}`,
                call: { kind: "form", fn: `course_modedit_${c.kind}_update_text`, params: { query: { update: String(c.cmid) }, fields } },
                target: { course_id: courseId, cmid: c.cmid },
                expected,
            },
        ],
        prior_state: { intro_html: c.intro, ...(c.content !== undefined ? { content_html: c.content } : {}), ...(c.grade !== undefined ? { grade: c.grade } : {}), ...(c.url !== undefined ? { url: c.url } : {}) },
        untrusted_fields: ["payload_preview.activity.name", "payload_preview.description.before_html", "payload_preview.text.before_html", "payload_preview.content.before_html", "payload_preview.external_url.before"],
        teacher_text: Object.fromEntries(Object.entries({ intro: change.introHtml, content: change.contentHtml }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la actividad: tarea, cuestionario, foro, página, enlace, etiqueta, carpeta, archivo, libro, wiki, glosario, base de datos, lección, LTI, H5P, consulta, elección de grupo, encuesta o asistencia (no Turnitin)."),
    description: z.string().max(20_000).optional().describe("Nueva descripción / consigna (Markdown). \"\" la vacía. En una etiqueta, es su texto (no vacío)."),
    external_url: z.string().min(1).max(1900).optional().describe("Sólo enlaces: nueva dirección http(s)."),
    content: z.string().min(1).max(200_000).optional().describe("Sólo páginas: nuevo contenido (Markdown)."),
    max_grade: z.number().int().min(1).max(100).optional().describe("Sólo tareas: nueva nota máxima en puntos (sólo si nadie tiene nota)."),
};

export const editActivityTextIntent: WriteIntent<typeof shape> = {
    name: "edit_activity_text",
    title: "Plan: editar descripción, contenido, dirección de enlace, texto de etiqueta o nota máxima",
    description: "Arma el plan para cambiar la descripción (consigna) de cualquier actividad con descripción (tarea, cuestionario, foro, página, enlace, carpeta, archivo, libro, wiki, glosario, base de datos, lección, LTI, H5P, consulta, elección de grupo, encuesta, asistencia); el contenido de una página; la dirección de un enlace; el texto de una etiqueta; o la nota máxima de una tarea (sin notas cargadas). Muestra antes y después. No escribe.",
    inputShape: shape,
    capability: "edit_activity",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        if (input.description === undefined && input.content === undefined && input.max_grade === undefined && input.external_url === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá description, content, external_url o max_grade.");
        const c = await current(ctx, input.course_id, input.course_module_id);
        if (input.content !== undefined && c.kind !== "page") throw new CampusError("WRITE_NOT_ALLOWED", "content sólo aplica a páginas.");
        if (input.max_grade !== undefined && c.kind !== "assign") throw new CampusError("WRITE_NOT_ALLOWED", "max_grade sólo aplica a tareas.");
        if (input.external_url !== undefined && c.kind !== "url") throw new CampusError("WRITE_NOT_ALLOWED", "external_url sólo aplica a enlaces.");
        if (c.kind === "label" && (input.description === undefined || !input.description.trim())) throw new CampusError("WRITE_NOT_ALLOWED", "En una etiqueta, description (su texto) es obligatorio y no puede quedar vacío.");
        const change: { introHtml?: string; contentHtml?: string; grade?: number; url?: string } = {};
        if (input.external_url !== undefined) {
            let u: URL;
            try {
                u = new URL(input.external_url.trim());
            } catch {
                throw new CampusError("WRITE_NOT_ALLOWED", "La URL no es válida.");
            }
            if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw new CampusError("WRITE_NOT_ALLOWED", "Sólo URLs http o https, sin usuario ni contraseña.");
            if (u.href === c.url) throw new CampusError("WRITE_NOT_ALLOWED", "Esa ya es la dirección del enlace.");
            change.url = u.href;
        }
        if (input.description !== undefined) change.introHtml = input.description === "" ? "" : toHtml(input.description, "markdown");
        if (input.content !== undefined) change.contentHtml = toHtml(input.content, "markdown");
        if (input.max_grade !== undefined) {
            if ((c.grade ?? 0) <= 0) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea no se califica por puntos (sin nota o con escala).");
            if (c.grade === input.max_grade) throw new CampusError("WRITE_NOT_ALLOWED", "Esa ya es la nota máxima.");
            const graded = z.object({ assignments: z.array(z.object({ grades: z.array(z.object({ grade: z.union([z.string(), z.number()]).nullable().optional() })).default([]) })).default([]) }).parse(await ctx.transport.call("mod_assign_get_grades", { assignmentids: [c.instance] })).assignments.flatMap((a) => a.grades).filter((g) => g.grade !== null && g.grade !== undefined && g.grade !== "" && Number(g.grade) >= 0);
            if (graded.length) throw new CampusError("WRITE_NOT_ALLOWED", `La tarea ya tiene ${graded.length} nota(s): cambiar la nota máxima cambiaría su sentido. No se admite por ahora.`);
            change.grade = input.max_grade;
        }
        if (change.introHtml !== undefined && comparable(change.introHtml) === comparable(c.intro) && change.contentHtml === undefined && change.grade === undefined && change.url === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "La descripción ya es esa.");
        return draftFor(input.course_id, c, change, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const prior = plan.prior_state as { intro_html: string; content_html?: string; grade?: number; url?: string };
        const it = plan.items[0]!;
        const c = await current(ctx, plan.course_id, Number(it.target.cmid));
        const x = it.expected as Record<string, unknown>;
        return {
            kind: "plan",
            draft: draftFor(plan.course_id, c, { ...(x.intro_text !== undefined ? { introHtml: prior.intro_html } : {}), ...(x.content_text !== undefined ? { contentHtml: prior.content_html ?? "" } : {}), ...(x.grade !== undefined ? { grade: prior.grade } : {}), ...(x.url !== undefined ? { url: prior.url } : {}) }, result.action_id),
        };
    },
};
