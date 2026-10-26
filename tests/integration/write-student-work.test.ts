import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { removeConfirmAllowed } from "../../src/write/intents/student-work.js";
import { COURSE, SITE, STUDENT_A, STUDENT_B } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-119: intentos de cuestionario y entregas de tareas. Datos inventados. */
const QUIZ = 7001;
const QUIZ_CMID = 7101;
const ASSIGN = 8001;
const ASSIGN_CMID = 8101;

async function harness(opts: { canRemove?: boolean } = {}) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["delete_student_work"] } } });
    const attempts = [
        { id: 501, quiz: QUIZ, userid: STUDENT_A, attempt: 1, state: "finished", timefinish: 1_790_000_000, sumgrades: 6 },
        { id: 502, quiz: QUIZ, userid: STUDENT_B, attempt: 1, state: "inprogress", timefinish: 0, sumgrades: null },
        { id: 503, quiz: QUIZ, userid: 999, attempt: 1, state: "finished", preview: 1, timefinish: 1_790_000_000, sumgrades: 3 },
    ];
    const subs = new Map<number, string>([
        [STUDENT_A, "submitted"],
        [STUDENT_B, "new"],
    ]);
    const posts: Record<string, string>[] = [];
    h.fake.overrides.set("mod_quiz_get_quizzes_by_courses", () => ({ quizzes: [{ id: QUIZ, coursemodule: QUIZ_CMID, course: COURSE, name: "Parcial 1" }], warnings: [] }));
    h.fake.overrides.set("mod_quiz_get_attempt_review", (p) => {
        const a = attempts.find((x) => x.id === Number(p.attemptid));
        if (!a) throw new Error("invalidrecord");
        return { grade: null, attempt: a, questions: [] };
    });
    h.fake.overrides.set("mod_quiz_get_user_attempts", (p) => ({ attempts: attempts.filter((a) => a.quiz === Number(p.quizid) && a.userid === Number(p.userid)), warnings: [] }));
    h.fake.overrides.set("core_enrol_get_enrolled_users", () => [
        { id: STUDENT_A, fullname: "Estudiante A" },
        { id: STUDENT_B, fullname: "Estudiante B" },
    ]);
    h.fake.web.pages.set("/mod/quiz/report.php", (_q, req) => {
        const b = new URLSearchParams(req.body ?? "");
        posts.push(Object.fromEntries(b));
        if (req.method === "POST" && b.get("sesskey") === WEB_SESSKEY && b.get("delete") === "1" && b.get("mode") === "overview") {
            const i = attempts.findIndex((a) => a.id === Number(b.get("attemptid[]")) && !("preview" in a));
            if (i >= 0) attempts.splice(i, 1);
        }
        return { status: 303, body: null, headers: { location: `${SITE}/mod/quiz/report.php?id=${b.get("id")}&mode=overview` } };
    });
    h.fake.overrides.set("mod_assign_get_assignments", () => ({ courses: [{ id: COURSE, assignments: [{ id: ASSIGN, cmid: ASSIGN_CMID, course: COURSE, name: "TP 1", teamsubmission: 0 }] }], warnings: [] }));
    h.fake.overrides.set("mod_assign_list_participants", () => [...subs].map(([id, st]) => ({ id, fullname: id === STUDENT_A ? "Estudiante A" : "Estudiante B", submitted: st === "submitted", submissionstatus: st })));
    h.fake.overrides.set("mod_assign_get_submission_status", (p) => ({ lastattempt: { submission: { id: 1, userid: Number(p.userid), status: subs.get(Number(p.userid)), plugins: [{ type: "file", fileareas: [{ area: "submission_files", files: [{ filename: "tp.pdf" }, { filename: "anexo.pdf" }] }] }] } }, warnings: [] }));
    h.fake.web.pages.set("/mod/assign/view.php", (q, req) => {
        if (req.method === "GET") return { body: opts.canRemove ? `<html><body><form method="post" action="${SITE}/mod/assign/view.php"><input type="hidden" name="action" value="removesubmission"></form></body></html>` : "<html><body><div class=\"alert\">No tiene permisos</div></body></html>" };
        const b = new URLSearchParams(req.body ?? "");
        posts.push(Object.fromEntries(b));
        const u = Number(b.get("userid"));
        if (b.get("sesskey") === WEB_SESSKEY && b.get("action") === "reverttodraft" && subs.get(u) === "submitted") subs.set(u, "draft");
        if (b.get("sesskey") === WEB_SESSKEY && b.get("action") === "removesubmission") subs.set(u, "new");
        return { status: 303, body: null, headers: { location: `${SITE}/mod/assign/view.php?id=${q.id ?? b.get("id")}&action=grading` } };
    });
    return { h, attempts, subs, posts };
}
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("intentos de cuestionario (ADR-119)", () => {
    it("R4: el plan nombra a cada estudiante y su intento; uno por ítem; verificado por relectura; sin deshacer", async () => {
        const { h, attempts, posts } = await harness();
        const p = await plan(h, "quiz_attempt_delete", { attempt_ids: [501, 502] });
        expect(p.risk).toBe("R4");
        expect(p.summary).toBe("BORRAR 2 intento(s) de 2 estudiante(s) en el cuestionario «Parcial 1».");
        expect(p.side_effects[0]).toMatch(/«Estudiante A», intento 1 \(terminado .*, puntaje 6\); «Estudiante B», intento 1 \(inprogress\)/);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(attempts.map((a) => a.id)).toEqual([503]);
        expect(posts.at(-1)).toMatchObject({ id: String(QUIZ_CMID), mode: "overview", "attemptid[]": "502", delete: "1" });
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);
    });

    it("rechazos: vistas previas, repetidos y otra capacidad", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, "quiz_attempt_delete", { attempt_ids: [503] }))).message).toMatch(/vistas previas/);
        expect((await errOf(plan(h, "quiz_attempt_delete", { attempt_ids: [501, 501] }))).message).toMatch(/repite/);
        const other = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["delete_content"] } } });
        expect((await errOf(plan(other, "quiz_attempt_delete", { attempt_ids: [501] }))).code).toBe("WRITE_NOT_ALLOWED");
    });
});

describe("entregas de tareas (ADR-119)", () => {
    it("devolver a borrador: R3, cuenta archivos; verificado; una sin entrega enviada se rechaza", async () => {
        const { h, subs } = await harness();
        expect((await errOf(plan(h, "assign_submission_reset", { assignment_id: ASSIGN, participant_ids: [STUDENT_B], operation: "revert_to_draft" }))).message).toMatch(/no tiene una entrega/);
        const p = await plan(h, "assign_submission_reset", { assignment_id: ASSIGN, participant_ids: [STUDENT_A], operation: "revert_to_draft" });
        expect(p.risk).toBe("R3");
        expect(p.side_effects[0]).toBe("Entregas: «Estudiante A» (submitted, 2 archivo(s)).");
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(subs.get(STUDENT_A)).toBe("draft");
    });

    it("borrar: si Moodle no lo permite, el plan lo dice sin escribir; si lo permite, R4 y verificado", async () => {
        const denied = await harness();
        const e = await errOf(plan(denied.h, "assign_submission_reset", { assignment_id: ASSIGN, participant_ids: [STUDENT_A], operation: "remove" }));
        expect(e.code).toBe("MOODLE_PERMISSION_DENIED");
        expect(denied.posts).toHaveLength(0);
        const { h, subs } = await harness({ canRemove: true });
        const p = await plan(h, "assign_submission_reset", { assignment_id: ASSIGN, participant_ids: [STUDENT_A], operation: "remove" });
        expect(p.risk).toBe("R4");
        expect(p.summary).toBe("BORRAR 1 entrega(s) de la tarea «TP 1», con 2 archivo(s).");
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(subs.get(STUDENT_A)).toBe("new");
    });

    it("la confirmación de Moodle se reconoce por su formulario", () => {
        expect(removeConfirmAllowed('<input type="hidden" name="action" value="removesubmission">')).toBe(true);
        expect(removeConfirmAllowed("<p>No tiene permisos</p>")).toBe(false);
    });
});
