/** Generadores de documentos SINTÉTICOS para tests (PDF, ZIP, PNG, notebook). Sin datos reales. */
import { crc32, deflateRawSync } from "node:zlib";

/** PDF de una página con las líneas dadas; sin líneas, una página sin texto (como un escaneo). */
export function makePdf(pages: string[][]): Uint8Array {
    const objs: string[] = [];
    const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
    objs.push("<< /Type /Catalog /Pages 2 0 R >>");
    objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    const fontId = 3 + pages.length * 2;
    pages.forEach((lines, i) => {
        objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
        const stream = lines.length ? "BT /F1 14 Tf 72 720 Td " + lines.map((l, j) => (j ? "0 -20 Td " : "") + `(${l}) Tj`).join(" ") + " ET" : "0 0 1 rg 72 72 200 200 re f";
        objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });
    objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    let out = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => {
        offs.push(out.length);
        out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
}

export interface ZipSpec {
    name: string;
    data: Uint8Array | string;
    method?: 0 | 8;
    encrypted?: boolean;
    /** Para simular un ZIP que miente sobre el tamaño o el CRC. */
    declaredSize?: number;
    declaredCrc?: number;
}

export function makeZip(specs: ZipSpec[]): Uint8Array {
    const enc = new TextEncoder();
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const s of specs) {
        const raw = typeof s.data === "string" ? enc.encode(s.data) : s.data;
        const method = s.method ?? 8;
        const comp = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
        const name = enc.encode(s.name);
        const crc = s.declaredCrc ?? crc32(raw) >>> 0;
        const size = s.declaredSize ?? raw.byteLength;
        const flags = 0x800 | (s.encrypted ? 1 : 0);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);
        lh.setUint16(6, flags, true);
        lh.setUint16(8, method, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, comp.byteLength, true);
        lh.setUint32(22, size, true);
        lh.setUint16(26, name.byteLength, true);
        const local = concat([new Uint8Array(lh.buffer), name, comp]);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(8, flags, true);
        ch.setUint16(10, method, true);
        ch.setUint32(16, crc, true);
        ch.setUint32(20, comp.byteLength, true);
        ch.setUint32(24, size, true);
        ch.setUint16(28, name.byteLength, true);
        ch.setUint32(42, offset, true);
        centrals.push(concat([new Uint8Array(ch.buffer), name]));
        locals.push(local);
        offset += local.byteLength;
    }
    const cd = concat(centrals);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, specs.length, true);
    eocd.setUint16(10, specs.length, true);
    eocd.setUint32(12, cd.byteLength, true);
    eocd.setUint32(16, offset, true);
    return concat([...locals, cd, new Uint8Array(eocd.buffer)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let i = 0;
    for (const p of parts) {
        out.set(p, i);
        i += p.byteLength;
    }
    return out;
}

/** PNG 1×1 válido. */
export const PNG_1X1 = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

export function makeNotebook(): string {
    return JSON.stringify({
        cells: [
            { cell_type: "markdown", source: ["# Ejercicio 1\n", "Calcular el doble."] },
            { cell_type: "code", source: ["def doble(x):\n", "    return 2 * x\n", "doble(21)"], outputs: [{ output_type: "execute_result", data: { "text/plain": ["42"] } }, { output_type: "display_data", data: { "image/png": "AAAA" } }] },
            { cell_type: "code", source: "import os\nos.system('rm -rf /')", outputs: [] },
        ],
        metadata: { language_info: { name: "python" } },
        nbformat: 4,
    });
}

/** ZIP típico de una entrega: código, notebook, imagen, basura de macOS y un ZIP anidado. */
export function makeSubmissionZip(): Uint8Array {
    return makeZip([
        { name: "tp2/main.py", data: "print('hola')\n" },
        { name: "tp2/notebook.ipynb", data: makeNotebook() },
        { name: "tp2/captura.png", data: PNG_1X1, method: 0 },
        { name: "__MACOSX/tp2/._main.py", data: "basura" },
        { name: "tp2/otro.zip", data: makeZip([{ name: "x.txt", data: "anidado" }]), method: 0 },
        { name: "tp2/informe.docx", data: "PK-docx-falso" },
    ]);
}

/** .docx mínimo: dos párrafos y una tabla de una fila. */
export function makeDocx(): Uint8Array {
    const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>
<w:p><w:r><w:t>Consigna del TP2</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Entrega: </w:t></w:r><w:r><w:t>03/11 &amp; defensa</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Criterio</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Puntaje</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;
    return makeZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: doc }]);
}

/** .pptx mínimo: dos diapositivas (orden numérico 2 < 10) y notas del orador. */
export function makePptx(): Uint8Array {
    const slide = (t: string) => `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    return makeZip([
        { name: "ppt/slides/slide10.xml", data: slide("Diez: cierre") },
        { name: "ppt/slides/slide2.xml", data: slide("Dos: ciclos for") },
        { name: "ppt/notesSlides/notesSlide2.xml", data: `<p:notes xmlns:a="a"><a:p><a:r><a:t>Recordar el ejemplo</a:t></a:r></a:p></p:notes>` },
    ]);
}

/** PNG de 1×1 (rojo) y otro distinto (azul), para las imágenes de documentos Office. */
export const PNG_RED = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
export const PNG_BLUE = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==", "base64"));

/**
 * .pptx con estructura real (ADR-112): el orden de la presentación (slide3, slide1, slide2) no es el
 * de los archivos; notas por relación; imágenes: una compartida por dos diapositivas, una propia y
 * un EMF (no se puede mostrar); y un enlace externo que no se sigue.
 */
export function makePptxWithMedia(): Uint8Array {
    const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const slide = (t: string, ids: string[]) =>
        `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>${ids.map((id) => `<p:pic><p:blipFill><a:blip r:embed="${id}"/></p:blipFill></p:pic>`).join("")}</p:spTree></p:cSld></p:sld>`;
    const rels = (list: [string, string, string][]) => `<Relationships>${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${target.startsWith("http") ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
    return makeZip([
        { name: "ppt/presentation.xml", data: `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId2"/></p:sldIdLst></p:presentation>` },
        { name: "ppt/_rels/presentation.xml.rels", data: rels([["rId1", "slide", "slides/slide1.xml"], ["rId2", "slide", "slides/slide2.xml"], ["rId3", "slide", "slides/slide3.xml"]]) },
        { name: "ppt/slides/slide1.xml", data: slide("Funciones", ["rId2"]) },
        { name: "ppt/slides/_rels/slide1.xml.rels", data: rels([["rId2", "image", "../media/image1.png"], ["rId9", "notesSlide", "../notesSlides/notesSlide7.xml"]]) },
        { name: "ppt/slides/slide2.xml", data: slide("Funciones", ["rId4", "rId5", "rId6"]) },
        { name: "ppt/slides/_rels/slide2.xml.rels", data: rels([["rId4", "image", "../media/image1.png"], ["rId5", "image", "../media/image2.png"], ["rId6", "image", "../media/image3.emf"], ["rId7", "image", "https://evil.example.com/x.png"]]) },
        { name: "ppt/slides/slide3.xml", data: slide("Portada", []) },
        { name: "ppt/notesSlides/notesSlide7.xml", data: `<p:notes xmlns:a="a"><a:p><a:r><a:t>Nota de la de funciones</a:t></a:r></a:p></p:notes>` },
        { name: "ppt/media/image1.png", data: PNG_RED },
        { name: "ppt/media/image2.png", data: PNG_BLUE },
        { name: "ppt/media/image3.emf", data: "EMF-no-es-imagen-web" },
    ]);
}

/** .xlsx mínimo: cadenas compartidas, número y cadena en línea. */
export function makeXlsx(): Uint8Array {
    return makeZip([
        { name: "xl/workbook.xml", data: `<workbook><sheets><sheet name="Notas" sheetId="1"/></sheets></workbook>` },
        { name: "xl/sharedStrings.xml", data: `<sst><si><t>Alumno</t></si><si><t>Nota</t></si><si><t>Sintético</t></si></sst>` },
        { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>8.5</v></c><c r="C2" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>` },
    ]);
}
