import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CampusError } from "../errors.js";
import type { Profile } from "../config/profile.js";

/**
 * Núcleo del protocolo de la estrategia `browser` (P4). Implementa lo verificable offline:
 * construcción del lanzamiento móvil, transacción de un solo uso con expiración y validación del
 * retorno `<esquema>://token=<base64(hash:::token[:::privatetoken])>`.
 *
 * NO implementa todavía cómo llega el retorno al proceso (handler de esquema/IPC). Ver
 * docs/AUTH_BROWSER.md: hasta resolver eso, `campus auth login --method browser` no está disponible.
 * El formato corresponde a admin/tool/mobile/launch.php de Moodle 4.5 [S06]; se contrasta con la
 * versión real antes de declarar compatibilidad.
 */

export interface BrowserTransaction {
    id: string;
    profile_id: string;
    /** wwwroot exacto esperado; entra en el hash de correlación. */
    site_url: string;
    service: string;
    passport: string;
    urlscheme: string;
    created_at: number;
    expires_at: number;
}

export interface LaunchRequest {
    transaction: BrowserTransaction;
    /** URL a abrir en el navegador normal del humano. No contiene secretos. */
    launch_url: string;
}

/** Esquema por defecto de la app oficial. Nunca lo registramos ni lo reclamamos (BR-05). */
export const OFFICIAL_APP_SCHEME = "moodlemobile";
const MAX_CALLBACK_CHARS = 4096;

export function createLaunch(
    profile: Profile,
    opts: { urlscheme: string; ttlMs?: number; now?: number; oauthssoId?: number; showLaunchPage?: boolean },
): LaunchRequest {
    const scheme = opts.urlscheme.toLowerCase();
    if (!/^[a-z][a-z0-9+.-]{2,40}$/.test(scheme)) throw new CampusError("CONFIG_INVALID", "Esquema de retorno inválido.");
    if (scheme === OFFICIAL_APP_SCHEME) {
        throw new CampusError("POLICY_DENIED", "No se usa el esquema de la app oficial de Moodle; elegí un esquema propio.");
    }
    const now = opts.now ?? Date.now();
    const transaction: BrowserTransaction = {
        id: randomUUID(),
        profile_id: profile.profile_id,
        site_url: profile.site_url,
        service: profile.service,
        passport: randomBytes(24).toString("hex"),
        urlscheme: scheme,
        created_at: now,
        expires_at: now + (opts.ttlMs ?? 5 * 60_000),
    };
    const url = new URL(`${profile.site_url}/admin/tool/mobile/launch.php`);
    url.searchParams.set("service", profile.service);
    url.searchParams.set("passport", transaction.passport);
    url.searchParams.set("urlscheme", scheme);
    // Con un proveedor OAuth2 (p. ej. Google institucional), launch.php inicia ese login desde la
    // sesión del navegador y, recién logueado, emite el token (como hace la app oficial).
    if (opts.oauthssoId !== undefined) url.searchParams.set("oauthsso", String(opts.oauthssoId));
    // confirmed=1: al final, launch.php muestra una página del Campus («Confirmado») con el enlace de
    // retorno visible, en vez de redirigir en silencio. Sin efectos: sólo cambia la presentación
    // (Moodle 5.1, admin/tool/mobile/launch.php). Permite copiar el retorno con clic derecho.
    if (opts.showLaunchPage) url.searchParams.set("confirmed", "1");
    return { transaction, launch_url: url.toString() };
}

export interface ParsedCallback {
    scheme: string;
    site_hash: string;
    token: string;
    had_private_token: boolean;
}

/** Parsea el retorno sin incluirlo jamás en mensajes de error (BR-04). */
export function parseCallback(raw: string): ParsedCallback {
    const reject = (why: string) => new CampusError("BROWSER_CALLBACK_REJECTED", `Retorno del navegador inválido: ${why}.`);
    if (typeof raw !== "string" || raw.length === 0) throw reject("vacío");
    if (raw.length > MAX_CALLBACK_CHARS) throw reject("demasiado largo");
    const m = /^([a-z][a-z0-9+.-]*):\/\/token=([A-Za-z0-9+/=%_-]+)$/i.exec(raw.trim());
    if (!m) throw reject("formato distinto de <esquema>://token=<payload>");
    const scheme = m[1]!.toLowerCase();
    let b64 = m[2]!;
    try {
        b64 = decodeURIComponent(b64);
    } catch {
        throw reject("codificación inválida");
    }
    // Windows, al pasar el enlace a un manejador de esquema, le agrega una barra final («…==/»).
    // Se prueba primero tal cual y, si no decodifica, sin UNA barra final. El resultado igual tiene
    // que pasar el formato, el hash del passport y la validación en Moodle.
    const candidates = b64.endsWith("/") ? [b64, b64.slice(0, -1)] : [b64];
    let lastError: CampusError = reject("payload no es base64");
    for (const c of candidates) {
        try {
            return decodePayload(scheme, c, reject);
        } catch (e) {
            if (e instanceof CampusError) lastError = e;
            else throw e;
        }
    }
    throw lastError;
}

function decodePayload(scheme: string, b64: string, reject: (why: string) => CampusError): ParsedCallback {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw reject("payload no es base64");
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const parts = decoded.split(":::");
    if (parts.length < 2 || parts.length > 3) throw reject("payload con cantidad de campos inesperada");
    const [siteHash, token, privateToken] = parts as [string, string, string | undefined];
    if (!/^[a-f0-9]{32}$/i.test(siteHash)) throw reject("campo de correlación con formato inesperado");
    if (!/^[A-Za-z0-9]{16,128}$/.test(token)) throw reject("token con formato inesperado");
    return { scheme, site_hash: siteHash.toLowerCase(), token, had_private_token: !!privateToken };
}

/** md5(wwwroot + passport): correlación del protocolo, NO una firma de confianza. */
export function expectedSiteHash(siteUrl: string, passport: string): string {
    return createHash("md5").update(siteUrl + passport).digest("hex");
}

/**
 * Transacciones en memoria del proceso de autenticación: una por intento, un solo uso,
 * expiración breve. `consume` es atómico dentro del proceso (BR-01/BR-03).
 */
export class TransactionStore {
    private readonly active = new Map<string, BrowserTransaction>();
    private readonly consumed = new Set<string>();

    add(tx: BrowserTransaction) {
        this.active.set(tx.id, tx);
    }

    /**
     * Busca la transacción cuyo hash coincide con el retorno, la consume y devuelve el token
     * candidato. Cualquier rechazo deja el resto de las transacciones intactas.
     */
    /**
     * `acceptForcedScheme`: el sitio puede forzar el esquema de la app oficial (moodlemobile). En el
     * importador manual se acepta el retorno con ese esquema (no se registra ni se intercepta nada:
     * el humano lo pega) y se informa `forced_scheme`.
     */
    consume(
        raw: string,
        expected: { profile_id: string; site_url: string },
        now = Date.now(),
        opts: { acceptForcedScheme?: boolean } = {},
    ): { token: string; transaction: BrowserTransaction; forced_scheme: boolean } {
        const cb = parseCallback(raw);
        const reject = (why: string) => new CampusError("BROWSER_CALLBACK_REJECTED", `Retorno rechazado: ${why}.`);
        for (const tx of this.active.values()) {
            const hash = expectedSiteHash(tx.site_url, tx.passport);
            if (!safeEqualHex(hash, cb.site_hash)) continue;
            // Coincidió el hash: a partir de acá la transacción se quema aunque falle otra regla.
            this.active.delete(tx.id);
            this.consumed.add(tx.id);
            if (tx.profile_id !== expected.profile_id || tx.site_url !== expected.site_url) throw reject("pertenece a otro perfil o sitio");
            const forced = cb.scheme !== tx.urlscheme && cb.scheme === OFFICIAL_APP_SCHEME && opts.acceptForcedScheme === true;
            if (cb.scheme !== tx.urlscheme && !forced) throw reject("esquema distinto del solicitado");
            if (now > tx.expires_at) throw reject("transacción expirada");
            return { token: cb.token, transaction: tx, forced_scheme: forced };
        }
        throw reject("no corresponde a ninguna transacción activa (desconocida, repetida o de otro sitio)");
    }

    purgeExpired(now = Date.now()) {
        for (const [id, tx] of this.active) if (now > tx.expires_at) this.active.delete(id);
    }

    get activeCount() {
        return this.active.size;
    }
}

function safeEqualHex(a: string, b: string): boolean {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface PublicLoginConfig {
    typeoflogin: number | null;
    launchurl: string | null;
    identity_providers: { id: number; name: string }[];
}

/**
 * Configuración pública de login móvil (la misma que consulta la app oficial antes de loguearse).
 * No usa token. Sólo se conservan el tipo de login, la URL de lanzamiento y los proveedores.
 */
export async function fetchPublicLoginConfig(profile: Profile, fetchImpl: typeof fetch = fetch): Promise<PublicLoginConfig> {
    let data: Record<string, unknown> | undefined;
    try {
        const r = await fetchImpl(`${profile.site_url}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify([{ index: 0, methodname: "tool_mobile_get_public_config", args: {} }]),
            redirect: "manual",
            signal: AbortSignal.timeout(profile.limits.http_timeout_seconds * 1000),
        });
        const j = (await r.json()) as { data?: Record<string, unknown>; error?: unknown }[];
        data = j[0]?.data;
    } catch {
        throw new CampusError("NETWORK_ERROR", "No se pudo leer la configuración pública de login del Campus.");
    }
    if (!data) throw new CampusError("SERVICE_UNAVAILABLE", "El Campus no devolvió su configuración pública de login.");
    const site = new URL(profile.site_url);
    const providers = Array.isArray(data.identityproviders) ? (data.identityproviders as { name?: string; url?: string }[]) : [];
    return {
        typeoflogin: typeof data.typeoflogin === "number" ? data.typeoflogin : null,
        launchurl: typeof data.launchurl === "string" ? data.launchurl : null,
        identity_providers: providers
            .map((x) => {
                try {
                    const u = new URL(String(x.url));
                    const id = Number(u.searchParams.get("id"));
                    // Sólo proveedores del propio Campus (auth/oauth2/login.php).
                    if (u.origin !== site.origin || !u.pathname.endsWith("/auth/oauth2/login.php") || !Number.isInteger(id) || id <= 0) return null;
                    return { id, name: (x.name ?? "").trim() };
                } catch {
                    return null;
                }
            })
            .filter((x): x is { id: number; name: string } => x !== null),
    };
}
