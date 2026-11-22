import { CampusError } from "../errors.js";
import { decodeEntities } from "../domain/html.js";
import { MOODLE_COOKIE, type WebCookie, type WebSessionSnapshot } from "./session.js";
import { WebOperation, type WebTransport } from "./transport.js";

/**
 * Login web con usuario y contraseña (opcional, no recomendado; ADR-088). Reproduce lo que hace
 * el navegador en `login/index.php` y, si el Campus lo pide, el factor «código por correo» de
 * tool_mfa con «confiar en este dispositivo» (cookie MFA_TOKEN_<userid>). Cualquier otra cosa
 * (captcha, otro factor, cambio de contraseña forzado, políticas, solo Google) falla cerrado.
 * Nunca reintenta: una contraseña o un código equivocado suman al bloqueo de la cuenta.
 */

/** Cookie de dispositivo de confianza de tool_mfa (factor_token). */
export const TRUST_COOKIE = /^MFA_TOKEN_\d{1,12}$/;
const LOGIN_COOKIES = new RegExp(`${MOODLE_COOKIE.source}|${TRUST_COOKIE.source}`);
const LOGIN_PATH = "/login/index.php";
const MFA_PATH = "/admin/tool/mfa/auth.php";
const MAX_REQUESTS = 12;
/** Plazo total del login (ADR-121): entra con margen en una función remota de 60 s. */
export const LOGIN_DEADLINE_MS = 25_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Pide el código que el Campus mandó por correo (diálogo o terminal). null = cancelado o sin canal. */
export type MfaCodePrompt = () => Promise<string | null>;

export interface LoginInput {
    username: string;
    password: string;
    /** Cookies recordadas de logins anteriores: MOODLEID1_ y MFA_TOKEN_<userid>. */
    remembered: WebCookie[];
    /** Sin canal para el código: si el Campus lo pide, AUTH_REQUIRED (ya habrá mandado el correo). */
    askCode?: MfaCodePrompt;
    now?: () => Date;
    /** Plazo total de las peticiones del login (sin contar la espera del código). */
    deadlineMs?: number;
}

export interface LoginResult {
    snapshot: WebSessionSnapshot;
    /** Cookies a recordar para el próximo login (MOODLEID1_ y la de confianza, si hay). */
    remembered: WebCookie[];
    /** Cómo se resolvió el segundo factor. */
    mfa: "no_pedido" | "dispositivo_de_confianza" | "codigo";
    /** Vencimiento de la confianza del dispositivo (ISO), si se conoce. */
    trust_expires_at: string | null;
}

interface Form {
    action: string;
    fields: Map<string, string>;
    names: Set<string>;
}

const attr = (tag: string, name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
    return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
};

/** Primer formulario que cumple `match` (por id o por acción), con sus campos. */
export function parseForm(html: string, match: (tag: string) => boolean): Form | null {
    return parseForms(html, match)[0] ?? null;
}

/** Todos los formularios que cumplen `match`: hidden con valor; el resto, sólo el nombre. */
export function parseForms(html: string, match: (tag: string) => boolean): Form[] {
    const out: Form[] = [];
    for (const m of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
        const tag = /^<form\b[^>]*>/i.exec(m[0])![0];
        if (!match(tag)) continue;
        const fields = new Map<string, string>();
        const names = new Set<string>();
        for (const im of m[1]!.matchAll(/<(input|button|textarea|select)\b[^>]*>/gi)) {
            const name = attr(im[0], "name");
            if (!name) continue;
            names.add(name);
            const type = (attr(im[0], "type") ?? "").toLowerCase();
            if (type === "hidden") fields.set(name, attr(im[0], "value") ?? "");
            else if ((type === "submit" || im[1]!.toLowerCase() === "button") && !fields.has(name)) fields.set(name, attr(im[0], "value") ?? "");
        }
        out.push({ action: attr(tag, "action") ?? "", fields, names });
    }
    return out;
}

/** Estructura de los formularios de una página, SIN valores: para diagnosticar un formato inesperado. */
function formShape(forms: Form[]): string {
    if (!forms.length) return "ningún formulario hacia auth.php";
    return forms
        .map((f, i) => {
            const factor = f.fields.get("factor");
            const names = [...f.names].filter((n) => !/^(sesskey|_qf__)/.test(n)).slice(0, 12).join(", ");
            return `#${i + 1}: factor=${factor ?? "—"}; campos: ${names || "—"}`;
        })
        .join(" | ");
}

/** Texto del aviso de error del formulario de login (#loginerrormessage o alerta), recortado. */
export function loginErrorText(html: string): string | null {
    const m = /id="loginerrormessage"[^>]*>([\s\S]{0,600}?)<\/(?:a|div|p|span)>/i.exec(html) ?? /class="[^"]*\balert-danger\b[^"]*"[^>]*>([\s\S]{0,600}?)<\/div>/i.exec(html);
    if (!m) return null;
    const text = decodeEntities(m[1]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 160) : null;
}

function pathOf(t: WebTransport, u: URL): string {
    return u.pathname.slice(t.sitePath.length) || "/";
}

function fail(code: "AUTH_REQUIRED" | "AUTH_REJECTED" | "UNEXPECTED_RESPONSE", message: string, reason?: string): never {
    throw new CampusError(code, message, {
        humanAction: "Revisá el login automático con: auth web autologin status. Para cargar la contraseña de nuevo: auth web autologin enable.",
        ...(reason ? { details: { reason } } : {}),
    });
}

/** Motivo de un AUTH_REQUIRED del login: el Campus pidió el código y no había canal (ADR-121). */
export const MFA_CODE_REQUIRED = "mfa_code_required";

type LoginRequest = WebOperation["loginRequest"];

/** Página a la que llegó el login que NO es una sesión lista: se nombra para el error. */
function blockingPage(path: string): string | null {
    if (path.startsWith("/login/change_password.php")) return "el Campus exige cambiar la contraseña";
    if (path.startsWith("/admin/tool/policy/") || path.startsWith("/user/policy.php")) return "hay políticas del sitio pendientes de aceptar";
    if (path.startsWith("/login/") || path.startsWith("/auth/")) return "el login no se completó";
    return null;
}

/** Motivos tipados de los rechazos y cortes del login (ADR-141): los usa el coordinador remoto. */
export const PASSWORD_REJECTED = "password_rejected";
export const OTP_REJECTED = "otp_rejected";
export const OTP_MALFORMED = "otp_malformed";

/**
 * Continuación del factor por correo (ADR-141): lo mínimo para completar la MISMA sesión candidata
 * cuando el humano trae el código, en otra petición o en otra instancia. Sin contraseña, sin código,
 * sin HTML: el frasco de cookies de la candidata, los campos ocultos del formulario del código y el
 * presupuesto que queda. La ruta del POST es una constante del servidor, nunca el `action` del HTML.
 */
export interface MfaContinuation {
    v: 1;
    origin: string;
    path_prefix: string;
    expected_user_id: number;
    cookies: WebCookie[];
    /** Campos del formulario del código (ocultos y botón), en orden. */
    fields: [string, string][];
    /** El formulario trae «confiar en este dispositivo». */
    trust_control: boolean;
    /** El login partió con una confianza recordada (para informar cómo se resolvió el factor). */
    had_trust: boolean;
    requests_used: number;
    budget_ms_left: number;
    created_at: string;
}

export type BeginLoginResult = { kind: "complete"; result: LoginResult } | { kind: "awaiting_code"; continuation: MfaContinuation };

/** Marca en un error si ya salieron credenciales hacia Moodle (para separar «falló» de «incierto»). */
function staged(e: unknown, sent: boolean): never {
    if (e instanceof CampusError) throw new CampusError(e.code, e.message, { humanAction: e.humanAction, moodleErrorcode: e.moodleErrorcode, details: { ...(e.details ?? {}), credentials_sent: sent } });
    throw e;
}

/** Peticiones con presupuesto total; la espera del código no cuenta. */
function budgeted(op: WebOperation, budget: { ms: number }): LoginRequest {
    return async (path, query, init) => {
        if (budget.ms <= 0) fail("UNEXPECTED_RESPONSE", "El login web no terminó dentro del plazo; no se sigue (el Campus responde lento).");
        const started = Date.now();
        try {
            return await op.loginRequest(path, query, { ...init, timeoutMs: Math.min(budget.ms, REQUEST_TIMEOUT_MS) });
        } finally {
            budget.ms -= Date.now() - started;
        }
    };
}

/** Sigue sólo el propio flujo: testsession, la página del MFA y el destino final (sin pedirlo). */
async function follow(t: WebTransport, req: LoginRequest, from: URL | null): Promise<{ mfaAt: URL | null }> {
    let next = from;
    for (let hop = 0; hop < 4 && next; hop++) {
        const p = pathOf(t, next);
        if (p === LOGIN_PATH && next.searchParams.has("testsession")) {
            next = (await req(LOGIN_PATH, next.searchParams, { method: "GET" })).location;
            continue;
        }
        if (p === MFA_PATH) return { mfaAt: next };
        const blocked = blockingPage(p);
        if (blocked) fail("AUTH_REQUIRED", `El login automático se detuvo: ${blocked}. Entrá una vez desde el navegador.`);
        break; // destino normal (p. ej. /my/): la sesión ya está creada; no se pide la página.
    }
    return { mfaAt: null };
}

/** Identidad y resultado de una sesión candidata completa. */
async function finish(t: WebTransport, op: WebOperation, expected: number, mfa: LoginResult["mfa"], budget: { ms: number }, now: () => Date): Promise<LoginResult> {
    // La verificación de identidad también entra en el plazo del login.
    if (budget.ms <= 0) fail("UNEXPECTED_RESPONSE", "El login web no terminó dentro del plazo; no se sigue (el Campus responde lento).");
    await op.verifyIdentity(expected, expected);
    const jar = op.cookies();
    const keep = jar.filter((c) => TRUST_COOKIE.test(c.name) || /^MOODLEID\d*_/.test(c.name));
    const trust = jar.find((c) => c.name === `MFA_TOKEN_${expected}`) ?? jar.find((c) => TRUST_COOKIE.test(c.name));
    return {
        snapshot: t.snapshotOf(op, now()),
        remembered: keep,
        mfa,
        trust_expires_at: trust?.expires ? new Date(trust.expires * 1000).toISOString() : null,
    };
}

/**
 * Inicio del login (ADR-141): formulario, contraseña y, si el Campus pide el código, la página del factor
 * (que manda el correo). Devuelve la sesión completa o la continuación para cuando llegue el código.
 * Los errores llevan `details.credentials_sent`: después del POST de la contraseña, un corte es incierto.
 */
export async function beginPasswordLogin(t: WebTransport, input: Omit<LoginInput, "askCode">): Promise<BeginLoginResult> {
    const now = input.now ?? (() => new Date());
    const expected = await t.expectedUserId();
    const remembered = input.remembered.filter((c) => LOGIN_COOKIES.test(c.name) && !/^MoodleSession/.test(c.name));
    const hadTrust = remembered.some((c) => TRUST_COOKIE.test(c.name));
    const op = new WebOperation(t, remembered, MAX_REQUESTS, LOGIN_COOKIES);
    const budget = { ms: input.deadlineMs ?? LOGIN_DEADLINE_MS };
    const req = budgeted(op, budget);
    let sent = false;
    try {
        // 1) Formulario: sesión anónima nueva + logintoken de un solo uso.
        const page = await req(LOGIN_PATH, null, { method: "GET" });
        if (page.location) fail("UNEXPECTED_RESPONSE", `La página de login redirigió a ${pathOf(t, page.location)} (¿login sólo por Google o sitio en mantenimiento?).`);
        if (/g-recaptcha|login-form-recaptcha/i.test(page.html)) fail("AUTH_REQUIRED", "El login web del Campus pide captcha: el login automático no es posible (no se esquiva).");
        const form = parseForm(page.html, (tag) => /\bid\s*=\s*"login"/i.test(tag) || /login\/index\.php/i.test(tag));
        const token = form?.fields.get("logintoken");
        if (!form || !token || !form.names.has("username") || !form.names.has("password")) {
            fail("UNEXPECTED_RESPONSE", "La página de login del Campus no tiene el formulario esperado (usuario, contraseña y logintoken).");
        }

        // 2) Usuario y contraseña. Moodle responde con una redirección: testsession = éxito; el formulario otra vez = rechazo.
        const body = new URLSearchParams({ anchor: "", logintoken: token, username: input.username, password: input.password });
        sent = true;
        const posted = await req(LOGIN_PATH, null, { method: "POST", body: body.toString(), contentType: "application/x-www-form-urlencoded" });
        if (!posted.location) fail("UNEXPECTED_RESPONSE", `El login respondió HTTP ${posted.status} sin redirección.`);
        if (pathOf(t, posted.location) === LOGIN_PATH && !posted.location.searchParams.has("testsession")) {
            // El motivo queda en la sesión y se muestra al volver al formulario.
            const back = await req(LOGIN_PATH, posted.location.searchParams, { method: "GET" });
            const msg = loginErrorText(back.html);
            if (msg && /token|sesi[oó]n|session|expir|caduc/i.test(msg) && !/contrase|password|usuario|username/i.test(msg)) {
                fail("UNEXPECTED_RESPONSE", `El Campus rechazó el formulario de login sin evaluar la contraseña («${msg}»). No cuenta como intento fallido; se puede volver a intentar más tarde.`);
            }
            fail("AUTH_REJECTED", `El Campus rechazó el usuario o la contraseña guardados${msg ? ` («${msg}»)` : ""}. El login automático se desactiva para no sumar intentos fallidos (bloqueo de cuenta).`, PASSWORD_REJECTED);
        }

        // 3) El propio flujo hasta el destino o la página del factor.
        const { mfaAt } = await follow(t, req, posted.location);
        if (!mfaAt) return { kind: "complete", result: await finish(t, op, expected, hadTrust ? "dispositivo_de_confianza" : "no_pedido", budget, now) };

        // 4) Página del factor: al armarla, el Campus manda el correo con el código (si no hay uno vigente).
        const mfaPage = await req(MFA_PATH, mfaAt.searchParams, { method: "GET" });
        if (mfaPage.location) {
            // Ya resuelto (p. ej. dispositivo de confianza): seguir hasta el destino.
            const again = await follow(t, req, mfaPage.location);
            if (again.mfaAt) fail("AUTH_REQUIRED", "El Campus volvió a pedir el segundo factor: el login automático no lo resuelve.");
            return { kind: "complete", result: await finish(t, op, expected, "codigo", budget, now) };
        }
        // La página puede traer más de un formulario hacia auth.php (p. ej. cancelar/cerrar sesión): vale el del código.
        const forms = parseForms(mfaPage.html, (tag) => /tool\/mfa\/auth\.php/i.test(tag) || !/\baction\s*=/i.test(tag));
        const codeForm = forms.find((f) => f.names.has("verificationcode"));
        if (!codeForm || (codeForm.fields.has("factor") && codeForm.fields.get("factor") !== "email")) {
            fail("AUTH_REQUIRED", `El Campus pidió un segundo factor que el login automático no reconoce (${formShape(forms)}).`);
        }
        // Sólo lo necesario: los campos del formulario del código, nunca los de otro formulario (logout).
        const fields = [...codeForm.fields].filter(([n]) => n !== "verificationcode" && n !== "factor_token_trust" && n !== "logout");
        return {
            kind: "awaiting_code",
            continuation: {
                v: 1,
                origin: t.siteOrigin,
                path_prefix: t.sitePath,
                expected_user_id: expected,
                cookies: op.cookies(),
                fields,
                trust_control: codeForm.names.has("factor_token_trust"),
                had_trust: hadTrust,
                requests_used: op.requestsUsed,
                budget_ms_left: Math.max(0, budget.ms),
                created_at: now().toISOString(),
            },
        };
    } catch (e) {
        staged(e, sent);
    }
}

/**
 * Completa la MISMA sesión candidata con el código (ADR-141). Un código mal formado no se envía (no
 * consume el factor); uno enviado y rechazado es terminal. Los errores llevan `details.credentials_sent`.
 */
export async function completePasswordLogin(t: WebTransport, c: MfaContinuation, code: string, opts: { now?: () => Date } = {}): Promise<LoginResult> {
    const now = opts.now ?? (() => new Date());
    if (c.v !== 1 || c.origin !== t.siteOrigin || c.path_prefix !== t.sitePath) throw new CampusError("CONFIG_INVALID", "La continuación del login es de otro sitio o de otra versión: no se usa.");
    const expected = await t.expectedUserId();
    if (c.expected_user_id !== expected) throw new CampusError("IDENTITY_MISMATCH", "La continuación del login es de otra cuenta de Moodle: no se usa.");
    const otp = code.trim();
    if (!/^\d{6}$/.test(otp)) throw new CampusError("AUTH_REQUIRED", "El código de verificación son 6 dígitos; no se envió nada.", { details: { reason: OTP_MALFORMED, credentials_sent: false } });
    const op = new WebOperation(t, c.cookies, Math.max(1, MAX_REQUESTS - c.requests_used), LOGIN_COOKIES);
    const budget = { ms: c.budget_ms_left };
    const req = budgeted(op, budget);
    let sent = false;
    try {
        const fields = new URLSearchParams(c.fields);
        fields.set("verificationcode", otp);
        if (c.trust_control) fields.set("factor_token_trust", "1");
        sent = true;
        const posted = await req(MFA_PATH, null, { method: "POST", body: fields.toString(), contentType: "application/x-www-form-urlencoded" });
        if (!posted.location) fail("AUTH_REJECTED", "El Campus no aceptó el código de verificación (incorrecto o vencido). No se reintenta.", OTP_REJECTED);
        if (pathOf(t, posted.location) === MFA_PATH) fail("AUTH_REQUIRED", "Después del código, el Campus pidió otro factor más: el login automático no lo resuelve.");
        const after = await follow(t, req, posted.location);
        if (after.mfaAt) fail("AUTH_REQUIRED", "Después del código, el Campus pidió otro factor más: el login automático no lo resuelve.");
        return await finish(t, op, expected, "codigo", budget, now);
    } catch (e) {
        staged(e, sent);
    }
}

/**
 * Login completo en una sola llamada (CLI y modo local): inicio, código por `askCode` si hace falta y la
 * misma continuación. Sin canal para el código, AUTH_REQUIRED con `MFA_CODE_REQUIRED` (el Campus ya habrá
 * mandado el correo): AutoLogin lo usa para marcar «necesita confianza» y no repetir correos.
 */
export async function passwordLogin(t: WebTransport, input: LoginInput): Promise<LoginResult> {
    const begun = await beginPasswordLogin(t, input);
    if (begun.kind === "complete") return begun.result;
    if (!input.askCode) {
        fail("AUTH_REQUIRED", "El Campus pidió el código de verificación (te mandó un correo: no uses su enlace «no fui yo») y no hay forma de pedírtelo acá. Renová la confianza del dispositivo con: auth web autologin enable.", MFA_CODE_REQUIRED);
    }
    const code = ((await input.askCode()) ?? "").trim();
    if (!code) fail("AUTH_REQUIRED", "No se ingresó el código de verificación: el login automático quedó sin completar.");
    return completePasswordLogin(t, begun.continuation, code, { now: input.now });
}
