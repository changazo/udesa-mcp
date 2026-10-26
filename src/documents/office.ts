import { CampusError } from "../errors.js";
import { pptxSlideOrder, relsOf } from "./office-media.js";
import { readZipDirectory, readZipEntry, type ZipEntry } from "./zip.js";

/**
 * Texto de documentos Office Open XML (docx, pptx, xlsx) con el lector ZIP propio y un parseo
 * mínimo de XML (sólo texto; sin macros, sin objetos incrustados, sin seguir relaciones externas).
 * Se pierde el formato visual; las tablas de Word salen como filas separadas por « | ».
 */
export type OfficeKind = "docx" | "pptx" | "xlsx";

export function officeKind(name: string): OfficeKind | null {
    const m = /\.(docx|pptx|xlsx)$/i.exec(name);
    return m ? (m[1]!.toLowerCase() as OfficeKind) : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const xmlText = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, b: string) => {
        if (b[0] === "#") {
            const cp = b[1] === "x" || b[1] === "X" ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
        }
        return ENTITIES[b] ?? m;
    });

const MAX_XML = 15 * 1024 * 1024;

function entryText(zip: Uint8Array, entries: ZipEntry[], name: string): string | null {
    const e = entries.find((x) => x.name === name);
    if (!e) return null;
    return new TextDecoder("utf-8").decode(readZipEntry(zip, e, MAX_XML));
}

/** Texto de los <tag>…</tag> de un XML, con saltos en los cierres de párrafo/fila indicados. */
function runs(xml: string, textTag: string, paraTag: string, extra: (s: string) => string = (s) => s): string {
    // Los saltos de línea del XML fuente son formato del archivo, no texto: los reales son etiquetas.
    const body = extra(xml.replace(/[\r\n]+/g, ""))
        .replace(new RegExp(`</${paraTag}>`, "g"), "\n")
        .replace(/<w:tab\/>|<a:tab\/>/g, "\t")
        .replace(/<w:br\/>|<a:br\/>/g, "\n");
    let out = "";
    const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>|(\\n)|(\\t)`, "g");
    for (const m of body.matchAll(re)) out += m[1] !== undefined ? xmlText(m[1]) : (m[2] ?? m[3] ?? "");
    return out
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function extractOfficeText(bytes: Uint8Array, kind: OfficeKind): { text: string; parts: number } {
    const entries = readZipDirectory(bytes);
    if (kind === "docx") {
        const xml = entryText(bytes, entries, "word/document.xml");
        if (xml === null) throw new CampusError("UNSUPPORTED_CONTENT", "El .docx no tiene word/document.xml (formato no reconocido).");
        // Tablas: cada fila en una línea, celdas separadas por « | » (los párrafos dentro de una
        // celda se unen con espacio).
        const text = runs(xml, "w:t", "w:p", (s) =>
            s.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => cell.replace(/<\/w:p>(?![\s\S]*<\/w:p>)/, "").replace(/<\/w:p>/g, "<w:t> </w:t>").replace(/<\/w:tc>$/, "<w:t> | </w:t></w:tc>"))
                .replace(/<\/w:tr>/g, "</w:tr></w:p>"),
        )
            .split("\n")
            .map((l) => l.replace(/\s*\|\s*$/, ""))
            .join("\n");
        return { text, parts: 1 };
    }
    if (kind === "pptx") {
        // Orden de la presentación (ADR-112), no el número del archivo; notas por la relación de cada diapositiva.
        const slides = pptxSlideOrder(bytes, entries);
        if (!slides.length) throw new CampusError("UNSUPPORTED_CONTENT", "El .pptx no tiene diapositivas reconocibles.");
        const parts = slides.map((name, i) => {
            const body = runs(entryText(bytes, entries, name) ?? "", "a:t", "a:p");
            // Sin relación (paquetes mínimos), la convención de nombres: slideN ↔ notesSlideN.
            const notesPath = [...relsOf(bytes, entries, name).values()].find((r) => /\/notesSlide$/.test(r.type))?.target ?? name.replace(/^ppt\/slides\/slide(\d+)\.xml$/, "ppt/notesSlides/notesSlide$1.xml");
            const notesXml = notesPath ? entryText(bytes, entries, notesPath) : null;
            const notes = notesXml ? runs(notesXml, "a:t", "a:p").replace(/^\d+$/m, "").trim() : "";
            return `--- Diapositiva ${i + 1} ---\n${body}${notes ? `\n[Notas del orador]\n${notes}` : ""}`;
        });
        return { text: parts.join("\n\n"), parts: slides.length };
    }
    // xlsx: cadenas compartidas + hojas, como texto tabulado (sin fórmulas: valores guardados).
    const shared: string[] = [];
    const sst = entryText(bytes, entries, "xl/sharedStrings.xml");
    if (sst) for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...si[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join(""));
    const wb = entryText(bytes, entries, "xl/workbook.xml") ?? "";
    const names = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => xmlText(m[1]!));
    const sheets = entries
        .map((e) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(e.name))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ n: Number(m[1]), name: m[0] }))
        .sort((a, b) => a.n - b.n);
    if (!sheets.length) throw new CampusError("UNSUPPORTED_CONTENT", "El .xlsx no tiene hojas reconocibles.");
    const parts = sheets.map((s, i) => {
        const xml = entryText(bytes, entries, s.name) ?? "";
        const rows: string[] = [];
        for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
            const cells: string[] = [];
            for (const c of row[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b[^>]*\/>/g)) {
                const attrs = c[1] ?? "";
                const inner = c[2] ?? "";
                const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
                const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
                if (t === "s" && v !== undefined) cells.push(shared[Number(v)] ?? "");
                else if (t === "inlineStr") cells.push([...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join(""));
                else cells.push(v !== undefined ? xmlText(v) : "");
            }
            if (cells.some((x) => x !== "")) rows.push(cells.join("\t"));
        }
        return `--- Hoja ${names[i] ?? s.n} ---\n${rows.join("\n")}`;
    });
    return { text: parts.join("\n\n"), parts: sheets.length };
}
