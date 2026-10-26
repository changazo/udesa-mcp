/**
 * Allowlist de funciones Moodle del primer hito. La capa de transporte rechaza cualquier otra,
 * aunque una ruta interna intente invocarla (POL-04). No se incluyen funciones `*_view_*` porque
 * marcan lectura/completitud. Agregar una función acá es una decisión de producto con tests.
 */
export const READ_FUNCTIONS = [
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "core_course_get_contents",
    "mod_forum_get_forums_by_courses",
    "mod_forum_get_forum_discussions",
    "mod_forum_get_discussion_posts",
    // Rol del usuario verificado en cada curso (alcance «cursos donde soy docente»). El esquema
    // proyecta sólo roles: el resto del perfil (email, etc.) se descarta.
    "core_user_get_course_user_profiles",
    // Lectura ampliada (2026-10-18). Ninguna es `*_view_*`; ninguna modifica estado académico.
    "mod_assign_get_assignments",
    "core_calendar_get_calendar_events",
    "mod_page_get_pages_by_courses",
    "mod_url_get_urls_by_courses",
    "mod_resource_get_resources_by_courses",
    // Datos de estudiantes (decisión del dueño: disponibles en local y remoto, con minimización).
    "mod_assign_list_participants",
    "mod_assign_get_submissions",
    "mod_assign_get_submission_status",
    // Lectura ampliada II (2026-10-18): cuestionarios, cambios, grupos, participantes, notas,
    // intentos, mensajes, comentarios y notas docentes. Ninguna marca lectura ni crea credenciales.
    "core_course_get_updates_since",
    "mod_quiz_get_quizzes_by_courses",
    "mod_quiz_get_user_attempts",
    "mod_quiz_get_attempt_review",
    // Intentos propios con cualquier rol (ADR-123): opciones de revisión que fijó quien configuró el
    // cuestionario (sólo lectura de quiz_settings; no registra vistas ni toca intentos).
    "mod_quiz_get_combined_review_options",
    "core_group_get_course_groups",
    "core_group_get_course_groupings",
    "core_enrol_get_enrolled_users",
    "mod_choicegroup_get_choicegroup_options",
    "gradereport_user_get_grade_items",
    "core_message_get_conversations",
    "core_message_get_conversation_messages",
    "core_comment_get_comments",
    "core_notes_get_course_notes",
    // Lectura ampliada III (2026-10-18): notificaciones. No las marca como leídas.
    "message_popup_get_popup_notifications",
    // Asistencia (2026-10-18): contenido de la app móvil del plugin mod_attendance. Es una función
    // genérica (ejecuta métodos móviles de cualquier plugin), así que el transporte la restringe con
    // MOBILE_CONTENT_POLICY: sólo dos métodos de lectura y nunca argumentos status* (tomarían asistencia).
    "tool_mobile_get_content",
    // Resumen de actividades de Moodle 5 (tabla por tipo de actividad, con agregados). No registra
    // vistas: eso lo hace core_courseformat_log_view_overview_information, que no se usa.
    "core_courseformat_get_overview_information",
    // Directiva de lecturas docentes, P1: fechas efectivas por participante (overrides en memoria)
    // y etiquetas de categoría de ítems de calificación (grade_item::fetch_all). Sólo lectura.
    "mod_assign_get_participant",
    "core_grades_get_gradeitems",
    // §6.3: modo de grupos y grupos seleccionables de una actividad (groups_get_activity_*; sólo lectura).
    "core_group_get_activity_groupmode",
    "core_group_get_activity_allowed_groups",
    // Cierre de lecturas (2026-10-19): detalle del curso (sólo lectura; restringido a field=id por
    // política: sin field devuelve TODOS los cursos del sitio), reglas de acceso de un cuestionario
    // (access_manager::describe_rules, sólo lectura) y mejor nota de un participante (usa
    // grade_get_grades, que puede recalcular notas finales pendientes: excepción ADR-031).
    "core_course_get_courses_by_field",
    "mod_quiz_get_quiz_access_information",
    "mod_quiz_get_user_best_grade",
    // Guarda de get_submission_status (ADR-051): prórroga y bloqueo sin crear un registro de entrega.
    // Sólo SELECT sobre assign_user_flags; exige mod/assign:grade (sin él, aviso 1 sin datos).
    "mod_assign_get_user_flags",
    // Contenido interno de las actividades (ADR-079): libros, carpetas, glosarios, wikis, bases de datos,
    // consultas, lecciones y H5P. Ninguna es `*_view_*` ni registra vistas. mod_wiki_get_subwiki_pages puede
    // regenerar la caché de render de una página vencida (cachedcontent): no cambia contenido académico.
    "mod_book_get_books_by_courses",
    "mod_folder_get_folders_by_courses",
    "mod_glossary_get_glossaries_by_courses",
    "mod_glossary_get_entries_by_letter",
    "mod_glossary_get_categories",
    "mod_wiki_get_wikis_by_courses",
    "mod_wiki_get_subwikis",
    "mod_wiki_get_subwiki_pages",
    "mod_data_get_databases_by_courses",
    "mod_data_get_fields",
    "mod_data_get_entries",
    "mod_choice_get_choices_by_courses",
    "mod_choice_get_choice_results",
    "mod_lesson_get_lessons_by_courses",
    "mod_lesson_get_pages",
    "mod_h5pactivity_get_h5pactivities_by_courses",
    "mod_h5pactivity_get_user_attempts",
    // Intentos H5P propios (ADR-123), la vía de la app para un estudiante; sólo lectura.
    "mod_h5pactivity_get_attempts",
    "mod_h5pactivity_get_results",
    // Eventos de grupo (ADR-083): get_calendar_events omite los grupos de los que la cuenta no es miembro;
    // la vista mensual los muestra como la web (sólo year, month y courseid: ver paramPolicyViolation).
    // get_calendar_event_by_id lee un evento puntual (verificar y borrar). Ninguna registra vistas.
    "core_calendar_get_calendar_monthly_view",
    "core_calendar_get_calendar_event_by_id",
    // ADR-085: entradas de glosario pendientes de aprobación e intentos de lecciones (resumen por
    // estudiante). Sólo lectura: no registran vistas.
    "mod_glossary_get_entries_to_approve",
    "mod_lesson_get_attempts_overview",
] as const;

export type AllowedFunction = (typeof READ_FUNCTIONS)[number];

const ALLOWED = new Set<string>(READ_FUNCTIONS);

export function isAllowedFunction(name: string): name is AllowedFunction {
    return ALLOWED.has(name);
}

/**
 * Métodos de la app móvil permitidos en tool_mobile_get_content (revisados en mod_attendance
 * 2025122100, ADR-028). mobile_view_activity escribe asistencia si recibe claves status<id>;
 * mobile_teacher_form sólo lee el registro de una sesión. Cualquier otro componente o método se rechaza.
 */
export const MOBILE_CONTENT_POLICY: Record<string, { methods: Record<string, readonly string[]> }> = {
    mod_attendance: {
        methods: {
            mobile_view_activity: ["cmid", "courseid", "appversioncode"],
            mobile_teacher_form: ["cmid", "courseid", "sessid", "appversioncode"],
        },
    },
};

/** Verifica los parámetros de funciones genéricas antes de enviarlas. Lanza un mensaje si no cumplen. */
export function paramPolicyViolation(fn: string, flat: [string, string][]): string | null {
    if (fn === "core_course_get_courses_by_field") {
        const field = flat.find(([k]) => k === "field")?.[1];
        const value = flat.find(([k]) => k === "value")?.[1];
        if (flat.length !== 2 || field !== "id" || !/^\d{1,12}$/.test(value ?? "")) return "core_course_get_courses_by_field: sólo field=id con un ID de curso.";
        return null;
    }
    if (fn === "core_calendar_get_calendar_monthly_view") {
        const keys = flat.map(([k]) => k).sort().join(",");
        const get = (k: string) => Number(flat.find(([key]) => key === k)?.[1]);
        if (keys !== "courseid,month,year" || !(get("month") >= 1 && get("month") <= 12) || !(get("year") >= 2000 && get("year") <= 2100) || !(get("courseid") > 0)) return "core_calendar_get_calendar_monthly_view: sólo year, month y courseid.";
        return null;
    }
    if (fn !== "tool_mobile_get_content") return null;
    const get = (k: string) => flat.find(([key]) => key === k)?.[1];
    const component = get("component");
    const method = get("method");
    const allowedArgs = component && method ? MOBILE_CONTENT_POLICY[component]?.methods[method] : undefined;
    if (!allowedArgs) return `tool_mobile_get_content: ${component ?? "?"}/${method ?? "?"} no está permitido.`;
    for (const [key, value] of flat) {
        if (key === "component" || key === "method") continue;
        const m = /^args\[(\d+)\]\[(name|value)\]$/.exec(key);
        if (!m) return `tool_mobile_get_content: parámetro ${key} no permitido.`;
        if (m[2] === "name") {
            if (/^status/i.test(value) || !allowedArgs.includes(value)) return `tool_mobile_get_content: argumento ${value} no permitido.`;
        }
    }
    return null;
}

/** Parámetros que el transporte controla y nadie más puede fijar. */
export const RESERVED_PARAMS = new Set(["wstoken", "wsfunction", "moodlewsrestformat", "moodlewssettingfilter", "moodlewssettingfileurl"]);
