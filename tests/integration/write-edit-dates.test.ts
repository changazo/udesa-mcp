import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, NOW_UNIX } from "../fixtures/fake-moodle.js";
import { DUE, W2_ASSIGN_CMID } from "../fixtures/fake-w2.js";
import { QUIZ_CMID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { SyntheticDateEdits } from "../fixtures/fake-edit-dates.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_activity"] } } });
    const q = new SyntheticQuizzes(h.fake, h.w2);
    return { h, q, e: new SyntheticDateEdits(h.fake, h.w2, q) };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("edit_dates", { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
/** AAAA-MM-DDTHH:MM en -03:00 para un Unix. */
const local = (unix: number) => new Date(unix * 1000 - 3 * 3600_000).toISOString().slice(0, 16);
const minute = (unix: number) => Math.floor(unix / 60) * 60;

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("cambiar fechas de una tarea o un cuestionario (§8.8, ADR-065)", () => {
    it("tarea: mueve el vencimiento y deshabilita la fecha límite; el resto del formulario vuelve intacto; deshacer restaura", async () => {
        const { h, e } = await harness();
        const a = h.w2.assignments[0]!;
        const before = { ...a };
        const newDue = minute(DUE + 2 * 86_400);
        const p = await plan(h, { course_module_id: W2_ASSIGN_CMID, due: local(newDue), cutoff: null });
        expect(p.risk).toBe("R2");
        expect((p.payload_preview as { changes: { field: string }[] }).changes.map((c) => c.field)).toEqual(["duedate", "cutoffdate"]);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(a.duedate).toBe(newDue);
        expect(a.cutoffdate).toBe(0);
        const post = e.posts.at(-1)!;
        expect(post).toMatchObject({ sendnotifications: "1", secreto_conservado: "sí", submitbutton2: "1" });
        expect(post).not.toHaveProperty("cutoffdate[enabled]");
        expect(post).not.toHaveProperty("coursecontentnotification");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(a.duedate).toBe(minute(before.duedate));
        expect(a.cutoffdate).toBe(minute(before.cutoffdate));
    });

    it("cuestionario: apertura, cierre, límite de tiempo e intentos; verificado; deshacer", async () => {
        const { h, q } = await harness();
        const open = minute(NOW_UNIX + 86_400);
        const p = await plan(h, { course_module_id: QUIZ_CMID, open: local(open), close: local(open + 7200), time_limit_minutes: 45, attempts: 2 });
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(q.quizzes[0]).toMatchObject({ timeopen: open, timeclose: open + 7200, timelimit: 2700, attempts: 2 });
        const u = await h.app.engine.planUndo((await h.app.engine.listActions()).actions.at(-1)!.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(q.quizzes[0]).toMatchObject({ timeopen: 0, timeclose: 0, timelimit: 0, attempts: 0 });
    });

    it("rechazos: campo de otro tipo, sin cambios, orden de fechas, fecha inválida, actividad ajena", async () => {
        const { h } = await harness();
        const code = async (i: Record<string, unknown>) => (await errOf(plan(h, i))).code;
        expect(await code({ course_module_id: W2_ASSIGN_CMID, close: local(DUE) })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ course_module_id: QUIZ_CMID, due: local(DUE) })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ course_module_id: W2_ASSIGN_CMID })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ course_module_id: W2_ASSIGN_CMID, cutoff: local(DUE - 86_400) })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ course_module_id: QUIZ_CMID, open: local(NOW_UNIX + 7200), close: local(NOW_UNIX + 3600) })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ course_module_id: W2_ASSIGN_CMID, due: "mañana" })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ course_module_id: 4242, due: local(DUE) })).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("Moodle ignora el cambio → sin_efecto, nunca «ok»", async () => {
        const { h, e } = await harness();
        e.ignoreDue = true;
        expect((await exec(h, (await plan(h, { course_module_id: W2_ASSIGN_CMID, due: local(DUE + 86_400) })).plan_id)).status).toBe("sin_efecto");
    });
});
