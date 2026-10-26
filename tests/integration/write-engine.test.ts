import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { TerminalApprovalConfirmer } from "../../src/write/confirm.js";
import { resultError } from "../../src/write/engine.js";
import type { ExecutionResult, StoredPlan } from "../../src/write/plan.js";
import { COURSE, INJECTION, OTHER_COURSE, VALID_TOKEN } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

type Change = { marker_id: number; value: string };
const plan = (h: WriteHarness, changes: Change[], extra: Record<string, unknown> = {}, course = COURSE) =>
    h.app.engine.plan("marcador_sintetico", { course_id: course, changes, ...extra }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
const writes = (h: WriteHarness) => h.fake.callsOf("local_sintetico_set_marker").length;
const value = (h: WriteHarness, id: number) => h.markers.markers.get(id)!.value;

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

/** Ejecuta y devuelve el resultado; si el motor lo convierte en error tipado, también lo devuelve. */
async function run(h: WriteHarness, changes: Change[], extra: Record<string, unknown> = {}) {
    const p = await plan(h, changes, extra);
    const result = await exec(h, p.plan_id);
    return { plan: p, result, error: resultError(result) };
}

describe("escrituras W0 · política (§12)", () => {
    it("capacidad no habilitada para el curso: WRITE_NOT_ALLOWED antes de leer o escribir", async () => {
        const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: [] } } });
        const e = await errOf(plan(h, [{ marker_id: 1, value: "x" }]));
        expect(e.code).toBe("WRITE_NOT_ALLOWED");
        expect(h.fake.callsOf("local_sintetico_get_markers")).toHaveLength(0);
        expect(writes(h)).toBe(0);
    });

    it("curso fuera del alcance de lectura: rechazo sin red; recurso de otro curso: RESOURCE_OUT_OF_SCOPE", async () => {
        const h = await makeWriteHarness();
        expect((await errOf(plan(h, [{ marker_id: 1, value: "x" }], {}, OTHER_COURSE))).code).toBe("POLICY_DENIED");
        expect((await errOf(plan(h, [{ marker_id: 99, value: "x" }]))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(writes(h)).toBe(0);
    });

    it("el transporte rechaza antes de la red funciones fuera de la allowlist, bloqueadas o con parámetros no admitidos", async () => {
        const h = await makeWriteHarness();
        const before = h.fake.calls.length;
        const t = h.app.transport;
        for (const [fn, params] of [
            ["mod_forum_add_discussion", { forumid: 1, subject: "x", message: "y" }],
            ["core_enrol_unenrol_user_enrolment", { ueid: 1 }],
            ["mod_assign_reveal_identities", { assignmentid: 1 }],
            ["tool_mobile_call_external_functions", { requests: [{ function: "x" }] }],
            ["core_webservice_get_site_info", {}],
            ["local_sintetico_set_marker", { courseid: COURSE, markerid: 1, value: "x", extra: 1 }],
            ["local_sintetico_set_marker", { courseid: COURSE, markerid: 1, value: "x", wstoken: "y" }],
            ["local_sintetico_set_marker", { courseid: COURSE, markerid: 1, value: "a\u0007b" }],
        ] as const) {
            expect((await errOf(t.call(fn, params as never))).code, fn).toBe("POLICY_DENIED");
        }
        expect(h.fake.calls.length).toBe(before);
        expect(t.writesSent).toBe(0);
    });
});

describe("escrituras W0 · confirmación (§12)", () => {
    it("R2 rechazado por el humano: CONFIRMATION_REQUIRED, nada escrito, y el plan queda rechazado sin volver a preguntar", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "nuevo" }]);
        expect(p.risk).toBe("R2");
        expect(p.confirmation.channel).toBe("fuera_de_banda");
        h.confirmer.decisions = ["rejected"];
        expect((await errOf(exec(h, p.plan_id))).code).toBe("CONFIRMATION_REQUIRED");
        expect((await errOf(exec(h, p.plan_id))).code).toBe("CONFIRMATION_REQUIRED");
        expect(h.confirmer.views).toHaveLength(1);
        expect(writes(h)).toBe(0);
        expect((await h.app.engine.getPlan(p.plan_id)).state.status).toBe("rechazado");
    });

    it("diálogo vencido o sin canal: CONFIRMATION_REQUIRED con la instrucción de la terminal; el plan sigue disponible", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "nuevo" }]);
        h.confirmer.decisions = ["timeout", "unavailable"];
        for (let i = 0; i < 2; i++) {
            const e = await errOf(exec(h, p.plan_id));
            expect(e.code).toBe("CONFIRMATION_REQUIRED");
            expect(e.humanAction).toContain(`write approve ${p.plan_id}`);
        }
        expect(writes(h)).toBe(0);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(r.confirmation.channel).toBe("prueba");
    });

    it("la vista de confirmación muestra el contenido exacto, el código y los valores por defecto", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "Texto exacto ✓" }]);
        await exec(h, p.plan_id);
        const v = h.confirmer.views[0]!;
        expect(v.code).toBe(p.confirmation_code);
        expect(v.plan_hash).toBe(p.plan_hash);
        expect(v.text).toContain("Texto exacto ✓");
        expect(v.text).toContain("visible_to_students");
        expect(v.text).toContain("DESHACER: exacto");
    });

    it("R1 (no visible) se confirma en el cliente; con require_out_of_band_from_risk=R1 también va fuera de banda", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "x" }], { visible_to_students: false });
        expect(p.risk).toBe("R1");
        expect(p.confirmation.channel).toBe("cliente");
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(h.confirmer.views).toHaveLength(0);

        const strict = await makeWriteHarness({ policy: { require_out_of_band_from_risk: "R1" } });
        const q = await plan(strict, [{ marker_id: 1, value: "x" }], { visible_to_students: false });
        expect(q.confirmation.channel).toBe("fuera_de_banda");
        await exec(strict, q.plan_id);
        expect(strict.confirmer.views).toHaveLength(1);
    });

    it("require_out_of_band_from_risk=nunca (ADR-061): un R3 de curso real se ejecuta sin canal fuera de banda y el plan lo declara", async () => {
        const h = await makeWriteHarness({ policy: { require_out_of_band_from_risk: "nunca", sandbox_course_ids: [] } });
        // R3 por más de 5 ítems en un R2 (un curso real ya no escala, ADR-126).
        const p = await plan(h, [1, 2, 4, 5, 6, 7].map((id) => ({ marker_id: id, value: "x" })));
        expect(p.risk).toBe("R3");
        expect(p.confirmation.channel).toBe("cliente");
        expect(p.risk_reasons.join(" ")).toContain("ADR-061");
        // ADR-118: sin canal fuera de banda, un R3 necesita la aprobación del usuario (palabras o elicitación).
        expect(p.human_in_the_loop?.present_to_user).toMatch(/^Escritura R3 en el curso[\s\S]*¿Lo aprobás\?$/);
        const e = await errOf(exec(h, p.plan_id));
        expect(e.code).toBe("CONFIRMATION_REQUIRED");
        expect(writes(h)).toBe(0);
        const r = await h.app.engine.execute(p.plan_id, h.confirmer, "test", { userWords: "sí, dale" });
        expect(r.status).toBe("aplicado_verificado");
        expect(r.confirmation.channel).toBe("usuario_en_chat");
        expect(h.confirmer.views).toHaveLength(0);
    });

    it("humano en el circuito (ADR-118): la elicitación aprueba o rechaza; si falla, valen las palabras del usuario", async () => {
        const h = await makeWriteHarness({ policy: { require_out_of_band_from_risk: "nunca", sandbox_course_ids: [] } });
        const elicit = (answer: "approved" | "rejected" | "unavailable") => ({ channel: "elicitacion", confirm: async () => ({ decision: answer }) });
        const a = await plan(h, [1, 2, 4, 5, 6, 7].map((id) => ({ marker_id: id, value: "a" })));
        expect((await errOf(h.app.engine.execute(a.plan_id, h.confirmer, "test", { elicit: elicit("rejected"), userWords: "sí" }))).code).toBe("CONFIRMATION_REQUIRED");
        expect((await h.app.engine.getPlan(a.plan_id)).state.status).toBe("rechazado");
        expect(writes(h)).toBe(0);
        const b = await plan(h, [1, 2, 4, 5, 6, 7].map((id) => ({ marker_id: id, value: "b" })));
        expect((await errOf(h.app.engine.execute(b.plan_id, h.confirmer, "test", { elicit: elicit("unavailable") }))).code).toBe("CONFIRMATION_REQUIRED");
        expect((await h.app.engine.execute(b.plan_id, h.confirmer, "test", { elicit: elicit("unavailable"), userWords: "aprobado" })).confirmation.channel).toBe("usuario_en_chat");
        const c = await plan(h, [1, 2, 4, 5, 6, 7].map((id) => ({ marker_id: id, value: "c" })));
        expect((await h.app.engine.execute(c.plan_id, h.confirmer, "test", { elicit: elicit("approved") })).confirmation.channel).toBe("elicitacion");
        // Un R2 no lo necesita; con human_in_the_loop_from_risk=nunca, tampoco un R3.
        const off = await makeWriteHarness({ policy: { require_out_of_band_from_risk: "nunca", sandbox_course_ids: [], human_in_the_loop_from_risk: "nunca" } });
        const d = await plan(off, [1, 2, 4, 5, 6, 7].map((id) => ({ marker_id: id, value: "d" })));
        expect(d.human_in_the_loop).toBeUndefined();
        expect((await exec(off, d.plan_id)).confirmation.channel).toBe("cliente");
    });

    it("una aprobación de otro plan (otro hash) no sirve", async () => {
        const h = await makeWriteHarness();
        const a = await plan(h, [{ marker_id: 1, value: "a" }]);
        const b = await plan(h, [{ marker_id: 2, value: "b" }]);
        const e = await errOf(h.app.engine.execute(b.plan_id, new TerminalApprovalConfirmer(a.plan_hash), "test"));
        expect(e.code).toBe("CONFIRMATION_REQUIRED");
        expect(writes(h)).toBe(0);
        const ok = await h.app.engine.execute(b.plan_id, new TerminalApprovalConfirmer(b.plan_hash), "test");
        expect(ok.confirmation.channel).toBe("terminal");
    });

    it("un plan alterado en disco (antes o durante la confirmación) no se ejecuta", async () => {
        const h = await makeWriteHarness();
        const tamper = (planId: string) => {
            const file = join(h.dir, "plans", `${planId}.json`);
            const sp = JSON.parse(readFileSync(file, "utf8")) as StoredPlan;
            sp.plan.items[0]!.call.params.value = "valor inyectado";
            writeFileSync(file, JSON.stringify(sp));
        };
        const p = await plan(h, [{ marker_id: 1, value: "legítimo" }]);
        tamper(p.plan_id);
        expect((await errOf(exec(h, p.plan_id))).code).toBe("POLICY_DENIED");

        const q = await plan(h, [{ marker_id: 2, value: "legítimo" }]);
        h.confirmer.during = () => tamper(q.plan_id);
        expect((await errOf(exec(h, q.plan_id))).code).toBe("POLICY_DENIED");
        expect(writes(h)).toBe(0);
    });

    it("plan vencido (15 min): PLAN_EXPIRED sin pedir confirmación", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "x" }]);
        h.clock.ms += 15 * 60_000 + 1000;
        expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_EXPIRED");
        expect(h.confirmer.views).toHaveLength(0);
        expect(writes(h)).toBe(0);
    });

    it("uso único: la segunda ejecución devuelve el resultado anterior sin escribir; dos simultáneas escriben una vez", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "x" }]);
        const first = await exec(h, p.plan_id);
        const e = await errOf(exec(h, p.plan_id));
        expect(e.code).toBe("PLAN_ALREADY_EXECUTED");
        expect((e.details?.previous_result as ExecutionResult).action_id).toBe(first.action_id);
        expect(writes(h)).toBe(1);

        const q = await plan(h, [{ marker_id: 2, value: "y" }]);
        const both = await Promise.allSettled([exec(h, q.plan_id), exec(h, q.plan_id)]);
        expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as CampusError).code).toBe("PLAN_ALREADY_EXECUTED");
        expect(writes(h)).toBe(2);
    });
});

describe("escrituras W0 · concurrencia (§12)", () => {
    it("un cambio en el Campus entre el plan y la ejecución da PLAN_STALE y no escribe", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "mío" }]);
        h.markers.touch(1, "de otra persona");
        const e = await errOf(exec(h, p.plan_id));
        expect(e.code).toBe("PLAN_STALE");
        expect(JSON.stringify(e.details)).toContain("marker:1");
        expect(writes(h)).toBe(0);
        expect(value(h, 1)).toBe("de otra persona");
        expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
    });

    it("también si el cambio ocurre mientras el humano mira el diálogo", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "mío" }]);
        h.confirmer.during = () => h.markers.touch(1, "cambio durante la confirmación");
        expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
        expect(writes(h)).toBe(0);
    });
});

describe("escrituras W0 · fallas silenciosas (§12)", () => {
    it.each([
        ["noop_null", "sin_efecto", "VERIFICATION_FAILED"],
        ["noop_status_true", "sin_efecto", "VERIFICATION_FAILED"],
        ["warnings", "rechazado_por_moodle", "MOODLE_REJECTED"],
        ["minus_one", "rechazado_por_moodle", "MOODLE_REJECTED"],
        ["status_false", "rechazado_por_moodle", "MOODLE_REJECTED"],
        ["exception", "rechazado_por_moodle", "MOODLE_REJECTED"],
    ] as const)("%s → %s, nunca «ok»", async (mode, status, code) => {
        const h = await makeWriteHarness();
        h.markers.next(mode);
        const { result, error } = await run(h, [{ marker_id: 1, value: "nuevo" }]);
        expect(result.status).toBe(status);
        expect(result.verification.matched).toBe(false);
        expect(error?.code).toBe(code);
        expect(writes(h)).toBe(1);
    });

    it("null con el cambio aplicado sí es éxito, porque lo decide la relectura", async () => {
        const h = await makeWriteHarness();
        h.markers.next("ok_null");
        const { result, error } = await run(h, [{ marker_id: 1, value: "nuevo" }]);
        expect(result.status).toBe("aplicado_verificado");
        expect(error).toBeNull();
    });

    it("descarte silencioso (valor recortado): aplicado_con_diferencias con campo, esperado y obtenido", async () => {
        const h = await makeWriteHarness();
        h.markers.next("truncate");
        const { result } = await run(h, [{ marker_id: 1, value: "valor largo" }]);
        expect(result.status).toBe("aplicado_con_diferencias");
        expect(result.differences).toEqual([{ item_id: "i1", field: "value", expected: "valor largo", observed: "valor" }]);
    });

    it("Moodle rechaza pero guardó una parte: PARTIAL_APPLIED, con aviso y deshacer disponible", async () => {
        const h = await makeWriteHarness();
        h.markers.next("exception_after_partial");
        const { result, error } = await run(h, [{ marker_id: 1, value: "abcdef" }]);
        expect(result.status).toBe("rechazado_por_moodle");
        expect(result.partial).toBe(true);
        expect(error?.code).toBe("PARTIAL_APPLIED");
        expect(result.warnings.join(" ")).toMatch(/rechazó la operación pero la relectura muestra cambios/);
        expect((await h.app.engine.planUndo(result.action_id, "test")).undoable).toBe(true);
    });

    it("si la relectura falla, el resultado es aplicado_desconocido (VERIFICATION_FAILED), no éxito", async () => {
        const h = await makeWriteHarness();
        h.markers.afterWrite = () => (h.markers.readFails = true);
        const { result, error } = await run(h, [{ marker_id: 1, value: "nuevo" }]);
        expect(result.status).toBe("aplicado_desconocido");
        expect(error?.code).toBe("VERIFICATION_FAILED");
        expect(result.items[0]!.verification.note).toMatch(/No se pudo releer/);
    });
});

describe("escrituras W0 · red (§12)", () => {
    it.each(["network_after", "http500_after", "html_after"] as const)("%s: no reenvía; reconcilia por lectura y verifica", async (mode) => {
        const h = await makeWriteHarness();
        h.markers.next(mode);
        const { result, error } = await run(h, [{ marker_id: 1, value: "nuevo" }]);
        expect(writes(h)).toBe(1);
        expect(h.app.transport.writesSent).toBe(1);
        expect(result.status).toBe("aplicado_verificado");
        expect(error).toBeNull();
        expect(result.items[0]!.verification.note).toMatch(/Reconciliación por lectura: presente\. No se reenvió/);
    });

    it("corte antes de llegar: aplicado_desconocido con instrucciones, sin reenvío", async () => {
        const h = await makeWriteHarness();
        h.markers.next("network_before");
        const { result, error } = await run(h, [{ marker_id: 1, value: "nuevo" }]);
        expect(h.app.transport.writesSent).toBe(1);
        expect(writes(h)).toBe(0);
        expect(result.status).toBe("aplicado_desconocido");
        expect(error?.code).toBe("VERIFICATION_FAILED");
        expect(error?.message).toMatch(/NO reintentes/);
        expect(value(h, 1)).toBe("inicial-a");
    });

    it("token rechazado antes de escribir: AUTH_REQUIRED y el plan sigue pendiente", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "x" }]);
        h.fake.validTokens.delete(VALID_TOKEN);
        expect((await errOf(exec(h, p.plan_id))).code).toBe("AUTH_REQUIRED");
        expect(writes(h)).toBe(0);
        expect((await h.app.engine.getPlan(p.plan_id)).state.status).toBe("pendiente");
    });
});

describe("escrituras W0 · lotes (§12)", () => {
    it("una llamada por ítem, en serie", async () => {
        const h = await makeWriteHarness();
        const { result } = await run(h, [
            { marker_id: 1, value: "a" },
            { marker_id: 2, value: "b" },
            { marker_id: 4, value: "c" },
        ]);
        expect(result.status).toBe("aplicado_verificado");
        const calls = h.fake.callsOf("local_sintetico_set_marker");
        expect(calls.map((c) => c.params.markerid)).toEqual(["1", "2", "4"]);
        for (const c of calls) expect(Object.keys(c.params).sort()).toEqual(["courseid", "markerid", "value"]);
    });

    it("una falla a mitad de camino da PARTIAL_APPLIED con detalle y no ejecuta el resto", async () => {
        const h = await makeWriteHarness();
        h.markers.next("ok", "exception");
        const { result, error } = await run(h, [
            { marker_id: 1, value: "a" },
            { marker_id: 2, value: "b" },
            { marker_id: 4, value: "c" },
        ]);
        expect(error?.code).toBe("PARTIAL_APPLIED");
        expect(result.items.map((i) => i.outcome)).toEqual(["verificado", "rechazado", "no_ejecutado"]);
        expect(writes(h)).toBe(2);
        expect(value(h, 4)).toBe("v4");
    });

    it("límite de ítems por plan y escaladas de riesgo calculadas por el servidor", async () => {
        const small = await makeWriteHarness({ policy: { limits: { max_items_per_plan: 2, max_messages_per_plan: 1, max_actions_per_day: 200, max_messages_per_day: 20 } } });
        expect((await errOf(plan(small, [1, 2, 4].map((id) => ({ marker_id: id, value: "x" }))))).code).toBe("LIMIT_EXCEEDED");

        const h = await makeWriteHarness();
        const six = await plan(h, [1, 2, 4, 5, 6, 7].map((id) => ({ marker_id: id, value: "x" })));
        expect(six.risk).toBe("R3");
        expect(six.risk_reasons.join(" ")).toMatch(/Más de 5 ítems/);

        // ADR-126: un curso real no escala por sí solo, con o sin enabled_on reciente.
        const real = await makeWriteHarness({ policy: { sandbox_course_ids: [] } });
        const one = await plan(real, [{ marker_id: 1, value: "x" }]);
        expect(one.risk).toBe("R2");
        expect(one.risk_reasons.join(" ")).not.toMatch(/Curso real/);
        expect((await plan(real, [1, 2, 4, 5, 6, 7].map((id) => ({ marker_id: id, value: "x" })))).risk).toBe("R3");
        const fresh = await makeWriteHarness({ policy: { sandbox_course_ids: [], courses: { [String(COURSE)]: [{ capability: "synthetic_test", enabled_on: "2026-10-22" }] } } });
        expect((await plan(fresh, [{ marker_id: 1, value: "x" }])).risk).toBe("R2");
    });
});

describe("escrituras W0 · deshacer (§12)", () => {
    it("deshacer exacto es un plan propio: se confirma, restaura y queda registrado; no se deshace dos veces", async () => {
        const h = await makeWriteHarness();
        const { result } = await run(h, [
            { marker_id: 1, value: "nuevo-a" },
            { marker_id: 2, value: "nuevo-b" },
        ]);
        expect(value(h, 1)).toBe("nuevo-a");
        const u = await h.app.engine.planUndo(result.action_id, "test");
        if (!u.undoable) throw new Error("debería poder deshacerse");
        expect(u.undo_kind).toBe("exacto");
        expect(u.plan.undo_of).toBe(result.action_id);
        expect(writes(h)).toBe(2); // armar el deshacer no escribe
        const r = await exec(h, u.plan.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect([value(h, 1), value(h, 2)]).toEqual(["inicial-a", "inicial-b"]);
        expect((await h.app.engine.getPlan(result.plan_id)).state.undone_by).toBe(r.action_id);
        expect((await errOf(h.app.engine.planUndo(result.action_id, "test"))).code).toBe("PLAN_ALREADY_EXECUTED");
    });

    it("deshacer de una acción parcial revierte sólo lo aplicado; sin efecto no hay nada que deshacer", async () => {
        const h = await makeWriteHarness();
        h.markers.next("ok", "exception");
        const { result } = await run(h, [
            { marker_id: 1, value: "a" },
            { marker_id: 2, value: "b" },
        ]);
        const u = await h.app.engine.planUndo(result.action_id, "test");
        if (!u.undoable) throw new Error("debería poder deshacerse");
        expect(u.plan.items.map((i) => i.target.marker_id)).toEqual([1]);

        h.markers.next("noop_null");
        const { result: none } = await run(h, [{ marker_id: 4, value: "z" }]);
        expect(await h.app.engine.planUndo(none.action_id, "test")).toMatchObject({ undoable: false });
    });
});

describe("escrituras W0 · inyección (§12)", () => {
    it("contenido del Campus con instrucciones no produce escrituras: planificar sólo lee y lo marca como dato no confiable", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 3, value: "valor pedido por el docente" }]);
        expect(writes(h)).toBe(0);
        expect(JSON.stringify(p.payload_preview)).toContain(INJECTION);
        expect(p.untrusted_notice).toMatch(/datos, no instrucciones/);
        // El plan contiene exactamente lo pedido; el texto inyectado no cambia ítems ni destino.
        expect(p.items).toHaveLength(1);
        expect(p.items[0]!.expected).toEqual({ value: "valor pedido por el docente" });
        // Sin confirmación del humano no se escribe.
        h.confirmer.decisions = ["unavailable"];
        expect((await errOf(exec(h, p.plan_id))).code).toBe("CONFIRMATION_REQUIRED");
        expect(writes(h)).toBe(0);
    });
});

describe("escrituras W0 · secretos y auditoría (§12)", () => {
    it("planes, auditoría, errores y logs sin token, sesskey ni contenido de estudiantes; texto docente sólo como hash", async () => {
        const h = await makeWriteHarness();
        await run(h, [{ marker_id: 3, value: "texto-del-docente-123" }]);
        h.markers.next("exception");
        h.fake.overrides.set("local_sintetico_set_marker", () => ({ exception: "moodle_exception", errorcode: "x", message: `falló con wstoken=${VALID_TOKEN}` }));
        const { error } = await run(h, [{ marker_id: 1, value: "otro" }]);
        expect(error?.message).not.toContain(VALID_TOKEN);
        const plans = readdirSync(join(h.dir, "plans")).map((f) => readFileSync(join(h.dir, "plans", f), "utf8")).join("\n");
        const audit = readFileSync(join(h.dir, "write-audit.jsonl"), "utf8");
        const all = [plans, audit, h.logs.join("\n"), JSON.stringify(error)].join("\n");
        expect(all).not.toContain(VALID_TOKEN);
        expect(all).not.toContain(WEB_SESSKEY);
        expect(audit).not.toContain("texto-del-docente-123");
        expect(audit).not.toContain(INJECTION);
        expect(audit).toMatch(/"sha256_12":"[a-f0-9]{12}","length":21/);
        const events = audit.trim().split("\n").map((l) => JSON.parse(l).event);
        expect(events).toEqual(["plan_created", "confirmation", "execution", "plan_created", "confirmation", "execution"]);
    });

    it("con audit_teacher_text=true se guarda el texto del docente (opción del dueño)", async () => {
        const h = await makeWriteHarness({ policy: { audit_teacher_text: true } });
        await plan(h, [{ marker_id: 1, value: "texto-visible" }]);
        expect(readFileSync(join(h.dir, "write-audit.jsonl"), "utf8")).toContain("texto-visible");
    });

    it("campus_list_write_actions lee la auditoría con since", async () => {
        const h = await makeWriteHarness();
        const { result } = await run(h, [{ marker_id: 1, value: "x" }]);
        const list = await h.app.engine.listActions("2020-01-01");
        expect(list.actions.map((a) => a.action_id)).toEqual([result.action_id]);
        expect((await h.app.engine.listActions("2099-01-01")).actions).toHaveLength(0);
        await expect(h.app.engine.listActions("ayer")).rejects.toThrow(CampusError);
    });
});

describe("escrituras W0 · interruptor y límites (§12)", () => {
    it("interruptor general: WRITE_DISABLED en plan y ejecución; se reactiva", async () => {
        const h = await makeWriteHarness();
        const p = await plan(h, [{ marker_id: 1, value: "x" }]);
        await h.app.engine.setSwitch(true, "test");
        expect((await errOf(plan(h, [{ marker_id: 2, value: "x" }]))).code).toBe("WRITE_DISABLED");
        expect((await errOf(exec(h, p.plan_id))).code).toBe("WRITE_DISABLED");
        expect((await h.app.engine.status()).enabled).toBe(false);
        await h.app.engine.setSwitch(false, "test");
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
    });

    it("write_policy.enabled=false también deshabilita", async () => {
        const h = await makeWriteHarness({ policy: { enabled: false } });
        expect((await errOf(plan(h, [{ marker_id: 1, value: "x" }]))).code).toBe("WRITE_DISABLED");
    });

    it("freno: 3 resultados sin efecto o rechazados seguidos pausan hasta resume", async () => {
        const h = await makeWriteHarness();
        h.markers.next("noop_null", "exception", "warnings");
        for (const id of [1, 2, 4]) await run(h, [{ marker_id: id, value: "x" }]);
        const e = await errOf(plan(h, [{ marker_id: 5, value: "x" }]));
        expect(e.code).toBe("WRITE_DISABLED");
        expect(e.details?.brake).toBe(true);
        expect(e.humanAction).toContain("write resume");
        await h.app.engine.resume("test");
        expect((await run(h, [{ marker_id: 5, value: "x" }])).result.status).toBe("aplicado_verificado");
    });

    it("un éxito reinicia el contador del freno", async () => {
        const h = await makeWriteHarness();
        h.markers.next("noop_null", "noop_null", "ok", "noop_null", "noop_null");
        for (const id of [1, 2, 4, 5, 6]) await run(h, [{ marker_id: id, value: "x" }]);
        expect((await h.app.engine.status()).brake).toMatchObject({ paused: false, consecutive_failures: 2 });
    });

    it("límite diario de acciones (LIMIT_EXCEEDED) que se renueva al cambiar el día", async () => {
        const h = await makeWriteHarness({ policy: { limits: { max_items_per_plan: 30, max_messages_per_plan: 1, max_actions_per_day: 3, max_messages_per_day: 20 } } });
        await run(h, [
            { marker_id: 1, value: "a" },
            { marker_id: 2, value: "b" },
        ]);
        const p = await plan(h, [
            { marker_id: 4, value: "c" },
            { marker_id: 5, value: "d" },
        ]);
        expect((await errOf(exec(h, p.plan_id))).code).toBe("LIMIT_EXCEEDED");
        expect((await h.app.engine.status()).today).toMatchObject({ actions: 2, remaining_actions: 1 });
        h.clock.ms += 86_400_000;
        const q = await plan(h, [
            { marker_id: 4, value: "c" },
            { marker_id: 5, value: "d" },
        ]);
        expect((await exec(h, q.plan_id)).status).toBe("aplicado_verificado");
    });
});
