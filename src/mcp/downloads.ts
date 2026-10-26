import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CampusError } from "../errors.js";

/**
 * Entrega del archivo original de campus_get_original_file (ADR-112):
 * - servidor local: se guarda en una carpeta del usuario (por defecto `~/Downloads/udesa-campus-mcp`,
 *   o `CAMPUS_DOWNLOAD_DIR`) y se devuelve la ruta, para abrirlo con herramientas locales;
 * - remoto (o si se pide): va como recurso incrustado del MCP, con un tope de tamaño.
 * Nunca se sobrescribe un archivo distinto: se agrega « (2)», « (3)»…; uno idéntico se reutiliza.
 */

export const INLINE_MAX_BYTES = 8 * 1024 * 1024;
/** Incrustado automático en el remoto: ChatGPT trunca contenidos base64 de más de ~2,5 MB. */
export const INLINE_AUTO_BYTES = 2_500_000;

export function defaultDownloadDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.CAMPUS_DOWNLOAD_DIR || join(homedir(), "Downloads", "udesa-campus-mcp");
}

/** Nombre de archivo seguro (sin rutas, controles ni reservados de Windows). */
export function safeFileName(name: string): string {
    let n = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 150);
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
    return n || "archivo";
}

export function saveDownload(dir: string, courseId: number, name: string, data: Uint8Array): { path: string; reused: boolean } {
    const folder = join(dir, String(courseId));
    mkdirSync(folder, { recursive: true });
    const safe = safeFileName(name);
    const dot = safe.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
    const hash = createHash("sha256").update(data).digest("hex");
    for (let i = 1; i < 1000; i++) {
        const p = join(folder, i === 1 ? safe : `${stem} (${i})${ext}`);
        if (!existsSync(p)) {
            writeFileSync(p, data, { flag: "wx" });
            return { path: p, reused: false };
        }
        if (createHash("sha256").update(readFileSync(p)).digest("hex") === hash) return { path: p, reused: true };
    }
    throw new CampusError("UNEXPECTED_RESPONSE", "No se pudo elegir un nombre libre para guardar el archivo.");
}
