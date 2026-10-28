import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { ChatFile } from "../chat-files.js";
import { describeLocalFiles, type PlanFile } from "../files.js";
import { folderFiles } from "./content.js";
import { requireH5pPackage } from "./h5p-package.js";

/**
 * W6 · Archivos de una carpeta, de un recurso o de una actividad H5P (ADR-077 y 104), por
 * `/course/modedit.php?update=<cmid>`:
 * - el formulario sirve un borrador privado con los archivos ACTUALES (`files`; en H5P, `packagefile`);
 *   el motor quita de ese borrador los pedidos, sube los nuevos al mismo y envía el formulario sin tocar
 *   el campo;
 * - carpeta: agregar (archivos locales) y quitar (por nombre, sólo de la raíz); recurso y H5P: reemplazar
 *   su único archivo (paquete .h5p) por uno local;
 * - verificación por la estructura del curso (nombre:bytes de cada archivo); en H5P, por el paquete que
 *   informa `mod_h5pactivity_get_h5pactivities_by_courses` (la estructura no lo trae).
 * Deshacer: quitar lo agregado a una carpeta. Un archivo quitado o reemplazado no se puede restaurar
 * (no se guarda copia): R3 y sin deshacer automático.
 */

const ContentsSchema = z.array(
    z.object({
        modules: z
            .array(
                z.object({
                    id: z.number().int(),
                    modname: z.string(),
                    name: z.string().nullable().optional(),
                    contents: z.array(z.object({ type: z.string().nullable().optional(), filename: z.string().nullable().optional(), filepath: z.string().nullable().optional(), filesize: z.number().nullable().optional() })).nullable().optional(),
                }),
            )
            .default([]),
    }),
);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
type Kind = "folder" | "resource" | "h5pactivity";
const UPLOAD_FIELD: Record<Kind, string> = { folder: "files", resource: "files", h5pactivity: "packagefile" };
const LABEL: Record<Kind, string> = { folder: "carpeta", resource: "archivo", h5pactivity: "actividad H5P" };

/** nombre:bytes de los archivos de la actividad (H5P: su paquete). */
export async function filesOf(ctx: IntentContext, courseId: number, m: Awaited<ReturnType<typeof moduleOf>>): Promise<string[]> {
    return m.modname === "h5pactivity" ? requireH5pPackage(ctx, courseId, m.id) : folderFiles(m);
}

export async function moduleOf(ctx: IntentContext, courseId: number, cmid: number) {
    const m = (await ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema)).flatMap((s) => s.modules).find((x) => x.id === cmid);
    if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${cmid} no es del curso ${courseId}.`);
    return m;
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course, cmid] = k.split(":");
        out[k] = kind === "cmfiles" ? JSON.stringify(await filesOf(ctx, Number(course), await moduleOf(ctx, Number(course), Number(cmid)))) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const now = await filesOf(ctx, plan.course_id, await moduleOf(ctx, plan.course_id, Number(item.target.cmid)));
    const want = item.expected.files as string[];
    if (JSON.stringify(now) === JSON.stringify(want)) return { outcome: "coincide", checked: ["files"], differences: [] };
    return { outcome: JSON.stringify(now) === JSON.stringify(item.expected.prior_files) ? "sin_efecto" : "difiere", checked: ["files"], differences: [{ field: "files", expected: want, observed: now }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const nameOf = (entry: string) => entry.slice(0, entry.lastIndexOf(":"));

/** Plan de archivos; `add` ya descriptos (locales o generados por el servidor, ADR-110). */
export function buildActivityFilesDraft(courseId: number, m: Awaited<ReturnType<typeof moduleOf>>, prior: string[], add: PlanFile[], remove: string[], undoOf: string | null): PlanDraft {
    const kind = m.modname as Kind;
    const rootNames = new Set(prior.filter((e) => !e.startsWith("/")).map(nameOf));
    if (kind !== "folder") {
        if (add.length !== 1 || remove.length) throw new CampusError("WRITE_NOT_ALLOWED", `En ${kind === "resource" ? "un archivo (recurso)" : "una actividad H5P"} sólo se reemplaza su archivo: indicá exactamente un archivo (add_file_paths o add_files) y ningún remove_filenames.`);
        if (kind === "h5pactivity" && !/\.h5p$/i.test(add[0]!.filename)) throw new CampusError("WRITE_NOT_ALLOWED", "Una actividad H5P necesita un paquete .h5p.");
        remove = [...rootNames];
        if (!remove.length || prior.some((e) => e.startsWith("/"))) throw new CampusError("UNEXPECTED_RESPONSE", `${kind === "resource" ? "El recurso" : "La actividad H5P"} no tiene un archivo en la raíz para reemplazar.`);
    }
    for (const n of remove) if (!rootNames.has(n)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `«${n}» no está en la raíz de la carpeta.`);
    if (new Set(remove).size !== remove.length) throw new CampusError("WRITE_NOT_ALLOWED", "Un archivo aparece dos veces en remove_filenames.");
    const addNames = add.map((f) => f.filename);
    if (new Set(addNames).size !== addNames.length) throw new CampusError("WRITE_NOT_ALLOWED", "Hay dos archivos nuevos con el mismo nombre.");
    const clash = addNames.filter((n) => rootNames.has(n) && !remove.includes(n));
    if (clash.length) throw new CampusError("WRITE_NOT_ALLOWED", `Ya hay un archivo con ese nombre: ${clash.join(", ")} (para reemplazarlo, quitalo en el mismo pedido).`);
    const files = [...prior.filter((e) => e.startsWith("/") || !remove.includes(nameOf(e))), ...add.map((f) => `${f.filename}:${f.size}`)].sort();
    if (kind === "folder" && !files.length) throw new CampusError("WRITE_NOT_ALLOWED", "La carpeta quedaría vacía: si es lo que querés, borrala con campus_plan_delete_content.");
    const destructive = remove.length > 0;
    const what = kind !== "folder" ? `reemplazar «${remove.join(", ")}» por «${addNames[0]}»` : [addNames.length ? `agregar ${addNames.join(", ")}` : null, remove.length ? `quitar ${remove.join(", ")}` : null].filter(Boolean).join("; ");
    return {
        intent: "activity_files",
        capability: "edit_activity",
        course_id: courseId,
        base_risk: destructive ? "R3" : "R2",
        summary: `${undoOf ? "Deshacer: " : ""}Archivos de «${m.name ?? ""}» (${LABEL[kind]}): ${what}.`,
        payload_preview: { activity: { course_module_id: m.id, type: kind, name: m.name ?? "" }, before: prior, after: files, add: add.map((f) => ({ filename: f.filename, bytes: f.size, sha256: f.sha256, path: f.path })), remove },
        side_effects: [
            "Cambia los archivos que ven los participantes. El resto de la configuración se reenvía tal cual. Sin notificación.",
            ...(destructive ? ["Los archivos quitados o reemplazados se BORRAN del Campus: el MCP no guarda copia."] : []),
            ...(add.length ? ["Sube los archivos nuevos a tu borrador privado justo antes de guardar."] : []),
            ...(kind === "h5pactivity" ? ["Los intentos ya registrados se conservan, pero corresponden al paquete anterior. El Campus despliega el paquete nuevo la primera vez que alguien abre la actividad."] : []),
        ],
        preconditions: { description: "Los archivos no cambiaron desde el plan.", versions: { [`cmfiles:${courseId}:${m.id}`]: JSON.stringify(prior) } },
        undo: destructive ? { kind: "ninguno", how: "Un archivo quitado o reemplazado no se restaura: habría que volver a subirlo.", until: null } : { kind: "compensación", how: "Quitar los archivos agregados.", until: null },
        warnings: ["Formulario web: requiere la sesión web del Campus. Abrirlo copia los archivos a un borrador privado."],
        items: [
            {
                item_id: "i1",
                description: `Archivos de la actividad ${m.id}: ${what}`,
                call: { kind: "form", fn: `course_modedit_${kind}_update_files`, params: { query: { update: String(m.id) }, fields: { coursecontentnotification: "0" } } },
                target: { course_id: courseId, cmid: m.id },
                expected: { files, prior_files: prior },
                uploads: { field: UPLOAD_FIELD[kind], files: add, form_draft: { remove } },
            },
        ],
        prior_state: { files: prior },
        untrusted_fields: ["payload_preview.activity.name", "payload_preview.before"],
        teacher_text: {},
        undo_of: undoOf,
    };
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().describe("cmid de una carpeta, de un archivo (recurso) o de una actividad H5P."),
    add_file_paths: z.array(z.string().min(1).max(1000)).max(10).optional().describe("Rutas ABSOLUTAS de archivos locales que indicó el humano (sólo servidor local). En un recurso o una actividad H5P, exactamente una: reemplaza su archivo (H5P: un paquete .h5p)."),
    add_files: z
        .array(ChatFile)
        .min(1)
        .max(10)
        .optional()
        .describe("Archivos que entrega el cliente (ChatGPT: adjuntos o generados en la conversación), en lugar de add_file_paths; funciona también en el remoto. En un recurso o una actividad H5P, exactamente uno."),
    remove_filenames: z.array(z.string().min(1).max(255)).max(50).optional().describe("Carpeta: nombres EXACTOS de archivos de la raíz a quitar (se borran)."),
};

export const activityFilesIntent: WriteIntent<typeof shape> = {
    name: "activity_files",
    title: "Plan: agregar o quitar archivos de una carpeta, o reemplazar el archivo de un recurso o el paquete de una actividad H5P",
    description:
        "Arma el plan para agregar archivos a una carpeta (locales con add_file_paths, o los que entrega ChatGPT con add_files), quitar archivos de su raíz (por nombre) o reemplazar el archivo de un recurso o el paquete .h5p de una actividad H5P. Quitar o reemplazar BORRA el archivo anterior (R3, sin deshacer). Las rutas locales requieren el servidor local. No escribe.",
    inputShape: shape,
    fileParams: ["add_files"],
    capability: "edit_activity",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const add = input.add_file_paths ?? [];
        // Archivos del cliente (ChatGPT): el motor ya los bajó y validó (`add_files` → `chat_files.add_files`).
        const chat = (input as { chat_files?: Record<string, PlanFile[]> }).chat_files?.add_files ?? [];
        const remove = input.remove_filenames ?? [];
        if (add.length && input.add_files) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá add_file_paths o add_files, no los dos.");
        if (!add.length && !chat.length && !remove.length) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá add_file_paths, add_files o remove_filenames.");
        const m = await moduleOf(ctx, input.course_id, input.course_module_id);
        if (m.modname !== "folder" && m.modname !== "resource" && m.modname !== "h5pactivity") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${m.id} no es una carpeta, un archivo ni una actividad H5P (es ${m.modname}).`);
        const files = chat.length ? chat : add.length ? describeLocalFiles(add, Math.min(MAX_FILE_BYTES, ctx.profile.read_profile.limits.max_file_bytes), 10) : [];
        return buildActivityFilesDraft(input.course_id, m, await filesOf(ctx, input.course_id, m), files, remove, null);
    },
    async undo(plan, result, ctx) {
        if (!result.items.some((r) => r.outcome === "verificado" || r.outcome === "con_diferencias")) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const p = plan.payload_preview as { remove: string[]; add: { filename: string }[] };
        if (p.remove.length) return { kind: "ninguno", reason: "Se quitaron o reemplazaron archivos: no hay copia para restaurarlos." };
        const m = await moduleOf(ctx, plan.course_id, Number(plan.items[0]!.target.cmid));
        return { kind: "plan", draft: buildActivityFilesDraft(plan.course_id, m, folderFiles(m), [], p.add.map((f) => f.filename), result.action_id) };
    },
};
