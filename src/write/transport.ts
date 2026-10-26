import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CampusError } from "../errors.js";
import { MoodleExceptionSchema } from "../moodle/schemas.js";
import { flattenParams, type ParamValue } from "../moodle/serialize.js";
import { readWithLimit, type FetchLike, type TokenSource } from "../moodle/transport.js";
import type { Logger } from "../util/logger.js";
import { checkWriteRest, WRITE_FUNCTIONS, type RestWriteSpec } from "./functions.js";

/**
 * Transporte de ESCRITURA (directiva §5.2, ADR-044). Separado del de lectura:
 * - sólo funciones de WRITE_FUNCTIONS, con validador por función, chequeadas ANTES de la red;
 * - una sola petición por llamada: CERO reintentos automáticos (ninguna creación es idempotente);
 * - cualquier respuesta que no sea un JSON interpretable (red caída, timeout, 5xx, HTML,
 *   redirección) es «resultado incierto»: quien llama reconcilia por lectura, nunca reenvía;
 * - el token viaja sólo en el cuerpo y nunca se registra; los logs llevan la función y el desenlace.
 */
export interface WriteTransportOptions {
    siteUrl: string;
    tokenSource: TokenSource;
    logger: Logger;
    timeoutMs: number;
    fetch?: FetchLike;
    /** Sólo tests: otra tabla de funciones (por defecto WRITE_FUNCTIONS). */
    table?: Readonly<Record<string, RestWriteSpec>>;
}

/** La petición pudo haber llegado a Moodle: el efecto se averigua releyendo. */
export class WriteUncertainError extends CampusError {
    constructor(message: string) {
        super("NETWORK_ERROR", message, { details: { applied: "desconocido" } });
        this.name = "WriteUncertainError";
    }
}

const TOKEN_ERRORS = new Set(["invalidtoken", "expiredtoken", "invalidtokensession"]);
const UploadedSchema = z.array(z.object({ itemid: z.number().int().positive().optional(), filename: z.string().nullable().optional(), errortype: z.string().nullable().optional(), error: z.string().nullable().optional() }).passthrough());

export class WriteTransport {
    private readonly fetchImpl: FetchLike;
    private readonly host: string;
    /** Escrituras emitidas (sin contar relecturas sintéticas); para auditoría y tests. */
    writesSent = 0;

    constructor(private readonly opts: WriteTransportOptions) {
        this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
        this.host = new URL(opts.siteUrl).host;
    }

    get siteUrl() {
        return this.opts.siteUrl;
    }

    /**
     * Sube archivos al BORRADOR privado del usuario (`webservice/upload.php`, §8.12, ADR-057) en UNA
     * petición y devuelve el itemid. Nada de esto es visible en un curso: un fallo nunca es «incierto»
     * para la escritura que sigue (no se envió). Los errores por archivo llegan con HTTP 200: si alguno
     * falla, se limpia lo subido y se rechaza.
     */
    async uploadDraft(files: readonly { filename: string; data: Buffer }[], intoItemid = 0): Promise<number> {
        const correlationId = randomUUID();
        const started = Date.now();
        let outcome = "ok";
        try {
            const token = await this.opts.tokenSource.getToken();
            const form = new FormData();
            form.set("token", token);
            form.set("filearea", "draft");
            form.set("itemid", String(intoItemid));
            form.set("filepath", "/");
            files.forEach((f, i) => form.set(`file_${i + 1}`, new Blob([new Uint8Array(f.data)]), f.filename));
            this.writesSent++;
            let res: Response;
            try {
                res = await this.fetchImpl(`${this.opts.siteUrl}/webservice/upload.php`, { method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(this.opts.timeoutMs) });
            } catch {
                throw new CampusError("NETWORK_ERROR", "No se pudieron subir los adjuntos (falla de red). No se publicó nada; si algo llegó, queda en tu borrador privado y Moodle lo purga a los 4 días.");
            }
            let data: unknown;
            try {
                if (res.status !== 200) throw new Error(String(res.status));
                data = JSON.parse(new TextDecoder().decode(await readWithLimit(res, 1024 * 1024)));
            } catch (e) {
                if (e instanceof CampusError && e.code !== "UNSUPPORTED_CONTENT") throw e;
                throw new CampusError("NETWORK_ERROR", `La subida de adjuntos no devolvió JSON (HTTP ${res.status}). No se publicó nada.`);
            }
            if (data && typeof data === "object" && !Array.isArray(data)) {
                const ex = MoodleExceptionSchema.safeParse(data);
                const errorcode = ex.success ? (ex.data.errorcode ?? undefined) : undefined;
                if (errorcode && TOKEN_ERRORS.has(errorcode)) {
                    this.opts.tokenSource.reportRejected(token);
                    throw new CampusError("AUTH_REQUIRED", "Moodle rechazó el token al subir los adjuntos; no se publicó nada.", { moodleErrorcode: errorcode });
                }
                const message = ex.success ? (ex.data.message ?? ex.data.exception) : "respuesta inesperada";
                throw new CampusError("MOODLE_REJECTED", `Moodle rechazó la subida de adjuntos: ${String(message).slice(0, 300)}. No se publicó nada.`, { moodleErrorcode: errorcode });
            }
            const rows = UploadedSchema.safeParse(data);
            if (!rows.success || rows.data.length !== files.length) throw new CampusError("UNEXPECTED_RESPONSE", "La subida de adjuntos devolvió una respuesta inesperada. No se publicó nada.");
            const ok = rows.data.filter((r) => !r.errortype && r.itemid);
            const itemids = new Set(ok.map((r) => r.itemid!));
            const failed = rows.data.filter((r) => r.errortype || !r.itemid);
            if (failed.length || itemids.size !== 1 || (intoItemid && !itemids.has(intoItemid))) {
                const [itemid] = [...itemids];
                if (itemid && ok.length) await this.deleteDraft(itemid, ok.map((r) => String(r.filename ?? ""))).catch(() => undefined);
                throw new CampusError("MOODLE_REJECTED", `Moodle no guardó ${failed.length || "algunos"} adjunto(s): ${failed.map((r) => `${r.filename ?? "?"} (${r.errortype ?? "sin itemid"})`).join(", ")}. No se publicó nada.`);
            }
            return [...itemids][0]!;
        } catch (e) {
            outcome = e instanceof CampusError ? e.code : "INTERNAL";
            throw e;
        } finally {
            this.opts.logger.log(outcome === "ok" ? "info" : "warn", "moodle_write_call", { correlation_id: correlationId, wsfunction: "webservice/upload.php", outcome, files: files.length, duration_ms: Date.now() - started });
        }
    }

    /** Limpia archivos de un borrador propio (adjuntos que no llegaron a publicarse). */
    async deleteDraft(itemid: number, filenames: readonly string[]): Promise<void> {
        await this.call("core_files_delete_draft_files", { draftitemid: itemid, files: filenames.map((filename) => ({ filepath: "/", filename })) });
    }

    /**
     * Una llamada REST de la allowlist de escritura. Devuelve el JSON tal cual: la intención decide si
     * es una falla silenciosa (null, false, -1, warnings) y la verificación por relectura decide el éxito.
     * Lanza: POLICY_DENIED (antes de la red), AUTH_REQUIRED (token rechazado: no se aplicó),
     * MOODLE_REJECTED (excepción de Moodle) o WriteUncertainError.
     */
    async call(fn: string, params: Record<string, ParamValue>): Promise<unknown> {
        const flat = flattenParams(params);
        const spec = checkWriteRest(fn, flat, this.opts.siteUrl, this.opts.table ?? WRITE_FUNCTIONS);
        const correlationId = randomUUID();
        const started = Date.now();
        let outcome = "ok";
        try {
            const token = await this.opts.tokenSource.getToken();
            const body = new URLSearchParams([...flat, ["wstoken", token], ["wsfunction", fn], ["moodlewsrestformat", "json"]]);
            let res: Response;
            if (spec.kind === "write") this.writesSent++;
            try {
                res = await this.fetchImpl(`${this.opts.siteUrl}/webservice/rest/server.php`, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
                    body,
                    redirect: "manual",
                    signal: AbortSignal.timeout(this.opts.timeoutMs),
                });
            } catch (e) {
                const why = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "tiempo de espera agotado" : "falla de red";
                throw new WriteUncertainError(`${fn}: ${why} con ${this.host}. Puede haberse aplicado o no: se reconcilia por lectura, sin reenviar.`);
            }
            if (res.status !== 200) {
                await res.body?.cancel();
                throw new WriteUncertainError(`${fn}: HTTP ${res.status} del servicio REST. Puede haberse aplicado o no: se reconcilia por lectura, sin reenviar.`);
            }
            let data: unknown;
            try {
                data = JSON.parse(new TextDecoder().decode(await readWithLimit(res, 4 * 1024 * 1024)));
            } catch (e) {
                if (e instanceof CampusError && e.code !== "UNSUPPORTED_CONTENT") throw e;
                throw new WriteUncertainError(`${fn}: la respuesta no es JSON (¿página de mantenimiento?). Puede haberse aplicado o no.`);
            }
            if (data && typeof data === "object" && !Array.isArray(data) && "exception" in data) {
                const ex = MoodleExceptionSchema.safeParse(data);
                const errorcode = ex.success ? (ex.data.errorcode ?? undefined) : undefined;
                const message = ex.success ? (ex.data.message ?? ex.data.exception).slice(0, 300) : "excepción sin detalle";
                if (errorcode && TOKEN_ERRORS.has(errorcode)) {
                    this.opts.tokenSource.reportRejected(token);
                    // El token se valida antes de ejecutar la función: no se aplicó nada.
                    throw new CampusError("AUTH_REQUIRED", `Moodle rechazó el token antes de ${fn}; no se aplicó nada.`, { moodleErrorcode: errorcode });
                }
                throw new CampusError("MOODLE_REJECTED", `Moodle rechazó ${fn}: ${message}`, { moodleErrorcode: errorcode });
            }
            return data;
        } catch (e) {
            outcome = e instanceof WriteUncertainError ? "UNCERTAIN" : e instanceof CampusError ? e.code : "INTERNAL";
            throw e;
        } finally {
            this.opts.logger.log(outcome === "ok" ? "info" : "warn", "moodle_write_call", { correlation_id: correlationId, wsfunction: fn, outcome, duration_ms: Date.now() - started });
        }
    }
}
