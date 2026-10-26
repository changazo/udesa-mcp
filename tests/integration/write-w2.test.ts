import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { resultError } from "../../src/write/engine.js";
import { checkWriteRest } from "../../src/write/functions.js";
import { parseLocalDateTime } from "../../src/write/intents/w2.js";
import { COURSE, NOW_UNIX, SITE, STUDENT_A, STUDENT_B, STUDENT_C } from "../fixtures/fake-moodle.js";
import { CUTOFF, DUE, W2_ASSIGN, W2_GROUP, W2_SUBMISSION_A } from "../fixtures/fake-w2.js";
import { connectWrite, makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const W2 = ["calendar_event", "grant_extension", "lock_submissions", "submission_comment"];
const harness = (policy: Record<string, unknown> = {}) => makeWriteHarness({ policy: { courses: { [String(COURSE)]: W2 }, ...policy } });
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
const calls = (h: WriteHarness, fn: string) => h.fake.callsOf(fn);
const TZ = "America/Argentina/Buenos_Aires";
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

async function undoAll(h: WriteHarness, actionId: string) {
    const u = await h.app.engine.planUndo(actionId, "test");
    if (!u.undoable) throw new Error(`no se puede deshacer: ${u.reason}`);
    return { plan: u.plan, result: await exec(h, u.plan.plan_id) };
}

describe("W2 · calendario (§8.2)", () => {
    it("hora local del perfil → Unix; ISO con zona; formatos ambiguos rechazados", () => {
        expect(parseLocalDateTime("2026-11-02T18:30", TZ)).toBe(Date.parse("2026-11-02T18:30:00-03:00") / 1000);
        expect(parseLocalDateTime("2026-11-02T21:30:00Z", TZ)).toBe(Date.parse("2026-11-02T21:30:00Z") / 1000);
        expect(parseLocalDateTime("2/11/2026 18:30", TZ)).toBeNull();
    });

    it("evento semanal del curso: una llamada con repeats, verificación de la serie y deshacer de a uno (nunca repeat=1)", async () => {
        const h = await harness();
        const start = NOW_UNIX + 86_400;
        const p = await plan(h, "calendar_event", { name: "Clase de consulta", description: "Traer **dudas**", start: iso(start), duration_minutes: 90, occurrences: 3 });
        expect(p.risk).toBe("R2");
        expect(p.items).toHaveLength(1);
        expect(p.items[0]!.expected).toMatchObject({ occurrences: 3, eventtype: "course", groupid: 0, timeduration: 5400 });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(calls(h, "core_calendar_create_calendar_events")[0]!.params).toMatchObject({ "events[0][repeats]": "3", "events[0][eventtype]": "course", "events[0][courseid]": String(COURSE), "events[0][groupid]": "0" });
        expect(h.w2.events.size).toBe(3);
        const u = await undoAll(h, r.action_id);
        expect(u.plan.items).toHaveLength(3);
        expect(u.result.status).toBe("aplicado_verificado");
        expect(h.w2.events.size).toBe(0);
        for (const c of calls(h, "core_calendar_delete_calendar_events")) expect(c.params["events[0][repeat]"]).toBe("0");
    });

    it("evento de grupo con un grupo del curso; grupo ajeno, tipo no permitido o antes del inicio del curso se rechazan en el plan", async () => {
        const h = await harness();
        const ok = await plan(h, "calendar_event", { name: "Comisión A", start: iso(NOW_UNIX + 3600), group_id: W2_GROUP });
        expect(ok.items[0]!.expected).toMatchObject({ eventtype: "group", groupid: W2_GROUP });
        expect((await errOf(plan(h, "calendar_event", { name: "x", start: iso(NOW_UNIX + 3600), group_id: 999 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "calendar_event", { name: "x", start: iso(NOW_UNIX - 200 * 86_400) }))).code).toBe("WRITE_NOT_ALLOWED");
        h.w2.allowedTypes = ["user"];
        expect((await errOf(plan(h, "calendar_event", { name: "x", start: iso(NOW_UNIX + 3600) }))).code).toBe("MOODLE_PERMISSION_DENIED");
        expect(calls(h, "core_calendar_create_calendar_events")).toHaveLength(0);
    });

    it("el aviso nopermissions sin evento creado es rechazado_por_moodle, nunca «ok»", async () => {
        const h = await harness();
        const p = await plan(h, "calendar_event", { name: "x", start: iso(NOW_UNIX + 3600) });
        h.w2.calendarDenied = true;
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("rechazado_por_moodle");
        expect(resultError(r)?.code).toBe("MOODLE_REJECTED");
    });

    it("la allowlist sólo admite course/group, un evento por llamada, ≤ 20 repeticiones y borrar sin serie", () => {
        const base: [string, string][] = [
            ["events[0][name]", "x"],
            ["events[0][description]", ""],
            ["events[0][format]", "1"],
            ["events[0][courseid]", "1"],
            ["events[0][groupid]", "0"],
            ["events[0][repeats]", "0"],
            ["events[0][eventtype]", "course"],
            ["events[0][timestart]", "1"],
            ["events[0][timeduration]", "0"],
            ["events[0][visible]", "1"],
        ];
        const code = (flat: [string, string][], fn = "core_calendar_create_calendar_events") => {
            try {
                checkWriteRest(fn, flat, SITE);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        expect(code(base)).toBe("OK");
        expect(code(base.map(([k, v]) => [k, k.endsWith("[eventtype]") ? "site" : v]))).toBe("POLICY_DENIED");
        expect(code(base.map(([k, v]) => [k, k.endsWith("[repeats]") ? "21" : v]))).toBe("POLICY_DENIED");
        expect(code([...base, ["events[1][name]", "y"]])).toBe("POLICY_DENIED");
        expect(code([["events[0][eventid]", "5"], ["events[0][repeat]", "1"]], "core_calendar_delete_calendar_events")).toBe("POLICY_DENIED");
    });
});

describe("W2 · prórrogas y bloqueo (§8.5)", () => {
    it("prórroga: una llamada por participante, verificada; deshacer vuelve a la anterior", async () => {
        const h = await harness();
        const until = DUE + 2 * 86_400;
        const p = await plan(h, "extension", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_A, STUDENT_B], until: iso(until) });
        expect(p.items).toHaveLength(2);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(calls(h, "mod_assign_save_user_extensions").map((c) => [c.params["userids[0]"], c.params["dates[0]"]])).toEqual([
            [String(STUDENT_A), String(until)],
            [String(STUDENT_B), String(until)],
        ]);
        const u = await undoAll(h, r.action_id);
        expect(u.result.status).toBe("aplicado_verificado");
        expect(h.w2.extensions.size).toBe(0);
    });

    it("antes del vencimiento o de un no participante: rechazo en el plan; después del corte, advertencia", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "extension", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_A], until: iso(DUE - 3600) }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "extension", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_C], until: iso(DUE + 3600) }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "extension", { assignment_id: 999, participant_ids: [STUDENT_A], until: iso(DUE + 3600) }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        const late = await plan(h, "extension", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_A], until: iso(CUTOFF + 86_400) });
        expect(late.warnings.join(" ")).toMatch(/supera la fecha de corte/);
        expect(calls(h, "mod_assign_save_user_extensions")).toHaveLength(0);
    });

    it("el aviso couldnotgrantextensions (sin cambio) es rechazado_por_moodle", async () => {
        const h = await harness();
        const p = await plan(h, "extension", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_A], until: iso(DUE + 3600) });
        h.fake.overrides.set("mod_assign_save_user_extensions", () => [{ item: "assign", warningcode: "couldnotgrantextensions" }]);
        expect((await exec(h, p.plan_id)).status).toBe("rechazado_por_moodle");
    });

    it("bloquear entregas: verificado por relectura; deshacer desbloquea; ya bloqueadas → nada que escribir", async () => {
        const h = await harness();
        const r = await exec(h, (await plan(h, "submission_lock", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_A], locked: true })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.w2.locked.has(STUDENT_A)).toBe(true);
        expect((await errOf(plan(h, "submission_lock", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_A], locked: true }))).code).toBe("WRITE_NOT_ALLOWED");
        await undoAll(h, r.action_id);
        expect(h.w2.locked.has(STUDENT_A)).toBe(false);
        expect(calls(h, "mod_assign_unlock_submissions")).toHaveLength(1);
    });

    it("Moodle «acepta» el bloqueo pero no lo aplica: sin_efecto", async () => {
        const h = await harness();
        const p = await plan(h, "submission_lock", { assignment_id: W2_ASSIGN, participant_ids: [STUDENT_B], locked: true });
        h.fake.overrides.set("mod_assign_lock_submissions", () => []);
        expect((await exec(h, p.plan_id)).status).toBe("sin_efecto");
    });
});

describe("W2 · comentario de entrega (§8.4)", () => {
    it("componente y área fijos; verificado como propio; deshacer lo borra", async () => {
        const h = await harness();
        const p = await plan(h, "submission_comment", { assignment_id: W2_ASSIGN, participant_id: STUDENT_A, text: "Revisá el punto 2." });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(calls(h, "core_comment_add_comments")[0]!.params).toMatchObject({
            "comments[0][component]": "assignsubmission_comments",
            "comments[0][area]": "submission_comments",
            "comments[0][itemid]": String(W2_SUBMISSION_A),
            "comments[0][contextlevel]": "module",
        });
        await undoAll(h, r.action_id);
        expect(h.w2.comments.size).toBe(0);
    });

    it("sin entrega no hay dónde comentar; el área «upgrade» (firma como el estudiante) nunca pasa la allowlist", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "submission_comment", { assignment_id: W2_ASSIGN, participant_id: STUDENT_B, text: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        const flat: [string, string][] = [
            ["comments[0][contextlevel]", "module"],
            ["comments[0][instanceid]", "1"],
            ["comments[0][component]", "assignsubmission_comments"],
            ["comments[0][content]", "x"],
            ["comments[0][itemid]", "1"],
            ["comments[0][area]", "submission_comments_upgrade"],
        ];
        expect(() => checkWriteRest("core_comment_add_comments", flat, SITE)).toThrow(/valor inválido para comments\[0\]\[area\]/);
    });

    it("comentarios deshabilitados en el sitio: rechazado_por_moodle con el errorcode", async () => {
        const h = await harness();
        const p = await plan(h, "submission_comment", { assignment_id: W2_ASSIGN, participant_id: STUDENT_A, text: "x" });
        h.w2.commentsEnabled = false;
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("rechazado_por_moodle");
        expect(r.items[0]!.error?.moodle_errorcode).toBe("commentsnotenabled");
    });
});

describe("W2 · servidor MCP", () => {
    it("expone las intenciones de W2; de mensajes, sólo send_message (ADR-120)", async () => {
        const client = await connectWrite(await harness());
        const names = (await client.listTools()).tools.map((t) => t.name);
        for (const t of ["campus_plan_calendar_event", "campus_plan_extension", "campus_plan_submission_lock", "campus_plan_submission_comment"]) expect(names).toContain(t);
        expect(names.filter((n) => /message|mensaje/.test(n))).toEqual(["campus_plan_send_message"]);
    });
});
