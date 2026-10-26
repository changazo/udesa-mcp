import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { hasSubmissionRecord } from "../../src/domain/submission-guard.js";
import { SubmissionStatusSchema } from "../../src/moodle/schemas.js";
import { ASSIGN, ASSIGN_CMID, COURSE, NOW_UNIX, STUDENT_A, STUDENT_B, STUDENT_C } from "../fixtures/fake-moodle.js";
import { DUE, W2_ASSIGN } from "../fixtures/fake-w2.js";
import { makeHarness } from "../fixtures/harness.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * ADR-051: en Moodle 5.1 mod_assign_get_submission_status crea un registro de entrega vacío (new)
 * cuando el participante no tiene ninguno. Ninguna lectura del MCP debe provocarlo.
 */

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("el Moodle falso reproduce el efecto observado en UdeSA", () => {
    it("primera llamada: submission null pero crea el registro; la segunda lo devuelve", async () => {
        const h = await makeHarness();
        h.fake.withoutSubmission.add(STUDENT_B);
        const call = () => h.app.session.transport.call("mod_assign_get_submission_status", { assignid: ASSIGN, userid: STUDENT_B }, SubmissionStatusSchema);
        expect((await call()).lastattempt?.submission ?? null).toBeNull();
        expect(h.fake.createdSubmissions).toEqual([STUDENT_B]);
        expect((await call()).lastattempt?.submission?.status).toBe("new");
    });
});

describe("servidor de lectura: guarda antes de get_submission_status", () => {
    it("sin registro: responde «sin entrega» con aviso, sin llamar a get_submission_status ni crear nada", async () => {
        const h = await makeHarness();
        h.fake.withoutSubmission.add(STUDENT_B);
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_B, include_feedback: true });
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(0);
        expect(h.fake.createdSubmissions).toEqual([]);
        expect(r.data).toMatchObject({ status: null, submission_record: false, attempt: null, files: [], comments: null, feedback: null, locked: true, grading_status: null });
        // La prórroga sale de mod_assign_get_user_flags (lectura SQL pura).
        expect(r.data.extension_due?.unix).toBe(NOW_UNIX + 3 * 86400);
        expect(r.warnings.join(" ")).toMatch(/Sin entrega.*ADR-051/);
        expect(r.source.wsfunctions).toEqual(expect.arrayContaining(["mod_assign_list_participants", "mod_assign_get_user_flags"]));
        expect(r.source.wsfunctions).not.toContain("mod_assign_get_submission_status");
    });

    it("con registro (aunque sea new): consulta get_submission_status como antes", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_B });
        expect(r.data).toMatchObject({ status: "new", submission_record: true });
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(1);
        // La guarda relee los participantes en cada consulta (el estado puede cambiar).
        await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A });
        expect(h.fake.callsOf("mod_assign_list_participants").length).toBeGreaterThanOrEqual(2);
    });

    it("archivos de entrega (campus_read_file) de alguien sin registro: no encontrado, sin crear nada", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A });
        const ref = r.data.files[0]!.ref;
        h.fake.withoutSubmission.add(STUDENT_A);
        const before = h.fake.callsOf("mod_assign_get_submission_status").length;
        expect(await codeOf(h.app.service.readFile({ file_ref: ref }))).not.toBe("NO_ERROR");
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(before);
        expect(h.fake.createdSubmissions).toEqual([]);
    });

    it("configuración de la tarea con participant_id: sólo verifica al participante, nunca pide su entrega", async () => {
        const h = await makeHarness();
        h.fake.withoutSubmission.add(STUDENT_C);
        await h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: ASSIGN_CMID, participant_id: STUDENT_C });
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(0);
        expect(h.fake.createdSubmissions).toEqual([]);
    });
});

describe("hasSubmissionRecord: entregas grupales", () => {
    const p = (id: number, status: string, groups: number[]) => ({ id, submissionstatus: status, groups: groups.map((g) => ({ id: g })) }) as never;

    it("individual: decide sólo el registro propio", () => {
        expect(hasSubmissionRecord([p(1, "", [7]), p(2, "submitted", [7])], 1, false)).toBe(false);
        expect(hasSubmissionRecord([p(1, "new", [7])], 1, false)).toBe(true);
        expect(hasSubmissionRecord([p(2, "new", [7])], 1, false)).toBe(false);
    });

    it("grupal: un compañero con registro implica que el grupo ya tiene entrega", () => {
        expect(hasSubmissionRecord([p(1, "", [7]), p(2, "submitted", [7])], 1, true)).toBe(true);
        expect(hasSubmissionRecord([p(1, "", [7]), p(2, "submitted", [8])], 1, true)).toBe(false);
        // Sin grupo: el grupo por defecto son los participantes sin grupo.
        expect(hasSubmissionRecord([p(1, "", []), p(2, "draft", [])], 1, true)).toBe(true);
        expect(hasSubmissionRecord([p(1, "", []), p(2, "draft", [8])], 1, true)).toBe(false);
    });
});

describe("W2: prórroga, bloqueo y comentario sin crear entregas", () => {
    const W2 = ["calendar_event", "grant_extension", "lock_submissions", "submission_comment"];
    const harness = () => makeWriteHarness({ policy: { courses: { [String(COURSE)]: W2 } } });
    const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
    const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
    const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

    it("prórroga y bloqueo de quien no tiene entrega: planifican, verifican y deshacen con get_user_flags", async () => {
        const h = await harness();
        const ext = await exec(h, (await plan(h, "extension", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_B], until: iso(DUE + 86_400) })).plan_id);
        expect(ext.status).toBe("aplicado_verificado");
        const lock = await exec(h, (await plan(h, "submission_lock", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_B], locked: true })).plan_id);
        expect(lock.status).toBe("aplicado_verificado");
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(0);
        expect(h.w2.createdSubmissions).toEqual([]);
    });

    it("comentario a quien no tiene entrega: rechazo en el plan sin llamar a get_submission_status", async () => {
        const h = await harness();
        expect(await codeOf(plan(h, "submission_comment", { assignment_id: W2_ASSIGN, participant_id: STUDENT_B, text: "x" }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(0);
        expect(h.w2.createdSubmissions).toEqual([]);
        // Con entrega, el plan sí lee su estado para obtener el id.
        await plan(h, "submission_comment", { assignment_id: W2_ASSIGN, participant_id: STUDENT_A, text: "x" });
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(1);
    });
});
