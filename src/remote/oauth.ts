import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { RemoteConfig } from "./config.js";

/**
 * Servidor de autorización OAuth 2.1 mínimo para UN dueño, sin base de datos: clientes (DCR),
 * códigos y tokens son JWT firmados con HS256 y un `typ` propio por tipo, para que uno no pueda
 * usarse como otro. Rotar OAUTH_SIGNING_SECRET revoca todo.
 *
 * Límite conocido: sin almacenamiento, un código de autorización no se puede marcar como usado.
 * Se mitiga con vida de 120 s y PKCE S256 obligatorio (quien no tiene el verifier no lo canjea).
 */
export const SCOPE = "campus.read";
/** Alcance del endpoint de escritura (W5). Un token de lectura nunca lo abre, ni al revés. */
export const SCOPE_WRITE = "campus.write";
const APPROVER_TTL = 8 * 3600;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 120;
const FLOW_TTL = 600;

export type TokenKind = "client" | "authreq" | "ghstate" | "code" | "access" | "refresh" | "approver" | "approveform";

export interface AuthRequest {
    client_id: string;
    client_name: string;
    redirect_uri: string;
    state: string | null;
    code_challenge: string;
    scope: string;
    resource: string;
}

export class OAuthError extends Error {
    constructor(
        readonly error: string,
        readonly description: string,
        readonly status = 400,
    ) {
        super(description);
    }
}

export class TokenSigner {
    constructor(
        private readonly cfg: RemoteConfig,
        private readonly now: () => Date = () => new Date(),
    ) {}

    get issuer() {
        return this.cfg.baseUrl;
    }
    /** Recurso MCP canónico. */
    get resource() {
        return `${this.cfg.baseUrl}/mcp`;
    }
    /** Recurso del MCP de escritura (W5). */
    get writeResource() {
        return `${this.cfg.baseUrl}/mcp-escritura`;
    }
    /** Recurso del MCP completo, lecturas + escrituras (perfil docente-completo, ADR-062). */
    get fullResource() {
        return `${this.cfg.baseUrl}/mcp-completo`;
    }
    /** Recursos que requieren alcance de escritura. Un token de uno no abre el otro. */
    get writeResources(): string[] {
        return [this.writeResource, this.fullResource];
    }
    get writeEnabled() {
        return this.cfg.write !== null;
    }
    /** El MCP se sirve en /mcp y también en la raíz (algunos clientes guardan la URL sin /mcp). */
    get resources(): string[] {
        return [this.resource, this.cfg.baseUrl];
    }

    async sign(kind: TokenKind, claims: JWTPayload, ttlSeconds: number | null): Promise<string> {
        const iat = Math.floor(this.now().getTime() / 1000);
        let jwt = new SignJWT({ ...claims, typ: kind }).setProtectedHeader({ alg: "HS256" }).setIssuer(this.issuer).setIssuedAt(iat);
        if (ttlSeconds !== null) jwt = jwt.setExpirationTime(iat + ttlSeconds);
        return jwt.sign(this.cfg.signingSecret);
    }

    async verify(kind: TokenKind, token: string): Promise<JWTPayload> {
        if (typeof token !== "string" || token.length > 8192) throw new OAuthError("invalid_grant", "Token inválido.");
        try {
            const { payload } = await jwtVerify(token, this.cfg.signingSecret, {
                issuer: this.issuer,
                algorithms: ["HS256"],
                currentDate: this.now(),
            });
            if (payload.typ !== kind) throw new Error("typ");
            return payload;
        } catch {
            throw new OAuthError(kind === "client" ? "invalid_client" : "invalid_grant", `${kind} inválido o vencido.`, kind === "client" ? 401 : 400);
        }
    }

    clientSecretFor(clientId: string): string {
        return createHmac("sha256", this.cfg.signingSecret).update(`client_secret:${clientId}`).digest("base64url");
    }

    // --- Clientes registrados dinámicamente (RFC 7591) ---

    async registerClient(body: unknown): Promise<Record<string, unknown>> {
        if (!body || typeof body !== "object") throw new OAuthError("invalid_client_metadata", "Cuerpo JSON requerido.");
        const b = body as Record<string, unknown>;
        const uris = b.redirect_uris;
        if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
            throw new OAuthError("invalid_redirect_uri", "redirect_uris requerido (1 a 5 URIs).");
        }
        for (const u of uris as string[]) {
            if (!isAllowedRedirect(u)) throw new OAuthError("invalid_redirect_uri", `redirect_uri no permitido: ${safeShow(u)}`);
        }
        const name = typeof b.client_name === "string" ? b.client_name.slice(0, 80) : "Cliente MCP";
        const requested = typeof b.token_endpoint_auth_method === "string" ? b.token_endpoint_auth_method : "none";
        const authMethod = ["none", "client_secret_post", "client_secret_basic"].includes(requested) ? requested : "none";
        const clientId = await this.sign("client", { redirect_uris: uris, client_name: name, am: authMethod }, null);
        const issuedAt = Math.floor(this.now().getTime() / 1000);
        return {
            client_id: clientId,
            client_id_issued_at: issuedAt,
            ...(authMethod !== "none" ? { client_secret: this.clientSecretFor(clientId), client_secret_expires_at: 0 } : {}),
            client_name: name,
            redirect_uris: uris,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: authMethod,
            scope: SCOPE,
        };
    }

    async loadClient(clientId: string): Promise<{ redirect_uris: string[]; client_name: string; auth_method: string }> {
        const p = await this.verify("client", clientId);
        return { redirect_uris: p.redirect_uris as string[], client_name: String(p.client_name ?? "Cliente MCP"), auth_method: String(p.am ?? "none") };
    }

    /** Valida un pedido de /authorize. Los errores antes de validar redirect_uri no redirigen. */
    async parseAuthorize(q: URLSearchParams): Promise<AuthRequest> {
        const clientId = q.get("client_id") ?? "";
        const client = await this.loadClient(clientId).catch(() => {
            throw new OAuthError("invalid_client", "Cliente desconocido. Volvé a agregar el conector.", 400);
        });
        const redirect = q.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : "");
        if (!client.redirect_uris.includes(redirect) || !isAllowedRedirect(redirect)) {
            throw new OAuthError("invalid_request", "redirect_uri no registrado para este cliente.");
        }
        if (q.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Sólo response_type=code.");
        const challenge = q.get("code_challenge") ?? "";
        if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
            throw new OAuthError("invalid_request", "PKCE S256 obligatorio.");
        }
        const requested = q.get("resource")?.replace(/\/$/, "") ?? null;
        const write = requested !== null && this.writeResources.includes(requested);
        if (write && !this.writeEnabled) throw new OAuthError("invalid_target", "Las escrituras remotas no están habilitadas en este servidor.");
        if (requested && !write && !this.resources.includes(requested)) {
            throw new OAuthError("invalid_target", "resource no corresponde a este servidor.");
        }
        const want = write ? SCOPE_WRITE : SCOPE;
        const scope = q.get("scope");
        // Algunos clientes (Codex) piden todos los scopes que anuncia el servidor: se acepta cualquier
        // combinación de los conocidos y se emite SÓLO el del recurso (el resource decide, nunca el scope).
        const known = this.writeEnabled ? [SCOPE, SCOPE_WRITE] : [SCOPE];
        if (scope && !scope.split(" ").every((s) => s === "" || known.includes(s))) throw new OAuthError("invalid_scope", `Scopes disponibles: ${known.join(" ")}.`);
        const state = q.get("state");
        if (state && state.length > 2048) throw new OAuthError("invalid_request", "state demasiado largo.");
        return { client_id: clientId, client_name: client.client_name, redirect_uri: redirect, state, code_challenge: challenge, scope: want, resource: requested ?? this.resource };
    }

    // --- /token ---

    async exchange(form: URLSearchParams, basicAuth: { id: string; secret: string } | null): Promise<Record<string, unknown>> {
        const grant = form.get("grant_type");
        const clientId = basicAuth?.id ?? form.get("client_id") ?? "";
        const client = await this.loadClient(clientId);
        if (client.auth_method !== "none") {
            const secret = basicAuth?.secret ?? form.get("client_secret") ?? "";
            if (!safeEqual(secret, this.clientSecretFor(clientId))) throw new OAuthError("invalid_client", "Autenticación de cliente fallida.", 401);
        }
        if (grant === "authorization_code") {
            const code = await this.verify("code", form.get("code") ?? "");
            if (code.client_id !== clientId) throw new OAuthError("invalid_grant", "El código pertenece a otro cliente.");
            if (code.redirect_uri !== (form.get("redirect_uri") ?? code.redirect_uri)) throw new OAuthError("invalid_grant", "redirect_uri no coincide.");
            const verifier = form.get("code_verifier") ?? "";
            if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(s256(verifier), String(code.code_challenge))) {
                throw new OAuthError("invalid_grant", "PKCE inválido.");
            }
            return this.issueTokens(String(code.sub), clientId, String(code.resource ?? this.resource));
        }
        if (grant === "refresh_token") {
            const rt = await this.verify("refresh", form.get("refresh_token") ?? "");
            if (rt.client_id !== clientId) throw new OAuthError("invalid_grant", "El refresh token pertenece a otro cliente.");
            return this.issueTokens(String(rt.sub), clientId, String(rt.resource ?? this.resource), rt.wv);
        }
        throw new OAuthError("unsupported_grant_type", "Sólo authorization_code y refresh_token.");
    }

    private async issueTokens(sub: string, clientId: string, resource: string, wv?: unknown) {
        if (this.writeResources.includes(resource)) {
            // Un refresh de escritura de otra versión (revocada) no renueva nada.
            if (!this.cfg.write || (wv !== undefined && wv !== this.cfg.write.tokenVersion)) throw new OAuthError("invalid_grant", "Las escrituras remotas no están habilitadas o el acceso fue revocado.");
            const v = this.cfg.write.tokenVersion;
            const access = await this.sign("access", { sub, client_id: clientId, scope: SCOPE_WRITE, aud: resource, wv: v }, ACCESS_TTL);
            const refresh = await this.sign("refresh", { sub, client_id: clientId, scope: SCOPE_WRITE, resource, wv: v, jti: randomBytes(12).toString("base64url") }, REFRESH_TTL);
            return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE_WRITE };
        }
        const aud = this.resources.includes(resource) ? resource : this.resource;
        const access = await this.sign("access", { sub, client_id: clientId, scope: SCOPE, aud }, ACCESS_TTL);
        const refresh = await this.sign("refresh", { sub, client_id: clientId, scope: SCOPE, resource: aud, jti: randomBytes(12).toString("base64url") }, REFRESH_TTL);
        return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
    }

    async issueCode(req: AuthRequest, sub: string): Promise<string> {
        return this.sign("code", { sub, client_id: req.client_id, redirect_uri: req.redirect_uri, code_challenge: req.code_challenge, scope: req.scope, resource: req.resource }, CODE_TTL);
    }

    async signAuthRequest(req: AuthRequest): Promise<string> {
        return this.sign("authreq", { req }, FLOW_TTL);
    }

    async signGithubState(req: AuthRequest, nonce: string): Promise<string> {
        return this.sign("ghstate", { req, nonce }, FLOW_TTL);
    }

    /** Valida un access token para /mcp: firma, tipo, audiencia y dueño permitido. */
    async verifyAccess(token: string): Promise<JWTPayload> {
        const p = await this.verify("access", token);
        const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
        if (!aud.some((a) => typeof a === "string" && this.resources.includes(a))) throw new OAuthError("invalid_token", "Audiencia incorrecta.", 401);
        if (p.sub !== this.cfg.github.allowedUserId) throw new OAuthError("invalid_token", "Usuario no autorizado.", 401);
        if (p.scope === SCOPE_WRITE) throw new OAuthError("invalid_token", "Token de escritura: no sirve para la lectura.", 401);
        return p;
    }

    /** Access token para /mcp-escritura: audiencia y alcance de escritura, versión vigente y dueño. */
    async verifyWriteAccess(token: string, resource: string = this.writeResource): Promise<JWTPayload> {
        const p = await this.verify("access", token);
        if (!this.cfg.write) throw new OAuthError("invalid_token", "Escrituras remotas deshabilitadas.", 401);
        const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
        if (!aud.includes(resource) || p.scope !== SCOPE_WRITE) throw new OAuthError("invalid_token", "El token no tiene alcance de escritura.", 401);
        if (p.wv !== this.cfg.write.tokenVersion) throw new OAuthError("invalid_token", "Acceso de escritura revocado: volvé a conectar.", 401);
        if (p.sub !== this.cfg.github.allowedUserId) throw new OAuthError("invalid_token", "Usuario no autorizado.", 401);
        return p;
    }

    // --- Página de aprobación (W5): sesión del dueño y formulario atado al plan ---

    async signApproveState(planId: string, nonce: string): Promise<string> {
        return this.sign("ghstate", { approve_plan: planId, nonce }, FLOW_TTL);
    }

    async issueApprover(sub: string): Promise<string> {
        return this.sign("approver", { sub }, APPROVER_TTL);
    }

    async verifyApprover(token: string): Promise<string | null> {
        try {
            const p = await this.verify("approver", token);
            return p.sub === this.cfg.github.allowedUserId ? String(p.sub) : null;
        } catch {
            return null;
        }
    }

    async signApproveForm(planId: string, planHash: string, sub: string): Promise<string> {
        return this.sign("approveform", { plan_id: planId, plan_hash: planHash, sub }, FLOW_TTL);
    }

    async verifyApproveForm(token: string, planId: string, sub: string): Promise<string> {
        const p = await this.verify("approveform", token);
        if (p.plan_id !== planId || p.sub !== sub || typeof p.plan_hash !== "string") throw new OAuthError("invalid_request", "Formulario de aprobación inválido.");
        return p.plan_hash;
    }
}

// --- Redirecciones permitidas ---

const EXACT_REDIRECTS = new Set([
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector_platform_oauth_redirect/",
]);

/**
 * claude.ai/claude.com, ChatGPT y loopback local (Codex, Claude Code). Nada más: un atacante no
 * puede registrar un cliente que entregue códigos a un dominio propio.
 */
export function isAllowedRedirect(raw: string): boolean {
    if (typeof raw !== "string" || raw.length > 512 || /[\s\\]/.test(raw)) return false;
    if (EXACT_REDIRECTS.has(raw)) return true;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return false;
    }
    if (u.username || u.password || u.hash) return false;
    if (u.protocol === "https:" && u.hostname === "chatgpt.com" && /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}\/?$/.test(u.pathname) && !u.search) return true;
    if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
    return false;
}

export function s256(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function safeShow(u: string): string {
    return u.slice(0, 120).replace(/[<>"']/g, "");
}
