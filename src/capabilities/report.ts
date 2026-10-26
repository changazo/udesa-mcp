import type { Profile } from "../config/profile.js";
import type { VerifiedSite } from "../session/session-manager.js";

/**
 * Matriz de capacidades con cuatro dimensiones independientes (05_DESCUBRIMIENTO):
 * anuncio del servicio, implementación local, política local y prueba en contexto.
 * `listed` no implica `allowed`; una escritura queda `not_tested` aunque esté listada (CAP-03).
 */
export type ServiceListing = "listed" | "not_listed" | "unknown";
export type ContextStatus = "not_tested" | "allowed" | "denied" | "inconclusive" | "error";

export interface CapabilityDef {
    name: string;
    required_functions: string[];
    implementation: "implemented" | "not_implemented";
    local_policy: "allow_read" | "blocked" | "future_opt_in";
    /** Para capacidades sin función (descarga/subida), la bandera de get_site_info. */
    listing_flag?: "downloadfiles" | "uploadfiles";
    /** Si la prueba en contexto se hace sobre un curso. */
    course_scoped: boolean;
    /** «web» = usa la sesión web (rutas o AJAX auditados); no figura en la lista de funciones del servicio. */
    transport?: "rest" | "web";
}

export const CAPABILITIES: CapabilityDef[] = [
    { name: "session_identity", required_functions: ["core_webservice_get_site_info"], implementation: "implemented", local_policy: "allow_read", course_scoped: false },
    { name: "list_courses", required_functions: ["core_enrol_get_users_courses"], implementation: "implemented", local_policy: "allow_read", course_scoped: false },
    { name: "read_course", required_functions: ["core_course_get_contents"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    {
        name: "read_forums",
        required_functions: ["mod_forum_get_forums_by_courses", "mod_forum_get_forum_discussions", "mod_forum_get_discussion_posts"],
        implementation: "implemented",
        local_policy: "allow_read",
        course_scoped: true,
    },
    { name: "read_files", required_functions: [], listing_flag: "downloadfiles", implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "course_scope_roles", required_functions: ["core_enrol_get_users_courses", "core_user_get_course_user_profiles"], implementation: "implemented", local_policy: "allow_read", course_scoped: false },
    { name: "read_assignments", required_functions: ["mod_assign_get_assignments"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_calendar", required_functions: ["core_calendar_get_calendar_events"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    {
        name: "read_resources",
        required_functions: ["mod_page_get_pages_by_courses", "mod_url_get_urls_by_courses", "mod_resource_get_resources_by_courses"],
        implementation: "implemented",
        local_policy: "allow_read",
        course_scoped: true,
    },
    {
        name: "teacher_submission_status",
        required_functions: ["mod_assign_get_assignments", "mod_assign_list_participants", "mod_assign_get_submissions"],
        implementation: "implemented",
        local_policy: "allow_read",
        course_scoped: true,
    },
    { name: "teacher_submissions", required_functions: ["mod_assign_get_submission_status"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_quizzes", required_functions: ["mod_quiz_get_quizzes_by_courses"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    {
        name: "teacher_participants",
        required_functions: ["core_enrol_get_enrolled_users", "core_group_get_course_groups", "core_group_get_course_groupings", "mod_choicegroup_get_choicegroup_options"],
        implementation: "implemented",
        local_policy: "allow_read",
        course_scoped: true,
    },
    { name: "teacher_grades", required_functions: ["gradereport_user_get_grade_items"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "teacher_quiz_attempts", required_functions: ["mod_quiz_get_user_attempts", "mod_quiz_get_attempt_review"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "own_quiz_attempts", required_functions: ["mod_quiz_get_combined_review_options", "mod_quiz_get_user_attempts", "mod_quiz_get_attempt_review"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_messages", required_functions: ["core_message_get_conversations", "core_message_get_conversation_messages"], implementation: "implemented", local_policy: "allow_read", course_scoped: false },
    { name: "read_notifications", required_functions: ["message_popup_get_popup_notifications"], implementation: "implemented", local_policy: "allow_read", course_scoped: false },
    { name: "teacher_notes", required_functions: ["core_notes_get_course_notes"], implementation: "not_implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_course_overview", required_functions: ["core_courseformat_get_overview_information"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_quiz_structure", required_functions: [], transport: "web", implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_question_banks", required_functions: ["core_course_get_contents"], transport: "web", implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_questions", required_functions: [], transport: "web", implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_course_report", required_functions: [], transport: "web", implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_quiz_report", required_functions: [], transport: "web", implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_activity_content", required_functions: ["mod_book_get_books_by_courses", "mod_folder_get_folders_by_courses", "mod_glossary_get_glossaries_by_courses", "mod_glossary_get_entries_by_letter", "mod_glossary_get_categories", "mod_wiki_get_wikis_by_courses", "mod_wiki_get_subwikis", "mod_wiki_get_subwiki_pages", "mod_data_get_databases_by_courses", "mod_data_get_fields", "mod_data_get_entries", "mod_choice_get_choices_by_courses", "mod_choice_get_choice_results", "mod_lesson_get_lessons_by_courses", "mod_lesson_get_pages", "mod_h5pactivity_get_h5pactivities_by_courses", "mod_h5pactivity_get_user_attempts"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_activity_settings", required_functions: ["mod_assign_get_assignments", "mod_quiz_get_quizzes_by_courses"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    // Bloqueadas por efectos (ADR-030/031/034/035): calculan, guardan caché o reparan categorías.
    { name: "read_quiz_statistics", required_functions: [], transport: "web", implementation: "not_implemented", local_policy: "blocked", course_scoped: true },
    { name: "read_grade_tree", required_functions: ["core_grades_get_grade_tree"], implementation: "not_implemented", local_policy: "blocked", course_scoped: true },
    { name: "read_attendance_records", required_functions: ["tool_mobile_get_content"], implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "read_attendance_history", required_functions: ["tool_mobile_get_content"], transport: "web", implementation: "implemented", local_policy: "allow_read", course_scoped: true },
    { name: "post_announcement", required_functions: ["mod_forum_add_discussion"], implementation: "not_implemented", local_policy: "blocked", course_scoped: true },
    { name: "reply_forum_post", required_functions: ["mod_forum_add_discussion_post"], implementation: "not_implemented", local_policy: "blocked", course_scoped: true },
    { name: "send_message", required_functions: ["core_message_send_instant_messages"], implementation: "not_implemented", local_policy: "blocked", course_scoped: false },
    { name: "grade_submission", required_functions: ["mod_assign_save_grade"], implementation: "not_implemented", local_policy: "blocked", course_scoped: true },
    { name: "enrol_users", required_functions: ["enrol_manual_enrol_users"], implementation: "not_implemented", local_policy: "blocked", course_scoped: true },
    { name: "upload_files", required_functions: [], listing_flag: "uploadfiles", implementation: "not_implemented", local_policy: "blocked", course_scoped: false },
];

export interface ContextCheck {
    status: ContextStatus;
    course_id: number | null;
    checked_at: string | null;
    error_code?: string;
}

/**
 * Registra resultados reales de lecturas permitidas (diagnóstico o uso normal). Sólo acepta
 * capacidades con política allow_read e implementadas: nunca se "prueba" una escritura.
 */
/**
 * Observaciones en contexto, por capacidad Y curso (directiva §13): la prueba en un curso no pisa
 * la de otro ni se vuelve un veredicto global. `get` devuelve la más reciente (compatibilidad).
 */
export class ContextCheckRecorder {
    private readonly checks = new Map<string, Map<string, ContextCheck>>();
    private static readonly MAX_CONTEXTS = 20;

    record(capability: string, status: Exclude<ContextStatus, "not_tested">, courseId: number | null, errorCode?: string, at = new Date()) {
        const def = CAPABILITIES.find((c) => c.name === capability);
        if (!def || def.local_policy !== "allow_read" || def.implementation !== "implemented") return;
        const byCtx = this.checks.get(capability) ?? new Map<string, ContextCheck>();
        byCtx.delete(String(courseId));
        byCtx.set(String(courseId), { status, course_id: courseId, checked_at: at.toISOString(), ...(errorCode ? { error_code: errorCode } : {}) });
        while (byCtx.size > ContextCheckRecorder.MAX_CONTEXTS) byCtx.delete(byCtx.keys().next().value!);
        this.checks.set(capability, byCtx);
    }

    get(capability: string): ContextCheck | undefined {
        const all = this.all(capability);
        return all[all.length - 1];
    }

    all(capability: string): ContextCheck[] {
        return [...(this.checks.get(capability)?.values() ?? [])];
    }

    clear() {
        this.checks.clear();
    }
}

export interface CapabilityReport {
    schema_version: "1.0";
    report_kind: "template_not_tested" | "runtime_observation";
    profile_id: string;
    site_url: string;
    observed_at: string | null;
    identity_status: "unverified" | "verified";
    moodle_release: string | null;
    moodle_version: string | null;
    allowed_course_ids: number[];
    capabilities: {
        name: string;
        required_functions: string[];
        service_listing: ServiceListing;
        implementation: CapabilityDef["implementation"];
        local_policy: CapabilityDef["local_policy"];
        transport?: "rest" | "web";
        context_check: ContextCheck;
        context_checks?: ContextCheck[];
    }[];
    warnings: string[];
    service_function_inventory: {
        status: "unknown" | "observed";
        functions: { name: string; component_version: string | null }[];
        download_files: boolean | null;
        upload_files: boolean | null;
    };
}

const flag = (v: number | null | undefined): boolean | null => (v === null || v === undefined ? null : v === 1);

export function buildCapabilityReport(
    profile: Profile,
    site: VerifiedSite | null,
    recorder: ContextCheckRecorder | null,
    extraWarnings: string[] = [],
    resolvedCourseIds?: number[],
): CapabilityReport {
    const courseIds = resolvedCourseIds ?? profile.allowed_course_ids;
    const fns = site?.info.functions;
    const listedSet = fns ? new Set(fns.map((f) => f.name)) : null;
    const defaultCourse = courseIds[0] ?? null;
    const warnings = [...extraWarnings];
    if (!site) warnings.push("Sin verificación autenticada: el inventario de funciones es desconocido.");
    else if (!fns) warnings.push("get_site_info no incluyó la lista de funciones; el inventario es desconocido.");
    warnings.push("La allowlist de cursos y el modo de sólo lectura son políticas locales del MCP, no un alcance reducido del token de Moodle.");

    const capabilities = CAPABILITIES.map((def) => {
        let listing: ServiceListing;
        if (def.transport === "web" && def.required_functions.length === 0) {
            listing = "unknown"; // las rutas web no se anuncian en la lista del servicio
        } else if (def.listing_flag) {
            const v = flag(site?.info[def.listing_flag]);
            listing = v === null ? "unknown" : v ? "listed" : "not_listed";
        } else if (!listedSet) {
            listing = "unknown";
        } else {
            listing = def.required_functions.every((f) => listedSet.has(f)) ? "listed" : "not_listed";
        }
        const recorded = recorder?.get(def.name);
        const context_check: ContextCheck =
            recorded && def.local_policy === "allow_read" && def.implementation === "implemented"
                ? recorded
                : { status: "not_tested", course_id: def.course_scoped ? defaultCourse : null, checked_at: null };
        return {
            name: def.name,
            required_functions: [...def.required_functions],
            service_listing: listing,
            implementation: def.implementation,
            local_policy: def.local_policy,
            ...(def.transport ? { transport: def.transport } : {}),
            context_check,
            ...(recorder && recorder.all(def.name).length > 1 ? { context_checks: recorder.all(def.name) } : {}),
        };
    });

    return {
        schema_version: "1.0",
        report_kind: site ? "runtime_observation" : "template_not_tested",
        profile_id: profile.profile_id,
        site_url: profile.site_url,
        observed_at: site?.verified_at ?? null,
        identity_status: site ? "verified" : "unverified",
        moodle_release: site?.info.release ?? null,
        moodle_version: site?.info.version ?? null,
        allowed_course_ids: [...courseIds],
        capabilities,
        warnings,
        service_function_inventory: {
            status: fns ? "observed" : "unknown",
            functions: (fns ?? [])
                .map((f) => ({ name: f.name, component_version: f.version == null ? null : String(f.version) }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            download_files: flag(site?.info.downloadfiles),
            upload_files: flag(site?.info.uploadfiles),
        },
    };
}
