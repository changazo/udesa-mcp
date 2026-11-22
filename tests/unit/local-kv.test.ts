import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { ConnectionStore, emptyRecord } from "../../src/remote/connection-store.js";
import { FileKv, LOCAL_KV_FILE } from "../../src/web/local-kv.js";
import { CAD_SCRIPT, CAS_SCRIPT } from "../../src/write/store.js";

/** ADR-142: el registro de la conexión de la PC sobre un archivo con candado (sintético, en un directorio temporal). */

const dirs: string[] = [];
const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), "campus-kv-"));
    dirs.push(d);
    return d;
};
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("FileKv (ADR-142)", () => {
    it("dos procesos sobre el mismo archivo ven una sola historia: SET NX, CAS y comparar-y-borrar", async () => {
        const dir = tempDir();
        const a = new FileKv(dir);
        const b = new FileKv(dir);
        expect(await a.cmd(["SET", "k", "1", "NX"])).toBe("OK");
        expect(await b.cmd(["SET", "k", "2", "NX"])).toBeNull();
        expect(await b.cmd(["GET", "k"])).toBe("1");
        expect(await b.cmd(["EVAL", CAS_SCRIPT, 1, "k", "1", "3"])).toBe(1);
        expect(await a.cmd(["EVAL", CAS_SCRIPT, 1, "k", "1", "4"])).toBe(0); // base vieja: no pisa
        expect(await a.cmd(["GET", "k"])).toBe("3");
        expect(await a.cmd(["EVAL", CAD_SCRIPT, 1, "k", "otro"])).toBe(0);
        expect(await b.cmd(["EVAL", CAD_SCRIPT, 1, "k", "3"])).toBe(1);
        expect(await a.cmd(["EXISTS", "k"])).toBe(0);
    });

    it("los vencimientos (EX) se cumplen con el reloj y no sobreviven en el archivo", async () => {
        const dir = tempDir();
        const kv = new FileKv(dir);
        let t = 1_000_000;
        kv.clock = () => t;
        await kv.cmd(["SET", "corta", "x", "EX", 10]);
        await kv.cmd(["SET", "larga", "y"]);
        expect(await kv.cmd(["GET", "corta"])).toBe("x");
        t += 11_000;
        expect(await kv.cmd(["GET", "corta"])).toBeNull();
        await kv.cmd(["SET", "otra", "z"]);
        const file = JSON.parse(readFileSync(join(dir, LOCAL_KV_FILE), "utf8"));
        expect(Object.keys(file.entries).sort()).toEqual(["larga", "otra"]);
    });

    it("archivo dañado ≠ vacío: se informa como kv_unavailable y no se pisa", async () => {
        const dir = tempDir();
        writeFileSync(join(dir, LOCAL_KV_FILE), "{ esto no es json");
        const kv = new FileKv(dir);
        const e = await kv.cmd(["SET", "k", "v"]).catch((x) => x);
        expect(e).toBeInstanceOf(CampusError);
        expect((e as CampusError).details?.reason).toBe("kv_unavailable");
        expect(readFileSync(join(dir, LOCAL_KV_FILE), "utf8")).toBe("{ esto no es json");
    });

    it("escritura atómica: un temporal huérfano de un corte no se lee ni rompe nada; no quedan temporales propios", async () => {
        const dir = tempDir();
        const kv = new FileKv(dir);
        await kv.cmd(["SET", "k", "1"]);
        writeFileSync(join(dir, `${LOCAL_KV_FILE}.999.abc.tmp`), "{basura");
        await kv.cmd(["SET", "k", "2"]);
        expect(await new FileKv(dir).cmd(["GET", "k"])).toBe("2");
        expect(readdirSync(dir).filter((f) => f.endsWith(".tmp") && !f.includes(".999."))).toEqual([]);
    });

    it("un candado abandonado (proceso cortado) se libera solo; uno vigente hace esperar", async () => {
        const dir = tempDir();
        const lock = join(dir, `${LOCAL_KV_FILE}.lock`);
        writeFileSync(lock, "");
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);
        const kv = new FileKv(dir);
        expect(await kv.cmd(["SET", "k", "v"])).toBe("OK");
        expect(existsSync(lock)).toBe(false);
    });

    it("ConnectionStore sobre dos FileKv: 20 transiciones concurrentes, ninguna se pierde", async () => {
        const dir = tempDir();
        const key = "conn2:sintetico:1:abc";
        const s1 = new ConnectionStore(new FileKv(dir), key);
        const s2 = new ConnectionStore(new FileKv(dir), key);
        await s1.update(() => emptyRecord(0, "local-v1"));
        await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? s1 : s2).update((r) => (r ? { ...r, auth_generation: r.auth_generation + 1 } : null))));
        expect((await s1.read())!.auth_generation).toBe(20);
    });
});
