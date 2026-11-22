import { randomBytes } from "node:crypto";
import { CampusError, toPublicError } from "../errors.js";
import type { WebCookie, WebSessionSnapshot } from "../web/session.js";
import type { WebTransport } from "../web/transport.js";
import { recoveryAction, trustState, type Check, type ConnectionReason, type DiagnosticReport, type RecoveryKind } from "./connection-contracts.js";
import type { ConnectionRecord, ConnectionStore } from "./connection-store.js";

/**
 * Autodiagnóstico de la conexión remota (ADR-141), el mismo para el panel y para el MCP:
 * 1. persistencia: lectura NUEVA del registro (no el objeto que devolvió el CAS) y descifrado;
 * 2. API: verificación REST fresca (nunca `authenticated` ni una caché);
 * 3. sesión web: la publicada, en un transporte aislado y SIN login automático, contra la página de
 *    identidad (usuario esperado único y sesskey); no se consultan cursos ni datos de alumnos;
 * 4. confianza: cookie del usuario esperado con vencimiento futuro;
 * 5. una rotación de cookies durante el probe se guarda sólo sobre la revisión observada;
 * 6. el informe se guarda sólo si sigue siendo de la generación observada.
 */

export interface DiagnosticsContext {
    store: ConnectionStore;
    now: () => Date;
    expectedUserId: number;
    readActive: (rec: ConnectionRecord) => { snapshot: WebSessionSnapshot | null; trust: WebCookie[] };
    isolatedTransport: (seed: WebSessionSnapshot | null) => WebTransport;
    verifyApi: () => Promise<{ userid: number }>;
    saveRotation: (s: WebSessionSnapshot, baseRevision: string) => Promise<void>;
    nextAction: (rec: ConnectionRecord) => ConnectionReason | null;
    /** Local sin login automático (cookie): la confianza del dispositivo no aplica (ADR-142). */
    trustRequired?: boolean;
    /** Tipo de acción de cada motivo (local o remoto). */
    actionKind?: (reason: ConnectionReason) => RecoveryKind;
}

const check = (state: Check["state"], at: Date | null, reason: string | null = null): Check => ({ state, checked_at: at ? at.toISOString() : null, reason });

export async function runDiagnostics(c: DiagnosticsContext): Promise<DiagnosticReport> {
    const started = c.now();
    const id = `dg_${randomBytes(6).toString("base64url")}`;
    let rec: ConnectionRecord | null = null;
    let persistence: Check;
    let snapshot: WebSessionSnapshot | null = null;
    let trust: WebCookie[] = [];
    try {
        rec = await c.store.read();
        if (!rec) persistence = check("failed", c.now(), "sin_registro");
        else {
            const a = c.readActive(rec);
            snapshot = a.snapshot;
            trust = a.trust;
            persistence = rec.active ? check("ok", c.now()) : check("failed", c.now(), "sin_conexion_adoptada");
        }
    } catch (e) {
        persistence = check(e instanceof CampusError && e.code === "SERVICE_UNAVAILABLE" ? "failed" : "unknown", c.now(), toPublicError(e).code);
    }

    // API REST: error de red = desconocido aunque haya token; rechazo = falla.
    let api: Check;
    let restUser: number | null = null;
    try {
        restUser = (await c.verifyApi()).userid;
        api = restUser === c.expectedUserId ? check("ok", c.now()) : check("failed", c.now(), "identity_mismatch");
    } catch (e) {
        const code = toPublicError(e).code;
        api = check(code === "NETWORK_ERROR" || code === "SERVICE_UNAVAILABLE" || code === "UNEXPECTED_RESPONSE" ? "unknown" : "failed", c.now(), code);
    }

    // Sesión web publicada, aislada y sin login automático: una sesión vencida no dispara otro login.
    let web: Check;
    let webUser: number | null = null;
    if (!snapshot) web = check(rec ? "failed" : "unknown", c.now(), "sin_sesion_publicada");
    else {
        try {
            const t = c.isolatedTransport(snapshot);
            const op = await t.open();
            webUser = op.userId;
            web = check("ok", c.now());
            if (op.rotated && op.userId !== null) await c.saveRotation(t.snapshotOf(op, c.now()), snapshot.revision).catch(() => undefined);
        } catch (e) {
            const code = toPublicError(e).code;
            web = check(code === "AUTH_REQUIRED" || code === "IDENTITY_MISMATCH" ? "failed" : "unknown", c.now(), code);
        }
    }

    const identity = webUser !== null || restUser !== null ? check((webUser === null || webUser === c.expectedUserId) && (restUser === null || restUser === c.expectedUserId) ? "ok" : "failed", c.now()) : check("unknown", c.now());

    const own = trust.find((x) => x.name === `MFA_TOKEN_${c.expectedUserId}`);
    const expiresAt = own?.expires ? new Date(own.expires * 1000).toISOString() : null;
    const ts = trust.length && !own ? "missing" : trustState(expiresAt, c.now());
    const trustRequired = c.trustRequired !== false;
    const deviceTrust = trustRequired
        ? { ...check(ts === "valid" || ts === "expiring" ? "ok" : ts === "unknown" ? "unknown" : "failed", c.now(), ts), trust: ts, expires_at: expiresAt }
        : { ...check("not_applicable", c.now(), "sin_login_automatico"), trust: ts, expires_at: expiresAt };

    const required = trustRequired ? [persistence, api, web, identity, deviceTrust] : [persistence, api, web, identity];
    const result: DiagnosticReport["result"] = required.every((x) => x.state === "ok") ? "ready" : required.some((x) => x.state === "failed") ? (persistence.state === "ok" ? "partial" : "failed") : "partial";
    const report: DiagnosticReport = {
        diagnostic_id: id,
        renewal_id: rec?.active?.renewal_id ?? null,
        config_epoch: rec?.config_epoch ?? 0,
        auth_generation: rec?.auth_generation ?? 0,
        session_revision: snapshot?.revision ?? null,
        started_at: started.toISOString(),
        finished_at: c.now().toISOString(),
        result,
        checks: { persistence, api_token: api, web_session: web, identity, device_trust: deviceTrust },
        next_action: rec ? (c.nextAction(rec) ? (c.actionKind ? c.actionKind(c.nextAction(rec)!) : recoveryAction(c.nextAction(rec)!, null).kind) : null) : null,
    };
    // Un informe tardío no reemplaza el de una generación más nueva.
    if (rec) await c.store.update((r) => (r && r.auth_generation === report.auth_generation && r.config_epoch === report.config_epoch ? { ...r, last_diagnostic: report } : null)).catch(() => undefined);
    return report;
}
