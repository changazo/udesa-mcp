import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractOfficeMedia } from "../../src/documents/office-media.js";
import { extractOfficeText } from "../../src/documents/office.js";
import { findRenderer, rasterize, toPdf } from "../../src/documents/render.js";
import { safeFileName } from "../../src/mcp/downloads.js";
import { makePdf, makePptxWithMedia, PNG_BLUE, PNG_RED } from "../fixtures/documents.js";
import { COURSE, NOW_UNIX } from "../fixtures/fake-moodle.js";
import { createDownloadLinks } from "../../src/remote/download-links.js";
import { makeHarness } from "../fixtures/harness.js";

/** ADR-112: archivo original e imágenes de documentos Office. Datos inventados. */
const BIG = { limits: { http_timeout_seconds: 5, max_concurrent_requests: 2, max_pages_per_request: 10, max_file_bytes: 1_000_000, max_text_chars_per_result: 3000 } };
const LINKS = createDownloadLinks(Buffer.alloc(32, 7), "https://mcp.example.test", () => new Date(NOW_UNIX * 1000));
async function setup(downloadDir?: string, remote = false) {
    const h = await makeHarness({ profile: BIG, ...(downloadDir ? { downloadDir } : {}), ...(remote ? { downloadLinks: LINKS } : {}) });
    const r = await h.app.service.listResources(COURSE);
    const refs = Object.fromEntries(r.data.files.flatMap((x) => x.files).map((f) => [f.name, f.ref]));
    const server = h.app.server();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri: string; mimeType: string; blob: string } }[] };
    return { h, refs, call };
}

describe("documentos Office: orden e imágenes (ADR-112)", () => {
    it("diapositivas en el orden de la presentación; imágenes por diapositiva, internas, con su tipo", () => {
        const deck = makePptxWithMedia();
        expect(extractOfficeText(deck, "pptx").text).toBe("--- Diapositiva 1 ---\nPortada\n\n--- Diapositiva 2 ---\nFunciones\n[Notas del orador]\nNota de la de funciones\n\n--- Diapositiva 3 ---\nFunciones");
        const m = extractOfficeMedia(deck, "pptx");
        expect(m.parts.map((p) => [p.part, p.title, p.images])).toEqual([
            [1, "Portada", []],
            [2, "Funciones", ["ppt/media/image1.png"]],
            [3, "Funciones", ["ppt/media/image1.png", "ppt/media/image2.png", "ppt/media/image3.emf"]],
        ]);
        expect(m.images.get("ppt/media/image3.emf")!.mime).toBeNull();
        expect(Buffer.from(m.read("ppt/media/image2.png"))).toEqual(Buffer.from(PNG_BLUE));
    });

    it("campus_get_file_images: imágenes como contenido de imagen, cada una una vez, EMF listado sin enviar; paginación", async () => {
        const { refs, call } = await setup();
        const r = await call("campus_get_file_images", { file_ref: refs["funciones.pptx"]! });
        expect(r.content.map((c) => c.type)).toEqual(["text", "image", "image"]);
        expect(Buffer.from(r.content[1]!.data!, "base64")).toEqual(Buffer.from(PNG_RED));
        const body = JSON.parse(r.content[0]!.text!);
        expect(body.data.parts[2].images.map((i: { image: string; attached: boolean; also_in_part?: number; mime_type: string }) => [i.image, i.attached, i.also_in_part ?? null, i.mime_type.slice(0, 9)])).toEqual([
            ["image1.png", false, 2, "image/png"],
            ["image2.png", true, null, "image/png"],
            ["image3.emf", false, null, "no visibl"],
        ]);
        expect(body.data.distinct_images).toBe(3);
        const p = await call("campus_get_file_images", { file_ref: refs["funciones.pptx"]!, max_images: 1 });
        expect(JSON.parse(p.content[0]!.text!).data.next_part_start).toBe(3);
        const p2 = await call("campus_get_file_images", { file_ref: refs["funciones.pptx"]!, part_start: 3 });
        expect(p2.content.filter((c) => c.type === "image")).toHaveLength(2); // image1 se envía: es la primera vez en esta respuesta
        const txt = await call("campus_get_file_images", { file_ref: refs["consigna.txt"]! });
        expect(txt.isError).toBe(true);
    });

    it("campus_get_original_file local: guarda el original en la carpeta de descargas y no duplica uno idéntico", async () => {
        const dir = mkdtempSync(join(tmpdir(), "campus-dl-"));
        const { refs, call } = await setup(dir);
        const r = await call("campus_get_original_file", { file_ref: refs["funciones.pptx"]! });
        expect(r.content.map((c) => c.type)).toEqual(["text"]);
        const body = JSON.parse(r.content[0]!.text!);
        expect(body.data.delivery.saved_to).toBe(join(dir, String(COURSE), "funciones.pptx"));
        expect(Buffer.from(readFileSync(body.data.delivery.saved_to))).toEqual(Buffer.from(makePptxWithMedia()));
        expect(body.data.file.sha256).toMatch(/^[0-9a-f]{64}$/);
        const again = JSON.parse((await call("campus_get_original_file", { file_ref: refs["funciones.pptx"]! })).content[0]!.text!);
        expect(again.data.delivery).toMatchObject({ saved_to: body.data.delivery.saved_to, already_saved: true });
        // El modelo elige: inline (su cliente lo guarda en su propio espacio); link no existe en el local.
        const both = await call("campus_get_original_file", { file_ref: refs["funciones.pptx"]!, delivery: "inline" });
        expect(both.content.map((c) => c.type)).toEqual(["text", "resource"]);
        expect(JSON.parse(both.content[0]!.text!).data.delivery).toMatchObject({ mode: "inline", saved_to: null });
        const link = await call("campus_get_original_file", { file_ref: refs["funciones.pptx"]!, delivery: "link" });
        expect(link.isError).toBe(true);
        expect(link.content[0]!.text).toMatch(/sólo está disponible en el servidor remoto/);
    });

    it("campus_get_original_file remoto: auto = incrustado + enlace temporal; computer no existe; el enlace se verifica", async () => {
        const { refs, call } = await setup(undefined, true);
        const r = await call("campus_get_original_file", { file_ref: refs["funciones.pptx"]! });
        expect(r.content.map((c) => c.type)).toEqual(["text", "resource"]);
        const res = r.content[1]!.resource!;
        expect(res.uri).toMatch(/^campus-file:\/\/\/file_.+\/funciones\.pptx$/);
        expect(Buffer.from(res.blob, "base64")).toEqual(Buffer.from(makePptxWithMedia()));
        const d = JSON.parse(r.content[0]!.text!).data.delivery;
        expect(d).toMatchObject({ mode: "auto", saved_to: null });
        expect(d.link).toMatch(/^https:\/\/mcp\.example\.test\/descarga\/[^/]+\/funciones\.pptx$/);
        expect(LINKS.verify(d.link.split("/")[4])).toMatchObject({ name: "funciones.pptx", course_id: COURSE });
        const only = JSON.parse((await call("campus_get_original_file", { file_ref: refs["funciones.pptx"]!, delivery: "link" })).content[0]!.text!);
        expect(only.data.delivery).toMatchObject({ mode: "link", embedded: null });
        const pc = await call("campus_get_original_file", { file_ref: refs["funciones.pptx"]!, delivery: "computer" });
        expect(pc.content[0]!.text).toMatch(/computer sólo está disponible en el servidor local/);
    });

    it("enlaces: firma, vencimiento a los 15 min y alteración", () => {
        let clock = NOW_UNIX * 1000;
        const links = createDownloadLinks(Buffer.alloc(32, 9), "https://x.test", () => new Date(clock));
        const { url, expires_at } = links.mint({ url: "https://campus.example.test/webservice/pluginfile.php/1/a/b.pdf", name: "b.pdf", mime: "application/pdf", course_id: 1 });
        const token = url.split("/")[4]!;
        expect(links.verify(token)).toMatchObject({ name: "b.pdf" });
        expect(Date.parse(expires_at) - clock).toBe(15 * 60 * 1000);
        const [p, sig] = token.split(".");
        const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), url: "https://evil.test/x" })).toString("base64url");
        expect(links.verify(`${forged}.${sig}`)).toBeNull();
        expect(createDownloadLinks(Buffer.alloc(32, 1), "https://x.test", () => new Date(clock)).verify(token)).toBeNull();
        clock += 15 * 60 * 1000 + 1000;
        expect(links.verify(token)).toBeNull();
    });

    it("render sin conversores (remoto): error explícito, no un vacío", async () => {
        const { refs, call } = await setup();
        const r = await call("campus_get_file_images", { file_ref: refs["funciones.pptx"]!, render: true });
        expect(r.isError).toBe(true);
        expect(r.content[0]!.text).toMatch(/servidor local con LibreOffice/);
    });

    it.skipIf(!findRenderer().raster)("render local (si hay un rasterizador instalado): un PDF pasa directo y sale una imagen por página", async () => {
        const rd = findRenderer();
        const pdf = await toPdf(rd, makePdf([["Uno"], ["Dos"]]), "apunte.pdf");
        expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        const pngs = await rasterize(rd, pdf, 1, 2, 30);
        expect(pngs).toHaveLength(2);
        expect(pngs[0]!.subarray(1, 4).toString("latin1")).toBe("PNG");
    }, 180_000);

    it("nombres seguros para guardar", () => {
        expect(safeFileName("../../etc/passwd")).toBe(".._.._etc_passwd".replace(/^[.\s]+/, ""));
        expect(safeFileName("CON.txt")).toBe("_CON.txt");
        expect(safeFileName("Clase 10: «Funciones»?.pptx")).toBe("Clase 10_ «Funciones»_.pptx");
    });
});
