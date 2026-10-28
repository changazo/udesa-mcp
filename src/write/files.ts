import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { CampusError } from "../errors.js";

/**
 * Archivos de los planes (directiva §8.12, ADR-057). Sólo los que el humano indicó con una ruta local
 * explícita: nunca archivos «encontrados». El plan guarda ruta, nombre, tamaño y hash; el contenido se
 * lee recién al ejecutar y tiene que coincidir con el hash (si cambió, PLAN_STALE y no se sube nada).
 */
export interface PlanFile {
    path: string;
    filename: string;
    size: number;
    sha256: string;
    /** Archivo GENERADO por el servidor (ADR-110): viaja en el plan firmado, en base64. Sin ruta local. */
    inline_base64?: string;
    /** Archivo que entregó el cliente (ChatGPT): los bytes viven en el almacén con vencimiento corto, por hash. */
    blob?: boolean;
}

/** Describe un archivo generado por el servidor (por ejemplo, un paquete H5P): va dentro del plan. */
export function describeGeneratedFile(filename: string, data: Buffer, maxBytes: number): PlanFile {
    if (!SAFE_NAME.test(filename) || filename.startsWith(".")) throw new CampusError("WRITE_NOT_ALLOWED", `Nombre de archivo no admitido: ${filename}.`);
    if (!data.length) throw new CampusError("WRITE_NOT_ALLOWED", `El archivo ${filename} está vacío.`);
    if (data.length > maxBytes) throw new CampusError("WRITE_NOT_ALLOWED", `${filename} pesa ${data.length} bytes y el máximo es ${maxBytes}.`);
    return { path: "(generado)", filename, size: data.length, sha256: sha256(data), inline_base64: data.toString("base64") };
}

export const MAX_PLAN_FILES = 10;
export const SAFE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,200}$/;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Valida y describe los archivos de un plan. `maxBytes` por archivo; `maxFiles` del foro (0 = sin dato). */
export function describeLocalFiles(paths: readonly string[], maxBytes: number, maxFiles: number): PlanFile[] {
    if (paths.length > MAX_PLAN_FILES) throw new CampusError("WRITE_NOT_ALLOWED", `Como máximo ${MAX_PLAN_FILES} archivos por plan.`);
    if (maxFiles > 0 && paths.length > maxFiles) throw new CampusError("WRITE_NOT_ALLOWED", `El foro admite ${maxFiles} adjunto(s) por post: Moodle descartaría el resto en silencio.`);
    const out: PlanFile[] = [];
    for (const p of paths) {
        if (!isAbsolute(p)) throw new CampusError("WRITE_NOT_ALLOWED", `Ruta no absoluta: ${p}. Indicá la ruta completa del archivo.`);
        let st;
        try {
            st = statSync(p);
        } catch {
            throw new CampusError("WRITE_NOT_ALLOWED", `No existe o no se puede leer: ${p}.`);
        }
        if (!st.isFile()) throw new CampusError("WRITE_NOT_ALLOWED", `No es un archivo: ${p}.`);
        const filename = basename(p);
        if (!SAFE_NAME.test(filename) || filename.startsWith(".")) throw new CampusError("WRITE_NOT_ALLOWED", `Nombre de archivo no admitido: ${filename}.`);
        if (out.some((f) => f.filename.toLowerCase() === filename.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `Dos archivos se llaman ${filename}: Moodle no sobrescribe y descartaría uno.`);
        if (st.size === 0) throw new CampusError("WRITE_NOT_ALLOWED", `El archivo ${filename} está vacío.`);
        if (st.size > maxBytes) throw new CampusError("WRITE_NOT_ALLOWED", `${filename} pesa ${st.size} bytes y el máximo es ${maxBytes}: Moodle lo descartaría.`);
        out.push({ path: p, filename, size: st.size, sha256: sha256(readFileSync(p)) });
    }
    return out;
}

/**
 * Contenido de los archivos tal como se planificaron; si alguno cambió, PLAN_STALE. Los `blob` llegan
 * con `inline_base64` cargado por el motor desde el almacén; si ya venció, cuentan como cambiados.
 */
export function loadPlanFiles(files: readonly PlanFile[]): { filename: string; data: Buffer }[] {
    const changed: string[] = [];
    const out = files.map((f) => {
        let data: Buffer;
        try {
            if (f.blob && f.inline_base64 === undefined) throw new Error("vencido");
            data = f.inline_base64 !== undefined ? Buffer.from(f.inline_base64, "base64") : readFileSync(f.path);
        } catch {
            changed.push(f.filename);
            return { filename: f.filename, data: Buffer.alloc(0) };
        }
        if (data.length !== f.size || sha256(data) !== f.sha256) changed.push(f.filename);
        return { filename: f.filename, data };
    });
    if (changed.length) {
        throw new CampusError("PLAN_STALE", `Los archivos del plan cambiaron o ya no están (${changed.join(", ")}): no se subió ni escribió nada. Volvé a planificar.`, { details: { changed } });
    }
    return out;
}
