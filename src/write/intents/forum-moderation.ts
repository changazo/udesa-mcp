import { z } from "zod";
import { CampusError } from "../../errors.js";
import { comparable } from "../text.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { assertNoParticipantMail, discussionsOf, FORUM_COMMON, forumsOf, locateDiscussion, postsOf, readForumVersions } from "./forums.js";

/**
 * W6 · Moderación de foros (ADR-094), capacidad `moderate_forum`:
 * - Borrar UN post de cualquier autor: `mod_forum_delete_post` (borrado físico, sin papelera; borra
 *   también sus respuestas). El primer post borra la discusión entera: exige `delete_discussion`.
 *   Moodle no avisa al autor. Sin deshacer.
 * - Mover UNA discusión a otro foro del curso: `/mod/forum/discuss.php?move=` (no hay servicio web).
 *   Moodle mueve posts, adjuntos y suscripciones a la discusión. Un post que todavía no salió por correo
 *   saldría a los suscriptores del foro destino: el plan exige que el post más nuevo tenga más de 15 minutos.
 *   Deshacer: moverla de vuelta.
 */

/** Antigüedad mínima del post más nuevo para mover: el correo sale a los ~5 min en UdeSA (ADR-100); se deja margen triple. */
const MOVE_MIN_AGE_S = 900;

// ---------- borrar un post ----------

const deleteShape = {
    course_id: z.number().int().positive(),
    discussion_id: z.number().int().positive().describe("Discusión (sale de campus_list_announcements o campus_search_forums)."),
    post_id: z.number().int().positive().describe("Post a borrar (sale de campus_get_discussion)."),
    delete_discussion: z.boolean().optional().describe("Obligatorio en true si el post es el primero: se borra la discusión entera."),
};

export const forumPostDeleteIntent: WriteIntent<typeof deleteShape> = {
    name: "forum_post_delete",
    title: "Plan: borrar un post de un foro (de cualquier autor)",
    description: "Arma el plan para BORRAR un post de un foro del curso, sea de quien sea, con sus respuestas. Si es el primero de la discusión, borra la discusión entera (delete_discussion=true). Irreversible: R3 si todo lo que se borra es propio; R4 si borra posts de otros (ADR-119). Moodle no avisa al autor. No escribe.",
    inputShape: deleteShape,
    capability: "moderate_forum",
    synthetic_only: false,
    ...FORUM_COMMON,
    async plan(input, ctx): Promise<PlanDraft> {
        const { forum, row } = await locateDiscussion(ctx, input.course_id, input.discussion_id);
        const posts = await postsOf(ctx, input.course_id, forum.id, input.discussion_id);
        const post = posts.find((p) => p.id === input.post_id);
        if (!post) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La discusión ${input.discussion_id} no tiene el post ${input.post_id}.`);
        const first = post.id === row.id || !post.parentid;
        if (first && !input.delete_discussion) throw new CampusError("WRITE_NOT_ALLOWED", "Es el primer post: borrarlo borra la discusión entera. Para hacerlo, delete_discussion=true.");
        // Respuestas que se borran con el post (toda la rama).
        const branch = new Set([post.id]);
        for (let grew = true; grew; ) {
            grew = false;
            for (const p of posts) if (p.parentid && branch.has(p.parentid) && !branch.has(p.id)) (branch.add(p.id), (grew = true));
        }
        const replies = first ? posts.length - 1 : branch.size - 1;
        // ADR-119: borrar posts de otras personas (trabajo de estudiantes) es R4.
        const mine = (await ctx.read.session.verified()).info.userid;
        const gone = first ? posts : posts.filter((p) => branch.has(p.id));
        const others = gone.filter((p) => p.author?.id !== mine).length;
        const what = first ? `la discusión «${row.name ?? row.subject ?? row.discussion}» entera (${posts.length} post(s))` : `el post «${post.subject ?? post.id}» de ${post.author?.fullname ?? "?"}${replies ? ` y sus ${replies} respuesta(s)` : ""}`;
        return {
            intent: "forum_post_delete",
            capability: "moderate_forum",
            course_id: input.course_id,
            base_risk: others ? "R4" : "R3",
            summary: `BORRAR ${what} del foro «${forum.name ?? forum.id}».`,
            payload_preview: { forum: { forum_id: forum.id, name: forum.name ?? null }, discussion_id: row.discussion, post: { post_id: post.id, author: post.author?.fullname ?? null, subject: post.subject ?? null, message_excerpt: comparable(post.message).slice(0, 300), first_post: first }, deleted_posts: first ? posts.length : branch.size, posts_by_others: others },
            side_effects: [first ? "Borra la discusión entera con todas sus respuestas." : "Borra el post y sus respuestas.", ...(others ? [`${others} de los posts que se borran son de otras personas.`] : []), "Irreversible: no hay papelera. Moodle no avisa al autor; si el post ya salió por correo, queda en los buzones."],
            preconditions: { description: "El post no cambió desde el plan.", versions: { [`post:${forum.id}:${row.discussion}:${post.id}`]: post.timemodified ?? null } },
            undo: { kind: "ninguno", how: "El borrado no se puede deshacer.", until: null },
            warnings: ["Leer los posts de la discusión puede marcarlos como leídos para tu cuenta."],
            items: [
                {
                    item_id: "i1",
                    description: first ? `Borrar la discusión ${row.discussion} (primer post ${post.id})` : `Borrar el post ${post.id}`,
                    call: { fn: "mod_forum_delete_post", params: { postid: post.id } },
                    target: { course_id: input.course_id, forum_id: forum.id, discussion_id: row.discussion, post_id: post.id, kind: first ? "discussion" : "post" },
                    expected: { deleted: true },
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.forum.name", "payload_preview.post"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo() {
        return { kind: "ninguno", reason: "El borrado de un post no se puede deshacer." };
    },
};

// ---------- mover una discusión ----------

async function verifyMove(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const to = await discussionsOf(ctx, Number(t.to_forum_id));
    if (to.rows.some((r) => r.discussion === Number(t.discussion_id))) return { outcome: "coincide", checked: ["foro"], differences: [] };
    const from = await discussionsOf(ctx, Number(t.from_forum_id));
    const still = from.rows.some((r) => r.discussion === Number(t.discussion_id));
    if (!still && !(to.complete && from.complete)) throw new CampusError("INCOMPLETE_RESULT", "No se encontró la discusión en las páginas leídas de los dos foros.");
    return { outcome: still ? "sin_efecto" : "difiere", checked: ["foro"], differences: [{ field: "foro", expected: t.to_forum_id, observed: still ? t.from_forum_id : "ninguno de los dos" }] };
}

const moveShape = {
    course_id: z.number().int().positive(),
    discussion_id: z.number().int().positive(),
    to_forum_id: z.number().int().positive().describe("Foro destino, del mismo curso (campus_list_forums)."),
};

async function buildMove(input: { course_id: number; discussion_id: number; to_forum_id: number }, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const { forum, row } = await locateDiscussion(ctx, input.course_id, input.discussion_id);
    const to = (await forumsOf(ctx, input.course_id)).find((f) => f.id === input.to_forum_id);
    if (!to) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El foro ${input.to_forum_id} no es del curso ${input.course_id}.`);
    if (to.id === forum.id) throw new CampusError("WRITE_NOT_ALLOWED", "La discusión ya está en ese foro.");
    if (forum.type === "single" || to.type === "single") throw new CampusError("WRITE_NOT_ALLOWED", "Moodle no mueve discusiones desde ni hacia un foro de una sola discusión.");
    if (to.type === "news" || forum.type === "news") throw new CampusError("WRITE_NOT_ALLOWED", "No se mueven discusiones desde ni hacia un foro de Avisos (suscripción forzada; correo a todos).");
    assertNoParticipantMail(ctx, to);
    const posts = await postsOf(ctx, input.course_id, forum.id, input.discussion_id);
    const newest = Math.max(0, ...posts.map((p) => p.timecreated ?? 0));
    const now = Math.floor(ctx.now.getTime() / 1000);
    if (now - newest < MOVE_MIN_AGE_S) throw new CampusError("WRITE_NOT_ALLOWED", "La discusión tiene un post de los últimos 15 minutos: si todavía no salió por correo, saldría a los suscriptores del foro destino. Probá más tarde.");
    return {
        intent: "forum_move_discussion",
        capability: "moderate_forum",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Mover la discusión «${row.name ?? row.subject ?? row.discussion}» (${posts.length} post(s)) del foro «${forum.name ?? forum.id}» al foro «${to.name ?? to.id}».`,
        payload_preview: { discussion: { discussion_id: row.discussion, name: row.name ?? null, posts: posts.length }, from: { forum_id: forum.id, name: forum.name ?? null }, to: { forum_id: to.id, name: to.name ?? null } },
        side_effects: ["La discusión, sus posts, adjuntos y suscripciones pasan al otro foro; la ven quienes ven ese foro.", "Sin notificaciones (los posts ya salieron por correo)."],
        preconditions: { description: "La discusión no cambió desde el plan.", versions: { [`discussion:${forum.id}:${row.discussion}`]: row.timemodified ?? null } },
        undo: { kind: "compensación", how: "Moverla de vuelta al foro de origen.", until: null },
        warnings: ["Movimiento por formulario web: requiere la sesión web del Campus."],
        items: [
            {
                item_id: "i1",
                description: `Mover la discusión ${row.discussion} al foro ${to.id}`,
                call: { kind: "form", fn: "forum_discussion_move", params: { query: {}, fields: { d: String(row.discussion), move: String(to.id) } } },
                target: { course_id: input.course_id, discussion_id: row.discussion, from_forum_id: forum.id, to_forum_id: to.id },
                expected: { moved: true },
            },
        ],
        prior_state: {},
        untrusted_fields: ["payload_preview.discussion.name", "payload_preview.from.name", "payload_preview.to.name"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const forumMoveDiscussionIntent: WriteIntent<typeof moveShape> = {
    name: "forum_move_discussion",
    title: "Plan: mover una discusión a otro foro del curso",
    description: "Arma el plan para mover UNA discusión (con sus posts) a otro foro del mismo curso. No desde ni hacia Avisos ni foros de una sola discusión. Deshacer: moverla de vuelta. No escribe.",
    inputShape: moveShape,
    capability: "moderate_forum",
    synthetic_only: false,
    readVersions: readForumVersions,
    interpret: (): Interpretation => ({ ok: true }),
    verify: verifyMove,
    async reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
        const v = await verifyMove(item, plan, ctx);
        return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
    },
    plan: (input, ctx) => buildMove(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no movió la discusión." };
        const t = plan.items[0]!.target;
        return { kind: "plan", draft: await buildMove({ course_id: plan.course_id, discussion_id: Number(t.discussion_id), to_forum_id: Number(t.from_forum_id) }, ctx, result.action_id) };
    },
};

export const FORUM_MODERATION_INTENTS = [forumPostDeleteIntent, forumMoveDiscussionIntent];
