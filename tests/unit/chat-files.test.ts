import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { downloadChatFile, isPublicAddress, type ChatFileDeps } from "../../src/write/chat-files.js";
import { BLOB_CHUNK_BYTES, KvWriteStore, MemoryKv } from "../../src/write/store.js";

/** Archivos que entrega ChatGPT (`openai/fileParams`): descarga con salvaguardas. Enlaces y hosts sintéticos. */

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const ref = (over: Record<string, string> = {}) => ({ download_url: "https://files.chat.example/f/abc?sig=SECRETO", file_id: "file_abc", file_name: "guia.pdf", mime_type: "application/pdf", ...over });

function deps(routes: Record<string, () => Response>, dns: Record<string, string[]> = {}): ChatFileDeps & { asked: string[] } {
    const asked: string[] = [];
    return {
        asked,
        resolve: async (host) => dns[host] ?? ["93.184.216.34"],
        fetchImpl: (async (input: string | URL | Request) => {
            const url = String(input);
            asked.push(url);
            const r = routes[url];
            if (!r) return new Response("no", { status: 404 });
            return r();
        }) as typeof fetch,
    };
}

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("direcciones públicas", () => {
    it("rechaza locales, privadas, de enlace, CGNAT, documentación y sus formas IPv6", () => {
        for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.5", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "2001:db8::1"]) {
            expect(isPublicAddress(ip), ip).toBe(false);
        }
        for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPublicAddress(ip), ip).toBe(true);
    });
});

describe("descarga de un archivo de ChatGPT", () => {
    it("baja el PDF, toma el nombre que informa ChatGPT y no sigue más allá", async () => {
        const d = deps({ [ref().download_url]: () => new Response(PDF, { headers: { "content-length": String(PDF.length) } }) });
        const r = await downloadChatFile(ref(), 1_000_000, d);
        expect(r.filename).toBe("guia.pdf");
        expect(r.data.equals(PDF)).toBe(true);
        expect(r.host).toBe("files.chat.example");
    });

    it("sin file_name usa Content-Disposition; si tampoco hay, el último tramo del enlace", async () => {
        const url = "https://files.chat.example/f/apunte.pdf";
        const withHeader = deps({ [url]: () => new Response(PDF, { headers: { "content-disposition": "attachment; filename*=UTF-8''Gu%C3%ADa%201.pdf" } }) });
        expect((await downloadChatFile({ download_url: url, file_id: "f1" }, 1e6, withHeader)).filename).toBe("Guía 1.pdf");
        const bare = deps({ [url]: () => new Response(PDF) });
        expect((await downloadChatFile({ download_url: url, file_id: "f1" }, 1e6, bare)).filename).toBe("apunte.pdf");
    });

    it("rechaza http, puertos raros, credenciales en el enlace y hosts que resuelven a direcciones internas, sin pedir nada", async () => {
        for (const url of ["http://files.chat.example/f", "https://files.chat.example:8443/f", "https://u:p@files.chat.example/f", "https://169.254.169.254/latest", "https://[::1]/f"]) {
            const d = deps({});
            expect((await errOf(downloadChatFile(ref({ download_url: url }), 1e6, d))).code, url).toBe("WRITE_NOT_ALLOWED");
            expect(d.asked).toHaveLength(0);
        }
        const internal = deps({}, { "files.chat.example": ["93.184.216.34", "10.0.0.7"] });
        expect((await errOf(downloadChatFile(ref(), 1e6, internal))).message).toContain("no pública");
        expect(internal.asked).toHaveLength(0);
    });

    it("sigue redirecciones públicas, revisa cada destino y corta las que van a la red interna", async () => {
        const cdn = "https://cdn.chat.example/blob/1";
        const ok = deps({ [ref().download_url]: () => new Response(null, { status: 302, headers: { location: cdn } }), [cdn]: () => new Response(PDF) });
        expect((await downloadChatFile(ref(), 1e6, ok)).data.equals(PDF)).toBe(true);
        const bad = deps({ [ref().download_url]: () => new Response(null, { status: 302, headers: { location: "https://interno.chat.example/x" } }) }, { "interno.chat.example": ["192.168.0.10"] });
        expect((await errOf(downloadChatFile(ref(), 1e6, bad))).code).toBe("WRITE_NOT_ALLOWED");
        expect(bad.asked).toHaveLength(1);
    });

    it("corta por tamaño (declarado o real), un enlace vencido es PLAN_STALE y un .pdf que no es PDF se rechaza", async () => {
        const big = deps({ [ref().download_url]: () => new Response(PDF, { headers: { "content-length": "999999" } }) });
        expect((await errOf(downloadChatFile(ref(), 1000, big))).message).toContain("máximo es 1000");
        const sneaky = deps({ [ref().download_url]: () => new Response(Buffer.concat([PDF, Buffer.alloc(2000)])) });
        expect((await errOf(downloadChatFile(ref(), 1000, sneaky))).message).toContain("supera el máximo");
        const gone = deps({ [ref().download_url]: () => new Response("expired", { status: 403 }) });
        expect((await errOf(downloadChatFile(ref(), 1e6, gone))).code).toBe("PLAN_STALE");
        const fake = deps({ [ref().download_url]: () => new Response("<html>login</html>") });
        expect((await errOf(downloadChatFile(ref(), 1e6, fake))).message).toContain("no es un PDF válido");
    });

    it("los mensajes de error nunca incluyen el enlace firmado", async () => {
        const gone = deps({ [ref().download_url]: () => new Response("x", { status: 403 }) });
        expect((await errOf(downloadChatFile(ref(), 1e6, gone))).message).not.toContain("SECRETO");
        const down = { ...deps({}), fetchImpl: (async () => Promise.reject(new Error("ECONNRESET https://files.chat.example/f/abc?sig=SECRETO"))) as unknown as typeof fetch };
        expect((await errOf(downloadChatFile(ref(), 1e6, down))).message).not.toContain("SECRETO");
    });
});

describe("bytes en el KV", () => {
    it("se guardan por sha256 con vencimiento y se leen; un id que no es sha256 se rechaza", async () => {
        const kv = new MemoryKv();
        const store = new KvWriteStore(kv, "t");
        const sha = "a".repeat(64);
        await store.putBlob(sha, PDF, 3600);
        expect(kv.ttl.get(`t:blob:${sha}`)).toBe(3600);
        expect((await store.getBlob(sha))!.equals(PDF)).toBe(true);
        expect(await store.getBlob("b".repeat(64))).toBeNull();
        await expect(store.getBlob("../x")).rejects.toThrow(CampusError);
    });

    it("un archivo grande va en trozos de 4 MB; si falta un trozo, no se devuelve nada", async () => {
        const kv = new MemoryKv();
        const store = new KvWriteStore(kv, "t");
        const sha = "c".repeat(64);
        const big = Buffer.alloc(BLOB_CHUNK_BYTES * 2 + 10, 7);
        await store.putBlob(sha, big, 3600);
        expect(kv.data.get(`t:blob:${sha}`)).toBe("3");
        expect(Math.max(...[0, 1, 2].map((i) => String(kv.data.get(`t:blob:${sha}:${i}`)).length))).toBeLessThan(6 * 1024 * 1024);
        expect((await store.getBlob(sha))!.equals(big)).toBe(true);
        kv.data.delete(`t:blob:${sha}:1`);
        expect(await store.getBlob(sha)).toBeNull();
    });
});
