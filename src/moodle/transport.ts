import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { CampusError, type CampusErrorCode } from "../errors.js";
import type { Logger } from "../util/logger.js";
import { isAllowedFunction, paramPolicyViolation, RESERVED_PARAMS, type AllowedFunction } from "./functions.js";
import { MoodleExceptionSchema } from "./schemas.js";
import { flattenParams, rootName, type ParamValue } from "./serialize.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Fuente del token. Sólo el transporte lo ve; nunca sale en resultados ni logs. */
export interface TokenSource {
    getToken(): Promise<string>;
    /** Moodle rechazó este token (invalidtoken/expiredtoken). */
    reportRejected(token: string): void;
}

export interface TransportOptions {
    siteUrl: string;
    tokenSource: TokenSource;
    logger: Logger;
    timeoutMs: number;
    maxConcurrent: number;
    fetch?: FetchLike;
    /** Límite de bytes para respuestas JSON del REST. */
    maxJsonBytes?: number;
    /** Reintentos sólo para lecturas ante errores transitorios. */
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Funciones anunciadas por el servicio, si ya se conocen (para FUNCTION_NOT_AVAILABLE). */
    listedFunctions?: () => ReadonlySet<string> | null;
    /** Instrucción para el humano cuando el token deja de ser válido. */
    loginHint?: string;
}

const TOKEN_ERRORS = new Set(["invalidtoken", "expiredtoken", "invalidtokensession"]);
const PERMISSION_ERRORS = new Set([
    "nopermissions",
    "requireloginerror",
    "accessexception",
    "notingroup",
    "cannotviewdiscussion",
    "noviewdiscussionspermission",
    "nopermissiontoviewpage",
    "coursehidden",
    "errorcoursecontextnotvalid",
    "invalidcontext",
]);
const SERVICE_ERRORS = new Set(["servicenotavailable", "enablewsdescription", "sitemaintenance", "webservicesnotenabled"]);
const PERMISSION_EXCEPTIONS = new Set(["required_capability_exception", "require_login_exception", "webservice_access_exception"]);

class Semaphore {
    private active = 0;
    private readonly queue: (() => void)[] = [];
    constructor(private readonly max: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            this.queue.shift()?.();
        }
    }
}

class TransientError extends Error {}

export class MoodleTransport {
    private readonly fetchImpl: FetchLike;
    private readonly sem: Semaphore;
    private readonly site: URL;
    private readonly basePath: string;

    constructor(private readonly opts: TransportOptions) {
        this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
        this.sem = new Semaphore(opts.maxConcurrent);
        this.site = new URL(opts.siteUrl);
        this.basePath = this.site.pathname.replace(/\/+$/, "");
    }

    get siteUrl(): string {
        return this.opts.siteUrl;
    }

    /** Llama a una función de la allowlist y valida la forma de la respuesta. */
    async call<S extends z.ZodType>(fn: AllowedFunction, params: Record<string, ParamValue>, schema: S): Promise<z.infer<S>> {
        if (!isAllowedFunction(fn)) {
            // Defensa en profundidad: el tipo ya lo impide, pero una ruta dinámica podría colarlo.
            throw new CampusError("POLICY_DENIED", `La función ${String(fn)} no está permitida por la política local.`);
        }
        const flat = flattenParams(params);
        for (const [k] of flat) {
            if (RESERVED_PARAMS.has(rootName(k))) {
                throw new CampusError("POLICY_DENIED", `El parámetro ${rootName(k)} está reservado al transporte.`);
            }
        }
        const violation = paramPolicyViolation(fn, flat);
        if (violation) throw new CampusError("POLICY_DENIED", violation);
        const correlationId = randomUUID();
        const started = Date.now();
        const retries = this.opts.retries ?? 2;
        let outcome: string = "ok";
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    const data = await this.sem.run(() => this.postOnce(fn, flat));
                    return this.interpret(fn, data, schema);
                } catch (e) {
                    if (e instanceof TransientError && attempt < retries) {
                        await (this.opts.sleep ?? defaultSleep)(300 * 2 ** attempt);
                        continue;
                    }
                    if (e instanceof TransientError) throw new CampusError("NETWORK_ERROR", e.message);
                    throw e;
                }
            }
        } catch (e) {
            outcome = e instanceof CampusError ? e.code : "INTERNAL";
            throw e;
        } finally {
            this.opts.logger.log(outcome === "ok" ? "info" : "warn", "moodle_call", {
                correlation_id: correlationId,
                wsfunction: fn,
                outcome,
                duration_ms: Date.now() - started,
            });
        }
    }

    private async postOnce(fn: string, flat: [string, string][]): Promise<unknown> {
        const token = await this.opts.tokenSource.getToken();
        const body = new URLSearchParams([...flat, ["wstoken", token], ["wsfunction", fn], ["moodlewsrestformat", "json"]]);
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.opts.siteUrl}/webservice/rest/server.php`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
                body,
                redirect: "manual",
                signal: AbortSignal.timeout(this.opts.timeoutMs),
            });
        } catch (e) {
            throw new TransientError(`No se pudo conectar con ${this.site.host}: ${describeFetchError(e)}`);
        }
        if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel();
            throw new CampusError("SERVICE_UNAVAILABLE", `El servicio REST respondió con una redirección (HTTP ${res.status}); no se siguió para no reenviar el token.`);
        }
        if (res.status === 502 || res.status === 503 || res.status === 504) {
            await res.body?.cancel();
            throw new TransientError(`HTTP ${res.status} del servicio REST.`);
        }
        if (!res.ok) {
            await res.body?.cancel();
            throw new CampusError("SERVICE_UNAVAILABLE", `HTTP ${res.status} del servicio REST.`);
        }
        const bytes = await readWithLimit(res, this.opts.maxJsonBytes ?? 16 * 1024 * 1024);
        const text = new TextDecoder().decode(bytes);
        try {
            const data: unknown = JSON.parse(text);
            // Moodle devuelve `null` para funciones sin retorno; lo pasamos tal cual al esquema.
            if (data && typeof data === "object" && "exception" in data) {
                const parsed = MoodleExceptionSchema.safeParse(data);
                if (parsed.success) {
                    if (parsed.data.errorcode && TOKEN_ERRORS.has(parsed.data.errorcode)) {
                        this.opts.tokenSource.reportRejected(token);
                    }
                    throw this.mapException(fn, parsed.data);
                }
            }
            return data;
        } catch (e) {
            if (e instanceof CampusError) throw e;
            throw new CampusError("UNEXPECTED_RESPONSE", "El servicio REST no devolvió JSON (¿página HTML de mantenimiento o de login?).");
        }
    }

    private interpret<S extends z.ZodType>(fn: string, data: unknown, schema: S): z.infer<S> {
        const parsed = schema.safeParse(data);
        if (!parsed.success) {
            const where = parsed.error.issues
                .slice(0, 3)
                .map((i) => i.path.join("."))
                .join(", ");
            throw new CampusError("UNEXPECTED_RESPONSE", `La respuesta de ${fn} no tiene la forma esperada (${where || "raíz"}).`);
        }
        return parsed.data;
    }

    private mapException(fn: string, ex: z.infer<typeof MoodleExceptionSchema>): CampusError {
        const errorcode = ex.errorcode ?? undefined;
        const message = (ex.message ?? ex.exception).slice(0, 300);
        let code: CampusErrorCode = "MOODLE_ERROR";
        if (errorcode && TOKEN_ERRORS.has(errorcode)) code = "AUTH_REQUIRED";
        else if (errorcode && SERVICE_ERRORS.has(errorcode)) code = "SERVICE_UNAVAILABLE";
        else if ((errorcode && PERMISSION_ERRORS.has(errorcode)) || PERMISSION_EXCEPTIONS.has(ex.exception)) {
            const listed = this.opts.listedFunctions?.();
            code = listed && !listed.has(fn) ? "FUNCTION_NOT_AVAILABLE" : "MOODLE_PERMISSION_DENIED";
        }
        return new CampusError(code, `Moodle rechazó ${fn}: ${message}`, {
            moodleErrorcode: errorcode,
            humanAction: code === "AUTH_REQUIRED" ? `El token ya no es válido. ${this.opts.loginHint ?? "Volvé a iniciar sesión con la CLI."}` : undefined,
        });
    }

    /**
     * Descarga un archivo de pluginfile con el token. Sólo mismo origen HTTPS y rutas de
     * pluginfile; cada redirección se revalida y una cross-origin se bloquea (FILE-01).
     */
    async download(rawUrl: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string | null }> {
        let url = this.normalizeFileUrl(rawUrl);
        const started = Date.now();
        let outcome = "ok";
        try {
            return await this.sem.run(async () => {
                for (let hop = 0; hop < 4; hop++) {
                    const token = await this.opts.tokenSource.getToken();
                    const withToken = new URL(url);
                    withToken.searchParams.set("token", token);
                    let res: Response;
                    try {
                        res = await this.fetchImpl(withToken, { redirect: "manual", signal: AbortSignal.timeout(this.opts.timeoutMs) });
                    } catch (e) {
                        throw new CampusError("NETWORK_ERROR", `No se pudo descargar el archivo: ${describeFetchError(e)}`);
                    }
                    if (res.status >= 300 && res.status < 400) {
                        const location = res.headers.get("location");
                        await res.body?.cancel();
                        if (!location) throw new CampusError("UNEXPECTED_RESPONSE", "Redirección sin destino al descargar.");
                        url = this.normalizeFileUrl(new URL(location, url).toString(), "redirect");
                        continue;
                    }
                    const contentType = res.headers.get("content-type");
                    if (!res.ok) {
                        await res.body?.cancel();
                        throw new CampusError(res.status === 403 || res.status === 401 ? "MOODLE_PERMISSION_DENIED" : "SERVICE_UNAVAILABLE", `HTTP ${res.status} al descargar el archivo.`);
                    }
                    const bytes = await readWithLimit(res, maxBytes);
                    if (contentType?.includes("json")) {
                        const err = asPluginfileError(bytes);
                        if (err) {
                            if (err.errorcode && TOKEN_ERRORS.has(err.errorcode)) this.opts.tokenSource.reportRejected(token);
                            const code: CampusErrorCode =
                                err.errorcode && TOKEN_ERRORS.has(err.errorcode)
                                    ? "AUTH_REQUIRED"
                                    : err.errorcode && PERMISSION_ERRORS.has(err.errorcode)
                                      ? "MOODLE_PERMISSION_DENIED"
                                      : "MOODLE_ERROR";
                            throw new CampusError(code, `Moodle rechazó la descarga: ${(err.error ?? "error").slice(0, 200)}`, { moodleErrorcode: err.errorcode });
                        }
                    }
                    return { bytes, contentType };
                }
                throw new CampusError("UNEXPECTED_RESPONSE", "Demasiadas redirecciones al descargar.");
            });
        } catch (e) {
            outcome = e instanceof CampusError ? e.code : "INTERNAL";
            throw e;
        } finally {
            this.opts.logger.log(outcome === "ok" ? "info" : "warn", "moodle_download", { outcome, duration_ms: Date.now() - started });
        }
    }

    /** Valida que la URL sea del Campus configurado y de pluginfile; quita credenciales previas. */
    normalizeFileUrl(raw: string, stage: "initial" | "redirect" = "initial"): string {
        const deny = (why: string) =>
            new CampusError("RESOURCE_OUT_OF_SCOPE", `${stage === "redirect" ? "Redirección bloqueada" : "Archivo bloqueado"}: ${why}.`);
        if (/[\\\u0000-\u001f]/.test(raw)) throw deny("caracteres no permitidos");
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            throw deny("URL inválida");
        }
        if (url.protocol !== "https:") throw deny("no es HTTPS");
        if (url.username || url.password) throw deny("URL con credenciales embebidas");
        if (url.origin !== this.site.origin) throw deny("origen distinto del Campus configurado");
        const rawPath = raw.slice(raw.indexOf(url.host) + url.host.length).split(/[?#]/)[0] ?? "";
        if (/%2e|%2f|%5c|%00/i.test(rawPath) || rawPath.split("/").some((s) => s === ".." || s === ".")) {
            throw deny("ruta con segmentos codificados o relativos");
        }
        const ws = `${this.basePath}/webservice/pluginfile.php/`;
        const plain = `${this.basePath}/pluginfile.php/`;
        if (url.pathname.startsWith(plain)) url.pathname = ws + url.pathname.slice(plain.length);
        if (!url.pathname.startsWith(ws)) throw deny("no es una ruta de archivo de Moodle");
        for (const name of [...url.searchParams.keys()]) {
            if (/^(token|wstoken|key|sesskey)$/i.test(name)) url.searchParams.delete(name);
        }
        url.hash = "";
        return url.toString();
    }
}

function asPluginfileError(bytes: Uint8Array): { error?: string; errorcode?: string } | null {
    if (bytes.length > 64 * 1024) return null;
    try {
        const data = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        if (data && typeof data === "object" && !Array.isArray(data) && "errorcode" in data && ("error" in data || "exception" in data)) {
            const d = data as { error?: unknown; errorcode?: unknown };
            return { error: typeof d.error === "string" ? d.error : undefined, errorcode: typeof d.errorcode === "string" ? d.errorcode : undefined };
        }
    } catch {
        /* No es JSON de error: es el archivo. */
    }
    return null;
}

/** Lee el cuerpo cortando apenas supera el límite (FILE-02). Atribución en THIRD_PARTY_NOTICES.md. */
export async function readWithLimit(res: Response, maxBytes: number): Promise<Uint8Array> {
    const tooBig = () => new CampusError("UNSUPPORTED_CONTENT", `La respuesta supera el límite de ${maxBytes} bytes.`);
    if (Number(res.headers.get("content-length")) > maxBytes) {
        await res.body?.cancel();
        throw tooBig();
    }
    if (!res.body) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw tooBig();
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let i = 0;
    for (const c of chunks) {
        out.set(c, i);
        i += c.byteLength;
    }
    return out;
}

function describeFetchError(e: unknown): string {
    if (e instanceof Error) {
        if (e.name === "TimeoutError" || e.name === "AbortError") return "tiempo de espera agotado";
        const cause = (e as { cause?: { code?: string } }).cause?.code;
        return cause ? `${e.message} (${cause})` : e.message;
    }
    return String(e);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
