import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { webImport } from "../../src/cli/web-local.js";
import { CampusError } from "../../src/errors.js";
import { MemoryMetadataStore } from "../../src/session/metadata.js";
import { MemorySecretStore } from "../../src/session/secret-store.js";
import { createLogger } from "../../src/util/logger.js";
import { saveLogin, saveTrust, writeAutoLoginState } from "../../src/web/autologin.js";
import { LocalConnection } from "../../src/web/local-connection.js";
import { passwordLogin } from "../../src/web/login.js";
import { encodeSnapshot, revisionOf, webSecretAccount, type WebSessionSnapshot } from "../../src/web/session.js";
import { MemoryKv } from "../../src/write/store.js";
import { FakeMoodle, SITE, syntheticProfile, USER_ID, VALID_TOKEN } from "../fixtures/fake-moodle.js";
import { FakeLogin, LOGIN_PASSWORD, LOGIN_USER } from "../fixtures/fake-login.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";

/** ADR-142: la conexión web del MCP local con el modelo del remoto. Todo sintético (Moodle falso, keyring en memoria). */

const TIME = "core_session_time_remaining";

interface Shared {
    fake: FakeMoodle;
    login: FakeLogin;
    secrets: MemorySecretStore;
    metadata: MemoryMetadataStore;
    kv: MemoryKv;
    clock: { ms: number };
}

function shared(): Shared {
    const fake = new FakeMoodle();
    const login = new FakeLogin(fake.web, SITE, USER_ID);
    const kv = new MemoryKv();
    const clock = { ms: Date.now() };
    kv.clock = () => clock.ms;
    return { fake, login, secrets: new MemorySecretStore(), metadata: new MemoryMetadataStore(), kv, clock };
}

/** Un «proceso» local (serve, serve-full o la CLI): comparte keyring, metadata y archivo de conexión con los demás. */
async function proc(w: Shared, o: { server?: boolean; env?: Record<string, string>; askCode?: (() => Promise<string | null>) | null; cutAfter?: { path: string | null } } = {}) {
    const profile = syntheticProfile();
    const logs: string[] = [];
    const logger = createLogger((l) => logs.push(l), "debug");
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
        const res = await w.fake.fetch(input, init);
        if (o.cutAfter?.path && new URL(String(input)).pathname === o.cutAfter.path && (init?.method ?? "GET") === "POST") {
            o.cutAfter.path = null;
            throw new TypeError("fetch failed (corte sintético después de enviar)");
        }
        return res;
    };
    const local = new LocalConnection({
        profile,
        secrets: w.secrets,
        metadata: w.metadata,
        logger,
        cli: "campus",
        requireSecondKey: !!o.server,
        env: o.env ?? {},
        askCode: o.askCode ?? null,
        kv: w.kv,
        fetch: fetchImpl,
        now: () => new Date(w.clock.ms),
        expectedUserId: async () => USER_ID,
        verifyApi: async () => ({ userid: USER_ID }),
    });
    const app = createApp({ profile, secrets: w.secrets, metadata: w.metadata, logger, fetch: w.fake.fetch, webSource: local.source(), webRenewHint: "renovar (test)", webAuthError: (r) => local.authError(r) });
    await app.session.adoptCandidate(VALID_TOKEN, "native");
    return { local, app, web: app.web!, logs, profile };
}

const loginPosts = (w: Shared) => w.fake.web.requests.filter((r) => r.method === "POST" && r.path === "/login/index.php").length;

async function errorOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

/** Puesta en marcha desde la terminal (`auth web autologin enable`), sin la CLI. */
async function enableFromTerminal(w: Shared) {
    const p = await proc(w);
    const svc = await p.local.service();
    await svc.noteTerminalAttempt();
    const r = await passwordLogin(p.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: await svc.trustForLogin(), askCode: async () => w.login.lastCode });
    await saveLogin(w.secrets, p.profile.profile_id, SITE, { username: LOGIN_USER, password: LOGIN_PASSWORD });
    await svc.adoptLogin(r);
    return r;
}

describe("migración del estado local (ADR-142)", () => {
    it("adopta la cookie del keyring, la confianza y los intentos de web-autologin.json sin login ni correo", async () => {
        const w = shared();
        const profile = syntheticProfile();
        const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
        const s: WebSessionSnapshot = { v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: new Date(w.clock.ms).toISOString() };
        await w.secrets.set(webSecretAccount(profile.profile_id, SITE), encodeSnapshot(s));
        const exp = Math.floor(w.clock.ms / 1000) + 20 * 86_400;
        await saveTrust(w.secrets, profile.profile_id, SITE, [{ name: `MFA_TOKEN_${USER_ID}`, value: "t", expires: exp }]);
        const at = new Date(w.clock.ms - 3_600_000).toISOString();
        writeAutoLoginState(w.metadata, { attempts: [at], last: { at, ok: true } });
        const p = await proc(w);
        const svc = await p.local.service();
        const rec = await svc.record();
        expect(rec.active?.renewal_id).toBe("legacy");
        expect(rec.active?.session_revision).toBe(s.revision);
        expect(rec.active?.trust_expires_at).toBe(new Date(exp * 1000).toISOString());
        expect(rec.control.attempts).toEqual([at]);
        expect(loginPosts(w)).toBe(0);
        expect(w.login.emails).toHaveLength(0);
        // La sesión adoptada sirve en una operación real.
        expect((await p.web.open()).userId).toBe(USER_ID);
        // Idempotente: otro proceso no vuelve a migrar.
        const q = await proc(w);
        expect((await (await q.local.service()).record()).auth_generation).toBe(rec.auth_generation);
    });

    it("un intento que quedó en curso no se adopta como si nada: queda para revisar", async () => {
        const w = shared();
        writeAutoLoginState(w.metadata, { inflight: { at: new Date(w.clock.ms).toISOString() } });
        const p = await proc(w);
        const rec = await (await p.local.service()).record();
        expect(rec.control.disabled?.reason).toBe("attempt_uncertain");
    });
});

describe("errores con la acción de esta PC", () => {
    it("sin sesión ni login automático: AUTH_REQUIRED que recomienda activarlo, con la cookie como alternativa, sin pedir la página de login", async () => {
        const w = shared();
        const p = await proc(w, { server: true });
        const e = await errorOf(p.web.open());
        expect(e.code).toBe("AUTH_REQUIRED");
        const rec = e.details?.recovery as { kind: string; command: string; alternatives: { kind: string; command: string }[] };
        expect(rec.kind).toBe("enable_local_autologin");
        expect(rec.command).toBe(`campus auth web autologin enable --profile ${p.profile.profile_id}`);
        expect(rec.alternatives.find((a) => a.kind === "import_web_cookie")?.command).toBe(`campus auth web import --profile ${p.profile.profile_id} --clipboard`);
        expect(e.humanAction).toMatch(/nunca pegues contraseñas, códigos ni cookies en el chat/);
        expect(w.fake.web.requests.some((r) => r.path.startsWith("/login/"))).toBe(false);
    });

    it("cookie importada que venció: AUTH_REQUIRED tipado (session_expired), no un resultado vacío", async () => {
        const w = shared();
        const p = await proc(w, { server: true });
        const snapshot = await p.web.validateImport([{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }], new Date());
        await (await p.local.service()).importSession(snapshot);
        expect((await p.web.open()).userId).toBe(USER_ID);
        w.fake.web.sessions.clear();
        const e = await errorOf(p.web.open());
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(e.details?.reason).toBe("session_expired");
        expect((e.details?.recovery as { kind: string }).kind).toBe("enable_local_autologin");
    });
});

describe("cookie como respaldo", () => {
    it("estado local: método cookie, confianza «no aplica», vencimiento estimado y diagnóstico listo sin confianza", async () => {
        const w = shared();
        const p = await proc(w, { server: true });
        const svc = await p.local.service();
        await svc.importSession(await p.web.validateImport([{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }], new Date(w.clock.ms)));
        const st = await svc.publicStatus();
        expect(st).toMatchObject({ mode: "local", method: "cookie", device_trust: { state: "not_applicable" }, action: null });
        const ws = st.web_session as Record<string, string>;
        expect(Date.parse(ws.estimated_expires_if_idle_at!) - Date.parse(ws.last_used_at!)).toBe(4 * 3_600_000);
        expect(ws.estimate_basis).toBe("limite_documentado_4h");
        const d = await svc.diagnose();
        expect(d.result).toBe("ready");
        expect(d.checks.device_trust.state).toBe("not_applicable");
    });

    it("verify_web informa el tiempo que le queda a la sesión (core_session_time_remaining, sólo lectura)", async () => {
        const w = shared();
        w.fake.web.ajax.set(TIME, () => ({ userid: USER_ID, timeremaining: 5400 }));
        const p = await proc(w);
        const svc = await p.local.service();
        await svc.importSession(await p.web.validateImport([{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }], new Date()));
        const probe = await svc.probeWeb();
        expect(probe).toMatchObject({ state: "ok", time_remaining_s: 5400 });
    });

    it("--clipboard: importa, vacía el portapapeles también si falla y nunca muestra el valor", async () => {
        const w = shared();
        const p = await proc(w);
        const lines: string[] = [];
        let board = WEB_SESSION_OK;
        let cleared = 0;
        const clip = { read: async () => board, clear: async () => void (cleared++, (board = "")) };
        const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s), clipboard: true, clipboardImpl: clip };
        expect(await webImport(p.app, p.local, p.profile, io)).toBe(0);
        expect(cleared).toBe(1);
        expect(lines.join("\n")).not.toContain(WEB_SESSION_OK);
        expect(lines.join("\n")).toMatch(/Win\+V/);
        expect((await (await p.local.service()).publicStatus()).method).toBe("cookie");
        // Vacío o de otra cuenta: error, y el portapapeles se vacía igual.
        board = "";
        await expect(webImport(p.app, p.local, p.profile, io)).rejects.toThrow(/vacío/);
        expect(cleared).toBe(2);
        board = "MoodleSession=otra-sesion-desconocida";
        await expect(webImport(p.app, p.local, p.profile, io)).rejects.toBeInstanceOf(CampusError);
        expect(cleared).toBe(3);
        expect(lines.join("\n")).not.toContain("otra-sesion-desconocida");
    });
});

describe("login automático local sobre el registro", () => {
    it("puesta en marcha desde la terminal: publica sesión y confianza (generación nueva) y los servidores las usan sin otro correo", async () => {
        const w = shared();
        await enableFromTerminal(w);
        expect(w.login.emails).toHaveLength(1);
        const srv = await proc(w, { server: true, env: { CAMPUS_WEB_AUTOLOGIN: "true" } });
        const target: { connection?: { status(): Promise<Record<string, unknown>> } } = {};
        expect(await srv.local.wire(srv.web, target)).toBe(true);
        expect((await srv.web.open()).userId).toBe(USER_ID);
        expect(w.login.emails).toHaveLength(1);
        const st = await target.connection!.status();
        expect(st).toMatchObject({ mode: "local", method: "autologin", device_trust: { state: "valid" }, action: null });
    });

    it("aviso a los 7 días: la confianza «vence pronto» y la acción lleva al panel local", async () => {
        const w = shared();
        await enableFromTerminal(w);
        w.clock.ms += 22 * 86_400_000;
        const srv = await proc(w, { server: true, env: { CAMPUS_WEB_AUTOLOGIN: "true" } });
        const st = await (await srv.local.service()).publicStatus();
        expect(st.device_trust).toMatchObject({ state: "expiring" });
        expect(st.action).toMatchObject({ kind: "renew_local_trust", command: `campus auth web panel --profile ${srv.profile.profile_id}`, url: null });
    });

    it("sesión vencida en dos procesos a la vez: un solo login (candado del registro), sin código", async () => {
        const w = shared();
        await enableFromTerminal(w);
        const a = await proc(w, { server: true, env: { CAMPUS_WEB_AUTOLOGIN: "true" } });
        const b = await proc(w, { server: true, env: { CAMPUS_WEB_AUTOLOGIN: "true" } });
        await a.local.wire(a.web, {});
        await b.local.wire(b.web, {});
        await a.web.open();
        w.login.expireWebSessions();
        w.clock.ms += 3 * 60_000; // después de la pausa de 2 min tras un éxito
        const before = loginPosts(w);
        const ops = await Promise.all([a.web.open(), b.web.open()]);
        expect(ops.every((o) => o.userId === USER_ID)).toBe(true);
        expect(loginPosts(w) - before).toBe(1);
        expect(w.login.emails).toHaveLength(1);
    });

    it("confianza vencida SIN diálogo: AUTH_REQUIRED que lleva al panel local, sin mandar un correo", async () => {
        const w = shared();
        await enableFromTerminal(w);
        w.clock.ms += 29 * 86_400_000;
        const srv = await proc(w, { server: true, env: { CAMPUS_WEB_AUTOLOGIN: "true" } });
        await srv.local.wire(srv.web, {});
        w.login.expireWebSessions();
        const emails = w.login.emails.length;
        const e = await errorOf(srv.web.open());
        expect(e.code).toBe("AUTH_REQUIRED");
        const rec = e.details?.recovery as { kind: string; command: string };
        expect(rec).toMatchObject({ kind: "renew_local_trust", command: `campus auth web panel --profile ${srv.profile.profile_id}` });
        expect(w.login.emails.length).toBe(emails);
    });

    it("confianza vencida CON diálogo (D2): pide el código una vez y renueva la confianza en el registro", async () => {
        const w = shared();
        await enableFromTerminal(w);
        w.clock.ms += 29 * 86_400_000;
        w.login.trustTokens.clear(); // el Campus ya no acepta la confianza vieja: va a pedir el código
        let asked = 0;
        const srv = await proc(w, { server: true, env: { CAMPUS_WEB_AUTOLOGIN: "true" }, askCode: async () => (asked++, w.login.lastCode) });
        await srv.local.wire(srv.web, {});
        w.login.expireWebSessions();
        expect((await srv.web.open()).userId).toBe(USER_ID);
        expect(asked).toBe(1);
        expect(w.login.emails).toHaveLength(2);
        const rec = await (await srv.local.service()).record();
        expect(rec.control.last).toMatchObject({ ok: true, source: "autologin" });
        expect(Date.parse(rec.active!.trust_expires_at!)).toBeGreaterThan(Date.now() + 20 * 86_400_000);
    });

    it("los seis intentos por día valen entre procesos: la terminal no pide la contraseña si otro proceso los gastó", async () => {
        const w = shared();
        const a = await proc(w);
        const svcA = await a.local.service();
        for (let i = 0; i < 6; i++) await svcA.noteTerminalAttempt();
        const b = await proc(w);
        const blocked = await (await b.local.service()).terminalBlock();
        expect(blocked).toMatchObject({ state: "failed", reason: "rate_limited" });
    });

    it("panel local: un corte después de enviar el código queda «incierto» y no se reenvía solo", async () => {
        const w = shared();
        await enableFromTerminal(w);
        w.clock.ms += 3 * 60_000;
        const cut = { path: null as string | null };
        const p = await proc(w, { cutAfter: cut });
        const svc = await p.local.service();
        const started = await svc.start("navegador-local");
        expect(started.state).toBe("awaiting_code");
        cut.path = "/admin/tool/mfa/auth.php";
        const done = await svc.complete(started.renewal_id!, w.login.lastCode!, "navegador-local");
        expect(done.state).toBe("uncertain");
        const again = await svc.start("navegador-local");
        expect(again.state).toBe("uncertain"); // sin rearmar explícito, no hay reenvío
    });
});
