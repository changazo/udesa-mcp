import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * W4 · Estructura del curso por sesión web (directiva §8.9; investigación [C] §1 y §9.1):
 * mostrar u ocultar actividades y secciones, mover actividades y renombrar actividades o secciones.
 * Sólo tuplas AJAX allowlisteadas (cm_show/cm_hide/section_show/section_hide/cm_move y
 * inplace_editable activityname/sectionname), una por ítem. Verificación con core_course_get_contents
 * (no con el código de retorno: update_course puede fallar con el cambio ya aplicado [C §1.4]).
 * Ninguna de estas operaciones notifica a los participantes.
 */

const ContentsSchema = z.array(
    z.object({
        id: z.number().int(),
        section: z.number().nullable().optional(),
        name: z.string().nullable().optional(),
        visible: z.number().nullable().optional(),
        component: z.string().nullable().optional(),
        modules: z.array(z.object({ id: z.number().int().positive(), modname: z.string(), name: z.string().nullable().optional(), visible: z.number().nullable().optional() })).default([]),
    }),
);
type Section = z.infer<typeof ContentsSchema>[number];
const CourseFormatSchema = z.object({ courses: z.array(z.object({ id: z.number().int(), format: z.string().nullable().optional() })) });

async function contents(ctx: IntentContext, courseId: number): Promise<Section[]> {
    return ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema);
}

function locateCm(sections: Section[], cmid: number) {
    for (const s of sections) {
        const i = s.modules.findIndex((m) => m.id === cmid);
        if (i >= 0) return { section: s, index: i, module: s.modules[i]! };
    }
    return null;
}

const sectionByNumber = (sections: Section[], n: number) => sections.find((s) => s.section === n) ?? null;

// ---------- versiones ----------

/** `cm:<cmid>` → «sección:posición:visible:nombre» · `section:<número>` → «visible:nombre». */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const c = await contents(ctx, plan.course_id);
    const out: Record<string, string | null> = {};
    for (const key of Object.keys(plan.preconditions.versions)) {
        const [k, v] = key.split(":");
        if (k === "cm") {
            const l = locateCm(c, Number(v));
            out[key] = l ? `${l.section.section}:${l.index}:${l.module.visible ?? 1}:${l.module.name ?? ""}` : null;
        } else if (k === "section") {
            const s = sectionByNumber(c, Number(v));
            out[key] = s ? `${s.visible ?? 1}:${s.name ?? ""}` : null;
        } else out[key] = null;
    }
    return out;
}

function interpret(): Interpretation {
    // update_course devuelve el estado; inplace_editable, el elemento renderizado. El éxito lo decide la relectura.
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const c = await contents(ctx, plan.course_id);
    const t = item.target;
    const x = item.expected;
    const p = item.call.params as Record<string, unknown>;
    const result = (field: string, expected: unknown, observed: unknown, prior: unknown): ItemVerification =>
        observed === expected
            ? { outcome: "coincide", checked: [field], differences: [] }
            : { outcome: observed === prior ? "sin_efecto" : "difiere", checked: [field], differences: [{ field, expected, observed }] };
    if (t.kind === "cm") {
        const l = locateCm(c, Number(t.cmid));
        if (!l) return { outcome: "difiere", checked: ["actividad"], differences: [{ field: "actividad", expected: "existe", observed: "no está en el curso" }] };
        if (p.action === "cm_move") {
            const okSection = l.section.section === x.section;
            const next = l.section.modules[l.index + 1]?.id ?? null;
            const okPlace = x.before_cmid === undefined || x.before_cmid === null || next === x.before_cmid;
            if (okSection && okPlace) return { outcome: "coincide", checked: ["section", "position"], differences: [] };
            return { outcome: l.section.section === x.prior_section ? "sin_efecto" : "difiere", checked: ["section", "position"], differences: [{ field: "section", expected: x.section, observed: l.section.section }, ...(okPlace ? [] : [{ field: "before_cmid", expected: x.before_cmid, observed: next }])] };
        }
        if (p.itemtype === "activityname") return result("name", x.name, l.module.name ?? null, x.prior_name);
        return result("visible", x.visible, (l.module.visible ?? 1) === 1, x.prior_visible);
    }
    const s = sectionByNumber(c, Number(t.section));
    if (!s) return { outcome: "difiere", checked: ["sección"], differences: [{ field: "sección", expected: "existe", observed: "no existe" }] };
    if (p.itemtype === "sectionname") return result("name", x.name, s.name ?? null, x.prior_name);
    return result("visible", x.visible, (s.visible ?? 1) === 1, x.prior_visible);
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };
const appliedIds = (result: { items: { item_id: string; outcome: string }[] }) => new Set(result.items.filter((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido").map((r) => r.item_id));

function draft(base: Omit<PlanDraft, "prior_state" | "untrusted_fields" | "teacher_text" | "warnings"> & Partial<Pick<PlanDraft, "prior_state" | "untrusted_fields" | "teacher_text" | "warnings">>): PlanDraft {
    return { prior_state: {}, untrusted_fields: [], teacher_text: {}, warnings: [], ...base };
}

// ---------- mostrar u ocultar ----------

const visibilityShape = {
    course_id: z.number().int().positive(),
    course_module_ids: z.array(z.number().int().positive()).max(10).optional(),
    section_numbers: z.array(z.number().int().min(1).max(200)).max(10).optional().describe("Secciones (la 0, General, no se puede ocultar)."),
    visible: z.boolean().describe("true muestra, false oculta."),
};
type VisibilityInput = z.infer<z.ZodObject<typeof visibilityShape>>;

async function buildVisibility(input: VisibilityInput, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const cms = input.course_module_ids ?? [];
    const secs = input.section_numbers ?? [];
    if (!cms.length && !secs.length) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá actividades o secciones.");
    const c = await contents(ctx, input.course_id);
    const items: PlanItem[] = [];
    const versions: Record<string, string> = {};
    const preview: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    for (const n of secs) {
        if (n === 0) throw new CampusError("WRITE_NOT_ALLOWED", "La sección 0 (General) no se puede ocultar.");
        const s = sectionByNumber(c, n);
        if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${n} no existe en el curso.`);
        if (s.component) throw new CampusError("WRITE_NOT_ALLOWED", `La sección ${n} es una subsección: se maneja desde su actividad.`);
        const cur = (s.visible ?? 1) === 1;
        versions[`section:${n}`] = `${s.visible ?? 1}:${s.name ?? ""}`;
        if (cur === input.visible) continue;
        if (!input.visible) warnings.push(`Ocultar la sección ${n} oculta también sus ${s.modules.length} actividad(es); mostrarla después restaura su visibilidad previa.`);
        preview.push({ section: n, name: s.name ?? null, from: cur, to: input.visible });
        items.push({
            item_id: `i${items.length + 1}`,
            description: `${input.visible ? "Mostrar" : "Ocultar"} la sección ${n}`,
            call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: input.visible ? "section_show" : "section_hide", courseid: input.course_id, ids: [s.id] } },
            target: { course_id: input.course_id, kind: "section", section: n, section_id: s.id },
            expected: { visible: input.visible, prior_visible: cur },
        });
    }
    for (const cmid of cms) {
        const l = locateCm(c, cmid);
        if (!l) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso.`);
        const cur = (l.module.visible ?? 1) === 1;
        versions[`cm:${cmid}`] = `${l.section.section}:${l.index}:${l.module.visible ?? 1}:${l.module.name ?? ""}`;
        if (cur === input.visible) continue;
        if (input.visible && (l.section.visible ?? 1) !== 1) warnings.push(`La actividad ${cmid} está en una sección oculta: aunque se muestre, los estudiantes no la ven hasta que se muestre la sección.`);
        preview.push({ course_module_id: cmid, name: l.module.name ?? null, type: l.module.modname, from: cur, to: input.visible });
        items.push({
            item_id: `i${items.length + 1}`,
            description: `${input.visible ? "Mostrar" : "Ocultar"} la actividad ${cmid}`,
            call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: input.visible ? "cm_show" : "cm_hide", courseid: input.course_id, ids: [cmid] } },
            target: { course_id: input.course_id, kind: "cm", cmid },
            expected: { visible: input.visible, prior_visible: cur },
        });
    }
    if (!items.length) throw new CampusError("WRITE_NOT_ALLOWED", "Ya está todo en ese estado: no hay nada que escribir.");
    return draft({
        intent: "visibility",
        capability: "course_visibility",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}${input.visible ? "mostrar" : "ocultar"} ${items.length} elemento(s) del curso.`,
        payload_preview: { changes: preview },
        side_effects: [input.visible ? "Los estudiantes pasan a ver estos elementos (sin aviso por correo)." : "Los estudiantes dejan de ver estos elementos.", "También cambia la visibilidad de sus eventos de calendario e ítems de calificación."],
        preconditions: { description: "Ningún elemento cambió desde el plan.", versions },
        undo: { kind: "exacto", how: "La operación inversa.", until: null },
        warnings,
        items,
        untrusted_fields: ["payload_preview.changes[].name"],
        undo_of: undoOf,
    });
}

export const visibilityIntent: WriteIntent<typeof visibilityShape> = {
    name: "visibility",
    title: "Plan: mostrar u ocultar actividades o secciones",
    description: "Arma el plan para mostrar u ocultar actividades (course_module_id) o secciones del curso. No escribe. Sin notificaciones.",
    inputShape: visibilityShape,
    capability: "course_visibility",
    synthetic_only: false,
    ...common,
    plan: (input, ctx) => buildVisibility(input, ctx, null),
    async undo(plan, result, ctx) {
        const ids = appliedIds(result);
        const items = plan.items.filter((i) => ids.has(i.item_id));
        if (!items.length) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const visible = items[0]!.expected.visible === true;
        return {
            kind: "plan",
            draft: await buildVisibility(
                { course_id: plan.course_id, visible: !visible, course_module_ids: items.filter((i) => i.target.kind === "cm").map((i) => Number(i.target.cmid)), section_numbers: items.filter((i) => i.target.kind === "section").map((i) => Number(i.target.section)) },
                ctx,
                result.action_id,
            ),
        };
    },
};

// ---------- mover ----------

const moveShape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive(),
    to_section: z.number().int().min(0).max(200).describe("Número de sección destino (existente)."),
    before_course_module_id: z.number().int().positive().optional().describe("Ubicarla antes de esta actividad de la sección destino; si no, al final."),
};
type MoveInput = z.infer<z.ZodObject<typeof moveShape>>;

async function buildMove(input: MoveInput, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const c = await contents(ctx, input.course_id);
    const l = locateCm(c, input.course_module_id);
    if (!l) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${input.course_module_id} no es del curso.`);
    const dest = sectionByNumber(c, input.to_section);
    if (!dest) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.to_section} no existe (no se crean secciones).`);
    if (input.before_course_module_id !== undefined) {
        if (input.before_course_module_id === input.course_module_id) throw new CampusError("WRITE_NOT_ALLOWED", "No se puede ubicar una actividad antes de sí misma.");
        if (!dest.modules.some((m) => m.id === input.before_course_module_id)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "La actividad de referencia no está en la sección destino.");
    }
    const next = l.section.modules[l.index + 1]?.id ?? null;
    const isLast = l.section.modules.length - 1 === l.index;
    const samePlace = l.section.section === input.to_section && (input.before_course_module_id === undefined ? isLast : next === input.before_course_module_id);
    if (samePlace) throw new CampusError("WRITE_NOT_ALLOWED", "La actividad ya está en ese lugar.");
    const warnings: string[] = [];
    if ((dest.visible ?? 1) !== 1 && (l.module.visible ?? 1) === 1) warnings.push("La sección destino está oculta: Moodle va a OCULTAR la actividad al moverla.");
    if ((dest.visible ?? 1) === 1 && (l.module.visible ?? 1) !== 1) warnings.push("La actividad está oculta y la sección destino es visible: Moodle puede restaurar su visibilidad previa.");
    const params: Record<string, number | string | number[]> = input.before_course_module_id !== undefined ? { action: "cm_move", courseid: input.course_id, ids: [input.course_module_id], targetcmid: input.before_course_module_id } : { action: "cm_move", courseid: input.course_id, ids: [input.course_module_id], targetsectionid: dest.id };
    return draft({
        intent: "move_activity",
        capability: "move_content",
        course_id: input.course_id,
        base_risk: "R1",
        summary: `${undoOf ? "Deshacer: " : ""}mover la actividad ${input.course_module_id} de la sección ${l.section.section} a la ${input.to_section}${input.before_course_module_id ? ` (antes de ${input.before_course_module_id})` : " (al final)"}.`,
        payload_preview: { activity: { course_module_id: input.course_module_id, name: l.module.name ?? null }, from: { section: l.section.section, before: next }, to: { section: input.to_section, before: input.before_course_module_id ?? null } },
        side_effects: ["Cambia el orden de la página del curso. Sin notificaciones."],
        preconditions: { description: "La actividad no cambió de lugar desde el plan.", versions: { [`cm:${input.course_module_id}`]: `${l.section.section}:${l.index}:${l.module.visible ?? 1}:${l.module.name ?? ""}` } },
        undo: { kind: "exacto", how: "Volver a moverla a su lugar anterior.", until: null },
        warnings,
        items: [
            {
                item_id: "i1",
                description: `Mover la actividad ${input.course_module_id}`,
                call: { kind: "ajax", fn: "core_courseformat_update_course", params },
                target: { course_id: input.course_id, kind: "cm", cmid: input.course_module_id },
                expected: { section: input.to_section, before_cmid: input.before_course_module_id ?? null, prior_section: l.section.section, prior_before: next },
            },
        ],
        untrusted_fields: ["payload_preview.activity.name"],
        undo_of: undoOf,
    });
}

export const moveIntent: WriteIntent<typeof moveShape> = {
    name: "move_activity",
    title: "Plan: mover una actividad",
    description: "Arma el plan para mover una actividad a otra sección existente (al final o antes de otra actividad). No escribe.",
    inputShape: moveShape,
    capability: "move_content",
    synthetic_only: false,
    ...common,
    plan: (input, ctx) => buildMove(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!appliedIds(result).size) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const x = plan.items[0]!.expected;
        const c = await contents(ctx, plan.course_id);
        const prior = sectionByNumber(c, Number(x.prior_section));
        const before = typeof x.prior_before === "number" && prior?.modules.some((m) => m.id === x.prior_before) ? x.prior_before : undefined;
        return { kind: "plan", draft: await buildMove({ course_id: plan.course_id, course_module_id: Number(plan.items[0]!.target.cmid), to_section: Number(x.prior_section), before_course_module_id: before }, ctx, result.action_id) };
    },
};

// ---------- renombrar ----------

const renameShape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().optional(),
    section_number: z.number().int().min(0).max(200).optional(),
    name: z.string().min(1).max(255),
};
type RenameInput = z.infer<z.ZodObject<typeof renameShape>>;

async function buildRename(input: RenameInput, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    if ((input.course_module_id === undefined) === (input.section_number === undefined)) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá course_module_id o section_number (uno de los dos).");
    const name = input.name.trim();
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) throw new CampusError("WRITE_NOT_ALLOWED", "El nombre está vacío o tiene caracteres de control (Moodle ignora los vacíos en silencio).");
    const c = await contents(ctx, input.course_id);
    let item: PlanItem;
    let versions: Record<string, string>;
    let prior: string;
    if (input.course_module_id !== undefined) {
        const l = locateCm(c, input.course_module_id);
        if (!l) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${input.course_module_id} no es del curso.`);
        // El nombre de una tarea de Turnitin se sincroniza con el servicio externo (ADR-083).
        if (l.module.modname === "turnitintooltwo") throw new CampusError("WRITE_NOT_ALLOWED", "Turnitin no se renombra por esta vía: su nombre se sincroniza con el servicio externo.");
        prior = l.module.name ?? "";
        versions = { [`cm:${input.course_module_id}`]: `${l.section.section}:${l.index}:${l.module.visible ?? 1}:${prior}` };
        item = {
            item_id: "i1",
            description: `Renombrar la actividad ${input.course_module_id}`,
            call: { kind: "ajax", fn: "core_update_inplace_editable", params: { component: "core_course", itemtype: "activityname", itemid: String(input.course_module_id), value: name } },
            target: { course_id: input.course_id, kind: "cm", cmid: input.course_module_id },
            expected: { name, prior_name: prior },
        };
    } else {
        const s = sectionByNumber(c, input.section_number!);
        if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.section_number} no existe.`);
        if (s.component) throw new CampusError("WRITE_NOT_ALLOWED", "Es una subsección: se renombra desde su actividad.");
        const course = await ctx.read.session.transport.call("core_course_get_courses_by_field", { field: "id", value: String(input.course_id) }, CourseFormatSchema);
        const format = course.courses.find((x) => x.id === input.course_id)?.format;
        if (!format || !/^[a-z][a-z0-9_]{0,40}$/.test(format)) throw new CampusError("UNEXPECTED_RESPONSE", "No se pudo determinar el formato del curso.");
        prior = s.name ?? "";
        versions = { [`section:${input.section_number}`]: `${s.visible ?? 1}:${prior}` };
        item = {
            item_id: "i1",
            description: `Renombrar la sección ${input.section_number}`,
            // El componente es el del FORMATO del curso, no core_course [C §9.1].
            call: { kind: "ajax", fn: "core_update_inplace_editable", params: { component: `format_${format}`, itemtype: "sectionname", itemid: String(s.id), value: name } },
            target: { course_id: input.course_id, kind: "section", section: input.section_number!, section_id: s.id },
            expected: { name, prior_name: prior },
        };
    }
    if (prior === name) throw new CampusError("WRITE_NOT_ALLOWED", "Ya tiene ese nombre (Moodle no haría nada).");
    return draft({
        intent: "rename",
        capability: "rename_content",
        course_id: input.course_id,
        base_risk: "R1",
        summary: `${undoOf ? "Deshacer: " : ""}renombrar ${input.course_module_id !== undefined ? `la actividad ${input.course_module_id}` : `la sección ${input.section_number}`}: «${prior}» → «${name}».`,
        payload_preview: { from: prior, to: name },
        side_effects: input.course_module_id !== undefined ? ["También renombra su ítem de calificación y sus eventos de calendario. Sin notificaciones."] : ["Cambia el título de la sección en la página del curso. Sin notificaciones."],
        preconditions: { description: "El elemento no cambió desde el plan.", versions },
        undo: { kind: "exacto", how: "Volver al nombre anterior.", until: null },
        items: [item],
        untrusted_fields: ["payload_preview.from"],
        teacher_text: { name },
        undo_of: undoOf,
    });
}

export const renameIntent: WriteIntent<typeof renameShape> = {
    name: "rename",
    title: "Plan: renombrar una actividad o una sección",
    description: "Arma el plan para renombrar una actividad (course_module_id) o una sección (section_number) del curso. No escribe.",
    inputShape: renameShape,
    capability: "rename_content",
    synthetic_only: false,
    ...common,
    plan: (input, ctx) => buildRename(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!appliedIds(result).size) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const t = plan.items[0]!.target;
        const prior = String(plan.items[0]!.expected.prior_name);
        if (!prior.trim()) return { kind: "ninguno", reason: "El nombre anterior estaba vacío (nombre por defecto): no se puede volver por esta vía." };
        return { kind: "plan", draft: await buildRename({ course_id: plan.course_id, ...(t.kind === "cm" ? { course_module_id: Number(t.cmid) } : { section_number: Number(t.section) }), name: prior }, ctx, result.action_id) };
    },
};

export const LAYOUT_INTENTS = [visibilityIntent, moveIntent, renameIntent];
