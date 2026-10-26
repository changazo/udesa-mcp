import { CampusError } from "../errors.js";

/**
 * Entrada interactiva del humano. Los prompts van a stderr; la contraseña no tiene eco y no pasa
 * por argumentos, variables de entorno ni historial. Requiere una terminal real (TTY).
 */
export function requireTty(): void {
    if (!process.stdin.isTTY) {
        throw new CampusError("AUTH_REJECTED", "El login necesita una terminal interactiva. No se aceptan credenciales por pipe, argumentos ni variables de entorno.");
    }
}

export async function promptVisible(question: string): Promise<string> {
    return readLine(question, false);
}

export async function promptHidden(question: string, signal?: AbortSignal): Promise<string> {
    return readLine(question, true, signal);
}

function readLine(question: string, hidden: boolean, signal?: AbortSignal): Promise<string> {
    const stdin = process.stdin;
    process.stderr.write(question);
    return new Promise((resolve, reject) => {
        let value = "";
        const wasRaw = stdin.isRaw;
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let settled = false;
        const done = (err?: Error) => {
            if (settled) return;
            settled = true;
            stdin.removeListener("data", onData);
            stdin.setRawMode?.(wasRaw);
            stdin.pause();
            process.stderr.write("\n");
            if (err) reject(err);
            else resolve(value);
        };
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") return done();
                if (ch === "\u0003") return done(new CampusError("AUTH_REJECTED", "Login cancelado por el usuario."));
                if (ch === "\u007f" || ch === "\b") {
                    if (value.length) {
                        value = value.slice(0, -1);
                        if (!hidden) process.stderr.write("\b \b");
                    }
                    continue;
                }
                if (ch < " ") continue;
                value += ch;
                if (!hidden) process.stderr.write(ch);
            }
        };
        stdin.on("data", onData);
        signal?.addEventListener("abort", () => done(new CampusError("AUTH_REJECTED", "Entrada cancelada: el retorno llegó por el canal automático.")), { once: true });
    });
}
