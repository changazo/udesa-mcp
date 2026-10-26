/**
 * Configuración del modo remoto (Vercel). Todo sale de variables de entorno del proyecto; los
 * valores sensibles se cargan con `vercel env add --sensitive` y nunca se loguean.
 */
export interface RemoteConfig {
    /** Origen público estable, p. ej. https://<tu-proyecto>.vercel.app (sin barra final). */
    baseUrl: string;
    /** Clave HMAC para firmar clientes, códigos y tokens OAuth (≥ 32 bytes). */
    signingSecret: Uint8Array;
    github: { clientId: string; clientSecret: string; allowedUserId: string };
    /** Token Moodle del dueño, cargado desde su keyring con la CLI. */
    moodleToken: string;
    /** userid de Moodle esperado para ese token. */
    expectedMoodleUserId: number;
    /**
     * Escrituras remotas (W5, ADR-060): sólo con CAMPUS_WRITE_ENABLED=true y el KV de Upstash.
     * tokenVersion va en los tokens de escritura: cambiarla (y redesplegar) los revoca sin tocar la lectura.
     */
    write: { kvUrl: string; kvToken: string; tokenVersion: string; profileId: string } | null;
    /**
     * KV de Upstash para la sesión web compartida entre instancias (ADR-127), con o sin escrituras.
     * Sin KV, la sesión web es sólo el snapshot fijo de CAMPUS_WEB_SESSION.
     */
    kv: { url: string; token: string } | null;
    /**
     * Login web automático remoto (ADR-127): dos llaves, CAMPUS_WEB_AUTOLOGIN=true y la contraseña en
     * CAMPUS_WEB_LOGIN (sensible). Requiere el KV (estado, candado y sesión compartidos).
     */
    autologin: { login: string; trust: string | null } | null;
}

export type RemoteConfigResult = { ok: true; config: RemoteConfig } | { ok: false; missing: string[] };

export function readRemoteConfig(env: Record<string, string | undefined> = process.env): RemoteConfigResult {
    const v = (name: string) => env[name]?.trim() || undefined;
    const missing: string[] = [];
    const need = (name: string) => {
        const value = v(name);
        if (!value) missing.push(name);
        return value ?? "";
    };
    const baseRaw = need("PUBLIC_BASE_URL");
    const secret = need("OAUTH_SIGNING_SECRET");
    const ghId = need("GITHUB_CLIENT_ID");
    const ghSecret = need("GITHUB_CLIENT_SECRET");
    const ghUser = need("GITHUB_ALLOWED_USER_ID");
    const token = need("CAMPUS_MOODLE_TOKEN");
    const userId = need("CAMPUS_EXPECTED_USERID");

    let baseUrl = "";
    if (baseRaw) {
        try {
            const u = new URL(baseRaw);
            const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
            if ((u.protocol !== "https:" && !local) || u.search || u.hash || u.username || (u.pathname !== "/" && u.pathname !== "")) throw new Error();
            baseUrl = u.origin;
        } catch {
            missing.push("PUBLIC_BASE_URL (inválida: debe ser un origen https sin ruta)");
        }
    }
    const secretBytes = secret ? decodeSecret(secret) : null;
    if (secret && (!secretBytes || secretBytes.byteLength < 32)) missing.push("OAUTH_SIGNING_SECRET (≥ 32 bytes en base64url)");
    if (ghUser && !/^\d+$/.test(ghUser)) missing.push("GITHUB_ALLOWED_USER_ID (debe ser el ID numérico)");
    if (userId && !/^\d+$/.test(userId)) missing.push("CAMPUS_EXPECTED_USERID (numérico)");
    if (token && !/^[A-Za-z0-9]{16,128}$/.test(token)) missing.push("CAMPUS_MOODLE_TOKEN (formato inválido)");
    const kv = v("KV_REST_API_URL") && v("KV_REST_API_TOKEN") ? { url: v("KV_REST_API_URL")!, token: v("KV_REST_API_TOKEN")! } : null;
    const autologin = v("CAMPUS_WEB_AUTOLOGIN") === "true" && v("CAMPUS_WEB_LOGIN") && kv ? { login: v("CAMPUS_WEB_LOGIN")!, trust: v("CAMPUS_WEB_TRUST") ?? null } : null;
    if (missing.length) return { ok: false, missing };
    return {
        ok: true,
        config: {
            baseUrl,
            signingSecret: secretBytes!,
            github: { clientId: ghId, clientSecret: ghSecret, allowedUserId: ghUser },
            moodleToken: token,
            expectedMoodleUserId: Number(userId),
            write:
                v("CAMPUS_WRITE_ENABLED") === "true" && v("KV_REST_API_URL") && v("KV_REST_API_TOKEN")
                    ? { kvUrl: v("KV_REST_API_URL")!, kvToken: v("KV_REST_API_TOKEN")!, tokenVersion: v("CAMPUS_WRITE_TOKEN_VERSION") ?? "1", profileId: v("CAMPUS_WRITE_PROFILE") ?? "udesa-docente-escritura" }
                    : null,
            kv,
            autologin,
        },
    };
}

function decodeSecret(s: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
    return new Uint8Array(Buffer.from(s, "base64url"));
}
