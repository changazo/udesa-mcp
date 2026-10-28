import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile, packageRoot } from "../../src/config/profile.js";
import { CampusError } from "../../src/errors.js";
import { checkWriteAjax, checkWriteForm, checkWriteRest, WRITE_AJAX_METHODS, WRITE_FUNCTIONS, WRITE_WEB_FORMS, type AjaxWriteSpec, type WebFormWriteSpec } from "../../src/write/functions.js";
import { assertWriteServerMayStart, computeRisk, loadWriteProfile, parseWriteProfile } from "../../src/write/policy.js";
import { availableIntents } from "../../src/write/app.js";
import { canonicalJson, newPlanId, planIdOfAction, actionIdOf } from "../../src/write/plan.js";
import { syntheticProfile } from "../fixtures/fake-moodle.js";
import { writeProfileJson } from "../fixtures/write-harness.js";

const code = (fn: () => unknown) => {
    try {
        fn();
    } catch (e) {
        return e instanceof CampusError ? e.code : "OTHER";
    }
    return "NO_ERROR";
};

const CAPS = ["assign_override", "calendar_event", "course_visibility", "create_assignment", "create_attendance", "create_content", "create_quiz", "create_section", "delete_content", "delete_student_work", "edit_activity", "edit_own_post", "edit_quiz", "grade_forum", "grade_quiz", "grade_submission", "grant_extension", "import_questions", "lock_submissions", "manage_activity_entries", "manage_gradebook", "manage_groups", "moderate_forum", "move_content", "pin_lock_discussion", "post_announcement", "quiz_override", "rename_content", "reply_forum", "send_message", "submission_comment", "take_attendance"];

describe("perfil de escritura (§5.1)", () => {
    it("el perfil de ejemplo carga con su perfil de lectura; todos los cursos con rol de escritura (ADR-125); sin sandbox ni cuentas de prueba; notifica a participantes (ADR-130) pero no por defecto", () => {
        const wp = loadWriteProfile({ profileId: "udesa-docente-escritura", env: {} });
        // Nombres nuevos (ADR-062): docente-completo y docente-lectura apuntan a los mismos perfiles.
        expect(loadWriteProfile({ profileId: "docente-completo", env: {} }).profile_id).toBe("udesa-docente-escritura");
        expect(loadProfile({ profileId: "docente-lectura", env: {} }).profile_id).toBe("udesa-docente");
        expect(code(() => loadProfile({ profileId: "docente-completo", env: {} }))).toBe("CONFIG_INVALID");
        expect(wp.read_profile.profile_id).toBe("udesa-docente");
        expect(wp.read_profile.read_only).toBe(true);
        expect(wp.synthetic_site).toBe(false);
        // Ejemplo público: el sandbox y las cuentas de prueba los completa cada uno.
        expect(wp.policy.sandbox_course_ids).toEqual([]);
        expect([...wp.policy.courses.keys()]).toEqual([]);
        expect(wp.policy.notifiable_user_ids).toEqual([]);
        expect(wp.policy.all_courses.map((g) => g.capability).sort()).toEqual(CAPS);
        expect(wp.policy.allow_participant_notifications).toBe(true);
        expect(wp.policy.notify_students_default).toBe(false);
        expect(wp.policy.require_out_of_band_from_risk).toBe("nunca");
        // Contra el Campus real: las intenciones de foros (W1), nunca la de prueba.
        expect([...availableIntents(wp).keys()].sort()).toEqual(["activity_files", "activity_settings", "announcement", "assign_override", "assign_override_delete", "assign_submission_reset", "attendance", "attendance_session", "attendance_session_delete", "attendance_session_edit", "book_chapter", "calendar_event", "calendar_event_delete", "calendar_event_edit", "choice_options", "choicegroup_groups", "create_assignment", "create_attendance", "create_content", "create_group", "create_grouping", "create_quiz", "create_section", "data_entry", "data_field", "delete_content", "delete_group", "discussion_state", "duplicate_activity", "edit_activity_text", "edit_dates", "edit_group", "edit_grouping", "extension", "forum_grade", "forum_move_discussion", "forum_post_delete", "forum_reply", "glossary_category", "glossary_entry", "grade", "grade_advanced", "grade_item", "gradebook_grade", "grading_definition", "group_members", "grouping_groups", "h5p_content", "lab_lti_exercise", "lab_lti_tool", "lesson_page", "lesson_question", "move_activity", "move_section", "override_edit", "post_attachments", "post_edit", "question_import", "question_status", "questionnaire_question", "quiz_add_questions", "quiz_add_random", "quiz_attempt_delete", "quiz_grade", "quiz_layout", "quiz_override", "quiz_override_delete", "quiz_remove_question", "quiz_slot_maxmark", "rename", "section_summary", "send_message", "submission_comment", "submission_lock", "visibility", "wiki_page"]);
    });

    it("separación: el cargador de lectura rechaza el perfil de escritura y viceversa", () => {
        expect(code(() => loadProfile({ profileId: "udesa-docente-escritura", env: {} }))).toBe("CONFIG_INVALID");
        expect(code(() => loadWriteProfile({ profileId: "udesa-docente", env: {} }))).toBe("CONFIG_INVALID");
        // Los perfiles de lectura del repo siguen con read_only: true literal.
        for (const id of ["udesa-docente", "udesa-curso"]) {
            expect(JSON.parse(readFileSync(join(packageRoot(), "profiles", `${id}.json`), "utf8")).read_only).toBe(true);
        }
    });

    it("doble llave: hace falta CAMPUS_WRITE_ENABLED=true literal además del perfil", () => {
        const wp = parseWriteProfile(writeProfileJson(), syntheticProfile());
        expect(code(() => assertWriteServerMayStart(wp, {}))).toBe("WRITE_DISABLED");
        expect(code(() => assertWriteServerMayStart(wp, { CAMPUS_WRITE_ENABLED: "1" }))).toBe("WRITE_DISABLED");
        expect(code(() => assertWriteServerMayStart(wp, { CAMPUS_WRITE_ENABLED: "TRUE" }))).toBe("WRITE_DISABLED");
        expect(code(() => assertWriteServerMayStart(wp, { CAMPUS_WRITE_ENABLED: "true" }))).toBe("NO_ERROR");
        const off = parseWriteProfile(writeProfileJson({ enabled: false }), syntheticProfile());
        expect(code(() => assertWriteServerMayStart(off, { CAMPUS_WRITE_ENABLED: "true" }))).toBe("WRITE_DISABLED");
    });

    it("esquema cerrado: read_only literal false, sin claves desconocidas ni con forma de secreto, límites con tope", () => {
        const read = syntheticProfile();
        const bad = (policy: Record<string, unknown>, top: Record<string, unknown> = {}) => code(() => parseWriteProfile(writeProfileJson(policy, top), read));
        expect(bad({}, { read_only: true })).toBe("CONFIG_INVALID");
        expect(bad({}, { extra: 1 })).toBe("CONFIG_INVALID");
        expect(bad({}, { token: "x" })).toBe("CONFIG_INVALID");
        expect(bad({ require_out_of_band_from_risk: "R3" })).toBe("CONFIG_INVALID");
        expect(bad({ limits: { max_items_per_plan: 31, max_messages_per_plan: 1, max_actions_per_day: 200, max_messages_per_day: 20 } })).toBe("CONFIG_INVALID");
        expect(bad({ limits: { max_items_per_plan: 30, max_messages_per_plan: 2, max_actions_per_day: 200, max_messages_per_day: 20 } })).toBe("CONFIG_INVALID");
        // ADR-078: el dueño elevó el tope diario a 2000.
        expect(bad({ limits: { max_items_per_plan: 30, max_messages_per_plan: 1, max_actions_per_day: 2001, max_messages_per_day: 20 } })).toBe("CONFIG_INVALID");
        expect(bad({ limits: { max_items_per_plan: 30, max_messages_per_plan: 1, max_actions_per_day: 2000, max_messages_per_day: 20 } })).not.toBe("CONFIG_INVALID");
        expect(bad({ courses: { "4242": ["borrar_todo"] } })).toBe("CONFIG_INVALID");
        expect(bad({ courses: { "4242": ["synthetic_test", "synthetic_test"] } })).toBe("CONFIG_INVALID");
        // Curso fuera de la allowlist del perfil de lectura.
        expect(bad({ courses: { "7777": ["synthetic_test"] } })).toBe("CONFIG_INVALID");
        expect(bad({}, { read_profile: "otro" })).toBe("CONFIG_INVALID");
        expect(bad({}, { profile_id: "sintetico" })).toBe("CONFIG_INVALID");
    });

    it("la capacidad de prueba no se admite contra un sitio real", () => {
        const real = loadProfile({ profileId: "udesa-curso", env: {} });
        const json = writeProfileJson({ courses: { "12345": ["synthetic_test"] }, sandbox_course_ids: [] }, { read_profile: "udesa-curso" });
        expect(code(() => parseWriteProfile(json, real))).toBe("CONFIG_INVALID");
    });
});

describe("riesgo calculado por el servidor (§4)", () => {
    const policy = parseWriteProfile(writeProfileJson({ sandbox_course_ids: [] }), syntheticProfile()).policy;
    const now = new Date("2026-10-19T12:00:00Z");
    it("mensajes: más de uno sube un nivel; un curso real no escala (ADR-126); tope R4", () => {
        expect(computeRisk({ base: "R3", capability: "send_message", items: 2, courseId: 4242, policy, now }).risk).toBe("R4");
        expect(computeRisk({ base: "R4", capability: "synthetic_test", items: 1, courseId: 4242, policy, now }).risk).toBe("R4");
        expect(computeRisk({ base: "R1", capability: "synthetic_test", items: 1, courseId: 4242, policy, now }).risk).toBe("R1");
    });
});

describe("allowlists del transporte de escritura (§5.2)", () => {
    const site = "https://campus.example.test";
    const real = "https://campusvirtual.udesa.edu.ar";
    it("funciones reales sólo de W1 y W2 (foros, calendario, tareas, comentarios); las de prueba sólo contra un sitio .test", () => {
        for (const [fn, s] of Object.entries(WRITE_FUNCTIONS)) expect(s.synthetic_only ? fn.startsWith("local_sintetico_") : /^(mod_forum_|core_calendar_|mod_assign_(save_user_extensions|lock_submissions|unlock_submissions|submit_grading_form|get_grades)$|core_comment_(add|delete)_comments$|core_files_delete_draft_files$|mod_forum_prepare_draft_area_for_post$|tool_mobile_get_content$|mod_glossary_|mod_wiki_|mod_data_|core_grades_get_gradeitems$|mod_choice_get_choice(s_by_courses|_options)$|core_message_(send_instant_messages|get_conversation_between_users)$)/.test(fn), fn).toBe(true);
        // Mensajes: sólo el envío de UN mensaje y su verificación (ADR-120; la intención limita destinatarios).
        expect(Object.keys(WRITE_FUNCTIONS).filter((fn) => fn.startsWith("core_message_")).sort()).toEqual(["core_message_get_conversation_between_users", "core_message_send_instant_messages"]);
        // Web: sólo el alta de tareas (formulario) y su borrado como deshacer (cm_delete), ADR-050.
        expect(WRITE_AJAX_METHODS.map((s) => `${s.method}#${s.discriminator?.value}`).sort()).toEqual(
            ["cm_delete", "cm_duplicate", "cm_hide", "cm_move", "cm_show", "section_add", "section_delete", "section_hide", "section_move_after", "section_show"].map((a) => `core_courseformat_update_course#${a}`).concat(["core_grades_grader_gradingpanel_point_store#undefined", "mod_quiz_update_slots#undefined", "qbank_editquestion_set_status#undefined", "core_update_inplace_editable#activityname", "core_update_inplace_editable#sectionname", "core_update_inplace_editable#user_groups", "mod_quiz_delete_overrides#undefined", "mod_quiz_save_overrides#undefined"]).sort(),
        );
        expect(WRITE_WEB_FORMS.map((s) => s.id).sort()).toEqual(["assign_grade_classic", "assign_override_add", "assign_override_delete", "assign_override_edit", "assign_remove_submission", "assign_revert_to_draft", "attendance_session_add", "attendance_session_delete", "attendance_session_update", "book_chapter_add", "book_chapter_delete", "book_chapter_edit", "book_chapter_move", "book_chapter_toggle", "course_group_add", "course_group_delete", "course_group_update", "course_grouping_add", "course_grouping_delete", "course_grouping_update", "course_modedit_assign_add", "course_modedit_assign_update", "course_modedit_assign_update_settings", "course_modedit_assign_update_text", "course_modedit_attendance_add", "course_modedit_attendance_update_settings", "course_modedit_attendance_update_text", "course_modedit_book_add", "course_modedit_book_update_settings", "course_modedit_book_update_text", "course_modedit_choice_add", "course_modedit_choice_update", "course_modedit_choice_update_options", "course_modedit_choice_update_settings", "course_modedit_choice_update_text", "course_modedit_choicegroup_add", "course_modedit_choicegroup_update_groups", "course_modedit_choicegroup_update_settings", "course_modedit_choicegroup_update_text", "course_modedit_data_add", "course_modedit_data_update", "course_modedit_data_update_settings", "course_modedit_data_update_text", "course_modedit_folder_add", "course_modedit_folder_update_files", "course_modedit_folder_update_settings", "course_modedit_folder_update_text", "course_modedit_forum_add", "course_modedit_forum_update_settings", "course_modedit_forum_update_text", "course_modedit_glossary_add", "course_modedit_glossary_update_settings", "course_modedit_glossary_update_text", "course_modedit_h5pactivity_add", "course_modedit_h5pactivity_update_files", "course_modedit_h5pactivity_update_settings", "course_modedit_h5pactivity_update_text", "course_modedit_hvp_update_settings", "course_modedit_hvp_update_text", "course_modedit_label_add", "course_modedit_label_update_settings", "course_modedit_label_update_text", "course_modedit_lesson_add", "course_modedit_lesson_update", "course_modedit_lesson_update_settings", "course_modedit_lesson_update_text", "course_modedit_lti_add_lab", "course_modedit_lti_update_settings", "course_modedit_lti_update_text", "course_modedit_page_add", "course_modedit_page_update_settings", "course_modedit_page_update_text", "course_modedit_questionnaire_add", "course_modedit_questionnaire_update_settings", "course_modedit_questionnaire_update_text", "course_modedit_quiz_add", "course_modedit_quiz_update", "course_modedit_quiz_update_settings", "course_modedit_quiz_update_text", "course_modedit_resource_add", "course_modedit_resource_update_files", "course_modedit_resource_update_settings", "course_modedit_resource_update_text", "course_modedit_subjectattendance_update_settings", "course_modedit_subjectattendance_update_text", "course_modedit_subsection_add", "course_modedit_url_add", "course_modedit_url_update_settings", "course_modedit_url_update_text", "course_modedit_wiki_add", "course_modedit_wiki_update_settings", "course_modedit_wiki_update_text", "course_section_edit", "data_field_add", "data_field_delete", "data_field_update", "forum_discussion_move", "glossary_category_delete", "glossary_category_save", "glossary_entry_approve", "grade_grade_edit", "grade_item_action", "grade_item_delete", "grade_item_edit", "grading_definition_delete", "grading_guide_save", "grading_rubric_save", "grouping_assign_add", "grouping_assign_remove", "lab_lti11_tool_add", "lab_lti_tool_add", "lesson_page_add", "lesson_page_delete", "lesson_page_edit_branchtable", "lesson_page_edit_cluster", "lesson_page_edit_endofbranch", "lesson_page_edit_endofcluster", "lesson_page_edit_essay", "lesson_page_edit_matching", "lesson_page_edit_multichoice", "lesson_page_edit_numerical", "lesson_page_edit_shortanswer", "lesson_page_edit_truefalse", "lesson_question_add_essay", "lesson_question_add_matching", "lesson_question_add_multichoice", "lesson_question_add_numerical", "lesson_question_add_shortanswer", "lesson_question_add_truefalse", "question_delete", "question_import", "questionnaire_question_add", "questionnaire_question_delete", "questionnaire_question_edit", "questionnaire_question_move", "quiz_add_question", "quiz_add_random", "quiz_attempt_delete", "quiz_manual_grade", "quiz_override_edit", "quiz_page_break", "quiz_remove_slot", "quiz_repaginate", "quiz_section_add", "quiz_section_delete", "quiz_section_update", "wiki_page_delete"]);
        const flat: [string, string][] = [
            ["courseid", "1"],
            ["markerid", "2"],
            ["value", "x"],
        ];
        expect(code(() => checkWriteRest("local_sintetico_set_marker", flat, site))).toBe("NO_ERROR");
        expect(code(() => checkWriteRest("local_sintetico_set_marker", flat, real))).toBe("POLICY_DENIED");
    });

    it("bloqueadas siempre, aunque estuvieran en la tabla", () => {
        const table = { mod_assign_set_user_flags: { kind: "write" as const, synthetic_only: false, validate: () => null, effects: "" } };
        expect(code(() => checkWriteRest("mod_assign_set_user_flags", [], real, table))).toBe("POLICY_DENIED");
        for (const fn of ["enrol_self_enrol_user", "core_role_assign_roles", "core_ai_get_policy_status", "qtype_coderunner_run_in_sandbox", "core_calendar_update_event_start_day", "tool_mobile_get_autologin_key"]) {
            expect(code(() => checkWriteRest(fn, [], real, { [fn]: table.mod_assign_set_user_flags })), fn).toBe("POLICY_DENIED");
        }
    });

    it("AJAX: genéricos sólo como tupla allowlisteada; acción, argumento o sesskey fuera de la allowlist se rechazan", () => {
        const table: AjaxWriteSpec[] = [
            {
                method: "core_courseformat_update_course",
                discriminator: { arg: "action", value: "cm_hide" },
                validate: (a) => (Object.keys(a).every((k) => ["action", "courseid", "ids"].includes(k)) ? null : "argumento no admitido"),
                effects: "",
            },
        ];
        expect(code(() => checkWriteAjax("core_courseformat_update_course", { action: "cm_hide", courseid: 1, ids: [2] }, table))).toBe("NO_ERROR");
        expect(code(() => checkWriteAjax("core_courseformat_update_course", { action: "cm_delete", courseid: 1, ids: [2] }, table))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteAjax("core_courseformat_update_course", { action: "cm_hide", courseid: 1, ids: [2], extra: 1 }, table))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteAjax("core_courseformat_update_course", { action: "cm_hide", courseid: 1, ids: [2], sesskey: "x" }, table))).toBe("POLICY_DENIED");
        for (const m of ["core_update_inplace_editable", "core_form_dynamic_form", "core_courseformat_update_course"]) expect(code(() => checkWriteAjax(m, {}))).toBe("POLICY_DENIED");
    });

    it("formularios: campo fuera de la allowlist, valor inválido, faltante o _qf__/sesskey del llamador se rechazan", () => {
        const table: WebFormWriteSpec[] = [{ id: "prueba", path: "/x.php", qf_marker: "x_form", fields: { name: (v) => v.length > 0 && v.length < 10 }, required: ["name"], effects: "" }];
        expect(code(() => checkWriteForm("prueba", { name: "ok" }, table))).toBe("NO_ERROR");
        expect(code(() => checkWriteForm("prueba", { name: "ok", visible: "1" }, table))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteForm("prueba", { name: "" }, table))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteForm("prueba", {}, table))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteForm("prueba", { name: "ok", _qf__x_form: "1" }, table))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteForm("otro", { name: "ok" }))).toBe("POLICY_DENIED");
    });
});

describe("identificadores y hash", () => {
    it("plan_id y action_id comparten sufijo y no tienen forma de token", () => {
        const id = newPlanId();
        expect(id).toMatch(/^pl_[a-z2-7]{16}$/);
        expect(planIdOfAction(actionIdOf(id))).toBe(id);
        expect(code(() => planIdOfAction("ac_../../x"))).toBe("RESOURCE_OUT_OF_SCOPE");
    });
    it("JSON canónico: el orden de las claves no cambia el hash", () => {
        expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    });
});
