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

/**
 * Vista previa de HTML como imagen (ADR-140), SÓLO en el servidor local: Chrome o Edge sin interfaz
 * (`--headless=new --screenshot`), con perfil temporal propio, sin JavaScript (CSP) y sin red. El HTML se
 * escribe en una carpeta temporal que se borra al terminar. El navegador se busca en el sistema (o en
 * CAMPUS_CHROME_PATH); sin él, no hay vista previa.
 */

const CHROME_TIMEOUT_MS = 30_000;

/** Rutas habituales de Chrome, Edge y Chromium por sistema (las variables de entorno de Windows, si están). */
export function chromeCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
    if (platform === "win32") {
        const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA, "C:/Program Files", "C:/Program Files (x86)"].filter((x): x is string => !!x);
        return [...new Set([...roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe")), ...roots.map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe"))])];
    }
    if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
    return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
}

/** Busca Chrome o Edge: CAMPUS_CHROME_PATH, las rutas habituales y, por último, el PATH. */
export function findChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | null {
    for (const c of [env.CAMPUS_CHROME_PATH, ...chromeCandidates(env, platform)]) if (c && exists(c)) return c;
    const names = platform === "win32" ? ["chrome", "msedge"] : platform === "darwin" ? [] : ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"];
    for (const n of names) {
        const w = which(n);
        if (w && exists(w)) return w;
    }
    return null;
}

/** Proceso mínimo que usa el render (permite probar la invocación sin Chrome). */
export interface SpawnedProcess {
    on(event: "error", fn: (e: Error) => void): unknown;
    on(event: "close", fn: (code: number | null) => void): unknown;
    kill(): unknown;
}
export type SpawnFn = (cmd: string, args: string[], opts: { stdio: "ignore"; windowsHide: boolean }) => SpawnedProcess;

export interface HtmlShot {
    png: Buffer;
    /** Si la carpeta temporal (HTML, perfil y captura) se pudo borrar. */
    temp_removed: boolean;
}

export interface HtmlRenderer {
    /** Nombre del navegador (chrome, msedge…), para el informe. */
    browser: string;
    screenshot(html: string, size: { width: number; height: number }): Promise<HtmlShot>;
}

/** Argumentos de Chrome: sin interfaz, sin red, perfil temporal, sin extensiones ni sincronización. */
export function chromeArgs(profileDir: string, out: string, url: string, size: { width: number; height: number }): string[] {
    return [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-background-networking",
        "--disable-component-update",
        "--mute-audio",
        // Sin red: ningún nombre resuelve y el proxy no existe. JavaScript lo bloquea la CSP de la página
        // (script-src 'none'); --blink-settings=scriptEnabled=false impide que Chrome guarde la captura.
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--proxy-server=http://127.0.0.1:9",
        `--user-data-dir=${profileDir}`,
        `--window-size=${size.width},${size.height}`,
        "--virtual-time-budget=1500",
        `--screenshot=${out}`,
        url,
    ];
}

/** Captura un HTML con Chrome/Edge sin interfaz. `spawnFn` se reemplaza en los tests. */
export function chromeRenderer(chrome: string, spawnFn: SpawnFn = spawn as unknown as SpawnFn): HtmlRenderer {
    const browser = (/([^\\/]+?)(\.exe)?$/i.exec(chrome)?.[1] ?? "chrome").toLowerCase();
    return {
        browser,
        async screenshot(html, size) {
            const dir = mkdtempSync(join(tmpdir(), "campus-vista-"));
            let png: Buffer | null = null;
            try {
                const page = join(dir, "vista.html");
                const out = join(dir, "captura.png");
                writeFileSync(page, html, "utf8");
                const args = chromeArgs(join(dir, "perfil"), out, pathToFileURL(page).href, size);
                const code = await new Promise<number | null>((resolve, reject) => {
                    const p = spawnFn(chrome, args, { stdio: "ignore", windowsHide: true });
                    const t = setTimeout(() => {
                        p.kill();
                        reject(new CampusError("UNSUPPORTED_CONTENT", `La vista previa tardó más de ${CHROME_TIMEOUT_MS / 1000} s y se canceló.`));
                    }, CHROME_TIMEOUT_MS);
                    p.on("error", (e) => {
                        clearTimeout(t);
                        reject(new CampusError("UNSUPPORTED_CONTENT", `No se pudo ejecutar ${browser}: ${e.message}`));
                    });
                    p.on("close", (c) => {
                        clearTimeout(t);
                        resolve(c);
                    });
                });
                // Algunas versiones terminan con código distinto de 0 aunque la captura esté: vale el archivo.
                if (!existsSync(out)) throw new CampusError("UNSUPPORTED_CONTENT", `${browser} no generó la captura (código ${code}).`);
                png = readFileSync(out);
            } finally {
                // En Windows el navegador puede tardar un instante en soltar el perfil.
                try {
                    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
                } catch {
                    /* se informa con temp_removed */
                }
            }
            return { png: png!, temp_removed: !existsSync(dir) };
        },
    };
}
