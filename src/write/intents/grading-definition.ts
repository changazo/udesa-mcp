import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable } from "../text.js";
import { parseFormFields } from "../web.js";
import { fieldOf } from "./modform.js";

/**
 * W6 · Definir la rúbrica o la guía de evaluación de una tarea (ADR-095), por las páginas de gestión de
 * la calificación avanzada:
 * - área: `/grade/grading/manage.php?contextid&component=mod_assign&area=submissions` (areaid, método
 *   activo y la definición existente);
 * - definir o reemplazar: `/grade/grading/form/<rubric|guide>/edit.php` con criterios NUEVOS (NEWIDn):
 *   Moodle borra los que no se reenvían. Se guarda «lista para usar»;
 * - borrar: `manage.php?deleteform=<id>&confirmed=1`.
 * Sólo mientras la tarea no tenga notas (cambiar una definición usada recalcula notas). El método se elige
 * con campus_plan_activity_settings (grading_method). Verificación releyendo el editor.
 * Deshacer: volver a la definición anterior, o borrar la creada.
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional(), contextid: z.number().nullable().optional() })).default([]) }));
const AssignmentsSchema = z.object({ courses: z.array(z.object({ id: z.number().int(), assignments: z.array(z.object({ id: z.number().int(), cmid: z.number().int() })).default([]) })).default([]) });
const GradesSchema = z.object({ assignments: z.array(z.object({ assignmentid: z.number().int(), grades: z.array(z.object({ grade: z.string().nullable().optional() })).default([]) })).default([]) });

type Method = "rubric" | "guide";
interface RubricCriterion {
    description: string;
    levels: { definition: string; score: number }[];
}
interface GuideCriterion {
    shortname: string;
    description: string;
    description_markers: string;
    max_score: number;
}
export interface Definition {
    method: Method;
    name: string;
    rubric: RubricCriterion[];
    guide: GuideCriterion[];
    comments: string[];
}

/** Área de calificación de la tarea, método activo y definición existente. */
export async function gradingArea(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "assign") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es una tarea (es ${m.modname}).`);
    if (!m.contextid) throw new CampusError("UNEXPECTED_RESPONSE", "La tarea no trae su contexto.");
    const html = await ctx.web.readPage("grading_manage", { contextid: String(m.contextid), component: "mod_assign", area: "submissions" });
    const areaid = Number(/[?&;]areaid=(\d+)/.exec(html)?.[1]);
    if (!areaid) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció el área de calificación de la tarea.");
    const method = (/\/grade\/grading\/form\/(rubric|guide)\/edit\.php/.exec(html)?.[1] ?? null) as Method | null;
    const defid = Number(/[?&;]deleteform=(\d+)/.exec(html)?.[1]) || null;
    return { cmid, name: m.name ?? "", contextid: m.contextid, areaid, method, defid };
}

/** La definición tal como está guardada (editor), o null si todavía no hay. */
export async function readDefinition(ctx: IntentContext, areaid: number, method: Method): Promise<Definition | null> {
    const f = parseFormFields(await ctx.web.readPage(`grading_${method}_form`, { areaid: String(areaid) }), `_qf__gradingform_${method}_edit${method}`);
    if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `No se reconoció el editor de ${method === "rubric" ? "rúbrica" : "guía"}.`);
    const get = (n: string) => fieldOf(f, n) ?? "";
    const ids = (re: RegExp) => [...new Set(f.map(([n]) => re.exec(n)?.[1]).filter((x): x is string => !!x))];
    const order = (prefix: string, list: string[]) => list.sort((a, b) => Number(get(`${prefix}[${a}][sortorder]`)) - Number(get(`${prefix}[${b}][sortorder]`)));
    const d: Definition = { method, name: get("name"), rubric: [], guide: [], comments: [] };
    if (method === "rubric") {
        for (const c of order("rubric[criteria]", ids(/^rubric\[criteria\]\[(\w+)\]\[description\]$/))) {
            const levels = ids(new RegExp(`^rubric\\[criteria\\]\\[${c}\\]\\[levels\\]\\[(\\w+)\\]\\[definition\\]$`)).map((l) => ({ definition: get(`rubric[criteria][${c}][levels][${l}][definition]`), score: Number(get(`rubric[criteria][${c}][levels][${l}][score]`)) }));
            d.rubric.push({ description: get(`rubric[criteria][${c}][description]`), levels });
        }
        // Sin definición, el editor trae un criterio vacío de ejemplo.
        d.rubric = d.rubric.filter((c) => c.description.trim() || c.levels.some((l) => l.definition.trim()));
        return d.rubric.length ? d : null;
    }
    for (const c of order("guide[criteria]", ids(/^guide\[criteria\]\[(\w+)\]\[shortname\]$/))) {
        const p = `guide[criteria][${c}]`;
        d.guide.push({ shortname: get(`${p}[shortname]`), description: get(`${p}[description]`), description_markers: get(`${p}[descriptionmarkers]`), max_score: Number(get(`${p}[maxscore]`)) });
    }
    d.comments = order("guide[comments]", ids(/^guide\[comments\]\[(\w+)\]\[description\]$/)).map((c) => get(`guide[comments][${c}][description]`)).filter((x) => x.trim());
    d.guide = d.guide.filter((c) => c.shortname.trim());
    return d.guide.length ? d : null;
}

const norm = (d: Definition | null) =>
    d
        ? JSON.stringify({
              name: d.name.trim(),
              rubric: d.rubric.map((c) => ({ d: comparable(c.description), l: c.levels.map((l) => [comparable(l.definition), l.score]) })),
              guide: d.guide.map((c) => [c.shortname.trim(), comparable(c.description), comparable(c.description_markers), c.max_score]),
              comments: d.comments.map((x) => comparable(x)),
          })
        : null;

async function hasGrades(ctx: IntentContext, courseId: number, cmid: number) {
    const a = (await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [courseId] }, AssignmentsSchema)).courses.flatMap((c) => c.assignments).find((x) => x.cmid === cmid);
    if (!a) throw new CampusError("UNEXPECTED_RESPONSE", "La tarea no aparece en mod_assign_get_assignments.");
    const g = GradesSchema.parse(await ctx.transport.call("mod_assign_get_grades", { assignmentids: [a.id] }));
    return g.assignments.some((x) => x.grades.some((y) => y.grade !== null && y.grade !== undefined && Number(y.grade) >= 0));
}

/** Campos del editor para dejar exactamente esta definición (todo con ids nuevos). */
function definitionFields(areaid: number, d: Definition): Record<string, string> {
    const out: Record<string, string> = { areaid: String(areaid), name: d.name, "description_editor[text]": "", "description_editor[format]": "1" };
    if (d.method === "rubric") {
        d.rubric.forEach((c, i) => {
            const p = `rubric[criteria][NEWID${i + 1}]`;
            Object.assign(out, { [`${p}[sortorder]`]: String(i + 1), [`${p}[description]`]: c.description });
            c.levels.forEach((l, j) => Object.assign(out, { [`${p}[levels][NEWID${j}][definition]`]: l.definition, [`${p}[levels][NEWID${j}][score]`]: String(l.score) }));
        });
        for (const o of ["lockzeropoints", "alwaysshowdefinition", "showdescriptionteacher", "showdescriptionstudent", "showscoreteacher", "showscorestudent", "enableremarks", "showremarksstudent"]) out[`rubric[options][${o}]`] = "1";
        out["rubric[options][sortlevelsasc]"] = "1";
        return out;
    }
    d.guide.forEach((c, i) => {
        const p = `guide[criteria][NEWID${i + 1}]`;
        Object.assign(out, { [`${p}[sortorder]`]: String(i + 1), [`${p}[shortname]`]: c.shortname, [`${p}[description]`]: c.description, [`${p}[descriptionmarkers]`]: c.description_markers, [`${p}[maxscore]`]: String(c.max_score) });
    });
    d.comments.forEach((x, i) => Object.assign(out, { [`guide[comments][NEWID${i + 1}][sortorder]`]: String(i + 1), [`guide[comments][NEWID${i + 1}][description]`]: x }));
    Object.assign(out, { "guide[options][optionsset]": "1", "guide[options][alwaysshowdefinition]": "1", "guide[options][showmarkspercriterionstudents]": "1" });
    return out;
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, areaid, method] = k.split(":");
        out[k] = kind === "gradingdef" ? norm(await readDefinition(ctx, Number(areaid), method as Method)) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const x = item.expected as { want: string | null; prior: string | null; method: Method };
    const now = norm(await readDefinition(ctx, Number(item.target.areaid), x.method));
    if (now === x.want) return { outcome: "coincide", checked: ["definición"], differences: [] };
    return { outcome: now === x.prior ? "sin_efecto" : "difiere", checked: ["definición"], differences: [{ field: "definición", expected: x.want ? JSON.parse(x.want) : "borrada", observed: now ? JSON.parse(now) : "ninguna" }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

interface Req {
    course_id: number;
    course_module_id: number;
    action: "define" | "delete";
    name?: string;
    rubric?: { description: string; levels: { definition: string; score: number }[] }[];
    guide?: { shortname: string; description?: string; description_markers?: string; max_score: number }[];
    comments?: string[];
    restore?: Definition;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const area = await gradingArea(ctx, input.course_id, input.course_module_id);
    if (!area.method) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea usa calificación simple: elegí el método (grading_method: rubric o guide) con campus_plan_activity_settings.");
    if (await hasGrades(ctx, input.course_id, input.course_module_id)) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea ya tiene notas: cambiar su rúbrica o guía recalcularía notas. No se hace por esta vía.");
    const cur = await readDefinition(ctx, area.areaid, area.method);
    const label = area.method === "rubric" ? "rúbrica" : "guía de evaluación";
    let item: PlanItem;
    let summary: string;
    let want: Definition | null;
    if (input.action === "delete") {
        if (!cur || !area.defid) throw new CampusError("WRITE_NOT_ALLOWED", `La tarea no tiene ${label} definida.`);
        want = null;
        item = { item_id: "i1", description: `Borrar la ${label}`, call: { kind: "form", fn: "grading_definition_delete", params: { query: {}, fields: { areaid: String(area.areaid), deleteform: String(area.defid), confirmed: "1" } } }, target: { course_id: input.course_id, cmid: area.cmid, areaid: area.areaid }, expected: { method: area.method, want: null, prior: norm(cur) } };
        summary = `Borrar la ${label} «${cur.name}» de la tarea «${area.name}».`;
    } else {
        if (input.restore) want = input.restore;
        else {
            const name = input.name?.trim() || cur?.name || `${label[0]!.toUpperCase()}${label.slice(1)} de ${area.name}`;
            if (area.method === "rubric") {
                if (!input.rubric?.length) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea usa rúbrica: indicá rubric (criterios con niveles).");
                if (input.guide) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea usa rúbrica, no guía.");
                for (const c of input.rubric) {
                    if (c.levels.length < 2) throw new CampusError("WRITE_NOT_ALLOWED", `El criterio «${c.description}» necesita al menos 2 niveles.`);
                    if (new Set(c.levels.map((l) => l.score)).size !== c.levels.length) throw new CampusError("WRITE_NOT_ALLOWED", `El criterio «${c.description}» repite puntajes.`);
                }
                want = { method: "rubric", name, rubric: input.rubric.map((c) => ({ description: c.description.trim(), levels: c.levels.map((l) => ({ definition: l.definition.trim(), score: l.score })) })), guide: [], comments: [] };
            } else {
                if (!input.guide?.length) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea usa guía de evaluación: indicá guide (criterios con puntaje máximo).");
                if (input.rubric) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea usa guía, no rúbrica.");
                want = { method: "guide", name, rubric: [], guide: input.guide.map((c) => ({ shortname: c.shortname.trim(), description: c.description?.trim() ?? "", description_markers: c.description_markers?.trim() ?? "", max_score: c.max_score })), comments: (input.comments ?? []).map((x) => x.trim()).filter(Boolean) };
            }
        }
        if (norm(want) === norm(cur)) throw new CampusError("WRITE_NOT_ALLOWED", `La ${label} ya está así.`);
        item = { item_id: "i1", description: `${cur ? "Reemplazar" : "Definir"} la ${label}`, call: { kind: "form", fn: `grading_${area.method}_save`, params: { query: { areaid: String(area.areaid) }, fields: definitionFields(area.areaid, want) } }, target: { course_id: input.course_id, cmid: area.cmid, areaid: area.areaid }, expected: { method: area.method, want: norm(want), prior: norm(cur) } };
        const total = want.method === "rubric" ? want.rubric.reduce((s, c) => s + Math.max(...c.levels.map((l) => l.score)), 0) : want.guide.reduce((s, c) => s + c.max_score, 0);
        summary = `${cur ? "Reemplazar" : "Definir"} la ${label} «${want.name}» de la tarea «${area.name}» (${want.method === "rubric" ? want.rubric.length : want.guide.length} criterio(s), ${total} puntos en total).`;
    }
    return {
        intent: "grading_definition",
        capability: "edit_activity",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: { assignment: { course_module_id: area.cmid, name: area.name }, method: area.method, before: cur, after: want },
        side_effects: ["Cambia cómo se califica la tarea (los estudiantes ven la rúbrica o la guía si la tarea lo muestra).", "Sin notificaciones."],
        preconditions: { description: "La definición no cambió desde el plan.", versions: { [`gradingdef:${area.areaid}:${area.method}`]: norm(cur) } },
        undo: { kind: "compensación", how: cur ? "Volver a la definición anterior." : "Borrar la definición creada.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus."],
        items: [item],
        prior_state: { definition: cur },
        untrusted_fields: ["payload_preview.assignment.name", "payload_preview.before"],
        teacher_text: input.name ? { name: input.name } : {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la tarea (con grading_method rubric o guide)."),
    operation: z.enum(["define", "delete"]).describe("define = crear o reemplazar; delete = borrar la definición."),
    name: z.string().min(1).max(255).optional(),
    rubric: z
        .array(z.strictObject({ description: z.string().min(1).max(2_000), levels: z.array(z.strictObject({ definition: z.string().min(1).max(2_000), score: z.number().min(0).max(1_000) })).min(2).max(10) }))
        .min(1)
        .max(20)
        .optional()
        .describe("Rúbrica: criterios, cada uno con sus niveles (definición y puntaje)."),
    guide: z
        .array(z.strictObject({ shortname: z.string().min(1).max(255), description: z.string().max(2_000).optional(), description_markers: z.string().max(2_000).optional(), max_score: z.number().min(0).max(1_000) }))
        .min(1)
        .max(20)
        .optional()
        .describe("Guía: criterios con nombre corto, descripción para estudiantes y para correctores, y puntaje máximo."),
    comments: z.array(z.string().min(1).max(2_000)).max(30).optional().describe("Guía: comentarios frecuentes."),
};

export const gradingDefinitionIntent: WriteIntent<typeof shape> = {
    name: "grading_definition",
    title: "Plan: definir la rúbrica o la guía de evaluación de una tarea",
    description: "Arma el plan para crear, reemplazar o borrar la rúbrica (criterios con niveles y puntajes) o la guía de evaluación (criterios con puntaje máximo) de una tarea que todavía no tiene notas. El método se elige antes con campus_plan_activity_settings (grading_method). No escribe.",
    inputShape: shape,
    capability: "edit_activity",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: ({ operation, ...rest }, ctx) => build({ ...rest, action: operation }, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const prior = (plan.prior_state as { definition: Definition | null }).definition;
        const base = { course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid) };
        return { kind: "plan", draft: await build(prior ? { ...base, action: "define", restore: prior } : { ...base, action: "delete" }, ctx, result.action_id) };
    },
};
