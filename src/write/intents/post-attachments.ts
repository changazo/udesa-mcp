import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { describeLocalFiles, MAX_PLAN_FILES } from "../files.js";
import { assertNoParticipantMail, canAdd, locateDiscussion, me, postsOf, readForumVersions } from "./forums.js";

/**
 * W1 · Cambiar los adjuntos de un post PROPIO (directiva §8.1 «Edición… los adjuntos reemplazan el
 * área entera»; investigación [F] §2.7; ADR-069).
 * - Al ejecutar: `mod_forum_prepare_draft_area_for_post` copia al borrador SÓLO los adjuntos que se
 *   conservan (`filestokeep`; ojo: una lista vacía significa «todos», así que para quitar todos se
 *   manda un nombre que no existe), se suben al MISMO borrador los archivos nuevos, y
 *   `mod_forum_update_discussion_post` (asunto y mensaje sin cambios) reemplaza el área con ese
 *   borrador (`attachmentsid`).
 * - Verificación: nombres y tamaños de los adjuntos del post releído.
 * - Deshacer: si sólo se agregaron, se quitan; si se quitó alguno, no hay deshacer (ya no existe).
 */

const NONE = "__ninguno__.mcp";

const attachmentsOf = (post: { attachments?: { filename?: string | null; filesize?: number | null }[] } | undefined) =>
    (post?.attachments ?? []).map((a) => ({ filename: a.filename ?? "?", filesize: a.filesize ?? null }));
const sig = (list: { filename: string; filesize: number | null }[]) => list.map((a) => `${a.filename}:${a.filesize ?? "?"}`).sort();

function interpret(_item: PlanItem, data: unknown): Interpretation {
    const d = (data && typeof data === "object" ? data : {}) as { status?: unknown; warnings?: unknown };
    if (d.status === false) return { ok: false, reason: "Moodle devolvió status=false." };
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const post = (await postsOf(ctx, plan.course_id, Number(t.forum_id), Number(t.discussion_id))).find((p) => p.id === Number(t.post_id));
    if (!post) return { outcome: "difiere", checked: ["post"], differences: [{ field: "post", expected: "existe", observed: "no existe" }] };
    const now = JSON.stringify(sig(attachmentsOf(post)));
    const want = JSON.stringify(item.expected.attachments);
    if (now === want) return { outcome: "coincide", checked: ["attachments"], differences: [] };
    return { outcome: now === JSON.stringify(item.expected.prior) ? "sin_efecto" : "difiere", checked: ["attachments"], differences: [{ field: "attachments", expected: want, observed: now }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const shape = {
    course_id: z.number().int().positive(),
    discussion_id: z.number().int().positive(),
    post_id: z.number().int().positive().describe("Post PROPIO."),
    keep: z.array(z.string().min(1).max(255)).max(MAX_PLAN_FILES).optional().describe("Nombres de los adjuntos actuales que se conservan (por defecto, todos). [] = quitar todos."),
    add: z.array(z.string().min(1).max(1000)).max(MAX_PLAN_FILES).optional().describe("Rutas ABSOLUTAS de archivos locales a agregar (sólo servidor local)."),
    subscribe: z.boolean().optional().describe("Moodle fija la suscripción de quien edita: true = suscripto, false o ausente = sin suscripción (ADR-098)."),
};

type Input = z.infer<z.ZodObject<typeof shape>>;

async function build(input: Input, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const { forum } = await locateDiscussion(ctx, input.course_id, input.discussion_id);
    assertNoParticipantMail(ctx, forum);
    const post = (await postsOf(ctx, input.course_id, forum.id, input.discussion_id)).find((p) => p.id === input.post_id);
    if (!post) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "El post no está en esa discusión.");
    if (post.author?.id !== (await me(ctx))) throw new CampusError("WRITE_NOT_ALLOWED", "Sólo se editan posts propios (edit_own_post).");
    const current = attachmentsOf(post);
    const keepNames = input.keep ?? current.map((a) => a.filename);
    const unknown = keepNames.filter((n) => !current.some((a) => a.filename === n));
    if (unknown.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Esos adjuntos no están en el post: ${unknown.join(", ")}. Actuales: ${current.map((a) => a.filename).join(", ") || "ninguno"}.`);
    const kept = current.filter((a) => keepNames.includes(a.filename));
    const added = input.add?.length ? describeLocalFiles(input.add, Math.min(forum.maxbytes && forum.maxbytes > 0 ? forum.maxbytes : Infinity, ctx.profile.read_profile.limits.max_file_bytes), 0) : [];
    const clash = added.filter((f) => kept.some((k) => k.filename.toLowerCase() === f.filename.toLowerCase()));
    if (clash.length) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay un adjunto con ese nombre (Moodle no sobrescribe): ${clash.map((f) => f.filename).join(", ")}. Quitalo con keep o renombrá el archivo.`);
    const total = kept.length + added.length;
    if (forum.maxattachments && total > forum.maxattachments) throw new CampusError("WRITE_NOT_ALLOWED", `El foro admite ${forum.maxattachments} adjunto(s) y quedarían ${total}.`);
    if (added.length && !(await canAdd(ctx, forum.id, -1)).cancreateattachment) throw new CampusError("MOODLE_PERMISSION_DENIED", "La cuenta no puede adjuntar archivos en ese foro.");
    const removed = current.filter((a) => !keepNames.includes(a.filename));
    if (!removed.length && !added.length) throw new CampusError("WRITE_NOT_ALLOWED", "No hay cambios en los adjuntos.");
    const after = [...kept, ...added.map((f) => ({ filename: f.filename, filesize: f.size }))];
    return {
        intent: "post_attachments",
        capability: "edit_own_post",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Adjuntos del post ${post.id}: ${removed.length ? `quitar ${removed.map((a) => a.filename).join(", ")}` : ""}${removed.length && added.length ? "; " : ""}${added.length ? `agregar ${added.map((f) => f.filename).join(", ")}` : ""}.`,
        payload_preview: { post_id: post.id, before: current, after, removed: removed.map((a) => a.filename), added: added.map((f) => ({ filename: f.filename, bytes: f.size, sha256: f.sha256, path: f.path })) },
        side_effects: [
            "Reemplaza el área de adjuntos del post entera; el asunto y el mensaje no cambian.",
            removed.length ? "Los adjuntos quitados se borran del post y no se pueden recuperar desde acá." : "No se quita ningún adjunto.",
            "Si el correo del post ya salió, la edición no se reenvía. Te deja suscripto a la discusión.",
        ],
        preconditions: { description: "El post no cambió desde el plan.", versions: { [`post:${forum.id}:${input.discussion_id}:${post.id}`]: post.timemodified ?? null } },
        undo: removed.length ? { kind: "ninguno", how: "Los adjuntos quitados no se pueden restaurar desde el MCP.", until: null } : { kind: "exacto", how: "Quitar los adjuntos agregados.", until: null },
        warnings: ["Para armar el plan se leyó la discusión completa: en foros con seguimiento, Moodle marca sus posts como leídos (ADR-039)."],
        items: [
            {
                item_id: "i1",
                description: `Adjuntos del post ${post.id}`,
                call: { fn: "mod_forum_update_discussion_post", params: { postid: post.id, subject: "", message: "", messageformat: 1, options: [{ name: "discussionsubscribe", value: input.subscribe ? "1" : "0" }] } },
                target: { course_id: input.course_id, forum_id: forum.id, discussion_id: input.discussion_id, post_id: post.id },
                expected: { attachments: sig(after), prior: sig(current), removed: removed.length },
                uploads: { option: "attachmentsid", files: added, prepare: { postid: post.id, keep: kept.map((k) => k.filename), none: NONE } },
            },
        ],
        prior_state: { attachments: current },
        untrusted_fields: ["payload_preview.before"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const postAttachmentsIntent: WriteIntent<typeof shape> = {
    name: "post_attachments",
    title: "Plan: cambiar los adjuntos de un post propio",
    description: "Arma el plan para cambiar los adjuntos de un post propio: conservar algunos (keep) y agregar archivos locales (add). El asunto y el mensaje no cambian. No escribe.",
    inputShape: shape,
    capability: "edit_own_post",
    synthetic_only: false,
    readVersions: readForumVersions,
    interpret,
    verify,
    reconcile,
    plan: (input, ctx) => build(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const item = plan.items[0]!;
        if (Number(item.expected.removed) > 0) return { kind: "ninguno", reason: "Se quitaron adjuntos: no se pueden restaurar desde el MCP." };
        const prior = (plan.prior_state as { attachments: { filename: string }[] }).attachments.map((a) => a.filename);
        const t = item.target;
        return { kind: "plan", draft: await build({ course_id: plan.course_id, discussion_id: Number(t.discussion_id), post_id: Number(t.post_id), keep: prior }, ctx, result.action_id) };
    },
};
