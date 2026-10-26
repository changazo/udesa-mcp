import { mayNotify } from "../policy.js";
import { z } from "zod";
import { CampusError } from "../../errors.js";
import { decodeEntities } from "../../domain/html.js";
import { AssignmentsSchema, AssignParticipantsSchema, SubmissionStatusSchema } from "../../moodle/schemas.js";
import { describeLocalFiles, type PlanFile } from "../files.js";

/** Tope por archivo de retroalimentación (como los archivos de actividades). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Difference, Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { parseFormFields } from "../web.js";
import { fieldOf, stableHtml } from "./modform.js";

/**
 * W6 · Calificación avanzada de una entrega (ADR-095), por el formulario CLÁSICO de calificación
 * (`/mod/assign/view.php?action=grade&userid`, marcador `_qf__mod_assign_grade_form_<userid>`):
 * puntos, ESCALA (el ítem de la escala), RÚBRICA (un nivel por criterio, con observación), GUÍA DE
 * EVALUACIÓN (puntaje por criterio, con observación), comentario y ARCHIVOS de retroalimentación (en el
 * borrador que sirve el formulario, con los actuales). La notificación al estudiante queda SIEMPRE en 0 y
 * `applytoall` en 0. El estado del flujo de trabajo se conserva (o se cambia, pero nunca a «liberada»).
 * Verificación: nota (mod_assign_get_grades), formulario releído (niveles, puntajes, observaciones) y
 * archivos (mod_assign_get_submission_status). Deshacer: volver a lo anterior y quitar los archivos
 * agregados; un archivo quitado no vuelve.
 */

const GradesSchema = z.object({ assignments: z.array(z.object({ assignmentid: z.number().int(), grades: z.array(z.object({ userid: z.number().int(), attemptnumber: z.number().int().nullable().optional(), grade: z.string().nullable().optional() })).default([]) })).default([]) });
const WORKFLOW = ["notmarked", "inmarking", "readyforreview", "inreview", "readyforrelease"] as const;

interface RubricCriterion {
    id: number;
    description: string;
    levels: { id: number; definition: string; score: number }[];
    selected: number | null;
    remark: string;
}
interface GuideCriterion {
    id: number;
    shortname: string;
    max: number | null;
    score: string;
    remark: string;
}
interface GradeForm {
    kind: "points" | "scale" | "rubric" | "guide";
    scale: { value: string; label: string }[];
    grade: string;
    rubric: RubricCriterion[];
    guide: GuideCriterion[];
    comment: string;
    workflow: string | null;
    filesField: string | null;
}

const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** El formulario clásico de calificación de UN participante, interpretado. */
export function parseGradeForm(html: string, userId: number): GradeForm | null {
    const f = parseFormFields(html, `_qf__mod_assign_grade_form_${userId}`);
    if (!f) return null;
    const get = (n: string) => fieldOf(f, n);
    const form = /<form\b[^>]*class="[^"]*gradeform[\s\S]*?<\/form>/.exec(html)?.[0] ?? html;
    const scale = [...(/<select\b[^>]*name="grade"[^>]*>([\s\S]*?)<\/select>/.exec(form)?.[1] ?? "").matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].map((m) => ({ value: m[1]!, label: text(m[2]!) }));
    const rubric: RubricCriterion[] = [];
    for (const m of form.matchAll(/id="advancedgrading-criteria-(\d+)-description-cell"[^>]*>([\s\S]*?)<\/td>/g)) {
        const cid = Number(m[1]);
        const levels = [...form.matchAll(new RegExp(`id="advancedgrading-criteria-${cid}-levels-(\\d+)-definition-container"[^>]*>([\\s\\S]*?)</div>`, "g"))].map((l) => {
            const score = new RegExp(`id="advancedgrading-criteria-${cid}-levels-${l[1]}-score"[^>]*>([^<]*)<`).exec(form)?.[1];
            return { id: Number(l[1]), definition: text(l[2]!), score: Number((score ?? "").replace(",", ".")) };
        });
        rubric.push({ id: cid, description: text(m[2]!), levels, selected: Number(get(`advancedgrading[criteria][${cid}][levelid]`)) || null, remark: get(`advancedgrading[criteria][${cid}][remark]`) ?? "" });
    }
    const guide: GuideCriterion[] = [];
    const guideIds = [...new Set(f.map(([n]) => /^advancedgrading\[criteria\]\[(\d+)\]\[score\]$/.exec(n)?.[1]).filter((x): x is string => !!x))];
    for (const id of guideIds) {
        const block = new RegExp(`advancedgrading-criteria-${id}[\\s\\S]{0,4000}?name="advancedgrading\\[criteria\\]\\[${id}\\]\\[score\\]"`).exec(form)?.[0] ?? "";
        const shortname = text(/class="[^"]*criterionshortname[^"]*"[^>]*>([\s\S]*?)<\/(div|span|td)>/.exec(block)?.[1] ?? "");
        // El máximo va junto a la casilla del puntaje: <input … name="…[score]" …><div>/4</div>.
        const max = new RegExp(`name="advancedgrading\\[criteria\\]\\[${id}\\]\\[score\\]"[^>]*>\\s*<div>\\s*/\\s*(\\d+(?:[.,]\\d+)?)\\s*</div>`).exec(form)?.[1];
        guide.push({ id: Number(id), shortname, max: max ? Number(max.replace(",", ".")) : null, score: get(`advancedgrading[criteria][${id}][score]`) ?? "", remark: get(`advancedgrading[criteria][${id}][remark]`) ?? "" });
    }
    const kind = rubric.length ? "rubric" : guide.length ? "guide" : scale.length ? "scale" : "points";
    return {
        kind,
        scale: scale.filter((o) => o.value !== "-1" && o.value !== "" && o.label !== ""),
        grade: get("grade") ?? "",
        rubric,
        guide,
        comment: stableHtml(get("assignfeedbackcomments_editor[text]") ?? ""),
        workflow: get("workflowstate") ?? null,
        filesField: f.find(([n]) => /^files_\d+_filemanager$/.test(n))?.[0] ?? null,
    };
}

async function readForm(ctx: IntentContext, cmid: number, userId: number): Promise<GradeForm> {
    const g = parseGradeForm(await ctx.web.readPage("assign_grade_form", { id: String(cmid), action: "grade", userid: String(userId), rownum: "0" }), userId);
    if (!g) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció el formulario de calificación de la tarea.");
    return g;
}

async function feedbackFiles(ctx: IntentContext, assignmentId: number, userId: number): Promise<string[]> {
    const s = await ctx.read.session.transport.call("mod_assign_get_submission_status", { assignid: assignmentId, userid: userId }, SubmissionStatusSchema);
    return (s.feedback?.plugins?.find((p) => p.type === "file")?.fileareas ?? []).flatMap((a) => (a.files ?? []).map((x) => x.filename ?? "")).filter(Boolean).sort();
}

async function gradeValue(ctx: IntentContext, assignmentId: number, userId: number): Promise<number | null> {
    const rows = GradesSchema.parse(await ctx.transport.call("mod_assign_get_grades", { assignmentids: [assignmentId] })).assignments.find((a) => a.assignmentid === assignmentId)?.grades.filter((g) => g.userid === userId) ?? [];
    const last = rows.sort((a, b) => (b.attemptnumber ?? 0) - (a.attemptnumber ?? 0))[0];
    return last?.grade !== undefined && last?.grade !== null && Number(last.grade) >= 0 ? Number(last.grade) : null;
}

/** Lo comparable de un formulario: lo que el plan fija. */
function snapshot(g: GradeForm, files: string[]) {
    return {
        // Puntos como número: el formulario muestra la nota con la coma del idioma («8,25»).
        grade: g.kind === "points" ? (g.grade.trim() === "" ? null : Number(g.grade.replace(",", "."))) : g.kind === "scale" ? g.grade : null,
        rubric: g.rubric.map((c) => ({ id: c.id, level: c.selected, remark: comparable(c.remark) })),
        guide: g.guide.map((c) => ({ id: c.id, score: c.score === "" ? null : Number(c.score.replace(",", ".")), remark: comparable(c.remark) })),
        comment: comparable(g.comment),
        workflow: g.workflow,
        files,
    };
}
type Snap = ReturnType<typeof snapshot>;

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, cmid, assignId, userId] = k.split(":");
        out[k] = kind === "gradeform" ? JSON.stringify(snapshot(await readForm(ctx, Number(cmid), Number(userId)), await feedbackFiles(ctx, Number(assignId), Number(userId)))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, _plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected as { want: Partial<Snap>; prior: Snap };
    const now = snapshot(await readForm(ctx, Number(t.cmid), Number(t.user_id)), await feedbackFiles(ctx, Number(t.assignment_id), Number(t.user_id)));
    const keys = Object.keys(x.want) as (keyof Snap)[];
    const differences: Difference[] = keys.filter((k) => JSON.stringify(now[k]) !== JSON.stringify(x.want[k])).map((k) => ({ field: k, expected: x.want[k], observed: now[k] }));
    const grade = await gradeValue(ctx, Number(t.assignment_id), Number(t.user_id));
    if (!differences.length) return { outcome: "coincide", checked: [...keys, "nota"], differences };
    return { outcome: keys.every((k) => JSON.stringify(now[k]) === JSON.stringify(x.prior[k])) ? "sin_efecto" : "difiere", checked: keys, differences: [...differences, { field: "nota (libro)", expected: null, observed: grade }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

// ---------- plan ----------

interface Req {
    course_id: number;
    assignment_id: number;
    participant_id: number;
    grade?: number | string;
    rubric?: { criterion: string | number; level: string | number; remark?: string }[];
    guide?: { criterion: string | number; score: number; remark?: string }[];
    feedback_comment?: string;
    feedback_html?: string;
    add_feedback_file_paths?: string[];
    remove_feedback_files?: string[];
    workflow_state?: (typeof WORKFLOW)[number];
    /** Deshacer: valores exactos a restaurar. */
    notify_student?: boolean;
    restore?: { grade: string | null; rubric: { id: number; level: number | null; remark: string }[]; guide: { id: number; score: number | null; remark: string }[]; comment_html: string; workflow: string | null; remove_files: string[] };
}

const match = (want: string | number, id: number, label: string) => (typeof want === "number" ? want === id : comparable(label).toLowerCase() === comparable(want).toLowerCase());

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const a = (await ctx.read.session.transport.call("mod_assign_get_assignments", { courseids: [input.course_id] }, AssignmentsSchema)).courses.find((c) => c.id === input.course_id)?.assignments.find((x) => x.id === input.assignment_id);
    if (!a) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La tarea ${input.assignment_id} no es del curso ${input.course_id}.`);
    if (!a.cmid) throw new CampusError("UNEXPECTED_RESPONSE", "La tarea no trae su course_module_id.");
    if (a.blindmarking && !a.revealidentities) throw new CampusError("WRITE_NOT_ALLOWED", "Corrección anónima: no se califica por esta vía (y nunca se revelan identidades).");
    if (a.teamsubmission) throw new CampusError("WRITE_NOT_ALLOWED", "Entrega grupal: no se califica por esta vía (se aplicaría a todo el grupo).");
    const participants = await ctx.read.session.transport.call("mod_assign_list_participants", { assignid: a.id, groupid: 0, filter: "", skip: 0, limit: 0, onlyids: false, includeenrolments: false, tablesort: false }, AssignParticipantsSchema);
    const person = participants.find((p) => p.id === input.participant_id);
    if (!person) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${input.participant_id} no es participante de la tarea.`);
    const form = await readForm(ctx, a.cmid, input.participant_id);
    const files = await feedbackFiles(ctx, a.id, input.participant_id);
    const prior = snapshot(form, files);
    const notify = input.restore ? false : (input.notify_student ?? ctx.profile.policy.notify_students_default);
    if (notify && !mayNotify(ctx.profile.policy, input.course_id, [input.participant_id])) throw new CampusError("WRITE_NOT_ALLOWED", "Notificar a este estudiante no está permitido por el perfil (allow_participant_notifications=false y no es una cuenta de prueba del sandbox, ADR-115).");
    const fields: Record<string, string> = { sendstudentnotifications: notify ? "1" : "0" };
    const want: Partial<Snap> = {};
    const r = input.restore;
    // Nota: puntos o escala (con rúbrica o guía la calcula Moodle).
    if (r ? r.grade !== null && (form.kind === "points" || form.kind === "scale") : input.grade !== undefined) {
        if (form.kind === "rubric" || form.kind === "guide") throw new CampusError("WRITE_NOT_ALLOWED", `La tarea se califica con ${form.kind === "rubric" ? "rúbrica" : "guía"}: la nota sale de ${form.kind === "rubric" ? "los niveles (rubric)" : "los puntajes (guide)"}.`);
        let raw: string;
        if (r) raw = r.grade!;
        else if (form.kind === "scale") {
            const o = form.scale.find((s) => (typeof input.grade === "number" ? Number(s.value) === input.grade : comparable(s.label).toLowerCase() === comparable(String(input.grade)).toLowerCase()));
            if (!o) throw new CampusError("WRITE_NOT_ALLOWED", `«${input.grade}» no es un ítem de la escala: ${form.scale.map((s) => `${s.value} = ${s.label}`).join("; ")}.`);
            raw = o.value;
        } else {
            const v = typeof input.grade === "number" ? input.grade : Number(String(input.grade).trim().replace(",", "."));
            if (!Number.isFinite(v) || v < 0 || v > (a.grade ?? 0)) throw new CampusError("WRITE_NOT_ALLOWED", `La nota debe ser un número entre 0 y ${a.grade ?? 0}.`);
            raw = String(Math.round(v * 100000) / 100000);
        }
        fields.grade = raw;
        want.grade = form.kind === "points" ? Number(raw.replace(",", ".")) : raw;
    }
    // Rúbrica: un nivel por criterio (Moodle exige todos).
    if (form.kind === "rubric" && (r || input.rubric)) {
        const picks = form.rubric.map((c) => {
            if (r) return { c, level: r.rubric.find((x) => x.id === c.id)?.level ?? null, remark: r.rubric.find((x) => x.id === c.id)?.remark ?? "" };
            const req = input.rubric!.find((x) => match(x.criterion, c.id, c.description));
            if (!req) return { c, level: c.selected, remark: c.remark };
            const l = c.levels.find((x) => (typeof req.level === "number" ? x.id === req.level || x.score === req.level : comparable(x.definition).toLowerCase() === comparable(req.level).toLowerCase()));
            if (!l) throw new CampusError("WRITE_NOT_ALLOWED", `«${req.level}» no es un nivel del criterio «${c.description}»: ${c.levels.map((x) => `${x.definition} (${x.score})`).join("; ")}.`);
            return { c, level: l.id, remark: req.remark ?? c.remark };
        });
        const unknown = (input.rubric ?? []).filter((x) => !form.rubric.some((c) => match(x.criterion, c.id, c.description)));
        if (unknown.length) throw new CampusError("WRITE_NOT_ALLOWED", `Criterios que la rúbrica no tiene: ${unknown.map((x) => x.criterion).join(", ")}. Tiene: ${form.rubric.map((c) => c.description).join("; ")}.`);
        if (picks.some((p) => p.level === null)) throw new CampusError("WRITE_NOT_ALLOWED", `Moodle exige un nivel en cada criterio; falta en: ${picks.filter((p) => p.level === null).map((p) => p.c.description).join("; ")}.`);
        for (const p of picks) Object.assign(fields, { [`advancedgrading[criteria][${p.c.id}][levelid]`]: String(p.level), [`advancedgrading[criteria][${p.c.id}][remark]`]: p.remark });
        want.rubric = picks.map((p) => ({ id: p.c.id, level: p.level, remark: comparable(p.remark) }));
    } else if (input.rubric) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea no se califica con rúbrica.");
    // Guía: puntaje por criterio (dentro del máximo).
    if (form.kind === "guide" && (r || input.guide)) {
        const picks = form.guide.map((c) => {
            if (r) {
                const x = r.guide.find((y) => y.id === c.id);
                return { c, score: x?.score ?? null, remark: x?.remark ?? "" };
            }
            const req = input.guide!.find((x) => match(x.criterion, c.id, c.shortname));
            if (!req) return { c, score: c.score === "" ? null : Number(c.score.replace(",", ".")), remark: c.remark };
            if (req.score < 0 || (c.max !== null && req.score > c.max)) throw new CampusError("WRITE_NOT_ALLOWED", `El puntaje de «${c.shortname}» va de 0 a ${c.max ?? "?"}.`);
            return { c, score: req.score, remark: req.remark ?? c.remark };
        });
        const unknown = (input.guide ?? []).filter((x) => !form.guide.some((c) => match(x.criterion, c.id, c.shortname)));
        if (unknown.length) throw new CampusError("WRITE_NOT_ALLOWED", `Criterios que la guía no tiene: ${unknown.map((x) => x.criterion).join(", ")}. Tiene: ${form.guide.map((c) => c.shortname).join("; ")}.`);
        if (picks.some((p) => p.score === null)) throw new CampusError("WRITE_NOT_ALLOWED", `Moodle exige un puntaje en cada criterio; falta en: ${picks.filter((p) => p.score === null).map((p) => p.c.shortname).join("; ")}.`);
        for (const p of picks) Object.assign(fields, { [`advancedgrading[criteria][${p.c.id}][score]`]: String(p.score), [`advancedgrading[criteria][${p.c.id}][remark]`]: p.remark });
        want.guide = picks.map((p) => ({ id: p.c.id, score: p.score, remark: comparable(p.remark) }));
    } else if (input.guide) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea no se califica con guía de evaluación.");
    // Comentario: se reenvía siempre (omitirlo podría anularlo).
    const comment = r ? r.comment_html : (input.feedback_html ?? (input.feedback_comment !== undefined ? toHtml(input.feedback_comment, "markdown") : form.comment));
    Object.assign(fields, { "assignfeedbackcomments_editor[text]": comment, "assignfeedbackcomments_editor[format]": "1" });
    want.comment = comparable(comment);
    if (r ? r.workflow !== null && r.workflow !== form.workflow : input.workflow_state !== undefined) {
        if (form.workflow === null) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea no usa flujo de trabajo de calificación.");
        if (form.workflow === "released") throw new CampusError("WRITE_NOT_ALLOWED", "La calificación ya está liberada: su estado no se cambia por esta vía.");
        const state = r ? r.workflow! : input.workflow_state!;
        if (!(WORKFLOW as readonly string[]).includes(state)) throw new CampusError("WRITE_NOT_ALLOWED", "Ese estado no se fija por esta vía (nunca «liberada»).");
        fields.workflowstate = state;
        want.workflow = state;
    } else if (form.workflow === "released") throw new CampusError("WRITE_NOT_ALLOWED", "La calificación ya está liberada: reenviarla la volvería a publicar. No se califica por esta vía.");
    // Archivos de retroalimentación: en el borrador que sirve el formulario.
    const add = r ? [] : (input.add_feedback_file_paths ?? []);
    const remove = r ? r.remove_files : (input.remove_feedback_files ?? []);
    let uploads: PlanItem["uploads"];
    let planFiles: PlanFile[] = [];
    const warnings: string[] = ["Formulario web: requiere la sesión web del Campus. Abrirlo crea un borrador (y, con rúbrica o guía, una instancia de calificación sin completar)."];
    if (add.length || remove.length) {
        if (!form.filesField) throw new CampusError("WRITE_NOT_ALLOWED", "La tarea no tiene archivos de retroalimentación (feedback_files).");
        const missing = remove.filter((n) => !files.includes(n));
        if (missing.length) throw new CampusError("WRITE_NOT_ALLOWED", `Archivos de retroalimentación que no están: ${missing.join(", ")} (están: ${files.join(", ") || "ninguno"}).`);
        if (add.length) {
            planFiles = describeLocalFiles(add, Math.min(MAX_FILE_BYTES, ctx.profile.read_profile.limits.max_file_bytes), 10);
            const dup = planFiles.filter((f) => files.includes(f.filename) && !remove.includes(f.filename));
            if (dup.length) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay archivos con esos nombres: ${dup.map((f) => f.filename).join(", ")} (quitalos con remove_feedback_files).`);
        }
        uploads = { field: form.filesField, files: planFiles, form_draft: { remove } };
        want.files = [...files.filter((n) => !remove.includes(n)), ...planFiles.map((f) => f.filename)].sort();
    }
    const changed = (Object.keys(want) as (keyof Snap)[]).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(prior[k]));
    if (!changed.length) throw new CampusError("WRITE_NOT_ALLOWED", "La calificación ya está así.");
    const ungraded = (await gradeValue(ctx, a.id, input.participant_id)) === null;
    return {
        intent: "grade_advanced",
        capability: "grade_submission",
        course_id: input.course_id,
        base_risk: "R3",
        summary: `${undoOf ? "Deshacer: " : ""}Calificar a ${person.fullname ?? input.participant_id} en «${a.name ?? a.id}» (${form.kind === "points" ? "puntos" : form.kind === "scale" ? "escala" : form.kind === "rubric" ? "rúbrica" : "guía"}): ${changed.join(", ")}.${notify ? " Con aviso al estudiante." : " Sin notificar."}`,
        payload_preview: { assignment: { assignment_id: a.id, name: a.name ?? null, method: form.kind }, participant: { id: person.id, name: person.fullname ?? null }, before: prior, after: { ...prior, ...want }, scale: form.kind === "scale" ? form.scale : undefined, rubric: form.kind === "rubric" ? form.rubric.map((c) => ({ id: c.id, description: c.description, levels: c.levels })) : undefined, guide: form.kind === "guide" ? form.guide.map((c) => ({ id: c.id, shortname: c.shortname, max: c.max })) : undefined, files: planFiles.length ? planFiles.map((f) => ({ filename: f.filename, bytes: f.size })) : undefined },
        side_effects: ["Libro de calificaciones: la nota pasa al ítem de la tarea.", notify ? "Moodle le avisa al estudiante que tiene una calificación nueva (cuenta de prueba del sandbox, ADR-120)." : "SIN notificación al estudiante (sendstudentnotifications=0).", ...(remove.length ? ["Los archivos de retroalimentación quitados se borran (no vuelven con el deshacer)."] : [])],
        preconditions: { description: "La calificación no cambió desde el plan.", versions: { [`gradeform:${a.cmid}:${a.id}:${input.participant_id}`]: JSON.stringify(prior) } },
        undo: ungraded ? { kind: "ninguno", how: "No había nota: Moodle no permite volver a «sin nota» por el formulario.", until: null } : { kind: "compensación", how: "Volver a la nota, los niveles o puntajes, el comentario y el estado anteriores, y quitar los archivos agregados.", until: null },
        warnings,
        items: [
            {
                item_id: "i1",
                description: `Calificar al participante ${input.participant_id}`,
                call: { kind: "form", fn: "assign_grade_classic", params: { query: { id: String(a.cmid), action: "grade", userid: String(input.participant_id), rownum: "0" }, fields } },
                target: { course_id: input.course_id, cmid: a.cmid, assignment_id: a.id, user_id: input.participant_id },
                expected: { want, prior },
                ...(uploads ? { uploads } : {}),
            },
        ],
        prior_state: { grade: form.kind === "points" || form.kind === "scale" ? form.grade || null : null, rubric: prior.rubric.map((c, i) => ({ id: c.id, level: c.level, remark: form.rubric[i]!.remark })), guide: prior.guide.map((c, i) => ({ id: c.id, score: c.score, remark: form.guide[i]!.remark })), comment_html: form.comment, workflow: form.workflow, added_files: planFiles.map((f) => f.filename), ungraded },
        untrusted_fields: ["payload_preview.assignment.name", "payload_preview.participant.name", "payload_preview.before", "payload_preview.rubric", "payload_preview.guide", "payload_preview.scale"],
        teacher_text: Object.fromEntries(Object.entries({ feedback: input.feedback_comment }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    assignment_id: z.number().int().positive().describe("assignment_id (no el course_module_id)."),
    participant_id: z.number().int().positive(),
    grade: z.union([z.number(), z.string().max(255)]).optional().describe("Puntos, o el ítem de la ESCALA (su texto o su valor). Con rúbrica o guía no va: la nota sale de los criterios."),
    rubric: z.array(z.strictObject({ criterion: z.union([z.string().max(2_000), z.number().int()]).describe("Texto del criterio o su id."), level: z.union([z.string().max(2_000), z.number()]).describe("Texto del nivel, su puntaje o su id."), remark: z.string().max(5_000).optional() })).max(30).optional().describe("Rúbrica: un nivel por criterio (los que no se indican quedan como están)."),
    guide: z.array(z.strictObject({ criterion: z.union([z.string().max(255), z.number().int()]).describe("Nombre corto del criterio o su id."), score: z.number().min(0).max(1_000), remark: z.string().max(5_000).optional() })).max(30).optional().describe("Guía de evaluación: puntaje por criterio."),
    feedback_comment: z.string().max(20_000).optional().describe("Comentario de devolución (Markdown). Ausente = se conserva."),
    add_feedback_file_paths: z.array(z.string().min(1).max(1_000)).max(10).optional().describe("Archivos LOCALES de retroalimentación a agregar (sólo en el servidor local)."),
    remove_feedback_files: z.array(z.string().min(1).max(255)).max(20).optional().describe("Nombres de archivos de retroalimentación a quitar."),
    workflow_state: z.enum(WORKFLOW).optional().describe("Flujo de trabajo: notmarked, inmarking, readyforreview, inreview o readyforrelease (nunca released)."),
    notify_student: z.boolean().optional().describe("Avisarle al estudiante (por defecto, el del perfil: no). Sólo si el perfil permite notificarle (cuentas de prueba del sandbox, ADR-115)."),
};

export const gradeAdvancedIntent: WriteIntent<typeof shape> = {
    name: "grade_advanced",
    title: "Plan: calificar con escala, rúbrica o guía, y archivos de retroalimentación",
    description: "Arma el plan para calificar a UN participante por el formulario completo de la tarea: puntos o escala, rúbrica (nivel por criterio) o guía (puntaje por criterio), comentario, archivos de retroalimentación y estado del flujo de trabajo. Nunca notifica al estudiante. La vista previa muestra la escala, la rúbrica o la guía. No escribe.",
    inputShape: shape,
    capability: "grade_submission",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: (input, ctx) => build(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const p = plan.prior_state as { grade: string | null; rubric: { id: number; level: number | null; remark: string }[]; guide: { id: number; score: number | null; remark: string }[]; comment_html: string; workflow: string | null; added_files: string[]; ungraded: boolean };
        if (p.ungraded) return { kind: "ninguno", reason: "No había nota antes: Moodle no permite volver a «sin nota» por el formulario." };
        const t = plan.items[0]!.target;
        return { kind: "plan", draft: await build({ course_id: plan.course_id, assignment_id: Number(t.assignment_id), participant_id: Number(t.user_id), restore: { grade: p.grade, rubric: p.rubric, guide: p.guide, comment_html: p.comment_html, workflow: p.workflow, remove_files: p.added_files } }, ctx, result.action_id) };
    },
};
