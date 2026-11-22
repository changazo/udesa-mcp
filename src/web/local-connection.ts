import { randomBytes } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CampusError } from "../errors.js";
import type { ConnectionStatusDeps } from "../mcp/server.js";
import { localRecoveryAction, localWebAuthError, type ConnectionReason, type LocalRecoveryContext } from "../remote/connection-contracts.js";
import { ConnectionService, type ConnectionConfig } from "../remote/connection-service.js";
import { KvSecretBox, RemoteAutoLogin } from "../remote/web-store.js";
import type { FetchLike } from "../moodle/transport.js";
import type { MetadataStore } from "../session/metadata.js";
import type { SecretStore } from "../session/secret-store.js";
import type { Logger } from "../util/logger.js";
import { MemoryKv, type KvClient } from "../write/store.js";
import { AutoLogin, autoLoginStatus, loadLogin, loadTrust, readAutoLoginState, type StoredLogin } from "./autologin.js";
import { readWebState } from "./keepalive.js";
import { FileKv } from "./local-kv.js";
import type { MfaCodePrompt } from "./login.js";
import { KeyringWebSessionSource, MemoryWebSessionSource, webSecretAccount, type WebSessionSnapshot, type WebSessionSource } from "./session.js";
import { WebTransport, webUserAgent } from "./transport.js";

/**
 * Conexión web del MCP local con el mismo modelo que el remoto (ADR-142): un registro v2 en un archivo
 * con candado (FileKv), cifrado con una clave propia del Administrador de credenciales, y el mismo
 * servicio de conexión (renovación en dos pasos, cercos, guardas, diagnóstico y estado por capas).
 *
 * El servicio se arma recién cuando hace falta (lee el keyring): comandos que no usan la web no tocan nada.
 */

/** Segunda llave del login web automático en los servidores (ADR-088): la variable en la entrada del cliente MCP. */
export const AUTOLOGIN_ENV = "CAMPUS_WEB_AUTOLOGIN";
const LEGACY_STATE_FILE = "web-autologin.json";
/** Con el diálogo para el código abierto (hasta 3 min), el candado entre procesos dura más que en el remoto. */
const LOCAL_LEASE_S = 300;

export function connectionBoxAccount(profileId: string, siteUrl: string): string {
    return `${profileId}|${siteUrl}|web_connection_box`;
}

export interface LocalConnectionOptions {
    profile: { profile_id: string; site_url: string; limits: { http_timeout_seconds: number } };
    secrets: SecretStore;
    metadata: MetadataStore;
    logger: Logger;
    /** userid de Moodle esperado (identidad verificada del token móvil). */
    expectedUserId: () => Promise<number>;
    /** Verificación REST fresca (diagnóstico e inicio de una renovación). */
    verifyApi: () => Promise<{ userid: number }>;
    /** Prefijo de la CLI para las acciones de recuperación. */
    cli: string;
    /**
     * Servidores MCP: el login automático exige además CAMPUS_WEB_AUTOLOGIN=true (segunda llave). La CLI
     * del humano (panel, enable) no la exige.
     */
    requireSecondKey: boolean;
    env?: NodeJS.ProcessEnv;
    /** Diálogo para el código (servidores locales en Windows, ADR-142 D2). */
    askCode?: MfaCodePrompt | null;
    kv?: KvClient;
    fetch?: FetchLike;
    now?: () => Date;
}

export class LocalConnection {
    private svc: Promise<ConnectionService> | null = null;
    private loginCache: StoredLogin | null = null;

    constructor(private readonly o: LocalConnectionOptions) {}

    get profileId() {
        return this.o.profile.profile_id;
    }

    /** ¿Las dos llaves del login automático (contraseña guardada y, en servidores, la variable)? */
    secondKeyOn(): boolean {
        return !this.o.requireSecondKey || (this.o.env ?? process.env)[AUTOLOGIN_ENV] === "true";
    }

    /** El servicio de conexión de esta PC (se arma una vez por proceso). */
    service(): Promise<ConnectionService> {
        this.svc ??= this.build().catch((e) => {
            this.svc = null;
            throw e;
        });
        return this.svc;
    }

    private async boxKey(): Promise<Uint8Array> {
        const account = connectionBoxAccount(this.o.profile.profile_id, this.o.profile.site_url);
        const raw = await this.o.secrets.get(account);
        if (raw) return Buffer.from(raw, "base64url");
        const fresh = randomBytes(32);
        await this.o.secrets.set(account, fresh.toString("base64url"));
        return fresh;
    }

    private recoveryContext(cfg: ConnectionConfig): LocalRecoveryContext {
        return { cli: this.o.cli, profileId: this.o.profile.profile_id, method: cfg.mode === "enabled" ? "autologin" : "cookie" };
    }

    private async build(): Promise<ConnectionService> {
        const { profile, secrets, metadata, logger } = this.o;
        const [key, expectedUserId, login] = await Promise.all([this.boxKey(), this.o.expectedUserId(), loadLogin(secrets, profile.profile_id, profile.site_url)]);
        this.loginCache = login;
        const box = new KvSecretBox(key);
        const config: ConnectionConfig = {
            epoch: 0,
            fingerprint: "local-v1",
            mode: login && this.secondKeyOn() ? "enabled" : "session_only",
            login,
            bootstrap: null,
            legacy: { loginRaw: null, trustRaw: null, sessionSeedRaw: null },
        };
        const ctx = this.recoveryContext(config);
        const kv = this.o.kv ?? (metadata.location === "memory" ? new MemoryKv() : new FileKv(metadata.location));
        const now = this.o.now;
        return new ConnectionService({
            kv,
            box,
            profileId: profile.profile_id,
            siteUrl: profile.site_url,
            expectedUserId,
            config,
            panelUrl: null,
            now,
            mode: "local",
            log: (event, fields) => logger.log("info", event, { profile_id: profile.profile_id, ...fields }),
            verifyApi: this.o.verifyApi,
            recovery: (r) => localRecoveryAction(r, ctx),
            authError: (r) => localWebAuthError(r, ctx),
            interactiveCode: !!this.o.askCode,
            leaseSeconds: LOCAL_LEASE_S,
            inactivityLimitS: () => readWebState(metadata).last_check?.inactivity_limit_seconds ?? null,
            probeExtras: async (op) => {
                const r = await op.ajax<{ userid?: unknown; timeremaining?: unknown }>("core_session_time_remaining", {});
                const remaining = Number(r?.timeremaining);
                return Number(r?.userid) === op.userId && Number.isFinite(remaining) ? { time_remaining_s: Math.round(remaining) } : {};
            },
            legacyLoader: async () => {
                let snapshot: WebSessionSnapshot | null = null;
                try {
                    snapshot = await new KeyringWebSessionSource(secrets, webSecretAccount(profile.profile_id, profile.site_url)).load();
                } catch {
                    snapshot = null; // una cookie vieja ilegible no se adopta (se importa otra)
                }
                return { snapshot, trust: await loadTrust(secrets, profile.profile_id, profile.site_url), state: readAutoLoginState(metadata) };
            },
            onMigrated: () => {
                if (metadata.location === "memory") return;
                const old = join(metadata.location, LEGACY_STATE_FILE);
                if (existsSync(old)) renameSync(old, `${old}.migrated`);
            },
            isolatedTransport: (seed) =>
                new WebTransport({
                    siteUrl: profile.site_url,
                    source: new MemoryWebSessionSource(seed),
                    expectedUserId: async () => expectedUserId,
                    logger,
                    timeoutMs: profile.limits.http_timeout_seconds * 1000,
                    fetch: this.o.fetch,
                    renewHint: "",
                    userAgent: webUserAgent("local"),
                }),
        });
    }

    /** Fuente de sesión de los servidores y la CLI: el registro de esta PC (armado al primer uso). */
    source(): WebSessionSource {
        const lc = this;
        return {
            kind: "kv",
            async load() {
                return (await lc.service()).sessionSource().load();
            },
            async save(s, base) {
                await (await lc.service()).sessionSource().save(s, base);
            },
            async invalidate(rev) {
                await (await lc.service()).sessionSource().invalidate(rev);
            },
            async touch(rev) {
                await (await lc.service()).sessionSource().touch?.(rev);
            },
        };
    }

    /** AUTH_REQUIRED con la acción de esta PC (para el transporte web sin login automático). */
    async authError(reason: "session_missing" | "session_expired"): Promise<CampusError> {
        return (await this.service()).authError(reason);
    }

    /** Acción tipada de un motivo (mismo catálogo que el estado). */
    async action(reason: ConnectionReason | "session_missing") {
        return (await this.service()).action(reason);
    }

    /**
     * Servidores locales: estado por capas en campus_get_status y, con las dos llaves, el login automático
     * sobre el registro (diálogo para el código si la confianza venció). Devuelve si quedó el login automático.
     */
    async wire(web: WebTransport, target: { webAutoLoginStatus?: (() => Promise<Record<string, unknown>>) | null; connection?: ConnectionStatusDeps | null }): Promise<boolean> {
        const svc = await this.service();
        target.connection = { status: () => svc.publicStatus(), probeWeb: () => svc.probeWeb(), diagnose: () => svc.diagnose() };
        if (svc.config.mode !== "enabled") {
            if (this.loginCache && !this.secondKeyOn()) this.o.logger.log("warn", "web_autologin_second_key_missing", { profile_id: this.profileId });
            return false;
        }
        const backend = svc.autoLoginBackend();
        const src = this.source();
        const inner = new AutoLogin({ transport: web, backend, loadSnapshot: () => src.load(), askCode: this.o.askCode ?? undefined, now: this.o.now, log: (event, fields) => this.o.logger.log("info", event, { profile_id: this.profileId, ...fields }) });
        web.setAutoLogin(new RemoteAutoLogin(inner, backend.renewHint, null, (r) => svc.authError(r)));
        target.webAutoLoginStatus = () => autoLoginStatus(backend, (this.o.now ?? (() => new Date()))());
        this.o.logger.log("info", "web_autologin_enabled", { profile_id: this.profileId });
        return true;
    }
}
