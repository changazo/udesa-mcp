import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CampusError } from "../errors.js";

/**
 * Páginas como imágenes (ADR-112), SÓLO en el servidor local y si el usuario lo pide (`render`):
 * Office → PDF con LibreOffice (perfil temporal propio, sin macros, con tiempo límite) y PDF → PNG
 * con pdftoppm o Ghostscript. Todo en una carpeta temporal que se borra. Los programas se buscan en
 * el sistema (o en CAMPUS_SOFFICE / CAMPUS_PDFTOPPM / CAMPUS_GHOSTSCRIPT); sin ellos, no hay render.
 */

export interface Renderer {
    soffice: string | null;
    raster: { kind: "pdftoppm" | "gs"; path: string } | null;
}

const TIMEOUT_MS = 120_000;

function which(cmd: string): string | null {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
    const first = r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l.trim()) : undefined;
    return first?.trim() || null;
}

/** Busca LibreOffice y un rasterizador de PDF. */
export function findRenderer(env: NodeJS.ProcessEnv = process.env): Renderer {
    const pick = (...c: (string | null | undefined)[]) => c.find((x): x is string => !!x && existsSync(x)) ?? null;
    const soffice = pick(env.CAMPUS_SOFFICE, which("soffice"), "C:/Program Files/LibreOffice/program/soffice.com", "C:/Program Files/LibreOffice/program/soffice.exe", "/Applications/LibreOffice.app/Contents/MacOS/soffice", "/usr/bin/soffice");
    const pdftoppm = pick(env.CAMPUS_PDFTOPPM, which("pdftoppm"));
    const gs = pick(env.CAMPUS_GHOSTSCRIPT, which("gswin64c"), which("gs"));
    return { soffice, raster: pdftoppm ? { kind: "pdftoppm", path: pdftoppm } : gs ? { kind: "gs", path: gs } : null };
}

function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
        const t = setTimeout(() => {
            p.kill();
            reject(new CampusError("UNSUPPORTED_CONTENT", `La conversión tardó más de ${TIMEOUT_MS / 1000} s y se canceló.`));
        }, TIMEOUT_MS);
        p.on("error", (e) => {
            clearTimeout(t);
            reject(new CampusError("UNSUPPORTED_CONTENT", `No se pudo ejecutar el conversor: ${e.message}`));
        });
        p.on("close", (code) => {
            clearTimeout(t);
            if (code === 0) resolve();
            else reject(new CampusError("UNSUPPORTED_CONTENT", `El conversor terminó con código ${code}.`));
        });
    });
}

/** PDF convertidos recientemente (por hash del original): convertir una presentación tarda segundos. */
const PDF_CACHE = new Map<string, Buffer>();

/** PDF del archivo: el mismo si ya es PDF; si no, convertido con LibreOffice. */
export async function toPdf(r: Renderer, data: Uint8Array, name: string): Promise<Buffer> {
    if (/\.pdf$/i.test(name) || Buffer.from(data.subarray(0, 5)).toString("latin1") === "%PDF-") return Buffer.from(data);
    if (!/\.(pptx?|docx?|xlsx?|odt|odp|ods|rtf)$/i.test(name)) throw new CampusError("UNSUPPORTED_CONTENT", `Render: sólo PDF y documentos de oficina (${name}).`);
    if (!r.soffice) throw new CampusError("UNSUPPORTED_CONTENT", "Render de documentos de oficina: LibreOffice no está instalado en esta computadora (o definí CAMPUS_SOFFICE).");
    const key = createHash("sha256").update(data).digest("hex");
    const hit = PDF_CACHE.get(key);
    if (hit) return hit;
    const dir = mkdtempSync(join(tmpdir(), "campus-render-"));
    try {
        const ext = /\.[a-z]+$/i.exec(name)![0].toLowerCase();
        const input = join(dir, `documento${ext}`);
        writeFileSync(input, data);
        // Perfil temporal: no toca el LibreOffice del usuario y arranca con la seguridad de macros por defecto (no las ejecuta).
        await run(r.soffice, ["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=${pathToFileURL(join(dir, "perfil")).href}`, "--convert-to", "pdf", "--outdir", dir, input]);
        const pdf = join(dir, "documento.pdf");
        if (!existsSync(pdf)) throw new CampusError("UNSUPPORTED_CONTENT", "LibreOffice no generó el PDF.");
        const out = readFileSync(pdf);
        PDF_CACHE.set(key, out);
        if (PDF_CACHE.size > 4) PDF_CACHE.delete(PDF_CACHE.keys().next().value!);
        return out;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** PNG de las páginas `first..last` (1-based) del PDF, a `dpi` puntos por pulgada. */
export async function rasterize(r: Renderer, pdf: Buffer, first: number, last: number, dpi = 80): Promise<Buffer[]> {
    if (!r.raster) throw new CampusError("UNSUPPORTED_CONTENT", "Render: falta pdftoppm (Poppler) o Ghostscript en esta computadora (o definí CAMPUS_PDFTOPPM / CAMPUS_GHOSTSCRIPT).");
    const dir = mkdtempSync(join(tmpdir(), "campus-raster-"));
    try {
        const input = join(dir, "documento.pdf");
        writeFileSync(input, pdf);
        if (r.raster.kind === "pdftoppm") await run(r.raster.path, ["-png", "-r", String(dpi), "-f", String(first), "-l", String(last), input, join(dir, "p")]);
        else await run(r.raster.path, ["-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=png16m", `-r${dpi}`, `-dFirstPage=${first}`, `-dLastPage=${last}`, `-sOutputFile=${join(dir, "p-%04d.png")}`, input]);
        return readdirSync(dir)
            .filter((f) => /^p-\d+\.png$/.test(f))
            .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
            .map((f) => readFileSync(join(dir, f)));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
