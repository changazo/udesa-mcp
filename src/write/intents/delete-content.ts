import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * W6 · Borrar una actividad o una sección con su contenido (directiva §8.9 «Borrar», R4; ADR-067).
 * - `core_courseformat_update_course` con `cm_delete` o `section_delete` (un id por llamada): van a
 *   la PAPELERA del curso (7 días) si el módulo admite copias de seguridad. No hay deshacer
 *   automático: restaurar desde la papelera es manual y crea otro cmid.
 * - Guardas propias (el dueño quitó la aprobación humana, ADR-061):
 *   - `confirm_name` tiene que ser EXACTAMENTE el nombre de la actividad o sección: un id
 *     equivocado no borra nada;
 *   - un único destino por plan, y el plan lista TODO lo que se borra (en una sección, sus módulos);
 *   - la sección 0 (General) no se borra;
 *   - riesgo R4: se ejecuta sólo con la aprobación del usuario (ADR-118); el plan dice cuántos
 *     elementos y archivos (y cuántos MB) se borran, para que la pregunta sea concreta.
 */

const ContentsSchema = z.array(
    z.object({
        id: z.number().int().positive(),
        section: z.number().nullable().optional(),
        name: z.string().nullable().optional(),
        modules: z
            .array(
                z.object({
                    id: z.number().int().positive(),
                    modname: z.string(),
                    name: z.string().nullable().optional(),
                    contents: z.array(z.object({ type: z.string(), filesize: z.number().nullable().optional() })).default([]),
                }),
            )
            .default([]),
    }),
);

const TYPE_ES: Record<string, string> = { resource: "archivo", folder: "carpeta", page: "página", label: "etiqueta", url: "enlace", assign: "tarea", quiz: "cuestionario", forum: "foro", book: "libro", glossary: "glosario", wiki: "wiki", data: "base de datos", choice: "consulta", lesson: "lección", h5pactivity: "H5P", hvp: "H5P", attendance: "asistencia", questionnaire: "encuesta", lti: "herramienta externa", choicegroup: "elección de grupo", subsection: "subsección" };

/** Inventario de lo que se borra (ADR-118): elementos por tipo y archivos del contenido con su tamaño. */
export function inventory(mods: { modname: string; contents: { type: string; filesize?: number | null | undefined }[] }[]) {
    const byType = new Map<string, number>();
    for (const m of mods) byType.set(TYPE_ES[m.modname] ?? m.modname, (byType.get(TYPE_ES[m.modname] ?? m.modname) ?? 0) + 1);
    const files = mods.flatMap((m) => m.contents.filter((c) => c.type === "file"));
    const bytes = files.reduce((a, c) => a + (c.filesize ?? 0), 0);
    const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return {
        types: [...byType].map(([t, n]) => `${n} ${t}`).join(", "),
        files: files.length,
        bytes,
        text: files.length ? `${files.length} archivo(s) adjunto(s), ${size} en total` : "sin archivos adjuntos",
    };
}

async function contents(ctx: IntentContext, courseId: number) {
    return ctx.read.session.transport.call("core_course_get_contents", { courseid: courseId }, ContentsSchema);
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | number | null> = {};
    const c = await contents(ctx, plan.course_id);
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, id] = k.split(":");
        if (kind === "cm") out[k] = c.some((s) => s.modules.some((m) => m.id === Number(id))) ? 1 : null;
        else if (kind === "sectionmods") {
            const s = c.find((x) => x.id === Number(id));
            out[k] = s ? s.modules.map((m) => m.id).sort((a, b) => a - b).join(",") : null;
        } else out[k] = null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const c = await contents(ctx, plan.course_id);
    const t = item.target;
    const still = t.kind === "section" ? c.some((s) => s.id === Number(t.section_id)) : c.some((s) => s.modules.some((m) => m.id === Number(t.cmid)));
    return still ? { outcome: "sin_efecto", checked: [String(t.kind)], differences: [{ field: String(t.kind), expected: "borrado", observed: "sigue" }] } : { outcome: "coincide", checked: [String(t.kind)], differences: [] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    const v = await verify(item, plan, ctx);
    return v.outcome === "coincide" ? "presente" : v.outcome === "sin_efecto" ? "ausente" : "desconocido";
}

const shape = {
    course_id: z.number().int().positive(),
    course_module_id: z.number().int().positive().optional().describe("cmid de la actividad a borrar (o section_number)."),
    section_number: z.number().int().min(1).max(200).optional().describe("Número de la sección a borrar con TODO su contenido (nunca la 0)."),
    confirm_name: z.string().min(1).max(1333).optional().describe("Con course_module_id o section_number: nombre EXACTO de la actividad o sección, como confirmación: si no coincide, no se borra nada."),
    activities: z
        .array(z.object({ course_module_id: z.number().int().positive(), confirm_name: z.string().min(1).max(1333).describe("Nombre EXACTO de esa actividad.") }))
        .min(2)
        .max(20)
        .optional()
        .describe("Varias actividades de una vez (ADR-119), cada una con su nombre exacto; en lugar de course_module_id o section_number."),
};

export const deleteContentIntent: WriteIntent<typeof shape> = {
    name: "delete_content",
    title: "Plan: borrar una actividad o una sección (R4)",
    description:
        "Arma el plan para BORRAR una actividad (course_module_id), varias de una vez (activities, cada una con su nombre) o una sección con todo su contenido (section_number), con confirm_name igual al nombre exacto. El plan cuenta elementos, archivos y MB. Va a la papelera del curso (7 días); no hay deshacer automático. Se pierden entregas, notas, intentos y posts de lo borrado. Preferí ocultar (campus_plan_visibility) si alcanza. No escribe.",
    inputShape: shape,
    capability: "delete_content",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx) {
        const modes = [input.course_module_id, input.section_number, input.activities].filter((x) => x !== undefined).length;
        if (modes !== 1) throw new CampusError("WRITE_NOT_ALLOWED", "Indicá course_module_id, section_number o activities (uno solo).");
        if (!input.activities && !input.confirm_name) throw new CampusError("WRITE_NOT_ALLOWED", "Falta confirm_name: el nombre exacto de lo que se borra.");
        const c = await contents(ctx, input.course_id);
        let draft: Pick<PlanDraft, "summary" | "payload_preview" | "items" | "preconditions" | "side_effects">;
        if (input.activities) {
            // ADR-119: varias actividades, una por ítem, cada una confirmada por su nombre exacto.
            const ids = input.activities.map((a) => a.course_module_id);
            if (new Set(ids).size !== ids.length) throw new CampusError("WRITE_NOT_ALLOWED", "activities repite una actividad.");
            const found = input.activities.map((a) => {
                const s = c.find((x) => x.modules.some((m) => m.id === a.course_module_id));
                const m = s?.modules.find((x) => x.id === a.course_module_id);
                if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${a.course_module_id} no está en el curso ${input.course_id}.`);
                if ((m.name ?? "") !== a.confirm_name) throw new CampusError("WRITE_NOT_ALLOWED", `confirm_name no coincide con el nombre de la actividad ${m.id} («${m.name ?? ""}»): no se borra nada.`);
                if (m.modname === "subsection") throw new CampusError("WRITE_NOT_ALLOWED", `${m.id} es una subsección: borrala como sección (section_number).`);
                if (m.modname === "turnitintooltwo") throw new CampusError("WRITE_NOT_ALLOWED", "Turnitin no se borra por esta vía: borrarlo contacta al servicio externo de Turnitin.");
                return { m, section: s!.section };
            });
            const inv = inventory(found.map((f) => f.m));
            draft = {
                summary: `BORRAR ${found.length} actividades (${inv.types}), ${inv.text}.`,
                payload_preview: { delete: { kind: "actividades", activities: found.map((f) => ({ cmid: f.m.id, type: f.m.modname, name: f.m.name, section: f.section })), files: inv.files, bytes: inv.bytes } },
                side_effects: [
                    `Elementos: ${found.slice(0, 15).map((f) => `«${f.m.name ?? "sin nombre"}» (${TYPE_ES[f.m.modname] ?? f.m.modname}, sección ${f.section})`).join("; ")}${found.length > 15 ? `; y ${found.length - 15} más` : ""}.`,
                    "Se borran también todos sus datos (entregas, notas, intentos, posts), sus ítems de calificación y eventos; los archivos de las entregas no están contados.",
                    "Se borran de a una: si una falla, las anteriores ya quedaron borradas.",
                ],
                preconditions: { description: "Las actividades siguen en el curso.", versions: Object.fromEntries(found.map((f) => [`cm:${f.m.id}`, 1])) },
                items: found.map((f, i) => ({ item_id: `i${i + 1}`, description: `Borrar la actividad ${f.m.id} «${f.m.name ?? ""}»`, call: { kind: "ajax" as const, fn: "core_courseformat_update_course", params: { action: "cm_delete", courseid: input.course_id, ids: [f.m.id] } }, target: { course_id: input.course_id, kind: "actividad", cmid: f.m.id }, expected: { deleted: true } })),
            };
        } else if (input.course_module_id !== undefined) {
            const s = c.find((x) => x.modules.some((m) => m.id === input.course_module_id));
            const m = s?.modules.find((x) => x.id === input.course_module_id);
            if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La actividad ${input.course_module_id} no está en el curso ${input.course_id}.`);
            if ((m.name ?? "") !== input.confirm_name) throw new CampusError("WRITE_NOT_ALLOWED", `confirm_name no coincide con el nombre de la actividad ${m.id} («${m.name ?? ""}»): no se borra nada.`);
            if (m.modname === "subsection") throw new CampusError("WRITE_NOT_ALLOWED", "Es una subsección: borrala como sección (section_number).");
            // Borrar una tarea de Turnitin la borra también en el servicio externo (ADR-083).
            if (m.modname === "turnitintooltwo") throw new CampusError("WRITE_NOT_ALLOWED", "Turnitin no se borra por esta vía: borrarlo contacta al servicio externo de Turnitin.");
            draft = {
                summary: `BORRAR la actividad «${m.name}» (${TYPE_ES[m.modname] ?? m.modname}, cmid ${m.id}) de la sección ${s!.section}${inventory([m]).files ? `, con ${inventory([m]).text}` : ""}.`,
                payload_preview: { delete: { kind: "actividad", cmid: m.id, type: m.modname, name: m.name, section: s!.section } },
                side_effects: [`Se borran sus datos: entregas, notas, intentos o posts de «${m.name}», y su ítem de calificación y eventos.`],
                preconditions: { description: "La actividad sigue en el curso.", versions: { [`cm:${m.id}`]: 1 } },
                items: [{ item_id: "i1", description: `Borrar la actividad ${m.id}`, call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "cm_delete", courseid: input.course_id, ids: [m.id] } }, target: { course_id: input.course_id, kind: "actividad", cmid: m.id }, expected: { deleted: true } }],
            };
        } else {
            const s = c.find((x) => x.section === input.section_number);
            if (!s) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.section_number} no existe.`);
            if ((s.name ?? "") !== input.confirm_name) throw new CampusError("WRITE_NOT_ALLOWED", `confirm_name no coincide con el nombre de la sección ${s.section} («${s.name ?? ""}»): no se borra nada.`);
            const mods = s.modules.map((m) => ({ cmid: m.id, type: m.modname, name: m.name ?? null }));
            const inv = inventory(s.modules);
            if (mods.some((m) => m.type === "turnitintooltwo")) throw new CampusError("WRITE_NOT_ALLOWED", "La sección tiene una tarea de Turnitin: borrarla contactaría al servicio externo. Mové o borrá eso a mano primero.");
            draft = {
                summary: mods.length ? `BORRAR la sección ${s.section} «${s.name}»: ${mods.length} elemento(s) (${inv.types}), ${inv.text}.` : `BORRAR la sección ${s.section} «${s.name}» (vacía).`,
                payload_preview: { delete: { kind: "sección", section_id: s.id, section_number: s.section, name: s.name, modules: mods, files: inv.files, bytes: inv.bytes } },
                side_effects: [
                    ...(mods.length ? [`Elementos: ${mods.slice(0, 15).map((m) => `«${m.name ?? "sin nombre"}» (${TYPE_ES[m.type] ?? m.type})`).join("; ")}${mods.length > 15 ? `; y ${mods.length - 15} más` : ""}.`, `Se borran también todos sus datos (entregas, notas, intentos, posts); los archivos de las entregas no están contados.`, ...(mods.some((m) => m.type === "subsection") ? ["Las subsecciones se borran con todo su contenido, que no está contado arriba."] : [])] : ["La sección está vacía."]),
                    "Las secciones siguientes se renumeran.",
                ],
                preconditions: { description: "La sección sigue existiendo con las mismas actividades.", versions: { [`sectionmods:${s.id}`]: s.modules.map((m) => m.id).sort((a, b) => a - b).join(",") } },
                items: [{ item_id: "i1", description: `Borrar la sección ${s.section} (id ${s.id})`, call: { kind: "ajax", fn: "core_courseformat_update_course", params: { action: "section_delete", courseid: input.course_id, ids: [s.id] } }, target: { course_id: input.course_id, kind: "section", section_id: s.id }, expected: { deleted: true } }],
            };
        }
        return {
            intent: "delete_content",
            capability: "delete_content",
            course_id: input.course_id,
            base_risk: "R4",
            ...draft,
            side_effects: [...draft.side_effects, "Va a la papelera del curso por 7 días (si el módulo admite copias de seguridad). Restaurarla es manual y crea otro cmid.", "Sin notificaciones."],
            undo: { kind: "ninguno", how: "restaurar a mano desde la papelera del curso dentro de 7 días.", until: null },
            warnings: ["R4: borrado. Confirmado por nombre exacto (confirm_name)."],
            prior_state: {},
            untrusted_fields: ["payload_preview.delete"],
            teacher_text: {},
            undo_of: null,
        };
    },
    async undo() {
        return { kind: "ninguno", reason: "El borrado no tiene deshacer automático: restaurá desde la papelera del curso (7 días)." };
    },
};
