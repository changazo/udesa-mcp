import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRemoteHandler } from "../../src/remote/handler.js";
import { createLogger } from "../../src/util/logger.js";
import { MemoryKv } from "../../src/write/store.js";
import { FakeMoodle, NOW_UNIX, SITE, syntheticProfile, VALID_TOKEN } from "../fixtures/fake-moodle.js";
import { FakeLogin, LOGIN_PASSWORD, LOGIN_USER } from "../fixtures/fake-login.js";

/** ADR-141: panel privado /admin/conexion de punta a punta sobre el handler remoto. Todo sintético. */

const BASE = "https://mcp.example.test";
const OWNER_GH = "168579619";
const SECRET = randomBytes(32).toString("base64url");
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const TRUST_VALUE = "confianza-remota-sintetica";

function setup() {
    const fake = new FakeMoodle();
    const kv = new MemoryKv();
    const logs: string[] = [];
    const clock = { ms: NOW_UNIX * 1000 };
    const env = {
        PUBLIC_BASE_URL: BASE,
        OAUTH_SIGNING_SECRET: SECRET,
        GITHUB_CLIENT_ID: "Iv1.sintetico",
        GITHUB_CLIENT_SECRET: "gh-secret-sintetico",
        GITHUB_ALLOWED_USER_ID: OWNER_GH,
        CAMPUS_MOODLE_TOKEN: VALID_TOKEN,
        CAMPUS_EXPECTED_USERID: "501",
        KV_REST_API_URL: "https://kv.example.test",
        KV_REST_API_TOKEN: "kv-token",
        CAMPUS_WEB_AUTOLOGIN: "true",
        CAMPUS_WEB_LOGIN: JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASSWORD }),
        CAMPUS_WEB_TRUST: JSON.stringify([{ name: "MFA_TOKEN_501", value: TRUST_VALUE, expires: Math.floor(Date.now() / 1000) + 28 * 86_400 }]),
    };
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        if (url.href === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_sintetico" });
        if (url.href === "https://api.github.com/user") return Response.json({ id: Number(OWNER_GH), login: "alguien" });
        return fake.fetch(input, init);
    };
    const handler = createRemoteHandler({ env, fetch: fetchImpl, now: () => new Date(clock.ms), logger: createLogger((l) => logs.push(l), "debug"), profile: syntheticProfile(), kv });
    const call = (path: string, init: RequestInit = {}) => handler(new Request(`${BASE}${path}`, init));
    const login = new FakeLogin(fake.web, SITE, 501);
    login.trustTokens.add(TRUST_VALUE);
    return { fake, kv, logs, call, login, clock };
}
type S = ReturnType<typeof setup>;

const loginRequests = (s: S) => s.fake.web.requests.filter((r) => r.path.startsWith("/login") || r.path.startsWith("/admin/tool/mfa")).length;
const cookieFrom = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? null;
const formOf = (html: string, action: string) => new RegExp(`action="/admin/conexion/${action}"[^>]*><input type="hidden" name="form" value="([^"]+)"`).exec(html)?.[1] ?? null;

/** GitHub del dueño → cookie de aprobador → GET del panel (que fija el vínculo del navegador). */
async function openPanel(s: S) {
    const first = await s.call("/admin/conexion");
    expect(first.status).toBe(303);
    const gh = new URL(first.headers.get("location")!);
    expect(gh.origin).toBe("https://github.com");
    const nonce = first.headers.get("set-cookie")!.split(";")[0]!;
    const cb = await s.call(`/oauth/github/callback?${new URLSearchParams({ code: "gh-good-code", state: gh.searchParams.get("state")! })}`, { headers: { cookie: nonce } });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(`${BASE}/admin/conexion`);
    const approver = cookieFrom(cb, "__Host-campus_approver")!;
    const page = await s.call("/admin/conexion", { headers: { cookie: approver } });
    expect(page.status).toBe(200);
    const bind = cookieFrom(page, "__Host-campus_connection")!;
    expect(page.headers.getSetCookie().join(";")).toMatch(/__Host-campus_connection=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    const cookie = `${approver}; ${bind}`;
    return { cookie, approver, html: await page.text(), referrerPolicy: page.headers.get("referrer-policy") };
}

const get = async (s: S, cookie: string, query = "") => (await s.call(`/admin/conexion${query}`, { headers: { cookie } })).text();
const post = (s: S, action: string, cookie: string | null, body: Record<string, string>, headers: Record<string, string> = {}) =>
    s.call(`/admin/conexion/${action}`, { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...headers }, body: new URLSearchParams(body) });

describe("panel /admin/conexion (ADR-141)", () => {
    it("GET sólo muestra: no inicia login ni manda correos; pide GitHub si no hay sesión del dueño", async () => {
        const s = setup();
        const { html } = await openPanel(s);
        expect(html).toContain("Conexión con el Campus");
        expect(formOf(html, "iniciar")).toBeTruthy();
        expect(html).toContain("Enviar código y renovar");
        expect(loginRequests(s)).toBe(0);
        expect(s.login.emails).toHaveLength(0);
    });

    it("la página no usa no-referrer: Chrome mandaría `Origin: null` y el control de origen rechazaría el formulario", async () => {
        const s = setup();
        const { referrerPolicy } = await openPanel(s);
        expect(referrerPolicy).toBe("same-origin");
    });

    it("renovación completa por el panel: iniciar → código → 303 con resultado cerrado → diagnóstico listo", async () => {
        const s = setup();
        const { cookie, html } = await openPanel(s);
        const start = await post(s, "iniciar", cookie, { form: formOf(html, "iniciar")! });
        expect(start.status).toBe(303);
        expect(start.headers.get("location")).toBe("/admin/conexion?estado=awaiting_code");
        expect(start.headers.get("cache-control")).toBe("no-store");
        expect(s.login.emails).toHaveLength(1);
        const waiting = await get(s, cookie, "?estado=awaiting_code");
        expect(waiting).toMatch(/inputmode="numeric" autocomplete="one-time-code" maxlength="6"/);
        expect(waiting).toContain("No recibí el código");
        const code = s.login.lastCode!;
        const done = await post(s, "completar", cookie, { form: formOf(waiting, "completar")!, code });
        expect(done.status).toBe(303);
        const loc = done.headers.get("location")!;
        expect(loc).toBe("/admin/conexion?estado=committed&diag=ready");
        expect(loc).not.toContain(code);
        const after = await get(s, cookie, "?estado=committed&diag=ready");
        expect(after).toContain("Conexión renovada y verificada.");
        expect(after).toContain("vigente");
        // Ni la contraseña ni el código quedan en logs.
        const logs = s.logs.join("\n");
        expect(logs).not.toContain(LOGIN_PASSWORD);
        expect(logs).not.toContain(`"${code}"`);
    });

    it("CSRF y vínculo: sin Origin, Origin ajeno, otro content-type, sin vínculo o sin dueño → nada cambia", async () => {
        const s = setup();
        const { cookie, approver, html } = await openPanel(s);
        const form = formOf(html, "iniciar")!;
        expect((await post(s, "iniciar", cookie, { form }, { origin: "" })).status).toBe(403);
        expect((await post(s, "iniciar", cookie, { form }, { origin: "https://evil.example" })).status).toBe(403);
        expect((await s.call("/admin/conexion/iniciar", { method: "POST", headers: { origin: BASE, cookie, "content-type": "application/json" }, body: JSON.stringify({ form }) })).status).toBe(400);
        expect((await post(s, "iniciar", approver, { form })).status).toBe(403);
        expect((await post(s, "iniciar", null, { form })).status).toBe(401);
        // Un vínculo distinto (otro navegador) no valida el formulario firmado para este.
        expect((await post(s, "iniciar", `${approver}; __Host-campus_connection=otro-navegador`, { form })).status).toBe(409);
        // El formulario de una acción no sirve para otra.
        expect((await post(s, "completar", cookie, { form, code: "123456" })).status).toBe(409);
        // GET a una acción no existe (nunca se inicia nada por GET).
        expect((await s.call("/admin/conexion/iniciar", { headers: { cookie } })).status).toBe(404);
        expect(loginRequests(s)).toBe(0);
    });

    it("repetir el mismo formulario no produce un segundo efecto", async () => {
        const s = setup();
        const { cookie, html } = await openPanel(s);
        const form = formOf(html, "iniciar")!;
        expect((await post(s, "iniciar", cookie, { form })).headers.get("location")).toBe("/admin/conexion?estado=awaiting_code");
        const replay = await post(s, "iniciar", cookie, { form });
        expect(replay.status).toBe(303);
        expect(replay.headers.get("location")).toBe("/admin/conexion");
        expect(s.fake.web.requests.filter((r) => r.method === "POST" && r.path === "/login/index.php")).toHaveLength(1);
    });

    it("código mal formado: 303 con codigo=formato y el formulario sigue disponible", async () => {
        const s = setup();
        const { cookie, html } = await openPanel(s);
        await post(s, "iniciar", cookie, { form: formOf(html, "iniciar")! });
        const waiting = await get(s, cookie);
        const r = await post(s, "completar", cookie, { form: formOf(waiting, "completar")!, code: "12ab" });
        expect(r.headers.get("location")).toBe("/admin/conexion?estado=awaiting_code&codigo=formato");
        const again = await get(s, cookie, "?estado=awaiting_code&codigo=formato");
        expect(again).toContain("El código son seis dígitos: no se envió nada.");
        expect(formOf(again, "completar")).toBeTruthy();
        expect(s.fake.web.requests.filter((q) => q.method === "POST" && q.path === "/admin/tool/mfa/auth.php")).toHaveLength(0);
    });

    it("valores de la URL fuera de las listas cerradas se ignoran (sin texto libre reflejado)", async () => {
        const s = setup();
        const { cookie } = await openPanel(s);
        const html = await get(s, cookie, "?estado=<script>x</script>&motivo=hackeo&diag=x");
        expect(html).not.toContain("<script>x</script>");
        expect(html).not.toContain("hackeo");
    });

    it("cancelar desde el panel deja de esperar el código", async () => {
        const s = setup();
        const { cookie, html } = await openPanel(s);
        await post(s, "iniciar", cookie, { form: formOf(html, "iniciar")! });
        const waiting = await get(s, cookie);
        const r = await post(s, "cancelar", cookie, { form: formOf(waiting, "cancelar")! });
        expect(r.headers.get("location")).toBe("/admin/conexion?estado=cancelled");
        expect(formOf(await get(s, cookie), "completar")).toBeNull();
    });
});

// ---------- campus_get_status con verify_web y `connection` por el MCP remoto ----------

async function mcpToken(s: S) {
    const reg = await s.call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CB] }) });
    const client = (await reg.json()) as Record<string, string>;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "e", resource: `${BASE}/mcp` });
    const consent = await (await s.call(`/authorize?${q}`)).text();
    const reqJwt = /name="request" value="([^"]+)"/.exec(consent)![1]!;
    const approve = await s.call("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: reqJwt }) });
    const gh = new URL(approve.headers.get("location")!);
    const cb = await s.call(`/oauth/github/callback?${new URLSearchParams({ code: "gh-good-code", state: gh.searchParams.get("state")! })}`, { headers: { cookie: approve.headers.get("set-cookie")!.split(";")[0]! } });
    const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
    const tok = await s.call("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id!, redirect_uri: CLAUDE_CB }) });
    return ((await tok.json()) as Record<string, string>).access_token!;
}

async function status(s: S, token: string, args: Record<string, unknown>) {
    const res = await s.call("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "campus_get_status", arguments: args } }),
    });
    const body = JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text);
    return (body.data ?? body).connection as Record<string, any>;
}

describe("campus_get_status: conexión por capas (ADR-141)", () => {
    it("sin flags no hay red de autenticación; verify_web prueba la sesión; los dos corren el diagnóstico completo", async () => {
        const s = setup();
        const token = await mcpToken(s);
        // Migración legacy: confianza vigente, todavía sin sesión web publicada.
        const plain = await status(s, token, {});
        expect(plain).toMatchObject({ schema_version: 1, mode: "remote", device_trust: { state: "valid" }, web_session: { present: false, state: "not_checked" }, persistence: { state: "ok" } });
        expect(loginRequests(s)).toBe(0);
        const web = await status(s, token, { verify_web: true });
        expect(web.web_session).toMatchObject({ state: "failed", reason: "sin_sesion_publicada" });
        expect(loginRequests(s)).toBe(0); // verify_web nunca inicia sesión
        // Renovación por el panel → luego el diagnóstico completo queda «ok» en todas las capas.
        const { cookie, html } = await openPanel(s);
        await post(s, "iniciar", cookie, { form: formOf(html, "iniciar")! });
        await post(s, "completar", cookie, { form: formOf(await get(s, cookie), "completar")!, code: s.login.lastCode! });
        const full = await status(s, token, { verify: true, verify_web: true });
        expect(full).toMatchObject({ api_token: { state: "ok" }, web_session: { state: "ok", present: true }, device_trust: { state: "valid" }, last_diagnostic: { result: "ready" }, action: null });
        expect(JSON.stringify(full)).not.toMatch(/sealed|MoodleSession|confianza/);
    });

    it("con la confianza vencida, `connection.action` lleva al panel", async () => {
        const s = setup();
        s.clock.ms = Date.now() + 40 * 86_400_000; // más allá del vencimiento de la confianza legacy
        const token = await mcpToken(s);
        const c = await status(s, token, {});
        expect(c.device_trust.state).toBe("expired");
        expect(c.action).toMatchObject({ kind: "renew_web_trust", url: `${BASE}/admin/conexion` });
    });
});
