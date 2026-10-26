import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import {
    ASSIGN,
    ATTEMPT_A,
    CONVERSATION,
    COURSE,
    OTHER_COURSE,
    OTHER_QUIZ_ATTEMPT,
    QUIZ,
    STUDENT_A,
    STUDENT_B,
    STUDENT_C,
    STUDENT_INJECTION,
    SUBSECTION,
} from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

// Secretos: nunca salen. Los datos personales sí, donde la herramienta los necesita (ADR-124).
const SENSITIVE = ["CLAVE-QUIZ-SECRETA", "10.0.0.0/8", "CLAVE-GRUPO", "token=abc", "ana.login"];
const noLeaks = (x: unknown) => {
    const t = JSON.stringify(x);
    for (const s of SENSITIVE) expect(t, s).not.toContain(s);
};

describe("estructura del curso: etiquetas", () => {
    it("incluye el texto de las etiquetas de la página del curso", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourse(COURSE);
        const label = r.data.sections[0]!.modules.find((m) => m.modname === "label")!;
        expect(label.description_markdown).toBe("Bienvenidos a **SINT-101**. Las clases son los lunes.");
    });
});

describe("estructura del curso: todas las secciones (Moodle 5)", () => {
    it("anida las subsecciones dentro de su sección y no las repite arriba", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourse(COURSE);
        expect(r.data.sections.map((s) => s.section_number)).toEqual([0, 1]);
        expect(r.data.totals).toEqual({ sections: 2, subsections: 2, modules: 12 });
        const sub = r.data.sections[1]!.modules.find((m) => m.modname === "subsection")!;
        expect(sub.instance_id).toBe(SUBSECTION);
        expect(sub.subsection).toMatchObject({ name: "Semana 1 y 2", summary: "Ejercicios de las dos primeras semanas." });
        expect(sub.subsection!.modules.map((m) => m.name)).toEqual(["Ejercicios"]);
        // La subsección sin módulo visible no se pierde: va aparte, con aviso.
        expect(r.data.orphan_subsections?.map((s) => s.name)).toEqual(["Subsección suelta"]);
        expect(r.warnings.join(" ")).toContain("orphan_subsections");
    });

    it("muestra las fechas de las actividades", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourse(COURSE);
        const tp = r.data.sections[1]!.modules.find((m) => m.name === "TP1")!;
        expect(tp.dates.map((d) => d.label)).toEqual(["Apertura:", "Vencimiento:"]);
        expect(tp.dates[1]!.at).not.toBeNull();
    });

    it("recorta resúmenes largos en la vista completa y los entrega enteros con section_number", async () => {
        const h = await makeHarness();
        const all = await h.app.service.getCourse(COURSE);
        expect(all.data.sections[1]!.summary_truncated).toBe(true);
        expect(all.warnings.join(" ")).toContain("section_number");
        const one = await h.app.service.getCourse(COURSE, { section_number: 1 });
        expect(one.data.sections).toHaveLength(1);
        expect(one.data.section_filter).toBe(1);
        // El presupuesto del perfil sintético (3000) supera el recorte de la vista completa (2000).
        expect(one.data.sections[0]!.summary.length).toBeGreaterThan(all.data.sections[1]!.summary.length);
        expect(one.data.sections[0]!.modules.find((m) => m.modname === "subsection")!.subsection).not.toBeNull();
        expect(await codeOf(h.app.service.getCourse(COURSE, { section_number: 9 }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("expone imágenes y archivos del resumen de sección como file_ref (sólo del Campus)", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourse(COURSE);
        const files = r.data.sections[1]!.summary_files;
        expect(files.map((f) => f.name)).toEqual(["diagrama.png", "guía.pdf"]);
        expect(files[0]!.ref).toMatch(/^file_c\.4242\.2\.[0-9a-f]{8}$/);
        const img = await h.app.service.readFile({ file_ref: files[0]!.ref });
        expect(img.data.modality).toBe("image");
        expect(img.data.file.origin).toEqual({ kind: "section", id: 2 });
        // Un localizador de sección de otro curso no se resuelve.
        expect(await codeOf(h.app.service.readFile({ file_ref: files[0]!.ref.replace(".4242.", `.${OTHER_COURSE}.`) }))).toBe("POLICY_DENIED");
    });

    it("distingue archivos homónimos en subcarpetas de una Carpeta", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourse(COURSE);
        const folder = r.data.sections[1]!.modules.find((m) => m.modname === "subsection")!.subsection!.modules[0]!;
        expect(folder.files.map((f) => f.folder_path)).toEqual(["/semana1/", "/semana2/"]);
        expect(folder.files[0]!.ref).not.toBe(folder.files[1]!.ref);
        const a = await h.app.service.readFile({ file_ref: folder.files[0]!.ref });
        const b = await h.app.service.readFile({ file_ref: folder.files[1]!.ref });
        expect(a.data.text).toContain("semana 1");
        expect(b.data.text).toContain("semana 2");
    });
});

describe("cuestionarios", () => {
    it("lista cuestionarios del curso sin contraseña ni red", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listQuizzes(COURSE);
        expect(r.data.quizzes).toHaveLength(1);
        expect(r.data.quizzes[0]).toMatchObject({ quiz_id: QUIZ, time_limit_minutes: 30, attempts_allowed: 2, grading_method: "nota más alta", close: null });
        noLeaks(r);
    });

    it("intentos de un estudiante y revisión con preguntas como texto", async () => {
        const h = await makeHarness();
        const a = await h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: STUDENT_A });
        expect(a.data.attempts).toEqual([expect.objectContaining({ attempt_id: ATTEMPT_A, state: "finished", grade: 7.5 })]);
        const rev = await h.app.service.getQuizAttempt({ course_id: COURSE, quiz_id: QUIZ, attempt_id: ATTEMPT_A });
        expect(rev.data.questions[0]).toMatchObject({ number: "1", mark: 1, max_mark: 1, text_markdown: "¿Cuánto es 2+2?\n\nRespuesta: 4" });
        expect(rev.data.questions[1]!.text_markdown).toContain(STUDENT_INJECTION); // respuesta del alumno = dato
        expect(rev.data.questions[1]!.mark).toBeNull();
    });

    it("intento de otro cuestionario o de alguien ajeno al curso: no se expone", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getQuizAttempt({ course_id: COURSE, quiz_id: QUIZ, attempt_id: OTHER_QUIZ_ATTEMPT }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.getQuizAttempt({ course_id: COURSE, quiz_id: QUIZ, attempt_id: 8899 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: 799, participant_id: STUDENT_A }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.getQuizAttempts({ course_id: COURSE, quiz_id: QUIZ, participant_id: 999 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.listQuizzes(OTHER_COURSE))).toBe("POLICY_DENIED");
    });
});

describe("participantes y grupos", () => {
    it("participantes con roles, grupos, último acceso y datos de perfil (ADR-124); sin username ni token en la foto", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listParticipants({ course_id: COURSE });
        expect(r.data.summary).toEqual({ participants: 4, by_role: { editingteacher: 1, student: 3 }, without_group: 2 });
        expect(r.data.participants.find((p) => p.participant_id === STUDENT_A)).toMatchObject({
            email: "ana@campus.example.test",
            student_id: "L-0001",
            country: "AR",
            description_markdown: "bio",
            photo_url: "https://campus.example.test/pluginfile.php/5/user/icon/boost/f1?rev=3",
        });
        expect(r.data.participants.find((p) => p.participant_id === STUDENT_C)).toMatchObject({ student_id: null, country: null, photo_url: null });
        expect(r.data.participants.find((p) => p.participant_id === STUDENT_B)!.last_course_access).toBeNull(); // 0 ≠ 1970
        noLeaks(r);
        const students = await h.app.service.listParticipants({ course_id: COURSE, role: "student", group_id: 1 });
        expect(students.data.participants.map((p) => p.participant_id)).toEqual([STUDENT_A]);
    });

    it("grupos con integrantes, inscripción a grupos y estudiantes sin grupo; sin claves", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listGroups(COURSE);
        expect(r.data.groups.map((g) => [g.name, g.member_count])).toEqual([["Comisión A", 1], ["Comisión B", 1]]);
        expect(r.data.groups[1]!.description_markdown).toBe("Tarde");
        expect(r.data.group_signups[0]).toMatchObject({ name: "Grupos TP2", options: [{ group_id: 1, name: "Comisión A", max: 3, enrolled: 1 }, { group_id: 2, name: "Comisión B", max: 3, enrolled: 1 }] });
        expect(r.data.students_without_group.map((s) => s.participant_id)).toEqual([STUDENT_C]);
        noLeaks(r);
    });
});

describe("calificaciones", () => {
    it("libro de calificaciones con legajos (ADR-124); devoluciones sólo si se piden", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getGrades({ course_id: COURSE });
        expect(r.data.items.map((i) => i.name)).toEqual(["TP1 sintético", "Asistencia", "Total del curso"]);
        const ana = r.data.students.find((s) => s.participant_id === STUDENT_A)!;
        expect(ana.grades[0]).toMatchObject({ value: 8, formatted: "8,00", percentage: "80,00 %" });
        expect(ana.grades[0]).not.toHaveProperty("feedback_markdown");
        expect(ana.student_id).toBe("L-0001");
        expect(r.data.students.find((s) => s.participant_id === STUDENT_B)!.student_id).toBe("L-0002");
        expect(r.data.students.find((s) => s.participant_id === STUDENT_B)!.grades[0]!.hidden_from_student).toBe(true);
        noLeaks(r);
        const withFb = await h.app.service.getGrades({ course_id: COURSE, participant_id: STUDENT_A, include_feedback: true });
        expect(withFb.data.students).toHaveLength(1);
        expect(withFb.data.students[0]!.grades[0]!.feedback_markdown).toBe("Muy bien, revisá los nombres.");
    });

    it("participante no matriculado → bloqueo antes de pedir notas", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getGrades({ course_id: COURSE, participant_id: 999 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.callsOf("gradereport_user_get_grade_items")).toHaveLength(0);
    });
});

describe("cambios, búsqueda, asistencia", () => {
    it("cambios desde una fecha con nombres de módulo", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourseUpdates({ course_id: COURSE, since: "2026-09-01" });
        // 9101 (la tarea) no figura en la estructura sintética: su nombre queda null, sin inventarlo.
        expect(r.data.changes.map((c) => [c.course_module_id, c.name, c.changed.map((x) => x.label)])).toEqual([
            [9001, "Avisos", ["discusiones"]],
            [9101, "TP1 sintético", ["entregas", "configuración"]],
        ]);
        expect(r.data.changes[0]).toMatchObject({ module: "forum" });
        expect(await codeOf(h.app.service.getCourseUpdates({ course_id: COURSE, since: "ayer" }))).toBe("POLICY_DENIED");
    });

    it("búsqueda en foros: todos los términos, sin tildes, con cobertura", async () => {
        const h = await makeHarness();
        const r = await h.app.service.searchForums({ course_id: COURSE, query: "ENTREGA tp1" });
        expect(r.data.matches.length).toBeGreaterThan(0);
        expect(r.data.matches.every((m) => /TP1/.test(m.snippet_markdown) || /TP1/i.test(m.subject))).toBe(true);
        expect(r.coverage.complete).toBe(true);
        const acc = await h.app.service.searchForums({ course_id: COURSE, query: "sintetico" }); // sin tilde encuentra «sintético»
        expect(acc.data.matches.length).toBeGreaterThan(0);
        expect(await codeOf(h.app.service.searchForums({ course_id: COURSE, query: "x" }))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.searchForums({ course_id: COURSE, query: "tp", forum_id: 3999 }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("asistencia: sesiones desde el calendario y remite a campus_get_attendance", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listAttendanceSessions({ course_id: COURSE });
        expect(r.data.sessions.map((e) => e.event_id)).toEqual([5003]);
        expect(r.warnings[0]).toMatch(/campus_get_attendance/);
    });
});

describe("mensajes y comentarios", () => {
    it("conversaciones con no leídos y vista previa; mensajes en orden, sin marcar leídos", async () => {
        const h = await makeHarness();
        const list = await h.app.service.listConversations({});
        expect(list.data.conversations[0]).toMatchObject({ conversation_id: CONVERSATION, members: ["Ana Sintética"], unread: true, unread_count: 2 });
        expect(list.data.conversations[1]!.last_message!.from_me).toBe(true);
        const unread = await h.app.service.listConversations({ unread_only: true });
        expect(unread.data.conversations).toHaveLength(1);
        const conv = await h.app.service.getConversation({ conversation_id: CONVERSATION });
        expect(conv.data.messages.map((m) => [m.from, m.text_markdown])).toEqual([
            ["Ana Sintética", "Profe, ¿se puede entregar mañana?"],
            ["yo", "Hola Ana"],
        ]);
        expect(h.fake.calls.some((c) => /mark|read/.test(c.fn) && c.fn !== "core_message_get_conversation_messages")).toBe(false);
        noLeaks(list);
    });

    it("la entrega incluye los comentarios", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A });
        expect(r.data.comments).toEqual([expect.objectContaining({ author: "Ana Sintética", text_markdown: "Subí la versión corregida" })]);
    });
});
