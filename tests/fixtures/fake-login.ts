import type { FakeWeb } from "./fake-web.js";

/**
 * Login web SINTÉTICO de Moodle 5.1 (login/index.php + tool_mfa con código por correo y
 * «confiar en este dispositivo»), según el código auditado para ADR-088. Datos 100 % sintéticos.
 */
export const LOGIN_USER = "docente";
export const LOGIN_PASSWORD = "contraseña-web-sintética";

export class FakeLogin {
    mfaEnabled = true;
    /** Duración de la confianza (UdeSA: 28 días). */
    trustSeconds = 28 * 86_400;
    captcha = false;
    forcePasswordChange = false;
    /** Correos con código enviados (cuántas veces se armó la página del MFA sin código vigente). */
    readonly emails: string[] = [];
    /** Intentos fallidos de contraseña (lo que sumaría al bloqueo de la cuenta). */
    failedPasswords = 0;
    failedCodes = 0;
    readonly trustTokens = new Set<string>();
    private seq = 0;
    private readonly anon = new Map<string, { token: string; error: string | null }>();
    private readonly pending = new Map<string, number>();
    private code: string | null = null;

    constructor(
        private readonly web: FakeWeb,
        private readonly origin: string,
        private readonly userId: number,
    ) {
        web.loginFlow = (url, req) => this.handle(url, req);
    }

    private html(body: string, status = 200, cookies: string[] = []) {
        const h = new Headers({ "content-type": "text/html; charset=utf-8" });
        for (const c of cookies) h.append("set-cookie", c);
        return new Response(body, { status, headers: h });
    }

    private redirect(to: string, cookies: string[] = []) {
        const h = new Headers({ location: to.startsWith("http") ? to : `${this.origin}${to}` });
        for (const c of cookies) h.append("set-cookie", c);
        return new Response(null, { status: 303, headers: h });
    }

    private cookie(cookie: string, name: string): string | null {
        return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1] ?? null;
    }

    private loginForm(token: string, error: string | null) {
        const err = error ? `<a href="#" id="loginerrormessage" class="sr-only">${error}</a><div class="alert alert-danger" role="alert">${error}</div>` : "";
        const captcha = this.captcha ? `<div class="login-form-recaptcha"><div class="g-recaptcha" data-sitekey="x"></div></div>` : "";
        return `<html><body id="page-login-index">${err}<form class="login-form" action="${this.origin}/login/index.php" method="post" id="login"><input type="hidden" name="logintoken" value="${token}"><input type="text" name="username" id="username" value=""><input type="password" name="password" id="password" value="">${captcha}<button type="submit" id="loginbtn">Acceder</button></form><a href="${this.origin}/auth/oauth2/login.php?id=4&amp;sesskey=x">Google</a></body></html>`;
    }

    private handle(url: URL, req: { method: string; body: string | null; cookie: string }): Response | null {
        const sess = this.cookie(req.cookie, "MoodleSession");
        if (url.pathname === "/login/index.php") {
            const testsession = url.searchParams.get("testsession");
            if (testsession) {
                const uid = sess ? this.pending.get(sess) : undefined;
                if (sess && this.web.sessions.has(sess)) return this.redirect("/my/");
                if (uid !== undefined) return this.redirect("/admin/tool/mfa/auth.php");
                return this.redirect("/login/index.php");
            }
            if (req.method === "GET") {
                const prev = sess ? this.anon.get(sess) : undefined;
                if (prev && sess) {
                    const token = `tok${++this.seq}`.padEnd(32, "x");
                    this.anon.set(sess, { token, error: null });
                    return this.html(this.loginForm(token, prev.error));
                }
                const id = `anon${++this.seq}`;
                const token = `tok${this.seq}`.padEnd(32, "x");
                this.anon.set(id, { token, error: null });
                return this.html(this.loginForm(token, null), 200, [`MoodleSession=${id}; path=/; secure; HttpOnly`]);
            }
            const b = new URLSearchParams(req.body ?? "");
            const a = sess ? this.anon.get(sess) : undefined;
            if (!a || !sess || b.get("logintoken") !== a.token) {
                if (a && sess) this.anon.set(sess, { token: a.token, error: "Su sesión ha expirado (token de login inválido)." });
                return this.redirect("/login/index.php?loginredirect=1");
            }
            if (this.captcha && !b.get("g-recaptcha-response")) return this.redirect("/login/index.php?loginredirect=1");
            if (b.get("username") !== LOGIN_USER || b.get("password") !== LOGIN_PASSWORD) {
                this.failedPasswords++;
                this.anon.set(sess, { token: a.token, error: "Nombre de usuario o contraseña erróneos. Por favor, inténtelo otra vez." });
                return this.redirect("/login/index.php?loginredirect=1");
            }
            // Sesión regenerada; MOODLEID1_ recuerda el usuario.
            this.anon.delete(sess);
            const id = `web${++this.seq}`;
            const cookies = [`MoodleSession=${id}; path=/; secure; HttpOnly`, `MOODLEID1_=recuerdo${this.userId}; expires=Wed, 01 Jan 2031 00:00:00 GMT; path=/`];
            const trust = this.cookie(req.cookie, `MFA_TOKEN_${this.userId}`);
            if (this.forcePasswordChange) {
                this.web.sessions.set(id, this.userId);
                return this.redirect("/login/change_password.php", cookies);
            }
            if (!this.mfaEnabled || (trust && this.trustTokens.has(trust))) this.web.sessions.set(id, this.userId);
            else this.pending.set(id, this.userId);
            return this.redirect(`/login/index.php?testsession=${this.userId}`, cookies);
        }
        if (url.pathname === "/admin/tool/mfa/auth.php") {
            const uid = sess ? this.pending.get(sess) : undefined;
            if (sess && this.web.sessions.has(sess)) return this.redirect("/my/");
            if (uid === undefined || !sess) return this.redirect("/login/index.php");
            if (req.method === "GET") {
                if (!this.code) {
                    this.code = String(100000 + this.emails.length * 7919);
                    this.emails.push(this.code);
                }
                return this.html(
                    `<html><body><form action="${this.origin}/admin/tool/mfa/auth.php" method="post"><input type="hidden" name="logout" value="1"><input type="hidden" name="sesskey" value="MfaSesskey1"><input type="submit" value="Cancelar"></form><form action="${this.origin}/admin/tool/mfa/auth.php" method="post" class="ignoredirty"><input name="sesskey" type="hidden" value="MfaSesskey1"><input name="_qf__tool_mfa_local_form_login_form" type="hidden" value="1"><input name="factor" type="hidden" value="email"><input type="text" name="verificationcode" id="id_verificationcode"><input type="hidden" name="factor_token_trust" value="0"><input type="checkbox" name="factor_token_trust" value="1" checked> Confiar en este dispositivo<input type="submit" name="submitbutton" value="Verificar código"></form></body></html>`,
                );
            }
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("sesskey") !== "MfaSesskey1" || b.get("factor") !== "email" || b.get("verificationcode") !== this.code) {
                this.failedCodes++;
                return this.html(`<html><body><div class="alert alert-danger">Código de verificación incorrecto</div><form action="${this.origin}/admin/tool/mfa/auth.php" method="post"><input name="factor" type="hidden" value="email"><input name="verificationcode"></form></body></html>`);
            }
            this.code = null;
            this.pending.delete(sess);
            this.web.sessions.set(sess, uid);
            const cookies: string[] = [];
            if (b.getAll("factor_token_trust").includes("1")) {
                const t = `confianza${++this.seq}`;
                this.trustTokens.add(t);
                const exp = new Date(Date.now() + this.trustSeconds * 1000).toUTCString();
                cookies.push(`MFA_TOKEN_${uid}=${t}; expires=${exp}; path=/; HttpOnly`);
            }
            return this.redirect("/my/", cookies);
        }
        return null;
    }

    /** Código del último correo (lo que el humano leería en su casilla). */
    get lastCode(): string | null {
        return this.emails.at(-1) ?? null;
    }

    /** Vence la sesión web actual (como si pasaran 4 h sin uso). */
    expireWebSessions() {
        for (const k of [...this.web.sessions.keys()]) if (k.startsWith("web")) this.web.sessions.delete(k);
    }
}
