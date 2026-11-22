import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../config/profile.js";
import { CampusError } from "../errors.js";

/**
 * Carga variables en el proyecto de Vercel vinculado (carpeta .vercel/ en la raíz del paquete).
 * El valor viaja por stdin a `vercel env add`: nunca por argumentos, nunca impreso.
 */
export async function vercelEnvAdd(name: string, value: string, opts: { sensitive: boolean; environment?: string }): Promise<void> {
    const cwd = packageRoot();
    if (!existsSync(join(cwd, ".vercel", "project.json"))) {
        throw new CampusError("CONFIG_INVALID", `El paquete no está vinculado a un proyecto de Vercel. Corré primero: vercel link (en ${cwd}).`);
    }
    const environment = opts.environment ?? "production";
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name) || !/^(production|preview|development)$/.test(environment)) {
        throw new CampusError("CONFIG_INVALID", "Nombre de variable o entorno inválido.");
    }
    const args = ["env", "add", name, environment, "--force", "--yes", ...(opts.sensitive ? ["--sensitive"] : [])];
    await new Promise<void>((resolve, reject) => {
        // En Windows `vercel` es un .cmd y requiere shell: se pasa como una sola cadena de tokens
        // validados (sin valores del usuario). El valor secreto va siempre por stdin.
        const child =
            process.platform === "win32"
                ? spawn(`vercel ${args.join(" ")}`, { cwd, shell: true, stdio: ["pipe", "ignore", "pipe"] })
                : spawn("vercel", args, { cwd, stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("error", () => reject(new CampusError("CONFIG_INVALID", "No se encontró la CLI de Vercel (vercel).")));
        child.on("close", (code) => {
            if (code === 0) resolve();
            // stderr de vercel no contiene el valor (va por stdin); igual se recorta.
            else reject(new CampusError("CONFIG_INVALID", `vercel env add ${name} falló (código ${code}): ${stderr.trim().slice(-300)}`));
        });
        child.stdin.end(value);
    });
}

/** Borra una variable del proyecto de Vercel vinculado. Si no existía, no es error. */
export async function vercelEnvRm(name: string, environment = "production"): Promise<"removed" | "absent"> {
    const cwd = packageRoot();
    if (!existsSync(join(cwd, ".vercel", "project.json"))) {
        throw new CampusError("CONFIG_INVALID", `El paquete no está vinculado a un proyecto de Vercel. Corré primero: vercel link (en ${cwd}).`);
    }
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name) || !/^(production|preview|development)$/.test(environment)) {
        throw new CampusError("CONFIG_INVALID", "Nombre de variable o entorno inválido.");
    }
    const args = ["env", "rm", name, environment, "--yes"];
    return new Promise((resolve, reject) => {
        const child =
            process.platform === "win32"
                ? spawn(`vercel ${args.join(" ")}`, { cwd, shell: true, stdio: ["ignore", "ignore", "pipe"] })
                : spawn("vercel", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("error", () => reject(new CampusError("CONFIG_INVALID", "No se encontró la CLI de Vercel (vercel).")));
        child.on("close", (code) => {
            if (code === 0) resolve("removed");
            else if (/not found|no se encontr|doesn't exist|does not exist/i.test(stderr)) resolve("absent");
            else reject(new CampusError("CONFIG_INVALID", `vercel env rm ${name} falló (código ${code}): ${stderr.trim().slice(-300)}`));
        });
    });
}

/** ¿El paquete está vinculado a un proyecto de Vercel (.vercel/project.json)? No lee su contenido. */
export function vercelProjectLinked(): boolean {
    return existsSync(join(packageRoot(), ".vercel", "project.json"));
}

/** ¿Está la CLI de Vercel instalada? Corre `vercel --version` sin mostrar nada ni pasar secretos. */
export async function vercelAvailable(): Promise<boolean> {
    const cwd = packageRoot();
    return new Promise((resolve) => {
        const child =
            process.platform === "win32"
                ? spawn("vercel --version", { cwd, shell: true, stdio: ["ignore", "ignore", "ignore"] })
                : spawn("vercel", ["--version"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
    });
}

export interface VercelDeployResult {
    ok: boolean;
    /** Código de salida de `vercel deploy`; null si no se pudo lanzar. */
    code: number | null;
    /** Cola recortada de stderr (sin valores: los argumentos son fijos y no hay stdin). */
    stderr_tail: string;
}

/**
 * `vercel deploy --prod --yes` en el proyecto vinculado (ADR-141). Argumentos fijos, sin secretos;
 * stdout (URL del deployment, progreso) se descarta y sólo se conserva el código y la cola de stderr.
 * No lanza: el llamador decide qué estado informar.
 */
export async function vercelDeployProd(): Promise<VercelDeployResult> {
    const cwd = packageRoot();
    if (!vercelProjectLinked()) return { ok: false, code: null, stderr_tail: "El paquete no está vinculado a un proyecto de Vercel (vercel link)." };
    const args = ["deploy", "--prod", "--yes"];
    return new Promise((resolve) => {
        const child =
            process.platform === "win32"
                ? spawn(`vercel ${args.join(" ")}`, { cwd, shell: true, stdio: ["ignore", "ignore", "pipe"] })
                : spawn("vercel", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => {
            stderr = (stderr + String(d)).slice(-4000);
        });
        child.on("error", () => resolve({ ok: false, code: null, stderr_tail: "No se encontró la CLI de Vercel (vercel)." }));
        child.on("close", (code) => resolve({ ok: code === 0, code, stderr_tail: stderr.trim().slice(-300) }));
    });
}

export function newSigningSecret(): string {
    return randomBytes(32).toString("base64url");
}
