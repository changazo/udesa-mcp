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

export function newSigningSecret(): string {
    return randomBytes(32).toString("base64url");
}
