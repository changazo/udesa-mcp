import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CampusError } from "../errors.js";
import { MemoryKv, type KvClient } from "../write/store.js";

/**
 * Almacén de la conexión web del MCP local (ADR-142): el mismo subconjunto de Redis que usa el registro
 * v2 del remoto (GET, SET con NX/EX, DEL, EXISTS, comparar-y-escribir y comparar-y-borrar), sobre UN
 * archivo JSON en el directorio del perfil.
 *
 * - Cada comando toma un candado de archivo exclusivo: varios procesos MCP locales (serve, serve-full,
 *   otros clientes, la CLI) ven una sola historia y el CAS funciona entre ellos.
 * - La escritura es atómica: archivo temporal + renombrado. Un corte deja el archivo anterior entero.
 * - Archivo dañado ≠ vacío: se informa (kv_unavailable) y nunca se pisa solo.
 * - El contenido sensible (sesión, confianza) llega ya cifrado por el servicio; acá no hay secretos en claro.
 */

export const LOCAL_KV_FILE = "web-connection.json";
const LOCK_SUFFIX = ".lock";
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 10_000;
const MUTATING = new Set(["SET", "DEL", "EVAL", "EXPIRE"]);

interface FileShape {
    v: 1;
    entries: Record<string, { value: string; expires_at: number | null }>;
}

export class FileKv implements KvClient {
    readonly path: string;
    private readonly lockPath: string;
    /** Reloj de los vencimientos (tests). */
    clock: () => number = () => Date.now();

    constructor(
        private readonly dir: string,
        file = LOCAL_KV_FILE,
    ) {
        this.path = join(dir, file);
        this.lockPath = `${this.path}${LOCK_SUFFIX}`;
    }

    async cmd(args: (string | number)[]): Promise<unknown> {
        const release = await this.lock();
        try {
            const mem = this.load();
            const result = await mem.cmd(args);
            if (MUTATING.has(String(args[0]).toUpperCase())) this.save(mem);
            return result;
        } finally {
            release();
        }
    }

    private load(): MemoryKv {
        const mem = new MemoryKv();
        mem.clock = this.clock;
        if (!existsSync(this.path)) return mem;
        let shape: FileShape;
        try {
            shape = JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
            if (!shape || shape.v !== 1 || typeof shape.entries !== "object") throw new Error("formato");
        } catch {
            throw new CampusError("SERVICE_UNAVAILABLE", `El archivo de la conexión web de esta PC (${this.path}) está dañado: no se usa ni se reemplaza solo.`, { details: { reason: "kv_unavailable" } });
        }
        const now = this.clock();
        for (const [k, e] of Object.entries(shape.entries)) {
            if (!e || typeof e.value !== "string") continue;
            if (e.expires_at !== null && e.expires_at <= now) continue;
            mem.data.set(k, e.value);
            if (e.expires_at !== null) mem.expiresAt.set(k, e.expires_at);
        }
        return mem;
    }

    private save(mem: MemoryKv) {
        const now = this.clock();
        const entries: FileShape["entries"] = {};
        for (const [k, v] of mem.data) {
            if (typeof v !== "string") continue;
            const exp = mem.expiresAt.get(k) ?? null;
            if (exp !== null && exp <= now) continue;
            entries[k] = { value: v, expires_at: exp };
        }
        mkdirSync(this.dir, { recursive: true });
        const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        writeFileSync(tmp, JSON.stringify({ v: 1, entries } satisfies FileShape), { encoding: "utf8", mode: 0o600 });
        // En Windows un antivirus puede tomar el archivo un instante: reintento acotado del renombrado.
        for (let i = 0; ; i++) {
            try {
                renameSync(tmp, this.path);
                return;
            } catch {
                if (i >= 5) {
                    rmSync(tmp, { force: true });
                    throw new CampusError("SERVICE_UNAVAILABLE", "No se pudo guardar el archivo de la conexión web de esta PC.", { details: { reason: "kv_unavailable" } });
                }
                // Espera corta y síncrona (el candado sigue tomado), sin ocupar la CPU.
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
            }
        }
    }

    private async lock(): Promise<() => void> {
        mkdirSync(this.dir, { recursive: true });
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            try {
                closeSync(openSync(this.lockPath, "wx"));
                return () => rmSync(this.lockPath, { force: true });
            } catch {
                try {
                    if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) rmSync(this.lockPath, { force: true });
                } catch {
                    /* lo liberó otro proceso */
                }
                if (Date.now() > deadline) throw new CampusError("SERVICE_UNAVAILABLE", "Otro proceso tiene tomado el archivo de la conexión web de esta PC hace demasiado.", { details: { reason: "kv_unavailable" } });
                await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
            }
        }
    }
}
