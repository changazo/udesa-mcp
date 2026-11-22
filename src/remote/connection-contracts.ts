import { CampusError } from "../errors.js";
import { parseStoredLogin, parseTrust, type StoredLogin } from "../web/autologin.js";
import { TRUST_COOKIE } from "../web/login.js";
import { decodeSnapshot, type WebCookie, type WebSessionSnapshot } from "../web/session.js";

/**
 * Contratos de la conexión web remota (ADR-141): motivos cerrados, proyección pública de recuperación,
 * estados de la renovación, informe de diagnóstico y sobre de configuración de recuperación
 * (CAMPUS_WEB_BOOTSTRAP). Todo lo que sale al cliente MCP o al panel se arma desde estos valores, nunca
 * desde mensajes libres de errores, HTML de Moodle o datos cifrados.
 */

/** Motivos públicos (catálogo cerrado). */
export const CONNECTION_REASONS = [
    "trust_missing",
    "trust_expired",
    "trust_expiring",
    "session_expired",
    "renewal_in_progress",
    "credentials_rejected",
    "otp_rejected",
    "attempt_uncertain",
    "rate_limited",
    "kv_unavailable",
    "api_token_invalid",
    "identity_mismatch",
    "config_incomplete",
    "config_conflict",
    "stale_instance",
    "activation_pending",
    "manual_disable",
] as const;
export type ConnectionReason = (typeof CONNECTION_REASONS)[number];

export type RecoveryKind = "renew_web_trust" | "activate_recovery" | "cli_recovery" | "wait" | "review_attempt";

/** Qué hace un humano ante cada motivo: el panel (navegador) o la CLI de recuperación (PC). */
const RECOVERY: Record<ConnectionReason, RecoveryKind> = {
    trust_missing: "renew_web_trust",
    trust_expired: "renew_web_trust",
    trust_expiring: "renew_web_trust",
    session_expired: "renew_web_trust",
    renewal_in_progress: "wait",
    credentials_rejected: "cli_recovery",
    otp_rejected: "renew_web_trust",
    attempt_uncertain: "review_attempt",
    rate_limited: "wait",
    kv_unavailable: "wait",
    api_token_invalid: "cli_recovery",
    identity_mismatch: "cli_recovery",
    config_incomplete: "cli_recovery",
    config_conflict: "cli_recovery",
    stale_instance: "wait",
    activation_pending: "activate_recovery",
    manual_disable: "cli_recovery",
};

export interface RecoveryAction {
    kind: RecoveryKind;
    label: string;
    url: string | null;
    requires_human: true;
}

const LABEL: Record<RecoveryKind, string> = {
    renew_web_trust: "Renovar conexión con el Campus",
    activate_recovery: "Activar y verificar recuperación",
    cli_recovery: "Recuperación desde la PC (campus remote autologin renew)",
    wait: "Esperar y volver a consultar el estado",
    review_attempt: "Revisar el intento en el panel de conexión",
};

/** Acción pública de recuperación. La URL sale de la configuración validada (PUBLIC_BASE_URL); sin secretos. */
export function recoveryAction(reason: ConnectionReason, panelUrl: string | null): RecoveryAction {
    const kind = RECOVERY[reason];
    return { kind, label: LABEL[kind], url: panelUrl, requires_human: true };
}

/** `details` cerrados de un AUTH_REQUIRED de la sesión web, para el cliente MCP. */
export function webRecoveryDetails(reason: ConnectionReason, panelUrl: string | null): Record<string, unknown> {
    const a = recoveryAction(reason, panelUrl);
    return { component: "web_session", reason, recovery: { kind: a.kind, url: a.url, requires_human: true } };
}

const HUMAN: Record<ConnectionReason, string> = {
    trust_missing: "La conexión web necesita renovar la confianza del dispositivo.",
    trust_expired: "La confianza del dispositivo remoto venció: la conexión web necesita renovarse.",
    trust_expiring: "La confianza del dispositivo remoto vence pronto: conviene renovarla.",
    session_expired: "La sesión web del Campus venció y no se pudo renovar sola.",
    renewal_in_progress: "Hay una renovación de la conexión en curso.",
    credentials_rejected: "El Campus rechazó la contraseña guardada en el servidor: hay que corregirla desde la PC.",
    otp_rejected: "El Campus no aceptó el último código de verificación.",
    attempt_uncertain: "Un intento de inicio de sesión quedó sin resultado confirmado.",
    rate_limited: "Se alcanzó el límite de intentos de inicio de sesión: hay que esperar.",
    kv_unavailable: "El almacén compartido de la conexión no responde.",
    api_token_invalid: "El token de la API de Moodle del servidor no es válido.",
    identity_mismatch: "La conexión autentica a otra cuenta de Moodle.",
    config_incomplete: "La configuración del login automático remoto está incompleta.",
    config_conflict: "La configuración del servidor no coincide con la conexión guardada.",
    stale_instance: "Esta instancia del servidor tiene una configuración anterior a la vigente.",
    activation_pending: "Hay una configuración de recuperación publicada que falta activar y verificar.",
    manual_disable: "El login web automático está desactivado por el dueño.",
};

export function reasonMessage(reason: ConnectionReason): string {
    return HUMAN[reason];
}

/** Error AUTH_REQUIRED de la sesión web con acción tipada (nunca con texto libre de otra capa). */
export function webAuthError(reason: ConnectionReason, panelUrl: string | null): CampusError {
    const a = recoveryAction(reason, panelUrl);
    const where = a.kind === "cli_recovery" ? "Hace falta la recuperación desde la PC: campus remote autologin renew --redeploy." : a.kind === "wait" ? "Esperá unos minutos y volvé a consultar campus_get_status." : `Abrí ${a.url ?? "el panel de conexión del servidor"} y seguí el paso que indica.`;
    return new CampusError("AUTH_REQUIRED", reasonMessage(reason), { humanAction: where, details: webRecoveryDetails(reason, panelUrl) });
}

// ---------- estados ----------

export type RenewalState = "idle" | "starting" | "awaiting_code" | "submitting" | "candidate_ready" | "committed" | "failed" | "uncertain" | "expired" | "cancelled" | "superseded";
export type CheckState = "ok" | "failed" | "unknown" | "not_checked" | "not_applicable";
export type TrustState = "valid" | "expiring" | "expired" | "missing" | "unknown";

export interface Check {
    state: CheckState;
    checked_at: string | null;
    reason: string | null;
}

export interface DiagnosticReport {
    diagnostic_id: string;
    renewal_id: string | null;
    config_epoch: number;
    auth_generation: number;
    session_revision: string | null;
    started_at: string;
    finished_at: string | null;
    result: "ready" | "partial" | "failed" | "pending";
    checks: {
        persistence: Check;
        api_token: Check;
        web_session: Check;
        identity: Check;
        device_trust: Check & { trust: TrustState; expires_at: string | null };
    };
    next_action: RecoveryKind | null;
}

/** Aviso de vencimiento: siete días (decisión de producto, ADR-141). */
export const TRUST_WARN_MS = 7 * 86_400_000;

export function trustState(expiresAt: string | null, now: Date): TrustState {
    if (!expiresAt) return "missing";
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms)) return "unknown";
    if (ms <= now.getTime()) return "expired";
    return ms - now.getTime() < TRUST_WARN_MS ? "expiring" : "valid";
}

// ---------- sobre de recuperación (CAMPUS_WEB_BOOTSTRAP) ----------

export type WebBootstrap =
    | { v: 2; activation_epoch: number; mode: "enabled"; login: StoredLogin; trust: WebCookie[]; session: WebSessionSnapshot }
    | { v: 2; activation_epoch: number; mode: "disabled" };

/**
 * Sobre único de recuperación que publica la CLI (ADR-141): todo o nada, para que una publicación a
 * medias de varias variables no arme una configuración híbrida. Inválido = error de configuración.
 */
export function parseBootstrap(raw: string, expectedUserId: number): WebBootstrap {
    let v: Record<string, unknown>;
    try {
        v = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new CampusError("CONFIG_INVALID", "CAMPUS_WEB_BOOTSTRAP no es JSON válido.");
    }
    if (!v || v.v !== 2 || typeof v.activation_epoch !== "number" || !Number.isSafeInteger(v.activation_epoch) || v.activation_epoch <= 0) {
        throw new CampusError("CONFIG_INVALID", "CAMPUS_WEB_BOOTSTRAP: versión o activation_epoch inválidos.");
    }
    if (v.mode === "disabled") return { v: 2, activation_epoch: v.activation_epoch, mode: "disabled" };
    if (v.mode !== "enabled") throw new CampusError("CONFIG_INVALID", "CAMPUS_WEB_BOOTSTRAP: mode debe ser enabled o disabled.");
    const login = parseStoredLogin(JSON.stringify(v.login ?? null));
    if (!login) throw new CampusError("CONFIG_INVALID", "CAMPUS_WEB_BOOTSTRAP: credenciales inválidas.");
    const trust = parseTrust(JSON.stringify(v.trust ?? null));
    const own = trust.find((c) => c.name === `MFA_TOKEN_${expectedUserId}`);
    if (!own || !own.expires || !trust.every((c) => !TRUST_COOKIE.test(c.name) || c.name === `MFA_TOKEN_${expectedUserId}`)) {
        throw new CampusError("CONFIG_INVALID", "CAMPUS_WEB_BOOTSTRAP: falta la confianza del usuario esperado, no tiene vencimiento o es de otra cuenta.");
    }
    let session: WebSessionSnapshot;
    try {
        if (typeof v.session !== "string") throw new Error("session");
        session = decodeSnapshot(v.session);
    } catch {
        throw new CampusError("CONFIG_INVALID", "CAMPUS_WEB_BOOTSTRAP: sesión inválida.");
    }
    if (session.user_id !== expectedUserId) throw new CampusError("CONFIG_INVALID", "CAMPUS_WEB_BOOTSTRAP: la sesión es de otra cuenta de Moodle.");
    return { v: 2, activation_epoch: v.activation_epoch, mode: "enabled", login, trust, session };
}
