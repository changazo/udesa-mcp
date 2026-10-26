import { z } from "zod";
import { CampusError } from "../../errors.js";
import { LAB_BASE_URL, LAB_LTI11_KEY, PythonExerciseSpec, pythonExerciseConfig } from "../../h5p/content-types.js";
import { createContentIntent } from "./content.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * W6 · Herramienta LTI del laboratorio en un curso (ADR-117). Registra la herramienta externa del curso
 * con las URLs del laboratorio fijas, SIN nombre ni correo de los participantes y sólo notas.
 * - LTI 1.1 (por defecto): clave fija y secreto compartido tomado del entorno al enviar
 *   (CAMPUS_LAB_LTI11_SECRET, igual a LTI11_SECRET del laboratorio). La nota usa Basic Outcomes
 *   (mod/lti/service.php), que funciona en el Campus de UdeSA.
 * - LTI 1.3: conjunto de claves; Moodle asigna un ID de cliente y el ID de implementación es el de la
 *   herramienta (se devuelven para LTI_REGISTRATIONS). En el Campus de UdeSA la nota por AGS no llega:
 *   según la configuración del servidor, mod/lti/services.php puede no recibir la ruta.
 */

export interface CourseTool {
    typeid: number | null;
    name: string;
}

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Herramientas de la tabla «Herramientas externas LTI» del curso (nombre y, si aparece, typeid). */
export function parseCourseTools(html: string): CourseTool[] {
    const main = html.slice(Math.max(0, html.indexOf('role="main"')));
    const rows = [...main.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[0]);
    const out: CourseTool[] = [];
    for (const r of rows) {
        const cells = [...r.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!);
        if (!cells.length) continue;
        const name = strip(cells[0]!);
        if (!name) continue;
        const id = /typeid=(\d+)|data-(?:typeid|tool-?id|id)="(\d+)"/.exec(r);
        out.push({ name, typeid: id ? Number(id[1] ?? id[2]) : null });
    }
    return out;
}

/** ID de cliente LTI 1.3 del formulario de la herramienta (campo o texto «ID de cliente»). */
export function parseClientId(html: string): string | null {
    return /name="lti_clientid(?:_disabled)?"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? /value="([^"]+)"[^>]*name="lti_clientid/.exec(html)?.[1] ?? null;
}

async function toolsOf(ctx: IntentContext, courseId: number) {
    return parseCourseTools(await ctx.web.readPage("lti_course_tools", { id: String(courseId) }));
}

async function readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>> {
    const out: Record<string, string | null> = {};
    for (const k of Object.keys(plan.preconditions.versions)) {
        const [kind, course] = k.split(":");
        out[k] = kind === "ltitools" ? JSON.stringify((await toolsOf(ctx, Number(course))).map((t) => t.name).sort()) : null;
    }
    return out;
}

function interpret(): Interpretation {
    return { ok: true };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const name = String(item.expected.name);
    const tools = await toolsOf(ctx, plan.course_id);
    const t = tools.find((x) => x.name === name);
    if (!t) return { outcome: "sin_efecto", checked: ["herramienta"], differences: [{ field: "herramienta", expected: name, observed: "no aparece" }] };
    if (!t.typeid || item.expected.lti_version === "1.1") return { outcome: "coincide", checked: ["herramienta"], differences: [], ...(t.typeid ? { moodle_ids: { typeid: t.typeid } } : {}) };
    // ID de cliente (lo genera Moodle) e ID de implementación (= typeid): lo que necesita el laboratorio.
    const clientId = parseClientId(await ctx.web.readPage("lti_course_tool_form", { course: String(plan.course_id), typeid: String(t.typeid) }));
    return {
        outcome: "coincide",
        checked: ["herramienta", "client_id"],
        differences: [],
        moodle_ids: { typeid: t.typeid },
        ...(clientId ? { note: `Registro para el laboratorio: agregar «${clientId}:${t.typeid}» a LTI_REGISTRATIONS (ID de cliente : ID de implementación) y redesplegarlo.` } : {}),
    };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    return (await verify(item, plan, ctx)).outcome === "coincide" ? "presente" : "ausente";
}

const shape = {
    course_id: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional().describe("Nombre de la herramienta en el curso (por defecto «Laboratorio UdeSA»)."),
    lti_version: z.enum(["1.1", "1.3"]).optional().describe("Por defecto 1.1: en el Campus de UdeSA sólo la 1.1 registra la nota (la 1.3 abre el ejercicio pero su servicio de notas no responde)."),
};

export const labLtiToolIntent: WriteIntent<typeof shape> = {
    name: "lab_lti_tool",
    title: "Plan: registrar en el curso la herramienta LTI del laboratorio",
    description:
        "Arma el plan para registrar en el curso la herramienta externa LTI del laboratorio (ejercicios de Python con nota). Fija URLs, claves y privacidad: no se envían nombres ni correos, sólo la nota. Por defecto LTI 1.1 (clave y secreto compartido del entorno del servidor); con 1.3 hay que cargar después el ID de cliente y de implementación en el laboratorio. No escribe.",
    inputShape: shape,
    capability: "create_content",
    synthetic_only: false,
    readVersions,
    interpret,
    verify,
    reconcile,
    async plan(input, ctx): Promise<PlanDraft> {
        const name = input.name ?? "Laboratorio UdeSA";
        const tools = await toolsOf(ctx, input.course_id);
        if (tools.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `El curso ya tiene una herramienta «${name}».`);
        const v11 = (input.lti_version ?? "1.1") === "1.1";
        if (v11 && !process.env.CAMPUS_LAB_LTI11_SECRET) throw new CampusError("WRITE_NOT_ALLOWED", "Falta CAMPUS_LAB_LTI11_SECRET en el entorno del servidor (el mismo secreto que LTI11_SECRET del laboratorio).");
        const fields11 = {
            lti_typename: name,
            lti_description: "Ejercicios del laboratorio de la cátedra (Python con pruebas automáticas). No recibe nombres ni correos.",
            lti_toolurl: `${LAB_BASE_URL}/api/lti/launch11`,
            lti_ltiversion: "LTI-1p0",
            lti_resourcekey: LAB_LTI11_KEY,
            lti_customparameters: "",
            lti_launchcontainer: "3",
            lti_contentitem: "0",
            ltiservice_gradesynchronization: "0",
            ltiservice_memberships: "0",
            ltiservice_toolsettings: "0",
            lti_sendname: "0",
            lti_sendemailaddr: "0",
            lti_acceptgrades: "1",
            lti_forcessl: "1",
        };
        const fields13 = {
            lti_typename: name,
            lti_description: "Ejercicios del laboratorio de la cátedra (Python con pruebas automáticas). No recibe nombres ni correos.",
            lti_toolurl: `${LAB_BASE_URL}/api/lti/launch`,
            lti_ltiversion: "1.3.0",
            lti_keytype: "JWK_KEYSET",
            lti_publickeyset: `${LAB_BASE_URL}/api/lti/jwks`,
            lti_initiatelogin: `${LAB_BASE_URL}/api/lti/login`,
            lti_redirectionuris: `${LAB_BASE_URL}/api/lti/launch`,
            lti_customparameters: "",
            lti_launchcontainer: "3",
            lti_contentitem: "0",
            ltiservice_gradesynchronization: "1",
            ltiservice_memberships: "0",
            ltiservice_toolsettings: "0",
            lti_sendname: "0",
            lti_sendemailaddr: "0",
            lti_acceptgrades: "1",
            lti_forcessl: "1",
        };
        return {
            intent: "lab_lti_tool",
            capability: "create_content",
            course_id: input.course_id,
            base_risk: "R2",
            summary: `Registrar en el curso ${input.course_id} la herramienta LTI ${v11 ? "1.1" : "1.3"} «${name}» del laboratorio (${LAB_BASE_URL}).`,
            payload_preview: { name, base_url: LAB_BASE_URL, lti_version: v11 ? "1.1" : "1.3", ...(v11 ? { consumer_key: LAB_LTI11_KEY, secret: "del entorno del servidor al enviar (no figura en el plan)" } : {}), privacy: { send_name: false, send_email: false }, services: { grades: "sólo sincronizar notas", memberships: false, tool_settings: false }, launch: "incrustada, sin bloques" },
            side_effects: ["Agrega una herramienta externa al curso (visible para docentes al crear actividades). No cambia nada para los estudiantes hasta que se cree una actividad.", "Sin notificaciones."],
            preconditions: { description: "Las herramientas del curso no cambiaron desde el plan.", versions: { [`ltitools:${input.course_id}`]: JSON.stringify(tools.map((t) => t.name).sort()) } },
            undo: { kind: "ninguno", how: "Borrarla desde Herramientas externas LTI del curso (no hay borrado tipado todavía).", until: null },
            warnings: ["Formulario web: requiere la sesión web del Campus.", v11 ? "El secreto compartido tiene que ser el mismo en el servidor (CAMPUS_LAB_LTI11_SECRET) y en el laboratorio (LTI11_SECRET)." : "Después del alta: cargar el ID de cliente y el de implementación en el laboratorio (LTI_REGISTRATIONS) y redesplegarlo. En el Campus de UdeSA la nota por LTI 1.3 no llega: para notas, usá LTI 1.1."],
            items: [{ item_id: "i1", description: `Herramienta LTI «${name}»`, call: { kind: "form", fn: v11 ? "lab_lti11_tool_add" : "lab_lti_tool_add", params: { query: { course: String(input.course_id) }, fields: v11 ? fields11 : fields13 } }, target: { course_id: input.course_id }, expected: { name, lti_version: v11 ? "1.1" : "1.3" } }],
            prior_state: {},
            untrusted_fields: [],
            teacher_text: { name },
            undo_of: null,
        };
    },
    async undo() {
        return { kind: "ninguno", reason: "Borrar la herramienta desde Herramientas externas LTI del curso." };
    },
};

// ---------- actividad LTI con un ejercicio del laboratorio ----------

const exerciseShape = {
    course_id: z.number().int().positive(),
    section: z.number().int().min(0).max(200).describe("Número de sección EXISTENTE."),
    name: z.string().trim().min(1).max(255).describe("Nombre de la actividad."),
    visible: z.boolean().optional().describe("Por defecto false (oculta)."),
    max_grade: z.number().int().min(1).max(100).optional().describe("Nota máxima en el libro de calificaciones (por defecto 10). La nota es proporcional a las pruebas que pasan."),
    tool_id: z.number().int().positive().optional().describe("typeid de la herramienta del laboratorio en el curso (por defecto, la llamada «Laboratorio UdeSA»)."),
    exercise: PythonExerciseSpec.omit({ type: true, height_px: true }).describe("Ejercicio de Python: title, statement, function_name, starter_code, tests (input, expected, hidden)."),
};

export const labLtiExerciseIntent: WriteIntent<typeof exerciseShape> = {
    name: "lab_lti_exercise",
    title: "Plan: actividad LTI con nota (ejercicio de Python del laboratorio)",
    description:
        "Arma el plan para crear una actividad LTI que abre un ejercicio de Python del laboratorio y registra la nota en el libro de calificaciones (proporcional a las pruebas que pasa; la calcula el navegador: es práctica calificada, no examen). Requiere la herramienta del laboratorio registrada en el curso (campus_plan_lab_lti_tool). Oculta por defecto, sin notificar. No escribe.",
    inputShape: exerciseShape,
    capability: "create_content",
    synthetic_only: false,
    readVersions: createContentIntent.readVersions,
    interpret: createContentIntent.interpret,
    verify: createContentIntent.verify,
    reconcile: createContentIntent.reconcile,
    async plan(input, ctx): Promise<PlanDraft> {
        const ex = PythonExerciseSpec.omit({ type: true, height_px: true }).safeParse(input.exercise);
        if (!ex.success) throw new CampusError("WRITE_NOT_ALLOWED", `Ejercicio inválido: ${ex.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 6).join("; ")}`);
        const tools = await toolsOf(ctx, input.course_id);
        const tool = input.tool_id ? tools.find((t) => t.typeid === input.tool_id) : tools.find((t) => /^Laboratorio UdeSA/i.test(t.name));
        if (!tool?.typeid) throw new CampusError("WRITE_NOT_ALLOWED", "El curso no tiene la herramienta del laboratorio: registrala antes con campus_plan_lab_lti_tool.");
        const sections = await ctx.read.session.transport.call("core_course_get_contents", { courseid: input.course_id, options: [{ name: "excludecontents", value: 1 }] }, ContentsSchema);
        if (!sections.some((s) => s.section === input.section)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La sección ${input.section} no existe.`);
        const priorCmids = sections.flatMap((s) => s.modules).map((m) => m.id);
        const visible = input.visible ?? false;
        const maxGrade = input.max_grade ?? 10;
        const config = pythonExerciseConfig(ex.data);
        const fields: Record<string, string> = {
            name: input.name,
            "introeditor[text]": "",
            "introeditor[format]": "1",
            typeid: String(tool.typeid),
            instructorcustomparameters: `ejercicio=${config}`,
            instructorchoiceacceptgrades: "1",
            "grade[modgrade_type]": "point",
            "grade[modgrade_point]": String(maxGrade),
            visible: visible ? "1" : "0",
            coursecontentnotification: "0",
        };
        return {
            intent: "create_content",
            capability: "create_content",
            course_id: input.course_id,
            base_risk: visible ? "R2" : "R1",
            summary: `Crear la actividad LTI «${input.name}» ${visible ? "VISIBLE" : "oculta"} en la sección ${input.section}: ejercicio de Python «${ex.data.title}» con nota sobre ${maxGrade}.`,
            payload_preview: { type: "lti", tool: { typeid: tool.typeid, name: tool.name }, name: input.name, section: input.section, visible, max_grade: maxGrade, exercise: { title: ex.data.title, function_name: ex.data.function_name, tests: ex.data.tests.length, hidden_tests: ex.data.tests.filter((t) => t.hidden).length }, privacy: "sin nombre ni correo; la nota viaja con un identificador opaco" },
            side_effects: [visible ? "Visible para los estudiantes en cuanto se crea." : "Oculta: los estudiantes no la ven hasta que se muestre.", "Crea su columna en el libro de calificaciones.", "Sin notificaciones."],
            preconditions: { description: "La sección sigue existiendo.", versions: {} },
            undo: { kind: "compensación", how: "Borrar la actividad (va a la papelera; su columna de notas se va con ella).", until: null },
            warnings: ["Creación por formulario web: requiere la sesión web del Campus.", "La nota la calcula el navegador del estudiante: sirve para práctica calificada, no para exámenes."],
            items: [
                {
                    item_id: "i1",
                    description: `Nueva actividad LTI «${input.name}» en la sección ${input.section}`,
                    call: { kind: "form", fn: "course_modedit_lti_add_lab", params: { query: { add: "lti", course: String(input.course_id), section: String(input.section), typeid: String(tool.typeid) }, fields } },
                    target: { course_id: input.course_id, section: input.section },
                    expected: { kind: "lti", section: input.section, visible, prior_cmids: priorCmids, name: input.name },
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.tool.name"],
            teacher_text: { name: input.name, exercise: JSON.stringify(ex.data).slice(0, 100_000) },
            undo_of: null,
        };
    },
    async undo(plan, result, ctx) {
        return createContentIntent.undo(plan, result, ctx);
    },
};

const ContentsSchema = z.array(z.object({ section: z.number().nullable().optional(), modules: z.array(z.object({ id: z.number().int() })).default([]) }));
