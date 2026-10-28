import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CampusError } from "../errors.js";
import { SAFE_NAME, type PlanFile } from "./files.js";

/**
 * Archivos que entrega el cliente (ChatGPT, `openai/fileParams`): un enlace temporal de descarga por
 * archivo. El servidor los baja al planificar, los valida y guarda los bytes aparte, con vencimiento
 * corto (`blob`); el plan sólo lleva nombre, tamaño y hash. Nunca se registra el enlace: puede llevar
 * la credencial de acceso.
 */
export const ChatFile = z
    .object({
        download_url: z.string().min(1).max(4000).describe("Enlace temporal de descarga que entrega ChatGPT."),
        file_id: z.string().min(1).max(200).describe("Identificador del archivo en ChatGPT."),
        mime_type: z.string().max(200).optional().describe("Tipo MIME, si ChatGPT lo informa."),
        file_name: z.string().max(255).optional().describe("Nombre del archivo, si ChatGPT lo informa."),
    })
    .meta({ id: "ChatFile" });
export type ChatFileRef = z.infer<typeof ChatFile>;

/** `_meta` de una herramienta con campos de archivo: ChatGPT sólo entrega archivos en los campos listados. */
export const fileParamsMeta = (fields: readonly string[]) => ({ "openai/fileParams": [...fields] });

type JsonSchema = { definitions?: Record<string, JsonSchema>; $defs?: Record<string, JsonSchema>; [k: string]: unknown };

/**
 * El SDK publica los esquemas en draft-07 (`definitions`, `#/definitions/…`). OpenAI documenta el objeto de
 * archivo en `$defs`, con `#/$defs/…` y `additionalProperties: false`; con la otra forma ChatGPT mostró
 * `files` como texto y mandó cadenas (ADR-129). Se reescribe sólo en las herramientas
 * con `openai/fileParams`.
 */
export function openAiFileSchema(schema: JsonSchema): JsonSchema {
    const defs = schema.definitions;
    if (!defs) return schema;
    const fixRefs = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(fixRefs);
        if (!v || typeof v !== "object") return v;
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "$ref" && typeof x === "string" ? x.replace(/^#\/definitions\//, "#/$defs/") : fixRefs(x)]));
    };
    const { definitions: _old, ...rest } = schema;
    const $defs = Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, k === "ChatFile" ? { ...d, additionalProperties: false } : d]));
    return { ...(fixRefs(rest) as JsonSchema), $defs: fixRefs($defs) as Record<string, JsonSchema> };
}

/**
 * Aplica `openAiFileSchema` a la respuesta de `tools/list` de un servidor ya armado. El SDK no expone un
 * gancho para el esquema publicado: se envuelve su manejador (el de McpServer, que se fija una sola vez).
 */
export function publishOpenAiFileSchemas(server: Server): void {
    const handlers = (server as unknown as { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<{ tools: { _meta?: Record<string, unknown>; inputSchema: JsonSchema }[] }>> })._requestHandlers;
    const inner = handlers?.get("tools/list");
    if (!inner) throw new Error("tools/list no está registrado: llamar después de registrar las herramientas.");
    server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
        const res = await inner(req, extra);
        return { ...res, tools: res.tools.map((t) => (t._meta?.["openai/fileParams"] ? { ...t, inputSchema: openAiFileSchema(t.inputSchema) } : t)) } as never;
    });
}

/** Vida de los bytes guardados: más que la del plan (15 min), para que vencido el plan venza también el archivo. */
export const CHAT_FILE_TTL_S = 3_600;
/** Remoto: por archivo y por plan. El plan entero se sube a Moodle dentro de una invocación (60 s en Vercel). */
export const REMOTE_MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
export const REMOTE_MAX_CHAT_PLAN_BYTES = 40 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

export interface ChatFileDeps {
    fetchImpl?: typeof fetch;
    /** Direcciones IP de un nombre (por defecto, el DNS del sistema). */
    resolve?: (host: string) => Promise<string[]>;
}

/** Direcciones a las que nunca se pide: locales, privadas, de enlace, reservadas y de documentación. */
export function isPublicAddress(ip: string): boolean {
    const v = isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split(".").map(Number) as [number, number];
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && (b === 168 || (b === 0 && ip.startsWith("192.0.0.")) || ip.startsWith("192.0.2."))) return false;
        if (a === 198 && (b === 18 || b === 19 || ip.startsWith("198.51.100."))) return false;
        if (ip.startsWith("203.0.113.")) return false;
        return true;
    }
    if (v === 6) {
        const s = ip.toLowerCase();
        if (s === "::" || s === "::1") return false;
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
        if (mapped) return isPublicAddress(mapped[1]!);
        if (/^(fc|fd|fe[89ab]|ff)/.test(s)) return false; // ULA, enlace local, multicast
        if (s.startsWith("2001:db8") || s.startsWith("64:ff9b") || s.startsWith("100::")) return false;
        return true;
    }
    return false;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

async function assertPublicUrl(raw: string, resolve: (h: string) => Promise<string[]>): Promise<URL> {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new CampusError("WRITE_NOT_ALLOWED", "El enlace del archivo no es válido.");
    }
    if (u.protocol !== "https:") throw new CampusError("WRITE_NOT_ALLOWED", "El enlace del archivo tiene que ser https.");
    if (u.username || u.password) throw new CampusError("WRITE_NOT_ALLOWED", "El enlace del archivo no puede llevar usuario ni contraseña.");
    if (u.port && u.port !== "443") throw new CampusError("WRITE_NOT_ALLOWED", "El enlace del archivo usa un puerto no estándar.");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
        try {
            addresses = await resolve(host);
        } catch {
            throw new CampusError("SERVICE_UNAVAILABLE", `No se pudo resolver el servidor del archivo (${host}).`);
        }
    }
    if (!addresses.length || !addresses.every(isPublicAddress)) throw new CampusError("WRITE_NOT_ALLOWED", `El enlace del archivo apunta a una dirección no pública (${host}).`);
    return u;
}

function nameFrom(ref: ChatFileRef, url: URL, disposition: string | null): string {
    const fromHeader = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    let decodedHeader: string | undefined;
    try {
        decodedHeader = fromHeader ? decodeURIComponent(fromHeader) : undefined;
    } catch {
        decodedHeader = fromHeader || undefined;
    }
    const last = url.pathname.split("/").pop() ?? "";
    const name = (ref.file_name?.trim() || decodedHeader?.trim() || last).trim();
    if (!name || !SAFE_NAME.test(name) || name.startsWith(".")) throw new CampusError("WRITE_NOT_ALLOWED", `Nombre de archivo no admitido${name ? `: ${name}` : " (ChatGPT no informó el nombre)"}.`);
    return name;
}

/** El contenido tiene que ser lo que dice ser: un .pdf empieza con %PDF-, un .h5p o un Office moderno es un ZIP. */
function checkContent(filename: string, mime: string | undefined, data: Buffer) {
    const lower = filename.toLowerCase();
    const head = data.subarray(0, 8).toString("latin1");
    if (lower.endsWith(".pdf") || mime === "application/pdf") {
        if (!head.startsWith("%PDF-")) throw new CampusError("WRITE_NOT_ALLOWED", `${filename} no es un PDF válido (no empieza con %PDF-).`);
    }
    if (/\.(h5p|zip|docx|xlsx|pptx|odt|ods|odp)$/.test(lower) && !head.startsWith("PK\u0003\u0004")) {
        throw new CampusError("WRITE_NOT_ALLOWED", `${filename} no tiene el formato que indica su extensión.`);
    }
}

async function readCapped(res: Response, maxBytes: number, filename: string): Promise<Buffer> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new CampusError("WRITE_NOT_ALLOWED", `${filename} pesa ${declared} bytes y el máximo es ${maxBytes}.`);
    if (!res.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new CampusError("WRITE_NOT_ALLOWED", `${filename} supera el máximo de ${maxBytes} bytes.`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/** Baja un archivo de ChatGPT con las salvaguardas (https, direcciones públicas, redirecciones, tamaño y tipo). */
export async function downloadChatFile(ref: ChatFileRef, maxBytes: number, deps: ChatFileDeps = {}): Promise<{ filename: string; data: Buffer; host: string }> {
    const fetchImpl = deps.fetchImpl ?? ((i, init) => fetch(i, init));
    const resolve = deps.resolve ?? defaultResolve;
    let url = await assertPublicUrl(ref.download_url, resolve);
    const firstHost = url.hostname;
    for (let hop = 0; ; hop++) {
        let res: Response;
        try {
            res = await fetchImpl(url.href, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch {
            throw new CampusError("SERVICE_UNAVAILABLE", `No se pudo descargar el archivo de ChatGPT (${firstHost}).`);
        }
        if (res.status >= 300 && res.status < 400) {
            const next = res.headers.get("location");
            if (!next || hop >= MAX_REDIRECTS) throw new CampusError("WRITE_NOT_ALLOWED", "El enlace del archivo redirige demasiadas veces.");
            url = await assertPublicUrl(new URL(next, url).href, resolve);
            continue;
        }
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
            throw new CampusError("PLAN_STALE", `El enlace del archivo de ChatGPT venció o no está disponible (HTTP ${res.status}). Pedile a ChatGPT que vuelva a pasar el archivo.`);
        }
        if (!res.ok) throw new CampusError("SERVICE_UNAVAILABLE", `La descarga del archivo de ChatGPT respondió HTTP ${res.status}.`);
        const filename = nameFrom(ref, url, res.headers.get("content-disposition"));
        const data = await readCapped(res, maxBytes, filename);
        if (!data.length) throw new CampusError("WRITE_NOT_ALLOWED", `El archivo ${filename} llegó vacío.`);
        checkContent(filename, ref.mime_type, data);
        return { filename, data, host: firstHost };
    }
}

/** Describe un archivo bajado de ChatGPT para el plan. Los bytes van aparte (`putBlob`), no en el plan. */
export function describeChatFile(filename: string, data: Buffer, ref: ChatFileRef, host: string): PlanFile {
    return { path: `(ChatGPT ${host}: ${ref.file_id.slice(0, 40)})`, filename, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), blob: true };
}
