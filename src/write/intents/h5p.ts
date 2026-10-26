import { z } from "zod";
import { CampusError } from "../../errors.js";
import { buildContentParams, describeContent, H5pContentSpec, MAIN_LIBRARY, teacherTextOf, type H5pContent } from "../../h5p/content-types.js";
import { withH5pEditor } from "../../h5p/editor.js";
import { buildPackage, ContentFactory, fillDefaults, validateParams } from "../../h5p/semantics.js";
import { describeGeneratedFile } from "../files.js";
import type { IntentContext, WriteIntent } from "../intent.js";
import type { PlanDraft } from "../plan.js";
import { buildActivityFilesDraft, filesOf, moduleOf } from "./activity-files.js";
import { createContentIntent } from "./content.js";

/**
 * W6 · Contenido H5P generado por el MCP (ADR-110 y 111): Question Set, Course Presentation, Interactive
 * Book, Interactive Video, Branching Scenario, Dialog Cards, Chart, Timeline y Accordion, desde un
 * esquema tipado por tipo (no parámetros H5P crudos).
 * - El paquete se arma en el servidor SIN bibliotecas (sólo `h5p.json` y `content/content.json`) con
 *   las versiones instaladas en el Campus; los valores por defecto y los textos de la interfaz salen
 *   de la semántica y la traducción que sirve el editor H5P del Campus, y el contenido se valida
 *   contra esa semántica antes del plan.
 * - El paquete viaja dentro del plan firmado: funciona también en el remoto (sin archivos locales).
 * - create: actividad H5P nueva (oculta por defecto); la verifica y la deshace `create_content`.
 * - replace: reemplaza el paquete de una actividad H5P existente; lo verifica `activity_files` (R3,
 *   sin deshacer automático: el paquete anterior no se guarda).
 */

const MAX_PACKAGE_BYTES = 512 * 1024;
const MAX_ROUNDS = 6;

const shape = {
    course_id: z.number().int().positive(),
    operation: z.enum(["create", "replace"]).describe("create: actividad H5P nueva; replace: reemplazar el contenido de una existente."),
    section: z.number().int().min(0).max(200).optional().describe("create: número de sección EXISTENTE."),
    name: z.string().trim().min(1).max(255).optional().describe("create: nombre de la actividad (también es el título del contenido)."),
    intro: z.string().max(10_000).optional().describe("create: descripción de la actividad (Markdown)."),
    visible: z.boolean().optional().describe("create: por defecto false (oculta)."),
    course_module_id: z.number().int().positive().optional().describe("replace: cmid de la actividad H5P."),
    content: H5pContentSpec.describe(
        "Contenido, según type: question_set (questions), course_presentation (slides con blocks), interactive_book (chapters con blocks), interactive_video (video_url, interactions), branching_scenario (nodes: text con next, choice con options; next = id o «end»), dialog_cards (cards front/back), chart (bar|pie, items), timeline (events con date AAAA-MM-DD), accordion (panels) o python_exercise (ejercicio de Python con pruebas automáticas que corre en el navegador: function_name, tests con input y expected; mini-aplicación del laboratorio, ADR-116). Bloques y preguntas: text (markdown), multiple_choice, true_false, drag_words (palabras entre *asteriscos*), fill_blanks (lines con *respuesta*).",
    ),
};

function slug(name: string): string {
    const s = name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()
        .slice(0, 60);
    return s || "contenido";
}

/** Arma y valida el paquete con la semántica del Campus. */
async function generate(ctx: IntentContext, courseId: number, spec: H5pContent, title: string) {
    const main = MAIN_LIBRARY[spec.type];
    return withH5pEditor(ctx.web, courseId, main.machine, async (ed) => {
        const lib = ed.main;
        if (Number(lib.split(" ")[1]!.split(".")[0]) !== main.major) throw new CampusError("WRITE_NOT_ALLOWED", `El Campus tiene ${lib}; el MCP arma la versión mayor ${main.major}.`);
        await ed.load([lib]);
        for (let round = 0; round < MAX_ROUNDS; round++) {
            const f = new ContentFactory((l) => ed.semantics(l));
            const built = buildContentParams(spec, lib, f);
            if (f.missing.size) {
                await ed.load([...f.missing]);
                continue;
            }
            const params = fillDefaults(lib, built, (l) => ed.semantics(l));
            const errs = validateParams(lib, params, (l) => ed.semantics(l));
            if (errs.length) throw new CampusError("WRITE_NOT_ALLOWED", `El contenido no coincide con la versión instalada (${lib}): ${errs.join(" ")}`, { details: { errors: errs } });
            const pkg = buildPackage(lib, params, title, spec);
            return { main: lib, ...pkg };
        }
        throw new CampusError("UNEXPECTED_RESPONSE", "No se pudieron reunir las semánticas H5P del contenido.");
    });
}

export const h5pContentIntent: WriteIntent<typeof shape> = {
    name: "h5p_content",
    title: "Plan: crear o reemplazar contenido H5P generado (cuestionario, presentación, libro, video, escenario ramificado, tarjetas, gráfico, línea de tiempo, acordeón)",
    description:
        "Arma el plan para crear una actividad H5P (o reemplazar el contenido de una existente) a partir de un esquema tipado: Question Set, Course Presentation, Interactive Book, Interactive Video (YouTube o mp4), Branching Scenario, Dialog Cards, Chart, Timeline o Accordion. El MCP genera el paquete con las bibliotecas instaladas en el Campus y lo valida contra su semántica. Funciona también en el remoto. Para EDITAR uno generado por el MCP: campus_get_activity_content devuelve package_content.spec; modificalo y pasalo con operation=replace. Reemplazar borra el paquete anterior (R3, sin deshacer). Requiere la sesión web. No escribe.",
    inputShape: shape,
    capability: "create_content",
    synthetic_only: false,
    // Verificación, reconciliación y deshacer: los de create_content o activity_files (los planes usan esas intenciones).
    readVersions: createContentIntent.readVersions,
    interpret: createContentIntent.interpret,
    verify: createContentIntent.verify,
    reconcile: createContentIntent.reconcile,
    async plan(input, ctx): Promise<PlanDraft> {
        const parsed = H5pContentSpec.safeParse(input.content);
        if (!parsed.success) throw new CampusError("WRITE_NOT_ALLOWED", `Contenido H5P inválido: ${parsed.error.issues.map((i) => `${i.path.join(".") || "content"}: ${i.message}`).slice(0, 8).join("; ")}`);
        const spec = parsed.data;
        // Límite propio de los paquetes generados (el de descargas del perfil no aplica: no se descarga nada).
        const maxBytes = MAX_PACKAGE_BYTES;
        if (input.operation === "create") {
            if (input.section === undefined || !input.name) throw new CampusError("WRITE_NOT_ALLOWED", "Para create hacen falta section y name.");
            if (input.course_module_id !== undefined) throw new CampusError("WRITE_NOT_ALLOWED", "course_module_id es para replace.");
            const pkg = await generate(ctx, input.course_id, spec, input.name);
            const file = describeGeneratedFile(`${slug(input.name)}.h5p`, pkg.data, maxBytes);
            // El alta la arma create_content (mismo formulario y verificación); se le pasa el paquete generado.
            const draft = await createContentIntent.plan({ course_id: input.course_id, type: "h5pactivity", section: input.section, name: input.name, ...(input.intro ? { intro: input.intro } : {}), ...(input.visible !== undefined ? { visible: input.visible } : {}), generated_file: file } as never, ctx);
            const item = draft.items[0]!;
            item.expected = { ...item.expected, package: [`${file.filename}:${file.size}`] };
            return {
                ...draft,
                summary: `${draft.summary} Contenido H5P generado: ${MAIN_LIBRARY[spec.type].label}.`,
                payload_preview: { ...draft.payload_preview, h5p: { type: spec.type, library: pkg.main, libraries: pkg.libraries, content: describeContent(spec), package: { filename: file.filename, bytes: file.size, sha256: file.sha256 } } },
                warnings: [...draft.warnings, "El paquete lo genera el MCP con las bibliotecas instaladas; el Campus lo despliega al abrirlo por primera vez."],
                teacher_text: { ...draft.teacher_text, h5p: teacherTextOf(spec) },
            };
        }
        if (input.course_module_id === undefined) throw new CampusError("WRITE_NOT_ALLOWED", "Para replace hace falta course_module_id.");
        if (input.section !== undefined || input.name !== undefined || input.intro !== undefined || input.visible !== undefined) throw new CampusError("WRITE_NOT_ALLOWED", "replace sólo cambia el contenido: section, name, intro y visible no corresponden.");
        const m = await moduleOf(ctx, input.course_id, input.course_module_id);
        if (m.modname !== "h5pactivity") throw new CampusError("WRITE_NOT_ALLOWED", `La actividad ${m.id} no es una actividad H5P (es ${m.modname}).`);
        const prior = await filesOf(ctx, input.course_id, m);
        const pkg = await generate(ctx, input.course_id, spec, m.name ?? "Contenido H5P");
        let filename = `${slug(m.name ?? "contenido")}.h5p`;
        // Mismo nombre que el actual: Moodle no lo distinguiría en la verificación por nombre y tamaño.
        if (prior.some((e) => e.startsWith(`${filename}:`))) filename = filename.replace(/\.h5p$/, `-${Date.now().toString(36)}.h5p`);
        const file = describeGeneratedFile(filename, pkg.data, maxBytes);
        const draft = buildActivityFilesDraft(input.course_id, m, prior, [file], [], null);
        return {
            ...draft,
            capability: "edit_activity",
            summary: `Reemplazar el contenido H5P de «${m.name ?? m.id}» por un ${MAIN_LIBRARY[spec.type].label} generado.`,
            payload_preview: { ...draft.payload_preview, h5p: { type: spec.type, library: pkg.main, libraries: pkg.libraries, content: describeContent(spec) } },
            teacher_text: { h5p: teacherTextOf(spec) },
        };
    },
    async undo(plan, result, ctx) {
        return createContentIntent.undo(plan, result, ctx);
    },
};
