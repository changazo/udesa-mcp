import { z } from "zod";
import { CampusError } from "../../errors.js";
import { EnrolledUsersSchema, GroupsSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";
import type { FormSubmission } from "../web.js";
import { assertIdnumberEditable } from "./idnumber.js";
import { groupingsOf, membersOf as groupingGroupIds } from "./groupings.js";

/**
 * W6 · Grupos (directiva §8.11; investigación [C] §5, ADR-058).
 * - Crear un grupo: formulario `/group/group.php`, sin mensajería de grupo (no crea conversación) y sin
 *   clave de matriculación. Deshacer: borrarlo por `/group/delete.php`, sólo si sigue SIN miembros
 *   (borrar un grupo con miembros es R4: cambia el acceso y destruye su conversación).
 * - Membresías de un participante: `core_update_inplace_editable` `core_group/user_groups`, que
 *   REEMPLAZA el conjunto de grupos (agrega y quita). El plan muestra antes y después; las membresías
 *   protegidas (de plugins de matriculación) Moodle no las quita, y la verificación lo marca.
 * - Borrar un grupo (ADR-108): `/group/delete.php`, con `confirm_name`. Con miembros es R4 (capacidad
 *   `delete_content`): cambia el acceso y destruye su conversación. Deshacer: recrearlo con su nombre,
 *   número de ID y descripción; los miembros se vuelven a agregar con `campus_plan_group_members`.
 * Ningún cambio de grupos manda correo.
 */

async function groupsOf(ctx: IntentContext, courseId: number) {
    return (await ctx.read.session.transport.call("core_group_get_course_groups", { courseid: courseId }, GroupsSchema)).filter((g) => g.courseid === courseId);
}

async function usersOf(ctx: IntentContext, courseId: number) {
    return ctx.read.session.transport.call("core_enrol_get_enrolled_users", { courseid: courseId }, EnrolledUsersSchema);
}

async function membersOf(ctx: IntentContext, courseId: number, groupId: number): Promise<number> {
    return (await usersOf(ctx, courseId)).filter((u) => (u.groups ?? []).some((g) => g.id === groupId)).length;
}

async function userGroups(ctx: IntentContext, courseId: number, userId: number): Promise<number[] | null> {
    const u = (await usersOf(ctx, courseId)).find((x) => x.id === userId);
    return u ? (u.groups ?? []).map((g) => g.id).sort((a, b) => a - b) : null;
}

const key = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join(",");

// ---------- versiones, interpretación y verificación ----------

/** `groups:<curso>` (ids) · `members:<curso>:<usuario>` (ids de sus grupos) · `groupsize:<curso>:<grupo>`. */
async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, a, b] = k.split(":");
        if (kind === "groups") out[k] = key((await groupsOf(ctx, Number(a))).map((g) => g.id));
        else if (kind === "members") {
            const g = await userGroups(ctx, Number(a), Number(b));
            out[k] = g ? key(g) : null;
        } else if (kind === "groupsize") out[k] = (await groupsOf(ctx, Number(a))).some((g) => g.id === Number(b)) ? await membersOf(ctx, Number(a), Number(b)) : null;
        else out[k] = null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    if (item.call.fn === "course_group_add") {
        const id = /\/group\/index\.php\?(?:.*&)?group=(\d+)/.exec((data as FormSubmission | null)?.location ?? "")?.[1];
        return id ? { ok: true, moodle_ids: { group_id: Number(id) } } : { ok: true };
    }
    // inplace_editable devuelve el elemento renderizado; borrar redirige. Decide la relectura.
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const x = item.expected;
    const t = item.target;
    switch (item.call.fn) {
        case "course_group_add": {
            const groups = await groupsOf(ctx, plan.course_id);
            const prior = new Set(x.prior_group_ids as number[]);
            const g = known.group_id ? groups.find((y) => y.id === known.group_id) : groups.find((y) => !prior.has(y.id) && y.name === x.name);
            if (!g) return { outcome: "sin_efecto", checked: ["grupo"], differences: [{ field: "grupo", expected: "creado", observed: "no aparece" }] };
            const differences = [
                ...(g.name === x.name ? [] : [{ field: "name", expected: x.name, observed: g.name ?? null }]),
                ...((g.idnumber ?? "") === x.idnumber ? [] : [{ field: "idnumber", expected: x.idnumber, observed: g.idnumber ?? null }]),
                ...(comparable(g.description) === x.description_text ? [] : [{ field: "description", expected: x.description_text, observed: comparable(g.description) }]),
            ];
            return { outcome: differences.length ? "difiere" : "coincide", checked: ["name", "idnumber", "description"], differences, moodle_ids: { group_id: g.id } };
        }
        case "course_grouping_delete": {
            const still = (await groupingsOf(ctx, plan.course_id)).some((g) => g.id === Number(t.grouping_id));
            return still ? { outcome: "sin_efecto", checked: ["agrupamiento"], differences: [{ field: "agrupamiento", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["agrupamiento"], differences: [] };
        }
        case "course_group_delete": {
            const still = (await groupsOf(ctx, plan.course_id)).some((g) => g.id === Number(t.group_id));
            return still ? { outcome: "sin_efecto", checked: ["grupo"], differences: [{ field: "grupo", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["grupo"], differences: [] };
        }
        case "core_update_inplace_editable": {
            const now = await userGroups(ctx, plan.course_id, Number(t.user_id));
            const want = key(x.groups as number[]);
            const observed = now ? key(now) : "no matriculado";
            if (observed === want) return { outcome: "coincide", checked: ["grupos"], differences: [] };
            return { outcome: observed === key(x.prior_groups as number[]) ? "sin_efecto" : "difiere", checked: ["grupos"], differences: [{ field: "grupos", expected: want || "ninguno", observed: observed || "ninguno" }] };
        }
        default:
            throw new CampusError("UNEXPECTED_RESPONSE", `Sin verificación para ${item.call.fn}.`);
    }
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const common = { readVersions, interpret, verify, reconcile };
const applied = (r: { outcome: string }) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido";

// ---------- crear un grupo ----------

const createShape = {
    course_id: z.number().int().positive(),
    name: z.string().min(1).max(254).describe("Nombre del grupo (único en el curso)."),
    idnumber: z.string().max(100).optional().describe("Número de ID (opcional, único en el curso)."),
    description: z.string().max(5_000).optional().describe("Descripción (Markdown)."),
};

export const createGroupIntent: WriteIntent<typeof createShape> = {
    name: "create_group",
    title: "Plan: crear un grupo",
    description: "Arma el plan para crear un grupo VACÍO en el curso (sin mensajería de grupo ni clave de matriculación). No escribe. Para agregar participantes, campus_plan_group_members.",
    inputShape: createShape,
    capability: "manage_groups",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const name = input.name.trim();
        const idnumber = (input.idnumber ?? "").trim();
        if (!name || /[\u0000-\u001f]/.test(name + idnumber)) throw new CampusError("WRITE_NOT_ALLOWED", "Nombre vacío o con caracteres de control.");
        const groups = await groupsOf(ctx, input.course_id);
        if (groups.some((g) => (g.name ?? "").trim().toLowerCase() === name.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay un grupo «${name}» en el curso.`);
        if (idnumber && groups.some((g) => g.idnumber === idnumber)) throw new CampusError("WRITE_NOT_ALLOWED", `El número de ID «${idnumber}» ya lo usa otro grupo.`);
        if (idnumber) await assertIdnumberEditable(ctx, "group_form_new", { courseid: String(input.course_id) }, "_qf__group_form", "los grupos");
        const html = input.description ? toHtml(input.description, "markdown") : "";
        return {
            intent: "create_group",
            capability: "manage_groups",
            course_id: input.course_id,
            base_risk: "R1",
            summary: `Crear el grupo vacío «${name}»${idnumber ? ` (ID ${idnumber})` : ""} en el curso ${input.course_id}.`,
            payload_preview: { name, idnumber, description_html: html, members: "ninguno", group_messaging: false, enrolment_key: "ninguna", other_settings: "valores por defecto del formulario (visibilidad y participación)" },
            side_effects: ["Crea el grupo, vacío: no cambia el acceso de nadie hasta que se agreguen miembros.", "Sin conversación de grupo y sin notificaciones."],
            preconditions: { description: "Los grupos del curso no cambiaron desde el plan.", versions: { [`groups:${input.course_id}`]: key(groups.map((g) => g.id)) } },
            undo: { kind: "exacto", how: "Borrar el grupo, mientras siga sin miembros.", until: null },
            warnings: ["Creación por formulario web: requiere la sesión web del Campus."],
            items: [
                {
                    item_id: "i1",
                    description: `Nuevo grupo «${name}»`,
                    call: {
                        kind: "form",
                        fn: "course_group_add",
                        params: { query: { courseid: String(input.course_id) }, fields: { name, idnumber, "description_editor[text]": html, "description_editor[format]": "1", enablemessaging: "0", enrolmentkey: "" } },
                    },
                    target: { course_id: input.course_id },
                    expected: { name, idnumber, description_text: comparable(html), prior_group_ids: groups.map((g) => g.id) },
                },
            ],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: { name, ...(input.description ? { description: input.description } : {}) },
            undo_of: null,
        };
    },
    async undo(plan, result, ctx) {
        const groupId = result.items.find(applied)?.moodle_ids.group_id;
        if (!groupId) return { kind: "ninguno", reason: "No se conoce el grupo creado." };
        const members = await membersOf(ctx, plan.course_id, groupId);
        if (members > 0) return { kind: "ninguno", reason: `El grupo ya tiene ${members} miembro(s): borrarlo cambia el acceso y es R4. Quitá primero los miembros (campus_plan_group_members).` };
        const name = String((plan.payload_preview as { name?: string }).name ?? groupId);
        const draft: PlanDraft = {
            intent: "create_group",
            capability: "manage_groups",
            course_id: plan.course_id,
            base_risk: "R2",
            summary: `Deshacer: borrar el grupo vacío «${name}» (${groupId}).`,
            payload_preview: { delete_group: groupId, name },
            side_effects: ["Borra el grupo (irreversible). Está vacío: no cambia el acceso de nadie."],
            preconditions: { description: "El grupo sigue existiendo y sin miembros.", versions: { [`groupsize:${plan.course_id}:${groupId}`]: 0 } },
            undo: { kind: "ninguno", how: "El borrado no se puede deshacer (se puede volver a crear).", until: null },
            warnings: [],
            items: [
                {
                    item_id: "i1",
                    description: `Borrar el grupo ${groupId}`,
                    call: { kind: "form", fn: "course_group_delete", params: { query: {}, fields: { courseid: String(plan.course_id), groups: String(groupId), confirm: "1" } } },
                    target: { course_id: plan.course_id, group_id: groupId },
                    expected: { deleted: true },
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

// ---------- membresías de un participante ----------

const membersShape = {
    course_id: z.number().int().positive(),
    participant_id: z.number().int().positive().describe("Participante matriculado."),
    group_ids: z.array(z.number().int().positive()).max(50).describe("Conjunto COMPLETO de grupos que va a tener (reemplaza el actual; [] lo quita de todos)."),
};

function membersDraft(courseId: number, userId: number, userName: string | null, before: number[], after: number[], names: Map<number, string>, undoOf: string | null): PlanDraft {
    const label = (ids: number[]) => (ids.length ? ids.map((id) => `«${names.get(id) ?? id}»`).join(", ") : "ninguno");
    const added = after.filter((g) => !before.includes(g));
    const removed = before.filter((g) => !after.includes(g));
    return {
        intent: "group_members",
        capability: "manage_groups",
        course_id: courseId,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Dejar al participante ${userId} en los grupos ${label(after)} (antes: ${label(before)}).`,
        payload_preview: { participant: { id: userId, name: userName }, before: before.map((id) => ({ id, name: names.get(id) ?? null })), after: after.map((id) => ({ id, name: names.get(id) ?? null })), added, removed },
        side_effects: [
            "Cambia lo que el participante ve en actividades con grupos separados o restringidas por grupo.",
            "Lo agrega o quita de las conversaciones de esos grupos, si tienen mensajería. Sin correo.",
            "Las membresías agregadas por un plugin de matriculación no se quitan (la verificación lo marca).",
        ],
        preconditions: { description: "Los grupos del participante no cambiaron desde el plan.", versions: { [`members:${courseId}:${userId}`]: key(before) } },
        undo: { kind: "exacto", how: "Volver a dejarlo en sus grupos anteriores.", until: null },
        warnings: [],
        items: [
            {
                item_id: "i1",
                description: `Grupos del participante ${userId}: +${added.length} −${removed.length}`,
                call: { kind: "ajax", fn: "core_update_inplace_editable", params: { component: "core_group", itemtype: "user_groups", itemid: `${courseId}:${userId}`, value: JSON.stringify(after) } },
                target: { course_id: courseId, user_id: userId },
                expected: { groups: after, prior_groups: before },
            },
        ],
        prior_state: { groups: before },
        untrusted_fields: ["payload_preview.participant.name", "payload_preview.before", "payload_preview.after"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const groupMembersIntent: WriteIntent<typeof membersShape> = {
    name: "group_members",
    title: "Plan: grupos de un participante",
    description: "Arma el plan para fijar el conjunto de grupos de UN participante del curso (agrega y quita respecto del actual; el plan muestra antes y después). No escribe.",
    inputShape: membersShape,
    capability: "manage_groups",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const [groups, users] = await Promise.all([groupsOf(ctx, input.course_id), usersOf(ctx, input.course_id)]);
        const user = users.find((u) => u.id === input.participant_id);
        if (!user) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${input.participant_id} no está matriculado en el curso.`);
        const names = new Map(groups.map((g) => [g.id, g.name ?? String(g.id)] as const));
        const unknown = input.group_ids.filter((g) => !names.has(g));
        if (unknown.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Grupos que no son del curso: ${unknown.join(", ")}.`);
        const after = [...new Set(input.group_ids)].sort((a, b) => a - b);
        const before = (user.groups ?? []).map((g) => g.id).sort((a, b) => a - b);
        if (key(after) === key(before)) throw new CampusError("WRITE_NOT_ALLOWED", "El participante ya está exactamente en esos grupos: no hay cambios.");
        return membersDraft(input.course_id, user.id, user.fullname ?? null, before, after, names, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some(applied)) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const item = plan.items[0]!;
        const userId = Number(item.target.user_id);
        const names = new Map((await groupsOf(ctx, plan.course_id)).map((g) => [g.id, g.name ?? String(g.id)] as const));
        const now = await userGroups(ctx, plan.course_id, userId);
        if (!now) return { kind: "ninguno", reason: "El participante ya no está matriculado." };
        const prior = (item.expected.prior_groups as number[]).filter((g) => names.has(g));
        const draft = membersDraft(plan.course_id, userId, null, now, prior, names, result.action_id);
        return { kind: "plan", draft };
    },
};

// ---------- borrar un grupo ----------

const deleteShape = {
    course_id: z.number().int().positive(),
    group_id: z.number().int().positive().optional().describe("Un grupo (o groups, o grouping_id)."),
    confirm_name: z.string().min(1).max(254).optional().describe("Con group_id: nombre EXACTO del grupo; con grouping_id: nombre EXACTO del agrupamiento. Si no coincide, no se borra nada."),
    groups: z
        .array(z.object({ group_id: z.number().int().positive(), confirm_name: z.string().min(1).max(254).describe("Nombre EXACTO de ese grupo.") }))
        .min(2)
        .max(29)
        .optional()
        .describe("Varios grupos de una vez (ADR-119), cada uno con su nombre exacto."),
    grouping_id: z.number().int().positive().optional().describe("Borra el agrupamiento Y todos sus grupos (ADR-119); confirm_name = nombre del agrupamiento."),
};

export const deleteGroupIntent: WriteIntent<typeof deleteShape> = {
    name: "delete_group",
    title: "Plan: borrar un grupo (R4 si tiene miembros)",
    description:
        "Arma el plan para BORRAR un grupo del curso (group_id + confirm_name), varios de una vez (groups, cada uno con su nombre) o un agrupamiento con todos sus grupos (grouping_id + confirm_name del agrupamiento). Con miembros es R4: pierden el acceso que les daba el grupo, se borra su conversación y sale de sus agrupamientos. El deshacer recrea el grupo vacío; los miembros se vuelven a agregar con campus_plan_group_members. No escribe.",
    inputShape: deleteShape,
    capability: "delete_content",
    synthetic_only: false,
    ...common,
    async plan(input, ctx) {
        const modes = [input.group_id, input.groups, input.grouping_id].filter((x) => x !== undefined).length;
        if (modes !== 1) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá group_id, groups o grouping_id (uno solo).");
        if (!input.groups && !input.confirm_name) throw new CampusError("WRITE_NOT_ALLOWED", "Falta confirm_name: el nombre exacto de lo que se borra.");
        const [groups, users] = await Promise.all([groupsOf(ctx, input.course_id), usersOf(ctx, input.course_id)]);
        const pick = (id: number, confirm: string) => {
            const g = groups.find((x) => x.id === id);
            if (!g) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El grupo ${id} no es del curso ${input.course_id}.`);
            if ((g.name ?? "") !== confirm) throw new CampusError("WRITE_NOT_ALLOWED", `confirm_name no coincide con el nombre del grupo ${g.id} («${g.name ?? ""}»): no se borra nada.`);
            return g;
        };
        let grouping: { id: number; name: string } | null = null;
        let chosen: typeof groups;
        if (input.grouping_id !== undefined) {
            const gr = (await groupingsOf(ctx, input.course_id)).find((x) => x.id === input.grouping_id);
            if (!gr) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El agrupamiento ${input.grouping_id} no es del curso ${input.course_id}.`);
            if ((gr.name ?? "") !== input.confirm_name) throw new CampusError("WRITE_NOT_ALLOWED", `confirm_name no coincide con el nombre del agrupamiento ${gr.id} («${gr.name ?? ""}»): no se borra nada.`);
            grouping = { id: gr.id, name: gr.name ?? String(gr.id) };
            const ids = new Set(await groupingGroupIds(ctx, gr.id));
            chosen = groups.filter((g) => ids.has(g.id));
        } else if (input.groups) {
            if (new Set(input.groups.map((g) => g.group_id)).size !== input.groups.length) throw new CampusError("WRITE_NOT_ALLOWED", "groups repite un grupo.");
            chosen = input.groups.map((x) => pick(x.group_id, x.confirm_name));
        } else chosen = [pick(input.group_id!, input.confirm_name!)];
        const list = chosen.map((g) => {
            const members = users.filter((u) => (u.groups ?? []).some((x) => x.id === g.id)).map((u) => ({ id: u.id, name: u.fullname ?? null }));
            return { g, name: g.name ?? String(g.id), members };
        });
        const totalMembers = list.reduce((a, x) => a + x.members.length, 0);
        const single = list.length === 1 && !grouping ? list[0]! : null;
        const groupItems: PlanItem[] = list.map((x, i) => ({
            item_id: `i${i + 1}`,
            description: `Borrar el grupo ${x.g.id} «${x.name}»`,
            call: { kind: "form", fn: "course_group_delete", params: { query: {}, fields: { courseid: String(input.course_id), groups: String(x.g.id), confirm: "1" } } },
            target: { course_id: input.course_id, group_id: x.g.id },
            expected: { deleted: true },
        }));
        const items: PlanItem[] = grouping
            ? [...groupItems, { item_id: `i${groupItems.length + 1}`, description: `Borrar el agrupamiento ${grouping.id} «${grouping.name}»`, call: { kind: "form", fn: "course_grouping_delete", params: { query: {}, fields: { id: String(grouping.id), delete: "1", confirm: "1" } } }, target: { course_id: input.course_id, grouping_id: grouping.id }, expected: { deleted: true } }]
            : groupItems;
        const names = `${list.map((x) => `«${x.name}»`).slice(0, 15).join(", ")}${list.length > 15 ? `, y ${list.length - 15} más` : ""}`;
        const what = single
            ? `el grupo «${single.name}» (${single.g.id})${single.members.length ? ` con ${single.members.length} miembro(s)` : ", vacío"}`
            : `${grouping ? `el agrupamiento «${grouping.name}» y sus ` : ""}${list.length} grupo(s)${list.length ? ` (${names})` : ""}, con ${totalMembers} pertenencia(s) de participantes`;
        return {
            intent: "delete_group",
            capability: "delete_content",
            course_id: input.course_id,
            base_risk: totalMembers ? "R4" : "R3",
            summary: `BORRAR ${what}.`,
            payload_preview: single
                ? { group: { id: single.g.id, name: single.name, idnumber: single.g.idnumber ?? "", description: single.g.description ?? "" }, members: single.members }
                : { grouping, groups: list.map((x) => ({ id: x.g.id, name: x.name, members: x.members.length })) },
            side_effects: [
                ...(totalMembers ? ["Los miembros pierden lo que el grupo les daba: actividades con grupos separados, restricciones por grupo, entregas en grupo."] : []),
                "Borra la conversación de cada grupo, si tenía, y lo quita de sus agrupamientos. Irreversible en Moodle.",
                ...(grouping ? ["Las actividades restringidas a ese agrupamiento quedan sin agrupamiento."] : []),
                ...(items.length > 1 ? ["Se borran de a uno: si uno falla, los anteriores ya quedaron borrados."] : []),
                "Sin correo.",
            ],
            preconditions: { description: "Los grupos y sus miembros no cambiaron desde el plan.", versions: Object.fromEntries(list.map((x) => [`groupsize:${input.course_id}:${x.g.id}`, x.members.length])) },
            undo: single
                ? { kind: "compensación", how: `Recrear el grupo «${single.name}» vacío, con su número de ID y descripción${single.members.length ? "; los miembros se vuelven a agregar con campus_plan_group_members (sus ids están en el plan)" : ""}. Agrupamientos, conversación y lo que dependía del id del grupo no vuelven.`, until: null }
                : { kind: "ninguno", how: "Sin deshacer automático: los grupos se recrean a mano (sus nombres están en el plan).", until: null },
            warnings: [`${totalMembers ? "R4: borrado con miembros" : "Borrado sin miembros"}. Confirmado por nombre exacto (confirm_name).`],
            items,
            prior_state: single ? { group: { name: single.name, idnumber: single.g.idnumber ?? "", description: single.g.description ?? "" }, members: single.members.map((m) => m.id) } : {},
            untrusted_fields: single ? ["payload_preview.group.name", "payload_preview.group.description", "payload_preview.members"] : ["payload_preview.grouping", "payload_preview.groups"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo(plan, result, ctx) {
        if (!result.items.some(applied)) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        if (plan.items.length !== 1) return { kind: "ninguno", reason: "Un borrado de varios grupos no tiene deshacer automático: recrealos a mano (sus nombres están en el plan)." };
        const prior = plan.prior_state as { group: { name: string; idnumber: string; description: string }; members: number[] };
        const draft = await createGroupIntent.plan({ course_id: plan.course_id, name: prior.group.name, ...(prior.group.idnumber ? { idnumber: prior.group.idnumber } : {}) }, ctx);
        const item = draft.items[0]!;
        // La descripción vuelve tal cual estaba (HTML de Moodle), no reconvertida desde Markdown.
        (item.call.params as { fields: Record<string, string> }).fields["description_editor[text]"] = prior.group.description;
        item.expected = { ...item.expected, description_text: comparable(prior.group.description) };
        return {
            kind: "plan",
            draft: {
                ...draft,
                base_risk: "R2",
                summary: `Deshacer: recrear el grupo «${prior.group.name}» vacío${prior.members.length ? ` (después, volver a agregar a ${prior.members.length} miembro(s): ${prior.members.join(", ")})` : ""}.`,
                undo_of: result.action_id,
            },
        };
    },
};

export const GROUP_INTENTS = [createGroupIntent, groupMembersIntent, deleteGroupIntent];
