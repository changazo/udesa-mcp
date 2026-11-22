import { spawn } from "node:child_process";
import { CampusError } from "../errors.js";

/**
 * Portapapeles de Windows para `auth web import --clipboard` (ADR-142). Lo usa sólo la CLI del humano:
 * el valor nunca se muestra, se valida contra el Campus y el portapapeles se vacía después, también si
 * la validación falla. El historial de Windows (Win+V) y su sincronización no se pueden borrar desde acá:
 * la CLI lo advierte en lugar de prometerlo.
 */
export interface Clipboard {
    read(): Promise<string>;
    clear(): Promise<void>;
}

function powershell(script: string, timeoutMs = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
        // Sin shell y con -NoProfile: el script es fijo, nada del usuario se interpreta como comando.
        const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => p.kill(), timeoutMs);
        p.stdout.on("data", (c: Buffer) => chunks.push(c));
        p.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        p.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
            else reject(new Error(`powershell salió con ${code}`));
        });
    });
}

export function windowsClipboard(platform: NodeJS.Platform = process.platform): Clipboard {
    const unsupported = () => new CampusError("CONFIG_INVALID", "--clipboard sólo funciona en Windows. Usá la entrada oculta (sin --clipboard).");
    return {
        async read() {
            if (platform !== "win32") throw unsupported();
            // UTF-8 explícito para que la salida no dependa de la página de códigos de la consola.
            return powershell("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $v = Get-Clipboard -Raw; if ($v) { [Console]::Out.Write($v) }");
        },
        async clear() {
            if (platform !== "win32") return;
            await powershell("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()");
        },
    };
}

export const CLIPBOARD_HISTORY_WARNING =
    "Vaciar el portapapeles no borra el historial de Windows (Win+V) ni su sincronización en la nube: si los tenés activos, borrá esa entrada a mano (Win+V → … → Eliminar) o usá la entrada oculta (sin --clipboard).";
