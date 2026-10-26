import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import { ASSIGN, COURSE, STUDENT_A } from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

const BIG = { limits: { http_timeout_seconds: 5, max_concurrent_requests: 2, max_pages_per_request: 10, max_file_bytes: 1_000_000, max_text_chars_per_result: 3000 } };

async function submissionRefs() {
    const h = await makeHarness({ profile: BIG });
    const sub = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A });
    const refs = Object.fromEntries(sub.data.files.map((f) => [f.name, f.ref]));
    return { h, refs };
}

async function resourceRefs() {
    const h = await makeHarness({ profile: BIG });
    const r = await h.app.service.listResources(COURSE);
    const refs = Object.fromEntries(r.data.files.flatMap((x) => x.files).map((f) => [f.name, f.ref]));
    return { h, refs };
}

describe("entregas en ZIP", () => {
    it("sin entry: listado con tipos, basura marcada y sin extraer nada", async () => {
        const { h, refs } = await submissionRefs();
        const r = await h.app.service.readFile({ file_ref: refs["entrega.zip"]! });
        expect(r.data.modality).toBe("zip_listing");
        const entries = r.data.entries as { entry: string; kind: string; junk?: boolean }[];
        expect(entries.find((e) => e.entry === "tp2/main.py")!.kind).toBe("text");
        expect(entries.find((e) => e.entry === "tp2/notebook.ipynb")!.kind).toBe("notebook");
        expect(entries.find((e) => e.entry === "__MACOSX/tp2/._main.py")!.junk).toBe(true);
        expect(r.warnings.join(" ")).toMatch(/entry=/);
    });

    it("con entry: código, notebook e imagen; ZIP anidado y Office rechazados", async () => {
        const { h, refs } = await submissionRefs();
        const ref = refs["entrega.zip"]!;
        const py = await h.app.service.readFile({ file_ref: ref, entry: "tp2/main.py" });
        expect(py.data).toMatchObject({ modality: "text", text: "print('hola')\n", entry: "tp2/main.py" });
        const nb = await h.app.service.readFile({ file_ref: ref, entry: "tp2/notebook.ipynb" });
        expect(nb.data.modality).toBe("notebook_as_markdown");
        expect(String(nb.data.text)).toContain("def doble(x):");
        const img = await h.app.service.readFile({ file_ref: ref, entry: "tp2/captura.png" });
        expect(img.data.modality).toBe("image");
        expect(img.media?.[0]?.mimeType).toBe("image/png");
        expect(await codeOf(h.app.service.readFile({ file_ref: ref, entry: "tp2/otro.zip" }))).toBe("UNSUPPORTED_CONTENT");
        expect(await codeOf(h.app.service.readFile({ file_ref: ref, entry: "tp2/informe.docx" }))).toBe("UNSUPPORTED_CONTENT");
        expect(await codeOf(h.app.service.readFile({ file_ref: ref, entry: "../../etc/passwd" }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("entry sólo vale para ZIP", async () => {
        const { h, refs } = await submissionRefs();
        expect(await codeOf(h.app.service.readFile({ file_ref: refs["tp1.py"]!, entry: "x" }))).toBe("POLICY_DENIED");
    });
});

describe("imágenes, PDF escaneado, notebooks y Office", () => {
    it("imagen de una entrega se devuelve como imagen, sin base64 en el JSON", async () => {
        const { h, refs } = await submissionRefs();
        const r = await h.app.service.readFile({ file_ref: refs["captura.png"]! });
        expect(r.data).toMatchObject({ modality: "image", detected_mime_type: "image/png" });
        expect(JSON.stringify(r.data)).not.toContain("iVBOR");
        expect(r.media).toHaveLength(1);
    });

    it("un .png que no es imagen se rechaza por firma binaria", async () => {
        const { h, refs } = await resourceRefs();
        expect(await codeOf(h.app.service.readFile({ file_ref: refs["trampa.png"]! }))).toBe("UNSUPPORTED_CONTENT");
    });

    it("FILE-03: PDF escaneado → aviso explícito sin texto inventado", async () => {
        const { h, refs } = await resourceRefs();
        const r = await h.app.service.readFile({ file_ref: refs["escaneado.pdf"]! });
        expect(r.data.modality).toBe("pdf_text");
        expect(r.warnings.join(" ")).toMatch(/escaneado/);
    });

    it("notebook como Markdown; Word, PowerPoint y Excel como texto; .doc viejo sin descargar", async () => {
        const { h, refs } = await resourceRefs();
        const nb = await h.app.service.readFile({ file_ref: refs["notebook.ipynb"]! });
        expect(nb.data.modality).toBe("notebook_as_markdown");
        const docx = await h.app.service.readFile({ file_ref: refs["informe.docx"]! });
        expect(docx.data.modality).toBe("docx_as_text");
        expect(docx.data.text).toBe("Consigna del TP2\nEntrega: 03/11 & defensa\nCriterio | Puntaje");
        const pptx = await h.app.service.readFile({ file_ref: refs["clase.pptx"]! });
        // Sin presentation.xml: orden por número de archivo (2 < 10), numeradas por posición (ADR-112).
        expect(pptx.data.text).toBe("--- Diapositiva 1 ---\nDos: ciclos for\n[Notas del orador]\nRecordar el ejemplo\n\n--- Diapositiva 2 ---\nDiez: cierre");
        const xlsx = await h.app.service.readFile({ file_ref: refs["notas.xlsx"]! });
        expect(xlsx.data.text).toBe("--- Hoja Notas ---\nAlumno\tNota\nSintético\t8.5\tok");
        const before = h.fake.downloads.length;
        expect(await codeOf(h.app.service.readFile({ file_ref: refs["viejo.doc"]! }))).toBe("UNSUPPORTED_CONTENT");
        expect(h.fake.downloads.length).toBe(before);
    });
});

describe("MCP adjunta la imagen como bloque de contenido", () => {
    it("campus_read_file devuelve JSON + bloque image", async () => {
        const { h, refs } = await submissionRefs();
        const server = h.app.server();
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "t", version: "0" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        const r = (await client.callTool({ name: "campus_read_file", arguments: { file_ref: refs["captura.png"]! } })) as { content: { type: string; mimeType?: string; text?: string }[] };
        expect(r.content.map((c) => c.type)).toEqual(["text", "image"]);
        expect(r.content[1]!.mimeType).toBe("image/png");
        expect(JSON.parse(r.content[0]!.text!).media).toBeUndefined();
    });
});
