import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { CampusError } from "../errors.js";

/**
 * Retorno automático del login por navegador.
 *
 * 1. Un esquema propio (p. ej. `udesacampusmcp`) se registra SÓLO para el usuario actual de Windows
 *    (HKCU\Software\Classes\<esquema>): al abrirse `<esquema>://token=…`, Windows ejecuta
 *    `node <cli.js> auth callback "<enlace>"`.
 * 2. Ese proceso entrega el enlace por un canal local (named pipe del usuario) al `auth login` que
 *    está esperando, y termina. No lo guarda, no lo muestra, no lo loguea.
 * 3. El login lo valida igual que un pegado manual (hash con el passport de ESE intento, vencimiento,
 *    uso único, identidad). Mandar cualquier cosa al canal no sirve sin ese passport.
 *
 * Nunca se registra el esquema de la app oficial (`moodlemobile`).
 */

const MAX_MESSAGE = 4096;
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** Nombre del canal: propio del usuario del sistema (no adivinable entre usuarios, no secreto). */
export function callbackChannel(scheme: string): string {
    const tag = createHash("sha256").update(`${userInfo().username}|${scheme}`).digest("hex").slice(0, 16);
    return process.platform === "win32" ? `\\\\.\\pipe\\udesa-campus-mcp-${tag}` : join(tmpdir(), `udesa-campus-mcp-${tag}.sock`);
}

/** Espera UN mensaje en el canal. Se cierra al recibirlo, al abortar o si falla. */
export function waitForCallback(scheme: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        let server: Server | null = null;
        const close = () => {
            server?.close();
            server = null;
        };
        signal.addEventListener("abort", () => {
            close();
            reject(new CampusError("BROWSER_CALLBACK_REJECTED", "Espera del retorno cancelada."));
        }, { once: true });
        server = createServer((sock) => {
            let buf = "";
            sock.setEncoding("utf8");
            // Protocolo de una línea: «<enlace>LF» → «okLF». Sin medio-cierre (frágil en named pipes).
            sock.on("data", (d: string) => {
                buf += d;
                if (buf.length > MAX_MESSAGE) return void sock.destroy();
                const nl = buf.indexOf(LF);
                if (nl < 0) return;
                const line = buf.slice(0, nl).trim();
                if (!line) return void sock.destroy();
                sock.end(`ok${LF}`);
                close();
                resolve(line);
            });
            sock.on("error", () => {});
        });
        server.on("error", (e: NodeJS.ErrnoException) => {
            close();
            reject(
                new CampusError(
                    "BROWSER_CALLBACK_REJECTED",
                    e.code === "EADDRINUSE" ? "Ya hay otro login por navegador esperando el retorno." : "No se pudo abrir el canal local del retorno.",
                ),
            );
        });
        server.listen(callbackChannel(scheme));
    });
}

/** Entrega el enlace al login que espera. Usado por `auth callback` (lo invoca Windows). */
export function sendCallback(scheme: string, url: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
        if (url.length > MAX_MESSAGE || url.includes(LF) || url.includes(CR)) return reject(new CampusError("BROWSER_CALLBACK_REJECTED", "Retorno demasiado largo o inválido."));
        const sock = createConnection(callbackChannel(scheme));
        const timer = setTimeout(() => {
            sock.destroy();
            reject(new CampusError("BROWSER_CALLBACK_REJECTED", "El login no respondió a tiempo."));
        }, timeoutMs);
        let ack = "";
        sock.setEncoding("utf8");
        sock.on("connect", () => sock.write(`${url}${LF}`));
        sock.on("data", (d: string) => (ack += d));
        sock.on("close", () => {
            clearTimeout(timer);
            if (ack.trim() === "ok") resolve();
            else reject(new CampusError("BROWSER_CALLBACK_REJECTED", "El login no confirmó la recepción."));
        });
        sock.on("error", () => {
            clearTimeout(timer);
            reject(new CampusError("BROWSER_CALLBACK_REJECTED", "No hay ningún login por navegador esperando el retorno."));
        });
    });
}

// ---------- Registro del esquema en Windows (sólo usuario actual) ----------

export function registryKey(scheme: string): string {
    return `HKCU\\Software\\Classes\\${scheme}`;
}

/** Comando que Windows ejecuta al abrir el esquema. `%1` es el enlace completo. */
export function handlerCommand(nodePath: string, cliPath: string, scheme: string): string {
    return `"${nodePath}" "${cliPath}" auth callback --scheme ${scheme} "%1"`;
}

/** Argumentos de `reg.exe` para instalar (sin shell: no hay interpretación de comandos). */
export function installArgs(scheme: string, nodePath: string, cliPath: string): string[][] {
    const key = registryKey(scheme);
    return [
        ["add", key, "/ve", "/d", "URL:UdeSA Campus MCP (retorno de login)", "/f"],
        ["add", key, "/v", "URL Protocol", "/d", "", "/f"],
        ["add", `${key}\\shell\\open\\command`, "/ve", "/d", handlerCommand(nodePath, cliPath, scheme), "/f"],
    ];
}

export function assertCustomScheme(scheme: string): void {
    if (!/^[a-z][a-z0-9+.-]{2,40}$/.test(scheme) || scheme === "moodlemobile") {
        throw new CampusError("POLICY_DENIED", "Esquema inválido o reservado (no se registra el de la app oficial).");
    }
}

function reg(args: string[]): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
        const p = spawn("reg", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        p.stdout.on("data", (d) => (out += String(d)));
        p.stderr.on("data", (d) => (out += String(d)));
        p.on("error", () => resolve({ code: -1, out: "reg.exe no disponible" }));
        p.on("close", (code) => resolve({ code: code ?? -1, out }));
    });
}

function requireWindows() {
    if (process.platform !== "win32") throw new CampusError("CONFIG_INVALID", "El retorno automático sólo está implementado para Windows. Usá el pegado manual.");
}

export async function installHandler(scheme: string, nodePath: string, cliPath: string): Promise<void> {
    requireWindows();
    assertCustomScheme(scheme);
    for (const args of installArgs(scheme, nodePath, cliPath)) {
        const r = await reg(args);
        if (r.code !== 0) throw new CampusError("CONFIG_INVALID", `No se pudo registrar el esquema (reg ${args[0]}): ${r.out.trim().slice(0, 200)}`);
    }
}

export async function uninstallHandler(scheme: string): Promise<boolean> {
    requireWindows();
    assertCustomScheme(scheme);
    const r = await reg(["delete", registryKey(scheme), "/f"]);
    return r.code === 0;
}

/** Comando registrado actualmente para el esquema, o null si no está instalado. */
export async function handlerStatus(scheme: string): Promise<string | null> {
    if (process.platform !== "win32") return null;
    assertCustomScheme(scheme);
    const r = await reg(["query", `${registryKey(scheme)}\\shell\\open\\command`, "/ve"]);
    if (r.code !== 0) return null;
    const m = /REG_SZ\s+(.+)\s*$/m.exec(r.out);
    return m ? m[1]!.trim() : null;
}
