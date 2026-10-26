import { cliCommand } from "../util/cli-command.js";
import { CampusError, LOGIN_HINT } from "../errors.js";
import { canonicalSiteUrl, type Profile } from "../config/profile.js";
import { SiteInfoSchema, type SiteInfo } from "../moodle/schemas.js";
import { MoodleTransport, type FetchLike, type TokenSource } from "../moodle/transport.js";
import type { Logger } from "../util/logger.js";
import type { MetadataStore, SessionMetadata } from "./metadata.js";
import { secretAccount, type SecretStore } from "./secret-store.js";

export type AuthMethod = "native" | "browser";

export interface VerifiedIdentity {
    site_url: string;
    user_id: number;
    validated_at: string;
}

export interface PublicSessionStatus {
    profile_id: string;
    site_url: string;
    authenticated: boolean;
    identity: VerifiedIdentity | null;
    auth_method: AuthMethod | null;
    obtained_at: string | null;
    last_verified_at: string | null;
    requires_human_login: boolean;
    secret_backend: string;
    notes: string[];
    // Nunca: token, password, cookies, privatetoken, userprivateaccesskey.
}

export interface VerifiedSite {
    info: SiteInfo;
    verified_at: string;
}

export interface SessionDeps {
    profile: Profile;
    secrets: SecretStore;
    metadata: MetadataStore;
    logger: Logger;
    fetch?: FetchLike;
    now?: () => Date;
    /** Instrucción al humano cuando hace falta un token nuevo (local: login; remoto: push-token). */
    loginHint?: string;
}

/**
 * Sesión común a ambos métodos de login. Valida candidatos contra el sitio esperado, persiste el
 * token en el keyring y es la única fuente de token del transporte.
 */
export class SessionManager implements TokenSource {
    private cachedToken: string | null = null;
    private rejectedToken: string | null = null;
    private verifying: Promise<VerifiedSite> | null = null;
    private lastVerified: VerifiedSite | null = null;
    private _transport: MoodleTransport | null = null;

    constructor(private readonly deps: SessionDeps) {}

    private get loginHint() {
        return this.deps.loginHint ?? LOGIN_HINT(this.deps.profile.profile_id);
    }

    private get account() {
        const p = this.deps.profile;
        return secretAccount(p.profile_id, p.site_url, p.service);
    }

    private now() {
        return (this.deps.now ?? (() => new Date()))();
    }

    get transport(): MoodleTransport {
        this._transport ??= this.makeTransport(this);
        return this._transport;
    }

    private makeTransport(tokenSource: TokenSource): MoodleTransport {
        const p = this.deps.profile;
        return new MoodleTransport({
            siteUrl: p.site_url,
            tokenSource,
            logger: this.deps.logger,
            timeoutMs: p.limits.http_timeout_seconds * 1000,
            maxConcurrent: p.limits.max_concurrent_requests,
            fetch: this.deps.fetch,
            loginHint: this.loginHint,
            listedFunctions: () => {
                const fns = this.lastVerified?.info.functions;
                return fns ? new Set(fns.map((f) => f.name)) : null;
            },
        });
    }

    /** Comprueba que el almacén seguro responde, antes de pedirle nada al humano. */
    async probeSecretStore(): Promise<void> {
        await this.deps.secrets.get(this.account);
    }

    async getToken(): Promise<string> {
        if (this.cachedToken && this.cachedToken !== this.rejectedToken) return this.cachedToken;
        const stored = await this.deps.secrets.get(this.account);
        if (!stored) {
            throw new CampusError("AUTH_REQUIRED", "No hay una sesión del Campus guardada para este perfil.", {
                humanAction: this.loginHint,
            });
        }
        if (stored === this.rejectedToken) {
            throw new CampusError("AUTH_REQUIRED", "Moodle rechazó el token guardado (vencido o revocado).", {
                humanAction: this.loginHint,
            });
        }
        this.cachedToken = stored;
        return stored;
    }

    reportRejected(token: string): void {
        this.rejectedToken = token;
        this.cachedToken = null;
        this.lastVerified = null;
        this.deps.logger.log("warn", "token_rejected", { profile_id: this.deps.profile.profile_id });
    }

    /** Verificación en vivo, coordinada: N llamadas simultáneas comparten un único request (AUTH-09). */
    verify(): Promise<VerifiedSite> {
        this.verifying ??= this.doVerify().finally(() => {
            this.verifying = null;
        });
        return this.verifying;
    }

    /** Última verificación exitosa, o una nueva si no hay. */
    async verified(): Promise<VerifiedSite> {
        return this.lastVerified ?? this.verify();
    }

    private async doVerify(): Promise<VerifiedSite> {
        const info = await this.transport.call("core_webservice_get_site_info", {}, SiteInfoSchema);
        this.assertSite(info);
        const meta = this.deps.metadata.read();
        if (meta && meta.identity.user_id !== info.userid) {
            throw new CampusError("IDENTITY_MISMATCH", "El token guardado pertenece a otra identidad que la registrada para este perfil.", {
                humanAction: `Revisá la sesión con: ${cliCommand()} auth status --profile ${this.deps.profile.profile_id}`,
            });
        }
        this.lastVerified = { info, verified_at: this.now().toISOString() };
        return this.lastVerified;
    }

    private assertSite(info: SiteInfo) {
        let site: string;
        try {
            site = canonicalSiteUrl(info.siteurl);
        } catch {
            site = "(inválida)";
        }
        if (site !== this.deps.profile.site_url) {
            throw new CampusError("IDENTITY_MISMATCH", `El sitio que respondió (${site}) no es el configurado (${this.deps.profile.site_url}).`);
        }
    }

    /**
     * Adopta un token candidato de cualquier estrategia: lo valida con get_site_info, verifica
     * sitio e identidad y recién entonces lo persiste (AUTH-01/AUTH-05). Ante cualquier falla no
     * toca la sesión existente.
     */
    async adoptCandidate(candidate: string, method: AuthMethod, opts: { replaceIdentity?: boolean } = {}): Promise<VerifiedIdentity> {
        const fixed: TokenSource = { getToken: async () => candidate, reportRejected: () => {} };
        let info: SiteInfo;
        try {
            info = await this.makeTransport(fixed).call("core_webservice_get_site_info", {}, SiteInfoSchema);
        } catch (e) {
            if (e instanceof CampusError && e.code === "AUTH_REQUIRED") {
                throw new CampusError("AUTH_REJECTED", "Moodle emitió un token que luego rechazó al validarlo; no se guardó.", { moodleErrorcode: e.moodleErrorcode });
            }
            throw e;
        }
        this.assertSite(info);
        const existing = this.deps.metadata.read();
        if (existing && existing.identity.user_id !== info.userid && !opts.replaceIdentity) {
            throw new CampusError(
                "IDENTITY_MISMATCH",
                `La cuenta autenticada (userid ${info.userid}) no coincide con la registrada en el perfil (userid ${existing.identity.user_id}). No se reemplazó la sesión.`,
                { humanAction: "Si es intencional, repetí el login con --replace-identity." },
            );
        }
        const nowIso = this.now().toISOString();
        const identity: VerifiedIdentity = { site_url: this.deps.profile.site_url, user_id: info.userid, validated_at: nowIso };
        await this.deps.secrets.set(this.account, candidate);
        const meta: SessionMetadata = {
            schema_version: "1.0",
            profile_id: this.deps.profile.profile_id,
            site_url: this.deps.profile.site_url,
            service: this.deps.profile.service,
            auth_method: method,
            identity,
            obtained_at: nowIso,
        };
        this.deps.metadata.write(meta);
        this.cachedToken = candidate;
        this.rejectedToken = null;
        this.lastVerified = { info, verified_at: nowIso };
        this.deps.logger.log("info", "session_adopted", { profile_id: meta.profile_id, auth_method: method });
        return identity;
    }

    async status(verifyLive = false): Promise<PublicSessionStatus> {
        const p = this.deps.profile;
        const meta = this.deps.metadata.read();
        const notes: string[] = [];
        let stored: string | null = null;
        try {
            stored = await this.deps.secrets.get(this.account);
        } catch (e) {
            notes.push(e instanceof CampusError ? e.message : "No se pudo consultar el almacén seguro.");
        }
        const hasToken = !!stored;
        // Un token nuevo (login posterior al rechazo) no queda marcado como rechazado.
        let requiresLogin = !hasToken || stored === this.rejectedToken;
        if (verifyLive && hasToken) {
            try {
                await this.verify();
                requiresLogin = false;
            } catch (e) {
                const code = e instanceof CampusError ? e.code : "MOODLE_ERROR";
                notes.push(`Verificación en vivo fallida: ${code}.`);
                if (code === "AUTH_REQUIRED" || code === "IDENTITY_MISMATCH") requiresLogin = true;
            }
        } else if (hasToken && !this.lastVerified) {
            notes.push("Estado local; el token no se verificó contra Moodle en esta consulta.");
        }
        if (hasToken && !meta) notes.push("Hay un token sin metadata de identidad; conviene repetir el login.");
        return {
            profile_id: p.profile_id,
            site_url: p.site_url,
            authenticated: hasToken && !requiresLogin,
            identity: meta?.identity ?? null,
            auth_method: meta?.auth_method ?? null,
            obtained_at: meta?.obtained_at ?? null,
            last_verified_at: this.lastVerified?.verified_at ?? null,
            requires_human_login: requiresLogin,
            secret_backend: this.deps.secrets.kind,
            notes,
        };
    }

    /** Borra token y metadata locales. NO revoca el token en Moodle. */
    async logoutLocal(): Promise<{ removed_token: boolean }> {
        const removed = await this.deps.secrets.delete(this.account);
        this.deps.metadata.delete();
        this.cachedToken = null;
        this.rejectedToken = null;
        this.lastVerified = null;
        return { removed_token: removed };
    }

    get identity(): VerifiedIdentity | null {
        return this.deps.metadata.read()?.identity ?? null;
    }

    get lastSiteInfo(): VerifiedSite | null {
        return this.lastVerified;
    }
}
