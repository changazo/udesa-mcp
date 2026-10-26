import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { comparable, toHtml } from "../text.js";

/**
 * W6 · Páginas de una wiki (ADR-077). Cada grupo (wiki con grupos) o participante (wiki individual) tiene
 * su subwiki: se elige con group_id y user_id (ADR-093); una colaborativa sin grupos tiene uno solo.
 * - agregar: `mod_wiki_new_page` (si el subwiki todavía no existe, Moodle lo crea con wikiid, groupid y userid);
 * - editar: `mod_wiki_edit_page` (versión nueva; la anterior queda en el historial de la wiki);
 * - borrar: `/mod/wiki/admin.php?pageid&delete&option=1` (no hay servicio web). La primera página no se borra.
 * Verificación por `mod_wiki_get_subwiki_pages`: Moodle devuelve el HTML RENDERIZADO (puede agregar un
 * índice de encabezados), así que se exige que contenga el texto pedido.
 * Deshacer: borrar la agregada; volver al contenido anterior; volver a crear una borrada. Ambos con el
 * contenido renderizado (compensación: enlaces de wiki e índices pueden no quedar igual).
 */

const ContentsSchema = z.array(z.object({ modules: z.array(z.object({ id: z.number().int(), modname: z.string(), name: z.string().nullable().optional() })).default([]) }));
const WikisSchema = z.object({ wikis: z.array(z.object({ id: z.number().int(), coursemodule: z.number().int(), name: z.string().nullable().optional(), wikimode: z.string().nullable().optional(), firstpagetitle: z.string().nullable().optional(), groupmode: z.number().nullable().optional() })).default([]) });
const SubwikisSchema = z.object({ subwikis: z.array(z.object({ id: z.number().int(), groupid: z.union([z.string(), z.number()]), userid: z.number().int(), canedit: z.boolean().nullable().optional() })).default([]) });
const PagesSchema = z.object({ pages: z.array(z.object({ id: z.number().int(), subwikiid: z.number().int(), title: z.string(), cachedcontent: z.string().nullable().optional(), firstpage: z.boolean().nullable().optional(), caneditpage: z.boolean().nullable().optional() })).default([]) });

/** Subwiki elegido: grupo (0 = sin grupo o «todos los participantes») y participante (0 = colaborativa). */
interface Where {
    group: number;
    user: number;
}

async function wikiOf(ctx: IntentContext, courseId: number, cmid: number, where: Partial<Where> = {}) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    if (m.modname !== "wiki") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${cmid} no es una wiki (es ${m.modname}).`);
    const w = WikisSchema.parse(await ctx.transport.call("mod_wiki_get_wikis_by_courses", { courseids: [courseId] })).wikis.find((x) => x.coursemodule === cmid);
    if (!w) throw new CampusError("UNEXPECTED_RESPONSE", "La wiki no aparece en mod_wiki_get_wikis_by_courses.");
    const individual = w.wikimode === "individual";
    const subs = SubwikisSchema.parse(await ctx.transport.call("mod_wiki_get_subwikis", { wikiid: w.id })).subwikis;
    const group = where.group ?? 0;
    const user = individual ? (where.user ?? 0) : 0;
    if (!individual && where.user) throw new CampusError("WRITE_NOT_ALLOWED", "La wiki es colaborativa: user_id no aplica.");
    if (individual && !user) throw new CampusError("WRITE_NOT_ALLOWED", "La wiki es individual: indicá user_id (cada participante tiene la suya).");
    // get_subwikis lista los subwikis a los que la cuenta accede; los que todavía no existen vienen con id 0.
    const sub = subs.find((s) => Number(s.groupid) === group && s.userid === user);
    if (!sub) {
        const options = subs.map((s) => (individual ? `grupo ${s.groupid}, participante ${s.userid}` : `grupo ${s.groupid}`)).join("; ");
        throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La wiki no tiene un subwiki para ${individual ? `el participante ${user} ` : ""}en el grupo ${group} (disponibles: ${options || "ninguno"}).`);
    }
    const pages = PagesSchema.parse(await ctx.transport.call("mod_wiki_get_subwiki_pages", { wikiid: w.id, groupid: group, userid: user })).pages;
    return { cmid, id: w.id, name: w.name ?? m.name ?? "", firstpagetitle: w.firstpagetitle ?? "", subwikiid: sub.id > 0 ? sub.id : null, pages, where: { group, user }, mode: w.wikimode ?? "", separated: subs.length > 1 || group !== 0 || user !== 0 };
}
const whereKey = (w: Where) => `${w.group}:${w.user}`;

const pageSnap = (p: { title: string; cachedcontent?: string | null } | undefined) => (p ? JSON.stringify([p.title, comparable(p.cachedcontent)]) : null);

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid, a, b, c] = k.split(":");
        if (kind === "wikipage") out[k] = pageSnap((await wikiOf(ctx, Number(course), Number(cmid), { group: Number(b ?? 0), user: Number(c ?? 0) })).pages.find((p) => p.id === Number(a)));
        else if (kind === "wikititles") out[k] = JSON.stringify((await wikiOf(ctx, Number(course), Number(cmid), { group: Number(a ?? 0), user: Number(b ?? 0) })).pages.map((p) => p.title.toLowerCase()).sort());
        else out[k] = null;
    }
    return out;
}

function interpret(item: PlanItem, data: unknown): Interpretation {
    if (item.call.fn !== "mod_wiki_new_page") return { ok: true };
    const id = Number((data as { pageid?: unknown } | null)?.pageid);
    return Number.isInteger(id) && id > 0 ? { ok: true, moodle_ids: { page_id: id } } : { ok: false, reason: "Moodle no devolvió la página creada." };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification> {
    const x = item.expected as { action: string; page_id?: number; title?: string; content_text?: string; prior_text?: string };
    const w = await wikiOf(ctx, plan.course_id, Number(item.target.cmid), { group: Number(item.target.group_id ?? 0), user: Number(item.target.user_id ?? 0) });
    if (x.action === "delete") {
        const still = w.pages.some((p) => p.id === x.page_id);
        return still ? { outcome: "sin_efecto", checked: ["página"], differences: [{ field: "página", expected: "borrada", observed: "sigue" }] } : { outcome: "coincide", checked: ["página"], differences: [] };
    }
    const p = x.action === "add" ? w.pages.find((y) => (known.page_id ? y.id === known.page_id : y.title === x.title)) : w.pages.find((y) => y.id === x.page_id);
    if (!p) return { outcome: "sin_efecto", checked: ["página"], differences: [{ field: "página", expected: "existe", observed: "no aparece" }] };
    const now = comparable(p.cachedcontent);
    const ids = x.action === "add" ? { moodle_ids: { page_id: p.id } } : {};
    const ok = (x.title === undefined || p.title === x.title) && now.includes(x.content_text ?? "");
    if (ok) return { outcome: "coincide", checked: ["title", "content"], differences: [], ...ids };
    return { outcome: x.action === "edit" && now === x.prior_text ? "sin_efecto" : "difiere", checked: ["title", "content"], differences: [{ field: "content", expected: x.content_text, observed: now.slice(0, 500) }], ...ids };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx, {});
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

type Action = "add" | "edit" | "delete";
interface Req {
    course_id: number;
    course_module_id: number;
    action: Action;
    page_id?: number;
    title?: string;
    content?: string;
    content_html?: string;
    group_id?: number;
    user_id?: number;
}

async function build(input: Req, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const w = await wikiOf(ctx, input.course_id, input.course_module_id, { group: input.group_id, user: input.user_id });
    const target = { course_id: input.course_id, cmid: w.cmid, group_id: w.where.group, user_id: w.where.user };
    const whereText = w.where.user ? ` (wiki del participante ${w.where.user}${w.where.group ? `, grupo ${w.where.group}` : ""})` : w.where.group ? ` (subwiki del grupo ${w.where.group})` : "";
    const html = input.content_html ?? (input.content !== undefined ? toHtml(input.content, "markdown") : undefined);
    if (html !== undefined && !comparable(html)) throw new CampusError("WRITE_NOT_ALLOWED", "El contenido no puede quedar vacío.");
    const preview: Record<string, unknown> = { wiki: { course_module_id: w.cmid, name: w.name, mode: w.mode, group_id: w.where.group, user_id: w.where.user || null } };
    let item: PlanItem;
    let summary: string;
    let risk: "R2" | "R3" = "R2";
    let undo: PlanDraft["undo"];
    let prior: Record<string, unknown> = {};
    const versions: Record<string, string | null> = {};
    if (input.action === "add") {
        const title = input.title?.trim();
        if (!title || html === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Para agregar una página hacen falta title y content.");
        if (w.pages.some((p) => p.title.toLowerCase() === title.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `La wiki ya tiene una página «${title}».`);
        versions[`wikititles:${input.course_id}:${w.cmid}:${whereKey(w.where)}`] = JSON.stringify(w.pages.map((p) => p.title.toLowerCase()).sort());
        const params: Record<string, string | number> = w.subwikiid ? { title, content: html, contentformat: "html", subwikiid: w.subwikiid } : { title, content: html, contentformat: "html", wikiid: w.id, groupid: w.where.group, userid: w.where.user };
        item = { item_id: "i1", description: `Agregar la página «${title}»`, call: { kind: "rest", fn: "mod_wiki_new_page", params }, target, expected: { action: "add", title, content_text: comparable(html) } };
        summary = `Agregar la página «${title}» a la wiki «${w.name}»${whereText}${w.subwikiid ? "" : "; Moodle crea el subwiki"}.`;
        Object.assign(preview, { title, content_html: html, first_page: title === w.firstpagetitle });
        undo = { kind: "compensación", how: "Borrar la página agregada.", until: null };
    } else {
        const p = w.pages.find((y) => y.id === input.page_id);
        if (!p) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La wiki «${w.name}» no tiene la página ${input.page_id ?? "(falta page_id)"}.`);
        versions[`wikipage:${input.course_id}:${w.cmid}:${p.id}:${whereKey(w.where)}`] = pageSnap(p);
        preview.page = { id: p.id, title: p.title, content_html: p.cachedcontent ?? "" };
        prior = { title: p.title, content_html: p.cachedcontent ?? "" };
        if (input.action === "edit") {
            if (input.title !== undefined) throw new CampusError("WRITE_NOT_ALLOWED", "El título de una página de wiki no se cambia (los enlaces apuntan a él).");
            if (html === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá content.");
            if (comparable(html) === comparable(p.cachedcontent)) throw new CampusError("WRITE_NOT_ALLOWED", "La página ya tiene ese contenido.");
            item = { item_id: "i1", description: `Editar la página ${p.id}`, call: { kind: "rest", fn: "mod_wiki_edit_page", params: { pageid: p.id, content: html } }, target, expected: { action: "edit", page_id: p.id, content_text: comparable(html), prior_text: comparable(p.cachedcontent) } };
            summary = `Editar la página «${p.title}» de la wiki «${w.name}»${whereText}.`;
            preview.after_html = html;
            undo = { kind: "compensación", how: "Guardar otra versión con el contenido anterior (renderizado; la versión exacta queda en el historial de la wiki).", until: null };
        } else {
            if (p.firstpage || p.title === w.firstpagetitle) throw new CampusError("WRITE_NOT_ALLOWED", "La primera página de la wiki no se borra.");
            item = { item_id: "i1", description: `Borrar la página ${p.id}`, call: { kind: "form", fn: "wiki_page_delete", params: { query: { pageid: String(p.id), delete: String(p.id), option: "1" }, fields: {} } }, target, expected: { action: "delete", page_id: p.id } };
            summary = `BORRAR la página «${p.title}» de la wiki «${w.name}»${whereText} con su historial.`;
            risk = "R3";
            undo = { kind: "compensación", how: "Volver a crear la página con su título y su contenido renderizado (otro id, sin historial).", until: null };
        }
    }
    return {
        intent: "wiki_page",
        capability: "manage_activity_entries",
        course_id: input.course_id,
        base_risk: risk,
        summary: `${undoOf ? "Deshacer: " : ""}${summary}`,
        payload_preview: preview,
        side_effects: [input.action === "delete" ? "La página se BORRA con todas sus versiones." : input.action === "edit" ? "Guarda una versión nueva (la anterior queda en el historial)." : "Agrega una página que ven los participantes.", "Sin mensajes."],
        preconditions: { description: "La wiki no cambió desde el plan.", versions },
        undo,
        warnings: input.action === "delete" ? ["Borrar es por formulario web: requiere la sesión web del Campus."] : [],
        items: [item],
        prior_state: prior,
        untrusted_fields: ["payload_preview.wiki.name", "payload_preview.page"],
        teacher_text: Object.fromEntries(Object.entries({ title: input.title, content: html }).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de la wiki."),
    group_id: z.number().int().min(0).optional().describe("Wiki con grupos: el grupo cuyo subwiki se toca (0 = todos los participantes, si existe). Por defecto 0."),
    user_id: z.number().int().positive().optional().describe("Wiki individual: el participante dueño del subwiki."),
    operation: z.enum(["add", "edit", "delete"]),
    page_id: z.number().int().positive().optional().describe("Página (edit, delete)."),
    title: z.string().min(1).max(255).optional().describe("add: título de la página nueva."),
    content: z.string().min(1).max(200_000).optional().describe("Contenido (Markdown)."),
};

export const wikiPageIntent: WriteIntent<typeof shape> = {
    name: "wiki_page",
    title: "Plan: agregar, editar o borrar una página de una wiki",
    description: "Arma el plan para agregar (title, content), editar el contenido o borrar (R3) una página de una wiki. En una wiki con grupos o individual, group_id y user_id eligen el subwiki (el error lista los disponibles). La primera página no se borra. No escribe.",
    inputShape: shape,
    capability: "manage_activity_entries",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    plan: ({ operation, ...rest }, ctx) => build({ ...rest, action: operation }, ctx, null),
    async undo(plan, result, ctx) {
        const r = result.items[0];
        if (!r || !(r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const x = plan.items[0]!.expected as { action: Action; page_id?: number };
        const p = plan.prior_state as { title?: string; content_html?: string };
        const t = plan.items[0]!.target;
        const base = { course_id: plan.course_id, course_module_id: Number(t.cmid), group_id: Number(t.group_id ?? 0), ...(Number(t.user_id ?? 0) ? { user_id: Number(t.user_id) } : {}) };
        if (x.action === "add") {
            const id = r.moodle_ids.page_id;
            if (!id) return { kind: "ninguno", reason: "No se conoce la página agregada." };
            return { kind: "plan", draft: await build({ ...base, action: "delete", page_id: id }, ctx, result.action_id) };
        }
        if (x.action === "edit") return { kind: "plan", draft: await build({ ...base, action: "edit", page_id: x.page_id, content_html: p.content_html }, ctx, result.action_id) };
        return { kind: "plan", draft: await build({ ...base, action: "add", title: p.title, content_html: p.content_html }, ctx, result.action_id) };
    },
};
