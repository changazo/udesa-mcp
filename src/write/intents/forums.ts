import { z } from "zod";
import { CampusError } from "../../errors.js";
import { ActivityAllowedGroupsSchema, ActivityGroupModeSchema, DiscussionPostsSchema, EnrolledUsersSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, UndoDraft, WriteIntent } from "../intent.js";
import type { Difference, ExecutionResult, Plan, PlanDraft, PlanItem } from "../plan.js";
import type { Risk } from "../policy.js";
import { comparable, toHtml, type TextFormat } from "../text.js";
import { describeLocalFiles, MAX_PLAN_FILES, type PlanFile } from "../files.js";

/**
 * W1 · Foros (directiva §8.1; investigación [F] §2). Cuatro intenciones docentes:
 * aviso nuevo, respuesta, edición de un post propio y fijar/bloquear. El borrado de posts ajenos y
 * mover discusiones son moderación (forum-moderation.ts, ADR-094). Cada ítem se interpreta, reconcilia y verifica según su función,
 * así un plan de deshacer (que borra o reedita) se verifica con la misma lógica.
 *
 * Lecturas: foros, discusiones, posts, grupos y participantes por el núcleo de lectura; los
 * chequeos de permisos (can_add_discussion, access_information) por el transporte de escritura,
 * que los tiene como lecturas auditadas. Leer los posts de una discusión puede marcarlos como
 * leídos para la cuenta (ADR-039): el plan lo advierte.
 */

/**
 * Ventana de edición (maxeditingtime) de UdeSA, medida en real el 2026-10-21 (ADR-100): post a las
 * 23:49:35 y correo a las 23:55, o sea 5 min más el cron de cada minuto. (El valor por defecto de Moodle es 30 min.)
 */
const DEFAULT_EDIT_WINDOW_S = 300;
const PER_PAGE = 50;

const optStr = z.string().nullable().optional();
const optNum = z.number().nullable().optional();
const bool = z.union([z.boolean(), z.number(), z.string()]).nullable().optional().transform((v) => (v === null || v === undefined ? null : v === true || v === 1 || v === "1" || v === "true"));

const ForumsSchema = z.array(z.object({ id: z.number().int().positive(), course: z.number().int().positive(), type: optStr, name: optStr, cmid: optNum, forcesubscribe: optNum, maxbytes: optNum, maxattachments: optNum }));
export type ForumRow = z.infer<typeof ForumsSchema>[number];

const DiscussionsSchema = z.object({
    discussions: z.array(
        z.object({
            id: z.number().int().positive(), // primer post
            discussion: z.number().int().positive(),
            name: optStr,
            subject: optStr,
            message: optStr,
            userid: optNum,
            created: optNum,
            modified: optNum,
            timemodified: optNum,
            groupid: optNum,
            pinned: bool,
            locked: bool,
            canreply: bool,
            numreplies: optNum,
        }),
    ),
});
type DiscussionRow = z.infer<typeof DiscussionsSchema>["discussions"][number];
type PostRow = z.infer<typeof DiscussionPostsSchema>["posts"][number];

const CanAddSchema = z.object({ status: bool, canpindiscussions: bool, cancreateattachment: bool });
const AccessSchema = z.object({ canpostprivatereply: bool, canreplypost: bool }).passthrough();

// ---------- lecturas compartidas ----------

export async function me(ctx: IntentContext) {
    return (await ctx.read.session.verified()).info.userid;
}

export async function forumsOf(ctx: IntentContext, courseId: number): Promise<ForumRow[]> {
    const rows = await ctx.read.session.transport.call("mod_forum_get_forums_by_courses", { courseids: [courseId] }, ForumsSchema);
    return rows.filter((f) => f.course === courseId);
}

async function resolveForum(ctx: IntentContext, courseId: number, forumId?: number): Promise<ForumRow> {
    const forums = await forumsOf(ctx, courseId);
    if (forumId !== undefined) {
        const f = forums.find((x) => x.id === forumId);
        if (!f) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El foro ${forumId} no es un foro del curso ${courseId}.`);
        return f;
    }
    const news = forums.filter((f) => f.type === "news");
    if (news.length === 1) return news[0]!;
    throw new CampusError(news.length ? "AMBIGUOUS_RESOURCE" : "RESOURCE_OUT_OF_SCOPE", news.length ? "Hay más de un foro de Avisos: indicá forum_id." : "No se encontró el foro de Avisos del curso: indicá forum_id.", {
        details: { candidates: news.map((f) => ({ forum_id: f.id, name: f.name ?? null })) },
    });
}

export async function discussionsOf(ctx: IntentContext, forumId: number): Promise<{ rows: DiscussionRow[]; complete: boolean }> {
    const max = ctx.profile.read_profile.limits.max_pages_per_request;
    const rows: DiscussionRow[] = [];
    for (let page = 0; page < max; page++) {
        const res = await ctx.read.session.transport.call("mod_forum_get_forum_discussions", { forumid: forumId, page, perpage: PER_PAGE }, DiscussionsSchema);
        rows.push(...res.discussions);
        if (res.discussions.length < PER_PAGE) return { rows, complete: true };
    }
    return { rows, complete: false };
}

/** Discusión de un foro del curso (pertenencia verificada; nunca se acepta un ID ajeno). */
export async function locateDiscussion(ctx: IntentContext, courseId: number, discussionId: number): Promise<{ forum: ForumRow; row: DiscussionRow }> {
    let incomplete = false;
    for (const forum of await forumsOf(ctx, courseId)) {
        const { rows, complete } = await discussionsOf(ctx, forum.id);
        const row = rows.find((r) => r.discussion === discussionId);
        if (row) return { forum, row };
        incomplete ||= !complete;
    }
    throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La discusión ${discussionId} no está en un foro del curso ${courseId}${incomplete ? " (o está más allá de las páginas leídas)" : ""}.`);
}

export async function postsOf(ctx: IntentContext, courseId: number, forumId: number, discussionId: number): Promise<PostRow[]> {
    const res = await ctx.read.session.transport.call("mod_forum_get_discussion_posts", { discussionid: discussionId }, DiscussionPostsSchema);
    if ((res.courseid != null && res.courseid !== courseId) || (res.forumid != null && res.forumid !== forumId) || res.posts.some((p) => p.discussionid != null && p.discussionid !== discussionId)) {
        throw new CampusError("RESOURCE_OUT_OF_SCOPE", "La discusión no pertenece al foro y curso verificados.");
    }
    return res.posts;
}

export async function canAdd(ctx: IntentContext, forumId: number, groupId: number) {
    return CanAddSchema.parse(await ctx.transport.call("mod_forum_can_add_discussion", { forumid: forumId, groupid: groupId }));
}

/**
 * Guarda del dueño (ADR-048): sin allow_participant_notifications, no se publica en foros cuya
 * suscripción manda correo a los participantes (forzada o inicial), ni en los de suscripción desconocida.
 */
export function assertNoParticipantMail(ctx: IntentContext, forum: ForumRow) {
    if (ctx.profile.policy.allow_participant_notifications) return;
    if (forum.forcesubscribe === 0 || forum.forcesubscribe === 3) return;
    const kind = forum.forcesubscribe === 1 ? "forzada" : forum.forcesubscribe === 2 ? "inicial" : "desconocida";
    throw new CampusError("WRITE_NOT_ALLOWED", `El foro «${forum.name ?? forum.id}» tiene suscripción ${kind}: publicar ahí mandaría correo a los participantes, y el perfil no lo permite (allow_participant_notifications=false). Usá un foro con suscripción opcional o deshabilitada.`);
}

/**
 * Adjuntos del plan (ADR-057): sólo con la capacidad de adjuntar (sin ella Moodle los descarta en
 * silencio), dentro de maxattachments y de maxbytes del foro (0 = límite del curso o del sitio, que no
 * se conoce: se acota con el máximo del perfil y lo confirma la verificación).
 */
async function planAttachments(ctx: IntentContext, forum: ForumRow, paths: readonly string[] | undefined, canAttach: () => Promise<boolean>): Promise<{ files: PlanFile[]; warnings: string[] }> {
    if (!paths?.length) return { files: [], warnings: [] };
    if (!(await canAttach())) throw new CampusError("MOODLE_PERMISSION_DENIED", "La cuenta no puede adjuntar archivos en ese foro: Moodle los descartaría en silencio. Quitá attachments.");
    const profileMax = ctx.profile.read_profile.limits.max_file_bytes;
    const forumMax = forum.maxbytes && forum.maxbytes > 0 ? forum.maxbytes : 0;
    const files = describeLocalFiles(paths, forumMax ? Math.min(forumMax, profileMax) : profileMax, forum.maxattachments ?? 0);
    const warnings = [`Se suben ${files.length} archivo(s) a tu borrador privado del Campus justo antes de publicar; si la publicación falla se borran.`];
    if (!forumMax) warnings.push("El foro no informa su tamaño máximo (usa el del curso o el sitio): si Moodle descarta un adjunto, la verificación lo marca como diferencia.");
    return { files, warnings };
}

const attachmentsPreview = (files: PlanFile[]) => (files.length ? files.map((f) => ({ filename: f.filename, bytes: f.size, sha256: f.sha256, path: f.path })) : "ninguno");
const expectedAttachments = (files: PlanFile[]) => files.map((f) => `${f.filename}:${f.size}`).sort();
const observedAttachments = (post: PostRow | undefined) => (post?.attachments ?? []).map((a) => `${a.filename ?? "?"}:${a.filesize ?? "?"}`).sort();

const isoAt = (unixSeconds: number | null | undefined, plus = 0) => (unixSeconds ? new Date((unixSeconds + plus) * 1000).toISOString() : undefined);
const untilFromCreated = (created: number | null | undefined) => isoAt(created, DEFAULT_EDIT_WINDOW_S);
const planUnix = (plan: Plan) => Math.floor(Date.parse(plan.created_at) / 1000);
const firstPostOf = (posts: PostRow[]) => posts.find((p) => !p.parentid) ?? null;

// ---------- versiones (concurrencia optimista) ----------

/**
 * Claves de versión: `can_add:<foro>:<grupo>`, `post:<foro>:<discusión>:<post>`,
 * `discussion:<foro>:<discusión>`, `flags:<foro>:<discusión>`. Se releen igual en todas las intenciones.
 */
export async function readForumVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    const discussionCache = new Map<number, DiscussionRow[]>();
    const rowsOf = async (forumId: number) => {
        if (!discussionCache.has(forumId)) discussionCache.set(forumId, (await discussionsOf(ctx, forumId)).rows);
        return discussionCache.get(forumId)!;
    };
    for (const key of Object.keys(plan.preconditions.versions)) {
        const [kind, a, b, c] = key.split(":");
        const forumId = Number(a);
        if (kind === "can_add") out[key] = (await canAdd(ctx, forumId, Number(b))).status ? 1 : 0;
        else if (kind === "discussion") out[key] = (await rowsOf(forumId)).find((r) => r.discussion === Number(b))?.timemodified ?? null;
        else if (kind === "flags") {
            const r = (await rowsOf(forumId)).find((x) => x.discussion === Number(b));
            out[key] = r ? `${r.pinned ? 1 : 0}${r.locked ? 1 : 0}` : null;
        } else if (kind === "post") {
            try {
                out[key] = (await postsOf(ctx, plan.course_id, forumId, Number(b))).find((p) => p.id === Number(c))?.timemodified ?? null;
            } catch (e) {
                if (e instanceof CampusError && e.code === "MOODLE_ERROR") out[key] = null;
                else throw e;
            }
        } else out[key] = null;
    }
    return out;
}

// ---------- comportamiento por función ----------

function warningsOf(data: unknown): string | null {
    const w = data && typeof data === "object" ? (data as { warnings?: unknown }).warnings : undefined;
    if (!Array.isArray(w) || !w.length) return null;
    return w.map((x) => (x && typeof x === "object" && "warningcode" in x ? String((x as { warningcode: unknown }).warningcode) : "aviso")).join(", ");
}

function interpretForum(item: PlanItem, data: unknown): Interpretation {
    const warn = warningsOf(data);
    if (warn) return { ok: false, reason: `Moodle devolvió avisos: ${warn}.` };
    const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    switch (item.call.fn) {
        case "mod_forum_add_discussion":
            return typeof d.discussionid === "number" && d.discussionid > 0 ? { ok: true, moodle_ids: { discussion_id: d.discussionid } } : { ok: false, reason: "Moodle no devolvió discussionid." };
        case "mod_forum_add_discussion_post":
            return typeof d.postid === "number" && d.postid > 0 ? { ok: true, moodle_ids: { post_id: d.postid } } : { ok: false, reason: "Moodle no devolvió postid." };
        case "mod_forum_update_discussion_post":
        case "mod_forum_delete_post":
            return d.status === false ? { ok: false, reason: "Moodle devolvió status=false." } : { ok: true };
        default:
            return { ok: true };
    }
}

const diff = (field: string, expected: unknown, observed: unknown): Difference[] => (expected === observed ? [] : [{ field, expected, observed }]);

async function verifyForum(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const t = item.target;
    const x = item.expected;
    const forumId = Number(t.forum_id);
    switch (item.call.fn) {
        case "mod_forum_add_discussion": {
            const { rows } = await discussionsOf(ctx, forumId);
            const mine = await me(ctx);
            const row = known.discussion_id
                ? rows.find((r) => r.discussion === known.discussion_id)
                : rows.find((r) => r.userid === mine && r.subject === x.subject && (r.created ?? 0) >= planUnix(plan) - 120);
            if (!row) return { outcome: "sin_efecto", checked: ["discusión"], differences: [{ field: "discusión", expected: "creada", observed: "no aparece en el foro" }] };
            const differences = [
                ...diff("subject", x.subject, row.subject ?? row.name ?? null),
                ...diff("message", x.message_text, comparable(row.message)),
                ...diff("groupid", x.groupid, row.groupid ?? null),
                ...diff("pinned", x.pinned, row.pinned ?? false),
            ];
            const checked = ["subject", "message", "groupid", "pinned"];
            if (Array.isArray(x.attachments)) {
                checked.push("attachments");
                const first = (await postsOf(ctx, plan.course_id, forumId, row.discussion)).find((p) => p.id === row.id);
                differences.push(...diff("attachments", JSON.stringify(x.attachments), JSON.stringify(observedAttachments(first))));
            }
            return { outcome: differences.length ? "difiere" : "coincide", checked, differences, moodle_ids: { discussion_id: row.discussion, post_id: row.id }, undo_until: untilFromCreated(row.created) };
        }
        case "mod_forum_add_discussion_post": {
            const posts = await postsOf(ctx, plan.course_id, forumId, Number(t.discussion_id));
            const mine = await me(ctx);
            const post = known.post_id
                ? posts.find((p) => p.id === known.post_id)
                : posts.find((p) => p.author?.id === mine && p.parentid === x.parent_id && comparable(p.message) === x.message_text && (p.timecreated ?? 0) >= planUnix(plan) - 120);
            if (!post) return { outcome: "sin_efecto", checked: ["respuesta"], differences: [{ field: "respuesta", expected: "creada", observed: "no aparece en la discusión" }] };
            const differences = [
                ...diff("parent_id", x.parent_id, post.parentid ?? null),
                ...diff("private", x.private, post.isprivatereply ?? false),
                ...diff("subject", x.subject, post.subject ?? null),
                ...diff("message", x.message_text, comparable(post.message)),
            ];
            const checked = ["parent_id", "private", "subject", "message"];
            if (Array.isArray(x.attachments)) {
                checked.push("attachments");
                differences.push(...diff("attachments", JSON.stringify(x.attachments), JSON.stringify(observedAttachments(post))));
            }
            return { outcome: differences.length ? "difiere" : "coincide", checked, differences, moodle_ids: { post_id: post.id }, undo_until: untilFromCreated(post.timecreated) };
        }
        case "mod_forum_update_discussion_post": {
            const post = (await postsOf(ctx, plan.course_id, forumId, Number(t.discussion_id))).find((p) => p.id === Number(t.post_id));
            if (!post) return { outcome: "difiere", checked: ["post"], differences: [{ field: "post", expected: "existe", observed: "no existe" }] };
            const checked: string[] = [];
            const differences: Difference[] = [];
            const prior = item.expected.prior as { subject: string; message_text: string };
            let unchanged = true;
            if (x.subject !== undefined) {
                checked.push("subject");
                differences.push(...diff("subject", x.subject, post.subject ?? null));
                unchanged &&= (post.subject ?? null) === prior.subject;
            }
            if (x.message_text !== undefined) {
                checked.push("message");
                differences.push(...diff("message", x.message_text, comparable(post.message)));
                unchanged &&= comparable(post.message) === prior.message_text;
            }
            if (!differences.length) return { outcome: "coincide", checked, differences, moodle_ids: { post_id: post.id } };
            return { outcome: unchanged ? "sin_efecto" : "difiere", checked, differences, moodle_ids: { post_id: post.id } };
        }
        case "mod_forum_delete_post": {
            if (t.kind === "discussion") {
                const { rows, complete } = await discussionsOf(ctx, forumId);
                const still = rows.some((r) => r.discussion === Number(t.discussion_id));
                if (!still && !complete) throw new CampusError("INCOMPLETE_RESULT", "No se pudo confirmar el borrado: el foro tiene más páginas que las leídas.");
                return still ? { outcome: "sin_efecto", checked: ["discusión"], differences: [{ field: "discusión", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["discusión"], differences: [] };
            }
            let posts: PostRow[] = [];
            try {
                posts = await postsOf(ctx, plan.course_id, forumId, Number(t.discussion_id));
            } catch (e) {
                if (!(e instanceof CampusError && e.code === "MOODLE_ERROR")) throw e;
            }
            const still = posts.some((p) => p.id === Number(t.post_id));
            return still ? { outcome: "sin_efecto", checked: ["post"], differences: [{ field: "post", expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: ["post"], differences: [] };
        }
        case "mod_forum_set_pin_state":
        case "mod_forum_set_lock_state": {
            const field = item.call.fn === "mod_forum_set_pin_state" ? "pinned" : "locked";
            const row = (await discussionsOf(ctx, forumId)).rows.find((r) => r.discussion === Number(t.discussion_id));
            if (!row) return { outcome: "difiere", checked: [field], differences: [{ field: "discusión", expected: "existe", observed: "no aparece" }] };
            const observed = row[field] ?? false;
            if (observed === x[field]) return { outcome: "coincide", checked: [field], differences: [] };
            return { outcome: observed === x[`prior_${field}`] ? "sin_efecto" : "difiere", checked: [field], differences: [{ field, expected: x[field], observed }] };
        }
        default:
            throw new CampusError("UNEXPECTED_RESPONSE", `Sin verificación para ${item.call.fn}.`);
    }
}

async function reconcileForum(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    // Sin IDs de Moodle (se perdió la respuesta): se busca el efecto por su contenido y autor.
    const v = await verifyForum(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

/** Deshacer de las creaciones: borrar lo creado (dentro de la ventana no sale el correo). */
function deleteDraft(plan: Plan, result: ExecutionResult, title: string): UndoDraft {
    const r = result.items.find((i) => i.outcome === "verificado" || i.outcome === "con_diferencias" || i.outcome === "desconocido");
    const item = r && plan.items.find((i) => i.item_id === r.item_id);
    if (!r || !item) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
    const isDiscussion = item.call.fn === "mod_forum_add_discussion";
    const postId = r.moodle_ids.post_id;
    const discussionId = isDiscussion ? r.moodle_ids.discussion_id : Number(item.target.discussion_id);
    if (!postId || !discussionId) return { kind: "ninguno", reason: "No se conoce el ID del post creado (la verificación no lo encontró): revisá en el Campus." };
    const forumId = Number(item.target.forum_id);
    const untilNote = result.undo.until ? ` Ventana sin correo hasta ${result.undo.until} (en UdeSA el correo sale unos 5 min después de publicar).` : "";
    return {
        kind: "plan",
        draft: {
            intent: plan.intent,
            capability: plan.capability,
            course_id: plan.course_id,
            base_risk: "R2",
            summary: `Deshacer: borrar ${isDiscussion ? "la discusión" : "la respuesta"} «${title}» (${isDiscussion ? `discusión ${discussionId}` : `post ${postId}`}).${untilNote}`,
            payload_preview: { delete: isDiscussion ? { discussion_id: discussionId, first_post_id: postId } : { post_id: postId, discussion_id: discussionId } },
            side_effects: [
                isDiscussion ? "Borra la discusión entera (con sus respuestas, si las hubiera). Irreversible: no hay papelera." : "Borra la respuesta (y sus respuestas, si las hubiera). Irreversible.",
                "Si todavía no pasó maxeditingtime, el correo no sale. Si ya salió, queda en los buzones.",
            ],
            preconditions: { description: "El post sigue existiendo y no se editó desde la ejecución.", versions: { [`post:${forumId}:${discussionId}:${postId}`]: null } },
            undo: { kind: "ninguno", how: "El borrado no se puede deshacer.", until: null },
            warnings: [],
            items: [
                {
                    item_id: "i1",
                    description: isDiscussion ? `Borrar la discusión ${discussionId} (primer post ${postId})` : `Borrar el post ${postId}`,
                    call: { fn: "mod_forum_delete_post", params: { postid: postId } },
                    target: { course_id: plan.course_id, forum_id: forumId, discussion_id: discussionId, post_id: postId, kind: isDiscussion ? "discussion" : "post" },
                    expected: { deleted: true },
                },
            ],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: {},
            undo_of: result.action_id,
        },
    };
}

/** La versión del post a borrar se lee en el momento de armar el deshacer (no en el plan original). */
async function withCurrentVersions(draft: PlanDraft, ctx: IntentContext): Promise<PlanDraft> {
    const fake = { ...draft, plan_id: "", profile_id: "", created_at: new Date().toISOString(), expires_at: "", risk: draft.base_risk, risk_reasons: [], confirmation: { channel: "cliente" as const, how: [] } };
    const versions = await readForumVersions(fake, ctx);
    if (Object.values(versions).some((v) => v === null)) {
        throw new CampusError("RESOURCE_OUT_OF_SCOPE", "Lo que se quiere deshacer ya no existe en el Campus.");
    }
    return { ...draft, preconditions: { ...draft.preconditions, versions } };
}

/** Lectura, interpretación y verificación de foros, compartidas con la moderación (ADR-094). */
export const FORUM_COMMON = {
    readVersions: readForumVersions,
    interpret: interpretForum,
    verify: verifyForum,
    reconcile: reconcileForum,
};

const common = FORUM_COMMON;

const courseId = z.number().int().positive().describe("ID del curso.");
const textFormat = z.enum(["markdown", "html", "texto"]).optional().describe("Formato de message (por defecto markdown). Se envía como HTML; el plan muestra el HTML final.");

// ---------- aviso nuevo ----------

const announcementShape = {
    course_id: courseId,
    subject: z.string().min(1).max(255).describe("Asunto (≤ 255 caracteres)."),
    message: z.string().min(1).max(50_000).describe("Texto del aviso."),
    message_format: textFormat,
    forum_id: z.number().int().positive().optional().describe("forum_id de un foro del curso; por defecto, el foro de Avisos detectado."),
    group_id: z.number().int().min(-1).optional().describe("-1 o ausente = todos los participantes; si no, un grupo permitido de la actividad."),
    pin: z.boolean().optional().describe("Fijar la discusión (por defecto no)."),
    subscribe: z.boolean().optional().describe("Suscribirte a la discusión (te llegan sus correos). Por defecto no (ADR-098)."),
    attachments: z.array(z.string().min(1).max(1000)).max(MAX_PLAN_FILES).optional().describe("Rutas ABSOLUTAS de archivos locales que el humano indicó para adjuntar (nunca archivos «encontrados»). El plan muestra nombre, tamaño y hash; si cambian antes de ejecutar, el plan queda obsoleto."),
};

async function recipients(ctx: IntentContext, courseId: number, groupId: number): Promise<number | null> {
    try {
        const users = await ctx.read.session.transport.call("core_enrol_get_enrolled_users", { courseid: courseId }, EnrolledUsersSchema);
        const mine = await me(ctx);
        return users.filter((u) => u.id !== mine && (groupId <= 0 || (u.groups ?? []).some((g) => g.id === groupId))).length;
    } catch {
        return null;
    }
}

export const announcementIntent: WriteIntent<typeof announcementShape> = {
    name: "announcement",
    title: "Plan: publicar un aviso",
    description:
        "Arma el plan para publicar una discusión nueva en el foro de Avisos (u otro foro del curso): asunto, mensaje convertido a HTML, grupo (por defecto todos) y fijado. No escribe. El correo a los suscriptos lo manda Moodle después de maxeditingtime (30 min por defecto); deshacer antes lo evita.",
    inputShape: announcementShape,
    capability: "post_announcement",
    synthetic_only: false,
    ...common,

    async plan(input, ctx) {
        const forum = await resolveForum(ctx, input.course_id, input.forum_id);
        if (!forum.cmid) throw new CampusError("UNEXPECTED_RESPONSE", "El foro no informa su course_module_id.");
        const mode = (await ctx.read.session.transport.call("core_group_get_activity_groupmode", { cmid: forum.cmid }, ActivityGroupModeSchema)).groupmode;
        const allowed = await ctx.read.session.transport.call("core_group_get_activity_allowed_groups", { cmid: forum.cmid }, ActivityAllowedGroupsSchema);
        let groupId = input.group_id ?? -1;
        let groupName: string | null = null;
        if (mode === 0 && groupId !== -1) throw new CampusError("WRITE_NOT_ALLOWED", "El foro no usa grupos: el aviso va a todos (group_id -1).");
        if (mode !== 0 && groupId === -1 && mode === 1 && !allowed.canaccessallgroups) throw new CampusError("MOODLE_PERMISSION_DENIED", "Foro con grupos separados y sin acceso a todos los grupos: indicá un grupo permitido.");
        if (groupId === 0) groupId = -1; // nunca 0: con accessallgroups crearía un aviso invisible para los estudiantes
        if (groupId > 0) {
            const g = allowed.groups.find((x) => x.id === groupId);
            if (!g) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El grupo ${groupId} no es un grupo permitido de este foro.`, { details: { allowed: allowed.groups.map((x) => ({ id: x.id, name: x.name ?? null })) } });
            groupName = g.name ?? null;
        }
        const can = await canAdd(ctx, forum.id, groupId);
        if (!can.status) throw new CampusError("MOODLE_PERMISSION_DENIED", "Moodle informa que la cuenta no puede publicar en ese foro y grupo (chequeo previo, sin escribir).");
        const pin = input.pin ?? false;
        if (pin && !can.canpindiscussions) throw new CampusError("MOODLE_PERMISSION_DENIED", "La cuenta no puede fijar discusiones: Moodle ignoraría el fijado en silencio. Quitá pin.");
        const format: TextFormat = input.message_format ?? "markdown";
        const html = toHtml(input.message, format);
        const text = comparable(html);
        if (!text) throw new CampusError("WRITE_NOT_ALLOWED", "El mensaje queda vacío después de convertirlo.");
        const who = await recipients(ctx, input.course_id, groupId);
        const sandbox = ctx.profile.policy.sandbox_course_ids.includes(input.course_id);
        assertNoParticipantMail(ctx, forum);
        const att = await planAttachments(ctx, forum, input.attachments, async () => can.cancreateattachment === true);
        const forced = forum.forcesubscribe === 1;
        const warnings: string[] = [...att.warnings];
        const subscription =
            forum.forcesubscribe === 1 ? "forzada" : forum.forcesubscribe === 2 ? "inicial" : forum.forcesubscribe === 3 ? "deshabilitada" : forum.forcesubscribe === 0 ? "opcional" : "desconocida";
        if (forced) warnings.push(`El foro tiene suscripción forzada: ${who === null ? "todos los participantes" : `los ${who} participantes${groupId > 0 ? " del grupo" : ""}`} pueden recibir el aviso por correo.`);
        warnings.push("El correo sale por cron unos 5 min después de publicar (maxeditingtime de UdeSA, medido; ADR-100). Borrar antes evita el envío.");
        const base: Risk = forced && !sandbox ? "R3" : "R2";
        return {
            intent: "announcement",
            capability: "post_announcement",
            course_id: input.course_id,
            base_risk: base,
            summary: `Publicar el aviso «${input.subject}» en «${forum.name ?? forum.id}» para ${groupId === -1 ? "todos los participantes" : `el grupo «${groupName ?? groupId}»`}${pin ? ", fijado" : ""}.`,
            payload_preview: {
                forum: { forum_id: forum.id, name: forum.name ?? null, type: forum.type ?? null, subscription },
                subject: input.subject,
                message_html: html,
                source_format: format,
                group: groupId === -1 ? "todos (groupid -1)" : { group_id: groupId, name: groupName },
                pinned: pin,
                discussion_subscribe: input.subscribe ?? false,
                attachments: attachmentsPreview(att.files),
                possible_recipients: who,
                send_now: "no existe por web service: el correo sale después de maxeditingtime",
            },
            side_effects: [
                `Visible en el foro para ${groupId === -1 ? "todos los participantes" : "el grupo"}.`,
                input.subscribe ? "Quedás suscripto a la discusión: te llegan sus correos." : "No quedás suscripto a la discusión: no te llegan sus correos (subscribe=false, ADR-098).",
                `Correo a los suscriptos (suscripción ${subscription}) por cron, unos 5 min después (maxeditingtime de UdeSA).`,
                "Marca el post como leído para la cuenta; puede actualizar la finalización del foro.",
            ],
            preconditions: { description: "La cuenta sigue pudiendo publicar en ese foro y grupo.", versions: { [`can_add:${forum.id}:${groupId}`]: 1 } },
            undo: { kind: "exacto", how: "Borrar la discusión antes de que pase maxeditingtime evita el correo; después se puede borrar, pero el correo ya salió.", until: null },
            warnings,
            items: [
                {
                    item_id: "i1",
                    description: `Nueva discusión «${input.subject}» en el foro ${forum.id}`,
                    call: {
                        fn: "mod_forum_add_discussion",
                        params: {
                            forumid: forum.id,
                            subject: input.subject,
                            message: html,
                            groupid: groupId,
                            options: [
                                { name: "discussionsubscribe", value: input.subscribe ? "1" : "0" },
                                { name: "discussionpinned", value: pin ? "1" : "0" },
                            ],
                        },
                    },
                    target: { course_id: input.course_id, forum_id: forum.id },
                    expected: { subject: input.subject, message_text: text, groupid: groupId, pinned: pin, ...(att.files.length ? { attachments: expectedAttachments(att.files) } : {}) },
                    ...(att.files.length ? { uploads: { option: "attachmentsid" as const, files: att.files } } : {}),
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.forum.name", "payload_preview.group.name"],
            teacher_text: { subject: input.subject, message: input.message },
            undo_of: null,
        };
    },

    async undo(plan, result, ctx) {
        const d = deleteDraft(plan, result, String((plan.payload_preview as { subject?: string }).subject ?? ""));
        return d.kind === "plan" ? { kind: "plan", draft: await withCurrentVersions(d.draft, ctx) } : d;
    },
};

// ---------- respuesta ----------

const replyShape = {
    course_id: courseId,
    discussion_id: z.number().int().positive().describe("discussion_id (no el id del post)."),
    message: z.string().min(1).max(50_000),
    message_format: textFormat,
    reply_to_post_id: z.number().int().positive().optional().describe("Post al que se responde; por defecto, el primero de la discusión."),
    private: z.boolean().optional().describe("Respuesta privada a la autora del post (requiere la capacidad; si no, el plan se rechaza)."),
    subject: z.string().min(1).max(255).optional().describe("Por defecto «Re: <asunto>»."),
    subscribe: z.boolean().optional().describe("Suscribirte a la discusión (te llegan sus correos). Por defecto no (ADR-098)."),
    attachments: z.array(z.string().min(1).max(1000)).max(MAX_PLAN_FILES).optional().describe("Rutas ABSOLUTAS de archivos locales que el humano indicó para adjuntar (nunca archivos «encontrados»). El plan muestra nombre, tamaño y hash; si cambian antes de ejecutar, el plan queda obsoleto."),
};

export const replyIntent: WriteIntent<typeof replyShape> = {
    name: "forum_reply",
    title: "Plan: responder en un foro",
    description: "Arma el plan para responder en una discusión de un foro del curso (pública o privada). No escribe. Leer la discusión para armar el plan puede marcarla como leída (ADR-039).",
    inputShape: replyShape,
    capability: "reply_forum",
    synthetic_only: false,
    ...common,

    async plan(input, ctx) {
        const { forum, row } = await locateDiscussion(ctx, input.course_id, input.discussion_id);
        assertNoParticipantMail(ctx, forum);
        if (row.canreply === false) throw new CampusError("MOODLE_PERMISSION_DENIED", "Moodle informa que no se puede responder en esta discusión (bloqueada o sin permiso).");
        const posts = await postsOf(ctx, input.course_id, forum.id, input.discussion_id);
        const parent = input.reply_to_post_id ? posts.find((p) => p.id === input.reply_to_post_id) : firstPostOf(posts);
        if (!parent) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "El post al que se responde no está en esa discusión.");
        if (parent.isprivatereply) throw new CampusError("WRITE_NOT_ALLOWED", "No se puede responder a una respuesta privada.");
        const priv = input.private ?? false;
        if (priv) {
            const access = AccessSchema.parse(await ctx.transport.call("mod_forum_get_forum_access_information", { forumid: forum.id }));
            if (!access.canpostprivatereply) throw new CampusError("MOODLE_PERMISSION_DENIED", "La cuenta no puede responder en privado: Moodle la publicaría en abierto sin avisar.");
        }
        const subject = (input.subject ?? `Re: ${(parent.subject ?? row.subject ?? "").replace(/^Re:\s*/i, "")}`).slice(0, 255);
        const format: TextFormat = input.message_format ?? "markdown";
        const html = toHtml(input.message, format);
        const text = comparable(html);
        if (!text) throw new CampusError("WRITE_NOT_ALLOWED", "El mensaje queda vacío después de convertirlo.");
        const options: { name: string; value: string }[] = [{ name: "discussionsubscribe", value: input.subscribe ? "1" : "0" }];
        if (priv) options.push({ name: "private", value: "1" });
        const att = await planAttachments(ctx, forum, input.attachments, async () => (await canAdd(ctx, forum.id, -1)).cancreateattachment === true);
        return {
            intent: "forum_reply",
            capability: "reply_forum",
            course_id: input.course_id,
            base_risk: "R2",
            summary: `Responder ${priv ? "en privado " : ""}en la discusión «${row.subject ?? row.name ?? input.discussion_id}» al post ${parent.id}.`,
            payload_preview: {
                forum: { forum_id: forum.id, name: forum.name ?? null },
                discussion: { discussion_id: input.discussion_id, subject: row.subject ?? row.name ?? null },
                reply_to: { post_id: parent.id, author: parent.author?.fullname ?? null, subject: parent.subject ?? null },
                subject,
                message_html: html,
                source_format: format,
                private: priv,
                discussion_subscribe: input.subscribe ?? false,
                attachments: attachmentsPreview(att.files),
            },
            side_effects: [
                priv ? "Visible sólo para la autora del post y quienes pueden leer respuestas privadas." : "Visible para quienes ven la discusión.",
                "Correo a los suscriptos de la discusión por cron, unos 5 min después (maxeditingtime de UdeSA).",
                input.subscribe ? "Quedás suscripto a la discusión: te llegan sus correos." : "No quedás suscripto a la discusión: no te llegan sus correos (subscribe=false, ADR-098).",
            ],
            preconditions: { description: "El post al que se responde no cambió.", versions: { [`post:${forum.id}:${input.discussion_id}:${parent.id}`]: parent.timemodified ?? null } },
            undo: { kind: "exacto", how: "Borrar la respuesta antes de que pase maxeditingtime evita el correo; después se puede borrar, pero el correo ya salió.", until: null },
            warnings: ["Para armar el plan se leyó la discusión completa: en foros con seguimiento, Moodle marca sus posts como leídos (ADR-039).", ...att.warnings],
            items: [
                {
                    item_id: "i1",
                    description: `Respuesta al post ${parent.id}`,
                    call: { fn: "mod_forum_add_discussion_post", params: { postid: parent.id, subject, message: html, messageformat: 1, options } },
                    target: { course_id: input.course_id, forum_id: forum.id, discussion_id: input.discussion_id, parent_id: parent.id },
                    expected: { parent_id: parent.id, private: priv, subject, message_text: text, ...(att.files.length ? { attachments: expectedAttachments(att.files) } : {}) },
                    ...(att.files.length ? { uploads: { option: "attachmentsid" as const, files: att.files } } : {}),
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.forum.name", "payload_preview.discussion.subject", "payload_preview.reply_to.author", "payload_preview.reply_to.subject"],
            teacher_text: { subject, message: input.message },
            undo_of: null,
        };
    },

    async undo(plan, result, ctx) {
        const d = deleteDraft(plan, result, String((plan.payload_preview as { subject?: string }).subject ?? ""));
        return d.kind === "plan" ? { kind: "plan", draft: await withCurrentVersions(d.draft, ctx) } : d;
    },
};

// ---------- editar un post propio ----------

const editShape = {
    course_id: courseId,
    discussion_id: z.number().int().positive(),
    post_id: z.number().int().positive(),
    subject: z.string().min(1).max(255).optional(),
    message: z.string().min(1).max(50_000).optional(),
    message_format: textFormat,
    subscribe: z.boolean().optional().describe("Moodle fija la suscripción de quien edita: true = suscripto, false o ausente = sin suscripción (ADR-098)."),
};

type EditInput = z.infer<z.ZodObject<typeof editShape>>;

async function buildEdit(input: EditInput & { raw_html?: boolean }, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    if (input.subject === undefined && input.message === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá subject, message o ambos.");
    const { forum } = await locateDiscussion(ctx, input.course_id, input.discussion_id);
    const post = (await postsOf(ctx, input.course_id, forum.id, input.discussion_id)).find((p) => p.id === input.post_id);
    if (!post) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "El post no está en esa discusión.");
    if (post.author?.id !== (await me(ctx))) throw new CampusError("WRITE_NOT_ALLOWED", "Sólo se editan posts propios (edit_own_post).");
    const html = input.message === undefined ? undefined : input.raw_html ? input.message : toHtml(input.message, input.message_format ?? "markdown");
    if (html !== undefined && !comparable(html)) throw new CampusError("WRITE_NOT_ALLOWED", "El mensaje queda vacío (Moodle ignora los vacíos).");
    const prior = { subject: post.subject ?? "", message_html: post.message ?? "", message_text: comparable(post.message) };
    const isFirst = !post.parentid;
    return {
        intent: "post_edit",
        capability: "edit_own_post",
        course_id: input.course_id,
        base_risk: "R2",
        summary: `${undoOf ? "Deshacer: restaurar" : "Editar"} el post ${post.id}${isFirst ? " (primer post: renombra la discusión)" : ""}.`,
        payload_preview: {
            post_id: post.id,
            before: { subject: prior.subject, message_html: prior.message_html },
            after: { subject: input.subject ?? "(sin cambios)", message_html: html ?? "(sin cambios)" },
            discussion_subscribe: input.subscribe ?? false,
        },
        side_effects: [
            isFirst ? "Cambia el asunto de la discusión si cambia el asunto." : "Cambia sólo este post.",
            "Si el correo de este post ya salió, la edición no se reenvía; si todavía no salió, sale la versión nueva.",
            input.subscribe ? "Quedás suscripto a la discusión: te llegan sus correos." : "No quedás suscripto a la discusión: no te llegan sus correos (subscribe=false, ADR-098).",
        ],
        preconditions: { description: "El post no cambió desde el plan.", versions: { [`post:${forum.id}:${input.discussion_id}:${post.id}`]: post.timemodified ?? null } },
        undo: { kind: "compensación", how: "Volver a editar con el asunto y el mensaje anteriores (tal como los devolvía Moodle).", until: null },
        warnings: ["Para armar el plan se leyó la discusión completa: en foros con seguimiento, Moodle marca sus posts como leídos (ADR-039)."],
        items: [
            {
                item_id: "i1",
                description: `Editar el post ${post.id}`,
                call: { fn: "mod_forum_update_discussion_post", params: { postid: post.id, subject: input.subject ?? "", message: html ?? "", messageformat: 1, options: [{ name: "discussionsubscribe", value: input.subscribe ? "1" : "0" }] } },
                target: { course_id: input.course_id, forum_id: forum.id, discussion_id: input.discussion_id, post_id: post.id },
                expected: { ...(input.subject !== undefined ? { subject: input.subject } : {}), ...(html !== undefined ? { message_text: comparable(html) } : {}), prior: { subject: prior.subject, message_text: prior.message_text } },
            },
        ],
        prior_state: { subject: prior.subject, message_html: prior.message_html },
        untrusted_fields: ["payload_preview.before"],
        teacher_text: { ...(input.subject !== undefined ? { subject: input.subject } : {}), ...(input.message !== undefined ? { message: input.message } : {}) },
        undo_of: undoOf,
    };
}

export const editIntent: WriteIntent<typeof editShape> = {
    name: "post_edit",
    title: "Plan: editar un post propio",
    description: "Arma el plan para cambiar el asunto y/o el mensaje de un post propio de un foro del curso. No escribe. El plan muestra antes y después.",
    inputShape: editShape,
    capability: "edit_own_post",
    synthetic_only: false,
    ...common,
    plan: (input, ctx) => buildEdit(input, ctx, null),
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const t = plan.items[0]!.target;
        const prior = plan.prior_state as { subject: string; message_html: string };
        const x = plan.items[0]!.expected;
        return {
            kind: "plan",
            draft: await buildEdit(
                {
                    course_id: plan.course_id,
                    discussion_id: Number(t.discussion_id),
                    post_id: Number(t.post_id),
                    subject: x.subject !== undefined && prior.subject ? prior.subject : undefined,
                    message: x.message_text !== undefined && prior.message_html ? prior.message_html : undefined,
                    raw_html: true,
                },
                ctx,
                result.action_id,
            ),
        };
    },
};

// ---------- fijar y bloquear ----------

const stateShape = {
    course_id: courseId,
    discussion_id: z.number().int().positive(),
    pinned: z.boolean().optional().describe("true fija, false desfija."),
    locked: z.boolean().optional().describe("true bloquea respuestas, false desbloquea."),
};

type StateInput = z.infer<z.ZodObject<typeof stateShape>>;

async function buildState(input: StateInput, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    if (input.pinned === undefined && input.locked === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá pinned, locked o ambos.");
    const { forum, row } = await locateDiscussion(ctx, input.course_id, input.discussion_id);
    const cur = { pinned: row.pinned ?? false, locked: row.locked ?? false };
    const items: PlanItem[] = [];
    if (input.pinned !== undefined && input.pinned !== cur.pinned) {
        if (!(await canAdd(ctx, forum.id, -1)).canpindiscussions) throw new CampusError("MOODLE_PERMISSION_DENIED", "La cuenta no puede fijar discusiones en este foro.");
        items.push({
            item_id: `i${items.length + 1}`,
            description: `${input.pinned ? "Fijar" : "Desfijar"} la discusión ${input.discussion_id}`,
            call: { fn: "mod_forum_set_pin_state", params: { discussionid: input.discussion_id, targetstate: input.pinned ? 1 : 0 } },
            target: { course_id: input.course_id, forum_id: forum.id, discussion_id: input.discussion_id },
            expected: { pinned: input.pinned, prior_pinned: cur.pinned },
        });
    }
    if (input.locked !== undefined && input.locked !== cur.locked) {
        items.push({
            item_id: `i${items.length + 1}`,
            description: `${input.locked ? "Bloquear" : "Desbloquear"} la discusión ${input.discussion_id}`,
            // Semántica invertida de Moodle [F §2.5]: targetstate=0 BLOQUEA; distinto de 0 desbloquea.
            call: { fn: "mod_forum_set_lock_state", params: { forumid: forum.id, discussionid: input.discussion_id, targetstate: input.locked ? 0 : 1 } },
            target: { course_id: input.course_id, forum_id: forum.id, discussion_id: input.discussion_id },
            expected: { locked: input.locked, prior_locked: cur.locked },
        });
    }
    if (!items.length) throw new CampusError("WRITE_NOT_ALLOWED", "La discusión ya está en ese estado: no hay nada que escribir.");
    return {
        intent: "discussion_state",
        capability: "pin_lock_discussion",
        course_id: input.course_id,
        base_risk: "R1",
        summary: `${undoOf ? "Deshacer: " : ""}${items.map((i) => i.description.toLowerCase()).join(" y ")} («${row.subject ?? row.name ?? input.discussion_id}»).`,
        payload_preview: { discussion: { discussion_id: input.discussion_id, subject: row.subject ?? row.name ?? null }, before: cur, after: { pinned: input.pinned ?? cur.pinned, locked: input.locked ?? cur.locked } },
        side_effects: ["Cambia cómo se ve la discusión en el foro (fijada arriba o sin respuestas nuevas). Sin correos."],
        preconditions: { description: "El estado de la discusión no cambió desde el plan.", versions: { [`flags:${forum.id}:${input.discussion_id}`]: `${cur.pinned ? 1 : 0}${cur.locked ? 1 : 0}` } },
        undo: { kind: "exacto", how: "La operación inversa.", until: null },
        warnings: [],
        items,
        prior_state: cur,
        untrusted_fields: ["payload_preview.discussion.subject"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

export const discussionStateIntent: WriteIntent<typeof stateShape> = {
    name: "discussion_state",
    title: "Plan: fijar o bloquear una discusión",
    description: "Arma el plan para fijar/desfijar o bloquear/desbloquear una discusión de un foro del curso. No escribe.",
    inputShape: stateShape,
    capability: "pin_lock_discussion",
    synthetic_only: false,
    ...common,
    plan: (input, ctx) => buildState(input, ctx, null),
    async undo(plan, result, ctx) {
        const applied = result.items.filter((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido");
        if (!applied.length) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const prior = plan.prior_state as { pinned: boolean; locked: boolean };
        const fns = applied.map((r) => plan.items.find((i) => i.item_id === r.item_id)!.call.fn);
        return {
            kind: "plan",
            draft: await buildState(
                {
                    course_id: plan.course_id,
                    discussion_id: Number(plan.items[0]!.target.discussion_id),
                    pinned: fns.includes("mod_forum_set_pin_state") ? prior.pinned : undefined,
                    locked: fns.includes("mod_forum_set_lock_state") ? prior.locked : undefined,
                },
                ctx,
                result.action_id,
            ),
        };
    },
};

export const FORUM_INTENTS = [announcementIntent, replyIntent, editIntent, discussionStateIntent];
