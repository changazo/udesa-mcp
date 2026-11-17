import { deflateSync, inflateSync } from "node:zlib";

/**
 * PNG mínimo para recortar capturas (ADR-140): decodifica PNG de 8 bits RGB o RGBA sin entrelazar (lo
 * que generan Chrome y Edge), busca una franja de color marcador y vuelve a codificar. Otro formato no
 * se toca (decodePng devuelve null).
 */

export interface RawPng {
    width: number;
    height: number;
    /** 3 (RGB) o 4 (RGBA). */
    channels: 3 | 4;
    /** Filas sin filtro, width * channels bytes cada una. */
    data: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngSize(buf: Buffer): { width: number; height: number } | null {
    if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function decodePng(buf: Buffer): RawPng | null {
    if (!pngSize(buf)) return null;
    let pos = 8;
    let width = 0;
    let height = 0;
    let channels: 3 | 4 | null = null;
    const idat: Buffer[] = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString("latin1", pos + 4, pos + 8);
        const body = buf.subarray(pos + 8, pos + 8 + len);
        if (type === "IHDR") {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            const depth = body[8];
            const color = body[9];
            const interlace = body[12];
            if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return null;
            channels = color === 6 ? 4 : 3;
        } else if (type === "IDAT") idat.push(body);
        else if (type === "IEND") break;
        pos += 12 + len;
    }
    if (!channels || !width || !height) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < height * (stride + 1)) return null;
    const out = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)]!;
        const src = y * (stride + 1) + 1;
        const dst = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? out[dst + x - channels]! : 0;
            const b = y > 0 ? out[dst - stride + x]! : 0;
            const c = x >= channels && y > 0 ? out[dst - stride + x - channels]! : 0;
            const v = raw[src + x]!;
            let r: number;
            if (f === 0) r = v;
            else if (f === 1) r = v + a;
            else if (f === 2) r = v + b;
            else if (f === 3) r = v + ((a + b) >> 1);
            else if (f === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            } else return null;
            out[dst + x] = r & 0xff;
        }
    }
    return { width, height, channels, data: out };
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(b: Buffer): number {
    let c = 0xffffffff;
    for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
}

export function encodePng(p: RawPng): Buffer {
    const stride = p.width * p.channels;
    const raw = Buffer.alloc(p.height * (stride + 1));
    for (let y = 0; y < p.height; y++) {
        // Filtro Sub: las capturas tienen muchas franjas horizontales del mismo color.
        const dst = y * (stride + 1);
        raw[dst] = 1;
        for (let x = 0; x < stride; x++) raw[dst + 1 + x] = (p.data[y * stride + x]! - (x >= p.channels ? p.data[y * stride + x - p.channels]! : 0)) & 0xff;
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(p.width, 0);
    ihdr.writeUInt32BE(p.height, 4);
    ihdr[8] = 8;
    ihdr[9] = p.channels === 4 ? 6 : 2;
    return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const isColor = (p: RawPng, x: number, y: number, rgb: readonly [number, number, number]) => {
    const i = (y * p.width + x) * p.channels;
    return p.data[i] === rgb[0] && p.data[i + 1] === rgb[1] && p.data[i + 2] === rgb[2];
};

/**
 * Primera fila de la franja marcadora (ancho completo, color exacto), buscando desde abajo; -1 si no está.
 * Se miran el borde izquierdo, el centro y el borde derecho de cada fila.
 */
export function findMarkerTop(p: RawPng, rgb: readonly [number, number, number]): number {
    const xs = [0, Math.floor(p.width / 2), p.width - 1];
    const row = (y: number) => xs.every((x) => isColor(p, x, y, rgb));
    for (let y = p.height - 1; y >= 0; y--) {
        if (!row(y)) continue;
        while (y > 0 && row(y - 1)) y--;
        return y;
    }
    return -1;
}

export function cropRows(p: RawPng, height: number): RawPng {
    const h = Math.max(1, Math.min(height, p.height));
    return { ...p, height: h, data: p.data.subarray(0, h * p.width * p.channels) };
}
