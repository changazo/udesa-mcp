/**
 * Superficie web FALSA del Moodle sintético (cookies, sesskey, AJAX, páginas). Datos 100 % sintéticos.
 * Registra cada petición para que los tests verifiquen qué se emitió (y qué no).
 */
export const WEB_SESSION_OK = "sintetica0123456789abcdef";
export const WEB_SESSION_OTHER = "otracuenta0123456789abcde";
export const WEB_SESSKEY = "SesskeySint1";

export interface WebRequestLog {
    method: string;
    path: string;
    query: Record<string, string>;
    cookie: string;
    body: string | null;
    userAgent: string | null;
}

type AjaxHandler = (args: Record<string, unknown>) => unknown;
type PageHandler = (query: Record<string, string>, req: { method: string; body: string | null }) => { status?: number; contentType?: string; body: string | Uint8Array | null; headers?: Record<string, string> };

export class FakeWeb {
    /** valor de MoodleSession → userid. */
    readonly sessions = new Map<string, number>([
        [WEB_SESSION_OK, 501],
        [WEB_SESSION_OTHER, 999],
    ]);
    readonly requests: WebRequestLog[] = [];
    /** Si se define, la próxima respuesta autenticada rota la cookie a este valor. */
    rotateTo: string | null = null;
    /** Al rotar, la cookie anterior deja de valer (como hace Moodle al regenerar la sesión). */
    invalidateOnRotate = true;
    /** Cómo responde una sesión inválida: redirección a login o página de login 200. */
    loginMode: "redirect" | "page200" = "redirect";
    /** Redirección forzada (para probar destinos ajenos). */
    redirectTo: string | null = null;
    readonly ajax = new Map<string, AjaxHandler>();
    readonly pages = new Map<string, PageHandler>();
    /** Flujo de login web con MFA (tests del login automático); null = el /login/ de siempre. */
    loginFlow: ((url: URL, req: { method: string; body: string | null; cookie: string }) => Response | null) | null = null;

    constructor(private readonly origin: string) {}

    private userOf(cookie: string): number | null {
        const m = /MoodleSession=([^;\s]+)/.exec(cookie);
        return m ? (this.sessions.get(m[1]!) ?? null) : null;
    }

    private loginResponse(): Response {
        if (this.loginMode === "redirect") return new Response(null, { status: 303, headers: { location: `${this.origin}/login/index.php` } });
        return new Response('<html><body id="page-login-index"><form id="login" action="/login/index.php"><input name="logintoken" value="x"></form></body></html>', {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
        });
    }

    private withRotation(res: Response, cookie: string): Response {
        if (!this.rotateTo) return res;
        const old = /MoodleSession=([^;\s]+)/.exec(cookie)?.[1];
        const uid = old ? this.sessions.get(old) : undefined;
        if (uid === undefined) return res;
        this.sessions.set(this.rotateTo, uid);
        if (this.invalidateOnRotate && old) this.sessions.delete(old);
        const headers = new Headers(res.headers);
        headers.append("set-cookie", `MoodleSession=${this.rotateTo}; path=/; secure; HttpOnly`);
        headers.append("set-cookie", `OtraCookieAjena=nolatomes; path=/`);
        this.rotateTo = null;
        return new Response(res.body, { status: res.status, headers });
    }

    async handle(url: URL, init?: RequestInit): Promise<Response> {
        const headers = new Headers(init?.headers);
        const cookie = headers.get("cookie") ?? "";
        const body = typeof init?.body === "string" ? init.body : null;
        this.requests.push({ method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), cookie, body, userAgent: headers.get("user-agent") });
        if (this.redirectTo) return new Response(null, { status: 302, headers: { location: this.redirectTo } });
        const flow = this.loginFlow?.(url, { method: init?.method ?? "GET", body, cookie });
        if (flow) return flow;
        const uid = this.userOf(cookie);
        if (url.pathname.startsWith("/login/")) return new Response("<html><body id=\"page-login-index\"><form id=\"login\"></form></body></html>", { status: 200, headers: { "content-type": "text/html" } });
        if (uid === null) return this.loginResponse();
        if (url.pathname === "/user/preferences.php") {
            const html = `<html><head><script>M.cfg = {"wwwroot":"${this.origin}","sesskey":"${WEB_SESSKEY}","userId":${uid}};</script></head><body><div class="logininfo">Usted se ha identificado como <a href="${this.origin}/user/profile.php?id=${uid}" title="Ver perfil">Usuario Sintético</a> (<a href="${this.origin}/login/logout.php?sesskey=${WEB_SESSKEY}">Cerrar sesión</a>)</div></body></html>`;
            return this.withRotation(new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }), cookie);
        }
        if (url.pathname === "/lib/ajax/service.php") {
            if (url.searchParams.get("sesskey") !== WEB_SESSKEY) return Response.json({ error: "Invalid sesskey", errorcode: "invalidsesskey" });
            const calls = JSON.parse(body ?? "[]") as { methodname: string; args: Record<string, unknown> }[];
            const out = calls.map((c) => {
                const h = this.ajax.get(c.methodname);
                if (!h) return { error: true, exception: { errorcode: "servicenotavailable", message: "No disponible" } };
                try {
                    return { error: false, data: h(c.args) };
                } catch (e) {
                    return { error: true, exception: { errorcode: (e as { errorcode?: string }).errorcode ?? "generalexceptionmessage", message: (e as Error).message } };
                }
            });
            return this.withRotation(Response.json(out), cookie);
        }
        const page = this.pages.get(url.pathname);
        if (page) {
            const r = page(Object.fromEntries(url.searchParams), { method: init?.method ?? "GET", body });
            const res = new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "text/html; charset=utf-8", ...(r.headers ?? {}) } });
            return this.withRotation(res, cookie);
        }
        return new Response("not found", { status: 404 });
    }
}
