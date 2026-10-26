import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Comando ejecutable para las instrucciones al humano. No hay un `campus` instalado globalmente,
 * así que se muestra `node <ruta>/build/cli.js`, que funciona desde cualquier directorio.
 */
export function cliCommand(): string {
    // build/util/cli-command.js o src/util/cli-command.ts → dos niveles arriba.
    const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "build", "cli.js").replaceAll("\\", "/");
    return `node ${path.includes(" ") ? `"${path}"` : path}`;
}
