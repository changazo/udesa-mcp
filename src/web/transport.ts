import { CampusError } from "../errors.js";
import type { FetchLike } from "../moodle/transport.js";
import { readWithLimit } from "../moodle/transport.js";
import type { Logger } from "../util/logger.js";
import { decodeEntities } from "../domain/html.js";
import { assertAjax, assertWebRoute, WEB_ROUTES, type WebRouteName } from "./policy.js";
import { MOODLE_COOKIE, revisionOf, type WebCookie, type WebSessionSnapshot, type WebSessionSource } from "./session.js";

export interface WebTransportOptions {
    siteUrl: string;
    source: WebSessionSource;
    /** userid de Moodle que la sesión debe autenticar (de la identidad verificada del perfil). */
    expectedUserId: () => Promise<number>;
    logger: Logger;
    timeoutMs: number;
    fetch?: FetchLike;
    /** Bytes máximos por respuesta. */
    maxBytes?: number;
    /** Peticiones máximas por operación (incluye la de identidad). */
    maxRequests?: number;
    /** Instrucción para renovar la sesión (distinta en local y en remoto). */
    renewHint: string;
    /**
     * User-Agent explícito de todas las peticiones web (ADR-121): Moodle lo muestra en el correo del
     * código y lo guarda con el acceso, así se reconoce que es el MCP. Por defecto, el local.
     */
    userAgent?: string;
}

/** Identificación honesta del cliente web: qué es y desde dónde corre. */
export function webUserAgent(mode: "local" | "remoto"): string {
    return `udesa-campus-mcp/0.1 (MCP del Campus; ${mode})`;
}

/**
 * Login web automático (opcional, no recomendado; ADR-088). Si está configurado, `open()` lo usa
 * una vez cuando no hay sesión o la guardada venció, en lugar de devolver AUTH_REQUIRED de entrada.
 */
export interface WebAutoLogin {
    /** Inicia sesión, guarda el snapshot en la fuente y lo devuelve. Lanza CampusError si no puede. */
    login(): Promise<WebSessionSnapshot>;
}

export interface WebPage {
    status: number;
    contentType: string | null;
    bytes: Uint8Array;
    /** Ruta final (sin query) tras redirecciones validadas. */
    path: string;
}

/** Datos de identidad extraídos de una página autenticada. */
export function inspectPage(html: string): { login: boolean; userIds: number[]; sesskey: string | null; error: string | null } {
    const login = /<form[^>]+id="login"|name="logintoken"|id="page-login-index"/i.test(html);
    const info = /class="[^"]*\blogininfo\b[^"]*"[^>]*>([\s\S]{0,2000}?)<\/div>/i.exec(html)?.[1] ?? "";
    const userIds = [...new Set([...info.matchAll(/user\/profile\.php\?id=(\d{1,12})/g)].map((m) => Number(m[1])))];
    const sesskey = /"sesskey"\s*:\s*"([A-Za-z0-9]{6,64})"/.exec(html)?.[1] ?? null;
    const errBox = /class="[^"]*\berrorbox\b[^"]*"[^>]*>([\s\S]{0,1500}?)<\/div>/i.exec(html)?.[1];
    const error = errBox ? decodeEntities(errBox.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200) || "error" : null;
    return { login, userIds, sesskey, error };
}

/**
 * Transporte HTTP web autenticado con cookies (directiva §5). Cada operación arma su propio
 * frasco de cookies a partir del snapshot: las rotaciones (Set-Cookie) sólo viven durante la
 * operación; en local, una renovación validada puede persistirse en el keyring.
 */
export class WebTransport {
    private readonly fetchImpl: FetchLike;
    private readonly site: URL;
    private readonly basePath: string;
    private autoLogin: WebAutoLogin | null = null;

    constructor(private readonly opts: WebTransportOptions) {
        this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
        this.site = new URL(opts.siteUrl);
        this.basePath = this.site.pathname.replace(/\/+$/, "");
    }

    /** Habilita el login automático (decisión explícita del dueño: local, ADR-088; remoto, ADR-127). */
    setAutoLogin(a: WebAutoLogin | null) {
        this.autoLogin = a;
    }

    get autoLoginEnabled() {
        return this.autoLogin !== null;
    }

    get expectedUserId() {
        return this.opts.expectedUserId;
    }

    get siteOrigin() {
        return this.site.origin;
    }

    get sitePath() {
        return this.basePath;
    }

    get sourceKind() {
        return this.opts.source.kind;
    }

    /** Abre una operación: carga el snapshot, verifica identidad y obtiene el sesskey. */
    async open(): Promise<WebOperation> {
        let snapshot = await this.opts.source.load();
        let loggedIn = false;
        if (!snapshot && this.autoLogin) {
            snapshot = await this.autoLogin.login();
            loggedIn = true;
        }
        if (!snapshot) {
            throw new CampusError("AUTH_REQUIRED", "No hay sesión web del Campus configurada para esta operación.", { humanAction: this.opts.renewHint });
        }
        try {
            return await this.openWith(snapshot);
        } catch (e) {
            // Sesión guardada vencida: un único login automático y un único reintento. Si lo que falló
            // es el token móvil (de ahí sale la identidad esperada), un login web no lo arregla.
            if (!(e instanceof CampusError) || e.code !== "AUTH_REQUIRED" || !this.autoLogin || loggedIn || e.details?.component === "mobile_token") throw e;
            return this.openWith(await this.autoLogin.login());
        }
    }

    private async openWith(snapshot: WebSessionSnapshot): Promise<WebOperation> {
        if (snapshot.origin !== this.site.origin || snapshot.path_prefix !== this.basePath) {
            throw new CampusError("CONFIG_INVALID", "La sesión web es de otro sitio o instalación de Moodle.", { humanAction: this.opts.renewHint });
        }
        const op = new WebOperation(this, snapshot.cookies, this.opts.maxRequests ?? 25);
        op.baseRevision = snapshot.revision;
        let expected: number;
        try {
            expected = await this.opts.expectedUserId();
        } catch (e) {
            // La identidad esperada sale del token móvil: su falla no es una sesión web vencida.
            if (!(e instanceof CampusError)) throw e;
            throw new CampusError(e.code, `Token del servicio móvil: ${e.message}`, { humanAction: e.humanAction, moodleErrorcode: e.moodleErrorcode, details: { ...(e.details ?? {}), component: "mobile_token" } });
        }
        await op.verifyIdentity(expected, snapshot.user_id);
        return op;
    }

    /** Snapshot de una operación de login ya verificada (sólo cookies de sesión de Moodle). */
    snapshotOf(op: WebOperation, now: Date): WebSessionSnapshot {
        if (op.userId === null) throw new CampusError("UNEXPECTED_RESPONSE", "La operación no verificó la identidad.");
        const jar = op.cookies().filter((c) => MOODLE_COOKIE.test(c.name));
        return { v: 1, origin: this.site.origin, path_prefix: this.basePath, user_id: op.userId, cookies: jar, revision: revisionOf(jar), imported_at: now.toISOString() };
    }

    async saveSnapshot(s: WebSessionSnapshot) {
        await this.opts.source.save(s);
    }

    /** Valida cookies nuevas (importación por CLI) y devuelve el snapshot resultante, con rotaciones aplicadas. */
    async validateImport(cookies: WebCookie[], now: Date): Promise<WebSessionSnapshot> {
        const op = new WebOperation(this, cookies, 3);
        const userId = await this.opts.expectedUserId();
        await op.verifyIdentity(userId, userId);
        const jar = op.cookies();
        return { v: 1, origin: this.site.origin, path_prefix: this.basePath, user_id: userId, cookies: jar, revision: revisionOf(jar), imported_at: now.toISOString() };
    }

    /** Persiste una renovación validada (keyring local o KV remoto). Con la semilla fija, muere con la operación. */
    async afterOperation(op: WebOperation) {
        const snapshotUserId = op.userId;
        if (!op.rotated || snapshotUserId === null || (this.opts.source.kind !== "keyring" && this.opts.source.kind !== "kv")) return;
        const jar = op.cookies();
        await this.opts.source.save({ v: 1, origin: this.site.origin, path_prefix: this.basePath, user_id: snapshotUserId, cookies: jar, revision: revisionOf(jar), imported_at: new Date().toISOString() });
    }

    /** Descarta la sesión guardada si sigue siendo la de `revision` (la que falló). */
    async invalidate(revision?: string | null) {
        await this.opts.source.invalidate(revision);
    }

    /** URL absoluta de una ruta de la instalación, validada. */
    url(path: string, query: URLSearchParams | null): URL {
        const u = new URL(this.basePath + path, this.site.origin);
        if (query) u.search = query.toString();
        return u;
    }

    /** Valida un destino de redirección antes de reenviar credenciales. */
    /** Destino dentro del mismo Campus (https, mismo origen e instalación), o error. */
    sameSite(location: string, from: URL): URL {
        let u: URL;
        try {
            u = new URL(location, from);
        } catch {
            throw new CampusError("UNEXPECTED_RESPONSE", "Redirección inválida.");
        }
        if (u.protocol !== "https:" || u.origin !== this.site.origin || !(u.pathname === this.basePath || u.pathname.startsWith(`${this.basePath}/`))) {
            throw new CampusError("RESOURCE_OUT_OF_SCOPE", "Redirección fuera del Campus configurado: no se reenvían credenciales.");
        }
        return u;
    }

    checkRedirect(location: string, from: URL): URL {
        const u = this.sameSite(location, from);
        if (u.pathname.startsWith(`${this.basePath}/login/`) || u.pathname.startsWith(`${this.basePath}/auth/`)) {
            throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció o se cerró.", { humanAction: this.opts.renewHint });
        }
        return u;
    }

    async send(url: URL, init: RequestInit, timeoutMs?: number): Promise<Response> {
        const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}), "user-agent": this.opts.userAgent ?? webUserAgent("local") };
        try {
            return await this.fetchImpl(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs) });
        } catch (e) {
            throw new CampusError("NETWORK_ERROR", `No se pudo contactar al Campus (web): ${e instanceof Error ? e.name : "error"}.`);
        }
    }

    get maxBytes() {
        return this.opts.maxBytes ?? 8 * 1024 * 1024;
    }

    get renewHint() {
        return this.opts.renewHint;
    }

    get logger() {
        return this.opts.logger;
    }
}

export class WebOperation {
    private readonly jar = new Map<string, WebCookie>();
    private requests = 0;
    private sesskey: string | null = null;
    rotated = false;
    /** Revisión del snapshot con el que se abrió (para no descartar uno importado después). */
    baseRevision: string | null = null;
    /** Usuario verificado en esta operación (null hasta verificar). */
    userId: number | null = null;

    constructor(
        private readonly t: WebTransport,
        cookies: WebCookie[],
        private readonly maxRequests: number,
        /** Cookies que acepta el frasco. El login (ADR-088) suma la de dispositivo de confianza del MFA. */
        private readonly cookieFilter: RegExp = MOODLE_COOKIE,
    ) {
        for (const c of cookies) if (this.cookieFilter.test(c.name)) this.jar.set(c.name, c);
    }

    cookies(): WebCookie[] {
        return [...this.jar.values()];
    }

    private cookieHeader(now: number): string {
        return [...this.jar.values()]
            .filter((c) => c.expires === null || c.expires > now)
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");
    }

    private absorb(res: Response) {
        const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        for (const line of list) {
            const [pair, ...attrs] = line.split(";");
            const i = pair?.indexOf("=") ?? -1;
            if (!pair || i <= 0) continue;
            const name = pair.slice(0, i).trim();
            if (!this.cookieFilter.test(name)) continue;
            const value = pair.slice(i + 1).trim();
            let expires: number | null = null;
            for (const a of attrs) {
                const [k, v] = a.split("=").map((x) => x.trim());
                if (/^max-age$/i.test(k ?? "")) expires = Math.floor(Date.now() / 1000) + Number(v);
                else if (/^expires$/i.test(k ?? "") && v) expires = Math.floor(Date.parse(v) / 1000);
                else if (/^domain$/i.test(k ?? "") && v && !this.domainOk(v)) return;
            }
            const old = this.jar.get(name);
            if (!value || value === "deleted" || (expires !== null && expires <= Math.floor(Date.now() / 1000))) {
                if (old) {
                    this.jar.delete(name);
                    this.rotated = true;
                }
                continue;
            }
            if (!old || old.value !== value) this.rotated = true;
            this.jar.set(name, { name, value, expires });
        }
    }

    private domainOk(domain: string) {
        const host = new URL(this.t.url("/", null)).hostname;
        const d = domain.replace(/^\./, "").toLowerCase();
        return host === d || host.endsWith(`.${d}`);
    }

    /** GET/POST con cookies, redirecciones validadas y presupuesto de peticiones. */
    private async fetchPage(url: URL, init: { method: "GET" | "POST"; body?: string; contentType?: string }): Promise<WebPage> {
        let current = url;
        for (let hop = 0; hop < 4; hop++) {
            if (++this.requests > this.maxRequests) {
                throw new CampusError("INCOMPLETE_RESULT", `Se alcanzó el presupuesto de ${this.maxRequests} peticiones web de esta operación.`);
            }
            const headers: Record<string, string> = { cookie: this.cookieHeader(Math.floor(Date.now() / 1000)), accept: "text/html,application/json,application/xml;q=0.9,*/*;q=0.5" };
            if (init.contentType) headers["content-type"] = init.contentType;
            const res = await this.t.send(current, { method: hop === 0 ? init.method : "GET", headers, body: hop === 0 ? init.body : undefined });
            this.absorb(res);
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get("location");
                await res.body?.cancel();
                if (!loc) throw new CampusError("UNEXPECTED_RESPONSE", "Redirección sin destino.");
                const next = this.t.checkRedirect(loc, current);
                // La política audita la ruta pedida, no su destino: otra página (p. ej. manage.php → view.php
                // sin permiso de gestión) puede registrar eventos. Sólo se sigue dentro de la misma ruta.
                if (next.pathname !== url.pathname) {
                    throw new CampusError("UNEXPECTED_RESPONSE", `El Campus redirigió ${url.pathname} a otra página (${next.pathname}); no se sigue (posible falta de permiso o cambio del sitio).`);
                }
                current = next;
                continue;
            }
            const bytes = await readWithLimit(res, this.t.maxBytes);
            return { status: res.status, contentType: res.headers.get("content-type"), bytes, path: current.pathname };
        }
        throw new CampusError("UNEXPECTED_RESPONSE", "Demasiadas redirecciones (web).");
    }

    /** Verifica que la sesión autentica al usuario esperado y obtiene el sesskey. */
    async verifyIdentity(expectedUserId: number, snapshotUserId: number) {
        if (expectedUserId !== snapshotUserId) {
            throw new CampusError("IDENTITY_MISMATCH", "La sesión web se importó para otra cuenta de Moodle.", { humanAction: this.t.renewHint });
        }
        let page: WebPage;
        try {
            page = await this.fetchPage(this.t.url(WEB_ROUTES.identity.path, null), { method: "GET" });
        } catch (e) {
            if (e instanceof CampusError && e.code === "AUTH_REQUIRED") await this.t.invalidate(this.baseRevision);
            throw e;
        }
        const html = new TextDecoder().decode(page.bytes);
        const info = inspectPage(html);
        if (info.login) {
            await this.t.invalidate(this.baseRevision);
            throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció o se cerró.", { humanAction: this.t.renewHint });
        }
        if (page.status !== 200 || info.userIds.length === 0) {
            throw new CampusError("UNEXPECTED_RESPONSE", "No se pudo verificar la identidad de la sesión web (página sin datos de usuario).");
        }
        if (info.userIds.length !== 1 || info.userIds[0] !== expectedUserId) {
            await this.t.invalidate(this.baseRevision);
            throw new CampusError("IDENTITY_MISMATCH", "La sesión web autentica a otra cuenta de Moodle (o a una cuenta «iniciada como»). No se usa.", { humanAction: this.t.renewHint });
        }
        if (!info.sesskey) throw new CampusError("UNEXPECTED_RESPONSE", "La página autenticada no trajo la clave de sesión.");
        this.sesskey = info.sesskey;
        this.userId = expectedUserId;
    }

    /**
     * SÓLO para el transporte de escritura (`src/write/web.ts`), que antes valida la ruta, los campos
     * o el método contra sus propias allowlists (`checkWriteForm`, `checkWriteAjax`). Hace UNA petición
     * y no sigue redirecciones: en un formulario, la redirección ES el éxito. El destino de la
     * redirección igual se valida (mismo origen; login = sesión vencida).
     */
    async writeRequest(path: string, query: URLSearchParams | null, init: { method: "GET" | "POST"; body?: string; contentType?: string }): Promise<{ status: number; location: string | null; contentType: string | null; bytes: Uint8Array }> {
        if (++this.requests > this.maxRequests) throw new CampusError("INCOMPLETE_RESULT", `Se alcanzó el presupuesto de ${this.maxRequests} peticiones web de esta operación.`);
        const url = this.t.url(path, query);
        const headers: Record<string, string> = { cookie: this.cookieHeader(Math.floor(Date.now() / 1000)), accept: "text/html,application/json;q=0.9,*/*;q=0.5" };
        if (init.contentType) headers["content-type"] = init.contentType;
        const res = await this.t.send(url, { method: init.method, headers, body: init.body });
        this.absorb(res);
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            await res.body?.cancel();
            return { status: res.status, location: loc ? this.t.checkRedirect(loc, url).toString() : null, contentType: null, bytes: new Uint8Array() };
        }
        const bytes = await readWithLimit(res, this.t.maxBytes);
        return { status: res.status, location: null, contentType: res.headers.get("content-type"), bytes };
    }

    /**
     * SÓLO para el login web (`src/web/login.ts`, ADR-088): UNA petición, sin seguir redirecciones,
     * a una ruta del propio flujo de login. El destino de una redirección se valida (mismo Campus)
     * pero NO se trata /login/ como sesión vencida: es parte del flujo.
     */
    async loginRequest(path: string, query: URLSearchParams | null, init: { method: "GET" | "POST"; body?: string; contentType?: string; timeoutMs?: number }): Promise<{ status: number; location: URL | null; contentType: string | null; html: string }> {
        if (++this.requests > this.maxRequests) throw new CampusError("INCOMPLETE_RESULT", `Se alcanzó el presupuesto de ${this.maxRequests} peticiones web del login.`);
        const url = this.t.url(path, query);
        const headers: Record<string, string> = { cookie: this.cookieHeader(Math.floor(Date.now() / 1000)), accept: "text/html;q=0.9,*/*;q=0.5" };
        if (init.contentType) headers["content-type"] = init.contentType;
        const res = await this.t.send(url, { method: init.method, headers, body: init.body }, init.timeoutMs);
        this.absorb(res);
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            await res.body?.cancel();
            return { status: res.status, location: loc ? this.t.sameSite(loc, url) : null, contentType: null, html: "" };
        }
        const bytes = await readWithLimit(res, this.t.maxBytes);
        return { status: res.status, location: null, contentType: res.headers.get("content-type"), html: new TextDecoder().decode(bytes) };
    }

    /** sesskey de la operación verificada, para el transporte de escritura. Nunca se registra. */
    get sesskeyForWrite(): string {
        if (!this.sesskey) throw new CampusError("UNEXPECTED_RESPONSE", "Falta la clave de sesión.");
        return this.sesskey;
    }

    /** GET a una ruta admitida por la política. */
    async get(name: WebRouteName, params: Record<string, string>): Promise<WebPage> {
        const route = assertWebRoute(name, params);
        const inPath = new Set(route.pathParams ?? []);
        const q = new URLSearchParams(Object.entries(params).filter(([k]) => !inPath.has(k)));
        if (route.sesskey) {
            if (!this.sesskey) throw new CampusError("UNEXPECTED_RESPONSE", "Falta la clave de sesión.");
            q.set("sesskey", this.sesskey);
        }
        const path = route.pathTemplate ? route.pathTemplate(params) : route.path;
        const page = await this.fetchPage(this.t.url(path, q), { method: "GET" });
        const ct = page.contentType ?? "";
        if (ct.includes("html")) {
            const info = inspectPage(new TextDecoder().decode(page.bytes));
            if (info.login) {
                await this.t.invalidate(this.baseRevision);
                throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció durante la operación.", { humanAction: this.t.renewHint });
            }
            if (info.error) throw new CampusError("MOODLE_PERMISSION_DENIED", `El Campus rechazó la operación ${String(name)}: ${info.error}`);
        }
        if (page.status === 403 || page.status === 401) throw new CampusError("MOODLE_PERMISSION_DENIED", `HTTP ${page.status} en ${String(name)}.`);
        if (page.status === 404) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El Campus no encontró el recurso de ${String(name)}.`);
        if (page.status !== 200) throw new CampusError("UNEXPECTED_RESPONSE", `HTTP ${page.status} en ${String(name)}.`);
        return page;
    }

    /** Llamada AJAX (lib/ajax/service.php) admitida por la política. */
    async ajax<T>(method: string, args: Record<string, unknown>): Promise<T> {
        assertAjax(method, args);
        if (!this.sesskey) throw new CampusError("UNEXPECTED_RESPONSE", "Falta la clave de sesión.");
        const q = new URLSearchParams({ sesskey: this.sesskey, info: method });
        const page = await this.fetchPage(this.t.url("/lib/ajax/service.php", q), {
            method: "POST",
            body: JSON.stringify([{ index: 0, methodname: method, args }]),
            contentType: "application/json",
        });
        let data: unknown;
        try {
            data = JSON.parse(new TextDecoder().decode(page.bytes));
        } catch {
            throw new CampusError("UNEXPECTED_RESPONSE", `Respuesta AJAX no interpretable para ${method}.`);
        }
        const fail = (errorcode: string | undefined, message: string | undefined): never => {
            if (errorcode && /^(servicerequireslogin|requireloginerror|invalidsesskey|sessionexpired)$/.test(errorcode)) {
                throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció durante la operación.", { humanAction: this.t.renewHint, moodleErrorcode: errorcode });
            }
            if (errorcode && /^(nopermissions|required_capability_exception|accessdenied|nopermissiontoviewpage)$/.test(errorcode)) {
                throw new CampusError("MOODLE_PERMISSION_DENIED", `El Campus rechazó ${method}: ${(message ?? "sin permiso").slice(0, 200)}`, { moodleErrorcode: errorcode });
            }
            throw new CampusError("MOODLE_ERROR", `El Campus rechazó ${method}: ${(message ?? "error").slice(0, 200)}`, { moodleErrorcode: errorcode });
        };
        if (!Array.isArray(data)) {
            const d = data as { error?: string; errorcode?: string };
            return fail(d?.errorcode, d?.error);
        }
        const first = data[0] as { error?: boolean; data?: unknown; exception?: { errorcode?: string; message?: string } } | undefined;
        if (!first) throw new CampusError("UNEXPECTED_RESPONSE", `Respuesta AJAX vacía para ${method}.`);
        if (first.error) return fail(first.exception?.errorcode, first.exception?.message);
        return first.data as T;
    }
}
