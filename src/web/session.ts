import { createHash } from "node:crypto";
import { CampusError } from "../errors.js";
import type { SecretStore } from "../session/secret-store.js";

/**
 * Sesión web de Moodle (cookies), independiente del token móvil (directiva §5.1).
 * El snapshot se valida antes de guardarse y queda atado al origen, la subruta de la instalación
 * y la identidad esperada. Nunca se imprime ni se loguea.
 */
export interface WebCookie {
    name: string;
    value: string;
    /** Vencimiento en segundos Unix; null = cookie de sesión. */
    expires: number | null;
}

export interface WebSessionSnapshot {
    v: 1;
    origin: string;
    path_prefix: string;
    user_id: number;
    cookies: WebCookie[];
    /** Revisión derivada de los valores (para no pisar una sesión nueva con una vieja). */
    revision: string;
    imported_at: string;
}

/** Sólo cookies de sesión de Moodle: nunca las del proveedor de identidad ni otras del navegador. */
export const MOODLE_COOKIE = /^(MoodleSession\w*|MOODLEID\d*_\w*)$/;

/**
 * Acepta una cabecera Cookie («a=b; c=d») o sólo el valor de MoodleSession. Descarta todo lo que
 * no sea una cookie de sesión de Moodle.
 */
export function parseCookieInput(raw: string): WebCookie[] {
    const text = raw.trim().replace(/^cookie:\s*/i, "");
    if (!text) throw new CampusError("CONFIG_INVALID", "No se recibió ninguna cookie.");
    if (/[\r\n]/.test(text)) throw new CampusError("CONFIG_INVALID", "La cookie debe venir en una sola línea.");
    const out: WebCookie[] = [];
    if (!text.includes("=")) {
        if (!/^[A-Za-z0-9,-]{10,128}$/.test(text)) throw new CampusError("CONFIG_INVALID", "El valor no tiene la forma de una cookie MoodleSession.");
        return [{ name: "MoodleSession", value: text, expires: null }];
    }
    for (const part of text.split(";")) {
        const i = part.indexOf("=");
        if (i <= 0) continue;
        const name = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (!MOODLE_COOKIE.test(name) || !value || !/^[A-Za-z0-9%_.,-]{1,512}$/.test(value)) continue;
        out.push({ name, value, expires: null });
    }
    if (!out.some((c) => c.name.startsWith("MoodleSession"))) {
        throw new CampusError("CONFIG_INVALID", "No se encontró la cookie MoodleSession del Campus.");
    }
    return out;
}

export function revisionOf(cookies: WebCookie[]): string {
    const material = [...cookies].sort((a, b) => a.name.localeCompare(b.name)).map((c) => `${c.name}=${c.value}`).join(";");
    return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

export function encodeSnapshot(s: WebSessionSnapshot): string {
    return Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export function decodeSnapshot(raw: string): WebSessionSnapshot {
    let s: WebSessionSnapshot;
    try {
        s = JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8")) as WebSessionSnapshot;
    } catch {
        throw new CampusError("CONFIG_INVALID", "El snapshot de sesión web no es válido.");
    }
    if (
        !s ||
        s.v !== 1 ||
        typeof s.origin !== "string" ||
        typeof s.path_prefix !== "string" ||
        !Number.isInteger(s.user_id) ||
        !Array.isArray(s.cookies) ||
        !s.cookies.every((c) => typeof c.name === "string" && MOODLE_COOKIE.test(c.name) && typeof c.value === "string")
    ) {
        throw new CampusError("CONFIG_INVALID", "El snapshot de sesión web no tiene el formato esperado.");
    }
    return s;
}

/**
 * De dónde sale el snapshot. Local: keyring. Remoto: el KV de Upstash, sembrado desde la configuración
 * sensible del despliegue (ADR-127); sin KV, sólo esa configuración (de sólo lectura).
 */
export interface WebSessionSource {
    readonly kind: "keyring" | "env" | "kv" | "memory";
    load(): Promise<WebSessionSnapshot | null>;
    /** Guarda una renovación validada. En remoto no es posible: lo explica el error. */
    save(s: WebSessionSnapshot): Promise<void>;
    /**
     * Descarta la sesión rechazada en este contexto. Con `revision`, sólo si la guardada sigue siendo
     * esa: una importada mientras tanto (por ejemplo, mientras corría la tarea de keepalive) se conserva.
     */
    invalidate(revision?: string | null): Promise<void>;
}

export function webSecretAccount(profileId: string, siteUrl: string): string {
    return `${profileId}|${siteUrl}|web_session`;
}

/** Local: el keyring del sistema. Sin keyring, falla con SECRET_STORE_UNAVAILABLE (sin archivo de respaldo). */
export class KeyringWebSessionSource implements WebSessionSource {
    readonly kind = "keyring" as const;
    constructor(
        private readonly secrets: SecretStore,
        private readonly account: string,
    ) {}
    async load() {
        const raw = await this.secrets.get(this.account);
        return raw ? decodeSnapshot(raw) : null;
    }
    async save(s: WebSessionSnapshot) {
        await this.secrets.set(this.account, encodeSnapshot(s));
    }
    async invalidate(revision?: string | null) {
        if (revision) {
            const raw = await this.secrets.get(this.account);
            if (raw && decodeSnapshot(raw).revision !== revision) return;
        }
        await this.secrets.delete(this.account);
    }
}

/** Remoto: snapshot inyectado por configuración sensible. Cada invocación parte de él. */
export class EnvWebSessionSource implements WebSessionSource {
    readonly kind = "env" as const;
    private rejectedRevision: string | null = null;
    constructor(private readonly raw: string | null) {}
    async load() {
        if (!this.raw) return null;
        const s = decodeSnapshot(this.raw);
        // Una revisión ya rechazada en esta instancia no se reintenta como si fuera nueva.
        return s.revision === this.rejectedRevision ? null : s;
    }
    async save(): Promise<void> {
        // Las rotaciones quedan en memoria sólo durante la operación (directiva §5.2).
    }
    async invalidate(revision?: string | null) {
        if (this.raw) this.rejectedRevision = revision ?? decodeSnapshot(this.raw).revision;
    }
}

/** Para tests. */
export class MemoryWebSessionSource implements WebSessionSource {
    readonly kind = "memory" as const;
    constructor(public snapshot: WebSessionSnapshot | null = null) {}
    async load() {
        return this.snapshot;
    }
    async save(s: WebSessionSnapshot) {
        this.snapshot = s;
    }
    async invalidate(revision?: string | null) {
        if (revision && this.snapshot && this.snapshot.revision !== revision) return;
        this.snapshot = null;
    }
}
