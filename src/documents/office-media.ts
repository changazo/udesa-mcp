import { createHash } from "node:crypto";
import { posix } from "node:path";
import { CampusError } from "../errors.js";
import { sniffImage } from "./formats.js";
import type { OfficeKind } from "./office.js";
import { readZipDirectory, readZipEntry, type ZipEntry } from "./zip.js";

/**
 * Imágenes de documentos Office (ADR-112): qué imágenes usa cada diapositiva (pptx), el documento
 * (docx) o cada hoja (xlsx), en orden de aparición, siguiendo SÓLO relaciones internas del paquete
 * (nunca enlaces externos). Las diapositivas van en el orden de la presentación (`presentation.xml`),
 * no por el número del archivo. No se dibuja nada: se entregan las imágenes tal como están guardadas.
 */

const MAX_XML = 15 * 1024 * 1024;
const MAX_MEDIA = 25 * 1024 * 1024;

export interface OfficeImage {
    /** Ruta dentro del paquete (`ppt/media/image3.png`). */
    path: string;
    bytes: number;
    sha256_12: string;
    /** Tipo detectado por firma; null si no es PNG/JPEG/GIF/WebP (EMF, WMF, SVG, TIFF…). */
    mime: string | null;
}

export interface OfficePart {
    /** 1, 2, 3… en el orden que ve el usuario. */
    part: number;
    /** Primera línea de texto de la parte (título probable), o el nombre de la hoja. */
    title: string | null;
    images: string[];
}

export interface OfficeMedia {
    kind: OfficeKind;
    parts: OfficePart[];
    images: Map<string, OfficeImage>;
    /** Bytes de una imagen del paquete (sólo las listadas). */
    read(path: string): Uint8Array;
}

const text = (zip: Uint8Array, entries: ZipEntry[], name: string): string | null => {
    const e = entries.find((x) => x.name === name);
    return e ? new TextDecoder("utf-8").decode(readZipEntry(zip, e, MAX_XML)) : null;
};

/** Relaciones de una parte: id → destino absoluto dentro del paquete (sólo internas). */
export function relsOf(zip: Uint8Array, entries: ZipEntry[], part: string): Map<string, { target: string; type: string }> {
    const relsPath = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
    const xml = text(zip, entries, relsPath) ?? "";
    const out = new Map<string, { target: string; type: string }>();
    for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const a = m[1]!;
        const id = /\bId="([^"]+)"/.exec(a)?.[1];
        const target = /\bTarget="([^"]+)"/.exec(a)?.[1];
        const type = /\bType="([^"]+)"/.exec(a)?.[1] ?? "";
        if (!id || !target || /\bTargetMode="External"/.test(a)) continue;
        const abs = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target));
        if (abs.startsWith("..")) continue;
        out.set(id, { target: abs, type });
    }
    return out;
}

/** Imágenes referenciadas por una parte, en orden de aparición (r:embed / r:id / r:link internos). */
function imagesOf(zip: Uint8Array, entries: ZipEntry[], part: string, xml: string): string[] {
    const rels = relsOf(zip, entries, part);
    const out: string[] = [];
    for (const m of xml.matchAll(/\br:(?:embed|id|link)="([^"]+)"/g)) {
        const r = rels.get(m[1]!);
        if (r && /\/image$/.test(r.type) && !out.includes(r.target)) out.push(r.target);
    }
    return out;
}

const firstLine = (xml: string, tag: string) => {
    const t = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => m[1]!.trim()).find(Boolean);
    return t ? t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').slice(0, 120) : null;
};

/** Diapositivas en el orden de la presentación (si falta presentation.xml, por número de archivo). */
export function pptxSlideOrder(zip: Uint8Array, entries: ZipEntry[]): string[] {
    const pres = text(zip, entries, "ppt/presentation.xml");
    if (pres) {
        const rels = relsOf(zip, entries, "ppt/presentation.xml");
        const ordered = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => rels.get(m[1]!)?.target).filter((t): t is string => !!t && entries.some((e) => e.name === t));
        if (ordered.length) return ordered;
    }
    return entries
        .map((e) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name))
        .filter((m): m is RegExpExecArray => m !== null)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((m) => m[0]);
}

export function extractOfficeMedia(bytes: Uint8Array, kind: OfficeKind): OfficeMedia {
    const entries = readZipDirectory(bytes);
    let parts: OfficePart[];
    if (kind === "pptx") {
        const slides = pptxSlideOrder(bytes, entries);
        if (!slides.length) throw new CampusError("UNSUPPORTED_CONTENT", "El .pptx no tiene diapositivas reconocibles.");
        parts = slides.map((s, i) => {
            const xml = text(bytes, entries, s) ?? "";
            return { part: i + 1, title: firstLine(xml, "a:t"), images: imagesOf(bytes, entries, s, xml) };
        });
    } else if (kind === "docx") {
        const xml = text(bytes, entries, "word/document.xml");
        if (xml === null) throw new CampusError("UNSUPPORTED_CONTENT", "El .docx no tiene word/document.xml.");
        parts = [{ part: 1, title: firstLine(xml, "w:t"), images: imagesOf(bytes, entries, "word/document.xml", xml) }];
    } else {
        const wb = text(bytes, entries, "xl/workbook.xml") ?? "";
        const wbRels = relsOf(bytes, entries, "xl/workbook.xml");
        const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({ name: /\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? null, target: wbRels.get(/\br:id="([^"]+)"/.exec(m[1]!)?.[1] ?? "")?.target }));
        parts = sheets.map((s, i) => {
            const images: string[] = [];
            if (s.target) {
                const sheetXml = text(bytes, entries, s.target) ?? "";
                const rels = relsOf(bytes, entries, s.target);
                for (const m of sheetXml.matchAll(/<drawing\b[^>]*\br:id="([^"]+)"/g)) {
                    const d = rels.get(m[1]!);
                    if (!d) continue;
                    const dxml = text(bytes, entries, d.target) ?? "";
                    for (const img of imagesOf(bytes, entries, d.target, dxml)) if (!images.includes(img)) images.push(img);
                }
            }
            return { part: i + 1, title: s.name, images };
        });
    }
    const images = new Map<string, OfficeImage>();
    const cache = new Map<string, Uint8Array>();
    const read = (path: string): Uint8Array => {
        const hit = cache.get(path);
        if (hit) return hit;
        const e = entries.find((x) => x.name === path);
        if (!e) throw new CampusError("UNSUPPORTED_CONTENT", `El paquete no tiene ${path}.`);
        const data = readZipEntry(bytes, e, MAX_MEDIA);
        cache.set(path, data);
        return data;
    };
    for (const p of parts) {
        for (const path of p.images) {
            if (images.has(path)) continue;
            const e = entries.find((x) => x.name === path);
            if (!e) continue;
            const data = read(path);
            images.set(path, { path, bytes: data.byteLength, sha256_12: createHash("sha256").update(data).digest("hex").slice(0, 12), mime: sniffImage(data) });
        }
        p.images = p.images.filter((x) => images.has(x));
    }
    return { kind, parts, images, read };
}
