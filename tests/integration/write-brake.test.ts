import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { acquireProbe, brakeView, DEFAULT_BRAKE, recordResult } from "../../src/write/brake.js";
import { EMPTY_STATE, KvWriteStore, MemoryKv } from "../../src/write/store.js";
import { SyntheticContent } from "../fixtures/fake-content.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * ADR-134: freno con cooldown automático de 2 horas, prueba half_open, transiciones atómicas, fallos por
 * objetivo frente a sistémicos y diagnóstico de la subida. Reloj inyectado: nada de esperas reales.
 */

type Change = { marker_id: number; value: string };
const plan = (h: WriteHarness, changes: Change[]) => h.app.engine.plan("marcador_sintetico", { course_id: COURSE, changes }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
const writes = (h: WriteHarness) => h.fake.callsOf("local_sintetico_set_marker").length;
const run = async (h: WriteHarness, id: number) => exec(h, (await plan(h, [{ marker_id: id, value: `v${h.clock.ms}` }])).plan_id);
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}
const MIN = 60_000;
const stateFile = (h: WriteHarness) => join(h.dir, "write-state.json");
const audit = (h: WriteHarness) => readFileSync(join(h.dir, "write-audit.jsonl"), "utf8");

/** Tres fallos sobre objetivos distintos: abre el freno. */
async function tripBrake(h: WriteHarness) {
    h.markers.next("noop_null", "noop_null", "noop_null");
    for (const id of [1, 2, 4]) expect((await run(h, id)).status).toBe("sin_efecto");
}

describe("freno: cooldown de 2 horas y prueba half_open (ADR-134)", () => {
    it("tres fallos distintos abren el freno por 7.200 s; mientras tanto no se planifica ni se escribe", async () => {
        const h = await makeWriteHarness();
        const ready = await plan(h, [{ marker_id: 5, value: "listo" }]);
        await tripBrake(h);
        const st = (await h.app.engine.status()).brake;
        expect(st).toMatchObject({ state: "open", retry_after_seconds: 7200, cooldown_seconds: 7200, failure_window_seconds: 900, consecutive_failures: 3 });
        expect(Date.parse(st.paused_until!) - h.clock.ms).toBe(7_200_000);
        expect(st.paused_until_local).toContain("America/Argentina/Buenos_Aires");
        const before = writes(h);
        const e = await errOf(plan(h, [{ marker_id: 5, value: "x" }]));
        expect(e.code).toBe("WRITE_DISABLED");
        expect(e.details).toMatchObject({ reason: "automatic_cooldown", brake: true, paused_until: st.paused_until, retry_after_seconds: 7200 });
        expect(e.message).toContain("hasta");
        expect((await errOf(exec(h, ready.plan_id))).details?.reason).toBe("automatic_cooldown");
        expect(writes(h)).toBe(before);
        expect(audit(h)).toContain('"event":"brake_engaged"');
        // Las lecturas siguen.
        expect((await h.app.read.service.listCourses({})).data.length).toBeGreaterThan(0);
    });

    it("a las 1:59:59 sigue cerrado; a las 2:00 pasa a half_open y la prueba verificada lo cierra", async () => {
        const h = await makeWriteHarness();
        await tripBrake(h);
        h.clock.ms += 7_199_000;
        expect((await errOf(plan(h, [{ marker_id: 5, value: "x" }]))).details?.reason).toBe("automatic_cooldown");
        h.clock.ms += 1_000;
        // Consultar el estado no consume el turno.
        expect((await h.app.engine.status()).brake).toMatchObject({ state: "half_open", probe_in_progress: false, retry_after_seconds: 0 });
        expect((await h.app.engine.status()).brake.state).toBe("half_open");
        const r = await run(h, 5);
        expect(r.status).toBe("aplicado_verificado");
        expect(r.warnings.join(" ")).toContain("vuelven a la normalidad");
        const st = (await h.app.engine.status()).brake;
        expect(st).toMatchObject({ state: "closed", paused: false, consecutive_failures: 0, last_recovery: { via: "automatic_probe" } });
        expect((await run(h, 6)).status).toBe("aplicado_verificado");
        expect(audit(h)).toContain('"event":"brake_half_open"');
        expect(audit(h)).toContain('"event":"brake_recovered"');
    });

    it("la prueba fallida abre otro cooldown de 2 horas (otro ciclo)", async () => {
        const h = await makeWriteHarness();
        await tripBrake(h);
        const cycle = JSON.parse(readFileSync(stateFile(h), "utf8")).brake_cycle;
        h.clock.ms += 120 * MIN;
        h.markers.next("noop_null");
        expect((await run(h, 5)).status).toBe("sin_efecto");
        const st = (await h.app.engine.status()).brake;
        expect(st).toMatchObject({ state: "open", retry_after_seconds: 7200 });
        expect(JSON.parse(readFileSync(stateFile(h), "utf8")).brake_cycle).toBe(cycle + 1);
        expect(audit(h)).toContain('"event":"brake_reengaged"');
    });

    it("half_open: con el turno tomado por otra ejecución, ésta recibe probe_in_progress sin escribir; un turno abandonado vence", async () => {
        const h = await makeWriteHarness();
        await tripBrake(h);
        h.clock.ms += 120 * MIN;
        const b = await plan(h, [{ marker_id: 6, value: "b" }]);
        // Otra instancia toma el turno (y no informa: proceso caído).
        const taken = await h.app.store.updateState((s) => acquireProbe(s, new Date(h.clock.ms), DEFAULT_BRAKE, "otra-instancia"));
        expect(taken.changed).toBe(true);
        expect((await h.app.engine.status()).brake).toMatchObject({ state: "half_open", probe_in_progress: true });
        const before = writes(h);
        const e = await errOf(exec(h, b.plan_id));
        expect(e.details).toMatchObject({ reason: "probe_in_progress", probe_in_progress: true });
        expect(writes(h)).toBe(before);
        // El lease de la prueba vence (15 min): la siguiente ejecución toma el turno.
        h.clock.ms += 16 * MIN;
        expect((await run(h, 6)).status).toBe("aplicado_verificado");
        expect((await h.app.engine.status()).brake.state).toBe("closed");
    });

    it("un error previo a escribir (plan obsoleto) suelta el turno sin veredicto", async () => {
        const h = await makeWriteHarness();
        await tripBrake(h);
        h.clock.ms += 120 * MIN;
        const stale = await plan(h, [{ marker_id: 5, value: "viejo" }]);
        h.markers.markers.get(5)!.value = "cambiado por otro";
        h.markers.markers.get(5)!.timemodified += 10;
        expect((await errOf(exec(h, stale.plan_id))).code).toBe("PLAN_STALE");
        expect((await h.app.engine.status()).brake).toMatchObject({ state: "half_open", probe_in_progress: false });
        expect((await run(h, 6)).status).toBe("aplicado_verificado");
        expect((await h.app.engine.status()).brake.state).toBe("closed");
    });

    it("resultado incierto, parcial o con diferencias en la prueba: no es salud comprobada, reabre (conservador)", () => {
        const now = new Date("2026-11-16T12:00:00Z");
        const paused = { ...EMPTY_STATE, paused: true, paused_at: "2026-11-16T09:00:00Z", paused_until: "2026-11-16T11:00:00Z", brake_cycle: 1 };
        for (const status of ["aplicado_desconocido", "aplicado_parcial", "aplicado_con_diferencias", "rechazado_por_moodle"] as const) {
            const probing = acquireProbe(paused, now, DEFAULT_BRAKE, "p1")!;
            const r = recordResult(probing, now, DEFAULT_BRAKE, status, null, "p1");
            expect(r.transition, status).toBe("brake_reengaged");
            expect(brakeView(r.state, now, DEFAULT_BRAKE)).toMatchObject({ state: "open", retry_after_seconds: 7200 });
        }
        // Una prueba de un ciclo anterior no cierra el freno nuevo.
        const probing = acquireProbe(paused, now, DEFAULT_BRAKE, "viejo")!;
        const reopened = { ...probing, brake_cycle: 2, probe: null, paused_until: "2026-11-16T14:00:00Z" };
        expect(recordResult(reopened, now, DEFAULT_BRAKE, "aplicado_verificado", null, "viejo")).toMatchObject({ transition: null, state: { paused: true } });
    });

    it("reiniciar el proceso o cambiar de día no levanta antes el cooldown; vencido, se recupera sin cron", async () => {
        const h = await makeWriteHarness();
        await tripBrake(h);
        // Otro proceso (mismo directorio de estado), con el día cambiado en los contadores.
        const s = JSON.parse(readFileSync(stateFile(h), "utf8"));
        writeFileSync(stateFile(h), JSON.stringify({ ...s, day: "2000-01-01", actions_today: 99 }));
        const h2 = await makeWriteHarness({ dir: h.dir });
        h2.clock.ms = h.clock.ms + 60 * MIN;
        expect((await errOf(plan(h2, [{ marker_id: 5, value: "x" }]))).details?.reason).toBe("automatic_cooldown");
        h2.clock.ms += 60 * MIN;
        expect((await run(h2, 5)).status).toBe("aplicado_verificado");
        expect((await h2.app.engine.status()).brake.state).toBe("closed");
    });

    it("el interruptor manual sigue bloqueando pasado cualquier plazo; resume no lo toca ni toca el consumo del día", async () => {
        const h = await makeWriteHarness();
        await tripBrake(h);
        await h.app.engine.setSwitch(true, "test");
        h.clock.ms += 3 * 24 * 60 * MIN;
        expect((await errOf(plan(h, [{ marker_id: 5, value: "x" }]))).details?.reason).toBe("manual_disable");
        const before = await h.app.engine.status();
        const r = await h.app.engine.resume("test");
        expect(r).toMatchObject({ result: "resumed", disabled: true });
        const after = await h.app.engine.status();
        expect(after.switch.disabled).toBe(true);
        expect(after.today).toEqual(before.today);
        expect(after.brake.state).toBe("closed");
        expect((await errOf(plan(h, [{ marker_id: 5, value: "x" }]))).details?.reason).toBe("manual_disable");
        expect((await h.app.engine.resume("test")).result).toBe("no_brake");
        expect(audit(h)).toContain('"event":"brake_resumed_manually"');
    });

    it("migración: estado viejo con paused_at deriva el plazo; sin fecha fiable queda pausado hasta reanudar a mano", async () => {
        const h = await makeWriteHarness();
        const at = new Date(h.clock.ms - 30 * MIN).toISOString();
        writeFileSync(stateFile(h), JSON.stringify({ disabled: false, changed_at: null, paused: true, paused_at: at, paused_reason: "3 resultados seguidos", consecutive_failures: 3, day: null, actions_today: 4, messages_today: 0 }));
        const e = await errOf(plan(h, [{ marker_id: 5, value: "x" }]));
        expect(e.details).toMatchObject({ reason: "automatic_cooldown", retry_after_seconds: 90 * 60 });
        writeFileSync(stateFile(h), JSON.stringify({ disabled: false, paused: true, paused_at: null, paused_reason: "viejo", consecutive_failures: 3 }));
        h.clock.ms += 10 * 24 * 60 * MIN;
        const m = await errOf(plan(h, [{ marker_id: 5, value: "x" }]));
        expect(m.details).toMatchObject({ reason: "manual_recovery_required", paused_until: null });
        expect(m.humanAction).toContain("write resume");
        await h.app.engine.resume("test");
        expect((await run(h, 5)).status).toBe("aplicado_verificado");
    });

    it("estado dañado: falla cerrado (no se interpreta como «sin freno»)", async () => {
        const h = await makeWriteHarness();
        writeFileSync(stateFile(h), "{no es json");
        expect((await errOf(plan(h, [{ marker_id: 5, value: "x" }]))).code).toBe("SERVICE_UNAVAILABLE");
    });
});

describe("fallos por objetivo frente a sistémicos (ADR-134)", () => {
    it("el mismo intento fallido tres veces (mismo objetivo) no abre el freno global; fallos de objetivos distintos sí", async () => {
        const h = await makeWriteHarness();
        h.markers.next("noop_null", "noop_null", "noop_null");
        for (let i = 0; i < 3; i++) expect((await exec(h, (await plan(h, [{ marker_id: 1, value: "mismo" }])).plan_id)).status).toBe("sin_efecto");
        const st = (await h.app.engine.status()).brake;
        expect(st).toMatchObject({ state: "closed", consecutive_failures: 1, last_failure: { scope: "target", stage: "verify", code: "SIN_EFECTO" } });
        h.markers.next("noop_null", "noop_null");
        await run(h, 2);
        await run(h, 4);
        expect((await h.app.engine.status()).brake.state).toBe("open");
    });

    it("los fallos fuera de la ventana de 15 minutos no suman", async () => {
        const h = await makeWriteHarness();
        h.markers.next("noop_null", "noop_null", "noop_null");
        await run(h, 1);
        await run(h, 2);
        h.clock.ms += 16 * MIN;
        await run(h, 4);
        expect((await h.app.engine.status()).brake).toMatchObject({ state: "closed", consecutive_failures: 1 });
    });

    it("errores previos a la emisión (plan obsoleto, confirmación) no cuentan", async () => {
        const h = await makeWriteHarness();
        for (const id of [1, 2, 4]) {
            const p = await plan(h, [{ marker_id: id, value: "x" }]);
            h.markers.markers.get(id)!.value = "otro";
            h.markers.markers.get(id)!.timemodified += 10;
            expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
        }
        expect((await h.app.engine.status()).brake).toMatchObject({ state: "closed", consecutive_failures: 0 });
    });
});

describe("subida rechazada por el Campus (ADR-134)", () => {
    async function harness() {
        const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content", "synthetic_test"] } } });
        const c = new SyntheticContent(h.fake, h.w2);
        let uploads = 0;
        h.fake.upload = async () => {
            uploads++;
            return new Response("<html><body>Forbidden · sesskey=abc123 · token=deadbeef · alumno@udesa.edu.ar</body></html>", { status: 403, headers: { "content-type": "text/html" } });
        };
        const path = join(mkdtempSync(join(tmpdir(), "campus-403-")), "apunte.pdf");
        writeFileSync(path, "%PDF-1.4\n%prueba\n");
        return { h, c, path, uploads: () => uploads };
    }

    it("un 403 de upload_draft informa etapa y HTTP, sugiere regenerar el PDF, no vuelca el cuerpo y no reintenta", async () => {
        const { h, c, path, uploads } = await harness();
        const r = await exec(h, (await h.app.engine.plan("create_content", { course_id: COURSE, section: 1, type: "resource", name: "Apunte", file_path: path }, "test")).plan_id);
        expect(r.status).toBe("rechazado_por_moodle");
        expect(uploads()).toBe(1);
        expect(c.posts).toHaveLength(0);
        const err = r.items[0]!.error!;
        expect(err).toMatchObject({ code: "MOODLE_REJECTED", stage: "upload_draft", http_status: 403 });
        expect(err.message).toContain("en la etapa de subida (HTTP 403)");
        expect(err.message).toContain("Microsoft Print to PDF");
        const dump = JSON.stringify(r) + h.logs.join("\n") + audit(h);
        for (const leak of ["Forbidden", "abc123", "deadbeef", "alumno@udesa.edu.ar", "<html"]) expect(dump).not.toContain(leak);
        expect((await h.app.engine.status()).brake.last_failure).toMatchObject({ scope: "target", stage: "upload_draft", http_status: 403 });
    });

    it("tres intentos con el mismo PDF contra el mismo destino no bloquean las demás escrituras", async () => {
        const { h, path } = await harness();
        for (let i = 0; i < 3; i++) {
            const r = await exec(h, (await h.app.engine.plan("create_content", { course_id: COURSE, section: 1, type: "resource", name: "Apunte", file_path: path }, "test")).plan_id);
            expect(r.status).toBe("rechazado_por_moodle");
        }
        expect((await h.app.engine.status()).brake.state).toBe("closed");
        expect((await run(h, 5)).status).toBe("aplicado_verificado");
    });
});

describe("estado compartido en el KV: transiciones atómicas (ADR-134)", () => {
    it("dos instancias no pierden incrementos ni pisan un disable concurrente", async () => {
        const kv = new MemoryKv();
        const a = new KvWriteStore(kv, "w:p");
        const b = new KvWriteStore(kv, "w:p");
        await Promise.all([
            ...Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).updateState((s) => ({ ...s, actions_today: s.actions_today + 1 }))),
            a.updateState((s) => ({ ...s, disabled: true })),
        ]);
        const s = await b.readState();
        expect(s.actions_today).toBe(20);
        expect(s.disabled).toBe(true);
        expect(kv.ttl.has("w:p:state")).toBe(false);
    });

    it("dos instancias en half_open: sólo una toma el turno de prueba", async () => {
        const kv = new MemoryKv();
        const now = new Date("2026-11-16T12:00:00Z");
        await new KvWriteStore(kv, "w:p").updateState(() => ({ ...EMPTY_STATE, paused: true, paused_at: "2026-11-16T09:00:00Z", paused_until: "2026-11-16T11:00:00Z", brake_cycle: 1 }));
        const results = await Promise.all(["x1", "x2", "x3"].map((id) => new KvWriteStore(kv, "w:p").updateState((s) => acquireProbe(s, now, DEFAULT_BRAKE, id))));
        expect(results.filter((r) => r.changed)).toHaveLength(1);
        expect((await new KvWriteStore(kv, "w:p").readState()).probe?.cycle).toBe(1);
    });

    it("KV caído o estado dañado: error, nunca «sin freno»", async () => {
        const kv = new MemoryKv();
        kv.data.set("w:p:state", "basura");
        await expect(new KvWriteStore(kv, "w:p").readState()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        const down = new KvWriteStore({ cmd: async () => { throw new CampusError("SERVICE_UNAVAILABLE", "KV caído"); } }, "w:p");
        await expect(down.updateState((s) => s)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    });
});

describe("revisión adversarial (ADR-134)", () => {
    it("resultados inciertos por fallas sistémicas (red) sí suman al freno; un incierto por objetivo no", () => {
        const now = new Date("2026-11-16T12:00:00Z");
        let s = { ...EMPTY_STATE };
        for (let i = 0; i < 3; i++) s = recordResult(s, now, DEFAULT_BRAKE, "aplicado_desconocido", { fingerprint: `red${i}`, scope: "systemic", stage: "ws_call", code: "NETWORK_ERROR", http_status: null }, null).state;
        expect(brakeView(s, now, DEFAULT_BRAKE).state).toBe("open");
        let t = { ...EMPTY_STATE };
        for (let i = 0; i < 3; i++) t = recordResult(t, now, DEFAULT_BRAKE, "aplicado_desconocido", { fingerprint: `obj${i}`, scope: "target", stage: "verify", code: null, http_status: null }, null).state;
        expect(brakeView(t, now, DEFAULT_BRAKE).state).toBe("closed");
    });

    it("401 en la subida: AUTH_REQUIRED antes de escribir, el plan sigue disponible y no suma al freno", async () => {
        const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content", "synthetic_test"] } } });
        new SyntheticContent(h.fake, h.w2);
        h.fake.upload = async () => new Response("no", { status: 401 });
        const path = join(mkdtempSync(join(tmpdir(), "campus-401-")), "a.pdf");
        writeFileSync(path, "%PDF-1.4\n");
        const p = await h.app.engine.plan("create_content", { course_id: COURSE, section: 1, type: "resource", name: "A", file_path: path }, "test");
        expect((await errOf(exec(h, p.plan_id))).code).toBe("AUTH_REQUIRED");
        expect((await h.app.engine.status()).brake).toMatchObject({ state: "closed", consecutive_failures: 0, last_failure: null });
    });

    it("resume sin freno registra brake_resume_noop (no un desbloqueo)", async () => {
        const h = await makeWriteHarness();
        expect((await h.app.engine.resume("test")).result).toBe("no_brake");
        expect(audit(h)).toContain('"event":"brake_resume_noop"');
        expect(audit(h)).not.toContain('"event":"brake_resumed_manually"');
    });
});
