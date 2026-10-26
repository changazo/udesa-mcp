import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, SITE, STUDENT_A, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { QUIZ_ID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const ATTEMPT = 4100;
const USAGE = 88;

/** Intento terminado con un ensayo (slot 1, máx 2) y el formulario comment.php (con :sequencecheck). */
async function harness(opts: { owner?: number; allowNotify?: boolean } = {}) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["grade_quiz"] }, allow_participant_notifications: opts.allowNotify ?? false } });
    new SyntheticQuizzes(h.fake, h.w2);
    const state = { mark: null as number | null, comment: "", seq: 3, ignore: false, posts: [] as Record<string, string>[] };
    h.fake.overrides.set("mod_quiz_get_attempt_review", (p) => {
        if (Number(p.attemptid) !== ATTEMPT) return { exception: "moodle_exception", errorcode: "invalidattemptid", message: "No" };
        return { grade: null, attempt: { id: ATTEMPT, quiz: QUIZ_ID, userid: opts.owner ?? USER_ID, attempt: 1, state: "finished", sumgrades: null }, questions: [{ slot: 1, type: "essay", state: state.mark === null ? "needsgrading" : "mangrpartial", mark: state.mark === null ? null : state.mark.toFixed(2).replace(".", ","), maxmark: 2 }], warnings: [] };
    });
    h.fake.web.pages.set("/mod/quiz/comment.php", (q, req) => {
        if (req.method === "GET") {
            const p = `q${USAGE}:${q.slot}_`;
            return {
                body: `<html><body><form action="${SITE}/mod/quiz/comment.php" method="post"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="attempt" value="${q.attempt}"><input type="hidden" name="slot" value="${q.slot}"><input type="hidden" name="slots" value="${q.slot}"><input type="hidden" name="${p}:sequencecheck" value="${state.seq}"><textarea name="${p}-comment">${state.comment}</textarea><input type="hidden" name="${p}-commentformat" value="1"><input type="text" name="${p}-mark" value="${state.mark ?? ""}"><input type="hidden" name="${p}-maxmark" value="2"><input type="submit" name="submit" value="Guardar"></form></body></html>`,
            };
        }
        const b = new URLSearchParams(req.body ?? "");
        state.posts.push(Object.fromEntries(b));
        const p = `q${USAGE}:${b.get("slot")}_`;
        // Trampa real: sin :sequencecheck correcto Moodle ignora el slot en silencio, y muestra «guardado» igual.
        if (!state.ignore && b.get(`${p}:sequencecheck`) === String(state.seq)) {
            state.mark = Number(b.get(`${p}-mark`));
            state.comment = b.get(`${p}-comment`) ?? "";
            state.seq++;
        }
        return { body: `<html><body><div class="alert alert-success notifysuccess">Cambios guardados</div></body></html>` };
    });
    return { h, state };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("quiz_grade", { course_id: COURSE, attempt_id: ATTEMPT, slot: 1, ...input }, "test");
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

describe("calificación manual de una pregunta (ADR-071)", () => {
    it("intento propio: nota y comentario con el sequencecheck del formulario; verificado; un cambio posterior se deshace", async () => {
        const { h, state } = await harness();
        const r1 = await exec(h, (await plan(h, { mark: 1.5, comment: "Falta un **ejemplo**." })).plan_id);
        expect(r1.status).toBe("aplicado_verificado");
        expect(state.posts[0]).toMatchObject({ [`q${USAGE}:1_-mark`]: "1.5", [`q${USAGE}:1_:sequencecheck`]: "3", slots: "1", submit: "1" });
        expect(state.posts[0]![`q${USAGE}:1_-comment`]).toContain("<strong>ejemplo</strong>");
        expect((await h.app.engine.planUndo(r1.action_id, "test")).undoable).toBe(false); // no vuelve a «sin calificar»
        const r2 = await exec(h, (await plan(h, { mark: 0.5 })).plan_id);
        expect(state.mark).toBe(0.5);
        const u = await h.app.engine.planUndo(r2.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(state.mark).toBe(1.5);
    });

    it("Moodle ignora el slot y muestra «guardado» → sin_efecto, nunca «ok»", async () => {
        const { h, state } = await harness();
        state.ignore = true;
        expect((await exec(h, (await plan(h, { mark: 1 })).plan_id)).status).toBe("sin_efecto");
    });

    it("intento de un estudiante: rechazado mientras el perfil no permita notificar; permitido si lo permite", async () => {
        expect((await errOf(plan((await harness({ owner: STUDENT_A })).h, { mark: 1 }))).message).toMatch(/notificar/);
        const { h } = await harness({ owner: STUDENT_A, allowNotify: true });
        expect((await plan(h, { mark: 1 })).risk).toBe("R3");
    });

    it("rechazos: slot inexistente, nota mayor al máximo, intento ajeno al curso", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, { slot: 9, mark: 1 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, { mark: 3 }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { attempt_id: 1, mark: 1 }))).code).not.toBe("NO_ERROR");
    });
});
