import { randomBytes } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createApp, type App } from "../app.js";
import { loadProfile, type Profile } from "../config/profile.js";
import type { FetchLike } from "../moodle/transport.js";
import { MemoryMetadataStore } from "../session/metadata.js";
import { EnvSecretStore } from "../session/secret-store.js";
import { AutoLogin, autoLoginStatus } from "../web/autologin.js";
import { EnvWebSessionSource, type WebSessionSource } from "../web/session.js";
import { webUserAgent, type WebTransport } from "../web/transport.js";
import { KvAutoLoginBackend, KvSecretBox, KvWebSessionSource, RemoteAutoLogin, webKvPrefix } from "./web-store.js";
import { createLogger, type Logger } from "../util/logger.js";
import { readRemoteConfig, type RemoteConfig } from "./config.js";
import { OAuthError, safeEqual, SCOPE, SCOPE_WRITE, TokenSigner, type AuthRequest } from "./oauth.js";
import { createHmac } from "node:crypto";
import { toPublicError } from "../errors.js";
import type { SecretStore } from "../session/secret-store.js";
import { createWriteApp, type WriteApp } from "../write/app.js";
import { WebApprovalConfirmer } from "../write/confirm.js";
import { assertWriteServerMayStart, loadWriteProfile, type WriteProfile } from "../write/policy.js";
import { KvWriteStore, UpstashKv, type KvClient } from "../write/store.js";
import { createDownloadLinks, type DownloadLinks } from "./download-links.js";
import { readZipDirectory, readZipEntry, ZIP_LIMITS } from "../documents/zip.js";

/**
 * Servidor remoto privado: un único dueño autenticado con GitHub, mismo núcleo que el modo local.
 * /mcp sirve las lecturas; /mcp-completo (lecturas + escrituras) y /mcp-escritura, con alcance campus.write,
 * las escrituras (estado en el KV de Upstash; R3 y R4 con aprobación del usuario en el chat, ADR-060 a ADR-062
 * y ADR-118). Sin otro estado entre requests salvo caches.
 */
export interface RemoteDeps {
    env?: Record<string, string | undefined>;
    fetch?: FetchLike;
    now?: () => Date;
    logger?: Logger;
    profile?: Profile;
    /** Sólo tests: KV en memoria en lugar de Upstash. */
    kv?: KvClient;
    /** Sólo tests: perfil de escritura sintético. */
    writeProfile?: WriteProfile;
}

const APPROVER_COOKIE = "__Host-campus_approver";
const PLAN_PATH = /^\/aprobar\/(pl_[a-z2-7]{16})$/;

/**
 * Secretos del servidor de escritura remoto: el token de Moodle para el núcleo de lectura y una clave
 * de firma de planes DERIVADA de OAUTH_SIGNING_SECRET (no hay keyring en Vercel).
 */
class RemoteWriteSecrets implements SecretStore {
    readonly kind = "env" as const;
    constructor(
        private readonly token: string,
        private readonly signingSecret: Uint8Array,
    ) {}
    async get(account: string) {
        if (account.startsWith("write-signing|")) return createHmac("sha256", this.signingSecret).update(`plan-signing:${account}`).digest("hex");
        return this.token;
    }
    async set(): Promise<void> {
        throw new Error("Secretos de solo lectura en remoto.");
    }
    async delete(): Promise<boolean> {
        throw new Error("Secretos de solo lectura en remoto.");
    }
}

/** Perfil que sirve el remoto. CAMPUS_PROFILE puede elegir otro perfil versionado del repo. */
const DEFAULT_PROFILE_ID = "udesa-docente";
const NONCE_COOKIE = "__Host-campus_flow";
const MAX_BODY = 16 * 1024;
const REMOTE_LOGIN_HINT =
    "El token de Moodle del servidor remoto venció o fue revocado. En tu PC: login local (campus auth login), luego `campus remote push-token` y un nuevo deploy.";

export function createRemoteHandler(deps: RemoteDeps = {}): (req: Request) => Promise<Response> {
    const logger = deps.logger ?? createLogger();
    const fetchImpl: FetchLike = deps.fetch ?? ((i, init) => fetch(i, init));
    const now = deps.now ?? (() => new Date());
    let state: { cfg: RemoteConfig; signer: TokenSigner; app: App; write: WriteApp | null; links: DownloadLinks } | null = null;

    const init = () => {
        if (state) return state;
        const res = readRemoteConfig(deps.env ?? process.env);
        if (!res.ok) {
            logger.log("error", "remote_config_incomplete", { missing: res.missing });
            return null;
        }
        const env = deps.env ?? process.env;
        const profile = deps.profile ?? loadProfile({ profileId: env.CAMPUS_PROFILE?.trim() || DEFAULT_PROFILE_ID, env });
        // ADR-127: con el KV, la sesión web vive ahí (cifrada) y la comparten todas las instancias y los
        // dos núcleos (lectura y escritura); CAMPUS_WEB_SESSION queda como semilla. Sin KV, snapshot fijo.
        const kv: KvClient | null = deps.kv ?? (res.config.kv ? new UpstashKv(res.config.kv.url, res.config.kv.token) : null);
        const seed = env.CAMPUS_WEB_SESSION?.trim() || null;
        const box = new KvSecretBox(res.config.signingSecret);
        const prefix = webKvPrefix(profile.profile_id);
        const webSource: WebSessionSource = kv ? new KvWebSessionSource(kv, box, prefix, seed) : new EnvWebSessionSource(seed);
        const autoBackend = kv && res.config.autologin ? new KvAutoLoginBackend(kv, box, prefix, res.config.autologin, profile.profile_id) : null;
        const webRenewHint = autoBackend
            ? `El servidor inicia sesión solo cuando la sesión web vence; si no pudo, seguí lo que indica el error (${autoBackend.renewHint})`
            : "Renová la sesión web: importala en tu PC (campus auth web import), publicala con campus remote push-web-session y redesplegá.";
        /** Login automático remoto (ADR-127) sobre un transporte web: mismo backend (KV) y misma fuente. */
        const wireAutoLogin = (web: WebTransport | null, target: { webAutoLoginStatus?: (() => Promise<Record<string, unknown>>) | null }) => {
            if (!web || !autoBackend) return;
            const inner = new AutoLogin({ transport: web, backend: autoBackend, loadSnapshot: () => webSource.load(), now, log: (event, fields) => logger.log("info", event, { mode: "remoto", ...fields }) });
            web.setAutoLogin(new RemoteAutoLogin(inner, autoBackend.renewHint));
            target.webAutoLoginStatus = () => autoLoginStatus(autoBackend, now());
        };
        // ADR-113: enlaces temporales de descarga, con clave derivada de OAUTH_SIGNING_SECRET.
        const links = createDownloadLinks(res.config.signingSecret, res.config.baseUrl, now);
        const metadata = new MemoryMetadataStore();
        const at = now().toISOString();
        metadata.write({
            schema_version: "1.0",
            profile_id: profile.profile_id,
            site_url: profile.site_url,
            service: profile.service,
            auth_method: "native",
            identity: { site_url: profile.site_url, user_id: res.config.expectedMoodleUserId, validated_at: at },
            obtained_at: at,
        });
        const app = createApp({
            profile,
            secrets: new EnvSecretStore(res.config.moodleToken),
            metadata,
            logger,
            fetch: deps.fetch,
            now: deps.now,
            loginHint: REMOTE_LOGIN_HINT,
            webSource,
            webRenewHint,
            webUserAgent: webUserAgent("remoto"),
            downloadLinks: links,
        });
        wireAutoLogin(app.web, app.serverDeps);
        let write: WriteApp | null = null;
        const w = res.config.write;
        if (w) {
            try {
                const { CAMPUS_PROFILE: _p, ...wenv } = env;
                const wp = deps.writeProfile ?? loadWriteProfile({ profileId: w.profileId, env: wenv });
                assertWriteServerMayStart(wp, wenv);
                const wmeta = new MemoryMetadataStore();
                wmeta.write({
                    schema_version: "1.0",
                    profile_id: wp.read_profile.profile_id,
                    site_url: wp.read_profile.site_url,
                    service: wp.read_profile.service,
                    auth_method: "native",
                    identity: { site_url: wp.read_profile.site_url, user_id: res.config.expectedMoodleUserId, validated_at: at },
                    obtained_at: at,
                });
                const store = new KvWriteStore(kv ?? new UpstashKv(w.kvUrl, w.kvToken), `w:${wp.profile_id}`);
                write = createWriteApp({
                    profile: wp,
                    secrets: new RemoteWriteSecrets(res.config.moodleToken, res.config.signingSecret),
                    metadata: wmeta,
                    logger,
                    location: store.location,
                    fetch: deps.fetch,
                    now: deps.now,
                    loginHint: REMOTE_LOGIN_HINT,
                    webSource,
                    webRenewHint,
                    webUserAgent: webUserAgent("remoto"),
                    store,
                    confirmer: new WebApprovalConfirmer(store),
                    downloadLinks: links,
                    remote: { approvalUrl: (id) => `${res.config.baseUrl}/aprobar/${id}`, maxRisk: "R4" },
                });
                wireAutoLogin(write.read.web, write.read.serverDeps);
            } catch (e) {
                logger.log("error", "remote_write_disabled", { reason: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
                write = null;
            }
        }
        state = { cfg: res.config, signer: new TokenSigner(res.config, now), app, write, links };
        return state;
    };

    return async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";
        if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
        if ((path === "/" && req.method === "GET") || path === "/health") {
            const ok = init() !== null;
            return path === "/health" ? json({ ok, service: "udesa-campus-mcp", mode: "remote-private" }, ok ? 200 : 503) : html(landing(ok), ok ? 200 : 503);
        }
        const s = init();
        if (!s) return json({ error: "server_not_configured", error_description: "Faltan variables de entorno del despliegue." }, 503);
        // ADR-113: /descarga/<token>[/<nombre>] — enlace temporal firmado; sin token OAuth (el enlace es la credencial).
        const dl = /^\/descarga\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:\/[^/]*)?$/.exec(path);
        if (dl && req.method === "GET") return await serveDownload(s.app, s.links, dl[1]!, logger);
        try {
            switch (`${req.method} ${path}`) {
                case "GET /.well-known/oauth-protected-resource":
                    return cors(json(protectedResourceMetadata(s.signer, s.signer.issuer)));
                case "GET /.well-known/oauth-protected-resource/mcp":
                    return cors(json(protectedResourceMetadata(s.signer, s.signer.resource)));
                case "GET /.well-known/oauth-authorization-server":
                case "GET /.well-known/oauth-authorization-server/mcp":
                case "GET /.well-known/oauth-authorization-server/mcp-escritura":
                case "GET /.well-known/oauth-authorization-server/mcp-completo":
                    return cors(json(authServerMetadata(s.signer)));
                case "GET /.well-known/oauth-protected-resource/mcp-escritura":
                    if (!s.write) return json({ error: "not_found" }, 404);
                    return cors(json({ ...protectedResourceMetadata(s.signer, s.signer.writeResource), scopes_supported: [SCOPE_WRITE], resource_name: "UdeSA Campus MCP · escritura (privado)" }));
                case "POST /mcp-escritura":
                case "GET /mcp-escritura":
                case "DELETE /mcp-escritura":
                    if (!s.write) return json({ error: "not_found", error_description: "Escrituras remotas deshabilitadas." }, 404);
                    return cors(await mcpWrite(s.signer, s.write, req, logger, "escritura"));
                case "GET /.well-known/oauth-protected-resource/mcp-completo":
                    if (!s.write) return json({ error: "not_found" }, 404);
                    return cors(json({ ...protectedResourceMetadata(s.signer, s.signer.fullResource), scopes_supported: [SCOPE_WRITE], resource_name: "UdeSA Campus MCP · completo: lecturas + escrituras (privado)" }));
                case "POST /mcp-completo":
                case "GET /mcp-completo":
                case "DELETE /mcp-completo":
                    if (!s.write) return json({ error: "not_found", error_description: "Escrituras remotas deshabilitadas." }, 404);
                    return cors(await mcpWrite(s.signer, s.write, req, logger, "completo"));
                case "POST /register": {
                    const reg = await s.signer.registerClient(await readJson(req));
                    logger.log("info", "oauth_register", { client: String(reg.client_name).slice(0, 40), redirects: describeRedirects(reg.redirect_uris), auth_method: reg.token_endpoint_auth_method });
                    return cors(json(reg, 201));
                }
                case "GET /authorize":
                    return await authorizePage(s.signer, url.searchParams, logger);
                case "POST /authorize":
                    return await approve(s.cfg, s.signer, await readForm(req));
                case "GET /oauth/github/callback":
                    return await githubCallback(s.cfg, s.signer, url.searchParams, req.headers.get("cookie"), fetchImpl, logger);
                case "POST /token": {
                    const form = await readForm(req);
                    try {
                        const out = await s.signer.exchange(form, basicAuth(req));
                        logger.log("info", "oauth_token", { grant: form.get("grant_type"), outcome: "ok" });
                        return cors(noStore(json(out)));
                    } catch (e) {
                        logger.log("warn", "oauth_token", { grant: form.get("grant_type"), outcome: e instanceof OAuthError ? e.error : "error" });
                        throw e;
                    }
                }
                case "POST /mcp":
                case "GET /mcp":
                case "DELETE /mcp":
                    return cors(await mcp(s.signer, s.app, req, logger, "/mcp"));
                // Mismo MCP en la raíz: ChatGPT y otros clientes a veces guardan la URL sin /mcp.
                case "POST /":
                case "DELETE /":
                    return cors(await mcp(s.signer, s.app, req, logger, "/"));
                default: {
                    // Página de aprobación de escrituras (W5): /aprobar/<plan_id>.
                    const m = PLAN_PATH.exec(path);
                    if (!m || !s.write || (req.method !== "GET" && req.method !== "POST")) return json({ error: "not_found" }, 404);
                    return req.method === "GET" ? await approvalPage(s.cfg, s.signer, s.write, m[1]!, req, logger) : await approvalDecision(s.signer, s.write, m[1]!, req, logger);
                }
            }
        } catch (e) {
            if (e instanceof OAuthError) {
                const res = json({ error: e.error, error_description: e.description }, e.status);
                if (e.status === 401) res.headers.set("www-authenticate", wwwAuthenticate(s.signer, e.error, path === "/" ? "/" : "/mcp"));
                return cors(res);
            }
            logger.log("error", "remote_unhandled", { path, name: e instanceof Error ? e.name : "unknown" });
            return json({ error: "server_error" }, 500);
        }
    };
}

// ---------- Metadata (RFC 9728 / RFC 8414) ----------

function protectedResourceMetadata(signer: TokenSigner, resource: string) {
    return {
        resource,
        authorization_servers: [signer.issuer],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
        resource_name: "UdeSA Campus MCP (privado, sólo lectura)",
    };
}

function authServerMetadata(signer: TokenSigner) {
    const b = signer.issuer;
    return {
        issuer: b,
        authorization_endpoint: `${b}/authorize`,
        token_endpoint: `${b}/token`,
        registration_endpoint: `${b}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        scopes_supported: signer.writeEnabled ? [SCOPE, SCOPE_WRITE] : [SCOPE],
    };
}

function wwwAuthenticate(signer: TokenSigner, error = "invalid_token", mcpPath: "/" | "/mcp" = "/mcp") {
    const meta = `${signer.issuer}/.well-known/oauth-protected-resource${mcpPath === "/" ? "" : "/mcp"}`;
    return `Bearer realm="udesa-campus", error="${error}", resource_metadata="${meta}", scope="${SCOPE}"`;
}

// ---------- Autorización: consentimiento → GitHub → código ----------

async function authorizePage(signer: TokenSigner, q: URLSearchParams, logger: Logger): Promise<Response> {
    let req: AuthRequest;
    try {
        req = await signer.parseAuthorize(q);
    } catch (e) {
        if (e instanceof OAuthError) {
            logger.log("warn", "oauth_authorize", { outcome: e.error });
            return html(page("No se puede autorizar", `<p>${esc(e.description)}</p>`), 400);
        }
        throw e;
    }
    logger.log("info", "oauth_authorize", { client: req.client_name.slice(0, 40), redirect: describeRedirects([req.redirect_uri]), resource: req.resource === signer.resource ? "mcp" : "root", has_state: req.state !== null });
    const signed = await signer.signAuthRequest(req);
    const host = new URL(req.redirect_uri).host;
    const body = `
${
        signer.writeResources.includes(req.resource)
            ? `<p><strong>${esc(req.client_name)}</strong> pide acceso de <strong>ESCRITURA</strong> a tu Campus Virtual${req.resource === signer.fullResource ? " (también de lectura)" : ""}: podrá armar y ejecutar escrituras en los cursos donde tu rol es de profesor, gestor o superior. Las de riesgo alto (R3 y R4) se ejecutan sólo con tu aprobación.</p>`
            : `<p><strong>${esc(req.client_name)}</strong> pide acceso de <strong>sólo lectura</strong> a tu Campus Virtual a través de este servidor: los cursos donde estás matriculado, con los datos de otras personas sólo donde sos docente o superior.</p>`
    }
<p>Los datos se devolverán a <code>${esc(host)}</code>.</p>
<p class="warn">Aprobá sólo si <strong>vos</strong> acabás de iniciar esta conexión desde tu cliente (Claude, ChatGPT, Codex o Claude Code). Si llegaste por un enlace que te mandaron, cerrá esta página.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="request" value="${esc(signed)}">
  <button type="submit">Continuar con GitHub</button>
</form>`;
    // El origen ya pasó por isAllowedRedirect (claude.ai, chatgpt.com o loopback).
    return html(page("Autorizar acceso al Campus", body), 200, [new URL(req.redirect_uri).origin]);
}

async function approve(cfg: RemoteConfig, signer: TokenSigner, form: URLSearchParams): Promise<Response> {
    const p = await signer.verify("authreq", form.get("request") ?? "").catch(() => {
        throw new OAuthError("invalid_request", "La solicitud venció; volvé a iniciar la conexión desde tu cliente.");
    });
    const req = p.req as AuthRequest;
    const nonce = randomBytes(18).toString("base64url");
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", cfg.github.clientId);
    gh.searchParams.set("redirect_uri", `${cfg.baseUrl}/oauth/github/callback`);
    gh.searchParams.set("state", await signer.signGithubState(req, nonce));
    gh.searchParams.set("allow_signup", "false");
    const res = new Response(null, { status: 303, headers: { location: gh.toString() } });
    res.headers.append("set-cookie", `${NONCE_COOKIE}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    return noStore(res);
}

async function githubCallback(
    cfg: RemoteConfig,
    signer: TokenSigner,
    q: URLSearchParams,
    cookieHeader: string | null,
    fetchImpl: FetchLike,
    logger: Logger,
): Promise<Response> {
    const fail = (msg: string, status = 400) => html(page("No se pudo completar el acceso", `<p>${esc(msg)}</p>`), status);
    let st;
    try {
        st = await signer.verify("ghstate", q.get("state") ?? "");
    } catch {
        return fail("El intento de login venció o es inválido. Volvé a conectar desde tu cliente.");
    }
    const cookieNonce = parseCookie(cookieHeader)[NONCE_COOKIE] ?? "";
    if (!cookieNonce || !safeEqual(cookieNonce, String(st.nonce))) {
        return fail("Este login no se inició en este navegador. Volvé a conectar desde tu cliente.");
    }
    if (typeof st.approve_plan === "string" && /^pl_[a-z2-7]{16}$/.test(st.approve_plan)) {
        // Login para la página de aprobación (W5): mismo dueño de GitHub, cookie propia de 8 h.
        const code = q.get("code");
        if (q.get("error") || !code || code.length > 256) return fail("No se completó el login con GitHub.");
        const who = await githubUserId(cfg, code, fetchImpl);
        if (who === "error") return fail("No se pudo verificar la identidad con GitHub.", 502);
        if (who !== cfg.github.allowedUserId) {
            logger.log("warn", "approver_login_denied", { reason: "github_user_not_allowed" });
            return fail("Esta cuenta de GitHub no está autorizada en este servidor privado.", 403);
        }
        const res = clearCookie(redirect(new URL(`/aprobar/${st.approve_plan}`, cfg.baseUrl)));
        res.headers.append("set-cookie", `${APPROVER_COOKIE}=${await signer.issueApprover(who)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`);
        logger.log("info", "approver_login_ok", {});
        return res;
    }
    const req = st.req as AuthRequest;
    const back = new URL(req.redirect_uri);
    if (q.get("error")) {
        back.searchParams.set("error", "access_denied");
        if (req.state) back.searchParams.set("state", req.state);
        return clearCookie(redirect(back));
    }
    const code = q.get("code");
    if (!code || code.length > 256) return fail("GitHub no devolvió un código válido.");

    const who = await githubUserId(cfg, code, fetchImpl);
    if (who === "rejected") return fail("GitHub rechazó el código de login.");
    if (who === "error") return fail("No se pudo verificar la identidad con GitHub.", 502);
    const ghUserId: string | null = who;
    if (ghUserId !== cfg.github.allowedUserId) {
        logger.log("warn", "remote_login_denied", { reason: "github_user_not_allowed" });
        return fail("Esta cuenta de GitHub no está autorizada en este servidor privado.", 403);
    }
    back.searchParams.set("code", await signer.issueCode(req, ghUserId));
    if (req.state) back.searchParams.set("state", req.state);
    back.searchParams.set("iss", signer.issuer);
    logger.log("info", "remote_login_ok", { client: req.client_name.slice(0, 40), redirect_host: back.host, redirect_path: back.pathname.slice(0, 60) });
    return clearCookie(redirect(back));
}

/** ID numérico de GitHub del código de login, o "rejected" / "error". */
async function githubUserId(cfg: RemoteConfig, code: string, fetchImpl: FetchLike): Promise<string | "rejected" | "error" | null> {
    try {
        const tokRes = await fetchImpl("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: cfg.github.clientId, client_secret: cfg.github.clientSecret, code, redirect_uri: `${cfg.baseUrl}/oauth/github/callback` }),
            signal: AbortSignal.timeout(15_000),
        });
        const tok = (await tokRes.json()) as { access_token?: string };
        if (!tok.access_token) return "rejected";
        const userRes = await fetchImpl("https://api.github.com/user", {
            headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "udesa-campus-mcp" },
            signal: AbortSignal.timeout(15_000),
        });
        const user = (await userRes.json()) as { id?: number };
        return typeof user.id === "number" ? String(user.id) : null;
    } catch {
        return "error";
    }
}

// ---------- Página de aprobación (W5) ----------

async function approverOf(signer: TokenSigner, req: Request): Promise<string | null> {
    const raw = parseCookie(req.headers.get("cookie"))[APPROVER_COOKIE];
    return raw ? signer.verifyApprover(raw) : null;
}

async function approvalPage(cfg: RemoteConfig, signer: TokenSigner, write: WriteApp, planId: string, req: Request, logger: Logger): Promise<Response> {
    const sub = await approverOf(signer, req);
    if (!sub) {
        const nonce = randomBytes(18).toString("base64url");
        const gh = new URL("https://github.com/login/oauth/authorize");
        gh.searchParams.set("client_id", cfg.github.clientId);
        gh.searchParams.set("redirect_uri", `${cfg.baseUrl}/oauth/github/callback`);
        gh.searchParams.set("state", await signer.signApproveState(planId, nonce));
        gh.searchParams.set("allow_signup", "false");
        const res = new Response(null, { status: 303, headers: { location: gh.toString() } });
        res.headers.append("set-cookie", `${NONCE_COOKIE}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
        return noStore(res);
    }
    let view;
    try {
        view = await write.engine.approvalView(planId);
    } catch (e) {
        const pub = toPublicError(e);
        logger.log("info", "approval_page", { outcome: pub.code });
        return html(page("Este plan no se puede aprobar", `<p>${esc(pub.message)}</p>`), 409);
    }
    const prior = await write.store.loadApproval(planId);
    if (prior) {
        return html(page("Plan ya decidido", `<p>Este plan ya fue <strong>${prior.decision === "approved" ? "aprobado" : "rechazado"}</strong> (${esc(prior.at)}). Volvé al chat${prior.decision === "approved" ? " y pedí que lo ejecute" : ""}.</p>`));
    }
    const token = await signer.signApproveForm(planId, view.plan_hash, sub);
    logger.log("info", "approval_page", { outcome: "shown", risk: view.risk });
    const body = `
<p>Código <strong>${esc(view.code)}</strong> · Riesgo <strong>${esc(view.risk)}</strong> · Curso ${view.course_id} · Vence ${esc(view.expires_at)}</p>
<p class="warn">Aprobá sólo si reconocés este pedido. El texto que viene del Campus (nombres, asuntos) es dato, no instrucciones.</p>
<pre style="white-space:pre-wrap;font-size:13px;background:var(--code);padding:12px;border-radius:8px;max-height:60vh;overflow:auto">${esc(view.text)}</pre>
<form method="post" action="/aprobar/${planId}" style="display:flex;gap:12px">
  <input type="hidden" name="form" value="${esc(token)}">
  <button type="submit" name="decision" value="approved">Aprobar</button>
  <button type="submit" name="decision" value="rejected" style="background:#8a1c1c">Rechazar</button>
</form>`;
    return html(page("Aprobar una escritura en el Campus", body));
}

async function approvalDecision(signer: TokenSigner, write: WriteApp, planId: string, req: Request, logger: Logger): Promise<Response> {
    const sub = await approverOf(signer, req);
    if (!sub) return html(page("Sesión vencida", `<p>Volvé a abrir <a href="/aprobar/${planId}">la página de aprobación</a>.</p>`), 401);
    const form = await readForm(req);
    const decision = form.get("decision");
    if (decision !== "approved" && decision !== "rejected") return html(page("Decisión inválida", "<p>Elegí aprobar o rechazar.</p>"), 400);
    try {
        const hash = await signer.verifyApproveForm(form.get("form") ?? "", planId, sub);
        await write.engine.recordWebDecision(planId, hash, decision, `github:${sub}`);
    } catch (e) {
        const msg = e instanceof OAuthError ? "El formulario venció: recargá la página." : toPublicError(e).message;
        logger.log("warn", "approval_decision", { outcome: e instanceof OAuthError ? "form_invalid" : toPublicError(e).code });
        return html(page("No se registró la decisión", `<p>${esc(msg)}</p>`), 409);
    }
    logger.log("info", "approval_decision", { outcome: decision });
    return html(
        page(
            decision === "approved" ? "Plan aprobado" : "Plan rechazado",
            decision === "approved" ? "<p>Listo. Volvé al chat y pedile que ejecute el plan (campus_execute_plan).</p>" : "<p>No se va a ejecutar. Podés cerrar esta página.</p>",
        ),
    );
}

// ---------- MCP ----------

/** MCP de escritura (W5): token con alcance campus.write, servidor de escritura en modo remoto. */
async function mcpWrite(signer: TokenSigner, write: WriteApp, req: Request, logger: Logger, kind: "escritura" | "completo"): Promise<Response> {
    const resource = kind === "completo" ? signer.fullResource : signer.writeResource;
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(req.headers.get("authorization") ?? "");
    const meta = `${signer.issuer}/.well-known/oauth-protected-resource/mcp-${kind}`;
    const unauthorized = (error: string) =>
        new Response(JSON.stringify({ error, error_description: "Se requiere un access token de ESCRITURA de este servidor." }), {
            status: 401,
            headers: { "content-type": "application/json", "www-authenticate": `Bearer realm="udesa-campus-escritura", error="${error}", resource_metadata="${meta}", scope="${SCOPE_WRITE}"` },
        });
    if (!m) return unauthorized("invalid_request");
    let claims;
    try {
        claims = await signer.verifyWriteAccess(m[1]!, resource);
    } catch (e) {
        logger.log("warn", "mcp_write_unauthorized", { reason: e instanceof OAuthError ? e.description.slice(0, 60) : "invalid" });
        return unauthorized("invalid_token");
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed", error_description: "Servidor sin estado: sólo POST." }, 405);
    const server = kind === "completo" ? write.fullServer() : write.server();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 256 * 1024 });
    await server.connect(transport);
    try {
        return await transport.handleRequest(req, { authInfo: { token: m[1]!, clientId: String(claims.client_id), scopes: [SCOPE_WRITE], expiresAt: claims.exp } });
    } catch (e) {
        logger.log("error", "mcp_write_http_error", { name: e instanceof Error ? e.name : "unknown" });
        return json({ error: "server_error" }, 500);
    } finally {
        await server.close().catch(() => {});
    }
}

async function mcp(signer: TokenSigner, app: App, req: Request, logger: Logger, mcpPath: "/" | "/mcp"): Promise<Response> {
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(req.headers.get("authorization") ?? "");
    const unauthorized = (error: string) =>
        new Response(JSON.stringify({ error, error_description: "Se requiere un access token válido de este servidor." }), {
            status: 401,
            headers: { "content-type": "application/json", "www-authenticate": wwwAuthenticate(signer, error, mcpPath) },
        });
    if (!m) return unauthorized("invalid_request");
    let claims;
    try {
        claims = await signer.verifyAccess(m[1]!);
    } catch (e) {
        logger.log("warn", "mcp_unauthorized", { path: mcpPath, reason: e instanceof OAuthError ? e.description.slice(0, 60) : "invalid" });
        return unauthorized("invalid_token");
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed", error_description: "Servidor sin estado: sólo POST." }, 405);
    const server = app.server();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 256 * 1024 });
    await server.connect(transport);
    try {
        return await transport.handleRequest(req, {
            authInfo: { token: m[1]!, clientId: String(claims.client_id), scopes: [SCOPE], expiresAt: claims.exp },
        });
    } catch (e) {
        logger.log("error", "mcp_http_error", { name: e instanceof Error ? e.name : "unknown" });
        return json({ error: "server_error" }, 500);
    } finally {
        await server.close().catch(() => {});
    }
}

// ---------- Utilidades HTTP ----------

async function readBody(req: Request): Promise<string> {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) throw new OAuthError("invalid_request", "Cuerpo demasiado grande.");
    const text = await req.text();
    if (text.length > MAX_BODY) throw new OAuthError("invalid_request", "Cuerpo demasiado grande.");
    return text;
}

async function readJson(req: Request): Promise<unknown> {
    try {
        return JSON.parse(await readBody(req));
    } catch (e) {
        if (e instanceof OAuthError) throw e;
        throw new OAuthError("invalid_client_metadata", "JSON inválido.");
    }
}

async function readForm(req: Request): Promise<URLSearchParams> {
    return new URLSearchParams(await readBody(req));
}

function basicAuth(req: Request): { id: string; secret: string } | null {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!m) return null;
    const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
}

/** Sólo host y ruta (sin query ni ids largos) para diagnóstico en logs. */
function describeRedirects(uris: unknown): string[] {
    return (Array.isArray(uris) ? uris : []).slice(0, 5).map((u) => {
        try {
            const x = new URL(String(u));
            return `${x.protocol}//${x.host}${x.pathname.replace(/\/[A-Za-z0-9_-]{16,}/g, "/…").slice(0, 60)}`;
        } catch {
            return "(inválida)";
        }
    });
}

function parseCookie(header: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (header ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/**
 * `form-action` también se aplica a TODA la cadena de redirecciones que sigue al envío del
 * formulario de consentimiento (Chrome). Si GitHub ya autorizó la app, la cadena llega sin pausa
 * hasta el callback del cliente: por eso se permite además el origen de ESE callback.
 */
function html(body: string, status = 200, extraFormAction: string[] = []) {
    const formAction = ["'self'", "https://github.com", ...extraFormAction].join(" ");
    return noStore(
        new Response(body, {
            status,
            headers: {
                "content-type": "text/html; charset=utf-8",
                "content-security-policy": `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
                "x-frame-options": "DENY",
                "referrer-policy": "no-referrer",
            },
        }),
    );
}

const redirect = (u: URL) => noStore(new Response(null, { status: 302, headers: { location: u.toString() } }));

function clearCookie(res: Response) {
    res.headers.append("set-cookie", `${NONCE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return res;
}

function noStore(res: Response) {
    res.headers.set("cache-control", "no-store");
    return res;
}

function cors(res: Response) {
    res.headers.set("access-control-allow-origin", "*");
    res.headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.headers.set("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id");
    res.headers.set("access-control-expose-headers", "www-authenticate, mcp-session-id");
    return res;
}

function esc(s: string) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const REPO_URL = "https://github.com/changazo/udesa-mcp";
const CAFECITO_URL = "https://cafecito.app/changazo";
/** Marca de GitHub (octicon mark-github, 16×16). */
const GITHUB_ICON = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.01 8.01 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>`;

/** Plantilla de las páginas del remoto: sobria, con los colores del logo; claro y oscuro. */
function page(title: string, body: string, extraHead = "") {
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">${extraHead}
<style>
:root{--green:#329C32;--blue:#014A94;--pink:#C887B9;--ink:#1d2433;--muted:#5b6475;--bg:#f6f7f9;--card:#fff;--line:#e3e6eb;--code:#eef1f4}
@media (prefers-color-scheme:dark){:root{--ink:#e8eaee;--muted:#9aa3b2;--bg:#0f1115;--card:#171a20;--line:#2a2f38;--code:#232831;--blue:#5b9be0}}
*{box-sizing:border-box}
body{font:16px/1.55 system-ui,"Segoe UI",sans-serif;margin:0;padding:48px 16px;color:var(--ink);background:var(--bg)}
main{max-width:600px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-top:4px solid var(--green);border-radius:12px;padding:28px 32px}
header{display:flex;align-items:center;gap:14px;margin-bottom:8px}
.logo{width:56px;height:56px;flex:none}
h1{font-size:1.35rem;line-height:1.25;margin:0;color:var(--blue)}
a{color:var(--blue)}
.warn{background:#fff4e5;color:#3d2a00;border-left:4px solid #f0a020;padding:8px 12px;border-radius:4px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:var(--blue);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.1)}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.92em}
footer{max-width:600px;margin:16px auto 0;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;font-size:.9rem}
footer a{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--muted);text-decoration:none}
footer a:hover{color:var(--ink);border-color:var(--muted)}
</style>
</head><body><main><header><img class="logo" src="/logo.png" alt="" width="56" height="56"><h1>${esc(title)}</h1></header>${body}</main>
<footer><a href="${REPO_URL}" rel="noopener">${GITHUB_ICON}GitHub</a><a href="${CAFECITO_URL}" rel="noopener">☕ Invitame un cafecito</a></footer></body></html>`;
}

function landing(ok: boolean) {
    return page(
        "UdeSA Campus MCP",
        `<p>Servidor MCP privado del Campus Virtual de UdeSA (Moodle). No oficial. Endpoints (requieren OAuth): <code>/mcp</code> (lecturas), <code>/mcp-completo</code> (lecturas y escrituras) y <code>/mcp-escritura</code> (sólo escrituras).</p><p>Estado: ${ok ? "configurado" : "<strong>falta configuración</strong>"}.</p>`,
        `<meta name="description" content="MCP no oficial del Campus Virtual (Moodle) de UdeSA."><meta property="og:title" content="UdeSA MCP"><meta property="og:description" content="MCP no oficial del Campus Virtual (Moodle) de UdeSA."><meta property="og:image" content="/social.png"><meta name="twitter:card" content="summary_large_image">`,
    );
}

/** Respuesta de un enlace temporal de descarga (ADR-113): el remoto baja el archivo con su token y lo entrega. */
async function serveDownload(app: App, links: DownloadLinks, token: string, logger: Logger): Promise<Response> {
    const spec = links.verify(token);
    if (!spec) return json({ error: "link_invalid_or_expired", error_description: "El enlace no es válido o venció (duran 15 minutos). Pedí otro con campus_get_original_file." }, 410);
    try {
        const max = app.serverDeps.profile.limits.max_file_bytes;
        let { bytes } = await app.session.transport.download(spec.url, max);
        if (spec.entry !== undefined) {
            const e = readZipDirectory(bytes).find((x) => x.name === spec.entry && !x.is_dir);
            if (!e) return json({ error: "not_found" }, 404);
            bytes = readZipEntry(bytes, e, Math.min(ZIP_LIMITS.maxEntryBytes, max));
        }
        logger.log("info", "download_link", { course_id: spec.course_id, bytes: bytes.byteLength });
        const ascii = spec.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
        return new Response(Buffer.from(bytes), {
            status: 200,
            headers: {
                "content-type": spec.mime || "application/octet-stream",
                "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(spec.name)}`,
                "cache-control": "no-store",
                "x-robots-tag": "noindex",
                "referrer-policy": "no-referrer",
                "x-content-type-options": "nosniff",
            },
        });
    } catch (e) {
        const pub = toPublicError(e);
        logger.log("warn", "download_link", { outcome: pub.code });
        return json({ error: pub.code, error_description: pub.message }, pub.code === "AUTH_REQUIRED" ? 503 : 502);
    }
}
