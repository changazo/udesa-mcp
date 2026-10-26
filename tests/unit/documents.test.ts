import { describe, expect, it } from "vitest";
import { classifyFile, decodeText, notebookToMarkdown, sniffImage } from "../../src/documents/formats.js";
import { extractPdfText } from "../../src/documents/pdf.js";
import { isJunkEntry, readZipDirectory, readZipEntry } from "../../src/documents/zip.js";
import { CampusError } from "../../src/errors.js";
import { makeNotebook, makePdf, makeSubmissionZip, makeZip, PNG_1X1 } from "../fixtures/documents.js";

const codeOf = (fn: () => unknown) => {
    try {
        fn();
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
};

describe("ZIP", () => {
    it("lista entradas y lee store y deflate", () => {
        const zip = makeSubmissionZip();
        const entries = readZipDirectory(zip);
        expect(entries.map((e) => e.name)).toContain("tp2/main.py");
        const py = entries.find((e) => e.name === "tp2/main.py")!;
        expect(new TextDecoder().decode(readZipEntry(zip, py))).toBe("print('hola')\n");
        const png = entries.find((e) => e.name === "tp2/captura.png")!;
        expect(png.method).toBe(0);
        expect(sniffImage(readZipEntry(zip, png))).toBe("image/png");
        expect(entries.filter((e) => isJunkEntry(e.name)).map((e) => e.name)).toEqual(["__MACOSX/tp2/._main.py"]);
    });

    it("rechaza CRC inválido, tamaño declarado falso y entradas cifradas", () => {
        const badCrc = makeZip([{ name: "a.txt", data: "hola", declaredCrc: 1234 }]);
        expect(codeOf(() => readZipEntry(badCrc, readZipDirectory(badCrc)[0]!))).toBe("UNSUPPORTED_CONTENT");
        const lies = makeZip([{ name: "a.txt", data: "x".repeat(5000), declaredSize: 10 }]);
        expect(codeOf(() => readZipEntry(lies, readZipDirectory(lies)[0]!))).toBe("UNSUPPORTED_CONTENT");
        const enc = makeZip([{ name: "a.txt", data: "secreto", encrypted: true }]);
        expect(readZipDirectory(enc)[0]!.encrypted).toBe(true);
        expect(codeOf(() => readZipEntry(enc, readZipDirectory(enc)[0]!))).toBe("UNSUPPORTED_CONTENT");
    });

    it("zip bomb: relación de compresión desmedida o tamaño excesivo no se descomprimen", () => {
        const bomb = makeZip([{ name: "ceros.txt", data: new Uint8Array(3 * 1024 * 1024) }]);
        const e = readZipDirectory(bomb)[0]!;
        expect(e.uncompressed_bytes / e.compressed_bytes).toBeGreaterThan(200);
        expect(codeOf(() => readZipEntry(bomb, e))).toBe("UNSUPPORTED_CONTENT");
        const big = makeZip([{ name: "x.bin", data: "x", declaredSize: 50 * 1024 * 1024 }]);
        expect(codeOf(() => readZipEntry(big, readZipDirectory(big)[0]!))).toBe("UNSUPPORTED_CONTENT");
    });

    it("no-ZIP y ZIP truncado son errores controlados", () => {
        expect(codeOf(() => readZipDirectory(new TextEncoder().encode("no soy un zip")))).toBe("UNSUPPORTED_CONTENT");
        const zip = makeSubmissionZip();
        expect(codeOf(() => readZipDirectory(zip.subarray(0, zip.byteLength - 10)))).toBe("UNSUPPORTED_CONTENT");
    });
});

describe("formatos", () => {
    it.each([
        ["tp.py", null, "text"],
        ["nb.ipynb", null, "notebook"],
        ["a.pdf", null, "pdf"],
        ["x", "application/pdf", "pdf"],
        ["e.zip", null, "zip"],
        ["f.PNG", null, "image"],
        ["informe.docx", "application/zip", "office"],
        ["viejo.doc", "application/msword", "unsupported"],
        ["p.html", null, "html"],
        ["video.mp4", "video/mp4", "unsupported"],
    ])("%s (%s) → %s", (name, mime, kind) => {
        expect(classifyFile(name, mime)).toBe(kind);
    });

    it("imágenes por firma binaria, no por extensión", () => {
        expect(sniffImage(PNG_1X1)).toBe("image/png");
        expect(sniffImage(new TextEncoder().encode("<script>"))).toBeNull();
        expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    });

    it("binarios no se decodifican como texto", () => {
        expect(codeOf(() => decodeText(new Uint8Array([0, 1, 2, 0xff, 0xfe, 0, 0])))).toBe("UNSUPPORTED_CONTENT");
        expect(decodeText(new TextEncoder().encode("﻿hola"))).toBe("hola");
    });

    it("notebook → Markdown: celdas, código, salidas de texto; imágenes contadas; nada se ejecuta", () => {
        const r = notebookToMarkdown(makeNotebook());
        expect(r.cells).toBe(3);
        expect(r.image_outputs).toBe(1);
        expect(r.markdown).toContain("# Ejercicio 1");
        expect(r.markdown).toContain("```python\ndef doble(x):");
        expect(r.markdown).toContain("Salida (registrada en el notebook, no ejecutada)");
        expect(r.markdown).toContain("42");
        expect(r.markdown).toContain("os.system('rm -rf /')"); // se muestra como texto
        expect(codeOf(() => notebookToMarkdown("{no json"))).toBe("UNSUPPORTED_CONTENT");
    });
});

describe("PDF", () => {
    it("extrae texto por página y permite continuar", async () => {
        const pdf = makePdf([["Uno"], ["Dos"], ["Tres"]]);
        const r = await extractPdfText(pdf, { pageStart: 1, maxPages: 2, maxChars: 10_000 });
        expect(r.num_pages).toBe(3);
        expect(r.pages.map((p) => p.text)).toEqual(["Uno", "Dos"]);
        expect(r.next_page).toBe(3);
        const rest = await extractPdfText(pdf, { pageStart: 3, maxPages: 2, maxChars: 10_000 });
        expect(rest.pages.map((p) => p.text)).toEqual(["Tres"]);
        expect(rest.next_page).toBeNull();
    });

    it("página sin texto (escaneo) queda vacía, sin inventar", async () => {
        const r = await extractPdfText(makePdf([[]]), { pageStart: 1, maxPages: 5, maxChars: 10_000 });
        expect(r.pages).toEqual([{ page: 1, text: "" }]);
    });

    it("PDF inválido y página fuera de rango son errores", async () => {
        await expect(extractPdfText(new TextEncoder().encode("%PDF-1.4 roto"), { pageStart: 1, maxPages: 1, maxChars: 100 })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT" });
        await expect(extractPdfText(makePdf([["a"]]), { pageStart: 5, maxPages: 1, maxChars: 100 })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    });
});

describe("codificación de archivos de texto (.py de estudiantes)", () => {
    const py = "# Cálculo del año\nnombre = 'Ñandú'\nprint(nombre)\n";
    it("UTF-8 sin aviso", async () => {
        const { decodeTextWithInfo } = await import("../../src/documents/formats.js");
        expect(decodeTextWithInfo(new TextEncoder().encode(py))).toEqual({ text: py, encoding: "utf-8", warning: null });
    });
    it("Windows-1252 («ANSI»): se decodifica bien y se avisa, sin «�»", async () => {
        const { decodeTextWithInfo } = await import("../../src/documents/formats.js");
        const cp1252 = new Uint8Array(Buffer.from(py, "latin1"));
        const r = decodeTextWithInfo(cp1252);
        expect(r.text).toBe(py);
        expect(r.encoding).toBe("windows-1252");
        expect(r.warning).toMatch(/Windows-1252/);
        expect(r.text).not.toContain("\uFFFD");
    });
    it("UTF-16 con BOM (Bloc de notas «Unicode»)", async () => {
        const { decodeTextWithInfo } = await import("../../src/documents/formats.js");
        const u16 = new Uint8Array([0xff, 0xfe, ...Buffer.from(py, "utf16le")]);
        expect(decodeTextWithInfo(u16)).toMatchObject({ text: py, encoding: "utf-16le" });
    });
    it("binario se rechaza", async () => {
        const { decodeTextWithInfo } = await import("../../src/documents/formats.js");
        expect(() => decodeTextWithInfo(new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02, 0xff]))).toThrow(CampusError);
    });
});
