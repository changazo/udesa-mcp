import { createHash } from "node:crypto";
import { CampusError } from "../errors.js";
import { CAD_SCRIPT, CAS_SCRIPT, type KvClient } from "../write/store.js";
import type { ConnectionReason, DiagnosticReport, RenewalState } from "./connection-contracts.js";

/**
 * Registro autoritativo v2 de la conexión web remota (ADR-141): UNA clave por conexión (sitio, cuenta
 * Moodle esperada y familia del perfil de lectura), actualizada por compare-and-set con un script de Redis.
 * Sesión activa, confianza, generación y recibo de publicación cambian juntos. Las continuaciones del MFA y
 * las candidatas validadas van en claves aparte con vencimiento corto; el registro no tiene TTL (perderlo
 * borraría guardas e intentos).
 */

export interface ActiveConnection {
    session_sealed: string | null;
    trust_sealed: string | null;
    session_revision: string | null;
    trust_expires_at: string | null;
    published_at: string;
    renewal_id: string;
}

export interface PendingTransition {
    renewal_id: string;
    state: RenewalState;
    started_at: string;
    /** Vida del desafío (MCP, no de Moodle): no se extiende por recargas. */
    expires_at: string;
    /** Reclamo operativo de una transición que envía credenciales (starting/submitting). */
    claim_until: string | null;
    /** HMAC del vínculo con el navegador que inició el desafío. */
    browser_hash: string;
    config_epoch: number;
    auth_generation: number;
    reason: ConnectionReason | null;
    trust_expires_at: string | null;
}

export interface ConnectionRecord {
    schema_version: 2;
    config_epoch: number;
    config_fingerprint: string;
    auth_generation: number;
    active: ActiveConnection | null;
    control: {
        /** Intentos de login (ISO) de las últimas 24 h, panel y autologin juntos. */
        attempts: string[];
        last: { at: string; ok: boolean; source: "panel" | "autologin" | "recovery"; code?: string } | null;
        disabled: { at: string; reason: ConnectionReason } | null;
        needs_trust: { at: string; reason: ConnectionReason } | null;
        pending: PendingTransition | null;
        /** Intento del autologin en curso (antes de enviar la contraseña). */
        inflight: { at: string } | null;
        rejected_revisions: string[];
    };
    receipts: { renewal_id: string; auth_generation: number; at: string; state: "committed" }[];
    last_diagnostic: DiagnosticReport | null;
    activation: { epoch: number; state: "pending" | "rejected"; at: string; reason: string | null } | null;
}

export const RECEIPT_WINDOW_MS = 24 * 3_600_000;
const CAS_ATTEMPTS = 25;

/** Identificador de la conexión: sitio + cuenta esperada + perfil de lectura, nunca el endpoint MCP. */
export function connectionKey(siteUrl: string, expectedUserId: number, profileId: string): string {
    const site = createHash("sha256").update(siteUrl.replace(/\/+$/, "")).digest("hex").slice(0, 12);
    return `conn2:${profileId}:${expectedUserId}:${site}`;
}

export function emptyRecord(epoch: number, fingerprint: string): ConnectionRecord {
    return {
        schema_version: 2,
        config_epoch: epoch,
        config_fingerprint: fingerprint,
        auth_generation: 0,
        active: null,
        control: { attempts: [], last: null, disabled: null, needs_trust: null, pending: null, inflight: null, rejected_revisions: [] },
        receipts: [],
        last_diagnostic: null,
        activation: null,
    };
}

function parseRecord(raw: string): ConnectionRecord {
    let v: ConnectionRecord;
    try {
        v = JSON.parse(raw) as ConnectionRecord;
    } catch {
        throw new CampusError("SERVICE_UNAVAILABLE", "El registro de la conexión web está dañado: no se usa ni se reemplaza solo.", { details: { reason: "kv_unavailable" } });
    }
    if (!v || typeof v !== "object") throw new CampusError("SERVICE_UNAVAILABLE", "El registro de la conexión web está dañado.", { details: { reason: "kv_unavailable" } });
    if (v.schema_version !== 2) throw new CampusError("SERVICE_UNAVAILABLE", `El registro de la conexión web tiene una versión no soportada (${String(v.schema_version)}).`, { details: { reason: "config_conflict" } });
    if (!Number.isInteger(v.config_epoch) || !Number.isInteger(v.auth_generation) || !v.control || !Array.isArray(v.receipts)) {
        throw new CampusError("SERVICE_UNAVAILABLE", "El registro de la conexión web no tiene el formato esperado.", { details: { reason: "kv_unavailable" } });
    }
    return v;
}

export class ConnectionStore {
    constructor(
        private readonly kv: KvClient,
        readonly key: string,
    ) {}

    /** null = no existe. Dañado o versión desconocida = error (nunca «vacío»). KV caído = error. */
    async read(): Promise<ConnectionRecord | null> {
        const raw = await this.kv.cmd(["GET", this.key]);
        return typeof raw === "string" ? parseRecord(raw) : null;
    }

    /**
     * Transición atómica: `fn` recibe el registro actual (o null) y devuelve el siguiente, o null para no
     * cambiar nada. Se reintenta acotadamente si otra instancia cambió el registro; `fn` tiene que ser pura
     * (nunca un POST a Moodle adentro).
     */
    async update(fn: (r: ConnectionRecord | null) => ConnectionRecord | null): Promise<{ before: ConnectionRecord | null; after: ConnectionRecord | null; changed: boolean }> {
        for (let i = 0; i < CAS_ATTEMPTS; i++) {
            const raw = await this.kv.cmd(["GET", this.key]);
            const before = typeof raw === "string" ? parseRecord(raw) : null;
            const next = fn(before);
            if (!next) return { before, after: before, changed: false };
            const ok = await this.kv.cmd(["EVAL", CAS_SCRIPT, 1, this.key, typeof raw === "string" ? raw : "", JSON.stringify(next)]);
            if (Number(ok) === 1) return { before, after: next, changed: true };
            await new Promise((r) => setTimeout(r, Math.random() * 8 * (i + 1)));
        }
        throw new CampusError("SERVICE_UNAVAILABLE", "El registro de la conexión web cambia demasiado seguido: no se pudo actualizar.", { details: { reason: "kv_unavailable" } });
    }

    private side(kind: "challenge" | "candidate" | "once" | "autolock", id: string) {
        return `${this.key}:${kind}:${id}`;
    }

    async putSide(kind: "challenge" | "candidate", id: string, sealed: string, ttlSeconds: number) {
        await this.kv.cmd(["SET", this.side(kind, id), sealed, "EX", ttlSeconds]);
    }

    async getSide(kind: "challenge" | "candidate", id: string): Promise<string | null> {
        const raw = await this.kv.cmd(["GET", this.side(kind, id)]);
        return typeof raw === "string" ? raw : null;
    }

    async delSide(kind: "challenge" | "candidate", id: string) {
        await this.kv.cmd(["DEL", this.side(kind, id)]);
    }

    /** Marca de un solo uso (formularios del panel): true sólo la primera vez. */
    async consumeOnce(id: string, ttlSeconds: number): Promise<boolean> {
        if (!/^[A-Za-z0-9_.-]{8,128}$/.test(id)) return false;
        return (await this.kv.cmd(["SET", this.side("once", id), "1", "NX", "EX", ttlSeconds])) === "OK";
    }

    /** Candado corto entre instancias (autologin), con liberación atómica sólo por su dueño. */
    async lease(token: string, ttlSeconds: number): Promise<boolean> {
        return (await this.kv.cmd(["SET", this.side("autolock", "login"), token, "NX", "EX", ttlSeconds])) === "OK";
    }

    async releaseLease(token: string) {
        await this.kv.cmd(["EVAL", CAD_SCRIPT, 1, this.side("autolock", "login"), token]);
    }
}
