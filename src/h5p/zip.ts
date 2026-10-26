import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * ZIP mínimo para paquetes H5P (ADR-110): escribe entradas comprimidas con deflate y lee las de un
 * paquete propio. Sin cifrado, sin ZIP64 ni comentarios: los paquetes generados pesan unos KB.
 */

export function writeZip(entries: readonly (readonly [string, string | Uint8Array])[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, data] of entries) {
        const raw = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
        const comp = deflateRawSync(raw);
        const nameBuf = Buffer.from(name, "utf8");
        const crc = crc32(raw) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt16LE(0x21, 12); // fecha fija (1980-01-01): el paquete es reproducible
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, comp);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(comp.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

/** Entradas de un ZIP (stored o deflate), por el directorio central. Para tests y relecturas. */
export function readZip(buf: Buffer, maxEntries = 200, maxBytes = 20 * 1024 * 1024): Map<string, Buffer> {
    const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (endAt < 0) throw new Error("ZIP sin directorio central");
    const count = buf.readUInt16LE(endAt + 10);
    if (count > maxEntries) throw new Error("ZIP con demasiadas entradas");
    let p = buf.readUInt32LE(endAt + 16);
    const out = new Map<string, Buffer>();
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP: directorio central inválido");
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localAt = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
        total += size;
        if (total > maxBytes) throw new Error("ZIP demasiado grande");
        const lNameLen = buf.readUInt16LE(localAt + 26);
        const lExtraLen = buf.readUInt16LE(localAt + 28);
        const data = buf.subarray(localAt + 30 + lNameLen + lExtraLen, localAt + 30 + lNameLen + lExtraLen + compSize);
        if (method === 0) out.set(name, Buffer.from(data));
        else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: size }));
        else throw new Error(`ZIP: método ${method} no soportado`);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}
