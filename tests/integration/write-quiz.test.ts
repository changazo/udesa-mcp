import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { checkWriteAjax } from "../../src/write/functions.js";
import { COURSE, NOW_UNIX, STUDENT_A } from "../fixtures/fake-moodle.js";
import { QUIZ_ID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["quiz_override", "create_quiz"] } } });
    return { h, q: new SyntheticQuizzes(h.fake, h.w2) };
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

describe("override de cuestionario (§8.8)", () => {
    it("alta de un override nuevo, verificado; deshacer lo borra; la contraseña nunca sale", async () => {
        const { h, q } = await harness();
        const close = Math.floor(NOW_UNIX / 60) * 60 + 3 * 86_400;
        const p = await plan(h, "quiz_override", { quiz_id: QUIZ_ID, participant_id: STUDENT_A, close: iso(close), attempts: 2 });
        expect(p.risk).toBe("R3");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(q.overrideFor(STUDENT_A)).toMatchObject({ timeclose: close, attempts: 2, timeopen: null });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(q.overrideFor(STUDENT_A)).toBeUndefined();
        const files = readdirSync(join(h.dir, "plans")).map((f) => readFileSync(join(h.dir, "plans", f), "utf8")).join("\n");
        expect(files + readFileSync(join(h.dir, "write-audit.jsonl"), "utf8")).not.toContain("SECRETO-NO-DEBE-SALIR");
    });

    it("ya existe un override (reemplazo completo borraría la contraseña), no matriculado, sin cambios, cierre antes de apertura: rechazos", async () => {
        const { h, q } = await harness();
        q.overrides.push({ id: 1, quiz: QUIZ_ID, userid: STUDENT_A, timeopen: null, timeclose: null, timelimit: null, attempts: 3, password: "x" });
        expect((await errOf(plan(h, "quiz_override", { quiz_id: QUIZ_ID, participant_id: STUDENT_A, attempts: 4 }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "quiz_override", { quiz_id: QUIZ_ID, participant_id: 999_999, attempts: 4 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        q.overrides.length = 0;
        expect((await errOf(plan(h, "quiz_override", { quiz_id: QUIZ_ID, participant_id: STUDENT_A }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "quiz_override", { quiz_id: QUIZ_ID, participant_id: STUDENT_A, open: iso(NOW_UNIX + 7200), close: iso(NOW_UNIX + 3600) }))).code).toBe("WRITE_NOT_ALLOWED");
    });

    it("descarte silencioso (ids vacío) → rechazado, nunca «ok»", async () => {
        const { h, q } = await harness();
        q.dropSilently = true;
        expect((await exec(h, (await plan(h, "quiz_override", { quiz_id: QUIZ_ID, participant_id: STUDENT_A, attempts: 2 })).plan_id)).status).toBe("rechazado_por_moodle");
    });

    it("allowlist: un override por llamada, sin id/groupid/password; borrar de a uno", () => {
        const code = (m: string, a: Record<string, unknown>) => {
            try {
                checkWriteAjax(m, a);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        expect(code("mod_quiz_save_overrides", { data: { quizid: 1, overrides: [{ userid: 2, attempts: 1 }] } })).toBe("OK");
        expect(code("mod_quiz_save_overrides", { data: { quizid: 1, overrides: [{ userid: 2, attempts: 1, password: "x" }] } })).toBe("POLICY_DENIED");
        expect(code("mod_quiz_save_overrides", { data: { quizid: 1, overrides: [{ id: 5, userid: 2, attempts: 1 }] } })).toBe("POLICY_DENIED");
        expect(code("mod_quiz_save_overrides", { data: { quizid: 1, overrides: [{ groupid: 2, attempts: 1 }] } })).toBe("OK"); // grupos desde ADR-073
        expect(code("mod_quiz_save_overrides", { data: { quizid: 1, overrides: [{ userid: 2, attempts: 1 }, { userid: 3, attempts: 1 }] } })).toBe("POLICY_DENIED");
        expect(code("mod_quiz_delete_overrides", { data: { quizid: 1, ids: [5, 6] } })).toBe("POLICY_DENIED");
        expect(code("mod_quiz_reopen_attempt", { attemptid: 1 })).toBe("POLICY_DENIED");
    });
});

describe("crear un cuestionario (W6 adelantada)", () => {
    it("oculto, vacío, con fechas, límite (casilla enabled) e intentos; verificado; deshacer lo borra", async () => {
        const { h, q } = await harness();
        const open = Math.floor(NOW_UNIX / 60) * 60 + 86_400;
        const p = await plan(h, "create_quiz", { name: "Parcialito", section: 1, open: iso(open), close: iso(open + 7 * 86_400), time_limit_minutes: 45, attempts: 1 });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(q.posts.at(-1)).toMatchObject({ "timelimit[enabled]": "1", "timelimit[number]": "45", visible: "0" });
        expect(q.posts.at(-1)).not.toHaveProperty("coursecontentnotification");
        const created = q.quizzes.find((x) => x.name === "Parcialito")!;
        expect(created).toMatchObject({ timeopen: open, timelimit: 2700, attempts: 1 });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
    });

    it("sin límite de tiempo, la casilla se omite", async () => {
        const { h, q } = await harness();
        await exec(h, (await plan(h, "create_quiz", { name: "Sin límite", section: 1 })).plan_id);
        expect(q.posts.at(-1)).not.toHaveProperty("timelimit[enabled]");
        expect(q.posts.at(-1)).not.toHaveProperty("timeopen[enabled]");
    });
});

describe("override de cuestionario para un grupo (ADR-073)", () => {
    it("groupid en lugar de userid; verificado; deshacer; allowlist: nunca los dos", async () => {
        const { h, q } = await harness();
        h.fake.overrides.set("core_group_get_course_groups", () => [{ id: 12, courseid: COURSE, name: "Comisión A" }]);
        const r = await exec(h, (await plan(h, "quiz_override", { quiz_id: QUIZ_ID, group_id: 12, attempts: 3 })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(q.overrides[0]).toMatchObject({ groupid: 12, userid: null, attempts: 3 });
        expect((await errOf(plan(h, "quiz_override", { quiz_id: QUIZ_ID, group_id: 12, attempts: 4 }))).code).toBe("WRITE_NOT_ALLOWED");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(q.overrides).toHaveLength(0);
        expect(() => checkWriteAjax("mod_quiz_save_overrides", { data: { quizid: 1, overrides: [{ userid: 2, groupid: 3, attempts: 1 }] } })).toThrow(CampusError);
        expect(() => checkWriteAjax("mod_quiz_save_overrides", { data: { quizid: 1, overrides: [{ groupid: 3, attempts: 1 }] } })).not.toThrow();
    });
});

describe("borrar una excepción existente (ADR-084)", () => {
    it("borra un override que no creó el MCP; uno inexistente se rechaza", async () => {
        const { h, q } = await harness();
        const add = await exec(h, (await plan(h, "quiz_override", { quiz_id: QUIZ_ID, participant_id: STUDENT_A, attempts: 2 })).plan_id);
        const id = add.moodle_ids.override_id![0]!;
        const r = await exec(h, (await plan(h, "quiz_override_delete", { quiz_id: QUIZ_ID, override_id: id })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(q.overrides.some((o) => o.id === id)).toBe(false);
        await expect(plan(h, "quiz_override_delete", { quiz_id: QUIZ_ID, override_id: 424242 })).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
    });
});
