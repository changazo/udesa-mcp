import { crc32, inflateRawSync } from "node:zlib";
import { CampusError } from "../errors.js";

/**
 * Lector ZIP mínimo y defensivo, sólo en memoria (nunca escribe a disco, así que no hay riesgo de
 * path traversal). Soporta «store» y «deflate»; rechaza cifrado y ZIP64. Límites contra
 * zip bombs: cantidad de entradas, tamaño por entrada y relación de compresión; además verifica
 * CRC-32 y que la salida real no supere lo declarado.
 */
export interface ZipEntry {
    name: string;
    is_dir: boolean;
    method: number;
    encrypted: boolean;
    compressed_bytes: number;
    uncompressed_bytes: number;
    crc32: number;
    /** Offset del header local. */
    offset: number;
}

export const ZIP_LIMITS = {
    maxEntries: 5000,
    maxEntryBytes: 20 * 1024 * 1024,
    /** Relación descomprimido/comprimido a partir de la cual una entrada grande se considera sospechosa. */
    maxRatio: 200,
};

const unsupported = (msg: string) => new CampusError("UNSUPPORTED_CONTENT", msg);

export function readZipDirectory(buf: Uint8Array): ZipEntry[] {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // EOCD: firma 0x06054b50, buscada desde el final (comentario de hasta 64 KiB).
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw unsupported("El archivo no es un ZIP válido (sin directorio central).");
    const total = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw unsupported("ZIP64 no soportado.");
    if (total > ZIP_LIMITS.maxEntries) throw unsupported(`El ZIP tiene ${total} entradas; el límite es ${ZIP_LIMITS.maxEntries}.`);
    if (cdOffset + cdSize > buf.byteLength) throw unsupported("ZIP truncado o corrupto.");

    const entries: ZipEntry[] = [];
    let p = cdOffset;
    for (let n = 0; n < total; n++) {
        if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) throw unsupported("Directorio central del ZIP corrupto.");
        const flags = dv.getUint16(p + 8, true);
        const method = dv.getUint16(p + 10, true);
        const crc = dv.getUint32(p + 16, true);
        const comp = dv.getUint32(p + 20, true);
        const uncomp = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const offset = dv.getUint32(p + 42, true);
        if (comp === 0xffffffff || uncomp === 0xffffffff || offset === 0xffffffff) throw unsupported("ZIP64 no soportado.");
        const rawName = buf.subarray(p + 46, p + 46 + nameLen);
        const name = (flags & 0x800 ? new TextDecoder("utf-8") : new TextDecoder("latin1")).decode(rawName);
        entries.push({ name, is_dir: name.endsWith("/"), method, encrypted: (flags & 1) === 1, compressed_bytes: comp, uncompressed_bytes: uncomp, crc32: crc, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

export function readZipEntry(buf: Uint8Array, e: ZipEntry, maxBytes = ZIP_LIMITS.maxEntryBytes): Uint8Array {
    if (e.is_dir) throw unsupported("La entrada es una carpeta.");
    if (e.encrypted) throw unsupported("Entrada cifrada: no se puede leer.");
    if (e.uncompressed_bytes > maxBytes) throw unsupported(`La entrada descomprimida pesa ${e.uncompressed_bytes} bytes; el límite es ${maxBytes}.`);
    if (e.uncompressed_bytes > 1024 * 1024 && e.compressed_bytes > 0 && e.uncompressed_bytes / e.compressed_bytes > ZIP_LIMITS.maxRatio) {
        throw unsupported("Relación de compresión sospechosa (posible zip bomb); no se descomprime.");
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (e.offset + 30 > buf.byteLength || dv.getUint32(e.offset, true) !== 0x04034b50) throw unsupported("Header local del ZIP corrupto.");
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    const end = start + e.compressed_bytes;
    if (end > buf.byteLength) throw unsupported("ZIP truncado.");
    const data = buf.subarray(start, end);
    let out: Uint8Array;
    if (e.method === 0) {
        out = data;
    } else if (e.method === 8) {
        try {
            // maxOutputLength corta la descompresión aunque el tamaño declarado mienta.
            out = new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, e.uncompressed_bytes) }));
        } catch {
            throw unsupported("No se pudo descomprimir la entrada (corrupta o más grande que lo declarado).");
        }
    } else {
        throw unsupported(`Método de compresión ${e.method} no soportado.`);
    }
    if (out.byteLength !== e.uncompressed_bytes) throw unsupported("El tamaño descomprimido no coincide con el declarado.");
    if (crc32(out) >>> 0 !== e.crc32 >>> 0) throw unsupported("CRC inválido: la entrada está corrupta.");
    return out;
}

/** Archivos de sistema que suelen venir en ZIPs de macOS/Windows. */
export const isJunkEntry = (name: string) => /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i.test(name);
