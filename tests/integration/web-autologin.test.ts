import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { AutoLogin, AUTOLOGIN_MIN_INTERVAL_AFTER_OK_MS, AUTOLOGIN_MIN_INTERVAL_MS, loadTrust, readAutoLoginState, saveLogin, saveTrust } from "../../src/web/autologin.js";
import { parseDialogOutput } from "../../src/web/code-prompt.js";
import { passwordLogin } from "../../src/web/login.js";
import { MemoryWebSessionSource } from "../../src/web/session.js";
import { wireAutoLogin } from "../../src/cli/web-autologin.js";
import { SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { FakeLogin, LOGIN_PASSWORD, LOGIN_USER } from "../fixtures/fake-login.js";
import { makeHarness } from "../fixtures/harness.js";

const PROFILE = "sintetico";

async function setup(opts: { mfa?: boolean } = {}) {
    const source = new MemoryWebSessionSource(null);
    const h = await makeHarness({ webSource: source });
    const login = new FakeLogin(h.fake.web, SITE, USER_ID);
    login.mfaEnabled = opts.mfa ?? true;
    return { h, login, source, web: h.app.web! };
}

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

const posts = (h: Awaited<ReturnType<typeof makeHarness>>, path: string) => h.fake.web.requests.filter((r) => r.method === "POST" && r.path === path).length;

function autoLogin(s: Awaited<ReturnType<typeof setup>>, extra: { askCode?: () => Promise<string | null>; now?: () => Date } = {}) {
    return new AutoLogin({ transport: s.web, secrets: s.h.secrets, metadata: s.h.metadata, profileId: PROFILE, siteUrl: SITE, loadSnapshot: () => s.source.load(), ...extra });
}

describe("login web con contraseña y MFA (ADR-088)", () => {
    it("primer login: pide el código del correo, confía en el dispositivo (28 días) y deja una sesión verificada", async () => {
        const s = await setup();
        let asked = 0;
        const r = await passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [], askCode: async () => (asked++, s.login.lastCode) });
        expect(asked).toBe(1);
        expect(s.login.emails).toHaveLength(1);
        expect(r.mfa).toBe("codigo");
        expect(r.snapshot.user_id).toBe(USER_ID);
        expect(r.remembered.map((c) => c.name).sort()).toEqual([`MFA_TOKEN_${USER_ID}`, "MOODLEID1_"]);
        const days = (Date.parse(r.trust_expires_at!) - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(27.9);
        // Se marcó «confiar en este dispositivo» y la sesión sirve para operar.
        expect(s.h.fake.web.requests.find((x) => x.path === "/admin/tool/mfa/auth.php" && x.method === "POST")!.body).toMatch(/factor_token_trust=1/);
        await s.source.save(r.snapshot);
        const op = await s.web.open();
        expect(op.userId).toBe(USER_ID);
        // La sesión guardada no lleva la cookie de confianza: esa queda aparte.
        expect(r.snapshot.cookies.some((c) => c.name.startsWith("MFA_TOKEN"))).toBe(false);
    });

    it("dispositivo de confianza vigente: sin correo ni código", async () => {
        const s = await setup();
        const first = await passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [], askCode: async () => s.login.lastCode });
        let asked = false;
        const again = await passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: first.remembered, askCode: async () => ((asked = true), null) });
        expect(again.mfa).toBe("dispositivo_de_confianza");
        expect(asked).toBe(false);
        expect(s.login.emails).toHaveLength(1);
    });

    it("contraseña rechazada: AUTH_REJECTED con el motivo del Campus y sin la contraseña en el error", async () => {
        const s = await setup();
        const e = await passwordLogin(s.web, { username: LOGIN_USER, password: "otra-clave-equivocada", remembered: [] }).catch((x) => x);
        expect(e).toBeInstanceOf(CampusError);
        expect(e.code).toBe("AUTH_REJECTED");
        expect(e.message).toMatch(/contraseña erróneos/);
        expect(JSON.stringify(e)).not.toMatch(/otra-clave-equivocada/);
        expect(s.login.failedPasswords).toBe(1);
    });

    it("captcha, cambio de contraseña forzado o MFA sin canal: falla cerrado", async () => {
        const s = await setup();
        s.login.captcha = true;
        expect(await codeOf(passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [] }))).toBe("AUTH_REQUIRED");
        expect(posts(s.h, "/login/index.php")).toBe(0); // la contraseña no se llegó a enviar
        s.login.captcha = false;
        s.login.forcePasswordChange = true;
        expect(await codeOf(passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [] }))).toBe("AUTH_REQUIRED");
        s.login.forcePasswordChange = false;
        const e = await passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [] }).catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(e.message).toMatch(/código de verificación/);
        expect(s.login.failedCodes).toBe(0);
    });

    it("código equivocado o mal formado: un solo intento", async () => {
        const s = await setup();
        expect(await codeOf(passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [], askCode: async () => "12345" }))).toBe("AUTH_REJECTED");
        expect(s.login.failedCodes).toBe(0); // no se envió: no eran 6 dígitos
        expect(await codeOf(passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [], askCode: async () => "999999" }))).toBe("AUTH_REJECTED");
        expect(s.login.failedCodes).toBe(1);
    });
});

describe("login automático en el transporte web", () => {
    async function enabled(opts: { now?: () => Date } = {}) {
        const s = await setup();
        await saveLogin(s.h.secrets, PROFILE, SITE, { username: LOGIN_USER, password: LOGIN_PASSWORD });
        // Puesta en marcha (enable): el dispositivo ya es de confianza.
        const first = await passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [], askCode: async () => s.login.lastCode });
        await saveTrust(s.h.secrets, PROFILE, SITE, first.remembered);
        const a = autoLogin(s, { askCode: async () => s.login.lastCode, now: opts.now });
        s.web.setAutoLogin(a);
        return { ...s, a };
    }

    it("sin sesión guardada, la primera operación inicia sesión sola (sin correo) y la guarda", async () => {
        const s = await enabled();
        const op = await s.web.open();
        expect(op.userId).toBe(USER_ID);
        expect(s.source.snapshot).not.toBeNull();
        expect(s.login.emails).toHaveLength(1); // sólo el de la puesta en marcha
        expect(readAutoLoginState(s.h.metadata).last).toMatchObject({ ok: true, mfa: "dispositivo_de_confianza" });
    });

    it("sesión vencida: un login automático y un reintento; las operaciones simultáneas comparten el login", async () => {
        let t = Date.now();
        const s = await enabled({ now: () => new Date(t) });
        await s.web.open();
        s.login.expireWebSessions();
        t += AUTOLOGIN_MIN_INTERVAL_MS + 1000;
        const before = posts(s.h, "/login/index.php");
        const ops = await Promise.all([s.web.open(), s.web.open(), s.web.open()]);
        expect(ops.every((o) => o.userId === USER_ID)).toBe(true);
        expect(posts(s.h, "/login/index.php") - before).toBe(1);
    });

    it("límite de frecuencia: 2 min después de un éxito y a lo sumo 6 por día", async () => {
        let t = Date.now();
        const s = await enabled({ now: () => new Date(t) });
        await s.web.open();
        s.login.expireWebSessions();
        const before = posts(s.h, "/login/index.php");
        const e = await s.web.open().catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(e.message).toMatch(/menos de 2 minutos/);
        expect(posts(s.h, "/login/index.php")).toBe(before);
        for (let i = 0; i < 5; i++) {
            t += AUTOLOGIN_MIN_INTERVAL_AFTER_OK_MS + 1000;
            s.login.expireWebSessions();
            await s.web.open();
        }
        t += AUTOLOGIN_MIN_INTERVAL_AFTER_OK_MS + 1000;
        s.login.expireWebSessions();
        expect((await s.web.open().catch((x) => x)).message).toMatch(/6 intentos en 24 h/);
    });

    it("después de un fallo que no desactiva (el Campus no responde), la pausa es de 10 minutos", async () => {
        let t = Date.now();
        const s = await enabled({ now: () => new Date(t) });
        const flow = s.h.fake.web.loginFlow;
        s.h.fake.web.loginFlow = () => new Response("caído", { status: 503 });
        expect(await codeOf(s.web.open())).toBe("UNEXPECTED_RESPONSE");
        expect(readAutoLoginState(s.h.metadata)).toMatchObject({ disabled: null, inflight: null, last: { ok: false } });
        t += 3 * 60_000;
        s.h.fake.web.loginFlow = flow;
        expect((await s.web.open().catch((x) => x)).message).toMatch(/menos de 10 minutos/);
        t += AUTOLOGIN_MIN_INTERVAL_MS;
        expect((await s.web.open()).userId).toBe(USER_ID);
    });

    it("contraseña cambiada en el Campus: se desactiva al primer rechazo y no vuelve a intentar", async () => {
        let t = Date.now();
        const s = await enabled({ now: () => new Date(t) });
        await saveLogin(s.h.secrets, PROFILE, SITE, { username: LOGIN_USER, password: "vieja-clave" });
        expect(await codeOf(s.web.open())).toBe("AUTH_REJECTED");
        expect(readAutoLoginState(s.h.metadata).disabled).toMatchObject({ reason: expect.stringMatching(/rechazó/) });
        t += AUTOLOGIN_MIN_INTERVAL_MS * 10;
        const failed = s.login.failedPasswords;
        const e = await s.web.open().catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(e.message).toMatch(/desactivado/);
        expect(s.login.failedPasswords).toBe(failed);
        expect(JSON.stringify(readAutoLoginState(s.h.metadata))).not.toMatch(/vieja-clave/);
    });

    it("confianza vencida: pide el código por el canal (diálogo) y renueva la cookie de confianza", async () => {
        let t = Date.now();
        const s = await enabled({ now: () => new Date(t) });
        s.login.trustTokens.clear(); // vencieron los 28 días
        t += AUTOLOGIN_MIN_INTERVAL_MS + 1000;
        const oldTrust = (await loadTrust(s.h.secrets, PROFILE, SITE)).find((c) => c.name.startsWith("MFA_TOKEN"))!.value;
        const op = await s.web.open();
        expect(op.userId).toBe(USER_ID);
        expect(s.login.emails).toHaveLength(2);
        const newTrust = (await loadTrust(s.h.secrets, PROFILE, SITE)).find((c) => c.name.startsWith("MFA_TOKEN"))!.value;
        expect(newTrust).not.toBe(oldTrust);
        expect(readAutoLoginState(s.h.metadata).last).toMatchObject({ ok: true, mfa: "codigo" });
    });

    it("sin login automático, todo sigue como antes: AUTH_REQUIRED sin pedir la página de login", async () => {
        const s = await setup();
        expect(await codeOf(s.web.open())).toBe("AUTH_REQUIRED");
        expect(s.h.fake.web.requests.some((r) => r.path === "/login/index.php")).toBe(false);
    });

    it("la contraseña no aparece en los logs", async () => {
        const s = await enabled();
        await s.web.open();
        expect(s.h.logs.join("\n")).not.toContain(LOGIN_PASSWORD);
    });
});

describe("guardas de la Fase A (ADR-121)", () => {
    /** Login automático SIN canal para el código (local sin diálogo), con la confianza ya obtenida. */
    async function noChannel(opts: { now?: () => Date } = {}) {
        const s = await setup();
        await saveLogin(s.h.secrets, PROFILE, SITE, { username: LOGIN_USER, password: LOGIN_PASSWORD });
        const first = await passwordLogin(s.web, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [], askCode: async () => s.login.lastCode });
        await saveTrust(s.h.secrets, PROFILE, SITE, first.remembered);
        s.web.setAutoLogin(autoLogin(s, { now: opts.now }));
        return s;
    }

    it("sin canal y sin confianza guardada: AUTH_REQUIRED sin ninguna petición (no sale un correo)", async () => {
        const s = await setup();
        await saveLogin(s.h.secrets, PROFILE, SITE, { username: LOGIN_USER, password: LOGIN_PASSWORD });
        s.web.setAutoLogin(autoLogin(s));
        const e = await s.web.open().catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(e.message).toMatch(/confianza del dispositivo/);
        expect(s.h.fake.web.requests.some((r) => r.path === "/login/index.php")).toBe(false);
        expect(s.login.emails).toHaveLength(0);
        expect(readAutoLoginState(s.h.metadata).needs_trust).toMatchObject({ reason: expect.stringMatching(/no hay confianza/) });
    });

    it("sin canal, el Campus igual pide el código: un solo correo y queda «necesita confianza»", async () => {
        let t = Date.now();
        const s = await noChannel({ now: () => new Date(t) });
        s.login.trustTokens.clear(); // la confianza dejó de valer en el Campus
        const e = await s.web.open().catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(s.login.emails).toHaveLength(2); // el de la puesta en marcha y éste
        expect(readAutoLoginState(s.h.metadata).needs_trust).toBeTruthy();
        t += 86_400_000;
        const before = s.h.fake.web.requests.length;
        expect((await s.web.open().catch((x) => x)).message).toMatch(/renovar la confianza/);
        expect(s.h.fake.web.requests.length).toBe(before);
        expect(s.login.emails).toHaveLength(2);
    });

    it("un intento que quedó sin resultado (ejecución cortada) frena y desactiva, sin enviar la contraseña", async () => {
        const s = await noChannel();
        const st = readAutoLoginState(s.h.metadata);
        s.h.metadata.writeJson("web-autologin.json", { ...st, inflight: { at: new Date(Date.now() - 60_000).toISOString() } });
        const before = posts(s.h, "/login/index.php");
        const e = await s.web.open().catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(e.message).toMatch(/se cortó sin resultado/);
        expect(posts(s.h, "/login/index.php")).toBe(before);
        expect(readAutoLoginState(s.h.metadata)).toMatchObject({ inflight: null, disabled: { reason: expect.stringMatching(/se cortó/) } });
    });

    it("si falla el token móvil, no se intenta un login web", async () => {
        const s = await noChannel();
        await s.web.open();
        s.login.expireWebSessions();
        s.h.fake.overrides.set("core_webservice_get_site_info", () => ({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token" }));
        // La identidad ya verificada queda en memoria: se fuerza a verificar de nuevo.
        await s.h.app.session.logoutLocal().catch(() => undefined);
        const before = posts(s.h, "/login/index.php");
        const attempts = (readAutoLoginState(s.h.metadata).attempts ?? []).length;
        const e = await s.web.open().catch((x) => x);
        expect(e).toBeInstanceOf(CampusError);
        expect(e.details?.component).toBe("mobile_token");
        expect(posts(s.h, "/login/index.php")).toBe(before);
        expect(readAutoLoginState(s.h.metadata).attempts ?? []).toHaveLength(attempts);
    });

    it("todas las peticiones web llevan un User-Agent que dice que es el MCP", async () => {
        const s = await noChannel();
        const seen: (string | null)[] = [];
        const { WebTransport, webUserAgent } = await import("../../src/web/transport.js");
        const t = new WebTransport({
            siteUrl: SITE,
            source: s.source,
            expectedUserId: async () => USER_ID,
            logger: { log() {} },
            timeoutMs: 5000,
            renewHint: "x",
            fetch: (u, init) => {
                seen.push(new Headers(init?.headers).get("user-agent"));
                return s.h.fake.fetch(u, init);
            },
        });
        await passwordLogin(t, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: await loadTrust(s.h.secrets, PROFILE, SITE) });
        expect(seen.length).toBeGreaterThan(2);
        expect(new Set(seen)).toEqual(new Set([webUserAgent("local")]));
        expect(webUserAgent("local")).toMatch(/udesa-campus-mcp/);
    });
});

describe("dos llaves y diálogo", () => {
    it("wireAutoLogin: sólo con la variable Y la contraseña cargada", async () => {
        const s = await setup();
        const w = { web: s.web, source: s.source, secrets: s.h.secrets, metadata: s.h.metadata, profileId: PROFILE, siteUrl: SITE, logger: { log: () => {} } };
        expect(await wireAutoLogin(w, {})).toBe(false);
        expect(await wireAutoLogin(w, { CAMPUS_WEB_AUTOLOGIN: "true" })).toBe(false);
        expect(s.web.autoLoginEnabled).toBe(false);
        await saveLogin(s.h.secrets, PROFILE, SITE, { username: LOGIN_USER, password: LOGIN_PASSWORD });
        expect(await wireAutoLogin(w, { CAMPUS_WEB_AUTOLOGIN: "1" })).toBe(false);
        expect(await wireAutoLogin(w, { CAMPUS_WEB_AUTOLOGIN: "true" })).toBe(true);
        expect(s.web.autoLoginEnabled).toBe(true);
    });

    it("salida del diálogo: sólo «CODE:» con 6 dígitos es un código", () => {
        expect(parseDialogOutput("CODE:123456\r\n")).toBe("123456");
        expect(parseDialogOutput("algo\nCODE: 654321")).toBe("654321");
        for (const bad of ["CANCEL", "TIMEOUT", "CODE:12345", "CODE:abcdef", ""]) expect(parseDialogOutput(bad)).toBeNull();
    });
});
