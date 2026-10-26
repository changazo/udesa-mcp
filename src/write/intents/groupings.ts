import { z } from "zod";
import { CampusError } from "../../errors.js";
import { GroupingsSchema, GroupsSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import { assertIdnumberEditable } from "./idnumber.js";

/**
 * W6 · Agrupamientos (directiva §8.11; investigación [C] §5; ADR-074).
 * - Crear: formulario `/group/grouping.php?courseid`. Deshacer: borrarlo (POST `delete=1&confirm=1`)
 *   mientras no tenga grupos (si los tiene, las actividades restringidas a él cambian de alcance).
 * - Grupos de un agrupamiento: `/group/assign.php?id=<agrupamiento>` (un POST por grupo, `add` con
 *   `addselect[]` o `remove` con `removeselect[]`). La página vuelve a mostrarse (200): se verifica releyendo.
 * Lecturas: `core_group_get_course_groupings` y la misma página assign.php (grupos actuales).
 */

export async function groupingsOf(ctx: IntentContext, courseId: number) {
    return (await ctx.read.session.transport.call("core_group_get_course_groupings", { courseid: courseId }, GroupingsSchema)).filter((g) => g.courseid === courseId);
}

/** Grupos que ya están en el agrupamiento (lista removeselect de assign.php). Irreconocible → null. */
export function parseGroupingMembers(html: string): number[] | null {
    const sel = /<select[^>]*(?:name="removeselect\[\]"|id="removeselect")[^>]*>([\s\S]*?)<\/select>/.exec(html);
    if (!sel) return null;
    // Moodle sirve los ids con un punto final (value="12345."). Una opción con otro formato hace la página
    // irreconocible: nunca se la lee como «sin grupos» (eso habilitaría el borrado del agrupamiento).
    // Con la lista vacía Moodle pone un relleno sin value (<option>&nbsp;</option>): ése se ignora.
    const options = [...sel[1]!.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)]
        .filter((m) => !(!/\bvalue=/.test(m[1]!) && /^(\s|&nbsp;)*$/.test(m[2]!)))
        .map((m) => /value="(\d+)\.?"/.exec(m[1]!)?.[1]);
    if (options.some((v) => v === undefined)) return null;
    return options.map(Number).sort((a, b) => a - b);
}

/** Grupos que tiene hoy el agrupamiento (también lo usa el borrado de un agrupamiento con sus grupos, ADR-119). */
export async function membersOf(ctx: IntentContext, groupingId: number): Promise<number[]> {
    const m = parseGroupingMembers(await ctx.web.readPage("grouping_assign", { id: String(groupingId) }));
    if (!m) throw new CampusError("UNEXPECTED_RESPONSE", "No se reconoció la página de grupos del agrupamiento.");
    return m;
}

const key = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join(",");

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, a] = k.split(":");
        if (kind === "groupings") out[k] = key((await groupingsOf(ctx, Number(a))).map((g) => g.id));
        else if (kind === "gmembers") out[k] = key(await membersOf(ctx, Number(a)));
        else out[k] = null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected;
    if (item.call.fn === "course_grouping_add") {
        const prior = new Set(x.prior_ids as number[]);
        const g = (await groupingsOf(ctx, plan.course_id)).find((y) => !prior.has(y.id) && y.name === x.name);
        if (!g) return { outcome: "sin_efecto", checked: ["agrupamiento"], differences: [{ field: "agrupamiento", expected: "creado", observed: "no aparece" }] };
        const differences = (g.idnumber ?? "") === x.idnumber ? [] : [{ field: "idnumber", expected: x.idnumber, observed: g.idnumber ?? null }];
        return { outcome: differences.length ? "difiere" : "coincide", checked: ["name", "idnumber"], differences, moodle_ids: { grouping_id: g.id } };
    }
    if (item.call.fn === "course_grouping_delete") {
        const still = (await groupingsOf(ctx, plan.course_id)).some((g) => g.id === Number(t.grouping_id));
        return still ? { outcome: "sin_efecto", checked: ["agrupamiento"], differences: [{ field: "agrupamiento", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["agrupamiento"], differences: [] };
    }
    // Agregar o quitar UN grupo.
    const inside = (await membersOf(ctx, Number(t.grouping_id))).includes(Number(t.group_id));
    const want = x.member === true;
    return inside === want ? { outcome: "coincide", checked: ["grupo"], differences: [] } : { outcome: "sin_efecto", checked: ["grupo"], differences: [{ field: `grupo ${t.group_id}`, expected: want ? "en el agrupamiento" : "fuera", observed: inside ? "en el agrupamiento" : "fuera" }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };

// ---------- crear ----------

const createShape = {
    course_id: z.number().int().positive(),
    name: z.string().min(1).max(254),
    idnumber: z.string().max(100).optional(),
    description: z.string().max(5_000).optional(),
};

export const createGroupingIntent: WriteIntent<typeof createShape> = {
    name: "create_grouping",
    title: "Plan: crear un agrupamiento",
    description: "Arma el plan para crear un agrupamiento VACÍO (para juntar grupos; los grupos se ponen con campus_plan_grouping_groups). No escribe.",
    inputShape: createShape,
    capability: "manage_groups",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const name = input.name.trim();
        const idnumber = (input.idnumber ?? "").trim();
        const existing = await groupingsOf(ctx, input.course_id);
        if (existing.some((g) => (g.name ?? "").trim().toLowerCase() === name.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay un agrupamiento «${name}».`);
        if (idnumber && existing.some((g) => g.idnumber === idnumber)) throw new CampusError("WRITE_NOT_ALLOWED", `El número de ID «${idnumber}» ya lo usa otro agrupamiento.`);
        if (idnumber) await assertIdnumberEditable(ctx, "grouping_form_new", { courseid: String(input.course_id) }, "_qf__grouping_form", "los agrupamientos");
        const html = input.description ? toHtml(input.description, "markdown") : "";
        return {
            intent: "create_grouping",
            capability: "manage_groups",
            course_id: input.course_id,
            base_risk: "R1",
            summary: `Crear el agrupamiento vacío «${name}».`,
            payload_preview: { name, idnumber, description_html: html },
            side_effects: ["Crea el agrupamiento, sin grupos: no cambia el acceso de nadie.", "Sin notificaciones."],
            preconditions: { description: "Los agrupamientos no cambiaron desde el plan.", versions: { [`groupings:${input.course_id}`]: key(existing.map((g) => g.id)) } },
            undo: { kind: "exacto", how: "Borrar el agrupamiento mientras no tenga grupos.", until: null },
            warnings: ["Formulario web: requiere la sesión web del Campus."],
            items: [
                {
                    item_id: "i1",
                    description: `Nuevo agrupamiento «${name}»`,
                    call: { kind: "form", fn: "course_grouping_add", params: { query: { courseid: String(input.course_id) }, fields: { name, idnumber, "description_editor[text]": html, "description_editor[format]": "1" } } },
                    target: { course_id: input.course_id },
                    expected: { name, idnumber, description_text: comparable(html), prior_ids: existing.map((g) => g.id) },
                },
            ],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: { name, ...(input.description ? { description: input.description } : {}) },
            undo_of: null,
        };
    },
    async undo(plan, result, ctx) {
        const id = result.items.find((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")?.moodle_ids.grouping_id;
        if (!id) return { kind: "ninguno", reason: "No se conoce el agrupamiento creado." };
        const members = await membersOf(ctx, id);
        if (members.length) return { kind: "ninguno", reason: `El agrupamiento ya tiene ${members.length} grupo(s): quitálos primero (campus_plan_grouping_groups).` };
        const draft: PlanDraft = {
            intent: "create_grouping",
            capability: "manage_groups",
            course_id: plan.course_id,
            base_risk: "R2",
            summary: `Deshacer: borrar el agrupamiento vacío ${id}.`,
            payload_preview: { delete_grouping: id },
            side_effects: ["Borra el agrupamiento (sin grupos). Las actividades que lo usaran pierden esa restricción."],
            preconditions: { description: "El agrupamiento sigue sin grupos.", versions: { [`gmembers:${id}`]: "" } },
            undo: { kind: "ninguno", how: "Se puede volver a crear.", until: null },
            warnings: [],
            items: [{ item_id: "i1", description: `Borrar el agrupamiento ${id}`, call: { kind: "form", fn: "course_grouping_delete", params: { query: {}, fields: { id: String(id), delete: "1", confirm: "1" } } }, target: { course_id: plan.course_id, grouping_id: id }, expected: { deleted: true } }],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: {},
            undo_of: result.action_id,
        };
        return { kind: "plan", draft };
    },
};

// ---------- grupos del agrupamiento ----------

const groupsShape = {
    course_id: z.number().int().positive(),
    grouping_id: z.number().int().positive(),
    group_ids: z.array(z.number().int().positive()).max(50).describe("Conjunto COMPLETO de grupos que va a tener el agrupamiento ([] = ninguno)."),
};

function groupsDraft(courseId: number, grouping: { id: number; name: string | null }, before: number[], after: number[], names: Map<number, string>, undoOf: string | null): PlanDraft {
    const add = after.filter((g) => !before.includes(g));
    const remove = before.filter((g) => !after.includes(g));
    const label = (ids: number[]) => (ids.length ? ids.map((g) => `«${names.get(g) ?? g}»`).join(", ") : "ninguno");
    return {
        intent: "grouping_groups",
        capability: "manage_groups",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Grupos del agrupamiento «${grouping.name ?? grouping.id}»: ${label(after)} (antes: ${label(before)}).`,
        payload_preview: { grouping: { id: grouping.id, name: grouping.name }, before, after, add, remove },
        side_effects: ["Cambia qué estudiantes alcanzan las actividades restringidas a este agrupamiento. Sin notificaciones."],
        preconditions: { description: "Los grupos del agrupamiento no cambiaron desde el plan.", versions: { [`gmembers:${grouping.id}`]: key(before) } },
        undo: { kind: "exacto", how: "Volver al conjunto anterior.", until: null },
        warnings: [],
        items: [
            ...add.map((g, i) => ({ item_id: `a${i + 1}`, description: `Agregar el grupo ${g}`, call: { kind: "form" as const, fn: "grouping_assign_add", params: { query: { id: String(grouping.id) }, fields: { "addselect[]": String(g), add: "1" } } }, target: { course_id: courseId, grouping_id: grouping.id, group_id: g }, expected: { member: true } })),
            ...remove.map((g, i) => ({ item_id: `r${i + 1}`, description: `Quitar el grupo ${g}`, call: { kind: "form" as const, fn: "grouping_assign_remove", params: { query: { id: String(grouping.id) }, fields: { "removeselect[]": String(g), remove: "1" } } }, target: { course_id: courseId, grouping_id: grouping.id, group_id: g }, expected: { member: false } })),
        ],
        prior_state: { groups: before },
        untrusted_fields: ["payload_preview.grouping.name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const groupingGroupsIntent: WriteIntent<typeof groupsShape> = {
    name: "grouping_groups",
    title: "Plan: grupos de un agrupamiento",
    description: "Arma el plan para fijar el conjunto de grupos de un agrupamiento del curso (agrega y quita respecto del actual). No escribe.",
    inputShape: groupsShape,
    capability: "manage_groups",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const grouping = (await groupingsOf(ctx, input.course_id)).find((g) => g.id === input.grouping_id);
        if (!grouping) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El agrupamiento ${input.grouping_id} no es del curso.`);
        const groups = (await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: input.course_id }, GroupsSchema)).filter((g) => g.courseid === input.course_id);
        const names = new Map(groups.map((g) => [g.id, g.name ?? String(g.id)] as const));
        const unknown = input.group_ids.filter((g) => !names.has(g));
        if (unknown.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Grupos que no son del curso: ${unknown.join(", ")}.`);
        const after = [...new Set(input.group_ids)].sort((a, b) => a - b);
        const before = await membersOf(ctx, grouping.id);
        if (key(after) === key(before)) throw new CampusError("WRITE_NOT_ALLOWED", "El agrupamiento ya tiene exactamente esos grupos.");
        return groupsDraft(input.course_id, { id: grouping.id, name: grouping.name ?? null }, before, after, names, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const p = plan.payload_preview as { grouping: { id: number; name: string | null }; before: number[] };
        const now = await membersOf(ctx, p.grouping.id);
        if (key(now) === key(p.before)) return { kind: "ninguno", reason: "El agrupamiento ya tiene sus grupos anteriores." };
        const names = new Map((await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: plan.course_id }, GroupsSchema)).map((g) => [g.id, g.name ?? String(g.id)] as const));
        return { kind: "plan", draft: groupsDraft(plan.course_id, p.grouping, now, p.before, names, result.action_id) };
    },
};

export const GROUPING_INTENTS = [createGroupingIntent, groupingGroupsIntent];
