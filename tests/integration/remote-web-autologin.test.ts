import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { readRemoteConfig } from "../../src/remote/config.js";
import { KvAutoLoginBackend, KvSecretBox, KvWebSessionSource, webKvPrefix } from "../../src/remote/web-store.js";
import { AUTOLOGIN_MIN_INTERVAL_MS, AutoLogin, autoLoginStatus } from "../../src/web/autologin.js";
import { passwordLogin } from "../../src/web/login.js";
import { encodeSnapshot, revisionOf, type WebSessionSnapshot } from "../../src/web/session.js";
import { WebTransport } from "../../src/web/transport.js";
import { createLogger } from "../../src/util/logger.js";
import { MemoryKv } from "../../src/write/store.js";
import { SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { FakeLogin, LOGIN_PASSWORD, LOGIN_USER } from "../fixtures/fake-login.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";

/** ADR-127: sesión web y login automático del servidor remoto en el KV (Upstash). */

const PROFILE = "sintetico";
const PREFIX = webKvPrefix(PROFILE);
const LOGIN = JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASSWORD });

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

const seedSnapshot = (value = WEB_SESSION_OK): WebSessionSnapshot => {
    const cookies = [{ name: "MoodleSession", value, expires: null }];
    return { v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" };
};

/** Dos «instancias» del remoto: cada una con su transporte web, compartiendo el mismo KV y Moodle. */
async function remote(opts: { trust?: "valid" | "none"; seed?: string | null; now?: () => Date; login?: string } = {}) {
    const kv = new MemoryKv();
    const box = new KvSecretBox(randomBytes(32));
    const seed = opts.seed === undefined ? null : opts.seed;
    const source = new KvWebSessionSource(kv, box, PREFIX, seed);
    const logs: string[] = [];
    const h = await makeHarness({ webSource: source });
    const login = new FakeLogin(h.fake.web, SITE, USER_ID);
    // Puesta en marcha (lo que hace `campus remote autologin enable` en la PC): un login con código.
    const setupWeb = new WebTransport({ siteUrl: SITE, source: new KvWebSessionSource(new MemoryKv(), box, "setup", null), expectedUserId: async () => USER_ID, logger: createLogger(() => {}), timeoutMs: 5000, fetch: h.fake.fetch, renewHint: "x" });
    const first = await passwordLogin(setupWeb, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [], askCode: async () => login.lastCode });
    const trust = opts.trust === "none" ? null : JSON.stringify(first.remembered);
    const cfg = { login: opts.login ?? LOGIN, trust };
    const instance = (src: KvWebSessionSource) => {
        const web = src === source ? h.app.web! : new WebTransport({ siteUrl: SITE, source: src, expectedUserId: async () => USER_ID, logger: createLogger(() => {}), timeoutMs: 5000, fetch: h.fake.fetch, renewHint: "x" });
        const backend = new KvAutoLoginBackend(kv, box, PREFIX, cfg, PROFILE);
        web.setAutoLogin(new AutoLogin({ transport: web, backend, loadSnapshot: () => src.load(), now: opts.now, log: (e, f) => logs.push(JSON.stringify({ e, ...f })) }));
        return { web, backend };
    };
    const a = instance(source);
    const b = instance(new KvWebSessionSource(kv, box, PREFIX, seed));
    return { kv, box, source, h, login, a, b, logs, emailsAtStart: login.emails.length };
}

const loginPosts = (h: Awaited<ReturnType<typeof makeHarness>>) => h.fake.web.requests.filter((r) => r.method === "POST" && r.path === "/login/index.php").length;

describe("sesión web remota en el KV (ADR-127)", () => {
    it("cifrado autenticado: el KV no guarda cookies en claro y un valor alterado no se abre", () => {
        const box = new KvSecretBox(randomBytes(32));
        const sealed = box.seal("MoodleSession=secreto");
        expect(sealed).not.toContain("secreto");
        expect(box.open(sealed)).toBe("MoodleSession=secreto");
        expect(box.open(sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA"))).toBeNull();
        expect(new KvSecretBox(randomBytes(32)).open(sealed)).toBeNull();
    });

    it("sin nada en el KV usa la semilla (CAMPUS_WEB_SESSION); lo guardado gana mientras la semilla no cambie", async () => {
        const kv = new MemoryKv();
        const box = new KvSecretBox(randomBytes(32));
        const seed = encodeSnapshot(seedSnapshot());
        const src = new KvWebSessionSource(kv, box, PREFIX, seed);
        expect((await src.load())!.revision).toBe(seedSnapshot().revision);
        await src.save(seedSnapshot("rotada0123456789abcdef"));
        expect((await src.load())!.cookies[0]!.value).toBe("rotada0123456789abcdef");
        expect(JSON.stringify([...kv.data.values()])).not.toContain("rotada0123456789abcdef");
        // Un push-web-session + deploy (semilla nueva) gana sobre lo guardado.
        const fresh = new KvWebSessionSource(kv, box, PREFIX, encodeSnapshot(seedSnapshot("nueva00123456789abcdef")));
        expect((await fresh.load())!.cookies[0]!.value).toBe("nueva00123456789abcdef");
    });

    it("una semilla rechazada no se reintenta en otra instancia", async () => {
        const kv = new MemoryKv();
        const box = new KvSecretBox(randomBytes(32));
        const seed = encodeSnapshot(seedSnapshot());
        await new KvWebSessionSource(kv, box, PREFIX, seed).invalidate(seedSnapshot().revision);
        expect(await new KvWebSessionSource(kv, box, PREFIX, seed).load()).toBeNull();
    });

    it("una rotación de la sesión se guarda en el KV y la ve la otra instancia", async () => {
        const r = await remote({ seed: encodeSnapshot(seedSnapshot()) });
        r.h.fake.web.rotateTo = "rotada9876543210fedcba";
        const op = await r.a.web.open();
        await op.get("/user/profile.php", null).catch(() => null);
        await r.a.web.afterOperation(op);
        const seen = await new KvWebSessionSource(r.kv, r.box, PREFIX, encodeSnapshot(seedSnapshot())).load();
        expect(seen!.cookies.find((c) => c.name === "MoodleSession")!.value).toBe("rotada9876543210fedcba");
    });
});

describe("login automático remoto (ADR-127)", () => {
    it("sin sesión: inicia sesión sola con la confianza del remoto (sin correo) y la deja en el KV para todas las instancias", async () => {
        const r = await remote();
        const op = await r.a.web.open();
        expect(op.userId).toBe(USER_ID);
        expect(r.login.emails.length).toBe(r.emailsAtStart);
        const before = loginPosts(r.h);
        expect((await r.b.web.open()).userId).toBe(USER_ID); // la otra instancia reusa la sesión del KV
        expect(loginPosts(r.h)).toBe(before);
        expect((await autoLoginStatus(r.a.backend)).last).toMatchObject({ ok: true, mfa: "dispositivo_de_confianza" });
    });

    it("sesión vencida y dos instancias a la vez: un solo login (candado del KV)", async () => {
        let t = Date.now();
        const r = await remote({ now: () => new Date(t) });
        await r.a.web.open();
        r.login.expireWebSessions();
        t += AUTOLOGIN_MIN_INTERVAL_MS + 1000;
        const before = loginPosts(r.h);
        const ops = await Promise.all([r.a.web.open(), r.b.web.open()]);
        expect(ops.every((o) => o.userId === USER_ID)).toBe(true);
        expect(loginPosts(r.h) - before).toBe(1);
        expect(r.kv.data.has(`${PREFIX}:lock`)).toBe(false);
    });

    it("sin confianza: AUTH_REQUIRED sin ninguna petición y sin correo, con la instrucción de renovarla", async () => {
        const r = await remote({ trust: "none" });
        const e = await r.a.web.open().catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(e.humanAction).toMatch(/remote autologin enable/);
        expect(loginPosts(r.h)).toBe(1); // sólo la puesta en marcha
        expect(r.login.emails.length).toBe(r.emailsAtStart);
        expect((await autoLoginStatus(r.a.backend)).needs_trust).not.toBeNull();
    });

    it("contraseña rechazada: se desactiva en todas las instancias; un enable nuevo (otra semilla) vuelve a empezar", async () => {
        const wrong = JSON.stringify({ username: LOGIN_USER, password: "equivocada" });
        const r = await remote({ login: wrong });
        expect(await codeOf(r.a.web.open())).toBe("AUTH_REJECTED");
        expect(r.login.failedPasswords).toBe(1);
        expect(await codeOf(r.b.web.open())).toBe("AUTH_REQUIRED");
        expect(r.login.failedPasswords).toBe(1); // nunca un segundo intento
        expect((await autoLoginStatus(r.b.backend)).disabled).not.toBeNull();
        const renewed = new KvAutoLoginBackend(r.kv, r.box, PREFIX, { login: LOGIN, trust: null }, PROFILE);
        expect((await renewed.readState()).disabled ?? null).toBeNull();
    });

    it("la huella de la semilla tiene clave: sin el secreto no sirve para probar contraseñas", async () => {
        const kv = new MemoryKv();
        const box = new KvSecretBox(randomBytes(32));
        await new KvAutoLoginBackend(kv, box, PREFIX, { login: LOGIN, trust: null }, PROFILE).writeState({});
        const stored = JSON.parse(kv.data.get(`${PREFIX}:autologin`) as string).seed as string;
        expect(stored).toBe(box.fingerprint(`${LOGIN}\n`));
        // Un hash sin clave del usuario y la contraseña se podría atacar sin conexión; éste no.
        expect(stored).not.toBe(createHash("sha256").update(`${LOGIN}\n`).digest("hex").slice(0, 16));
        expect(new KvSecretBox(randomBytes(32)).fingerprint(`${LOGIN}\n`)).not.toBe(stored);
    });

    it("la contraseña nunca llega al KV ni a los logs", async () => {
        const r = await remote();
        await r.a.web.open();
        const all = JSON.stringify([...r.kv.data.values()]) + r.logs.join("\n");
        expect(all).not.toContain(LOGIN_PASSWORD);
        expect(all).not.toContain(WEB_SESSION_OK);
    });

    it("candado: otra instancia espera y un candado abandonado vence", async () => {
        const kv = new MemoryKv();
        const box = new KvSecretBox(randomBytes(32));
        const b1 = new KvAutoLoginBackend(kv, box, PREFIX, { login: LOGIN, trust: null }, PROFILE);
        const b2 = new KvAutoLoginBackend(kv, box, PREFIX, { login: LOGIN, trust: null }, PROFILE);
        const release = await b1.lock();
        let second = false;
        const p = b2.lock().then((r2) => ((second = true), r2));
        await new Promise((r) => setTimeout(r, 50));
        expect(second).toBe(false);
        await release();
        await (await p)();
        expect(second).toBe(true);
        // Abandonado hace más de 90 s (una instancia cortada): se toma igual.
        kv.data.set(`${PREFIX}:lock`, `x.${Date.now() - 91_000}`);
        await (await b1.lock())();
    });
});

describe("configuración remota del login automático (ADR-127)", () => {
    const base = { PUBLIC_BASE_URL: "https://mcp.example.test", OAUTH_SIGNING_SECRET: randomBytes(32).toString("base64url"), GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", GITHUB_ALLOWED_USER_ID: "1", CAMPUS_MOODLE_TOKEN: "0123456789abcdef0123456789abcdef", CAMPUS_EXPECTED_USERID: "501" };
    const kv = { KV_REST_API_URL: "https://kv.example.test", KV_REST_API_TOKEN: "t" };
    const cfg = (env: Record<string, string>) => {
        const r = readRemoteConfig(env);
        if (!r.ok) throw new Error(r.missing.join(","));
        return r.config;
    };

    it("dos llaves y KV: sin cualquiera de las tres, no hay login automático", () => {
        expect(cfg({ ...base, ...kv, CAMPUS_WEB_AUTOLOGIN: "true", CAMPUS_WEB_LOGIN: LOGIN }).autologin).toMatchObject({ login: LOGIN, trust: null });
        expect(cfg({ ...base, ...kv, CAMPUS_WEB_LOGIN: LOGIN }).autologin).toBeNull();
        expect(cfg({ ...base, ...kv, CAMPUS_WEB_AUTOLOGIN: "true" }).autologin).toBeNull();
        expect(cfg({ ...base, CAMPUS_WEB_AUTOLOGIN: "true", CAMPUS_WEB_LOGIN: LOGIN }).autologin).toBeNull();
    });

    it("el KV de la sesión web no depende de las escrituras", () => {
        expect(cfg({ ...base, ...kv }).kv).toEqual({ url: kv.KV_REST_API_URL, token: "t" });
        expect(cfg({ ...base, ...kv }).write).toBeNull();
    });
});
