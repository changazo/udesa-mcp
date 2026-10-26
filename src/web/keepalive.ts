import { CampusError, toPublicError } from "../errors.js";
import type { MetadataStore } from "../session/metadata.js";
import { revisionOf } from "./session.js";
import type { WebTransport } from "./transport.js";

/**
 * Medición y mantenimiento de la sesión web (sólo local, por CLI).
 *
 * Moodle cierra una sesión cuando pasan `sessiontimeout` segundos sin peticiones; cada petición
 * autenticada renueva ese plazo (core\session\manager, como mucho una vez cada 20 s). Por eso:
 * - la verificación de identidad (GET /user/preferences.php, sin eventos) ya mantiene viva la sesión;
 * - inmediatamente después, `core_session_time_remaining` (sólo lectura) devuelve cuánto queda, que
 *   en ese momento equivale al límite de inactividad configurado en el Campus.
 * Local y remoto comparten la sesión del lado del Campus: mantenerla viva acá también la mantiene
 * para el snapshot publicado en Vercel, salvo que la cookie haya rotado desde la publicación.
 */

export interface WebSessionCheck {
    user_id: number;
    checked_at: string;
    /** Límite de inactividad medido (segundos). null si el Campus no lo informó. */
    inactivity_limit_seconds: number | null;
    /** Momento en que vencería si nadie la usa desde ahora. */
    expires_if_idle_at: string | null;
    /** Revisión del snapshot después de la operación (cambia si la cookie rotó). */
    revision: string;
    rotated: boolean;
    warnings: string[];
}

export async function checkWebSession(web: WebTransport, now: () => Date = () => new Date()): Promise<WebSessionCheck> {
    const op = await web.open();
    const warnings: string[] = [];
    let limit: number | null = null;
    try {
        const r = await op.ajax<{ userid?: unknown; timeremaining?: unknown }>("core_session_time_remaining", {});
        const remaining = Number(r?.timeremaining);
        if (Number(r?.userid) !== op.userId) {
            throw new CampusError("UNEXPECTED_RESPONSE", "El Campus informó el tiempo restante de otra sesión.");
        }
        if (!Number.isFinite(remaining)) throw new CampusError("UNEXPECTED_RESPONSE", "Tiempo restante de la sesión no interpretable.");
        if (remaining <= 0) throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció.", { humanAction: web.renewHint });
        limit = Math.round(remaining);
    } catch (e) {
        // La sesión ya quedó verificada y renovada por la página de identidad. Sólo se pierde la medición.
        if (e instanceof CampusError && (e.code === "AUTH_REQUIRED" || e.code === "IDENTITY_MISMATCH")) throw e;
        warnings.push(`No se pudo medir el tiempo restante (${toPublicError(e).code}); la sesión sí se verificó y renovó.`);
    }
    await web.afterOperation(op);
    const at = now();
    return {
        user_id: op.userId!,
        checked_at: at.toISOString(),
        inactivity_limit_seconds: limit,
        expires_if_idle_at: limit === null ? null : new Date(at.getTime() + limit * 1000).toISOString(),
        revision: revisionOf(op.cookies()),
        rotated: op.rotated,
        warnings,
    };
}

// ---------- Estado local no secreto ----------

const STATE_FILE = "web-session-state.json";

export interface WebSessionLocalState {
    /** Revisión publicada en Vercel con `remote push-web-session` (no secreta: hash corto). */
    published_revision?: string;
    published_at?: string;
    last_check?: {
        at: string;
        ok: boolean;
        code?: string;
        inactivity_limit_seconds?: number | null;
        expires_if_idle_at?: string | null;
        revision?: string;
        /** Qué falló, si no fue la sesión web: el token móvil que da la identidad esperada. */
        component?: "mobile_token";
        source: "status" | "keepalive" | "push";
    };
}

export function readWebState(store: MetadataStore): WebSessionLocalState {
    const raw = store.readJson(STATE_FILE);
    return raw && typeof raw === "object" ? (raw as WebSessionLocalState) : {};
}

export function recordCheck(store: MetadataStore, source: "status" | "keepalive" | "push", result: WebSessionCheck | { error: unknown; at: Date }) {
    const state = readWebState(store);
    if ("error" in result) {
        const pe = toPublicError(result.error);
        state.last_check = { at: result.at.toISOString(), ok: false, code: pe.code, ...(pe.details?.component === "mobile_token" ? { component: "mobile_token" as const } : {}), source };
    } else {
        state.last_check = {
            at: result.checked_at,
            ok: true,
            inactivity_limit_seconds: result.inactivity_limit_seconds,
            expires_if_idle_at: result.expires_if_idle_at,
            revision: result.revision,
            source,
        };
    }
    store.writeJson(STATE_FILE, state);
}

export function recordPublished(store: MetadataStore, revision: string, at: Date) {
    const state = readWebState(store);
    state.published_revision = revision;
    state.published_at = at.toISOString();
    store.writeJson(STATE_FILE, state);
}

/** ¿El remoto tiene la misma cookie que la copia local? null si nunca se publicó desde esta PC. */
export function remoteInSync(state: WebSessionLocalState, localRevision: string | null): boolean | null {
    if (!state.published_revision || !localRevision) return null;
    return state.published_revision === localRevision;
}

/** «1 h 30 min», «45 min». */
export function humanDuration(seconds: number): string {
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
}
