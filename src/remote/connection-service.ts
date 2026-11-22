import { randomBytes } from "node:crypto";
import { CampusError, toPublicError } from "../errors.js";
import { parseTrust, TRUST_MARGIN_MS, AUTOLOGIN_MAX_PER_DAY, AUTOLOGIN_MIN_INTERVAL_AFTER_OK_MS, AUTOLOGIN_MIN_INTERVAL_MS, type AutoLoginBackend, type AutoLoginState, type StoredLogin } from "../web/autologin.js";
import { beginPasswordLogin, completePasswordLogin, OTP_REJECTED, PASSWORD_REJECTED, TRUST_COOKIE, type LoginResult, type MfaContinuation } from "../web/login.js";
import { decodeSnapshot, encodeSnapshot, type WebCookie, type WebSessionSnapshot, type WebSessionSource } from "../web/session.js";
import type { WebOperation, WebTransport } from "../web/transport.js";
import type { KvClient } from "../write/store.js";
import { reasonMessage, recoveryAction, trustState, webAuthError, type ConnectionReason, type DiagnosticReport, type LocalWebMethod, type RecoveryAction, type RenewalState, type WebBootstrap } from "./connection-contracts.js";
import { connectionKey, ConnectionStore, emptyRecord, RECEIPT_WINDOW_MS, type ActiveConnection, type ConnectionRecord, type PendingTransition } from "./connection-store.js";
import type { KvSecretBox } from "./web-store.js";
import { runDiagnostics } from "./connection-diagnostics.js";

/**
 * Coordinador de la conexión web (ADR-141 en el remoto; ADR-142 en el MCP local, sobre un archivo con
 * candado). Lo comparten el panel de renovación, el login automático, la fuente de sesión de los
 * servidores MCP y el diagnóstico:
 * - renovación explícita en dos pasos (pedir código → confirmar código) sobre una sesión candidata aislada;
 * - cada transición que manda contraseña o código se reserva antes por CAS: repetir el pedido HTTP no
 *   repite el envío a Moodle; un corte después de enviar queda «incierto», nunca se reintenta solo;
 * - publicación atómica de sesión + confianza + recibo con generación nueva;
 * - cercos de configuración (epoch y huella) para instancias viejas y recuperaciones por CLI.
 */

export const CHALLENGE_TTL_S = 600;
const CLAIM_MS = 90_000;
const LEASE_S = 90;
const LEASE_WAIT_MS = 30_000;
const REJECTED_KEEP = 20;

export interface ConnectionConfig {
    epoch: number;
    fingerprint: string;
    /** enabled: hay credenciales y segunda llave; disabled: corte explícito; session_only: sólo sesión. */
    mode: "enabled" | "disabled" | "session_only";
    login: StoredLogin | null;
    bootstrap: WebBootstrap | null;
    /** Insumos legacy (epoch 0) para la migración inicial. */
    legacy: { loginRaw: string | null; trustRaw: string | null; sessionSeedRaw: string | null };
}

export interface ConnectionDeps {
    kv: KvClient;
    box: KvSecretBox;
    profileId: string;
    siteUrl: string;
    expectedUserId: number;
    config: ConnectionConfig;
    panelUrl: string | null;
    /** Transporte web aislado (fuente en memoria, sin login automático): candidatas y diagnóstico. */
    isolatedTransport: (seed: WebSessionSnapshot | null) => WebTransport;
    /** Verificación REST fresca (core_webservice_get_site_info). */
    verifyApi: () => Promise<{ userid: number }>;
    now?: () => Date;
    log?: (event: string, fields: Record<string, unknown>) => void;
    /** "local" (ADR-142): acciones con comandos de la CLI, migración desde el keyring y estado de la PC. */
    mode?: "remote" | "local";
    /** Acción de recuperación de cada motivo (por defecto, la del panel remoto). */
    recovery?: (reason: ConnectionReason | "session_missing") => RecoveryAction;
    /** AUTH_REQUIRED tipado de cada motivo (por defecto, el del panel remoto). */
    authError?: (reason: ConnectionReason | "session_missing") => CampusError;
    /** Local: estado anterior (keyring y web-autologin.json) que se adopta sin login ni MFA. */
    legacyLoader?: () => Promise<{ snapshot: WebSessionSnapshot | null; trust: WebCookie[]; state: AutoLoginState }>;
    /** Local: después de adoptar el estado anterior (p. ej. renombrar el archivo viejo). */
    onMigrated?: () => void;
    /** Duración del candado del login automático; con un diálogo para el código hace falta más (local). */
    leaseSeconds?: number;
    /** Hay un canal para el código (diálogo local): con la confianza vencida, el login se intenta igual. */
    interactiveCode?: boolean;
    /** Local: cómo se conecta esta PC (para la acción y el estado). */
    localMethod?: () => LocalWebMethod;
    /** Local: límite de inactividad medido de la sesión web (segundos), para estimar su vencimiento. */
    inactivityLimitS?: () => number | null;
    /** Local: datos extra del probe web (p. ej. el tiempo que le queda a la sesión). Sólo lecturas. */
    probeExtras?: (op: WebOperation) => Promise<Record<string, unknown>>;
}

/** Sin medición, el límite de inactividad documentado del Campus (4 h). */
export const DEFAULT_INACTIVITY_S = 4 * 3_600;
const TOUCH_MIN_MS = 60_000;

export interface RenewalOutcome {
    state: RenewalState;
    renewal_id: string | null;
    reason: ConnectionReason | null;
    /** Mensaje fijo para el panel (nunca texto de Moodle ni de otra capa). */
    message: string;
    retry_at?: string | null;
    input_error?: "otp_format";
    diagnostic?: DiagnosticReport | null;
}

const ACTIVE_STATES: RenewalState[] = ["starting", "awaiting_code", "submitting", "candidate_ready"];
const RECOVERABLE: ConnectionReason[] = ["attempt_uncertain", "otp_rejected", "trust_expired", "trust_missing", "session_expired"];

export class ConnectionService {
    readonly store: ConnectionStore;
    private readonly now: () => Date;
    private readonly cfg: ConnectionConfig;

    constructor(private readonly d: ConnectionDeps) {
        this.store = new ConnectionStore(d.kv, connectionKey(d.siteUrl, d.expectedUserId, d.profileId));
        this.now = d.now ?? (() => new Date());
        this.cfg = d.config;
    }

    get panelUrl() {
        return this.d.panelUrl;
    }

    get config() {
        return this.cfg;
    }

    get mode(): "remote" | "local" {
        return this.d.mode ?? "remote";
    }

    private log(event: string, fields: Record<string, unknown>) {
        this.d.log?.(event, { mode: this.mode === "local" ? "local" : "remoto", ...fields });
    }

    /** Acción de recuperación de un motivo, según el modo. */
    action(reason: ConnectionReason | "session_missing"): RecoveryAction {
        if (this.d.recovery) return this.d.recovery(reason);
        return recoveryAction(reason === "session_missing" ? "session_expired" : reason, this.d.panelUrl);
    }

    /** AUTH_REQUIRED tipado de un motivo, según el modo. */
    authError(reason: ConnectionReason | "session_missing"): CampusError {
        if (this.d.authError) return this.d.authError(reason);
        return webAuthError(reason === "session_missing" ? "session_expired" : reason, this.d.panelUrl);
    }

    // ---------- sellado ----------

    private seal(v: unknown) {
        return this.d.box.seal(JSON.stringify(v));
    }

    private open<T>(sealed: string | null): T | null {
        if (!sealed) return null;
        const plain = this.d.box.open(sealed);
        if (plain === null) throw new CampusError("SERVICE_UNAVAILABLE", "Un dato cifrado de la conexión web no se pudo descifrar (¿cambió OAUTH_SIGNING_SECRET?). Hace falta la recuperación.", { details: { reason: "config_conflict" } });
        return JSON.parse(plain) as T;
    }

    activeSnapshot(rec: ConnectionRecord | null): WebSessionSnapshot | null {
        const raw = this.open<string>(rec?.active?.session_sealed ?? null);
        return raw ? decodeSnapshot(raw) : null;
    }

    activeTrust(rec: ConnectionRecord | null): WebCookie[] {
        return this.open<WebCookie[]>(rec?.active?.trust_sealed ?? null) ?? [];
    }

    // ---------- registro, migración y cercos ----------

    /** Registro vigente; si no existe, migra lo legacy (epoch 0) con CAS de ausencia. */
    async record(): Promise<ConnectionRecord> {
        let rec = await this.store.read();
        if (!rec) {
            const fresh = await this.migrate();
            const res = await this.store.update((r) => (r ? null : fresh));
            rec = res.after!;
            this.log("connection_migrated", { from: fresh.active ? "legacy" : "vacio", generation: rec.auth_generation });
            if (res.changed && this.d.onMigrated) {
                try {
                    this.d.onMigrated();
                } catch {
                    /* el estado viejo queda donde estaba: no cambia el registro adoptado */
                }
            }
        }
        // Corte explícito publicado por la CLI (epoch mayor, modo disabled): se aplica sin login.
        if (this.cfg.mode === "disabled" && rec.config_epoch < this.cfg.epoch) {
            rec = (await this.store.update((r) => (r && r.config_epoch < this.cfg.epoch ? this.applyDisable(r) : null))).after ?? rec;
        }
        return rec;
    }

    private applyDisable(r: ConnectionRecord): ConnectionRecord {
        const at = this.now().toISOString();
        return {
            ...r,
            config_epoch: this.cfg.epoch,
            config_fingerprint: this.cfg.fingerprint,
            // La sesión abierta queda hasta que vence; la confianza deja de servir para el login automático.
            active: r.active ? { ...r.active, trust_sealed: null, trust_expires_at: null } : null,
            control: { ...r.control, disabled: { at, reason: "manual_disable" }, pending: r.control.pending && ACTIVE_STATES.includes(r.control.pending.state) ? { ...r.control.pending, state: "cancelled" } : r.control.pending },
            activation: null,
        };
    }

    /** Estado legacy (claves web:<perfil>:*) adoptado como epoch 0, sin login ni MFA. Dañado ≠ vacío. */
    private async migrate(): Promise<ConnectionRecord> {
        if (this.d.legacyLoader) return this.migrateLocal(this.d.legacyLoader);
        const at = this.now().toISOString();
        const legacyPrefix = `web:${this.d.profileId}`;
        const get = async (k: string) => {
            const raw = await this.d.kv.cmd(["GET", `${legacyPrefix}:${k}`]);
            if (typeof raw !== "string") return null;
            try {
                return JSON.parse(raw) as Record<string, unknown>;
            } catch {
                throw new CampusError("SERVICE_UNAVAILABLE", `El estado legacy de la sesión web (${k}) está dañado: no se migra solo.`, { details: { reason: "kv_unavailable" } });
            }
        };
        const L = this.cfg.legacy;
        const boot = this.cfg.bootstrap;
        // Con un sobre de recuperación y sin estado legacy, se arranca vacío y la activación lo adopta.
        const rec = emptyRecord(boot ? 0 : this.cfg.epoch, boot ? "pre-bootstrap" : this.cfg.fingerprint);
        const sessRec = await get("session");
        const seedFp = this.d.box.fingerprint(L.sessionSeedRaw);
        let snapshot: WebSessionSnapshot | null = null;
        if (sessRec && sessRec.seed === seedFp && typeof sessRec.sealed === "string") {
            const plain = this.d.box.open(sessRec.sealed);
            if (plain === null) throw new CampusError("SERVICE_UNAVAILABLE", "La sesión web legacy no se pudo descifrar: no se migra sola.", { details: { reason: "kv_unavailable" } });
            snapshot = decodeSnapshot(plain);
        } else if (L.sessionSeedRaw) {
            const s = decodeSnapshot(L.sessionSeedRaw);
            if ((await this.d.kv.cmd(["EXISTS", `${legacyPrefix}:rejected:${s.revision}`])) !== 1) snapshot = s;
        }
        const autoFp = this.d.box.fingerprint(`${L.loginRaw ?? ""}\n${L.trustRaw ?? ""}`);
        const trustRec = await get("trust");
        let trust: WebCookie[] = [];
        if (trustRec && trustRec.seed === autoFp && typeof trustRec.sealed === "string") {
            const plain = this.d.box.open(trustRec.sealed);
            if (plain === null) throw new CampusError("SERVICE_UNAVAILABLE", "La confianza legacy no se pudo descifrar: no se migra sola.", { details: { reason: "kv_unavailable" } });
            trust = parseTrust(plain);
        } else trust = parseTrust(L.trustRaw);
        const stateRec = await get("autologin");
        const st = stateRec && stateRec.seed === autoFp ? ((stateRec.state ?? {}) as AutoLoginState) : {};
        rec.control.attempts = (st.attempts ?? []).filter((a) => Date.now() - Date.parse(a) < 86_400_000);
        rec.control.last = st.last ? { at: st.last.at, ok: st.last.ok, source: "autologin", ...(st.last.code ? { code: st.last.code } : {}) } : null;
        if (st.disabled) rec.control.disabled = { at: st.disabled.at, reason: /contrase|password|rechaz/i.test(st.disabled.reason) ? "credentials_rejected" : "attempt_uncertain" };
        if (st.needs_trust) rec.control.needs_trust = { at: st.needs_trust.at, reason: "trust_expired" };
        // Un intento legacy en curso no se adopta como si nada: queda para revisar.
        if (st.inflight) rec.control.disabled = { at, reason: "attempt_uncertain" };
        const own = trust.find((c) => c.name === `MFA_TOKEN_${this.d.expectedUserId}`);
        if (snapshot || trust.length) {
            rec.active = {
                session_sealed: snapshot ? this.seal(encodeSnapshot(snapshot)) : null,
                trust_sealed: trust.length ? this.seal(trust) : null,
                session_revision: snapshot?.revision ?? null,
                trust_expires_at: own?.expires ? new Date(own.expires * 1000).toISOString() : null,
                published_at: at,
                renewal_id: "legacy",
            };
        }
        return rec;
    }

    /**
     * Local (ADR-142): adopta la sesión del keyring, la confianza del keyring y el estado de
     * web-autologin.json, sin login ni MFA. Un estado con un intento en curso queda para revisar.
     */
    private async migrateLocal(load: NonNullable<ConnectionDeps["legacyLoader"]>): Promise<ConnectionRecord> {
        const at = this.now().toISOString();
        const { snapshot, trust, state: st } = await load();
        const rec = emptyRecord(this.cfg.epoch, this.cfg.fingerprint);
        rec.control.attempts = (st.attempts ?? []).filter((a) => this.now().getTime() - Date.parse(a) < 86_400_000);
        rec.control.last = st.last ? { at: st.last.at, ok: st.last.ok, source: "autologin", ...(st.last.code ? { code: st.last.code } : {}) } : null;
        if (st.disabled) rec.control.disabled = { at: st.disabled.at, reason: /contrase|password|rechaz/i.test(st.disabled.reason) ? "credentials_rejected" : "attempt_uncertain" };
        if (st.needs_trust) rec.control.needs_trust = { at: st.needs_trust.at, reason: "trust_expired" };
        if (st.inflight) rec.control.disabled = { at, reason: "attempt_uncertain" };
        const own = trust.find((c) => c.name === `MFA_TOKEN_${this.d.expectedUserId}`);
        if (snapshot || trust.length) {
            rec.active = {
                session_sealed: snapshot ? this.seal(encodeSnapshot(snapshot)) : null,
                trust_sealed: trust.length ? this.seal(trust) : null,
                session_revision: snapshot?.revision ?? null,
                trust_expires_at: own?.expires ? new Date(own.expires * 1000).toISOString() : (st.trust_expires_at ?? null),
                published_at: at,
                renewal_id: "legacy",
                last_used_at: snapshot ? snapshot.imported_at : null,
            };
        }
        return rec;
    }

    /** Qué impide escribir o iniciar sesión con la configuración de esta instancia (null = nada). */
    gate(rec: ConnectionRecord): ConnectionReason | null {
        if (rec.config_epoch > this.cfg.epoch) return "stale_instance";
        if (rec.config_epoch === this.cfg.epoch && rec.config_fingerprint !== this.cfg.fingerprint) return "config_conflict";
        if (rec.config_epoch < this.cfg.epoch) return this.cfg.mode === "enabled" ? "activation_pending" : "manual_disable";
        return null;
    }

    private pendingActive(rec: ConnectionRecord): PendingTransition | null {
        const p = rec.control.pending;
        if (!p || !ACTIVE_STATES.includes(p.state)) return null;
        const now = this.now().getTime();
        if (p.state === "awaiting_code" && Date.parse(p.expires_at) <= now) return null;
        return p;
    }

    // ---------- fuente de sesión (los tres endpoints) ----------

    sessionSource(): WebSessionSource {
        const svc = this;
        return {
            kind: "kv",
            async load() {
                return svc.activeSnapshot(await svc.record());
            },
            async save(s: WebSessionSnapshot, baseRevision?: string | null) {
                const sealed = svc.seal(encodeSnapshot(s));
                const r = await svc.store.update((rec) => {
                    if (!rec?.active || svc.gate(rec) === "stale_instance") return null;
                    // Cerco (ADR-141): una operación abierta antes de una renovación o de otra rotación no pisa la vigente.
                    if (baseRevision !== undefined && baseRevision !== null && rec.active.session_revision !== baseRevision) return null;
                    return { ...rec, active: { ...rec.active, session_sealed: sealed, session_revision: s.revision } };
                });
                if (!r.changed) svc.log("web_session_save_discarded", { reason: "revision_or_generation_changed" });
            },
            async invalidate(revision?: string | null) {
                await svc.store.update((rec) => {
                    if (!rec?.active?.session_sealed || svc.gate(rec) === "stale_instance") return null;
                    if (revision && rec.active.session_revision !== revision) return null;
                    const rev = rec.active.session_revision;
                    return { ...rec, active: { ...rec.active, session_sealed: null, session_revision: null }, control: { ...rec.control, rejected_revisions: [...rec.control.rejected_revisions, ...(rev ? [rev] : [])].slice(-REJECTED_KEEP) } };
                });
            },
            // Local (ADR-142): último uso de la sesión, a lo sumo una escritura por minuto. El remoto no lo registra.
            ...(svc.mode === "local"
                ? {
                      async touch(revision: string | null) {
                          const now = svc.now();
                          await svc.store.update((rec) => {
                              if (!rec?.active?.session_sealed || (revision && rec.active.session_revision !== revision)) return null;
                              const last = rec.active.last_used_at ? Date.parse(rec.active.last_used_at) : 0;
                              if (now.getTime() - last < TOUCH_MIN_MS) return null;
                              return { ...rec, active: { ...rec.active, last_used_at: now.toISOString() } };
                          });
                      },
                  }
                : {}),
        };
    }

    // ---------- login automático remoto ----------

    autoLoginBackend(): AutoLoginBackend {
        const svc = this;
        const renewHint = svc.mode === "local" ? (svc.action("trust_expired").command ?? "Renová la confianza del dispositivo de esta PC.") : svc.d.panelUrl ? `Renová la conexión en ${svc.d.panelUrl}` : "Renová la conexión desde el panel de conexión del servidor.";
        return {
            renewHint,
            async preflight() {
                const rec = await svc.record();
                const g = svc.gate(rec);
                if (g) throw svc.authError(g);
                if (svc.cfg.mode === "disabled") throw svc.authError("manual_disable");
                if (!svc.cfg.login) throw svc.authError("config_incomplete");
                if (svc.pendingActive(rec)) throw svc.authError("renewal_in_progress");
                if (rec.control.disabled) throw svc.authError(rec.control.disabled.reason);
                // Con un canal para el código (diálogo local, ADR-142), una confianza vencida no frena: el login la renueva.
                if (svc.d.interactiveCode) return;
                const exp = rec.active?.trust_expires_at ? Date.parse(rec.active.trust_expires_at) : null;
                if (exp === null) throw svc.authError("trust_missing");
                if (exp - svc.now().getTime() < TRUST_MARGIN_MS) throw svc.authError("trust_expired");
            },
            async loadLogin() {
                return svc.cfg.login;
            },
            async loadTrust() {
                return svc.activeTrust(await svc.record());
            },
            async saveTrust(cookies: WebCookie[]) {
                if (!cookies.length) return;
                const sealed = svc.seal(cookies);
                await svc.store.update((rec) => (rec?.active && !svc.gate(rec) ? { ...rec, active: { ...rec.active, trust_sealed: sealed } } : null));
            },
            async readState(): Promise<AutoLoginState> {
                const rec = await svc.record();
                const c = rec.control;
                return {
                    disabled: c.disabled ? { at: c.disabled.at, reason: reasonMessage(c.disabled.reason) } : null,
                    needs_trust: c.needs_trust ? { at: c.needs_trust.at, reason: reasonMessage(c.needs_trust.reason) } : null,
                    inflight: c.inflight,
                    attempts: c.attempts,
                    last: c.last ? { at: c.last.at, ok: c.last.ok, ...(c.last.code ? { code: c.last.code } : {}) } : null,
                    trust_expires_at: rec.active?.trust_expires_at ?? null,
                };
            },
            async writeState(s: AutoLoginState) {
                await svc.store.update((rec) => {
                    if (!rec) return null;
                    const c = rec.control;
                    const disabled = s.disabled ? (c.disabled ?? { at: s.disabled.at, reason: s.last?.code === "AUTH_REJECTED" ? ("credentials_rejected" as const) : ("attempt_uncertain" as const) }) : null;
                    const needs = s.needs_trust ? (c.needs_trust ?? { at: s.needs_trust.at, reason: "trust_expired" as const }) : null;
                    return { ...rec, control: { ...c, attempts: (s.attempts ?? c.attempts).slice(-AUTOLOGIN_MAX_PER_DAY * 2), inflight: s.inflight ?? null, last: s.last ? { at: s.last.at, ok: s.last.ok, source: "autologin", ...(s.last.code ? { code: s.last.code } : {}) } : c.last, disabled, needs_trust: needs } };
                });
            },
            async publish(r: LoginResult) {
                await svc.commitLogin(r, `auto-${randomBytes(6).toString("base64url")}`, null);
            },
            async lock() {
                const token = randomBytes(9).toString("base64url");
                const deadline = Date.now() + LEASE_WAIT_MS;
                while (!(await svc.store.lease(token, svc.d.leaseSeconds ?? LEASE_S))) {
                    if (Date.now() > deadline) throw svc.authError("renewal_in_progress");
                    await new Promise((res) => setTimeout(res, 500));
                }
                return async () => svc.store.releaseLease(token);
            },
        };
    }

    /**
     * Publicación atómica de un login completo (renovación del panel o autologin): sesión, confianza,
     * generación nueva y recibo. Con `renewalId` de una renovación, sólo si sigue siendo la pendiente.
     */
    private async commitLogin(r: LoginResult, renewalId: string, pendingId: string | null, source: "panel" | "autologin" | "terminal" = pendingId ? "panel" : "autologin"): Promise<ConnectionRecord | null> {
        const at = this.now().toISOString();
        const own = r.remembered.find((c) => c.name === `MFA_TOKEN_${this.d.expectedUserId}`);
        const sessionSealed = this.seal(encodeSnapshot(r.snapshot));
        const trustSealed = r.remembered.length ? this.seal(r.remembered) : null;
        const res = await this.store.update((rec) => {
            if (!rec) return null;
            if (rec.receipts.some((x) => x.renewal_id === renewalId)) return null; // ya publicado (reintento)
            if (this.gate(rec)) return null;
            if (pendingId && (rec.control.pending?.renewal_id !== pendingId || !["submitting", "candidate_ready", "starting"].includes(rec.control.pending.state))) return null;
            const generation = rec.auth_generation + 1;
            const active: ActiveConnection = {
                session_sealed: sessionSealed,
                trust_sealed: trustSealed ?? rec.active?.trust_sealed ?? null,
                session_revision: r.snapshot.revision,
                trust_expires_at: own?.expires ? new Date(own.expires * 1000).toISOString() : (r.trust_expires_at ?? rec.active?.trust_expires_at ?? null),
                published_at: at,
                renewal_id: renewalId,
                ...(this.mode === "local" ? { last_used_at: at } : {}),
            };
            const receipts = [...rec.receipts.filter((x) => this.now().getTime() - Date.parse(x.at) < RECEIPT_WINDOW_MS), { renewal_id: renewalId, auth_generation: generation, at, state: "committed" as const }];
            // Una puesta en marcha desde la terminal (contraseña escrita de nuevo) limpia cualquier freno anterior.
            const disabled = source === "terminal" ? null : rec.control.disabled && RECOVERABLE.includes(rec.control.disabled.reason) && pendingId ? null : rec.control.disabled;
            return {
                ...rec,
                auth_generation: generation,
                active,
                receipts,
                // El diagnóstico anterior deja de ser vigente en la misma transición.
                last_diagnostic: pendingReport(renewalId, rec.config_epoch, generation, r.snapshot.revision, at),
                control: { ...rec.control, pending: pendingId ? null : rec.control.pending, needs_trust: null, disabled, inflight: null, last: { at, ok: true, source } },
            };
        });
        if (res.changed) this.log("connection_committed", { renewal_id: renewalId, generation: res.after!.auth_generation });
        return res.after;
    }

    // ---------- local: terminal, cookie y olvido (ADR-142) ----------

    /** Confianza guardada, o [] si no se puede descifrar (una puesta en marcha nueva la reemplaza). */
    async trustForLogin(): Promise<WebCookie[]> {
        try {
            return this.activeTrust(await this.record());
        } catch {
            return [];
        }
    }

    /** Antes de pedir la contraseña en la terminal: mismas guardas de frecuencia que el panel, sin efectos. */
    async terminalBlock(): Promise<RenewalOutcome | null> {
        const rec = await this.record();
        const p = this.pendingActive(rec);
        if (p) return this.outcome(p.state, p.renewal_id, "renewal_in_progress", "Hay una renovación en curso (panel u otro proceso): esperá a que termine.");
        const now = this.now().getTime();
        const recent = rec.control.attempts.filter((a) => now - Date.parse(a) < 86_400_000);
        if (recent.length >= AUTOLOGIN_MAX_PER_DAY) return this.outcome("failed", null, "rate_limited", reasonMessage("rate_limited"), { retry_at: new Date(Date.parse(recent.sort()[0]!) + 86_400_000).toISOString() });
        const last = rec.control.last;
        if (last) {
            const pause = last.ok ? AUTOLOGIN_MIN_INTERVAL_AFTER_OK_MS : AUTOLOGIN_MIN_INTERVAL_MS;
            if (now - Date.parse(last.at) < pause) return this.outcome("failed", null, "rate_limited", reasonMessage("rate_limited"), { retry_at: new Date(Date.parse(last.at) + pause).toISOString() });
        }
        return null;
    }

    /** Registra un intento de la terminal (cuenta para los seis por día) antes de enviar la contraseña. */
    async noteTerminalAttempt(): Promise<void> {
        await this.record(); // el registro existe (o se migra) antes de anotar
        const now = this.now();
        await this.store.update((r) => (r ? { ...r, control: { ...r.control, attempts: [...r.control.attempts.filter((a) => now.getTime() - Date.parse(a) < 86_400_000), now.toISOString()] } } : null));
    }

    /** Resultado fallido de la terminal (para la pausa de 10 minutos). */
    async noteTerminalFailure(code: string): Promise<void> {
        await this.record();
        const at = this.now().toISOString();
        await this.store.update((r) => (r ? { ...r, control: { ...r.control, last: { at, ok: false, source: "terminal", code } } } : null));
    }

    /** Login completo hecho en la terminal (`auth web autologin enable`): publica sesión y confianza con generación nueva. */
    async adoptLogin(r: LoginResult): Promise<ConnectionRecord | null> {
        if (r.snapshot.user_id !== this.d.expectedUserId) throw this.authError("identity_mismatch");
        await this.record();
        return this.commitLogin(r, `term-${randomBytes(6).toString("base64url")}`, null, "terminal");
    }

    /** Cookie importada y validada (`auth web import`): publica sólo la sesión, conserva la confianza. */
    async importSession(snapshot: WebSessionSnapshot): Promise<ConnectionRecord | null> {
        if (snapshot.user_id !== this.d.expectedUserId) throw this.authError("identity_mismatch");
        await this.record();
        const at = this.now().toISOString();
        const id = `imp-${randomBytes(6).toString("base64url")}`;
        const sealed = this.seal(encodeSnapshot(snapshot));
        const res = await this.store.update((rec) => {
            if (!rec) return null;
            const generation = rec.auth_generation + 1;
            const active: ActiveConnection = { session_sealed: sealed, trust_sealed: rec.active?.trust_sealed ?? null, session_revision: snapshot.revision, trust_expires_at: rec.active?.trust_expires_at ?? null, published_at: at, renewal_id: id, last_used_at: at };
            return { ...rec, auth_generation: generation, active, receipts: [...rec.receipts.filter((x) => this.now().getTime() - Date.parse(x.at) < RECEIPT_WINDOW_MS), { renewal_id: id, auth_generation: generation, at, state: "committed" as const }], last_diagnostic: pendingReport(id, rec.config_epoch, generation, snapshot.revision, at) };
        });
        if (res.changed) this.log("connection_imported", { generation: res.after!.auth_generation });
        return res.after;
    }

    /** `auth web autologin disable`: la confianza deja de existir; la sesión abierta queda hasta que vence. */
    async forgetTrust(): Promise<void> {
        await this.record();
        await this.store.update((rec) => (rec ? { ...rec, active: rec.active ? { ...rec.active, trust_sealed: null, trust_expires_at: null } : null, control: { ...rec.control, disabled: null, needs_trust: null, inflight: null } } : null));
    }

    /** `auth web logout --local`: borra la sesión guardada (no cierra la del navegador). */
    async dropSession(): Promise<void> {
        await this.record();
        await this.store.update((rec) => (rec?.active?.session_sealed ? { ...rec, active: { ...rec.active, session_sealed: null, session_revision: null } } : null));
    }

    // ---------- renovación desde el panel ----------

    private outcome(state: RenewalState, renewalId: string | null, reason: ConnectionReason | null, message: string, extra: Partial<RenewalOutcome> = {}): RenewalOutcome {
        return { state, renewal_id: renewalId, reason, message, ...extra };
    }

    /** Guardas comunes para iniciar (sin efectos). */
    private startBlock(rec: ConnectionRecord, rearm: boolean): RenewalOutcome | null {
        const g = this.gate(rec);
        if (g && g !== "activation_pending") return this.outcome("failed", null, g, reasonMessage(g));
        if (g === "activation_pending") return this.outcome("failed", null, g, reasonMessage(g));
        if (this.cfg.mode !== "enabled" || !this.cfg.login) return this.outcome("failed", null, this.cfg.mode === "disabled" ? "manual_disable" : "config_incomplete", reasonMessage(this.cfg.mode === "disabled" ? "manual_disable" : "config_incomplete"));
        const d = rec.control.disabled;
        if (d && (d.reason === "credentials_rejected" || d.reason === "manual_disable")) return this.outcome("failed", null, d.reason, reasonMessage(d.reason));
        const p = rec.control.pending;
        const now = this.now().getTime();
        if (p && ACTIVE_STATES.includes(p.state)) {
            const claimOver = p.claim_until ? Date.parse(p.claim_until) <= now : true;
            if (p.state === "awaiting_code" && Date.parse(p.expires_at) > now) return this.outcome("awaiting_code", p.renewal_id, "renewal_in_progress", "La renovación ya está en curso.");
            if ((p.state === "starting" || p.state === "submitting") && !claimOver) return this.outcome(p.state, p.renewal_id, "renewal_in_progress", "La renovación ya está en curso.");
            if (p.state === "candidate_ready") return this.outcome("candidate_ready", p.renewal_id, "renewal_in_progress", "La renovación ya está en curso.");
            if ((p.state === "starting" || p.state === "submitting") && claimOver && !rearm) return this.outcome("uncertain", p.renewal_id, "attempt_uncertain", "No pudimos confirmar el resultado del intento. No vamos a reenviar el código automáticamente.");
        }
        if ((p?.state === "uncertain" || d?.reason === "attempt_uncertain") && !rearm) return this.outcome("uncertain", p?.renewal_id ?? null, "attempt_uncertain", "No pudimos confirmar el resultado del intento. No vamos a reenviar el código automáticamente.");
        const recent = rec.control.attempts.filter((a) => now - Date.parse(a) < 86_400_000);
        if (recent.length >= AUTOLOGIN_MAX_PER_DAY) {
            const retry = new Date(Date.parse(recent.sort()[0]!) + 86_400_000).toISOString();
            return this.outcome("failed", null, "rate_limited", reasonMessage("rate_limited"), { retry_at: retry });
        }
        const last = rec.control.last;
        if (last) {
            const pause = last.ok ? AUTOLOGIN_MIN_INTERVAL_AFTER_OK_MS : AUTOLOGIN_MIN_INTERVAL_MS;
            if (now - Date.parse(last.at) < pause) return this.outcome("failed", null, "rate_limited", reasonMessage("rate_limited"), { retry_at: new Date(Date.parse(last.at) + pause).toISOString() });
        }
        return null;
    }

    /** POST «Enviar código y renovar»: reserva, inicia la candidata y deja el desafío listo para el código. */
    async start(browserHash: string, opts: { rearm?: boolean } = {}): Promise<RenewalOutcome> {
        let rec = await this.record();
        const blocked = this.startBlock(rec, !!opts.rearm);
        if (blocked) return blocked;
        // Para iniciar hace falta la identidad REST verificada (evidencia fresca).
        try {
            const v = await this.d.verifyApi();
            if (v.userid !== this.d.expectedUserId) return this.outcome("failed", null, "identity_mismatch", reasonMessage("identity_mismatch"));
        } catch (e) {
            const code = toPublicError(e).code;
            return this.outcome("failed", null, code === "NETWORK_ERROR" || code === "SERVICE_UNAVAILABLE" ? "kv_unavailable" : "api_token_invalid", code === "NETWORK_ERROR" || code === "SERVICE_UNAVAILABLE" ? "No se pudo verificar la identidad con la API de Moodle (el Campus no responde). No se envió nada." : reasonMessage("api_token_invalid"));
        }
        const now = this.now();
        const id = `ren_${randomBytes(9).toString("base64url")}`;
        const reserved = await this.store.update((r) => {
            if (!r || this.startBlock(r, !!opts.rearm)) return null;
            const pending: PendingTransition = { renewal_id: id, state: "starting", started_at: now.toISOString(), expires_at: new Date(now.getTime() + CHALLENGE_TTL_S * 1000).toISOString(), claim_until: new Date(now.getTime() + CLAIM_MS).toISOString(), browser_hash: browserHash, config_epoch: r.config_epoch, auth_generation: r.auth_generation, reason: null, trust_expires_at: null };
            const disabled = r.control.disabled?.reason === "attempt_uncertain" ? null : r.control.disabled;
            return { ...r, control: { ...r.control, pending, disabled, attempts: [...r.control.attempts.filter((a) => now.getTime() - Date.parse(a) < 86_400_000), now.toISOString()] } };
        });
        if (!reserved.changed) return this.startBlock(reserved.after ?? rec, !!opts.rearm) ?? this.outcome("failed", null, "renewal_in_progress", "La renovación ya está en curso.");
        rec = reserved.after!;
        this.log("connection_renewal", { phase: "reserved", renewal_id: id });
        // Renovación explícita: sin la confianza anterior (si no, Moodle la acepta sin emitir una nueva).
        const remembered = this.activeTrust(rec).filter((c) => !TRUST_COOKIE.test(c.name));
        let begun;
        try {
            begun = await beginPasswordLogin(this.d.isolatedTransport(null), { username: this.cfg.login!.username, password: this.cfg.login!.password, remembered, now: this.now });
        } catch (e) {
            return this.failStart(id, e);
        }
        if (begun.kind === "complete") return this.finishCandidate(id, begun.result, "starting");
        await this.store.putSide("challenge", id, this.seal(begun.continuation), CHALLENGE_TTL_S);
        const ready = await this.store.update((r) => (r?.control.pending?.renewal_id === id && r.control.pending.state === "starting" ? { ...r, control: { ...r.control, pending: { ...r.control.pending, state: "awaiting_code", claim_until: null } } } : null));
        if (!ready.changed) return this.outcome("superseded", id, null, "Este proceso fue reemplazado. Iniciá una nueva renovación.");
        this.log("connection_renewal", { phase: "awaiting_code", renewal_id: id });
        return this.outcome("awaiting_code", id, null, "Ingresá el código de seis dígitos del correo que acabás de solicitar.");
    }

    private async failStart(id: string, e: unknown): Promise<RenewalOutcome> {
        const pe = toPublicError(e);
        const sent = e instanceof CampusError && e.details?.credentials_sent === true;
        const rejected = e instanceof CampusError && e.details?.reason === PASSWORD_REJECTED;
        const at = this.now().toISOString();
        const state: RenewalState = rejected ? "failed" : sent ? "uncertain" : "failed";
        const reason: ConnectionReason | null = rejected ? "credentials_rejected" : sent ? "attempt_uncertain" : null;
        await this.store.update((r) =>
            r?.control.pending?.renewal_id === id
                ? { ...r, control: { ...r.control, pending: { ...r.control.pending, state, reason, claim_until: null }, last: { at, ok: false, source: "panel", code: pe.code }, disabled: rejected ? { at, reason: "credentials_rejected" } : r.control.disabled } }
                : null,
        );
        this.log("connection_renewal", { phase: "start_failed", renewal_id: id, code: pe.code, sent });
        if (rejected) return this.outcome("failed", id, "credentials_rejected", reasonMessage("credentials_rejected"));
        if (sent) return this.outcome("uncertain", id, "attempt_uncertain", "No pudimos confirmar el resultado del intento. No vamos a reenviar el código automáticamente.");
        return this.outcome("failed", id, null, "No se pudo iniciar el login en el Campus (no se envió la contraseña). Podés volver a intentar más tarde.");
    }

    /** Valida la candidata (identidad + confianza nueva del usuario esperado) y la publica. */
    private async finishCandidate(id: string, r: LoginResult, from: "starting" | "submitting"): Promise<RenewalOutcome> {
        const own = r.remembered.find((c) => c.name === `MFA_TOKEN_${this.d.expectedUserId}`);
        const nowMs = this.now().getTime();
        if (r.snapshot.user_id !== this.d.expectedUserId) {
            await this.markPending(id, "failed", "identity_mismatch");
            return this.outcome("failed", id, "identity_mismatch", reasonMessage("identity_mismatch"));
        }
        if (!own?.expires || own.expires * 1000 - nowMs < TRUST_MARGIN_MS) {
            // Moodle dejó entrar sin emitir una confianza nueva: la renovación quedó incompleta.
            await this.markPending(id, "failed", "trust_missing");
            return this.outcome("failed", id, "trust_missing", "El Campus inició sesión pero no emitió una confianza nueva del dispositivo: la renovación quedó incompleta.");
        }
        await this.store.putSide("candidate", id, this.seal({ r }), CHALLENGE_TTL_S);
        await this.store.update((x) => (x?.control.pending?.renewal_id === id && x.control.pending.state === from ? { ...x, control: { ...x.control, pending: { ...x.control.pending, state: "candidate_ready", trust_expires_at: new Date(own.expires! * 1000).toISOString() } } } : null));
        return this.publishCandidate(id, r);
    }

    private async publishCandidate(id: string, r: LoginResult): Promise<RenewalOutcome> {
        const after = await this.commitLogin(r, id, id);
        if (!after || !after.receipts.some((x) => x.renewal_id === id)) return this.outcome("superseded", id, null, "La renovación fue reemplazada por otra: leé el estado actual.");
        await this.store.delSide("challenge", id).catch(() => undefined);
        await this.store.delSide("candidate", id).catch(() => undefined);
        const diagnostic = await this.diagnose().catch(() => null);
        return this.outcome("committed", id, null, diagnostic?.result === "ready" ? "Conexión renovada y verificada." : "La renovación quedó guardada. No pudimos comprobar la conexión.", { diagnostic });
    }

    private async markPending(id: string, state: RenewalState, reason: ConnectionReason | null) {
        const at = this.now().toISOString();
        await this.store.update((r) => (r?.control.pending?.renewal_id === id ? { ...r, control: { ...r.control, pending: { ...r.control.pending, state, reason, claim_until: null }, last: state === "failed" || state === "uncertain" ? { at, ok: false, source: "panel" } : r.control.last } } : null));
    }

    /** POST «Confirmar y verificar»: reclama el desafío, envía el código una vez, publica y diagnostica. */
    async complete(renewalId: string, code: string, browserHash: string): Promise<RenewalOutcome> {
        const otp = code.trim();
        if (!/^\d{6}$/.test(otp)) return this.outcome("awaiting_code", renewalId, null, "El código son seis dígitos: no se envió nada.", { input_error: "otp_format" });
        const rec = await this.record();
        if (rec.receipts.some((x) => x.renewal_id === renewalId)) return this.outcome("committed", renewalId, null, "Conexión renovada.", { diagnostic: rec.last_diagnostic });
        const p = rec.control.pending;
        if (!p || p.renewal_id !== renewalId || p.browser_hash !== browserHash) return this.outcome("superseded", renewalId, null, "Este proceso no está vigente en este navegador. Iniciá una nueva renovación.");
        if (p.state === "candidate_ready") return this.resume();
        if (p.state !== "awaiting_code") return this.outcome(p.state, renewalId, p.reason, p.state === "submitting" ? "La renovación ya está en curso." : "Este proceso ya terminó.");
        const now = this.now();
        if (Date.parse(p.expires_at) <= now.getTime()) {
            await this.markPending(renewalId, "expired", null);
            return this.outcome("expired", renewalId, null, "Este proceso venció. Iniciá una nueva renovación.");
        }
        const claimed = await this.store.update((r) =>
            r?.control.pending?.renewal_id === renewalId && r.control.pending.state === "awaiting_code" && r.control.pending.browser_hash === browserHash && Date.parse(r.control.pending.expires_at) > now.getTime()
                ? { ...r, control: { ...r.control, pending: { ...r.control.pending, state: "submitting", claim_until: new Date(now.getTime() + CLAIM_MS).toISOString() } } }
                : null,
        );
        if (!claimed.changed) return this.outcome("submitting", renewalId, "renewal_in_progress", "La renovación ya está en curso.");
        const sealed = await this.store.getSide("challenge", renewalId);
        if (!sealed) {
            await this.markPending(renewalId, "expired", null);
            return this.outcome("expired", renewalId, null, "Este proceso venció. Iniciá una nueva renovación.");
        }
        const cont = this.open<MfaContinuation>(sealed)!;
        let result: LoginResult;
        try {
            result = await completePasswordLogin(this.d.isolatedTransport(null), cont, otp, { now: this.now });
        } catch (e) {
            const pe = toPublicError(e);
            const sent = e instanceof CampusError && e.details?.credentials_sent === true;
            const rejected = e instanceof CampusError && e.details?.reason === OTP_REJECTED;
            this.log("connection_renewal", { phase: "complete_failed", renewal_id: renewalId, code: pe.code, sent });
            if (rejected) {
                await this.markPending(renewalId, "failed", "otp_rejected");
                await this.store.delSide("challenge", renewalId).catch(() => undefined);
                return this.outcome("failed", renewalId, "otp_rejected", "El Campus no aceptó el código: puede ser incorrecto o haber vencido.");
            }
            if (sent) {
                await this.markPending(renewalId, "uncertain", "attempt_uncertain");
                return this.outcome("uncertain", renewalId, "attempt_uncertain", "No pudimos confirmar el resultado del intento. No vamos a reenviar el código automáticamente.");
            }
            await this.markPending(renewalId, "failed", null);
            return this.outcome("failed", renewalId, null, "No se pudo completar la renovación (no se envió el código).");
        }
        return this.finishCandidate(renewalId, result, "submitting");
    }

    /** Publica una candidata ya validada que quedó sin publicar (corte entre validación y publicación). Sin Moodle. */
    async resume(): Promise<RenewalOutcome> {
        const rec = await this.record();
        const p = rec.control.pending;
        if (!p || p.state !== "candidate_ready") return this.outcome(p?.state ?? "idle", p?.renewal_id ?? null, p?.reason ?? null, "No hay una publicación pendiente.");
        const sealed = await this.store.getSide("candidate", p.renewal_id);
        if (!sealed) {
            await this.markPending(p.renewal_id, "uncertain", "attempt_uncertain");
            return this.outcome("uncertain", p.renewal_id, "attempt_uncertain", "No pudimos confirmar el resultado del intento. No vamos a reenviar el código automáticamente.");
        }
        const { r } = this.open<{ r: LoginResult }>(sealed)!;
        return this.publishCandidate(p.renewal_id, r);
    }

    /** POST «Cancelar»: sólo un desafío que todavía espera el código. */
    async cancel(renewalId: string, browserHash: string): Promise<RenewalOutcome> {
        const res = await this.store.update((r) => (r?.control.pending?.renewal_id === renewalId && r.control.pending.state === "awaiting_code" && r.control.pending.browser_hash === browserHash ? { ...r, control: { ...r.control, pending: { ...r.control.pending, state: "cancelled", claim_until: null } } } : null));
        if (!res.changed) {
            const p = res.after?.control.pending;
            return this.outcome(p?.renewal_id === renewalId ? p.state : "superseded", renewalId, null, p?.state === "submitting" ? "La renovación ya está en curso: no se puede cancelar." : "No hay un proceso para cancelar.");
        }
        await this.store.delSide("challenge", renewalId).catch(() => undefined);
        return this.outcome("cancelled", renewalId, null, "Renovación cancelada.");
    }

    // ---------- activación de una recuperación por CLI ----------

    /** POST «Activar y verificar recuperación»: adopta el sobre de epoch mayor tras verificar su sesión, sin contraseña ni MFA. */
    async activate(): Promise<RenewalOutcome> {
        const rec = await this.record();
        const boot = this.cfg.bootstrap;
        if (this.gate(rec) !== "activation_pending" || !boot || boot.mode !== "enabled") return this.outcome("idle", null, this.gate(rec), "No hay una configuración de recuperación para activar.");
        const at = this.now().toISOString();
        const t = this.d.isolatedTransport(boot.session);
        let snapshot: WebSessionSnapshot;
        try {
            const op = await t.open();
            snapshot = op.rotated ? t.snapshotOf(op, this.now()) : boot.session;
        } catch (e) {
            await this.store.update((r) => (r && r.config_epoch < boot.activation_epoch ? { ...r, activation: { epoch: boot.activation_epoch, state: "rejected", at, reason: toPublicError(e).code } } : null));
            this.log("connection_activation", { outcome: "rejected", code: toPublicError(e).code });
            return this.outcome("failed", null, "activation_pending", "La sesión de la recuperación ya no es válida (venció entre la PC y el despliegue). Repetí la recuperación desde la PC.");
        }
        const own = boot.trust.find((c) => c.name === `MFA_TOKEN_${this.d.expectedUserId}`)!;
        const id = `act_${boot.activation_epoch}`;
        const res = await this.store.update((r) => {
            if (!r || r.config_epoch >= boot.activation_epoch) return null;
            const generation = r.auth_generation + 1;
            const pending = r.control.pending && ACTIVE_STATES.includes(r.control.pending.state) ? { ...r.control.pending, state: "superseded" as const, claim_until: null } : r.control.pending;
            return {
                ...r,
                config_epoch: boot.activation_epoch,
                config_fingerprint: this.cfg.fingerprint,
                auth_generation: generation,
                active: { session_sealed: this.seal(encodeSnapshot(snapshot)), trust_sealed: this.seal(boot.trust), session_revision: snapshot.revision, trust_expires_at: own.expires ? new Date(own.expires * 1000).toISOString() : null, published_at: at, renewal_id: id },
                receipts: [...r.receipts.filter((x) => this.now().getTime() - Date.parse(x.at) < RECEIPT_WINDOW_MS), { renewal_id: id, auth_generation: generation, at, state: "committed" as const }],
                last_diagnostic: pendingReport(id, boot.activation_epoch, generation, snapshot.revision, at),
                activation: null,
                control: { ...r.control, pending, disabled: null, needs_trust: null, inflight: null },
            };
        });
        if (!res.changed) return this.outcome("superseded", id, null, "Otra instancia ya activó una configuración: leé el estado actual.");
        this.log("connection_activation", { outcome: "activated", epoch: boot.activation_epoch });
        const diagnostic = await this.diagnose().catch(() => null);
        return this.outcome("committed", id, null, diagnostic?.result === "ready" ? "Recuperación activada y verificada." : "La recuperación quedó activada. No pudimos comprobar la conexión.", { diagnostic });
    }

    // ---------- diagnóstico y estado público ----------

    async diagnose(): Promise<DiagnosticReport> {
        return runDiagnostics({
            store: this.store,
            now: this.now,
            expectedUserId: this.d.expectedUserId,
            readActive: (rec) => ({ snapshot: this.activeSnapshot(rec), trust: this.activeTrust(rec) }),
            isolatedTransport: this.d.isolatedTransport,
            verifyApi: this.d.verifyApi,
            saveRotation: (s, base) => this.sessionSource().save(s, base),
            nextAction: (rec) => this.reasonOf(rec),
            trustRequired: this.mode === "remote" || this.cfg.mode === "enabled",
            actionKind: (r) => this.action(r).kind,
        });
    }

    /** Sólo la sesión web publicada, aislada y sin login automático (campus_get_status con verify_web). */
    async probeWeb(): Promise<{ state: "ok" | "failed" | "unknown"; checked_at: string; reason: string | null; [k: string]: unknown }> {
        const at = () => this.now().toISOString();
        let snapshot: WebSessionSnapshot | null;
        try {
            snapshot = this.activeSnapshot(await this.record());
        } catch (e) {
            return { state: "unknown", checked_at: at(), reason: toPublicError(e).code };
        }
        if (!snapshot) return { state: "failed", checked_at: at(), reason: "sin_sesion_publicada" };
        try {
            const t = this.d.isolatedTransport(snapshot);
            const op = await t.open();
            const extras = this.d.probeExtras ? await this.d.probeExtras(op).catch(() => ({})) : {};
            if (op.rotated && op.userId !== null) await this.sessionSource().save(t.snapshotOf(op, this.now()), snapshot.revision).catch(() => undefined);
            return { state: "ok", checked_at: at(), reason: null, ...extras };
        } catch (e) {
            const code = toPublicError(e).code;
            return { state: code === "AUTH_REQUIRED" || code === "IDENTITY_MISMATCH" ? "failed" : "unknown", checked_at: at(), reason: code };
        }
    }

    /** Motivo principal que requiere atención (sin red), o null si nada. */
    reasonOf(rec: ConnectionRecord): ConnectionReason | null {
        const g = this.gate(rec);
        if (g) return g;
        if (this.cfg.mode === "disabled") return "manual_disable";
        if (!this.cfg.login) return null; // sólo sesión: no hay renovación por panel
        if (this.pendingActive(rec)) return "renewal_in_progress";
        if (rec.control.pending?.state === "uncertain") return "attempt_uncertain";
        if (rec.control.disabled) return rec.control.disabled.reason;
        const t = trustState(rec.active?.trust_expires_at ?? null, this.now());
        if (t === "missing") return "trust_missing";
        if (t === "expired") return "trust_expired";
        if (t === "expiring") return "trust_expiring";
        return null;
    }

    /** Proyección pública para campus_get_status y el panel: sin datos cifrados ni secretos. */
    async publicStatus(): Promise<Record<string, unknown>> {
        let rec: ConnectionRecord;
        try {
            rec = await this.record();
        } catch (e) {
            const reason = (e instanceof CampusError && typeof e.details?.reason === "string" ? e.details.reason : "kv_unavailable") as ConnectionReason;
            return { schema_version: 1, mode: this.mode, persistence: { state: "failed", checked_at: this.now().toISOString(), reason }, action: this.action(reason) };
        }
        const reason = this.reasonOf(rec);
        const d = rec.last_diagnostic;
        const current = d && d.auth_generation === rec.auth_generation && d.config_epoch === rec.config_epoch;
        const check = (k: keyof DiagnosticReport["checks"]) => (current ? { state: d!.checks[k].state, checked_at: d!.checks[k].checked_at } : { state: "not_checked", checked_at: null });
        const local = this.mode === "local";
        const method = local ? (this.d.localMethod?.() ?? (this.cfg.mode === "enabled" ? "autologin" : rec.active?.session_sealed ? "cookie" : "none")) : null;
        // Local sin sesión y sin login automático: no hay motivo del catálogo, pero sí algo que hacer.
        const action: RecoveryAction | null = reason ? this.action(reason) : local && method !== "autologin" && !rec.active?.session_sealed ? this.action("session_missing") : null;
        const webSession: Record<string, unknown> = { ...check("web_session"), present: !!rec.active?.session_sealed };
        if (local && rec.active?.session_sealed) {
            const lastUsed = rec.active.last_used_at ?? rec.active.published_at;
            const limit = this.d.inactivityLimitS?.() ?? null;
            webSession.last_used_at = lastUsed;
            webSession.estimated_expires_if_idle_at = new Date(Date.parse(lastUsed) + (limit ?? DEFAULT_INACTIVITY_S) * 1000).toISOString();
            webSession.estimate_basis = limit ? "limite_medido" : "limite_documentado_4h";
            if (method === "autologin") webSession.note = "Con el login automático, una sesión vencida se renueva sola mientras la confianza del dispositivo esté vigente.";
        }
        const trustInfo = local && method !== "autologin" ? { state: "not_applicable", expires_at: rec.active?.trust_expires_at ?? null } : { state: trustState(rec.active?.trust_expires_at ?? null, this.now()), expires_at: rec.active?.trust_expires_at ?? null };
        return {
            schema_version: 1,
            mode: this.mode,
            ...(local ? { method } : {}),
            api_token: check("api_token"),
            web_session: webSession,
            device_trust: trustInfo,
            persistence: { state: "ok", checked_at: this.now().toISOString() },
            renewal: { state: rec.control.pending?.state ?? "idle", reason: rec.control.pending?.reason ?? null, last_result: rec.receipts.at(-1) ? { renewal_id: rec.receipts.at(-1)!.renewal_id, at: rec.receipts.at(-1)!.at } : null },
            activation: rec.config_epoch < this.cfg.epoch && this.cfg.mode === "enabled" ? { state: rec.activation?.state ?? "pending", expected_epoch: this.cfg.epoch, observed_epoch: rec.config_epoch } : null,
            last_diagnostic: d ? { result: current ? d.result : "superseded", finished_at: d.finished_at, auth_generation: d.auth_generation } : null,
            auth_generation: rec.auth_generation,
            action,
        };
    }
}

export function pendingReport(renewalId: string | null, epoch: number, generation: number, revision: string | null, at: string): DiagnosticReport {
    const nc = { state: "not_checked" as const, checked_at: null, reason: null };
    return {
        diagnostic_id: `dg_${randomBytes(6).toString("base64url")}`,
        renewal_id: renewalId,
        config_epoch: epoch,
        auth_generation: generation,
        session_revision: revision,
        started_at: at,
        finished_at: null,
        result: "pending",
        checks: { persistence: nc, api_token: nc, web_session: nc, identity: nc, device_trust: { ...nc, trust: "unknown", expires_at: null } },
        next_action: null,
    };
}
