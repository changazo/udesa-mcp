import { CampusError } from "../errors.js";

/**
 * Política del transporte web autenticado (directiva de lecturas docentes, §3.1 y §4).
 * Autoriza la combinación método + ruta/función + argumentos ANTES de emitir la petición. Una
 * función «de lectura» o un GET no bastan: cada entrada está auditada en el código oficial de
 * Moodle 5.1 (revisión 7637a7b6dac4d4148012d515a2f505b52c6bc248). Ver docs/HERRAMIENTAS.md.
 *
 * No hay operación genérica: ni URL libre, ni AJAX libre, ni formularios.
 */

type Validator = (v: string) => boolean;
const int: Validator = (v) => /^\d{1,12}$/.test(v);
const oneOf =
    (...values: string[]): Validator =>
    (v) => values.includes(v);
const day: Validator = (v) => /^\d{9,11}$/.test(v); // marca de tiempo de inicio de día

export interface WebRoute {
    /** Ruta relativa a la instalación de Moodle. */
    path: string;
    /**
     * Para rutas con argumentos en el camino (pluginfile.php): arma la ruta a partir de parámetros
     * ya validados. Esos parámetros (pathParams) no viajan en la query.
     */
    pathTemplate?: (p: Record<string, string>) => string;
    pathParams?: readonly string[];
    /** Parámetros admitidos y su validación. Cualquier otro se rechaza. */
    params: Record<string, Validator>;
    required: string[];
    /** El transporte agrega el sesskey de la sesión; nunca lo aporta quien llama. */
    sesskey: boolean;
    /** Efectos del flujo completo, auditados. */
    effects: string;
}

export const WEB_ROUTES = {
    /** Página propia sin eventos ni escrituras: verifica identidad y obtiene el sesskey. */
    identity: {
        path: "/user/preferences.php",
        params: {},
        required: [],
        sesskey: false,
        effects: "Ninguno (sólo require_login y renderizado).",
    },
    /** Exportación XML de UNA pregunta (question/bank/exporttoxml/exportone.php). */
    question_export_one: {
        path: "/question/bank/exporttoxml/exportone.php",
        params: { id: int, cmid: int },
        required: ["id", "cmid"],
        sesskey: true,
        effects: "Ninguno: carga la pregunta, verifica moodle/question:view y exporta. No crea categorías ni previsualiza.",
    },
    /**
     * Exportación Moodle XML de una categoría y sus descendientes (question_pluginfile, área «export»).
     * Contexto y categoría salen siempre de datos verificados (banco del curso + regla aleatoria).
     */
    question_export_category: {
        path: "/pluginfile.php",
        pathTemplate: (p: Record<string, string>) => `/pluginfile.php/${p.contextid}/question/export/${p.categoryid}/xml/withcategories/withcontexts/categoria-${p.categoryid}.xml`,
        pathParams: ["contextid", "categoryid"],
        params: { contextid: int, categoryid: int, forcedownload: oneOf("1") },
        required: ["contextid", "categoryid", "forcedownload"],
        sesskey: false,
        effects:
            "Ninguno: require_login, permiso de exportar en el contexto del banco, lectura de la categoría y de las últimas versiones (get_questions_category) y armado del archivo en memoria. Omite versiones ocultas, preguntas aleatorias, tipos ausentes y preguntas sin permiso de ver.",
    },
    /**
     * Lista de sesiones de una actividad de Asistencia (mod/attendance/manage.php, plugin 2025122100),
     * vista «todas» y todos los tipos de sesión. Da el ID de cada sesión y si ya se tomó.
     */
    /** Página de edición de un cuestionario: páginas, secciones (con su id) y slots (ADR-091). */
    /** Página de preguntas de una encuesta (mod_questionnaire; ADR-097). */
    questionnaire_questions: {
        path: "/mod/questionnaire/questions.php",
        params: { id: int },
        required: ["id"],
        sesskey: false,
        effects: "Ninguno: require_login y lista de preguntas. Sus botones (mover, editar, borrar) van por POST, que esta ruta nunca envía.",
    },
    quiz_edit_page: {
        path: "/mod/quiz/edit.php",
        params: { cmid: int },
        required: ["cmid"],
        sesskey: false,
        effects: "Registra el evento edit_page_viewed (registro de acceso). Sin escrituras: los cambios de esa página van por POST con sesskey, que esta ruta nunca envía.",
    },
    attendance_sessions: {
        path: "/mod/attendance/manage.php",
        params: { id: int, view: oneOf("5"), group: oneOf("-1") },
        required: ["id", "view", "group"],
        sesskey: false,
        effects:
            "Sin eventos ni escrituras en la base: require_login y lectura de sesiones. Guarda en la SESIÓN (no persistente) la vista y el tipo de sesión de ese curso, que comparte el navegador de origen. Nunca se envía «from» (redirige a tomar asistencia).",
    },
    /** Reporte de registros del curso (report/log). */
    course_log: {
        path: "/report/log/index.php",
        params: {
            id: int,
            chooselog: oneOf("1"),
            user: int,
            date: day,
            modid: int,
            modaction: oneOf("c", "r", "u", "d", "cud", "-view"),
            group: int,
            edulevel: oneOf("-1", "0", "1", "2"),
            origin: oneOf("", "cli", "restore", "web", "ws"),
            logreader: oneOf("logstore_standard"),
            page: int,
            perpage: oneOf("100"),
            download: oneOf("csv"),
        },
        required: ["id", "chooselog"],
        sesskey: false,
        effects: "Registra el evento report_viewed (registro de acceso). Tabla no persistente: no guarda preferencias.",
    },
    /** Reporte de participación (report/participation). */
    participation: {
        path: "/report/participation/index.php",
        params: {
            id: int,
            instanceid: int,
            roleid: int,
            timefrom: int,
            action: oneOf("", "view", "post"),
            page: int,
            perpage: oneOf("100"),
            group: int,
        },
        required: ["id", "instanceid", "roleid"],
        sesskey: false,
        effects: "Registra el evento report_viewed. Usa el grupo activo de la sesión (no persistente).",
    },
    /** Reporte de respuestas de un cuestionario (mod/quiz/report.php?mode=responses). */
    quiz_responses: {
        path: "/mod/quiz/report.php",
        params: {
            id: int,
            mode: oneOf("responses"),
            attempts: oneOf("enrolled_with", "enrolled_without", "enrolled_any", "all_with"),
            onlygraded: oneOf("0", "1"),
            whichtries: oneOf("first", "last", "all"),
            pagesize: oneOf("100"),
            page: int,
            group: int,
            qtext: oneOf("0", "1"),
            resp: oneOf("0", "1"),
            right: oneOf("0", "1"),
            download: oneOf("csv"),
        },
        required: ["id", "mode"],
        sesskey: false,
        effects: "Registra el evento report_viewed. Con parámetros GET no guarda preferencias (sólo el envío del formulario lo hace). Nunca se envían delete ni regrade.",
    },
} as const satisfies Record<string, WebRoute>;

export type WebRouteName = keyof typeof WEB_ROUTES;

/** Métodos AJAX (lib/ajax/service.php) admitidos, con validación cerrada de argumentos. */
export const AJAX_METHODS = {
    /** Estructura de calificación del cuestionario: secciones, slots, puntajes. Sólo lectura. */
    mod_quiz_get_edit_grading_page_data: (a: Record<string, unknown>) => keysOk(a, ["quizid"]) && isInt(a.quizid),
    /** Candidatos para selección aleatoria de una categoría (NO es un catálogo del banco). */
    core_question_get_random_question_summaries: (a: Record<string, unknown>) =>
        keysOk(a, ["categoryid", "includesubcategories", "tagids", "contextid", "limit", "offset"]) &&
        isInt(a.categoryid) &&
        typeof a.includesubcategories === "boolean" &&
        Array.isArray(a.tagids) &&
        a.tagids.length === 0 &&
        isInt(a.contextid) &&
        isInt(a.limit) &&
        (a.limit as number) > 0 &&
        (a.limit as number) <= 200 &&
        isInt(a.offset),
    /** Overrides de un cuestionario (sólo lectura; la contraseña se descarta al proyectar). */
    mod_quiz_get_overrides: (a: Record<string, unknown>) => keysOk(a, ["quizid"]) && isInt(a.quizid),
    /** Bancos compartidos que la cuenta puede ver (filtrados luego por cursos permitidos). */
    core_question_search_shared_banks: (a: Record<string, unknown>) =>
        keysOk(a, ["contextid", "search", "requiredcapabilities"]) &&
        isInt(a.contextid) &&
        a.search === "" &&
        Array.isArray(a.requiredcapabilities) &&
        a.requiredcapabilities.length === 1 &&
        a.requiredcapabilities[0] === "view",
    /**
     * Segundos que le quedan a la sesión antes de vencer por inactividad (core\session\external::
     * time_remaining → manager::time_remaining: sólo lee el registro de la sesión). Sin argumentos.
     * Se usa para medir y mantener la sesión web; el «touch» lo hace la página de identidad.
     */
    core_session_time_remaining: (a: Record<string, unknown>) => keysOk(a, []),
    /**
     * Nota actual de un participante en la calificación del foro completo (panel de calificación,
     * sólo lectura; ADR-070). Sólo mod_forum/forum: lo usa el servidor de escritura para planificar y verificar.
     */
    core_grades_grader_gradingpanel_point_fetch: (a: Record<string, unknown>) =>
        keysOk(a, ["component", "contextid", "itemname", "gradeduserid"]) && a.component === "mod_forum" && a.itemname === "forum" && isInt(a.contextid) && isInt(a.gradeduserid),
} as const;

export type AjaxMethod = keyof typeof AJAX_METHODS;

function keysOk(a: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(a).every((k) => allowed.includes(k));
}
function isInt(v: unknown): boolean {
    return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Parámetros que ninguna operación web puede llevar: escrituras, preferencias de tabla, credenciales. */
const FORBIDDEN_PARAMS = /^(sesskey|delete|regrade|regradeall|regradealldry|regradealldrydo|recalculate|treset|tsort|thide|tshow|tifirst|tilast|attemptid|attemptids|confirm|logintoken|password|token|wstoken)$/i;

/** Valida una petición a una ruta web antes de emitirla. Lanza POLICY_DENIED si no cumple. */
export function assertWebRoute(name: WebRouteName, params: Record<string, string>): WebRoute {
    const route = WEB_ROUTES[name] as WebRoute | undefined;
    if (!route) throw new CampusError("POLICY_DENIED", `Operación web no admitida: ${String(name)}.`);
    for (const [k, v] of Object.entries(params)) {
        if (FORBIDDEN_PARAMS.test(k)) throw new CampusError("POLICY_DENIED", `Parámetro web prohibido: ${k}.`);
        const ok = route.params[k];
        if (!ok) throw new CampusError("POLICY_DENIED", `Parámetro web no admitido para ${String(name)}: ${k}.`);
        if (typeof v !== "string" || !ok(v)) throw new CampusError("POLICY_DENIED", `Valor no admitido para ${k} en ${String(name)}.`);
    }
    for (const r of route.required) {
        if (!(r in params)) throw new CampusError("POLICY_DENIED", `Falta el parámetro ${r} para ${String(name)}.`);
    }
    return route;
}

/** Valida una llamada AJAX antes de emitirla. */
export function assertAjax(method: string, args: Record<string, unknown>): asserts method is AjaxMethod {
    const check = (AJAX_METHODS as Record<string, ((a: Record<string, unknown>) => boolean) | undefined>)[method];
    if (!check) throw new CampusError("POLICY_DENIED", `Función AJAX no admitida: ${method}.`);
    if (!check(args)) throw new CampusError("POLICY_DENIED", `Argumentos no admitidos para ${method}.`);
}
