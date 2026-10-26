import { redact } from "./redact.js";

/**
 * Logger a stderr. En modo STDIO, stdout es exclusivo del protocolo MCP (MCP-03).
 * Registra eventos mínimos de auditoría; nunca bodies, headers ni URLs con token.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
    log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export type LogSink = (line: string) => void;

export function createLogger(sink: LogSink = (l) => process.stderr.write(l + "\n"), minLevel: LogLevel = "info"): Logger {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    const min = order.indexOf(minLevel);
    return {
        log(level, event, fields = {}) {
            if (order.indexOf(level) < min) return;
            const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
            sink(redact(line));
        },
    };
}

export const silentLogger: Logger = { log() {} };
