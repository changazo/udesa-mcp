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

export async function passwordLogin(t: WebTransport, input: LoginInput): Promise<LoginResult> {
    const now = input.now ?? (() => new Date());
    const expected = await t.expectedUserId();
    const remembered = input.remembered.filter((c) => LOGIN_COOKIES.test(c.name) && !/^MoodleSession/.test(c.name));
    const hadTrust = remembered.some((c) => TRUST_COOKIE.test(c.name));
    const op = new WebOperation(t, remembered, MAX_REQUESTS, LOGIN_COOKIES);
    // Plazo total: cada petición usa lo que queda (con un tope), y la espera del código no cuenta.
    let budget = input.deadlineMs ?? LOGIN_DEADLINE_MS;
    const req: LoginRequest = async (path, query, init) => {
        if (budget <= 0) fail("UNEXPECTED_RESPONSE", "El login web no terminó dentro del plazo; no se sigue (el Campus responde lento).");
        const started = Date.now();
        try {
            return await op.loginRequest(path, query, { ...init, timeoutMs: Math.min(budget, REQUEST_TIMEOUT_MS) });
        } finally {
            budget -= Date.now() - started;
        }
    };

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
    const posted = await req(LOGIN_PATH, null, { method: "POST", body: body.toString(), contentType: "application/x-www-form-urlencoded" });
    if (!posted.location) fail("UNEXPECTED_RESPONSE", `El login respondió HTTP ${posted.status} sin redirección.`);
    if (pathOf(t, posted.location) === LOGIN_PATH && !posted.location.searchParams.has("testsession")) {
        // El motivo queda en la sesión y se muestra al volver al formulario.
        const back = await req(LOGIN_PATH, posted.location.searchParams, { method: "GET" });
        const msg = loginErrorText(back.html);
        if (msg && /token|sesi[oó]n|session|expir|caduc/i.test(msg) && !/contrase|password|usuario|username/i.test(msg)) {
            fail("UNEXPECTED_RESPONSE", `El Campus rechazó el formulario de login sin evaluar la contraseña («${msg}»). No cuenta como intento fallido; se puede volver a intentar más tarde.`);
        }
        fail("AUTH_REJECTED", `El Campus rechazó el usuario o la contraseña guardados${msg ? ` («${msg}»)` : ""}. El login automático se desactiva para no sumar intentos fallidos (bloqueo de cuenta).`);
    }
    let next: URL | null = posted.location;
    let mfa: LoginResult["mfa"] = "no_pedido";

    // 3) Seguir sólo el propio flujo: testsession, la página del MFA y el destino final (sin pedirlo).
    for (let hop = 0; hop < 4 && next; hop++) {
        const p = pathOf(t, next);
        if (p === LOGIN_PATH && next.searchParams.has("testsession")) {
            next = (await req(LOGIN_PATH, next.searchParams, { method: "GET" })).location;
            continue;
        }
        if (p === MFA_PATH) {
            next = await mfaStep(t, req, next, input.askCode);
            mfa = "codigo";
            continue;
        }
        const blocked = blockingPage(p);
        if (blocked) fail("AUTH_REQUIRED", `El login automático se detuvo: ${blocked}. Entrá una vez desde el navegador.`);
        break; // destino normal (p. ej. /my/): la sesión ya está creada; no se pide la página.
    }
    if (mfa === "no_pedido" && hadTrust) mfa = "dispositivo_de_confianza";

    // 4) Identidad: la sesión nueva tiene que ser de la misma cuenta que el token del perfil.
    await op.verifyIdentity(expected, expected);
    const jar = op.cookies();
    const keep = jar.filter((c) => TRUST_COOKIE.test(c.name) || /^MOODLEID\d*_/.test(c.name));
    const trust = jar.find((c) => TRUST_COOKIE.test(c.name));
    return {
        snapshot: t.snapshotOf(op, now()),
        remembered: keep,
        mfa,
        trust_expires_at: trust?.expires ? new Date(trust.expires * 1000).toISOString() : null,
    };
}

/** Factor «código por correo»: un solo intento, con «confiar en este dispositivo». Devuelve la siguiente redirección. */
async function mfaStep(t: WebTransport, req: LoginRequest, at: URL, askCode: MfaCodePrompt | undefined): Promise<URL | null> {
    // Al armar esta página, el Campus manda el correo con el código (si no hay uno vigente).
    const page = await req(MFA_PATH, at.searchParams, { method: "GET" });
    if (page.location) return page.location; // ya resuelto (p. ej. dispositivo de confianza)
    // La página puede traer más de un formulario hacia auth.php (p. ej. cancelar/cerrar sesión): vale el del código.
    const forms = parseForms(page.html, (tag) => /tool\/mfa\/auth\.php/i.test(tag) || !/\baction\s*=/i.test(tag));
    const form = forms.find((f) => f.names.has("verificationcode"));
    if (!form || (form.fields.has("factor") && form.fields.get("factor") !== "email")) {
        fail("AUTH_REQUIRED", `El Campus pidió un segundo factor que el login automático no reconoce (${formShape(forms)}).`);
    }
    if (!askCode) {
        fail("AUTH_REQUIRED", "El Campus pidió el código de verificación (te mandó un correo: no uses su enlace «no fui yo») y no hay forma de pedírtelo acá. Renová la confianza del dispositivo con: auth web autologin enable.", MFA_CODE_REQUIRED);
    }
    const code = ((await askCode()) ?? "").trim();
    if (!code) fail("AUTH_REQUIRED", "No se ingresó el código de verificación: el login automático quedó sin completar.");
    if (!/^\d{6}$/.test(code)) fail("AUTH_REJECTED", "El código de verificación son 6 dígitos; no se envió nada.");
    const fields = new URLSearchParams([...form.fields]);
    fields.set("verificationcode", code);
    if (form.names.has("factor_token_trust")) fields.set("factor_token_trust", "1");
    const posted = await req(MFA_PATH, null, { method: "POST", body: fields.toString(), contentType: "application/x-www-form-urlencoded" });
    if (!posted.location) fail("AUTH_REJECTED", "El Campus no aceptó el código de verificación (incorrecto o vencido). No se reintenta: pedí uno nuevo con auth web autologin enable.");
    if (pathOf(t, posted.location) === MFA_PATH) fail("AUTH_REQUIRED", "Después del código, el Campus pidió otro factor más: el login automático no lo resuelve.");
    return posted.location;
}
