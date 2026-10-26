import { CampusError } from "../errors.js";

/**
 * Clasificación de archivos por extensión y tipo MIME. Office (docx/xlsx/pptx, que también son
 * ZIP) queda como no soportado: abrirlo como ZIP mostraría XML interno, no el documento.
 */
export type FileKind = "text" | "html" | "notebook" | "pdf" | "zip" | "image" | "office" | "unsupported";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|py|yaml|yml|xml|r|sql|java|c|cpp|h|hpp|js|ts|log|m|sh|bat|ini|cfg|toml)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const OFFICE_EXT = /\.(docx|xlsx|pptx)$/i;
/** Formatos binarios viejos u OpenDocument: no soportados todavía. */
const LEGACY_OFFICE_EXT = /\.(doc|xls|ppt|odt|ods|odp|rtf)$/i;

export function classifyFile(name: string, mime: string | null): FileKind {
    const m = (mime ?? "").toLowerCase();
    if (OFFICE_EXT.test(name)) return "office";
    if (LEGACY_OFFICE_EXT.test(name)) return "unsupported";
    if (/\.ipynb$/i.test(name)) return "notebook";
    if (/\.pdf$/i.test(name) || m === "application/pdf") return "pdf";
    if (/\.zip$/i.test(name) || m === "application/zip" || m === "application/x-zip-compressed") return "zip";
    if (IMAGE_EXT.test(name) || /^image\/(png|jpeg|gif|webp)$/.test(m)) return "image";
    if (HTML_EXT.test(name) || m === "text/html" || m === "application/xhtml+xml") return "html";
    if (TEXT_EXT.test(name) || m.startsWith("text/") || m === "application/json") return "text";
    return "unsupported";
}

export const SUPPORTED_DESCRIPTION =
    "texto plano, Markdown, CSV/TSV, JSON, código fuente (sólo lectura), HTML como texto, notebooks .ipynb, PDF con texto, Word/PowerPoint/Excel (.docx/.pptx/.xlsx, sólo texto), ZIP (listado y entradas) e imágenes PNG/JPEG/GIF/WebP. Formatos viejos (.doc/.ppt/.xls) y OpenDocument: pendientes.";

/** Tipo real de una imagen por su firma binaria (no se confía en la extensión). */
export function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
    return null;
}

export interface DecodedText {
    text: string;
    encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
    /** Aviso cuando no era UTF-8 (para que el agente sepa cómo se interpretó). */
    warning: string | null;
}

/**
 * Decodifica texto sin alterarlo en silencio. Orden: UTF-8 estricto → UTF-16 con BOM (el
 * «Unicode» del Bloc de notas) → Windows-1252 (archivos guardados como «ANSI» en Windows, comunes
 * en .py de estudiantes con tildes o ñ). Nunca reemplaza caracteres por «�» sin avisar; un
 * binario se rechaza.
 */
export function decodeTextWithInfo(bytes: Uint8Array): DecodedText {
    const notText = () => new CampusError("UNSUPPORTED_CONTENT", "El archivo no parece texto (contenido binario); no se extrae para no inventar contenido.");
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
        const enc = bytes[0] === 0xff ? "utf-16le" : "utf-16be";
        const text = new TextDecoder(enc).decode(bytes.subarray(2));
        return { text, encoding: enc, warning: `Archivo en ${enc.toUpperCase()} (con BOM); se convirtió a texto.` };
    }
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
        if (text.includes("\u0000")) throw notText();
        return { text, encoding: "utf-8", warning: null };
    } catch (e) {
        if (e instanceof CampusError) throw e;
    }
    // No es UTF-8 válido: ¿texto en Windows-1252 o binario?
    if (bytes.includes(0)) throw notText();
    let control = 0;
    for (const b of bytes) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) control++;
    if (bytes.length > 0 && control / bytes.length > 0.01) throw notText();
    const text = new TextDecoder("windows-1252").decode(bytes);
    return {
        text,
        encoding: "windows-1252",
        warning: "El archivo no era UTF-8: se interpretó como Windows-1252 («ANSI»). Si ves caracteres raros, la codificación original puede ser otra.",
    };
}

/** Atajo: sólo el texto. */
export function decodeText(bytes: Uint8Array): string {
    return decodeTextWithInfo(bytes).text;
}

/**
 * Notebook Jupyter → Markdown legible: celdas markdown tal cual, código en bloques, salidas de
 * texto recortadas. Las imágenes de salida se cuentan pero no se incluyen. Nada se ejecuta.
 */
export function notebookToMarkdown(raw: string): { markdown: string; cells: number; image_outputs: number } {
    let nb: { cells?: unknown; metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } } };
    try {
        nb = JSON.parse(raw);
    } catch {
        throw new CampusError("UNSUPPORTED_CONTENT", "El notebook no es JSON válido.");
    }
    if (!Array.isArray(nb.cells)) throw new CampusError("UNSUPPORTED_CONTENT", "El notebook no tiene celdas (formato no reconocido).");
    const lang = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? "python";
    const src = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");
    const parts: string[] = [];
    let images = 0;
    nb.cells.forEach((c: { cell_type?: string; source?: unknown; outputs?: unknown[] }, i: number) => {
        const body = src(c.source).replace(/\s+$/, "");
        if (c.cell_type === "markdown") parts.push(`<!-- celda ${i + 1}: markdown -->\n${body}`);
        else if (c.cell_type === "code") {
            let block = `<!-- celda ${i + 1}: código -->\n\`\`\`${lang}\n${body}\n\`\`\``;
            const outs: string[] = [];
            for (const o of (c.outputs ?? []) as { output_type?: string; text?: unknown; data?: Record<string, unknown>; ename?: string; evalue?: string }[]) {
                if (o.output_type === "stream") outs.push(src(o.text));
                else if (o.output_type === "error") outs.push(`${o.ename ?? "Error"}: ${o.evalue ?? ""}`);
                else if (o.data) {
                    if (Object.keys(o.data).some((k) => k.startsWith("image/"))) images++;
                    if (o.data["text/plain"]) outs.push(src(o.data["text/plain"]));
                }
            }
            const outText = outs.join("\n").trim();
            if (outText) block += `\nSalida (registrada en el notebook, no ejecutada):\n\`\`\`text\n${outText.length > 1500 ? outText.slice(0, 1500) + "\n[… salida recortada]" : outText}\n\`\`\``;
            parts.push(block);
        } else if (body) parts.push(`<!-- celda ${i + 1}: ${c.cell_type ?? "raw"} -->\n${body}`);
    });
    return { markdown: parts.join("\n\n"), cells: nb.cells.length, image_outputs: images };
}
