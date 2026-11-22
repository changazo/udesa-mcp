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

export type RecoveryKind =
    | "renew_web_trust"
    | "activate_recovery"
    | "cli_recovery"
    | "wait"
    | "review_attempt"
    // MCP local (ADR-142): la conexión vive en esta PC; las acciones son comandos de la CLI.
    | "renew_local_trust"
    | "enable_local_autologin"
    | "import_web_cookie"
    | "renew_api_token";

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
    /** Local (ADR-142): comando exacto para la terminal del humano, con el perfil de esa entrada. */
    command?: string | null;
    /** Local: otro camino válido (p. ej. importar la cookie en lugar del login automático). */
    alternatives?: { kind: RecoveryKind; label: string; command: string }[];
}

const LABEL: Record<RecoveryKind, string> = {
    renew_web_trust: "Renovar conexión con el Campus",
    activate_recovery: "Activar y verificar recuperación",
    cli_recovery: "Recuperación desde la PC (campus remote autologin renew)",
    wait: "Esperar y volver a consultar el estado",
    review_attempt: "Revisar el intento en el panel de conexión",
    renew_local_trust: "Renovar la confianza del dispositivo de esta PC (pide el código del correo)",
    enable_local_autologin: "Activar el login web automático en esta PC (método recomendado)",
    import_web_cookie: "Importar la cookie MoodleSession del navegador (respaldo)",
    renew_api_token: "Renovar el token de la API de Moodle (campus auth login)",
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

// ---------- MCP local (ADR-142) ----------

/** Cómo está conectada esta PC a la web del Campus: define la acción de cada motivo. */
export type LocalWebMethod = "autologin" | "cookie" | "none";

export interface LocalRecoveryContext {
    /** Prefijo de la CLI (p. ej. `node build/cli.js` o `campus`). */
    cli: string;
    profileId: string;
    method: LocalWebMethod;
}

/**
 * Acción local para un motivo. Con login automático, la confianza se renueva con el panel local (o la
 * terminal); sin él, el camino recomendado es activarlo (decisión del dueño, ADR-142) y la cookie queda
 * como alternativa. Nunca un texto libre de otra capa.
 */
export function localRecoveryAction(reason: ConnectionReason | "session_missing", ctx: LocalRecoveryContext): RecoveryAction {
    const p = `--profile ${ctx.profileId}`;
    const cmd = {
        panel: `${ctx.cli} auth web panel ${p}`,
        enable: `${ctx.cli} auth web autologin enable ${p}`,
        import: `${ctx.cli} auth web import ${p} --clipboard`,
        login: `${ctx.cli} auth login ${p}`,
        status: `${ctx.cli} auth web autologin status ${p}`,
    };
    const cookieAlt = { kind: "import_web_cookie" as const, label: LABEL.import_web_cookie, command: cmd.import };
    const mk = (kind: RecoveryKind, command: string | null, alternatives: RecoveryAction["alternatives"] = []): RecoveryAction => ({ kind, label: LABEL[kind], url: null, requires_human: true, command, ...(alternatives.length ? { alternatives } : {}) });
    if (reason === "api_token_invalid" || reason === "identity_mismatch") return mk("renew_api_token", cmd.login);
    if (reason === "renewal_in_progress" || reason === "rate_limited" || reason === "kv_unavailable" || reason === "stale_instance") return mk("wait", cmd.status);
    if (reason === "attempt_uncertain") return mk("review_attempt", cmd.panel, [cookieAlt]);
    // Sin login automático configurado (o desactivado por un rechazo): activarlo es el camino recomendado.
    if (ctx.method !== "autologin" || reason === "credentials_rejected" || reason === "config_incomplete" || reason === "config_conflict" || reason === "manual_disable") return mk("enable_local_autologin", cmd.enable, [cookieAlt]);
    return mk("renew_local_trust", cmd.panel, [{ kind: "renew_local_trust", label: "Lo mismo desde la terminal", command: cmd.enable }, cookieAlt]);
}

const LOCAL_HUMAN: Partial<Record<ConnectionReason | "session_missing", string>> = {
    trust_expired: "La confianza del dispositivo de esta PC venció: el login web automático necesita un código nuevo.",
    trust_expiring: "La confianza del dispositivo de esta PC vence pronto: conviene renovarla.",
    session_expired: "La sesión web del Campus de esta PC venció y no se pudo renovar sola.",
    session_missing: "Esta PC no tiene sesión web del Campus.",
    credentials_rejected: "El Campus rechazó la contraseña guardada en esta PC: el login automático quedó desactivado.",
    config_incomplete: "Esta PC no tiene el login web automático configurado.",
    config_conflict: "La conexión web guardada en esta PC no se puede descifrar (¿se borró su clave del Administrador de credenciales?).",
    kv_unavailable: "El estado de la conexión web de esta PC no se pudo leer o está dañado.",
    api_token_invalid: "El token de la API de Moodle de esta PC no es válido.",
};

export function localReasonMessage(reason: ConnectionReason | "session_missing"): string {
    return LOCAL_HUMAN[reason] ?? (reason === "session_missing" ? LOCAL_HUMAN.session_missing! : HUMAN[reason]);
}

/** AUTH_REQUIRED local de la sesión web: acción tipada con el comando exacto (ADR-142). */
export function localWebAuthError(reason: ConnectionReason | "session_missing", ctx: LocalRecoveryContext): CampusError {
    const a = localRecoveryAction(reason, ctx);
    const alt = a.alternatives?.find((x) => x.kind === "import_web_cookie");
    const human = `${a.label}: ${a.command}${alt ? `. Alternativa: ${alt.command}` : ""}. Corrélo vos en tu terminal; nunca pegues contraseñas, códigos ni cookies en el chat.`;
    return new CampusError("AUTH_REQUIRED", localReasonMessage(reason), { humanAction: human, details: { component: "web_session", reason, recovery: { kind: a.kind, command: a.command ?? null, url: null, requires_human: true, ...(a.alternatives ? { alternatives: a.alternatives } : {}) } } });
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
