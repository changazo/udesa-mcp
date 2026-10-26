import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRemoteHandler } from "../../src/remote/handler.js";
import { TOOL_NAMES } from "../../src/mcp/server.js";
import { isAllowedRedirect } from "../../src/remote/oauth.js";
import { withRouteParam } from "../../src/remote/vercel.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeMoodle, NOW_UNIX, SITE, syntheticProfile, VALID_TOKEN } from "../fixtures/fake-moodle.js";
import { createDownloadLinks } from "../../src/remote/download-links.js";
import { MemoryKv, type KvClient } from "../../src/write/store.js";
import { FakeLogin, LOGIN_PASSWORD, LOGIN_USER } from "../fixtures/fake-login.js";

const BASE = "https://mcp.example.test";
const OWNER_GH = "1000001";
const SECRET = randomBytes(32).toString("base64url");
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

function setup(overrides: Record<string, string | undefined> = {}, ghUserId = Number(OWNER_GH), kv?: KvClient) {
    const fake = new FakeMoodle();
    const logs: string[] = [];
    let clock = NOW_UNIX * 1000;
    const env = {
        PUBLIC_BASE_URL: BASE,
        OAUTH_SIGNING_SECRET: SECRET,
        GITHUB_CLIENT_ID: "Iv1.sintetico",
        GITHUB_CLIENT_SECRET: "gh-secret-sintetico",
        GITHUB_ALLOWED_USER_ID: OWNER_GH,
        CAMPUS_MOODLE_TOKEN: VALID_TOKEN,
        CAMPUS_EXPECTED_USERID: "501",
        ...overrides,
    };
    const ghCalls: string[] = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        if (url.href === "https://github.com/login/oauth/access_token") {
            const body = new URLSearchParams(String(init?.body));
            ghCalls.push("token");
            const ok = body.get("code") === "gh-good-code" && body.get("client_secret") === "gh-secret-sintetico";
            return Response.json(ok ? { access_token: "gho_sintetico" } : { error: "bad_verification_code" });
        }
        if (url.href === "https://api.github.com/user") {
            ghCalls.push("user");
            return Response.json({ id: ghUserId, login: "alguien" });
        }
        return fake.fetch(input, init);
    };
    const handler = createRemoteHandler({
        env,
        fetch: fetchImpl,
        now: () => new Date(clock),
        logger: createLogger((l) => logs.push(l), "debug"),
        profile: syntheticProfile(),
        kv,
    });
    const call = (path: string, init: RequestInit = {}) => handler(new Request(`${BASE}${path}`, init));
    return { fake, logs, handler, call, ghCalls, advance: (ms: number) => (clock += ms) };
}

const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(call: ReturnType<typeof setup>["call"], redirect = CLAUDE_CB, extra: Record<string, unknown> = {}) {
    const res = await call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], ...extra }) });
    return { res, body: (await res.json()) as Record<string, string> };
}

/** Recorre consentimiento → GitHub → callback. Devuelve la URL final de redirección al cliente. */
async function authorize(s: ReturnType<typeof setup>, clientId: string, challenge: string, opts: { redirect?: string; cookie?: string; ghCode?: string } = {}) {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: opts.redirect ?? CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "estado-cliente", resource: `${BASE}/mcp` });
    const consent = await s.call(`/authorize?${q}`);
    expect(consent.status).toBe(200);
    const htmlText = await consent.text();
    const reqJwt = /name="request" value="([^"]+)"/.exec(htmlText)![1]!;
    const approve = await s.call("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: reqJwt }) });
    expect(approve.status).toBe(303);
    const gh = new URL(approve.headers.get("location")!);
    expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
    const cookie = opts.cookie ?? approve.headers.get("set-cookie")!.split(";")[0]!;
    const cb = await s.call(`/oauth/github/callback?${new URLSearchParams({ code: opts.ghCode ?? "gh-good-code", state: gh.searchParams.get("state")! })}`, { headers: { cookie } });
    return { cb, htmlText };
}

async function fullLogin(s: ReturnType<typeof setup>) {
    const { body: client } = await register(s.call);
    const { verifier, challenge } = pkce();
    const { cb } = await authorize(s, client.client_id!, challenge);
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get("location")!);
    const tok = await s.call("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id!, redirect_uri: CLAUDE_CB }),
    });
    expect(tok.status).toBe(200);
    return { client, tokens: (await tok.json()) as Record<string, string>, back, verifier };
}

const rpc = (s: ReturnType<typeof setup>, token: string | null, method: string, params: unknown = {}, id = 1) =>
    s.call("/mcp", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

describe("servidor remoto: metadata y registro", () => {
    it("publica metadata de recurso protegido y de servidor de autorización", async () => {
        const s = setup();
        const pr = await (await s.call("/.well-known/oauth-protected-resource/mcp")).json();
        expect(pr).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
        const as = await (await s.call("/.well-known/oauth-authorization-server")).json();
        expect(as).toMatchObject({ issuer: BASE, registration_endpoint: `${BASE}/register`, code_challenge_methods_supported: ["S256"] });
    });

    it("DCR acepta sólo callbacks de clientes conocidos y loopback", async () => {
        const s = setup();
        expect((await register(s.call)).res.status).toBe(201);
        expect((await register(s.call, "http://127.0.0.1:43123/callback")).res.status).toBe(201);
        expect((await register(s.call, "https://chatgpt.com/connector_platform_oauth_redirect")).res.status).toBe(201);
        const evil = await register(s.call, "https://evil.example.com/cb");
        expect(evil.res.status).toBe(400);
        expect(evil.body.error).toBe("invalid_redirect_uri");
    });

    it.each([
        ["https://claude.ai/api/mcp/auth_callback", true],
        ["https://claude.com/api/mcp/auth_callback", true],
        ["https://chatgpt.com/connector/oauth/abc_123", true],
        ["http://localhost:8976/oauth/callback", true],
        ["https://claude.ai.evil.example.com/api/mcp/auth_callback", false],
        ["https://claude.ai/otra/ruta", false],
        ["http://claude.ai/api/mcp/auth_callback", false],
        ["https://user@chatgpt.com/connector/oauth/x", false],
        ["javascript:alert(1)", false],
    ])("redirect %s → %s", (u, ok) => {
        expect(isAllowedRedirect(u)).toBe(ok);
    });
});

describe("servidor remoto: login y tokens", () => {
    it("flujo completo: consentimiento → GitHub (dueño) → código → token → MCP", async () => {
        const s = setup();
        const { tokens, back } = await fullLogin(s);
        expect(back.origin + back.pathname).toBe(CLAUDE_CB);
        expect(back.searchParams.get("state")).toBe("estado-cliente");
        expect(tokens.token_type).toBe("Bearer");

        const init = await rpc(s, tokens.access_token!, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
        expect(init.status).toBe(200);
        expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("udesa-campus-mcp");

        const list = await rpc(s, tokens.access_token!, "tools/list", {}, 2);
        const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools;
        expect(tools).toHaveLength(TOOL_NAMES.length);

        const call = await rpc(s, tokens.access_token!, "tools/call", { name: "campus_list_announcements", arguments: { course_id: 4242, limit: 2 } }, 3);
        const result = ((await call.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
        expect(result.isError).toBeFalsy();
        const body = JSON.parse(result.content[0]!.text);
        expect(body.data.announcements).toHaveLength(2);
        expect(body.source.site_url).toBe("https://campus.example.test");
    });

    it("la página de consentimiento escapa el nombre del cliente y advierte", async () => {
        const s = setup();
        const { body: client } = await register(s.call, CLAUDE_CB, { client_name: '<script>alert(1)</script>' });
        const { challenge } = pkce();
        const q = new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256" });
        const res = await s.call(`/authorize?${q}`);
        const text = await res.text();
        expect(text).not.toContain("<script>alert");
        expect(text).toContain("&lt;script&gt;");
        expect(text).toMatch(/Aprobá sólo si/);
        expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    });

    it("rechaza otra cuenta de GitHub", async () => {
        const s = setup({}, 42);
        const { body: client } = await register(s.call);
        const { cb } = await authorize(s, client.client_id!, pkce().challenge);
        expect(cb.status).toBe(403);
        expect(cb.headers.get("location")).toBeNull();
    });

    it("rechaza un callback de GitHub sin la cookie del navegador que inició el flujo", async () => {
        const s = setup();
        const { body: client } = await register(s.call);
        const { cb } = await authorize(s, client.client_id!, pkce().challenge, { cookie: "__Host-campus_flow=otro" });
        expect(cb.status).toBe(400);
        expect(s.ghCalls).toEqual([]); // ni siquiera se canjeó el código con GitHub
    });

    it("rechaza redirect_uri no registrado y PKCE ausente", async () => {
        const s = setup();
        const { body: client } = await register(s.call);
        const bad = new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: "http://localhost:1/x", code_challenge: pkce().challenge, code_challenge_method: "S256" });
        expect((await s.call(`/authorize?${bad}`)).status).toBe(400);
        const noPkce = new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: CLAUDE_CB });
        expect((await s.call(`/authorize?${noPkce}`)).status).toBe(400);
    });

    it("PKCE incorrecto, otro cliente o código vencido no canjean", async () => {
        const s = setup();
        const { body: client } = await register(s.call);
        const { body: other } = await register(s.call);
        const { challenge } = pkce();
        const { cb } = await authorize(s, client.client_id!, challenge);
        const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
        const exchange = (clientId: string, verifier: string) =>
            s.call("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CB }) });
        expect(((await (await exchange(client.client_id!, pkce().verifier)).json()) as { error: string }).error).toBe("invalid_grant");
        expect(((await (await exchange(other.client_id!, pkce().verifier)).json()) as { error: string }).error).toBe("invalid_grant");
        s.advance(5 * 60_000);
        expect((await exchange(client.client_id!, pkce().verifier)).status).toBe(400);
    });

    it("refresh token renueva; no sirve como access token; un token ajeno es 401", async () => {
        const s = setup();
        const { client, tokens } = await fullLogin(s);
        const r = await s.call("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: client.client_id! }) });
        expect(r.status).toBe(200);
        expect((await rpc(s, tokens.refresh_token!, "tools/list")).status).toBe(401);

        const other = setup({ OAUTH_SIGNING_SECRET: randomBytes(32).toString("base64url") });
        const o = await fullLogin(other);
        expect((await rpc(s, o.tokens.access_token!, "tools/list")).status).toBe(401); // firmado con otra clave
    });

    it("access token vencido → 401 con WWW-Authenticate para reautorizar", async () => {
        const s = setup();
        const { tokens } = await fullLogin(s);
        s.advance(2 * 3600_000);
        const res = await rpc(s, tokens.access_token!, "tools/list");
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    });

    it("/mcp sin token → 401 con resource_metadata (requisito de claude.ai)", async () => {
        const s = setup();
        const res = await rpc(s, null, "tools/list");
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Bearer .*resource_metadata=/);
        expect(s.fake.calls).toHaveLength(0);
    });
});

describe("servidor remoto: operación", () => {
    it("token de Moodle vencido → AUTH_REQUIRED con instrucción de renovarlo, no lista vacía", async () => {
        const s = setup();
        const { tokens } = await fullLogin(s);
        s.fake.validTokens.delete(VALID_TOKEN);
        const call = await rpc(s, tokens.access_token!, "tools/call", { name: "campus_list_announcements", arguments: { course_id: 4242 } });
        const result = ((await call.json()) as { result: { content: { text: string }[]; isError: boolean } }).result;
        expect(result.isError).toBe(true);
        const err = JSON.parse(result.content[0]!.text).error;
        expect(err.code).toBe("AUTH_REQUIRED");
        expect(err.human_action).toContain("remote push-token");
    });

    it("identidad de Moodle distinta de la esperada → no se exponen datos", async () => {
        const s = setup({ CAMPUS_EXPECTED_USERID: "999" });
        const { tokens } = await fullLogin(s);
        const call = await rpc(s, tokens.access_token!, "tools/call", { name: "campus_list_courses", arguments: {} });
        const result = ((await call.json()) as { result: { content: { text: string }[]; isError: boolean } }).result;
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text).error.code).toBe("IDENTITY_MISMATCH");
    });

    it("configuración incompleta → 503 sin revelar valores", async () => {
        const s = setup({ GITHUB_CLIENT_SECRET: undefined, OAUTH_SIGNING_SECRET: "corto" });
        const health = await s.call("/health");
        expect(health.status).toBe(503);
        const text = await (await s.call("/.well-known/oauth-authorization-server")).text();
        expect(text).not.toContain("corto");
        expect(text).not.toContain(VALID_TOKEN);
    });

    it("ningún secreto aparece en logs", async () => {
        const s = setup();
        const { tokens } = await fullLogin(s);
        await rpc(s, tokens.access_token!, "tools/call", { name: "campus_list_announcements", arguments: { course_id: 4242, limit: 1 } });
        const all = s.logs.join("\n");
        for (const secret of [VALID_TOKEN, SECRET, "gh-secret-sintetico", "gho_sintetico", "gh-good-code", tokens.access_token!, tokens.refresh_token!]) {
            expect(all).not.toContain(secret);
        }
    });

    it("el adaptador de Vercel reconstruye la ruta reescrita", async () => {
        const seen: string[] = [];
        const h = withRouteParam(async (r) => {
            seen.push(new URL(r.url).pathname + new URL(r.url).search);
            return new Response("ok");
        });
        await h(new Request(`${BASE}/api?__route=/authorize&client_id=x`));
        await h(new Request(`${BASE}/token`));
        expect(seen).toEqual(["/authorize?client_id=x", "/token"]);
    });
});

describe("adaptador de Vercel con cuerpo", () => {
    it("preserva el cuerpo de un POST reescrito", async () => {
        const h = withRouteParam(async (r) => new Response(`${new URL(r.url).pathname}|${await r.text()}`));
        const res = await h(new Request(`${BASE}/api?__route=/token`, { method: "POST", body: "grant_type=x", headers: { "content-type": "application/x-www-form-urlencoded" } }));
        expect(await res.text()).toBe("/token|grant_type=x");
    });
});

describe("MCP en la raíz (caso real de ChatGPT con la URL sin /mcp)", () => {
    const rootRpc = (s: ReturnType<typeof setup>, token: string | null, method: string, params: unknown = {}) =>
        s.call("/", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });

    it("POST / sin token → 401 apuntando a la metadata de la raíz; GET / sigue siendo HTML", async () => {
        const s = setup();
        const res = await rootRpc(s, null, "tools/list");
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
        const meta = await (await s.call("/.well-known/oauth-protected-resource")).json();
        expect(meta.resource).toBe(BASE);
        expect((await s.call("/")).headers.get("content-type")).toContain("text/html");
    });

    it("flujo con resource=raíz: el token sirve en / y en /mcp", async () => {
        const s = setup();
        const { body: client } = await register(s.call, "https://chatgpt.com/connector_platform_oauth_redirect");
        const { verifier, challenge } = pkce();
        const q = new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", code_challenge: challenge, code_challenge_method: "S256", resource: BASE, state: "x" });
        const consent = await s.call(`/authorize?${q}`);
        const reqJwt = /name="request" value="([^"]+)"/.exec(await consent.text())![1]!;
        const approve = await s.call("/authorize", { method: "POST", body: new URLSearchParams({ request: reqJwt }) });
        const gh = new URL(approve.headers.get("location")!);
        const cb = await s.call(`/oauth/github/callback?${new URLSearchParams({ code: "gh-good-code", state: gh.searchParams.get("state")! })}`, { headers: { cookie: approve.headers.get("set-cookie")!.split(";")[0]! } });
        const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
        const tok = (await (await s.call("/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id!, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }) })).json()) as Record<string, string>;
        const list = await rootRpc(s, tok.access_token!, "tools/list");
        expect(list.status).toBe(200);
        expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(TOOL_NAMES.length);
        expect((await rpc(s, tok.access_token!, "tools/list")).status).toBe(200);
    });

    it("rechaza un resource ajeno", async () => {
        const s = setup();
        const { body: client } = await register(s.call);
        const q = new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: CLAUDE_CB, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: "https://otro.example.test/mcp" });
        expect((await s.call(`/authorize?${q}`)).status).toBe(400);
    });
});

describe("CSP del consentimiento (regresión: segunda conexión de ChatGPT bloqueada)", () => {
    it("form-action permite el origen del callback de ESTE cliente y nada más", async () => {
        const s = setup();
        const cb = "https://chatgpt.com/connector_platform_oauth_redirect";
        const { body: client } = await register(s.call, cb);
        const q = new URLSearchParams({ response_type: "code", client_id: client.client_id!, redirect_uri: cb, code_challenge: pkce().challenge, code_challenge_method: "S256" });
        const csp = (await s.call(`/authorize?${q}`)).headers.get("content-security-policy")!;
        expect(csp).toContain("form-action 'self' https://github.com https://chatgpt.com;");
        expect(csp).not.toContain("claude.ai");
        const loop = await register(s.call, "http://127.0.0.1:43123/callback");
        const q2 = new URLSearchParams({ response_type: "code", client_id: loop.body.client_id!, redirect_uri: "http://127.0.0.1:43123/callback", code_challenge: pkce().challenge, code_challenge_method: "S256" });
        expect((await s.call(`/authorize?${q2}`)).headers.get("content-security-policy")).toContain("form-action 'self' https://github.com http://127.0.0.1:43123;");
    });
});

describe("file_ref entre instancias (regresión: Vercel en frío)", () => {
    it("una referencia emitida por una instancia se lee en otra con el mismo secreto", async () => {
        const a = setup();
        const b = setup(); // otra instancia: memoria vacía, mismo OAUTH_SIGNING_SECRET
        const { tokens } = await fullLogin(a);
        const course = await rpc(a, tokens.access_token!, "tools/call", { name: "campus_get_course", arguments: { course_id: 4242 } });
        const body = JSON.parse(((await course.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text);
        const ref = body.data.sections[0].modules.find((m: { course_module_id: number }) => m.course_module_id === 9003).files.find((f: { name: string }) => f.name === "consigna.txt").ref;
        const read = await rpc(b, tokens.access_token!, "tools/call", { name: "campus_read_file", arguments: { file_ref: ref } });
        const result = ((await read.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
        expect(result.isError).toBeFalsy();
        expect(JSON.parse(result.content[0]!.text).data.text).toBe("Consigna sintética: entregar el TP.");
    });
});

describe("servidor remoto: enlaces temporales de descarga (ADR-113)", () => {
    it("sirve el original con un enlace firmado; alterado o vencido → 410; sin token OAuth", async () => {
        const s = setup();
        const links = createDownloadLinks(Buffer.from(SECRET, "base64url"), BASE, () => new Date(NOW_UNIX * 1000));
        const { url } = links.mint({ url: `${SITE}/webservice/pluginfile.php/111/mod_resource/content/0/consigna.txt`, name: "Clase 10 - Consigna.txt", mime: "text/plain", course_id: 4242 });
        const path = new URL(url).pathname;
        const ok = await s.call(path);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toMatch(/Consigna/);
        expect(ok.headers.get("content-disposition")).toContain("filename*=UTF-8''Clase%2010%20-%20Consigna.txt");
        expect(ok.headers.get("cache-control")).toBe("no-store");
        const bad = await s.call(path.replace(/\.[A-Za-z0-9_-]+\//, ".AAAA/"));
        expect(bad.status).toBe(410);
        s.advance(16 * 60 * 1000);
        expect((await s.call(path)).status).toBe(410);
    });
});

describe("servidor remoto: login web automático (ADR-127)", () => {
    const TRUST_VALUE = "confianza-remota-sintetica";
    const env = (extra: Record<string, string> = {}) => ({
        KV_REST_API_URL: "https://kv.example.test",
        KV_REST_API_TOKEN: "kv-token",
        CAMPUS_WEB_AUTOLOGIN: "true",
        CAMPUS_WEB_LOGIN: JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASSWORD }),
        // Vence 28 días después del reloj real (el login filtra cookies vencidas con la hora real).
        CAMPUS_WEB_TRUST: JSON.stringify([{ name: "MFA_TOKEN_501", value: TRUST_VALUE, expires: Math.floor(Date.now() / 1000) + 28 * 86_400 }]),
        ...extra,
    });
    const tool = async (s: ReturnType<typeof setup>, token: string, name: string, args: Record<string, unknown>) => {
        const res = await rpc(s, token, "tools/call", { name, arguments: args });
        const result = ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
        return { isError: !!result.isError, body: JSON.parse(result.content[0]!.text) };
    };

    it("sin sesión web, una lectura web inicia sesión sola (sin código), como «remoto», y campus_get_status lo muestra", async () => {
        const kv = new MemoryKv();
        const s = setup(env(), undefined, kv);
        const login = new FakeLogin(s.fake.web, SITE, 501);
        login.trustTokens.add(TRUST_VALUE);
        const { tokens } = await fullLogin(s);
        // Una lectura que usa la sesión web (el armado del cuestionario no está simulado acá: alcanza con
        // que la sesión exista y la operación pase de la autenticación).
        const r = await tool(s, tokens.access_token!, "campus_get_quiz_structure", { course_id: 4242, quiz_id: 701 });
        expect(r.body.error?.code).not.toBe("AUTH_REQUIRED");
        expect(s.fake.web.requests.filter((q) => q.method === "POST" && q.path === "/login/index.php")).toHaveLength(1);
        expect(login.emails).toHaveLength(0);
        expect(kv.data.has("web:sintetico:session")).toBe(true);
        expect(s.fake.web.requests.filter((q) => q.path === "/login/index.php").every((q) => /\(MCP del Campus; remoto\)/.test(q.userAgent ?? ""))).toBe(true);
        const st = await tool(s, tokens.access_token!, "campus_get_status", {});
        expect(st.body.data?.web_autologin ?? st.body.web_autologin).toMatchObject({ enabled: true, configured: true, disabled: null, needs_trust: null });
        expect(s.logs.join("\n")).not.toContain(LOGIN_PASSWORD);
        expect(JSON.stringify([...kv.data.values()])).not.toContain(LOGIN_PASSWORD);
    });

    it("sin la segunda llave no hay login automático: AUTH_REQUIRED y el estado dice enabled=false", async () => {
        const s = setup(env({ CAMPUS_WEB_AUTOLOGIN: "false" }), undefined, new MemoryKv());
        const login = new FakeLogin(s.fake.web, SITE, 501);
        login.trustTokens.add(TRUST_VALUE);
        const { tokens } = await fullLogin(s);
        const r = await tool(s, tokens.access_token!, "campus_get_quiz_structure", { course_id: 4242, quiz_id: 701 });
        expect(r.isError).toBe(true);
        expect(r.body.error.code).toBe("AUTH_REQUIRED");
        expect(s.fake.web.requests.some((q) => q.path === "/login/index.php")).toBe(false);
        const st = await tool(s, tokens.access_token!, "campus_get_status", {});
        expect(st.body.data?.web_autologin ?? st.body.web_autologin).toEqual({ enabled: false });
    });

    it("si el Campus pide el código, el error indica cómo renovar la confianza desde la PC (no los comandos locales)", async () => {
        const s = setup(env(), undefined, new MemoryKv());
        new FakeLogin(s.fake.web, SITE, 501); // la confianza del remoto no está registrada en el Campus
        const { tokens } = await fullLogin(s);
        const r = await tool(s, tokens.access_token!, "campus_get_quiz_structure", { course_id: 4242, quiz_id: 701 });
        expect(r.body.error.code).toBe("AUTH_REQUIRED");
        expect(r.body.error.message).toContain("campus remote autologin enable");
        expect(r.body.error.message).not.toMatch(/(?<!remote )autologin enable(?! \(en tu PC)/);
        expect(r.body.error.human_action).toContain("campus remote autologin enable");
        const st = await tool(s, tokens.access_token!, "campus_get_status", {});
        expect((st.body.data?.web_autologin ?? st.body.web_autologin).action_needed).toMatch(/renovar la confianza/);
    });
});

