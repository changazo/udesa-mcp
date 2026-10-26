import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import { ASSIGN, COURSE, OTHER_COURSE, STUDENT_A, STUDENT_B } from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("devolución de una entrega", () => {
    it("sin include_feedback no expone nota ni devolución", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A });
        expect("feedback" in r.data).toBe(false);
        expect(JSON.stringify(r)).not.toContain("DEVOLUCION-PRIVADA");
        expect(r.warnings.join(" ")).toContain("include_feedback");
    });

    it("con include_feedback trae nota, comentario y archivos de devolución, sin quién calificó", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A, include_feedback: true });
        const fb = r.data.feedback!;
        expect(fb).toMatchObject({ grade: 8, grade_display: "8,00 / 10,00", comment_markdown: "DEVOLUCION-PRIVADA", comment_truncated: false });
        expect(fb.graded).not.toBeNull();
        expect(fb.files.map((f) => [f.name, f.kind])).toEqual([
            ["correccion.txt", "archivo_de_devolucion"],
            ["anotado.pdf", "pdf_anotado"],
        ]);
        expect(fb.files[0]!.ref).toMatch(new RegExp(`^file_f\\.${COURSE}\\.${ASSIGN}\\.${STUDENT_A}\\.[0-9a-f]{8}$`));
        expect(JSON.stringify(r)).not.toContain("\"grader\":"); // la URL de origen dice action=grader; el campo no debe estar
        const file = await h.app.service.readFile({ file_ref: fb.files[0]!.ref });
        expect(file.data.text).toContain("Corrección sintética");
        expect(file.data.file.origin).toEqual({ kind: "feedback", id: STUDENT_A });
    });

    it("sin calificar: nota null (Moodle usa -1)", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_B, include_feedback: true });
        expect(r.data.feedback).toMatchObject({ grade: null, comment_markdown: null, files: [] });
    });

    it("un localizador de devolución manipulado no se resuelve", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A, include_feedback: true });
        const ref = r.data.feedback!.files[0]!.ref;
        expect(await codeOf(h.app.service.readFile({ file_ref: ref.replace(`.${STUDENT_A}.`, ".999999.") }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.readFile({ file_ref: ref.replace(`.${COURSE}.`, `.${OTHER_COURSE}.`) }))).toBe("POLICY_DENIED");
    });
});

describe("pendientes del docente", () => {
    it("calcula entregas por corregir y próximos vencimientos de los cursos permitidos", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listPending({});
        expect(r.data.courses).toEqual([COURSE]);
        const tp1 = r.data.to_grade.find((x) => x.assignment_id === ASSIGN)!;
        expect(tp1).toMatchObject({ course_id: COURSE, requires_grading: 2, method: "resumen" });
        // Sólo vencimientos de actividades: ni la clase (asistencia) ni el evento sin módulo ni el de otro curso.
        expect(r.data.upcoming.map((e) => e.name)).toEqual(["TP1 sintético vence"]);
        expect(r.data.totals.submissions_to_grade).toBe(r.data.to_grade.reduce((n, x) => n + x.requires_grading, 0));
        expect(r.coverage.complete).toBe(true);
    });

    it("un curso fuera del perfil se rechaza antes de llamar a Moodle", async () => {
        const h = await makeHarness();
        const before = h.fake.calls.length;
        expect(await codeOf(h.app.service.listPending({ course_id: OTHER_COURSE }))).toBe("POLICY_DENIED");
        expect(h.fake.calls.length).toBe(before);
    });
});

describe("notificaciones", () => {
    it("lista notificaciones con remitente y cuerpo completo (ADR-124), sin token en enlaces", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listNotifications({});
        expect(r.data.unread_count).toBe(1);
        expect(r.data.notifications.map((n) => n.subject)).toEqual(["Nueva entrega en TP1", "Aviso publicado"]);
        expect(r.data.notifications[0]).toMatchObject({ message_markdown: "Ana entregó **TP1**", read: false, component: "mod_assign" });
        expect(r.data.notifications[0]).toMatchObject({ from: { user_id: STUDENT_A }, body_markdown: "CUERPO-COMPLETO" });
        expect(r.data.notifications[1]!.body_markdown).toBeNull();
        const text = JSON.stringify(r);
        expect(text).not.toContain("token=abc");
        const unread = await h.app.service.listNotifications({ unread_only: true });
        expect(unread.data.notifications).toHaveLength(1);
    });
});
