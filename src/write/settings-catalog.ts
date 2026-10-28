/**
 * Catálogo de ajustes editables por tipo de actividad (ADR-082), sobre `/course/modedit.php?update`.
 * Cada ajuste: clave pública → campo del formulario, tipo de control y valores admitidos. El control
 * importa: un `select` y un `advcheckbox` (oculto 0 + casilla 1) se mandan con su valor; una casilla
 * simple (`checkbox`) en 0 se OMITE (Moodle la da por marcada si llega con cualquier valor).
 * Quedan afuera a propósito: contraseñas, avisos y notificaciones, envío en grupo y anonimato de tareas,
 * la nota máxima con notas puestas (reescala), Turnitin y plagio, Safe Exam Browser, y cualquier cosa que notifique o contacte un
 * servicio externo.
 */

export type Control = "select" | "advcheckbox" | "checkbox" | "int";
export interface SettingDef {
    field: string;
    control: Control;
    /** Valores públicos → valor del formulario (select). Para booleanos: true → "1", false → "0". */
    values?: Record<string, string>;
    /** Valores del formulario que sólo se aceptan al deshacer (restaurar lo que había), nunca como pedido. */
    restore?: string[];
    /** Rango para enteros (select numérico o texto). */
    min?: number;
    max?: number;
    help: string;
}

const yesNo = (field: string, help: string): SettingDef => ({ field, control: "select", values: { true: "1", false: "0" }, help });
const box = (field: string, help: string): SettingDef => ({ field, control: "checkbox", help });
const adv = (field: string, help: string): SettingDef => ({ field, control: "advcheckbox", help });
const int = (field: string, min: number, max: number, help: string): SettingDef => ({ field, control: "int", min, max, help });
const pick = (field: string, values: Record<string, string>, help: string): SettingDef => ({ field, control: "select", values, help });

/** Comunes (sólo se ofrecen si el formulario del tipo los trae). */
export const COMMON_SETTINGS: Record<string, SettingDef> = {
    group_mode: pick("groupmode", { none: "0", separate: "1", visible: "2" }, "Modo de grupos: none, separate o visible."),
    grouping_id: int("groupingid", 0, 1e12, "Agrupamiento de la actividad (0 = ninguno)."),
    show_description: adv("showdescription", "Mostrar la descripción en la página del curso."),
};

const QUIZ_REVIEW: Record<string, SettingDef> = {};
for (const what of ["attempt", "correctness", "maxmarks", "marks", "specificfeedback", "generalfeedback", "rightanswer", "overallfeedback"]) {
    for (const when of ["during", "immediately", "open", "closed"]) QUIZ_REVIEW[`review_${what}_${when}`] = box(`${what}${when}`, `Revisión: mostrar «${what}» ${when === "during" ? "durante el intento" : when === "immediately" ? "inmediatamente después" : when === "open" ? "después, con el cuestionario abierto" : "después del cierre"}.`);
}

export const KIND_SETTINGS: Record<string, Record<string, SettingDef>> = {
    choice: {
        allow_update: yesNo("allowupdate", "Permitir cambiar la elección."),
        allow_multiple: yesNo("allowmultiple", "Permitir elegir más de una opción."),
        limit_answers: yesNo("limitanswers", "Limitar las respuestas por opción (los límites se fijan con campus_plan_choice_options)."),
        show_results: pick("showresults", { never: "0", after_answer: "1", after_close: "2", always: "3" }, "Cuándo ven los resultados: never, after_answer, after_close o always."),
        publish_names: pick("publish", { false: "0", true: "1" }, "Resultados con nombres (true) o anónimos (false)."),
        show_unanswered: yesNo("showunanswered", "Mostrar la columna de los que no respondieron."),
        include_inactive: yesNo("includeinactive", "Incluir respuestas de inactivos o suspendidos."),
        show_available: yesNo("showavailable", "Mostrar los lugares disponibles."),
        vertical: pick("display", { false: "0", true: "1" }, "Opciones en vertical (true) u horizontal (false)."),
        show_preview: adv("showpreview", "Mostrar una vista previa antes de abrir."),
    },
    forum: {
        forum_type: pick("type", { general: "general", eachuser: "eachuser", qanda: "qanda", blog: "blog" }, "Tipo: general, eachuser, qanda o blog (no «single»: crearía una discusión)."),
        subscription: pick("forcesubscribe", { optional: "0", disabled: "3" }, "Suscripción: optional o disabled (nunca forzada ni automática: notificarían)."),
        max_attachments: pick("maxattachments", Object.fromEntries(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "20", "50", "100"].map((v) => [v, v])), "Adjuntos por mensaje."),
        max_bytes: pick("maxbytes", { course: "0", "5MB": "5242880", "2MB": "2097152", "1MB": "1048576", "500KB": "512000", "100KB": "102400", none: "1" }, "Tamaño máximo de adjuntos: course, 5MB, 2MB, 1MB, 500KB, 100KB o none."),
        word_count: yesNo("displaywordcount", "Mostrar la cantidad de palabras."),
        tracking: pick("trackingtype", { optional: "1", off: "0" }, "Seguimiento de leídos: optional u off."),
        lock_after_days: pick("lockdiscussionafter", { "0": "0", "1": "86400", "7": "604800", "14": "1209600", "30": "2592000", "60": "5184000", "90": "7776000", "180": "15552000", "365": "31536000" }, "Bloquear discusiones sin actividad después de N días (0 = no)."),
    },
    glossary: {
        default_approval: yesNo("defaultapproval", "Aprobar automáticamente las entradas de estudiantes."),
        edit_always: yesNo("editalways", "Permitir editar siempre."),
        allow_duplicates: yesNo("allowduplicatedentries", "Permitir entradas duplicadas."),
        allow_comments: yesNo("allowcomments", "Permitir comentarios."),
        auto_linking: yesNo("usedynalink", "Enlace automático a las entradas."),
        display_format: pick("displayformat", { fullwithauthor: "fullwithauthor", fullwithoutauthor: "fullwithoutauthor", continuous: "continuous", encyclopedia: "encyclopedia", faq: "faq", entrylist: "entrylist", dictionary: "dictionary" }, "Formato de visualización."),
        entries_per_page: int("entbypage", 1, 200, "Entradas por página."),
        show_alphabet: yesNo("showalphabet", "Mostrar el alfabeto."),
        show_all: yesNo("showall", "Mostrar «TODAS»."),
        show_special: yesNo("showspecial", "Mostrar «Especial»."),
        allow_print: yesNo("allowprintview", "Permitir la vista de impresión."),
    },
    data: {
        approval: yesNo("approval", "Las entradas requieren aprobación."),
        manage_approved: yesNo("manageapproved", "Permitir editar entradas ya aprobadas."),
        comments: yesNo("comments", "Permitir comentarios."),
        required_entries_to_view: int("requiredentriestoview", 0, 1000, "Entradas propias necesarias para ver las demás."),
        max_entries: int("maxentries", 0, 1000, "Máximo de entradas por participante (0 = sin límite)."),
    },
    choicegroup: {
        allow_update: yesNo("allowupdate", "Permitir cambiar la elección."),
        multiple_enrollments: box("multipleenrollmentspossible", "Permitir inscribirse en varios grupos."),
        max_enrollments: int("maxenrollments", 0, 1000, "Máximo de grupos por persona (con inscripción múltiple; 0 = sin límite)."),
        show_results: pick("showresults", { never: "0", after_answer: "1", after_close: "2", always: "3" }, "Cuándo ven los resultados."),
        publish_names: pick("publish", { false: "0", true: "1" }, "Resultados con nombres (true) o anónimos (false)."),
        show_unanswered: yesNo("showunanswered", "Mostrar los que no eligieron."),
        only_active: yesNo("onlyactive", "Sólo inscripciones activas."),
        sort_groups_by: pick("sortgroupsby", { default: "0", created: "1", name: "2" }, "Orden de los grupos: default, created o name."),
    },
    assign: {
        online_text: box("assignsubmission_onlinetext_enabled", "Entrega de texto en línea."),
        file_submissions: box("assignsubmission_file_enabled", "Entrega de archivos."),
        max_files: int("assignsubmission_file_maxfiles", 1, 20, "Máximo de archivos por entrega."),
        max_file_size: pick("assignsubmission_file_maxsizebytes", { course: "0", "5MB": "5242880", "2MB": "2097152", "1MB": "1048576", "500KB": "512000", "100KB": "102400" }, "Tamaño máximo por archivo."),
        word_limit_enabled: box("assignsubmission_onlinetext_wordlimit_enabled", "Límite de palabras del texto en línea."),
        word_limit: int("assignsubmission_onlinetext_wordlimit", 0, 100000, "Límite de palabras."),
        submission_drafts: yesNo("submissiondrafts", "Requiere que el estudiante pulse «Enviar»."),
        submission_statement: yesNo("requiresubmissionstatement", "Requiere aceptar la declaración de entrega."),
        max_attempts: int("maxattempts", -1, 30, "Intentos (-1 = ilimitados)."),
        reopen_method: pick("attemptreopenmethod", { manual: "manual", automatic: "automatic", untilpass: "untilpass" }, "Reapertura de intentos: manual, automatic o untilpass."),
        feedback_comments: box("assignfeedback_comments_enabled", "Comentarios de retroalimentación."),
        feedback_files: box("assignfeedback_file_enabled", "Archivos de retroalimentación."),
        feedback_offline: box("assignfeedback_offline_enabled", "Planilla de calificación fuera de línea."),
        always_show_description: box("alwaysshowdescription", "Mostrar siempre la descripción (también antes de la apertura)."),
        // ADR-095: calificación avanzada. Sólo sin notas puestas (lo controla el plan).
        grading_method: pick("advancedgradingmethod_submissions", { simple: "", rubric: "rubric", guide: "guide" }, "Método de calificación: simple, rubric (rúbrica) o guide (guía de evaluación). La rúbrica o la guía se definen con campus_plan_grading_definition. Sólo si no hay notas puestas."),
        grade_type: pick("grade[modgrade_type]", { point: "point", scale: "scale", none: "none" }, "Tipo de nota: point, scale o none. Sólo si no hay notas puestas."),
        grade_scale: int("grade[modgrade_scale]", 1, 1e12, "Escala (id; las disponibles salen del error si no es válida). Sólo si no hay notas puestas."),
        marking_workflow: yesNo("markingworkflow", "Flujo de trabajo de calificación (las notas se publican al liberarlas). Sólo si no hay notas puestas."),
        // ADR-105: entregas en grupo. Moodle congela estos campos cuando ya hay entregas.
        team_submission: yesNo("teamsubmission", "Entregas en grupo (una entrega por grupo)."),
        team_require_all: yesNo("requireallteammemberssubmit", "En grupo: todos los integrantes deben pulsar «Enviar»."),
        team_require_group: yesNo("preventsubmissionnotingroup", "En grupo: quien no tiene grupo no puede entregar."),
        team_grouping: int("teamsubmissiongroupingid", 0, 1e12, "En grupo: agrupamiento cuyos grupos entregan (0 = grupos del curso)."),
    },
    quiz: {
        grade_method: pick("grademethod", { highest: "1", average: "2", first: "3", last: "4" }, "Método: highest, average, first o last."),
        questions_per_page: int("questionsperpage", 0, 50, "Preguntas por página (0 = todas; se aplica a los intentos nuevos)."),
        navigation: pick("navmethod", { free: "free", sequential: "sequential" }, "Navegación: free o sequential."),
        shuffle_answers: yesNo("shuffleanswers", "Barajar las respuestas dentro de las preguntas."),
        behaviour: pick("preferredbehaviour", { interactive: "interactive", adaptive: "adaptive", adaptivenopenalty: "adaptivenopenalty", deferredfeedback: "deferredfeedback", deferredcbm: "deferredcbm", immediatefeedback: "immediatefeedback", immediatecbm: "immediatecbm" }, "Comportamiento de las preguntas."),
        overdue_handling: pick("overduehandling", { autosubmit: "autosubmit", graceperiod: "graceperiod", autoabandon: "autoabandon" }, "Al vencer el tiempo: autosubmit, graceperiod o autoabandon."),
        redo_questions: yesNo("canredoquestions", "Permitir rehacer preguntas dentro del intento."),
        attempt_on_last: yesNo("attemptonlast", "Cada intento se basa en el anterior."),
        decimal_points: int("decimalpoints", 0, 5, "Decimales de las calificaciones."),
        show_blocks: yesNo("showblocks", "Mostrar bloques durante el intento."),
        ...QUIZ_REVIEW,
    },
    lesson: {
        progress_bar: yesNo("progressbar", "Barra de progreso."),
        ongoing_score: yesNo("ongoing", "Mostrar el puntaje en curso."),
        display_menu: yesNo("displayleft", "Mostrar el menú."),
        slideshow: yesNo("slideshow", "Presentación de diapositivas."),
        max_answers: int("maxanswers", 2, 20, "Máximo de respuestas por pregunta."),
        feedback: yesNo("feedback", "Mostrar la retroalimentación por defecto."),
        practice: yesNo("practice", "Lección de práctica (no se califica)."),
        custom_scoring: yesNo("custom", "Puntuación personalizada."),
        retake: yesNo("retake", "Permitir reintentos."),
        use_max_grade: pick("usemaxgrade", { average: "0", highest: "1" }, "Con reintentos: average o highest."),
        max_attempts: int("maxattempts", 0, 10, "Intentos por pregunta (0 = sin límite)."),
        review: yesNo("review", "Permitir revisar."),
        mod_attempts: yesNo("modattempts", "Permitir revisión del estudiante."),
        next_page_default: pick("nextpagedefault", { normal: "0", unseen: "1", unanswered: "2" }, "Acción tras respuesta correcta."),
        max_pages: int("maxpages", 0, 100, "Páginas a mostrar (0 = todas)."),
        min_questions: int("minquestions", 0, 100, "Mínimo de preguntas."),
    },
    h5pactivity: {
        tracking: yesNo("enabletracking", "Registrar los intentos."),
        grade_method: pick("grademethod", { highest: "1", average: "2", last: "3", first: "4", none: "0" }, "Método de calificación."),
        review_mode: pick("reviewmode", { participants: "1", nobody: "0" }, "Quién revisa los intentos: participants o nobody."),
        allow_download: box("displayopt[export]", "Permitir descargar."),
        embed_button: box("displayopt[embed]", "Botón de incrustar."),
        copyright_button: box("displayopt[copyright]", "Botón de derechos de autor."),
    },
    book: {
        numbering: pick("numbering", { none: "0", numbers: "1", bullets: "2", indented: "3" }, "Numeración de capítulos."),
        custom_titles: box("customtitles", "Títulos personalizados."),
    },
    wiki: {
        default_format: pick("defaultformat", { html: "html", creole: "creole", nwiki: "nwiki" }, "Formato por defecto."),
        force_format: box("forceformat", "Forzar el formato."),
    },
    folder: {
        inline: pick("display", { false: "0", true: "1" }, "Mostrar el contenido en la página del curso (true) o en una página aparte (false)."),
        show_expanded: adv("showexpanded", "Subcarpetas expandidas."),
        download_button: adv("showdownloadfolder", "Botón de descargar la carpeta."),
        force_download: adv("forcedownload", "Forzar la descarga de los archivos."),
    },
    // Presentación del enlace (RESOURCELIB_DISPLAY_AUTO 0, _EMBED 1, _OPEN 5). Frame, new y popup quedan afuera.
    url: {
        // Deshacer puede restaurar las otras presentaciones de Moodle (2 marco, 3 ventana nueva, 4 descarga, 6 emergente).
        display: { ...pick("display", { automatic: "0", embed: "1", open: "5" }, "Presentación del enlace: automatic (Moodle decide), embed (dentro del Campus) u open (en otra página)."), restore: ["2", "3", "4", "6"] },
    },
    resource: {
        show_size: box("showsize", "Mostrar el tamaño."),
        show_type: box("showtype", "Mostrar el tipo."),
        show_date: box("showdate", "Mostrar la fecha."),
    },
};

/** Tipos con formulario estándar donde además valen los comunes. */
export const SETTINGS_KINDS = Object.keys(KIND_SETTINGS).concat(["page", "url", "label", "attendance", "questionnaire", "lti", "hvp", "subjectattendance"].filter((k) => !(k in KIND_SETTINGS)));

/** Todos los campos del formulario que puede tocar un tipo (para su spec). */
export function settingFields(kind: string): SettingDef[] {
    return [...Object.values(COMMON_SETTINGS), ...Object.values(KIND_SETTINGS[kind] ?? {})];
}
