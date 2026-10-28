import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CampusError } from "../errors.js";
import { redact } from "../util/redact.js";
import type { StoredPlan } from "./plan.js";

/**
 * Estado de escritura (planes, uso único, interruptor, auditoría y aprobaciones web). Dos backends con
 * las mismas garantías (ADR-044, ADR-060):
 * - FileWriteStore (local): directorio de estado del PERFIL DE ESCRITURA
 *   (`%LOCALAPPDATA%\udesa-campus-mcp\profiles\<perfil>\`): `plans/<id>.json` (0600), `plans/<id>.lock`
 *   (uso único, O_EXCL), `write-state.json` y `write-audit.jsonl` (sólo de agregado).
 * - KvWriteStore (remoto, Vercel): Redis de Upstash por REST. Uso único con `SET NX`.
 * Nada de esto contiene tokens, cookies ni sesskey.
 */

const PLAN_ID = /^pl_[a-z2-7]{16}$/;

export interface WriteSwitchState {
    disabled: boolean;
    changed_at: string | null;
    /** Freno ante fallos (§5.8): 3 resultados sin_efecto o rechazado seguidos pausan las escrituras. */
    paused: boolean;
    paused_at: string | null;
    paused_reason: string | null;
    consecutive_failures: number;
    /** Contadores del día (en la zona del perfil). */
    day: string | null;
    actions_today: number;
    messages_today: number;
}

/** Aprobación fuera de banda por la página web (W5): atada al hash del plan que vio el humano. */
export interface WebApproval {
    plan_hash: string;
    decision: "approved" | "rejected";
    by: string;
    at: string;
}

export const EMPTY_STATE: WriteSwitchState = {
    disabled: false,
    changed_at: null,
    paused: false,
    paused_at: null,
    paused_reason: null,
    consecutive_failures: 0,
    day: null,
    actions_today: 0,
    messages_today: 0,
};

export interface WriteStore {
    /** Dónde vive el estado (para mensajes y auditoría). */
    readonly location: string;
    createPlan(sp: StoredPlan): Promise<void>;
    loadPlan(planId: string): Promise<StoredPlan | null>;
    /** Reescribe sólo el estado (el contenido firmado no cambia). */
    savePlanState(planId: string, state: StoredPlan["state"]): Promise<void>;
    /** Marca de uso único: true sólo para el primero que la toma, aun entre procesos o instancias. */
    claim(planId: string, at: string): Promise<boolean>;
    /** Libera la marca cuando se abortó ANTES de emitir cualquier escritura. */
    release(planId: string): Promise<void>;
    isClaimed(planId: string): Promise<boolean>;
    listPlans(): Promise<StoredPlan[]>;
    readState(): Promise<WriteSwitchState>;
    writeState(s: WriteSwitchState): Promise<void>;
    audit(event: Record<string, unknown>): Promise<void>;
    readAudit(): Promise<Record<string, unknown>[]>;
    saveApproval(planId: string, a: WebApproval): Promise<boolean>;
    loadApproval(planId: string): Promise<WebApproval | null>;
    /** Bytes de un archivo entregado por el cliente (ChatGPT), por su sha256, con vencimiento. */
    putBlob(sha256: string, data: Buffer, ttlSeconds: number): Promise<void>;
    /** null si no existe o ya venció. */
    getBlob(sha256: string): Promise<Buffer | null>;
}

function checkId(planId: string) {
    if (!PLAN_ID.test(planId)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "Identificador de plan inválido.");
}

const SHA256 = /^[0-9a-f]{64}$/;

function checkSha(sha256: string) {
    if (!SHA256.test(sha256)) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "Identificador de archivo inválido.");
}

function parseAuditLines(lines: string[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
            out.push({ event: "linea_ilegible" });
        }
    }
    return out;
}

// ---------- archivos (local) ----------

export class FileWriteStore implements WriteStore {
    readonly plansDir: string;
    readonly auditFile: string;
    private readonly stateFile: string;

    constructor(readonly location: string) {
        this.plansDir = join(location, "plans");
        this.auditFile = join(location, "write-audit.jsonl");
        this.stateFile = join(location, "write-state.json");
    }

    private planPath(planId: string, ext: "json" | "lock" | "approval.json") {
        checkId(planId);
        return join(this.plansDir, `${planId}.${ext}`);
    }

    private writeAtomic(target: string, data: string) {
        mkdirSync(join(target, ".."), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        writeFileSync(tmp, data, { mode: 0o600 });
        renameSync(tmp, target);
    }

    async createPlan(sp: StoredPlan): Promise<void> {
        const path = this.planPath(sp.plan.plan_id, "json");
        mkdirSync(this.plansDir, { recursive: true });
        // wx: nunca se pisa un plan existente.
        writeFileSync(path, JSON.stringify(sp, null, 2), { mode: 0o600, flag: "wx" });
    }

    async loadPlan(planId: string): Promise<StoredPlan | null> {
        try {
            return JSON.parse(readFileSync(this.planPath(planId, "json"), "utf8")) as StoredPlan;
        } catch (e) {
            if (e instanceof CampusError) throw e;
            return null;
        }
    }

    async savePlanState(planId: string, state: StoredPlan["state"]): Promise<void> {
        const sp = await this.loadPlan(planId);
        if (!sp) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "El plan no existe.");
        this.writeAtomic(this.planPath(planId, "json"), JSON.stringify({ ...sp, state }, null, 2));
    }

    async claim(planId: string, at: string): Promise<boolean> {
        mkdirSync(this.plansDir, { recursive: true });
        try {
            const fd = openSync(this.planPath(planId, "lock"), "wx", 0o600);
            writeFileSync(fd, at);
            closeSync(fd);
            return true;
        } catch (e) {
            if (e instanceof CampusError) throw e;
            return false;
        }
    }

    async release(planId: string): Promise<void> {
        rmSync(this.planPath(planId, "lock"), { force: true });
    }

    async isClaimed(planId: string): Promise<boolean> {
        return existsSync(this.planPath(planId, "lock"));
    }

    async listPlans(): Promise<StoredPlan[]> {
        let names: string[];
        try {
            names = readdirSync(this.plansDir);
        } catch {
            return [];
        }
        const out: StoredPlan[] = [];
        for (const n of names) {
            const m = /^(pl_[a-z2-7]{16})\.json$/.exec(n);
            if (!m) continue;
            const sp = await this.loadPlan(m[1]!);
            if (sp) out.push(sp);
        }
        return out.sort((a, b) => a.plan.created_at.localeCompare(b.plan.created_at));
    }

    async readState(): Promise<WriteSwitchState> {
        try {
            return { ...EMPTY_STATE, ...(JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<WriteSwitchState>) };
        } catch {
            return { ...EMPTY_STATE };
        }
    }

    async writeState(s: WriteSwitchState): Promise<void> {
        this.writeAtomic(this.stateFile, JSON.stringify(s, null, 2));
    }

    /** La red de seguridad `redact` corre igual, aunque nada sensible debería llegar acá. */
    async audit(event: Record<string, unknown>): Promise<void> {
        mkdirSync(this.location, { recursive: true });
        appendFileSync(this.auditFile, redact(JSON.stringify(event)) + "\n", { mode: 0o600 });
    }

    async readAudit(): Promise<Record<string, unknown>[]> {
        try {
            return parseAuditLines(readFileSync(this.auditFile, "utf8").split("\n"));
        } catch {
            return [];
        }
    }

    async saveApproval(planId: string, a: WebApproval): Promise<boolean> {
        mkdirSync(this.plansDir, { recursive: true });
        try {
            writeFileSync(this.planPath(planId, "approval.json"), JSON.stringify(a), { mode: 0o600, flag: "wx" });
            return true;
        } catch (e) {
            if (e instanceof CampusError) throw e;
            return false;
        }
    }

    async loadApproval(planId: string): Promise<WebApproval | null> {
        try {
            return JSON.parse(readFileSync(this.planPath(planId, "approval.json"), "utf8")) as WebApproval;
        } catch (e) {
            if (e instanceof CampusError) throw e;
            return null;
        }
    }

    /** `blobs/<sha256>.bin`, con el vencimiento en `blobs/<sha256>.exp`. Los vencidos se borran al leerlos. */
    async putBlob(sha256: string, data: Buffer, ttlSeconds: number): Promise<void> {
        checkSha(sha256);
        const dir = join(this.location, "blobs");
        this.writeAtomic(join(dir, `${sha256}.bin`), data.toString("base64"));
        this.writeAtomic(join(dir, `${sha256}.exp`), String(Date.now() + ttlSeconds * 1000));
    }

    async getBlob(sha256: string): Promise<Buffer | null> {
        checkSha(sha256);
        const dir = join(this.location, "blobs");
        try {
            if (Number(readFileSync(join(dir, `${sha256}.exp`), "utf8")) < Date.now()) {
                rmSync(join(dir, `${sha256}.bin`), { force: true });
                rmSync(join(dir, `${sha256}.exp`), { force: true });
                return null;
            }
            return Buffer.from(readFileSync(join(dir, `${sha256}.bin`), "utf8"), "base64");
        } catch {
            return null;
        }
    }
}

// ---------- KV (remoto) ----------

/** Un comando de Redis. Upstash lo expone por REST; los tests usan MemoryKv. */
export interface KvClient {
    cmd(args: (string | number)[]): Promise<unknown>;
}

/** Cliente REST de Upstash (sin dependencias): POST con el comando como arreglo JSON. */
export class UpstashKv implements KvClient {
    constructor(
        private readonly url: string,
        private readonly token: string,
        private readonly fetchImpl: typeof fetch = (i, init) => fetch(i, init),
    ) {}

    async cmd(args: (string | number)[]): Promise<unknown> {
        let res: Response;
        try {
            res = await this.fetchImpl(this.url, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(10_000) });
        } catch {
            throw new CampusError("SERVICE_UNAVAILABLE", "No se pudo hablar con el almacén de escrituras (KV).");
        }
        const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
        if (!res.ok || !body || body.error) throw new CampusError("SERVICE_UNAVAILABLE", `El almacén de escrituras (KV) respondió con error${res.ok ? "" : ` HTTP ${res.status}`}.`);
        return body.result ?? null;
    }
}

/** Redis mínimo en memoria con la semántica que usa KvWriteStore (tests). */
export class MemoryKv implements KvClient {
    readonly data = new Map<string, string | string[] | Map<string, number>>();
    readonly ttl = new Map<string, number>();
    commands: string[] = [];

    async cmd(args: (string | number)[]): Promise<unknown> {
        const [op, key, ...rest] = args.map(String) as [string, string, ...string[]];
        this.commands.push(op);
        switch (op.toUpperCase()) {
            case "SET": {
                const nx = rest.includes("NX");
                if (nx && this.data.has(key)) return null;
                this.data.set(key, rest[0]!);
                const ex = rest.indexOf("EX");
                if (ex >= 0) this.ttl.set(key, Number(rest[ex + 1]));
                return "OK";
            }
            case "GET":
                return typeof this.data.get(key) === "string" ? this.data.get(key) : null;
            case "MGET":
                return [key, ...rest].map((k) => (typeof this.data.get(k) === "string" ? this.data.get(k) : null));
            case "DEL":
                return this.data.delete(key) ? 1 : 0;
            case "EXISTS":
                return this.data.has(key) ? 1 : 0;
            case "RPUSH": {
                const l = (this.data.get(key) as string[] | undefined) ?? [];
                l.push(...rest);
                this.data.set(key, l);
                return l.length;
            }
            case "LRANGE": {
                const l = (this.data.get(key) as string[] | undefined) ?? [];
                const end = Number(rest[1]);
                return l.slice(Number(rest[0]), end < 0 ? l.length + end + 1 : end + 1);
            }
            case "LTRIM": {
                const l = (this.data.get(key) as string[] | undefined) ?? [];
                const start = Number(rest[0]);
                this.data.set(key, l.slice(start < 0 ? Math.max(0, l.length + start) : start));
                return "OK";
            }
            case "ZADD": {
                const z = (this.data.get(key) as Map<string, number> | undefined) ?? new Map<string, number>();
                z.set(rest[1]!, Number(rest[0]));
                this.data.set(key, z);
                return 1;
            }
            case "ZRANGE": {
                const z = (this.data.get(key) as Map<string, number> | undefined) ?? new Map<string, number>();
                const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
                const end = Number(rest[1]);
                return sorted.slice(Number(rest[0]), end < 0 ? sorted.length + end + 1 : end + 1);
            }
            case "EXPIRE":
                this.ttl.set(key, Number(rest[0]));
                return 1;
            default:
                throw new Error(`MemoryKv: comando ${op} no implementado`);
        }
    }
}

const PLAN_TTL_S = 30 * 86_400;
/** 4 MB por trozo: en base64, unos 5,4 MB por pedido al KV. */
export const BLOB_CHUNK_BYTES = 4 * 1024 * 1024;
const APPROVAL_TTL_S = 3_600;
const AUDIT_MAX = 20_000;
const LIST_MAX = 500;

export class KvWriteStore implements WriteStore {
    readonly location: string;

    constructor(
        private readonly kv: KvClient,
        private readonly prefix: string,
    ) {
        this.location = `kv:${prefix}`;
    }

    private k(...parts: string[]) {
        return [this.prefix, ...parts].join(":");
    }

    async createPlan(sp: StoredPlan): Promise<void> {
        checkId(sp.plan.plan_id);
        const ok = await this.kv.cmd(["SET", this.k("plan", sp.plan.plan_id), JSON.stringify(sp), "NX", "EX", PLAN_TTL_S]);
        if (ok !== "OK") throw new CampusError("PLAN_ALREADY_EXECUTED", "Ya existe un plan con ese identificador.");
        await this.kv.cmd(["ZADD", this.k("plans"), Date.parse(sp.plan.created_at), sp.plan.plan_id]);
    }

    async loadPlan(planId: string): Promise<StoredPlan | null> {
        checkId(planId);
        const raw = await this.kv.cmd(["GET", this.k("plan", planId)]);
        return typeof raw === "string" ? (JSON.parse(raw) as StoredPlan) : null;
    }

    async savePlanState(planId: string, state: StoredPlan["state"]): Promise<void> {
        const sp = await this.loadPlan(planId);
        if (!sp) throw new CampusError("RESOURCE_OUT_OF_SCOPE", "El plan no existe.");
        await this.kv.cmd(["SET", this.k("plan", planId), JSON.stringify({ ...sp, state }), "EX", PLAN_TTL_S]);
    }

    async claim(planId: string, at: string): Promise<boolean> {
        checkId(planId);
        return (await this.kv.cmd(["SET", this.k("claim", planId), at, "NX", "EX", PLAN_TTL_S])) === "OK";
    }

    async release(planId: string): Promise<void> {
        checkId(planId);
        await this.kv.cmd(["DEL", this.k("claim", planId)]);
    }

    async isClaimed(planId: string): Promise<boolean> {
        checkId(planId);
        return Number(await this.kv.cmd(["EXISTS", this.k("claim", planId)])) > 0;
    }

    async listPlans(): Promise<StoredPlan[]> {
        const ids = (await this.kv.cmd(["ZRANGE", this.k("plans"), -LIST_MAX, -1])) as string[] | null;
        if (!ids?.length) return [];
        const raws = (await this.kv.cmd(["MGET", ...ids.map((id) => this.k("plan", id))])) as (string | null)[];
        return raws.filter((r): r is string => typeof r === "string").map((r) => JSON.parse(r) as StoredPlan);
    }

    async readState(): Promise<WriteSwitchState> {
        const raw = await this.kv.cmd(["GET", this.k("state")]);
        return typeof raw === "string" ? { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<WriteSwitchState>) } : { ...EMPTY_STATE };
    }

    async writeState(s: WriteSwitchState): Promise<void> {
        await this.kv.cmd(["SET", this.k("state"), JSON.stringify(s)]);
    }

    async audit(event: Record<string, unknown>): Promise<void> {
        await this.kv.cmd(["RPUSH", this.k("audit"), redact(JSON.stringify(event))]);
        await this.kv.cmd(["LTRIM", this.k("audit"), -AUDIT_MAX, -1]);
    }

    async readAudit(): Promise<Record<string, unknown>[]> {
        return parseAuditLines(((await this.kv.cmd(["LRANGE", this.k("audit"), 0, -1])) as string[] | null) ?? []);
    }

    async saveApproval(planId: string, a: WebApproval): Promise<boolean> {
        checkId(planId);
        return (await this.kv.cmd(["SET", this.k("approval", planId), JSON.stringify(a), "NX", "EX", APPROVAL_TTL_S])) === "OK";
    }

    async loadApproval(planId: string): Promise<WebApproval | null> {
        checkId(planId);
        const raw = await this.kv.cmd(["GET", this.k("approval", planId)]);
        return typeof raw === "string" ? (JSON.parse(raw) as WebApproval) : null;
    }

    /**
     * En trozos de BLOB_CHUNK_BYTES (Upstash admite 10 MB por pedido y el archivo viaja en base64). La
     * cantidad de trozos se escribe al final: sin ella, el archivo no existe.
     */
    async putBlob(sha256: string, data: Buffer, ttlSeconds: number): Promise<void> {
        checkSha(sha256);
        const n = Math.max(1, Math.ceil(data.length / BLOB_CHUNK_BYTES));
        for (let i = 0; i < n; i++) {
            await this.kv.cmd(["SET", this.k("blob", sha256, String(i)), data.subarray(i * BLOB_CHUNK_BYTES, (i + 1) * BLOB_CHUNK_BYTES).toString("base64"), "EX", ttlSeconds]);
        }
        await this.kv.cmd(["SET", this.k("blob", sha256), String(n), "EX", ttlSeconds]);
    }

    async getBlob(sha256: string): Promise<Buffer | null> {
        checkSha(sha256);
        const n = Number(await this.kv.cmd(["GET", this.k("blob", sha256)]));
        if (!Number.isInteger(n) || n < 1) return null;
        const parts: Buffer[] = [];
        for (let i = 0; i < n; i++) {
            const raw = await this.kv.cmd(["GET", this.k("blob", sha256, String(i))]);
            if (typeof raw !== "string") return null;
            parts.push(Buffer.from(raw, "base64"));
        }
        return Buffer.concat(parts);
    }
}
