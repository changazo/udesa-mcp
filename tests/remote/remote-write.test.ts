import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRemoteHandler } from "../../src/remote/handler.js";
import { createLogger } from "../../src/util/logger.js";
import { parseWriteProfile } from "../../src/write/policy.js";
import { MemoryKv } from "../../src/write/store.js";
import { COURSE, FakeMoodle, NOW_UNIX, syntheticProfile, VALID_TOKEN } from "../fixtures/fake-moodle.js";
import { SyntheticMarkers } from "../fixtures/fake-write.js";
import { writeProfileJson } from "../fixtures/write-harness.js";

/** W5 · escrituras remotas (ADR-060): endpoint, alcance, página de aprobación y KV. */

const BASE = "https://mcp.example.test";
const OWNER_GH = "1000001";
const SECRET = randomBytes(32).toString("base64url");
const CB = "https://claude.ai/api/mcp/auth_callback";

function setup(opts: { env?: Record<string, string | undefined>; kv?: MemoryKv; fake?: FakeMoodle; ghUser?: () => number; writeProfile?: Record<string, unknown> } = {}) {
    const fake = opts.fake ?? new FakeMoodle();
    const markers = new SyntheticMarkers(fake);
    const kv = opts.kv ?? new MemoryKv();
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
        CAMPUS_WRITE_ENABLED: "true",
        KV_REST_API_URL: "https://kv.example.test",
        KV_REST_API_TOKEN: "kv-token-sintetico",
        ...opts.env,
    };
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        if (url.href === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_sintetico" });
        if (url.href === "https://api.github.com/user") return Response.json({ id: opts.ghUser?.() ?? Number(OWNER_GH) });
        return fake.fetch(input, init);
    };
    const handler = createRemoteHandler({
        env,
        fetch: fetchImpl,
        now: () => new Date(clock.ms),
        logger: createLogger((l) => logs.push(l), "debug"),
        profile: syntheticProfile(),
        writeProfile: parseWriteProfile(writeProfileJson(opts.writeProfile), syntheticProfile()),
        kv,
    });
    const call = (path: string, init: RequestInit = {}) => handler(new Request(path.startsWith("http") ? path : `${BASE}${path}`, init));
    return { fake, markers, kv, logs, call, clock };
}
type S = ReturnType<typeof setup>;

async function login(s: S, resource = `${BASE}/mcp-escritura`) {
    const reg = (await (await s.call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB] }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256", state: "e", resource });
    const consent = await s.call(`/authorize?${q}`);
    const text = await consent.text();
    if (consent.status !== 200) return { status: consent.status, text, token: null as string | null };
    const reqJwt = /name="request" value="([^"]+)"/.exec(text)![1]!;
    const approve = await s.call("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: reqJwt }) });
    const gh = new URL(approve.headers.get("location")!);
    const cookie = approve.headers.get("set-cookie")!.split(";")[0]!;
    const cb = await s.call(`/oauth/github/callback?${new URLSearchParams({ code: "gh-good-code", state: gh.searchParams.get("state")! })}`, { headers: { cookie } });
    const back = new URL(cb.headers.get("location")!);
    const tok = (await (
        await s.call("/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: CB }),
        })
    ).json()) as { access_token: string; scope: string };
    return { status: 200, text, token: tok.access_token, scope: tok.scope };
}

async function rpc(s: S, path: string, token: string | null, method: string, params: unknown = {}) {
    const res = await s.call(path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as { result: { content?: { text: string }[]; tools?: { name: string }[]; isError?: boolean } }) : null, res };
}
const tool = async (s: S, token: string, name: string, args: Record<string, unknown>) => {
    const r = await rpc(s, "/mcp-escritura", token, "tools/call", { name, arguments: args });
    return { isError: !!r.body!.result.isError, data: JSON.parse(r.body!.result.content![0]!.text) };
};

/** Login del aprobador en la página: devuelve la cookie de aprobador. */
async function approverCookie(s: S, planId: string) {
    const first = await s.call(`/aprobar/${planId}`);
    expect(first.status).toBe(303);
    const gh = new URL(first.headers.get("location")!);
    expect(gh.origin).toBe("https://github.com");
    const nonce = first.headers.get("set-cookie")!.split(";")[0]!;
    const cb = await s.call(`/oauth/github/callback?${new URLSearchParams({ code: "gh-good-code", state: gh.searchParams.get("state")! })}`, { headers: { cookie: nonce } });
    return cb;
}

async function decide(s: S, planId: string, decision: "approved" | "rejected") {
    const cb = await approverCookie(s, planId);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(`${BASE}/aprobar/${planId}`);
    const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-campus_approver="))!.split(";")[0]!;
    const page = await s.call(`/aprobar/${planId}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const form = /name="form" value="([^"]+)"/.exec(html)![1]!;
    const res = await s.call(`/aprobar/${planId}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ form, decision }) });
    return { res, html, cookie };
}

describe("W5 · endpoint de escritura y alcance", () => {
    it("sin CAMPUS_WRITE_ENABLED: no hay endpoint ni se puede autorizar el recurso de escritura", async () => {
        const s = setup({ env: { CAMPUS_WRITE_ENABLED: undefined } });
        expect((await rpc(s, "/mcp-escritura", "x", "tools/list")).status).toBe(404);
        expect((await login(s)).status).toBe(400);
    });

    it("token de escritura sólo abre /mcp-escritura; token de lectura no lo abre; tools sin archivos locales", async () => {
        const s = setup();
        const w = await login(s);
        expect(w.text).toContain("ESCRITURA");
        expect(w.scope).toBe("campus.write");
        const r = await login(s, `${BASE}/mcp`);
        expect((await rpc(s, "/mcp-escritura", r.token, "tools/list")).status).toBe(401);
        expect((await rpc(s, "/mcp", w.token, "tools/list")).status).toBe(401);
        const list = await rpc(s, "/mcp-escritura", w.token, "tools/list");
        const names = list.body!.result.tools!.map((t) => t.name);
        expect(names).toContain("campus_plan_marcador_sintetico");
        expect(names).toContain("campus_execute_plan");
        expect(names).not.toContain("campus_plan_question_import");
        const unauth = await rpc(s, "/mcp-escritura", null, "tools/list");
        expect(unauth.res.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp-escritura");
        const meta = await (await s.call("/.well-known/oauth-protected-resource/mcp-escritura")).json();
        expect(meta).toMatchObject({ resource: `${BASE}/mcp-escritura`, scopes_supported: ["campus.write"] });
    });

    it("/mcp-completo (docente-completo): lecturas y escrituras en un conector; su token no abre /mcp-escritura ni al revés", async () => {
        const s = setup();
        const full = await login(s, `${BASE}/mcp-completo`);
        expect(full.scope).toBe("campus.write");
        const names = (await rpc(s, "/mcp-completo", full.token, "tools/list")).body!.result.tools!.map((t) => t.name);
        expect(names).toContain("campus_list_courses");
        expect(names).toContain("campus_plan_marcador_sintetico");
        expect(names).not.toContain("campus_plan_question_import");
        const w = await login(s);
        expect((await rpc(s, "/mcp-completo", w.token, "tools/list")).status).toBe(401);
        expect((await rpc(s, "/mcp-escritura", full.token, "tools/list")).status).toBe(401);
        expect((await rpc(s, "/mcp", full.token, "tools/list")).status).toBe(401);
        const r = await rpc(s, "/mcp-completo", full.token, "tools/call", { name: "campus_get_status", arguments: {} });
        expect(r.body!.result.isError ?? false).toBe(false);
        const meta = await (await s.call("/.well-known/oauth-protected-resource/mcp-completo")).json();
        expect(meta).toMatchObject({ resource: `${BASE}/mcp-completo`, scopes_supported: ["campus.write"] });
    });

    it("cliente que pide todos los scopes anunciados (caso real de Codex): el resource decide el alcance emitido", async () => {
        const s = setup();
        const reg = (await (await s.call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Codex", redirect_uris: [CB] }) })).json()) as { client_id: string };
        const q = (resource: string, scope: string) => new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: "x".repeat(43), code_challenge_method: "S256", resource, scope });
        expect((await s.call(`/authorize?${q(`${BASE}/mcp-completo`, "campus.read campus.write")}`)).status).toBe(200);
        expect((await s.call(`/authorize?${q(`${BASE}/mcp`, "campus.read campus.write")}`)).status).toBe(200);
        expect((await s.call(`/authorize?${q(`${BASE}/mcp`, "campus.admin")}`)).status).toBe(400);
        const ro = setup({ env: { CAMPUS_WRITE_ENABLED: undefined } });
        const reg2 = (await (await ro.call("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Codex", redirect_uris: [CB] }) })).json()) as { client_id: string };
        const q2 = new URLSearchParams({ response_type: "code", client_id: reg2.client_id, redirect_uri: CB, code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: `${BASE}/mcp`, scope: "campus.write" });
        expect((await ro.call(`/authorize?${q2}`)).status).toBe(400);
    });

    it("revocar: otra CAMPUS_WRITE_TOKEN_VERSION invalida los tokens de escritura, no los de lectura", async () => {
        const kv = new MemoryKv();
        const s1 = setup({ kv });
        const w = await login(s1);
        const r = await login(s1, `${BASE}/mcp`);
        const s2 = setup({ kv, env: { CAMPUS_WRITE_TOKEN_VERSION: "2" } });
        expect((await rpc(s2, "/mcp-escritura", w.token, "tools/list")).status).toBe(401);
        expect((await rpc(s2, "/mcp", r.token, "tools/list")).status).toBe(200);
    });
});

describe("W5 · aprobación por página y KV", () => {
    it("plan → ejecutar sin aprobar (CONFIRMATION_REQUIRED con la URL) → aprobar en la página → ejecutar verificado → no se repite", async () => {
        const s = setup();
        const { token } = await login(s);
        const plan = await tool(s, token!, "campus_plan_marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "desde remoto" }] });
        expect(plan.isError).toBe(false);
        expect(plan.data.confirmation.channel).toBe("fuera_de_banda");
        const id = plan.data.plan_id as string;
        expect(plan.data.next_step).toContain(`${BASE}/aprobar/${id}`);
        const early = await tool(s, token!, "campus_execute_plan", { plan_id: id });
        expect(early.data.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(early.data.error.human_action ?? JSON.stringify(early.data.error)).toContain(`/aprobar/${id}`);
        expect(s.markers.writes).toHaveLength(0);

        const { res, html } = await decide(s, id, "approved");
        expect(html).toContain("desde remoto");
        expect(res.status).toBe(200);
        const done = await tool(s, token!, "campus_execute_plan", { plan_id: id });
        expect(done.isError).toBe(false);
        expect(done.data.status).toBe("aplicado_verificado");
        expect(done.data.confirmation.channel).toBe("web");
        const again = await tool(s, token!, "campus_execute_plan", { plan_id: id });
        expect(again.data.error.code).toBe("PLAN_ALREADY_EXECUTED");
        // Todo el estado está en el KV (uso único con SET NX).
        expect([...s.kv.data.keys()].some((k) => k.endsWith(`claim:${id}`))).toBe(true);
        const log = await tool(s, token!, "campus_list_write_actions", {});
        expect(log.data.actions.map((a: { plan_id: string }) => a.plan_id)).toContain(id);
    });

    it("rechazar en la página → la ejecución queda rechazada; no se puede volver a decidir", async () => {
        const s = setup();
        const { token } = await login(s);
        const id = (await tool(s, token!, "campus_plan_marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "no" }] })).data.plan_id as string;
        const { cookie } = await decide(s, id, "rejected");
        const r = await tool(s, token!, "campus_execute_plan", { plan_id: id });
        expect(r.data.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(r.data.error.details.decision).toBe("rejected");
        const page = await s.call(`/aprobar/${id}`, { headers: { cookie } });
        expect(page.status).toBe(409);
    });

    it("la página exige al dueño de GitHub y un formulario firmado para ESE plan", async () => {
        const s = setup({ ghUser: () => 999 });
        const { token } = await login(setup());
        void token;
        const stranger = await approverCookie(s, "pl_aaaaaaaaaaaaaaaa");
        expect(stranger.status).toBe(403);

        const o = setup();
        const t = (await login(o)).token!;
        const id1 = (await tool(o, t, "campus_plan_marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "a" }] })).data.plan_id as string;
        const id2 = (await tool(o, t, "campus_plan_marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "b" }] })).data.plan_id as string;
        const cb = await approverCookie(o, id1);
        const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-campus_approver="))!.split(";")[0]!;
        const form1 = /name="form" value="([^"]+)"/.exec(await (await o.call(`/aprobar/${id1}`, { headers: { cookie } })).text())![1]!;
        // El formulario del plan 1 no aprueba el plan 2; sin cookie no hay decisión.
        expect((await o.call(`/aprobar/${id2}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ form: form1, decision: "approved" }) })).status).toBe(409);
        expect((await o.call(`/aprobar/${id1}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ form: form1, decision: "approved" }) })).status).toBe(401);
        expect((await tool(o, t, "campus_execute_plan", { plan_id: id2 })).data.error.code).toBe("CONFIRMATION_REQUIRED");
    });

    it("con require_out_of_band_from_risk=nunca (ADR-061) el remoto ejecuta sin página de aprobación", async () => {
        const s = setup({ writeProfile: { require_out_of_band_from_risk: "nunca" } });
        const { token } = await login(s);
        const p = await tool(s, token!, "campus_plan_marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "sin aprobar" }] });
        expect(p.data.confirmation.channel).toBe("cliente");
        const r = await tool(s, token!, "campus_execute_plan", { plan_id: p.data.plan_id });
        expect(r.data.status).toBe("aplicado_verificado");
        expect(r.data.confirmation.channel).toBe("cliente");
    });

    it("ningún secreto (token de Moodle, KV, cookies) aparece en logs", async () => {
        const s = setup();
        const { token } = await login(s);
        const id = (await tool(s, token!, "campus_plan_marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "z" }] })).data.plan_id as string;
        await decide(s, id, "approved");
        await tool(s, token!, "campus_execute_plan", { plan_id: id });
        const all = s.logs.join("\n");
        for (const secret of [VALID_TOKEN, "kv-token-sintetico", SECRET, token!]) expect(all).not.toContain(secret);
    });
});
