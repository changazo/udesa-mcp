import { spawn } from "node:child_process";
import type { App } from "../app.js";
import type { Profile } from "../config/profile.js";
import { CampusError } from "../errors.js";
import { cliCommand } from "../util/cli-command.js";
import type { LocalConnection } from "../web/local-connection.js";
import { startLocalPanel } from "../web/local-panel.js";
import { parseCookieInput } from "../web/session.js";
import { CLIPBOARD_HISTORY_WARNING, windowsClipboard, type Clipboard } from "./clipboard.js";

/** Comandos de la conexión web de esta PC que corre el humano: importar la cookie y abrir el panel (ADR-142). */

export interface WebLocalOptions {
    clipboard?: boolean;
    open?: boolean;
    noOpen?: boolean;
    clipboardImpl?: Clipboard;
    /** Entrada oculta (o stdin) de la cookie, sin --clipboard. */
    readHidden?: () => Promise<string>;
    /** Con --open y --clipboard: esperar a que el humano copie el valor. */
    waitEnter?: () => Promise<void>;
    openUrl?: (url: string) => void;
    out?: (s: string) => void;
    err?: (s: string) => void;
}

const defaultOut = (s: string) => process.stdout.write(`${s}
`);
const defaultErr = (s: string) => process.stderr.write(`${s}
`);

export function openInBrowser(url: string) {
    // Sin shell: la URL no se interpreta como comando.
    spawn(process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open", process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { detached: true, stdio: "ignore" }).unref();
}

/**
 * `auth web import`: respaldo del login automático (ADR-142). La cookie se valida contra el Campus (sesión
 * de la cuenta esperada) y se publica en el registro de esta PC con generación nueva. Con `--clipboard`, el
 * portapapeles se vacía también si la validación falla; el valor nunca se muestra.
 */
export async function webImport(app: App, conn: LocalConnection, profile: Pick<Profile, "site_url" | "profile_id">, o: WebLocalOptions): Promise<number> {
    const out = o.out ?? defaultOut;
    const err = o.err ?? defaultErr;
    if (o.open) {
        (o.openUrl ?? openInBrowser)(profile.site_url);
        out(`Se abrió el Campus en tu navegador. F12 → Application → Cookies → ${profile.site_url} → copiá el Value de MoodleSession.`);
    }
    let raw: string;
    if (o.clipboard) {
        const clip = o.clipboardImpl ?? windowsClipboard();
        if (o.open) await o.waitEnter?.();
        try {
            raw = await clip.read();
        } catch (e) {
            await clip.clear().catch(() => undefined);
            throw e instanceof CampusError ? e : new CampusError("CONFIG_INVALID", "No se pudo leer el portapapeles. Usá la entrada oculta (sin --clipboard).");
        }
        try {
            if (!raw.trim()) throw new CampusError("CONFIG_INVALID", "El portapapeles está vacío: copiá el valor de MoodleSession y repetí el comando.");
            return await importValidated(app, conn, raw, out);
        } finally {
            await clip.clear().catch(() => err("Aviso: no se pudo vaciar el portapapeles; vacialo a mano."));
            err(CLIPBOARD_HISTORY_WARNING);
        }
    }
    if (!o.readHidden) throw new CampusError("CONFIG_INVALID", "Falta la entrada de la cookie.");
    raw = await o.readHidden();
    return importValidated(app, conn, raw, out);
}

async function importValidated(app: App, conn: LocalConnection, raw: string, out: (s: string) => void): Promise<number> {
    const cookies = parseCookieInput(raw);
    const snapshot = await app.web!.validateImport(cookies, new Date());
    const svc = await conn.service();
    await svc.importSession(snapshot);
    const st = await svc.publicStatus();
    const ws = st.web_session as { estimated_expires_if_idle_at?: string } | undefined;
    out(`Sesión web validada y guardada en la conexión de esta PC: userid ${snapshot.user_id}, ${snapshot.cookies.length} cookie(s) de Moodle, revisión ${snapshot.revision}.`);
    out(`Vence por inactividad (aprox. ${ws?.estimated_expires_if_idle_at ? new Date(ws.estimated_expires_if_idle_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "4 h"} si no se usa) o si cerrás sesión en ese navegador.`);
    if (st.method !== "autologin") out(`Método recomendado, para no repetir esto: ${cliCommand()} auth web autologin enable --profile ${conn.profileId}.`);
    return 0;
}

/** `auth web panel`: el panel de conexión de esta PC en 127.0.0.1, hasta terminar, 15 min sin uso o Ctrl+C. */
export async function webPanel(conn: LocalConnection, profile: Pick<Profile, "profile_id">, o: WebLocalOptions): Promise<number> {
    const out = o.out ?? defaultOut;
    const svc = await conn.service();
    const panel = await startLocalPanel({ service: svc, cli: cliCommand(), profileId: profile.profile_id });
    out("Panel de conexión de esta PC (sólo responde en este equipo; se cierra solo al terminar o a los 15 minutos sin uso):");
    out(panel.url);
    out("No compartas este enlace: es la llave del panel mientras está abierto. Ctrl+C lo cierra.");
    if (!o.noOpen) (o.openUrl ?? openInBrowser)(panel.url);
    process.once("SIGINT", () => panel.close());
    const r = await panel.done;
    const st = await svc.publicStatus().catch(() => null);
    if (r.reason === "committed") out("Conexión renovada y verificada. Panel cerrado.");
    else out(`Panel cerrado (${r.reason === "idle" ? "15 minutos sin uso" : "a pedido"}).${r.last ? ` Último resultado: ${r.last.message}` : ""}`);
    if (st) out(JSON.stringify({ device_trust: st.device_trust, web_session: st.web_session, action: st.action }, null, 2));
    return r.reason === "committed" ? 0 : r.last && r.last.state !== "committed" && r.last.state !== "idle" ? 1 : 0;
}
