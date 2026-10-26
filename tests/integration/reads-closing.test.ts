import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { paramPolicyViolation } from "../../src/moodle/functions.js";
import { makeHarness } from "../fixtures/harness.js";
import { COURSE, QUIZ, QUIZ_CMID, STUDENT_A, STUDENT_B } from "../fixtures/fake-moodle.js";

describe("ficha del curso", () => {
    it("campus_get_course trae nombre, categoría, resumen, fechas y docentes de contacto", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourse(COURSE);
        expect(r.data.info).toMatchObject({
            fullname: "Curso sintético",
            shortname: "SINT",
            category: { id: 4, name: "Grado" },
            summary_markdown: "Resumen **sintético**",
            end: null,
            group_mode: "separados",
            contacts: [{ user_id: 2, name: "Docente Sintético" }],
            enrollment_methods: ["manual"],
            custom_fields: [{ name: "Modalidad", value: "Presencial" }],
        });
        expect(JSON.stringify(r.data.info)).not.toContain("overviewfiles");
        const call = h.fake.callsOf("core_course_get_courses_by_field")[0]!;
        expect(call.params).toMatchObject({ field: "id", value: String(COURSE) });
    });

    it("con section_number no se pide la ficha; la política sólo admite field=id", async () => {
        const h = await makeHarness();
        await h.app.service.getCourse(COURSE, { section_number: 1 }).catch(() => null);
        expect(h.fake.callsOf("core_course_get_courses_by_field")).toHaveLength(0);
        expect(paramPolicyViolation("core_course_get_courses_by_field", [["field", "id"], ["value", "12345"]])).toBeNull();
        expect(paramPolicyViolation("core_course_get_courses_by_field", [])).toMatch(/field=id/);
        expect(paramPolicyViolation("core_course_get_courses_by_field", [["field", "category"], ["value", "4"]])).toMatch(/field=id/);
        expect(paramPolicyViolation("core_course_get_courses_by_field", [["field", "id"], ["value", "1,2"]])).toMatch(/field=id/);
    });
});

describe("cuestionarios: reglas de acceso y nota", () => {
    it("la configuración del cuestionario incluye las reglas de acceso descritas por Moodle", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: QUIZ_CMID });
        expect((r.data.settings as { access_rules: unknown }).access_rules).toEqual({
            descriptions: ["Límite de tiempo: 30 minutos", "Se requiere contraseña"],
            active_rule_plugins: ["quizaccess_timelimit", "quizaccess_password"],
            blocking_reasons_for_you: [],
        });
        expect(JSON.stringify(r)).not.toContain("CLAVE-QUIZ-SECRETA");
    });

    it("los intentos de un participante traen la nota del cuestionario y la nota para aprobar", async () => {
        const h = await makeHarness();
        const a = await h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: STUDENT_A });
        expect(a.data.quiz_grade).toEqual({ has_grade: true, grade: 7.5, grade_to_pass: 6 });
        const b = await h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: STUDENT_B });
        expect(b.data.quiz_grade).toEqual({ has_grade: false, grade: null, grade_to_pass: null });
        expect(h.fake.callsOf("mod_quiz_get_user_best_grade")[0]!.params).toMatchObject({ quizid: String(QUIZ), userid: String(STUDENT_A) });
    });

    it("si la nota no se puede leer, se declara (no se inventa)", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_quiz_get_user_best_grade", () => ({ exception: "required_capability_exception", errorcode: "nopermissions", message: "Sin permiso" }));
        const a = await h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: STUDENT_A }).catch((e) => e as CampusError);
        if (a instanceof CampusError) throw a;
        expect(a.data.quiz_grade).toBeNull();
        expect(a.coverage.complete).toBe(false);
    });
});
