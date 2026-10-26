import { CampusError } from "../errors.js";
import type { Profile } from "../config/profile.js";
import { readWithLimit, type FetchLike } from "../moodle/transport.js";

export interface NativeCredentials {
    username: string;
    password: string;
}

/**
 * Estrategia `native`: POST a login/token.php con usuario y contraseña ingresados por el humano.
 * Un único intento, sin reintentos ni redirecciones (AUTH-03). Devuelve un token CANDIDATO: la
 * sesión lo valida con get_site_info antes de guardarlo. `privatetoken` se ignora y no sale de acá.
 */
export async function requestNativeToken(profile: Profile, creds: NativeCredentials, fetchImpl: FetchLike = fetch): Promise<string> {
    if (!creds.username || !creds.password) throw new CampusError("AUTH_REJECTED", "Usuario y contraseña son obligatorios.");
    let res: Response;
    try {
        res = await fetchImpl(`${profile.site_url}/login/token.php`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ username: creds.username, password: creds.password, service: profile.service }),
            redirect: "manual",
            signal: AbortSignal.timeout(profile.limits.http_timeout_seconds * 1000),
        });
    } catch (e) {
        const reason = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "tiempo de espera agotado" : "falla de red, DNS o TLS";
        throw new CampusError("NETWORK_ERROR", `No se pudo contactar ${new URL(profile.site_url).host} (${reason}). Esto no indica nada sobre las credenciales ni sobre la API.`);
    }
    if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new CampusError("SERVICE_UNAVAILABLE", `login/token.php respondió con una redirección (HTTP ${res.status}). No se siguió ni se reenviaron credenciales.`);
    }
    const bytes = await readWithLimit(res, 64 * 1024).catch(() => {
        throw new CampusError("UNEXPECTED_RESPONSE", "Respuesta de login/token.php demasiado grande.");
    });
    let data: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("no-object");
        data = parsed as Record<string, unknown>;
    } catch {
        // No se guarda ni se muestra el cuerpo: podría reflejar datos del formulario.
        throw new CampusError("UNEXPECTED_RESPONSE", `login/token.php no devolvió JSON (HTTP ${res.status}). Puede ser una página HTML, un proxy o mantenimiento; no se concluye que la contraseña sea incorrecta.`);
    }
    const token = data.token;
    if (typeof token === "string") {
        if (!/^[A-Za-z0-9]{16,128}$/.test(token)) throw new CampusError("UNEXPECTED_RESPONSE", "login/token.php devolvió un token con formato inesperado.");
        return token;
    }
    throw mapTokenError(typeof data.errorcode === "string" ? data.errorcode : undefined, typeof data.error === "string" ? data.error : undefined, res.status);
}

function mapTokenError(errorcode: string | undefined, error: string | undefined, status: number): CampusError {
    const detail = (error ?? "sin mensaje").slice(0, 200);
    switch (errorcode) {
        case "invalidlogin":
            return new CampusError("AUTH_REJECTED", `login/token.php rechazó el usuario o la contraseña (${detail}).`, {
                moodleErrorcode: errorcode,
                humanAction:
                    "Verificá usuario y contraseña. Si tu cuenta sólo entra con Google, el login nativo no aplica: usá el método browser cuando esté disponible. No se reintenta automáticamente.",
            });
        case "enablewsdescription":
        case "servicenotavailable":
        case "sitemaintenance":
            return new CampusError("SERVICE_UNAVAILABLE", `El Campus no emite tokens para el servicio pedido (${errorcode}: ${detail}).`, {
                moodleErrorcode: errorcode,
                humanAction: "No hay bypass: registrá el código y, si corresponde, consultá a IT con este errorcode.",
            });
        case "usernotfullysetup":
        case "forcepasswordchangenotice":
        case "policynotagreed":
        case "sitepolicynotagreed":
            return new CampusError("AUTH_REJECTED", `La cuenta tiene un paso pendiente en la web (${errorcode}).`, {
                moodleErrorcode: errorcode,
                humanAction: "Ingresá al Campus en el navegador, completá el paso pendiente y repetí el login.",
            });
        default:
            return new CampusError("MOODLE_ERROR", `login/token.php no emitió token (HTTP ${status}, ${errorcode ?? "sin errorcode"}: ${detail}).`, {
                moodleErrorcode: errorcode,
            });
    }
}

/**
 * Pista NO autenticada: login/token.php?appsitecheck=1. Sólo sugiere si los Web Services están
 * habilitados; no prueba el servicio móvil, la cuenta ni permisos.
 */
export async function appSiteCheck(profile: Profile, fetchImpl: FetchLike = fetch): Promise<{ result: "ok" | "error" | "unexpected"; errorcode: string | null }> {
    let res: Response;
    try {
        res = await fetchImpl(`${profile.site_url}/login/token.php?appsitecheck=1`, {
            redirect: "manual",
            signal: AbortSignal.timeout(profile.limits.http_timeout_seconds * 1000),
        });
    } catch {
        throw new CampusError("NETWORK_ERROR", "No se pudo contactar el Campus para appsitecheck (red, DNS o TLS).");
    }
    try {
        const data = JSON.parse(new TextDecoder().decode(await readWithLimit(res, 16 * 1024))) as Record<string, unknown>;
        if (data.appsitecheck === "ok") return { result: "ok", errorcode: null };
        if (typeof data.errorcode === "string") return { result: "error", errorcode: data.errorcode };
    } catch {
        /* cae a unexpected */
    }
    return { result: "unexpected", errorcode: null };
}
