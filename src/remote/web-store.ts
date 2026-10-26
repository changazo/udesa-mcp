import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { CampusError } from "../errors.js";
import { parseStoredLogin, parseTrust, type AutoLoginBackend, type AutoLoginState, type StoredLogin } from "../web/autologin.js";
import type { WebAutoLogin } from "../web/transport.js";
import { decodeSnapshot, encodeSnapshot, type WebCookie, type WebSessionSnapshot, type WebSessionSource } from "../web/session.js";
import type { KvClient } from "../write/store.js";

/**
 * Sesión web y login automático del servidor remoto en el KV de Upstash (ADR-127).
 *
 * - La sesión, la confianza del dispositivo y el estado del login viven en el KV, para que una
 *   rotación o un login de una instancia le sirva a las siguientes (antes, cada invocación partía
 *   del snapshot fijo de CAMPUS_WEB_SESSION y la rotación se perdía).
 * - Sesión y confianza van cifradas (AES-256-GCM) con una clave derivada de OAUTH_SIGNING_SECRET:
 *   el KV nunca guarda cookies en claro. El estado no tiene secretos.
 * - Lo que se publica desde la PC (CAMPUS_WEB_SESSION, CAMPUS_WEB_TRUST, CAMPUS_WEB_LOGIN) es la
 *   semilla: cada registro del KV recuerda de qué semilla salió, y una semilla nueva (un `enable` o
 *   un `push-web-session` + deploy) gana sobre lo guardado.
 * - La contraseña nunca entra al KV: vive sólo en la variable sensible CAMPUS_WEB_LOGIN.
 */

const LOCK_TTL_S = 90;
/** Espera del candado: entra con margen en una función de 60 s junto con el login (25 s). */
const LOCK_WAIT_MS = 30_000;
const REJECTED_TTL_S = 30 * 86_400;

/** Cifrado autenticado con una clave propia para el KV (derivada; no reusa la de firma). */
export class KvSecretBox {
    private readonly key: Buffer;
    constructor(signingSecret: Uint8Array) {
        this.key = createHmac("sha256", Buffer.from(signingSecret)).update("udesa-campus-mcp:web-kv:v1").digest();
    }
    seal(plain: string): string {
        const iv = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", this.key, iv);
        const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
        return `v1.${iv.toString("base64url")}.${body.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
    }
    /**
     * Huella corta de una semilla, para saber si lo del KV salió de la semilla vigente. Con clave (HMAC):
     * sin OAUTH_SIGNING_SECRET no sirve para probar contraseñas contra ella.
     */
    fingerprint(raw: string | null | undefined): string {
        return raw ? createHmac("sha256", this.key).update(`seed:v1\n${raw}`).digest("hex").slice(0, 16) : "none";
    }
    open(sealed: string): string | null {
        const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]+)$/.exec(sealed);
        if (!m) return null;
        try {
            const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(m[1]!, "base64url"));
            d.setAuthTag(Buffer.from(m[3]!, "base64url"));
            return Buffer.concat([d.update(Buffer.from(m[2]!, "base64url")), d.final()]).toString("utf8");
        } catch {
            return null;
        }
    }
}

interface SealedRecord {
    seed: string;
    sealed: string;
}

async function getJson<T>(kv: KvClient, key: string): Promise<T | null> {
    const raw = await kv.cmd(["GET", key]);
    if (typeof raw !== "string") return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export function webKvPrefix(profileId: string) {
    return `web:${profileId}`;
}

/**
 * Sesión web remota en el KV. `load` usa la del KV si salió de la semilla vigente; si no, la semilla
 * (CAMPUS_WEB_SESSION), salvo que esa revisión ya haya sido rechazada.
 */
export class KvWebSessionSource implements WebSessionSource {
    readonly kind = "kv" as const;
    private readonly seed: string;
    constructor(
        private readonly kv: KvClient,
        private readonly box: KvSecretBox,
        private readonly prefix: string,
        private readonly seedRaw: string | null,
    ) {
        this.seed = box.fingerprint(seedRaw);
    }
    private get key() {
        return `${this.prefix}:session`;
    }
    private rejectedKey(revision: string) {
        return `${this.prefix}:rejected:${revision}`;
    }
    async load(): Promise<WebSessionSnapshot | null> {
        const rec = await getJson<SealedRecord>(this.kv, this.key);
        if (rec && rec.seed === this.seed) {
            const plain = this.box.open(rec.sealed);
            if (plain) return decodeSnapshot(plain);
        }
        if (!this.seedRaw) return null;
        const s = decodeSnapshot(this.seedRaw);
        // Una semilla ya rechazada no se reintenta como si fuera nueva (sin login, sería AUTH_REQUIRED igual).
        if ((await this.kv.cmd(["EXISTS", this.rejectedKey(s.revision)])) === 1) return null;
        return s;
    }
    async save(s: WebSessionSnapshot): Promise<void> {
        const rec: SealedRecord = { seed: this.seed, sealed: this.box.seal(encodeSnapshot(s)) };
        await this.kv.cmd(["SET", this.key, JSON.stringify(rec)]);
    }
    async invalidate(revision?: string | null): Promise<void> {
        const current = await this.load().catch(() => null);
        if (revision && current && current.revision !== revision) return;
        const rev = revision ?? current?.revision ?? null;
        if (rev) await this.kv.cmd(["SET", this.rejectedKey(rev), "1", "EX", REJECTED_TTL_S]);
        await this.kv.cmd(["DEL", this.key]);
    }
}

export interface RemoteAutoLoginConfig {
    /** CAMPUS_WEB_LOGIN: JSON {username, password}. Sólo en memoria del proceso; nunca al KV. */
    login: string;
    /** CAMPUS_WEB_TRUST: JSON de cookies recordadas (MOODLEID1_ y MFA_TOKEN_<userid>) del dispositivo «remoto». */
    trust: string | null;
}

/**
 * Backend remoto del login automático: contraseña desde la variable sensible, confianza y estado
 * en el KV (la confianza, cifrada), candado con SET NX EX en el KV (entre instancias de Vercel).
 */
export class KvAutoLoginBackend implements AutoLoginBackend {
    readonly renewHint: string;
    private readonly seed: string;
    constructor(
        private readonly kv: KvClient,
        private readonly box: KvSecretBox,
        private readonly prefix: string,
        private readonly cfg: RemoteAutoLoginConfig,
        profileId: string,
    ) {
        // Un `enable` nuevo (contraseña o confianza distintas) arranca con estado y confianza limpios.
        this.seed = box.fingerprint(`${cfg.login}\n${cfg.trust ?? ""}`);
        this.renewHint = `En tu PC: campus remote autologin enable --profile ${profileId} (te pide el código del correo) y después vercel deploy --prod.`;
    }
    async loadLogin(): Promise<StoredLogin | null> {
        return parseStoredLogin(this.cfg.login);
    }
    async loadTrust(): Promise<WebCookie[]> {
        const rec = await getJson<SealedRecord>(this.kv, `${this.prefix}:trust`);
        if (rec && rec.seed === this.seed) {
            const plain = this.box.open(rec.sealed);
            if (plain) return parseTrust(plain);
        }
        return parseTrust(this.cfg.trust);
    }
    async saveTrust(cookies: WebCookie[]): Promise<void> {
        if (!cookies.length) return;
        const rec: SealedRecord = { seed: this.seed, sealed: this.box.seal(JSON.stringify(cookies)) };
        await this.kv.cmd(["SET", `${this.prefix}:trust`, JSON.stringify(rec)]);
    }
    async readState(): Promise<AutoLoginState> {
        const rec = await getJson<{ seed: string; state: AutoLoginState }>(this.kv, `${this.prefix}:autologin`);
        return rec && rec.seed === this.seed ? rec.state : {};
    }
    async writeState(s: AutoLoginState): Promise<void> {
        await this.kv.cmd(["SET", `${this.prefix}:autologin`, JSON.stringify({ seed: this.seed, state: s })]);
    }
    async lock(): Promise<() => Promise<void>> {
        const key = `${this.prefix}:lock`;
        // Reloj real (no el inyectable): mide esperas y abandono del candado, no fechas del dominio.
        const token = `${randomBytes(9).toString("base64url")}.${Date.now()}`;
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            if ((await this.kv.cmd(["SET", key, token, "NX", "EX", LOCK_TTL_S])) === "OK") {
                return async () => {
                    // Sólo lo libera quien lo tomó (otro pudo haberlo tomado si este venció).
                    if ((await this.kv.cmd(["GET", key])) === token) await this.kv.cmd(["DEL", key]);
                };
            }
            // Candado abandonado (instancia cortada): el EX lo vence en Redis; este control cubre al KV sin vencimiento.
            const held = await this.kv.cmd(["GET", key]);
            const since = typeof held === "string" ? Number(held.split(".")[1]) : NaN;
            if (Number.isFinite(since) && Date.now() - since > LOCK_TTL_S * 1000) await this.kv.cmd(["DEL", key]);
            else if (Date.now() > deadline) throw new CampusError("AUTH_REQUIRED", "Otra instancia del servidor está iniciando sesión en el Campus; probá de nuevo en un minuto.");
            else await new Promise((r) => setTimeout(r, 500));
        }
    }
}

/**
 * El login comparte la lógica con el local, cuyos mensajes nombran los comandos locales
 * (`auth web autologin …`). En el remoto se reescriben para indicar qué hacer desde la PC.
 */
export class RemoteAutoLogin implements WebAutoLogin {
    constructor(
        private readonly inner: WebAutoLogin,
        private readonly renewHint: string,
    ) {}
    async login() {
        try {
            return await this.inner.login();
        } catch (e) {
            if (!(e instanceof CampusError)) throw e;
            const message = e.message
                .replace(/(campus )?auth web autologin enable/g, "campus remote autologin enable (en tu PC) y vercel deploy --prod")
                .replace(/(campus )?auth web autologin status/g, "campus_get_status");
            throw new CampusError(e.code, message, { humanAction: this.renewHint, moodleErrorcode: e.moodleErrorcode, details: e.details });
        }
    }
}

