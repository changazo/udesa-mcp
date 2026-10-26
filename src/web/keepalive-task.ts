import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { CampusError } from "../errors.js";

/**
 * Tarea programada de Windows que corre `auth web keepalive` cada N minutos (opcional, con
 * consentimiento del dueño). Se registra sólo para el usuario actual, sin administrador:
 * - corre únicamente con la sesión de Windows iniciada (necesita el keyring del usuario);
 * - sin ventana: `conhost.exe --headless`;
 * - también con batería, se pone al día al volver de una suspensión y no se superpone consigo misma.
 * La tarea no contiene secretos: sólo la ruta de Node, la del CLI, el perfil (o su archivo) y, si se
 * usa uno propio, el directorio de estado.
 */

export const KEEPALIVE_MIN_EVERY = 5;
export const KEEPALIVE_MAX_EVERY = 240;
export const KEEPALIVE_DEFAULT_EVERY = 30;

export function taskName(profileId: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(profileId)) throw new CampusError("CONFIG_INVALID", "Identificador de perfil inválido para la tarea programada.");
    return `udesa-campus-mcp web-keepalive ${profileId}`;
}

/** Qué perfil y qué estado usa la tarea: los mismos que el comando que la instala. */
export interface KeepaliveTarget {
    profileId: string;
    /** Ruta absoluta de `--profile-file`, si se usó en lugar de `--profile`. */
    profileFile?: string;
    /** Directorio de estado propio (`--state-dir` o `CAMPUS_STATE_DIR`), absoluto. */
    stateDir?: string;
}

const quoted = (p: string) => {
    if (p.includes('"')) throw new CampusError("CONFIG_INVALID", "Una ruta de la tarea programada no puede contener comillas.");
    return `"${p}"`;
};

export function keepaliveArguments(nodePath: string, cliPath: string, target: KeepaliveTarget): string {
    const profile = target.profileFile ? `--profile-file ${quoted(target.profileFile)}` : `--profile ${target.profileId}`;
    const state = target.stateDir ? ` --state-dir ${quoted(target.stateDir)}` : "";
    return `--headless ${quoted(nodePath)} ${quoted(cliPath)} auth web keepalive ${profile}${state} --quiet`;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function localIso(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface TaskSpec {
    nodePath: string;
    cliPath: string;
    target: KeepaliveTarget;
    everyMinutes: number;
    /** DOMINIO\usuario de Windows. */
    user: string;
    conhostPath: string;
    start: Date;
}

export function validateEvery(raw: string | undefined): number {
    const n = raw === undefined ? KEEPALIVE_DEFAULT_EVERY : Number(raw);
    if (!Number.isInteger(n) || n < KEEPALIVE_MIN_EVERY || n > KEEPALIVE_MAX_EVERY) {
        throw new CampusError("CONFIG_INVALID", `--every debe ser un número entero de minutos entre ${KEEPALIVE_MIN_EVERY} y ${KEEPALIVE_MAX_EVERY}.`);
    }
    return n;
}

/** Definición XML (Task Scheduler 1.2). Se usa XML porque `schtasks` sin XML no permite correr con batería. */
export function taskXml(s: TaskSpec): string {
    const user = xmlEscape(s.user);
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`Mantiene viva la sesión web del Campus (perfil ${s.target.profileId}) con una lectura de identidad cada ${s.everyMinutes} min. Quitar con: auth web keepalive uninstall --profile ${s.target.profileId}`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${s.everyMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${localIso(s.start)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(s.conhostPath)}</Command>
      <Arguments>${xmlEscape(keepaliveArguments(s.nodePath, s.cliPath, s.target))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// CP850 (página OEM de Windows en español), 0x80–0xFF. Coincide con la 437 en las vocales con tilde y la ñ.
const CP850 =
    "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0";

/**
 * Salida de una herramienta de consola: `schtasks` escribe en la página OEM de la consola (850 o 437),
 * no en UTF-8. Si los bytes no son UTF-8 válido, se leen como CP850.
 */
export function decodeConsoleOutput(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        let s = "";
        for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP850[b - 0x80];
        return s;
    }
}

function schtasks(args: string[]): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
        const p = spawn("schtasks", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const chunks: Buffer[] = [];
        p.stdout.on("data", (d: Buffer) => chunks.push(d));
        p.stderr.on("data", (d: Buffer) => chunks.push(d));
        p.on("error", () => resolve({ code: -1, out: "schtasks.exe no disponible" }));
        p.on("close", (code) => resolve({ code: code ?? -1, out: decodeConsoleOutput(Buffer.concat(chunks)) }));
    });
}

function requireWindows() {
    if (process.platform !== "win32") throw new CampusError("CONFIG_INVALID", "La tarea programada sólo está implementada para Windows. En otros sistemas, programá `auth web keepalive` con cron o similar.");
}

export function currentWindowsUser(env: NodeJS.ProcessEnv = process.env): string {
    const name = env.USERNAME ?? userInfo().username;
    return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
}

export function defaultConhost(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");
}

export async function installKeepaliveTask(spec: TaskSpec): Promise<void> {
    requireWindows();
    const file = join(tmpdir(), `udesa-campus-mcp-task-${randomBytes(6).toString("hex")}.xml`);
    // schtasks exige UTF-16 con BOM para el XML.
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(spec), "utf16le")]));
    try {
        const r = await schtasks(["/Create", "/TN", taskName(spec.target.profileId), "/XML", file, "/F"]);
        if (r.code !== 0) throw new CampusError("CONFIG_INVALID", `No se pudo crear la tarea programada: ${r.out.trim().slice(0, 300)}`);
    } finally {
        rmSync(file, { force: true });
    }
}

export async function uninstallKeepaliveTask(profileId: string): Promise<boolean> {
    requireWindows();
    const r = await schtasks(["/Delete", "/TN", taskName(profileId), "/F"]);
    return r.code === 0;
}

/** Acción e intervalo de la tarea instalada, o null si no existe. */
export async function keepaliveTaskStatus(profileId: string): Promise<{ arguments: string | null; every_minutes: number | null; enabled: boolean | null } | null> {
    if (process.platform !== "win32") return null;
    const r = await schtasks(["/Query", "/TN", taskName(profileId), "/XML"]);
    if (r.code !== 0) return null;
    return parseTaskXml(r.out);
}

const decodeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Duración ISO 8601 de Task Scheduler (PT30M, PT1H, PT1H30M, P1D…) en minutos; null si no se reconoce. */
export function durationMinutes(iso: string): number | null {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
    if (!m || iso.trim() === "P" || iso.trim().endsWith("T")) return null;
    const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0));
    return d! * 1440 + h! * 60 + min! + s! / 60;
}

export function parseTaskXml(xml: string): { arguments: string | null; every_minutes: number | null; enabled: boolean | null } {
    const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)?.[1];
    const interval = /<Interval>([^<]+)<\/Interval>/.exec(xml)?.[1];
    const every = interval === undefined ? null : durationMinutes(interval);
    const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(xml)?.[1];
    // Windows omite los valores por defecto al exportar: sin <Enabled> en Settings, la tarea está habilitada.
    const enabled = settings === undefined ? null : /<Enabled>false<\/Enabled>/.test(settings.replace(/<IdleSettings>[\s\S]*?<\/IdleSettings>/, "")) ? false : true;
    return { arguments: args ? decodeXml(args) : null, every_minutes: every, enabled };
}
