import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseBootstrap, recoveryAction, trustState, TRUST_WARN_MS, CONNECTION_REASONS, type WebBootstrap } from "../../src/remote/connection-contracts.js";
import { ConnectionService, type ConnectionConfig } from "../../src/remote/connection-service.js";
import { KvSecretBox } from "../../src/remote/web-store.js";
import { encodeSnapshot, MemoryWebSessionSource, revisionOf, type WebSessionSnapshot } from "../../src/web/session.js";
import { WebTransport } from "../../src/web/transport.js";
import { createLogger } from "../../src/util/logger.js";
import { MemoryKv, type KvClient } from "../../src/write/store.js";
import { FakeMoodle, SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { FakeLogin, LOGIN_PASSWORD, LOGIN_USER } from "../fixtures/fake-login.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";

/** ADR-141: registro v2 de la conexión web remota, renovación en dos pasos, cercos y migración. Todo sintético. */

const PANEL = "https://mcp.example.test/admin/conexion";
const BROWSER = "navegador-a";
const LOGIN = { username: LOGIN_USER, password: LOGIN_PASSWORD };

const snap = (value = WEB_SESSION_OK): WebSessionSnapshot => {
    const cookies = [{ name: "MoodleSession", value, expires: null }];
    return { v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" };
};

const baseConfig = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    epoch: 0,
    fingerprint: "fp-legacy",
    mode: "enabled",
    login: LOGIN,
    bootstrap: null,
    legacy: { loginRaw: JSON.stringify(LOGIN), trustRaw: null, sessionSeedRaw: null },
    ...extra,
});

interface World {
    fake: FakeMoodle;
    login: FakeLogin;
    kv: MemoryKv;
    box: KvSecretBox;
    clock: { ms: number };
    /** Corta la red justo después de que Moodle procesó un POST a esta ruta (una vez). */
    cutAfter: { path: string | null };
    verifyUser: { id: number };
}

function world(): World {
    const fake = new FakeMoodle();
    const login = new FakeLogin(fake.web, SITE, USER_ID);
    const kv = new MemoryKv();
    const clock = { ms: Date.now() };
    kv.clock = () => clock.ms;
    return { fake, login, kv, box: new KvSecretBox(randomBytes(32)), clock, cutAfter: { path: null }, verifyUser: { id: USER_ID } };
}

/** Una «instancia» del remoto: comparte KV, caja y Moodle con las demás del mismo mundo. */
function instance(w: World, config: ConnectionConfig = baseConfig(), kv: KvClient = w.kv) {
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
        const res = await w.fake.fetch(input, init);
        const url = new URL(String(input));
        if (w.cutAfter.path && url.pathname === w.cutAfter.path && (init?.method ?? "GET") === "POST") {
            w.cutAfter.path = null;
            throw new TypeError("fetch failed (corte sintético después de enviar)");
        }
        return res;
    };
    const isolatedTransport = (seed: WebSessionSnapshot | null) =>
        new WebTransport({ siteUrl: SITE, source: new MemoryWebSessionSource(seed), expectedUserId: async () => USER_ID, logger: createLogger(() => {}), timeoutMs: 5000, fetch: fetchImpl, renewHint: "" });
    return new ConnectionService({
        kv,
        box: w.box,
        profileId: "sintetico",
        siteUrl: SITE,
        expectedUserId: USER_ID,
        config,
        panelUrl: PANEL,
        isolatedTransport,
        verifyApi: async () => ({ userid: w.verifyUser.id }),
        now: () => new Date(w.clock.ms),
    });
}

const posts = (w: World, path: string) => w.fake.web.requests.filter((r) => r.method === "POST" && r.path === path).length;
const passwordPosts = (w: World) => posts(w, "/login/index.php");
const codePosts = (w: World) => posts(w, "/admin/tool/mfa/auth.php");
const MIN = 60_000;

describe("conexión v2: renovación en dos pasos (ADR-141)", () => {
    it("flujo completo: pedir código → confirmarlo en OTRA instancia → publica, sube la generación y diagnostica", async () => {
        const w = world();
        const a = instance(w);
        const b = instance(w);
        const started = await a.start(BROWSER);
        expect(started).toMatchObject({ state: "awaiting_code", reason: null });
        expect(w.login.emails).toHaveLength(1);
        expect(passwordPosts(w)).toBe(1);
        // El desafío (cookies + campos del MFA) queda sellado en el KV, no en memoria de la instancia A.
        const done = await b.complete(started.renewal_id!, w.login.lastCode!, BROWSER);
        expect(done.state).toBe("committed");
        expect(done.diagnostic?.result).toBe("ready");
        expect(codePosts(w)).toBe(1);
        const rec = await a.record();
        expect(rec.auth_generation).toBe(1);
        expect(rec.control.pending).toBeNull();
        expect(rec.receipts.at(-1)).toMatchObject({ renewal_id: started.renewal_id, auth_generation: 1 });
        // La confianza publicada es la NUEVA del usuario esperado.
        const trust = a.activeTrust(rec).find((c) => c.name === `MFA_TOKEN_${USER_ID}`)!;
        expect(w.login.trustTokens.has(trust.value)).toBe(true);
        expect(trustState(rec.active!.trust_expires_at, new Date(w.clock.ms))).toBe("valid");
        // Nada en claro en el KV: ni la contraseña ni las cookies de sesión.
        const dump = JSON.stringify([...w.kv.data.values()]);
        expect(dump).not.toContain(LOGIN_PASSWORD);
        expect(dump).not.toContain(trust.value);
        // Desafío y candidata se borran al publicar.
        expect([...w.kv.data.keys()].some((k) => /:(challenge|candidate):/.test(k))).toBe(false);
        // El estado público no expone datos cifrados y dice qué capas se comprobaron.
        const st = await a.publicStatus();
        expect(JSON.stringify(st)).not.toMatch(/sealed|v1\./);
        expect(st).toMatchObject({ api_token: { state: "ok" }, web_session: { state: "ok", present: true }, device_trust: { state: "valid" }, renewal: { state: "idle" }, action: null });
    });

    it("una renovación explícita no manda la confianza anterior (si no, Moodle no emite una nueva)", async () => {
        const w = world();
        const a = instance(w);
        const first = await a.start(BROWSER);
        await a.complete(first.renewal_id!, w.login.lastCode!, BROWSER);
        w.clock.ms += 3 * MIN; // pausa tras un intento correcto
        const old = a.activeTrust(await a.record()).find((c) => c.name.startsWith("MFA_TOKEN_"))!;
        const second = await a.start(BROWSER);
        expect(second.state).toBe("awaiting_code");
        const loginPost = w.fake.web.requests.filter((r) => r.method === "POST" && r.path === "/login/index.php").at(-1)!;
        expect(loginPost.cookie ?? "").not.toContain(old.value);
        expect(w.login.emails).toHaveLength(2);
    });

    it("iniciar dos veces no manda dos correos: el segundo pedido devuelve el proceso en curso", async () => {
        const w = world();
        const a = instance(w);
        const b = instance(w);
        const one = await a.start(BROWSER);
        const two = await b.start(BROWSER);
        expect(two).toMatchObject({ state: "awaiting_code", renewal_id: one.renewal_id, reason: "renewal_in_progress" });
        expect(w.login.emails).toHaveLength(1);
        expect(passwordPosts(w)).toBe(1);
    });

    it("dos confirmaciones simultáneas del mismo código: un solo envío a Moodle", async () => {
        const w = world();
        const a = instance(w);
        const b = instance(w);
        const s = await a.start(BROWSER);
        const code = w.login.lastCode!;
        const [x, y] = await Promise.all([a.complete(s.renewal_id!, code, BROWSER), b.complete(s.renewal_id!, code, BROWSER)]);
        expect(codePosts(w)).toBe(1);
        expect([x.state, y.state].sort()).toEqual(["committed", "submitting"]);
        // Repetir después del commit devuelve el recibo, sin tocar Moodle.
        const again = await b.complete(s.renewal_id!, code, BROWSER);
        expect(again.state).toBe("committed");
        expect(codePosts(w)).toBe(1);
        expect((await a.record()).auth_generation).toBe(1);
    });

    it("el código sólo vale en el navegador que inició: otro navegador recibe «superseded» sin envío", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        const r = await a.complete(s.renewal_id!, w.login.lastCode!, "otro-navegador");
        expect(r.state).toBe("superseded");
        expect(codePosts(w)).toBe(0);
        expect(await a.cancel(s.renewal_id!, "otro-navegador")).toMatchObject({ state: "awaiting_code" });
    });

    it("un código mal formado no se envía y el proceso sigue esperando", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        for (const bad of ["12345", "1234567", "abcdef", ""]) {
            expect(await a.complete(s.renewal_id!, bad, BROWSER)).toMatchObject({ state: "awaiting_code", input_error: "otp_format" });
        }
        expect(codePosts(w)).toBe(0);
        expect((await a.record()).control.pending?.state).toBe("awaiting_code");
    });

    it("código rechazado: falla terminal, no se reintenta y la pausa de 10 minutos rige para el próximo inicio", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        const r = await a.complete(s.renewal_id!, "000000", BROWSER);
        expect(r).toMatchObject({ state: "failed", reason: "otp_rejected" });
        expect(w.login.failedCodes).toBe(1);
        expect(await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER)).toMatchObject({ state: "failed" });
        expect(codePosts(w)).toBe(1);
        const blocked = await a.start(BROWSER);
        expect(blocked).toMatchObject({ state: "failed", reason: "rate_limited" });
        expect(Date.parse(blocked.retry_at!)).toBe(w.clock.ms + 10 * MIN);
        w.clock.ms += 11 * MIN;
        expect((await a.start(BROWSER)).state).toBe("awaiting_code");
        expect((await a.publicStatus()).action).toMatchObject({ kind: "wait" });
    });

    it("el desafío vence a los 10 minutos: confirmar después no envía nada", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        w.clock.ms += 11 * MIN;
        const r = await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER);
        expect(r.state).toBe("expired");
        expect(codePosts(w)).toBe(0);
        // Vencido no bloquea: se puede iniciar otro (ya pasó la pausa).
        expect((await a.start(BROWSER)).state).toBe("awaiting_code");
    });

    it("cancelar sólo cancela un desafío que espera el código", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        expect((await a.cancel(s.renewal_id!, BROWSER)).state).toBe("cancelled");
        expect(await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER)).toMatchObject({ state: "cancelled" });
        expect(codePosts(w)).toBe(0);
    });

    it("corte después de enviar el código: queda incierto, nunca se reenvía solo y hace falta rearmar a propósito", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        w.cutAfter.path = "/admin/tool/mfa/auth.php";
        const r = await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER);
        expect(r).toMatchObject({ state: "uncertain", reason: "attempt_uncertain" });
        expect(codePosts(w)).toBe(1);
        expect((await a.record()).auth_generation).toBe(0);
        expect(a.reasonOf(await a.record())).toBe("attempt_uncertain");
        expect((await a.publicStatus()).action).toMatchObject({ kind: "review_attempt" });
        w.clock.ms += 11 * MIN;
        expect(await a.start(BROWSER)).toMatchObject({ state: "uncertain" });
        expect(w.login.emails).toHaveLength(1);
        expect((await a.start(BROWSER, { rearm: true })).state).toBe("awaiting_code");
        expect(w.login.emails).toHaveLength(2);
    });

    it("corte después de enviar la contraseña: incierto (no «falló»), sin correo nuevo", async () => {
        const w = world();
        const a = instance(w);
        w.cutAfter.path = "/login/index.php";
        const r = await a.start(BROWSER);
        expect(r).toMatchObject({ state: "uncertain", reason: "attempt_uncertain" });
        expect((await a.record()).control.pending?.state).toBe("uncertain");
    });

    it("corte entre validar la candidata y publicarla: otra instancia la publica sin volver a Moodle", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        const pub = (a as unknown as { publishCandidate: (...x: unknown[]) => Promise<unknown> }).publishCandidate;
        (a as unknown as { publishCandidate: unknown }).publishCandidate = async () => {
            throw new TypeError("instancia cortada");
        };
        await expect(a.complete(s.renewal_id!, w.login.lastCode!, BROWSER)).rejects.toThrow(/cortada/);
        (a as unknown as { publishCandidate: unknown }).publishCandidate = pub;
        const b = instance(w);
        expect((await b.record()).control.pending?.state).toBe("candidate_ready");
        const before = w.fake.web.requests.filter((r) => r.path.startsWith("/login") || r.path.startsWith("/admin/tool/mfa")).length;
        const r = await b.resume();
        expect(r.state).toBe("committed");
        expect(w.fake.web.requests.filter((r) => r.path.startsWith("/login") || r.path.startsWith("/admin/tool/mfa")).length).toBe(before);
        expect((await b.record()).auth_generation).toBe(1);
    });

    it("una candidata sin confianza nueva del usuario esperado no se publica", async () => {
        const w = world();
        w.login.trustSeconds = 60; // menos que el margen: como si Moodle no hubiese emitido una confianza útil
        const a = instance(w);
        const s = await a.start(BROWSER);
        const r = await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER);
        expect(r).toMatchObject({ state: "failed", reason: "trust_missing" });
        expect((await a.record()).auth_generation).toBe(0);
    });

    it("sin identidad REST verificada (otro usuario o API caída) no se inicia nada", async () => {
        const w = world();
        const a = instance(w);
        w.verifyUser.id = 999;
        expect(await a.start(BROWSER)).toMatchObject({ state: "failed", reason: "identity_mismatch" });
        expect(passwordPosts(w)).toBe(0);
        expect((await a.record()).control.attempts).toHaveLength(0);
    });

    it("seis intentos por día como máximo, con la hora del próximo", async () => {
        const w = world();
        const a = instance(w);
        for (let i = 0; i < 6; i++) {
            const s = await a.start(BROWSER);
            expect(s.state).toBe("awaiting_code");
            await a.cancel(s.renewal_id!, BROWSER);
            w.clock.ms += 11 * MIN;
        }
        const r = await a.start(BROWSER);
        expect(r).toMatchObject({ state: "failed", reason: "rate_limited" });
        expect(r.retry_at).toBeTruthy();
        expect(passwordPosts(w)).toBe(6); // el correo sintético reutiliza el código vigente; cuentan los inicios
    });
});

describe("conexión v2: cercos, persistencia y login automático (ADR-141)", () => {
    it("KV caído: el estado lo dice como persistencia fallida con acción, nunca como «sin datos»", async () => {
        const w = world();
        const down: KvClient = {
            cmd: async () => {
                throw new CampusError("SERVICE_UNAVAILABLE", "kv caído", { details: { reason: "kv_unavailable" } });
            },
        };
        const a = instance(w, baseConfig(), down);
        const st = await a.publicStatus();
        expect(st).toMatchObject({ persistence: { state: "failed", reason: "kv_unavailable" }, action: { kind: "wait" } });
        await expect(a.start(BROWSER)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        expect(passwordPosts(w)).toBe(0);
    });

    it("registro dañado o de versión desconocida = error, no un registro vacío", async () => {
        const w = world();
        const a = instance(w);
        await a.record();
        w.kv.data.set(a.store.key, "{no es json");
        await expect(a.record()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        w.kv.data.set(a.store.key, JSON.stringify({ schema_version: 99 }));
        await expect(a.record()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    });

    it("una operación abierta antes de la renovación no pisa la sesión nueva al guardar su rotación", async () => {
        const w = world();
        const a = instance(w);
        const src = a.sessionSource();
        const s = await a.start(BROWSER);
        await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER);
        const current = (await src.load())!;
        await src.save(snap("rotacion-vieja-0123456789"), "revision-de-antes");
        expect((await src.load())!.revision).toBe(current.revision);
        // Con la revisión vigente como base, la rotación sí se guarda.
        await src.save(snap("rotacion-nueva-0123456789"), current.revision);
        expect((await src.load())!.revision).toBe(snap("rotacion-nueva-0123456789").revision);
    });

    it("invalidar sólo afecta a la revisión indicada", async () => {
        const w = world();
        const a = instance(w, baseConfig({ legacy: { loginRaw: null, trustRaw: null, sessionSeedRaw: encodeSnapshot(snap()) } }));
        const src = a.sessionSource();
        await src.invalidate!("otra-revision");
        expect(await src.load()).not.toBeNull();
        await src.invalidate!(snap().revision);
        expect(await src.load()).toBeNull();
        expect((await a.record()).control.rejected_revisions).toContain(snap().revision);
    });

    it("login automático: confianza vencida o ausente → error tipado con la acción del panel, sin tocar Moodle", async () => {
        const w = world();
        const a = instance(w);
        const backend = a.autoLoginBackend();
        const err = await backend.preflight!().then(
            () => null,
            (e: CampusError) => e,
        );
        expect(err).toBeInstanceOf(CampusError);
        expect(err!.code).toBe("AUTH_REQUIRED");
        expect(err!.details).toMatchObject({ component: "web_session", reason: "trust_missing", recovery: { kind: "renew_web_trust", url: PANEL, requires_human: true } });
        expect(passwordPosts(w)).toBe(0);
    });

    it("login automático: con una renovación en curso no compite con el panel", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER);
        w.clock.ms += 3 * MIN;
        await a.start(BROWSER);
        await expect(a.autoLoginBackend().preflight!()).rejects.toMatchObject({ details: { reason: "renewal_in_progress" } });
    });

    it("el candado del login automático es exclusivo entre instancias y lo libera sólo su dueño", async () => {
        const w = world();
        const a = instance(w).autoLoginBackend();
        const b = instance(w).autoLoginBackend();
        const releaseA = await a.lock!();
        let bGot = false;
        const pending = b.lock!().then((rel) => {
            bGot = true;
            return rel;
        });
        await new Promise((r) => setTimeout(r, 700));
        expect(bGot).toBe(false);
        await releaseA();
        const releaseB = await pending;
        expect(bGot).toBe(true);
        await releaseA(); // liberar dos veces no suelta el candado ajeno
        const c = instance(w).autoLoginBackend();
        let cGot = false;
        const pc = c.lock!().then((rel) => ((cGot = true), rel));
        await new Promise((r) => setTimeout(r, 700));
        expect(cGot).toBe(false);
        await releaseB();
        await (await pc)();
    });

    it("el login automático publica con generación nueva y recibo, por el mismo camino que el panel", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER);
        const trust = a.activeTrust(await a.record());
        // Un login con la confianza vigente (sin código), como haría AutoLogin.
        const { passwordLogin } = await import("../../src/web/login.js");
        const t = new WebTransport({ siteUrl: SITE, source: new MemoryWebSessionSource(null), expectedUserId: async () => USER_ID, logger: createLogger(() => {}), timeoutMs: 5000, fetch: w.fake.fetch, renewHint: "" });
        const r = await passwordLogin(t, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: trust, askCode: null });
        await a.autoLoginBackend().publish!(r);
        const rec = await a.record();
        expect(rec.auth_generation).toBe(2);
        expect(rec.receipts.at(-1)!.renewal_id).toMatch(/^auto-/);
        expect(rec.last_diagnostic?.result).toBe("pending");
        expect(w.login.emails).toHaveLength(1);
    });
});

describe("conexión v2: migración, activación y corte (ADR-141)", () => {
    it("migra lo legacy del KV sin login ni MFA y conserva la sesión y la confianza (epoch 0)", async () => {
        const w = world();
        const seedRaw = encodeSnapshot(snap());
        const trustRaw = JSON.stringify([{ name: `MFA_TOKEN_${USER_ID}`, value: "confianza-legacy", expires: Math.floor(w.clock.ms / 1000) + 20 * 86_400 }]);
        const loginRaw = JSON.stringify(LOGIN);
        const rotated = snap("rotada-en-el-kv-0123456789");
        w.kv.data.set("web:sintetico:session", JSON.stringify({ seed: w.box.fingerprint(seedRaw), sealed: w.box.seal(encodeSnapshot(rotated)) }));
        const autoFp = w.box.fingerprint(`${loginRaw}\n${trustRaw}`);
        w.kv.data.set("web:sintetico:autologin", JSON.stringify({ seed: autoFp, state: { attempts: [], last: { at: new Date(w.clock.ms - 3_600_000).toISOString(), ok: true } } }));
        const a = instance(w, baseConfig({ legacy: { loginRaw, trustRaw, sessionSeedRaw: seedRaw } }));
        const rec = await a.record();
        expect(rec).toMatchObject({ schema_version: 2, config_epoch: 0, auth_generation: 0, active: { renewal_id: "legacy", session_revision: rotated.revision } });
        expect(a.activeTrust(rec)[0]!.value).toBe("confianza-legacy");
        expect(trustState(rec.active!.trust_expires_at, new Date(w.clock.ms))).toBe("valid");
        expect(w.fake.web.requests).toHaveLength(0);
        // Idempotente: otra instancia lee el mismo registro, no vuelve a migrar.
        expect((await instance(w, baseConfig({ legacy: { loginRaw, trustRaw, sessionSeedRaw: seedRaw } })).record()).active!.published_at).toBe(rec.active!.published_at);
    });

    it("un estado legacy dañado no se migra como vacío", async () => {
        const w = world();
        w.kv.data.set("web:sintetico:session", "{dañado");
        await expect(instance(w).record()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    });

    it("un intento legacy en curso no se adopta como si nada: queda para revisar", async () => {
        const w = world();
        const loginRaw = JSON.stringify(LOGIN);
        w.kv.data.set("web:sintetico:autologin", JSON.stringify({ seed: w.box.fingerprint(`${loginRaw}\n`), state: { inflight: { at: new Date().toISOString() } } }));
        const rec = await instance(w, baseConfig({ legacy: { loginRaw, trustRaw: null, sessionSeedRaw: null } })).record();
        expect(rec.control.disabled?.reason).toBe("attempt_uncertain");
    });

    it("recuperación por CLI: el sobre de epoch mayor queda pendiente, se activa verificando su sesión y la instancia vieja queda cercada", async () => {
        const w = world();
        const old = instance(w);
        const s = await old.start(BROWSER);
        await old.complete(s.renewal_id!, w.login.lastCode!, BROWSER);
        const boot: WebBootstrap = { v: 2, activation_epoch: 2, mode: "enabled", login: LOGIN, trust: [{ name: `MFA_TOKEN_${USER_ID}`, value: "confianza-cli", expires: Math.floor(w.clock.ms / 1000) + 28 * 86_400 }], session: snap() };
        const fresh = instance(w, baseConfig({ epoch: 2, fingerprint: "fp-boot-2", bootstrap: boot, legacy: { loginRaw: null, trustRaw: null, sessionSeedRaw: null } }));
        expect(fresh.reasonOf(await fresh.record())).toBe("activation_pending");
        expect((await fresh.publicStatus()).action).toMatchObject({ kind: "activate_recovery" });
        // Mientras no se activa, la instancia nueva no inicia login.
        await expect(fresh.autoLoginBackend().preflight!()).rejects.toMatchObject({ details: { reason: "activation_pending" } });
        const before = passwordPosts(w);
        const act = await fresh.activate();
        expect(act.state).toBe("committed");
        expect(passwordPosts(w)).toBe(before); // sin contraseña ni código
        const rec = await fresh.record();
        expect(rec).toMatchObject({ config_epoch: 2, config_fingerprint: "fp-boot-2", auth_generation: 2 });
        // La instancia vieja (epoch 0) ya no escribe ni inicia sesión.
        expect(old.gate(rec)).toBe("stale_instance");
        await old.sessionSource().save(snap("vieja-0123456789abcdef"), rec.active!.session_revision);
        expect((await fresh.record()).active!.session_revision).toBe(rec.active!.session_revision);
        expect((await old.start(BROWSER)).reason).toBe("stale_instance");
        // Activar dos veces no hace nada nuevo.
        expect((await fresh.activate()).state).toBe("idle");
    });

    it("un sobre con sesión vencida no se activa y queda registrado como rechazado", async () => {
        const w = world();
        const boot: WebBootstrap = { v: 2, activation_epoch: 3, mode: "enabled", login: LOGIN, trust: [{ name: `MFA_TOKEN_${USER_ID}`, value: "x", expires: Math.floor(w.clock.ms / 1000) + 86_400 * 20 }], session: snap("vencida-0123456789abcdef") };
        const a = instance(w, baseConfig({ epoch: 3, fingerprint: "fp3", bootstrap: boot }));
        const r = await a.activate();
        expect(r).toMatchObject({ state: "failed", reason: "activation_pending" });
        expect((await a.record()).activation).toMatchObject({ epoch: 3, state: "rejected" });
    });

    it("corte explícito (mode disabled, epoch mayor): se aplica sin login y el login automático queda apagado", async () => {
        const w = world();
        const a = instance(w);
        const s = await a.start(BROWSER);
        await a.complete(s.renewal_id!, w.login.lastCode!, BROWSER);
        const off = instance(w, baseConfig({ epoch: 4, fingerprint: "fp-off", mode: "disabled", login: null, bootstrap: { v: 2, activation_epoch: 4, mode: "disabled" } }));
        const rec = await off.record();
        expect(rec).toMatchObject({ config_epoch: 4, control: { disabled: { reason: "manual_disable" } }, active: { trust_sealed: null } });
        await expect(off.autoLoginBackend().preflight!()).rejects.toMatchObject({ details: { reason: "manual_disable" } });
        expect((await off.start(BROWSER)).reason).toBe("manual_disable");
        expect((await off.publicStatus()).action).toMatchObject({ kind: "cli_recovery" });
    });

    it("misma epoch con otra huella = conflicto de configuración (no se adivina cuál vale)", async () => {
        const w = world();
        await instance(w).record();
        const other = instance(w, baseConfig({ fingerprint: "fp-otra" }));
        expect(other.gate(await other.record())).toBe("config_conflict");
        expect((await other.start(BROWSER)).reason).toBe("config_conflict");
    });
});

describe("contratos de la conexión (ADR-141)", () => {
    it("aviso de vencimiento a los siete días", () => {
        const now = new Date("2026-11-01T00:00:00Z");
        expect(TRUST_WARN_MS).toBe(7 * 86_400_000);
        expect(trustState(new Date(now.getTime() + 8 * 86_400_000).toISOString(), now)).toBe("valid");
        expect(trustState(new Date(now.getTime() + 6 * 86_400_000).toISOString(), now)).toBe("expiring");
        expect(trustState(new Date(now.getTime() - 1).toISOString(), now)).toBe("expired");
        expect(trustState(null, now)).toBe("missing");
    });

    it("cada motivo del catálogo cerrado tiene una acción tipada; sólo los del panel llevan su URL", () => {
        for (const r of CONNECTION_REASONS) {
            const a = recoveryAction(r, PANEL) as { kind: string; url?: string | null };
            expect(a.kind).toMatch(/^(renew_web_trust|activate_recovery|cli_recovery|wait|review_attempt)$/);
            if (a.kind === "renew_web_trust" || a.kind === "activate_recovery") expect(a.url).toBe(PANEL);
        }
    });

    it("el sobre de recuperación es todo o nada", () => {
        const trust = [{ name: `MFA_TOKEN_${USER_ID}`, value: "c", expires: 2_000_000_000 }];
        const ok = { v: 2, activation_epoch: 5, mode: "enabled", login: LOGIN, trust, session: encodeSnapshot(snap()) };
        expect(parseBootstrap(JSON.stringify(ok), USER_ID)).toMatchObject({ activation_epoch: 5, mode: "enabled" });
        expect(parseBootstrap(JSON.stringify({ v: 2, activation_epoch: 6, mode: "disabled" }), USER_ID)).toMatchObject({ mode: "disabled" });
        const bad = [
            "{",
            JSON.stringify({ ...ok, v: 1 }),
            JSON.stringify({ ...ok, activation_epoch: 0 }),
            JSON.stringify({ ...ok, trust: [{ name: "MFA_TOKEN_9", value: "c", expires: 2_000_000_000 }] }),
            JSON.stringify({ ...ok, trust: [{ name: `MFA_TOKEN_${USER_ID}`, value: "c", expires: null }] }),
            JSON.stringify({ ...ok, session: { no: "string" } }),
            JSON.stringify({ ...ok, login: { username: "x" } }),
        ];
        for (const raw of bad) expect(() => parseBootstrap(raw, USER_ID)).toThrow(CampusError);
        expect(() => parseBootstrap(JSON.stringify(ok), 999)).toThrow(/otra cuenta/);
    });
});
