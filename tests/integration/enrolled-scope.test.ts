import { describe, expect, it } from "vitest";
import { loadProfile } from "../../src/config/profile.js";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import { makeWriteHarness } from "../fixtures/write-harness.js";
import { ASSIGN, ATTEMPT_A, COURSE, OTHER_COURSE, OWN_ATTEMPT, QUIZ, STUDENT_A, TEACH_COURSE_2, USER_ID } from "../fixtures/fake-moodle.js";

/** ADR-122: alcance «enrolled» (cualquier rol) con datos de terceros sólo para el rol docente. */

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

const ENROLLED = { course_scope: "enrolled", allowed_course_ids: [] };

/** Roles sintéticos por curso para la cuenta verificada (el resto, estudiante). */
function rolesBy(map: Record<number, string[]>) {
    return (params: Record<string, string>) => {
        const courseid = Number(params["userlist[0][courseid]"]);
        return [{ id: USER_ID, fullname: "Docente Sintético", roles: (map[courseid] ?? ["student"]).map((shortname) => ({ roleid: 5, shortname, name: shortname })) }];
    };
}

/** COURSE (el de más datos sintéticos) con rol de estudiante. */
async function studentHarness() {
    const h = await makeHarness({ profile: ENROLLED });
    h.fake.overrides.set("core_user_get_course_user_profiles", rolesBy({ [TEACH_COURSE_2]: ["teacher"] }));
    return h;
}

describe("course_scope=enrolled (ADR-122)", () => {
    it("el perfil versionado udesa-docente usa enrolled y roles de escritura por defecto", () => {
        const p = loadProfile({ profileId: "udesa-docente", env: {} });
        expect(p.course_scope).toBe("enrolled");
        expect(p.write_role_shortnames).toEqual(["editingteacher", "manager", "coursecreator"]);
    });

    it("lista todos los cursos matriculados, con el rol de cada uno", async () => {
        const h = await makeHarness({ profile: ENROLLED });
        const r = await h.app.service.listCourses();
        expect(r.data.map((c) => c.course_id).sort()).toEqual([COURSE, TEACH_COURSE_2, OTHER_COURSE].sort());
        expect(r.data.find((c) => c.course_id === OTHER_COURSE)!.roles).toEqual(["student"]);
        expect(r.warnings.join(" ")).toContain("exigen rol docente");
        expect(JSON.stringify(r)).not.toContain("docente@campus.example.test");
    });

    it("curso de estudiante: lo propio se lee (contenido, foros, tareas, calendario, notas propias)", async () => {
        const h = await studentHarness();
        expect((await h.app.service.getCourse(COURSE)).data.course_id).toBe(COURSE);
        expect((await h.app.service.listForums(COURSE)).data).toBeTruthy();
        expect((await h.app.service.listAnnouncements({ course_id: COURSE })).data.announcements.length).toBeGreaterThan(0);
        expect((await h.app.service.listAssignments(COURSE)).data.assignments.length).toBeGreaterThan(0);
        expect(await codeOf(h.app.service.listEvents({ course_id: COURSE }))).toBe("NO_ERROR");
        // Notas: siempre con el userid propio, nunca userid=0 (toda la clase).
        const g = await h.app.service.getGrades({ course_id: COURSE });
        expect(h.fake.callsOf("gradereport_user_get_grade_items").at(-1)!.params.userid).toBe(String(USER_ID));
        expect(g.warnings[0]).toContain("Tus notas");
    });

    it("curso que oculta el libro a los estudiantes: error claro, no lista vacía", async () => {
        const h = await studentHarness();
        h.fake.overrides.set("gradereport_user_get_grade_items", () => ({ exception: "moodle_exception", errorcode: "nopermissiontoviewgrades", message: "No se pueden ver las calificaciones." }));
        const e = await h.app.service.getGrades({ course_id: COURSE }).catch((x: CampusError) => x);
        expect((e as CampusError).code).toBe("MOODLE_PERMISSION_DENIED");
        expect((e as CampusError).message).toContain("no muestra las calificaciones a los estudiantes");
    });

    it("curso de estudiante: datos de terceros → POLICY_DENIED sin consultarlos", async () => {
        const h = await studentHarness();
        const denied = [
            h.app.service.listParticipants({ course_id: COURSE }),
            h.app.service.listGroups(COURSE),
            h.app.service.getSubmissionStatus({ course_id: COURSE, assignment_id: ASSIGN }),
            h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A }),
            h.app.service.getGrades({ course_id: COURSE, participant_id: STUDENT_A }),
            h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: STUDENT_A }),
            h.app.service.getAttendance({ course_id: COURSE }),
            h.app.service.getCourseReport({ course_id: COURSE, kind: "participation" } as never),
            h.app.service.getQuizReport({ course_id: COURSE, quiz_id: QUIZ, kind: "responses" }),
            h.app.service.getQuizStructure({ course_id: COURSE, quiz_id: QUIZ }),
            h.app.service.listQuestionBanks({ course_id: COURSE }),
            h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: 9101, participant_id: STUDENT_A }),
        ];
        for (const p of denied) {
            const e = await p.then(() => null, (x: unknown) => x);
            expect(e).toBeInstanceOf(CampusError);
            expect((e as CampusError).code).toBe("POLICY_DENIED");
            expect((e as CampusError).message).toContain("datos de terceros");
        }
        for (const fn of ["mod_assign_list_participants", "mod_assign_get_submissions", "mod_assign_get_submission_status", "mod_quiz_get_user_attempts", "tool_mobile_get_content", "core_enrol_get_enrolled_users"]) {
            expect(h.fake.callsOf(fn).length, fn).toBe(0);
        }
        const msg = await h.app.service.listParticipants({ course_id: COURSE }).catch((e: CampusError) => e.message);
        expect(msg).toContain("student");
        expect(msg).toContain("datos de terceros");
    });

    it("el mismo curso con rol docente sí permite los datos de terceros", async () => {
        const h = await makeHarness({ profile: ENROLLED });
        expect(await codeOf(h.app.service.listParticipants({ course_id: COURSE }))).toBe("NO_ERROR");
        expect(await codeOf(h.app.service.getSubmissionStatus({ course_id: COURSE, assignment_id: ASSIGN }))).toBe("NO_ERROR");
    });

    for (const role of ["manager", "coursecreator"]) {
        it(`rol superior (${role}) también ve datos de terceros`, async () => {
            const h = await makeHarness({ profile: ENROLLED });
            h.fake.overrides.set("core_user_get_course_user_profiles", rolesBy({ [COURSE]: [role] }));
            expect(await codeOf(h.app.service.listParticipants({ course_id: COURSE }))).toBe("NO_ERROR");
            expect(await codeOf(h.app.service.getSubmissionStatus({ course_id: COURSE, assignment_id: ASSIGN }))).toBe("NO_ERROR");
        });
    }

    it("pendientes: en cursos de estudiante sólo vencimientos, sin «por corregir»", async () => {
        const h = await studentHarness();
        const r = await h.app.service.listPending({ course_id: COURSE });
        expect(r.data.to_grade).toEqual([]);
        expect(r.warnings.join(" ")).toContain("rol no es docente");
        expect(h.fake.callsOf("mod_assign_get_submissions").length).toBe(0);
    });

    it("excluded_course_ids sigue sacando cursos del alcance", async () => {
        const h = await makeHarness({ profile: { ...ENROLLED, excluded_course_ids: [OTHER_COURSE] } });
        expect((await h.app.service.listCourses()).data.map((c) => c.course_id)).not.toContain(OTHER_COURSE);
        expect(await codeOf(h.app.service.getCourse(OTHER_COURSE))).toBe("POLICY_DENIED");
    });

    it("si falla la consulta de roles es un error, nunca «sin cursos» ni «todos»", async () => {
        const h = await makeHarness({ profile: ENROLLED });
        h.fake.overrides.set("core_user_get_course_user_profiles", () => ({ exception: "required_capability_exception", errorcode: "nopermissions", message: "No" }));
        expect(await codeOf(h.app.service.listCourses())).toBe("MOODLE_PERMISSION_DENIED");
        expect(await codeOf(h.app.service.getCourse(COURSE))).toBe("MOODLE_PERMISSION_DENIED");
    });

    it("curso que no figura entre los matriculados → POLICY_DENIED", async () => {
        const h = await makeHarness({ profile: ENROLLED });
        expect(await codeOf(h.app.service.getCourse(123456))).toBe("POLICY_DENIED");
    });
});

describe("allowlist: los datos de terceros también exigen rol docente (ADR-122)", () => {
    it("con rol de estudiante en un curso de la allowlist, participantes → POLICY_DENIED", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("core_user_get_course_user_profiles", rolesBy({}));
        expect(await codeOf(h.app.service.getCourse(COURSE))).toBe("NO_ERROR");
        expect(await codeOf(h.app.service.listParticipants({ course_id: COURSE }))).toBe("POLICY_DENIED");
        // Un fallo al consultar roles no se cachea como «sin roles».
        h.fake.overrides.delete("core_user_get_course_user_profiles");
        h.app.scope.invalidate();
        expect(await codeOf(h.app.service.listParticipants({ course_id: COURSE }))).toBe("NO_ERROR");
    });
});

describe("escritura: sólo con rol de profesor, gestor o superior (ADR-122)", () => {
    const plan = (h: Awaited<ReturnType<typeof makeWriteHarness>>) => h.app.engine.plan("marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "x" }] }, "test");

    for (const role of ["student", "teacher"]) {
        it(`rol ${role} → POLICY_DENIED antes de armar el plan`, async () => {
            const h = await makeWriteHarness();
            h.fake.overrides.set("core_user_get_course_user_profiles", rolesBy({ [COURSE]: [role] }));
            const e = await plan(h).catch((x: CampusError) => x);
            expect(e).toBeInstanceOf(CampusError);
            expect((e as CampusError).code).toBe("POLICY_DENIED");
            expect((e as CampusError).message).toContain("profesor, gestor o superior");
            expect(h.fake.callsOf("local_sintetico_set_marker").length).toBe(0);
        });
    }

    it("rol manager (gestor) puede planificar", async () => {
        const h = await makeWriteHarness();
        h.fake.overrides.set("core_user_get_course_user_profiles", rolesBy({ [COURSE]: ["manager"] }));
        expect((await plan(h)).plan_id).toBeTruthy();
    });

    it("rol editingteacher puede planificar; la allowlist de escritura sigue mandando", async () => {
        const h = await makeWriteHarness();
        expect((await plan(h)).plan_id).toBeTruthy();
        expect(await codeOf(h.app.engine.plan("marcador_sintetico", { course_id: OTHER_COURSE, changes: [{ marker_id: 1, value: "x" }] }, "test"))).toBe("POLICY_DENIED");
    });
});

describe("intentos propios con cualquier rol (ADR-123)", () => {
    it("lista los intentos propios con las opciones de revisión del cuestionario", async () => {
        const h = await studentHarness();
        const r = await h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ });
        expect(r.data.participant).toEqual({ participant_id: USER_ID, name: "Docente Sintético" });
        expect(r.data.attempts.map((a) => a.attempt_id)).toEqual([OWN_ATTEMPT]);
        // ADR-124: el nombre se muestra en lo propio, pero no se guarda en la sesión ni sale en el estado.
        expect(JSON.stringify(h.metadata.read())).not.toContain("Docente Sintético");
        expect(JSON.stringify(await h.app.session.status(true))).not.toContain("Docente Sintético");
        expect((r.data as { review: unknown }).review).toMatchObject({ responses: "siempre", marks: "a_veces", right_answer: "nunca" });
        expect(h.fake.callsOf("mod_quiz_get_user_attempts").at(-1)!.params.userid).toBe(String(USER_ID));
        // Con participant_id = la propia cuenta, igual.
        expect(await codeOf(h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: USER_ID }))).toBe("NO_ERROR");
    });

    it("revisa un intento propio si la configuración lo permite", async () => {
        const h = await studentHarness();
        const r = await h.app.service.getQuizAttempt({ course_id: COURSE, quiz_id: QUIZ, attempt_id: OWN_ATTEMPT });
        expect(r.data.participant.participant_id).toBe(USER_ID);
        expect(r.data.questions.length).toBe(2);
        expect(h.fake.callsOf("mod_assign_list_participants").length + h.fake.callsOf("core_enrol_get_enrolled_users").length).toBe(0);
    });

    it("revisión deshabilitada siempre → error claro sin pedir el intento", async () => {
        const h = await studentHarness();
        h.fake.reviewOptions = { some: { attempt: 0 }, all: { attempt: 0 } };
        const e = await h.app.service.getQuizAttempt({ course_id: COURSE, quiz_id: QUIZ, attempt_id: OWN_ATTEMPT }).catch((x: CampusError) => x);
        expect((e as CampusError).code).toBe("MOODLE_PERMISSION_DENIED");
        expect((e as CampusError).message).toContain("configuración de revisión");
        expect(h.fake.callsOf("mod_quiz_get_attempt_review").length).toBe(0);
    });

    it("revisión habilitada más tarde: Moodle la niega ahora y se informa así", async () => {
        const h = await studentHarness();
        h.fake.reviewBlockedNow = true;
        const e = await h.app.service.getQuizAttempt({ course_id: COURSE, quiz_id: QUIZ, attempt_id: OWN_ATTEMPT }).catch((x: CampusError) => x);
        expect((e as CampusError).code).toBe("MOODLE_PERMISSION_DENIED");
        expect((e as CampusError).message).toContain("no permite ver este intento ahora");
        expect((e as CampusError).moodleErrorcode).toBe("noreviewuntil");
    });

    it("sin rol docente, el intento de otro no se expone", async () => {
        const h = await studentHarness();
        expect(await codeOf(h.app.service.getQuizAttempt({ course_id: COURSE, quiz_id: QUIZ, attempt_id: ATTEMPT_A }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: STUDENT_A }))).toBe("POLICY_DENIED");
    });

    it("con rol docente, los intentos de otro siguen funcionando como antes", async () => {
        const h = await makeHarness({ profile: ENROLLED });
        const r = await h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: STUDENT_A });
        expect(r.data.attempts.map((a) => a.attempt_id)).toEqual([ATTEMPT_A]);
        expect((await h.app.service.getQuizAttempt({ course_id: COURSE, quiz_id: QUIZ, attempt_id: ATTEMPT_A })).data.participant.participant_id).toBe(STUDENT_A);
        expect(h.fake.callsOf("mod_quiz_get_combined_review_options").length).toBe(0);
    });
});

describe("escritura en todos los cursos con rol de escritura (ADR-125)", () => {
    const plan = (h: Awaited<ReturnType<typeof makeWriteHarness>>) => h.app.engine.plan("marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "x" }] }, "test");
    const OPEN = { sandbox_course_ids: [], courses: {}, all_courses: [{ capability: "synthetic_test", enabled_on: "2026-10-22" }] };

    it("un curso sin entrada propia toma all_courses, sin escalada por curso real (ADR-126)", async () => {
        const h = await makeWriteHarness({ policy: OPEN });
        const p = await plan(h);
        expect(p.plan_id).toBeTruthy();
        expect(p.risk_reasons.join(" ")).not.toContain("Curso real");
    });

    it("all_courses no saltea el rol: estudiante → POLICY_DENIED", async () => {
        const h = await makeWriteHarness({ policy: OPEN });
        h.fake.overrides.set("core_user_get_course_user_profiles", rolesBy({ [COURSE]: ["student"] }));
        expect(await codeOf(plan(h))).toBe("POLICY_DENIED");
    });

    it("una entrada propia vacía bloquea el curso aunque haya all_courses", async () => {
        const h = await makeWriteHarness({ policy: { ...OPEN, courses: { [String(COURSE)]: [] } } });
        expect(await codeOf(plan(h))).toBe("WRITE_NOT_ALLOWED");
    });

    it("sin all_courses, un curso sin entrada sigue sin escrituras", async () => {
        const h = await makeWriteHarness({ policy: { sandbox_course_ids: [], courses: {} } });
        expect(await codeOf(plan(h))).toBe("WRITE_NOT_ALLOWED");
    });
});

