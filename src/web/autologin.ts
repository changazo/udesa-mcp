import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CampusError, toPublicError } from "../errors.js";
import type { MetadataStore } from "../session/metadata.js";
import type { SecretStore } from "../session/secret-store.js";
import { MFA_CODE_REQUIRED, passwordLogin, TRUST_COOKIE, type LoginResult, type MfaCodePrompt } from "./login.js";
import type { WebCookie, WebSessionSnapshot } from "./session.js";
import type { WebAutoLogin, WebTransport } from "./transport.js";

/**
 * Login web automático — función OPCIONAL y NO RECOMENDADA (ADR-088; remoto, ADR-121). Existe sólo
 * para cuando el keepalive no es viable. Con la contraseña guardada (keyring en local, variable
 * sensible en Vercel), el servidor inicia sesión en la web cuando la sesión venció.
 *
 * Dos llaves: la contraseña cargada por el humano y CAMPUS_WEB_AUTOLOGIN=true. Guardas:
 * - un rechazo de usuario o contraseña la desactiva (nunca un segundo intento: bloqueo de cuenta);
 * - sin canal para el código (remoto, o local sin diálogo), no se intenta sin una confianza vigente
 *   y, si el Campus igual lo pide, queda «necesita confianza»: Moodle manda un correo cada vez que
 *   arma la página del código, así que no se repite;
 * - una marca de «intento en curso» antes de enviar la contraseña: si una ejecución se corta sin
 *   resultado, la siguiente no adivina, se frena;
 * - 10 min entre intentos después de un fallo, 2 min después de un éxito, y a lo sumo 6 por día;
 * - un solo login a la vez (en el proceso y, con el candado del backend, entre procesos o instancias).
 * La contraseña no sale nunca: ni en logs, ni en errores, ni en el estado, ni en respuestas.
 */

export const AUTOLOGIN_MIN_INTERVAL_MS = 10 * 60_000;
export const AUTOLOGIN_MIN_INTERVAL_AFTER_OK_MS = 2 * 60_000;
export const AUTOLOGIN_MAX_PER_DAY = 6;
/** Sin canal para el código, la confianza tiene que durar al menos esto más (si no, se renueva antes). */
export const TRUST_MARGIN_MS = 30 * 60_000;
const STATE_FILE = "web-autologin.json";
const LOCK_FILE = "web-autologin.lock";
const LOCK_STALE_MS = 3 * 60_000;
const LOCK_WAIT_MS = 90_000;

export function webLoginAccount(profileId: string, siteUrl: string): string {
    return `${profileId}|${siteUrl}|web_login`;
}

export function webTrustAccount(profileId: string, siteUrl: string): string {
    return `${profileId}|${siteUrl}|web_trust`;
}

export interface AutoLoginState {
    enabled_at?: string;
    disabled?: { at: string; reason: string } | null;
    /** El Campus pidió el código y no había canal: no se intenta hasta renovar la confianza. */
    needs_trust?: { at: string; reason: string } | null;
    /** Intento en curso (antes de enviar la contraseña). Si queda sin resultado, la ejecución se cortó. */
    inflight?: { at: string } | null;
    /** Intentos (ISO) de las últimas 24 h. */
    attempts?: string[];
    last?: { at: string; ok: boolean; code?: string; mfa?: LoginResult["mfa"] } | null;
    trust_expires_at?: string | null;
}

export interface StoredLogin {
    username: string;
    password: string;
}

/** Dónde viven credenciales, confianza, estado y candado: local (keyring y archivos) o remoto (Vercel + KV). */
export interface AutoLoginBackend {
    loadLogin(): Promise<StoredLogin | null>;
    loadTrust(): Promise<WebCookie[]>;
    saveTrust(cookies: WebCookie[]): Promise<void>;
    readState(): Promise<AutoLoginState>;
    writeState(s: AutoLoginState): Promise<void>;
    /** Toma el candado del login (espera acotada) y devuelve cómo liberarlo. */
    lock(): Promise<() => Promise<void> | void>;
    /** Qué hacer para volver a cargar la contraseña o renovar la confianza. */
    readonly renewHint: string;
}

export function readAutoLoginState(store: MetadataStore): AutoLoginState {
    const raw = store.readJson(STATE_FILE);
    return raw && typeof raw === "object" ? (raw as AutoLoginState) : {};
}

export function writeAutoLoginState(store: MetadataStore, s: AutoLoginState) {
    store.writeJson(STATE_FILE, s);
}

/** Candado entre procesos con un archivo exclusivo junto al estado; sin directorio real, sólo en proceso. */
export interface LoginLock {
    acquire(): Promise<() => void>;
}

export class FileLoginLock implements LoginLock {
    constructor(private readonly dir: string) {}
    async acquire(): Promise<() => void> {
        mkdirSync(this.dir, { recursive: true });
        const path = join(this.dir, LOCK_FILE);
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            try {
                closeSync(openSync(path, "wx"));
                return () => rmSync(path, { force: true });
            } catch {
                try {
                    if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
                } catch {
                    /* lo borró el otro proceso */
                }
                if (Date.now() > deadline) throw new CampusError("UNEXPECTED_RESPONSE", "Otro proceso está iniciando sesión en el Campus hace demasiado; probá de nuevo en un rato.");
                await new Promise((r) => setTimeout(r, 500));
            }
        }
    }
}

export class InProcessLoginLock implements LoginLock {
    private tail: Promise<void> = Promise.resolve();
    async acquire(): Promise<() => void> {
        let release!: () => void;
        const prev = this.tail;
        this.tail = new Promise((r) => (release = r));
        await prev;
        return release;
    }
}

/** Backend local: credenciales y confianza en el keyring; estado en el directorio del perfil. */
export class LocalAutoLoginBackend implements AutoLoginBackend {
    readonly renewHint = "Volvé a cargarla o renová la confianza con: auth web autologin enable (en tu terminal).";
    private readonly fileLock: LoginLock;
    constructor(
        private readonly secrets: SecretStore,
        private readonly metadata: MetadataStore,
        private readonly profileId: string,
        private readonly siteUrl: string,
        lock?: LoginLock,
    ) {
        this.fileLock = lock ?? (metadata.location === "memory" ? new InProcessLoginLock() : new FileLoginLock(metadata.location));
    }
    loadLogin() {
        return loadLogin(this.secrets, this.profileId, this.siteUrl);
    }
    loadTrust() {
        return loadTrust(this.secrets, this.profileId, this.siteUrl);
    }
    saveTrust(cookies: WebCookie[]) {
        return saveTrust(this.secrets, this.profileId, this.siteUrl, cookies);
    }
    async readState() {
        return readAutoLoginState(this.metadata);
    }
    async writeState(s: AutoLoginState) {
        writeAutoLoginState(this.metadata, s);
    }
    lock() {
        return this.fileLock.acquire();
    }
}

export interface AutoLoginDeps {
    transport: WebTransport;
    /** Carga el snapshot actual (para ver si otro proceso ya inició sesión mientras se esperaba el candado). */
    loadSnapshot: () => Promise<WebSessionSnapshot | null>;
    /** Backend explícito; si falta, el local con secrets/metadata/profileId/siteUrl. */
    backend?: AutoLoginBackend;
    secrets?: SecretStore;
    metadata?: MetadataStore;
    profileId?: string;
    siteUrl?: string;
    lock?: LoginLock;
    /** Canal para el código (diálogo local). Sin canal, rigen las guardas de «necesita confianza». */
    askCode?: MfaCodePrompt;
    now?: () => Date;
    deadlineMs?: number;
    log?: (event: string, fields: Record<string, unknown>) => void;
}

export class AutoLogin implements WebAutoLogin {
    private inflight: Promise<WebSessionSnapshot> | null = null;
    readonly backend: AutoLoginBackend;
    private readonly now: () => Date;

    constructor(private readonly d: AutoLoginDeps) {
        if (d.backend) this.backend = d.backend;
        else {
            if (!d.secrets || !d.metadata || !d.profileId || !d.siteUrl) throw new Error("AutoLogin: falta el backend o sus datos locales.");
            this.backend = new LocalAutoLoginBackend(d.secrets, d.metadata, d.profileId, d.siteUrl, d.lock);
        }
        this.now = d.now ?? (() => new Date());
    }

    /** Un solo login a la vez en el proceso; las operaciones concurrentes comparten el resultado. */
    login(): Promise<WebSessionSnapshot> {
        this.inflight ??= this.run().finally(() => (this.inflight = null));
        return this.inflight;
    }

    private async run(): Promise<WebSessionSnapshot> {
        const before = await this.d.loadSnapshot();
        const release = await this.backend.lock();
        try {
            // Mientras se esperaba, otro proceso o instancia pudo haber iniciado sesión: se usa esa.
            const current = await this.d.loadSnapshot();
            if (current && current.revision !== before?.revision) return current;
            return await this.attempt();
        } finally {
            await release();
        }
    }

    private async attempt(): Promise<WebSessionSnapshot> {
        const b = this.backend;
        const state = await b.readState();
        const nowMs = this.now().getTime();
        const at = this.now().toISOString();
        if (state.disabled) {
            throw new CampusError("AUTH_REQUIRED", `El login web automático está desactivado (${state.disabled.reason}).`, { humanAction: b.renewHint });
        }
        if (state.inflight) {
            // Un intento anterior quedó sin resultado (la ejecución se cortó): no se sabe si la contraseña
            // llegó a evaluarse. No se adivina: se frena hasta que el humano lo revise.
            const reason = "un intento anterior se cortó sin resultado; no se sabe si el Campus evaluó la contraseña";
            await b.writeState({ ...state, inflight: null, disabled: { at, reason } });
            throw new CampusError("AUTH_REQUIRED", `El login web automático se frenó: ${reason}. Revisá Sesiones del navegador en el Campus y volvé a activarlo.`, { humanAction: b.renewHint });
        }
        const creds = await b.loadLogin();
        if (!creds) throw new CampusError("AUTH_REQUIRED", "No hay contraseña guardada para el login web automático.", { humanAction: b.renewHint });
        const trust = await b.loadTrust();
        if (!this.d.askCode) {
            if (state.needs_trust) {
                throw new CampusError("AUTH_REQUIRED", `El login web automático necesita renovar la confianza del dispositivo (${state.needs_trust.reason}).`, { humanAction: b.renewHint });
            }
            const exp = trustExpiryMs(trust);
            if (exp === null || exp - nowMs < TRUST_MARGIN_MS) {
                // Sin canal para el código, un intento sólo mandaría un correo que nadie puede usar.
                const reason = exp === null ? "no hay confianza del dispositivo guardada" : "la confianza del dispositivo vence o venció";
                await b.writeState({ ...state, needs_trust: { at, reason } });
                throw new CampusError("AUTH_REQUIRED", `El login web automático necesita renovar la confianza del dispositivo (${reason}); no se intentó, para no mandar un correo con un código que nadie puede usar.`, { humanAction: b.renewHint });
            }
        }
        const recent = (state.attempts ?? []).filter((a) => nowMs - Date.parse(a) < 86_400_000);
        const lastAt = state.last ? Date.parse(state.last.at) : null;
        const pause = state.last?.ok ? AUTOLOGIN_MIN_INTERVAL_AFTER_OK_MS : AUTOLOGIN_MIN_INTERVAL_MS;
        if (lastAt !== null && nowMs - lastAt < pause) {
            throw new CampusError("AUTH_REQUIRED", `El login web automático ya se intentó hace menos de ${pause / 60_000} minutos; no se reintenta tan seguido.`, { humanAction: b.renewHint });
        }
        if (recent.length >= AUTOLOGIN_MAX_PER_DAY) {
            throw new CampusError("AUTH_REQUIRED", `El login web automático llegó a ${AUTOLOGIN_MAX_PER_DAY} intentos en 24 h; se frena hasta mañana.`, { humanAction: b.renewHint });
        }
        await b.writeState({ ...state, attempts: [...recent, at], inflight: { at } });
        try {
            const r = await passwordLogin(this.d.transport, { username: creds.username, password: creds.password, remembered: trust, askCode: this.d.askCode, now: this.now, deadlineMs: this.d.deadlineMs });
            await this.d.transport.saveSnapshot(r.snapshot);
            await b.saveTrust(r.remembered);
            const s = await b.readState();
            await b.writeState({
                ...s,
                inflight: null,
                needs_trust: null,
                last: { at, ok: true, mfa: r.mfa },
                trust_expires_at: r.trust_expires_at ?? trustExpiry(r.remembered) ?? s.trust_expires_at ?? null,
            });
            this.d.log?.("web_autologin", { outcome: "ok", mfa: r.mfa });
            return r.snapshot;
        } catch (e) {
            const pe = toPublicError(e);
            const s = await b.readState();
            // Usuario/contraseña o código rechazados: no se vuelve a intentar solo (cada fallo suma al bloqueo).
            const disabled = pe.code === "AUTH_REJECTED" ? { at, reason: e instanceof CampusError ? e.message.slice(0, 200) : "credenciales rechazadas" } : s.disabled ?? null;
            const needsTrust = e instanceof CampusError && e.details?.reason === MFA_CODE_REQUIRED ? { at, reason: "el Campus pidió el código y no había canal" } : s.needs_trust ?? null;
            await b.writeState({ ...s, inflight: null, last: { at, ok: false, code: pe.code }, disabled, needs_trust: needsTrust });
            this.d.log?.("web_autologin", { outcome: "error", code: pe.code, ...(needsTrust && !s.needs_trust ? { needs_trust: true } : {}) });
            throw e;
        }
    }
}

/** Resumen sin secretos para `campus_get_status` y la CLI. */
export async function autoLoginStatus(b: AutoLoginBackend, now: Date = new Date()) {
    const s = await b.readState();
    const trust = await b.loadTrust();
    const exp = trustExpiry(trust) ?? s.trust_expires_at ?? null;
    return {
        configured: (await b.loadLogin()) !== null,
        disabled: s.disabled ?? null,
        needs_trust: s.needs_trust ?? null,
        trust_expires_at: exp,
        trust_days_left: exp ? Math.floor((Date.parse(exp) - now.getTime()) / 86_400_000) : null,
        last: s.last ?? null,
        attempts_last_24h: (s.attempts ?? []).filter((a) => now.getTime() - Date.parse(a) < 86_400_000).length,
    };
}

export async function loadLogin(secrets: SecretStore, profileId: string, siteUrl: string): Promise<StoredLogin | null> {
    return parseStoredLogin(await secrets.get(webLoginAccount(profileId, siteUrl)));
}

/** JSON `{username, password}` validado; la contraseña no se recorta (puede tener espacios). */
export function parseStoredLogin(raw: string | null | undefined): StoredLogin | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<StoredLogin>;
        return typeof v.username === "string" && typeof v.password === "string" && v.username.trim() && v.password ? { username: v.username.trim(), password: v.password } : null;
    } catch {
        return null;
    }
}

export async function saveLogin(secrets: SecretStore, profileId: string, siteUrl: string, l: StoredLogin) {
    await secrets.set(webLoginAccount(profileId, siteUrl), JSON.stringify(l));
}

export async function loadTrust(secrets: SecretStore, profileId: string, siteUrl: string): Promise<WebCookie[]> {
    return parseTrust(await secrets.get(webTrustAccount(profileId, siteUrl)));
}

export function parseTrust(raw: string | null | undefined): WebCookie[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw) as WebCookie[];
        return Array.isArray(v) ? v.filter((c) => c && typeof c.name === "string" && typeof c.value === "string") : [];
    } catch {
        return [];
    }
}

export async function saveTrust(secrets: SecretStore, profileId: string, siteUrl: string, cookies: WebCookie[]) {
    if (cookies.length) await secrets.set(webTrustAccount(profileId, siteUrl), JSON.stringify(cookies));
}

function trustExpiryMs(cookies: WebCookie[]): number | null {
    const t = cookies.find((c) => TRUST_COOKIE.test(c.name));
    return t?.expires ? t.expires * 1000 : null;
}

export function trustExpiry(cookies: WebCookie[]): string | null {
    const ms = trustExpiryMs(cookies);
    return ms ? new Date(ms).toISOString() : null;
}

/** Borra la contraseña, las cookies recordadas y el estado. No cierra sesiones en el Campus. */
export async function forgetAutoLogin(secrets: SecretStore, metadata: MetadataStore, profileId: string, siteUrl: string) {
    await secrets.delete(webLoginAccount(profileId, siteUrl));
    await secrets.delete(webTrustAccount(profileId, siteUrl));
    writeAutoLoginState(metadata, {});
}
