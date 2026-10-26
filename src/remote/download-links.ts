import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Enlaces temporales de descarga del remoto (ADR-113): `/descarga/<token>/<nombre>`, firmados con una
 * clave DERIVADA de OAUTH_SIGNING_SECRET, válidos 15 minutos. El token lleva la ruta pluginfile del
 * archivo (sin credenciales: el remoto agrega su token de Moodle al descargarlo) y nunca el token.
 * Sólo se emiten para materiales del curso, no para entregas, devoluciones ni adjuntos de foros.
 */

export const LINK_TTL_S = 15 * 60;

export interface LinkSpec {
    /** URL pluginfile de Moodle del archivo (sin token). */
    url: string;
    name: string;
    mime: string;
    course_id: number;
    entry?: string;
}

export interface DownloadLinks {
    mint(spec: LinkSpec): { url: string; expires_at: string };
    verify(token: string): LinkSpec | null;
}

const b64u = (b: Buffer) => b.toString("base64url");

export function createDownloadLinks(signingSecret: Uint8Array, baseUrl: string, now: () => Date = () => new Date()): DownloadLinks {
    const key = createHmac("sha256", signingSecret).update("download-links:v1").digest();
    const sign = (payload: string) => createHmac("sha256", key).update(payload).digest();
    return {
        mint(spec) {
            const exp = Math.floor(now().getTime() / 1000) + LINK_TTL_S;
            const payload = b64u(Buffer.from(JSON.stringify({ ...spec, exp })));
            const token = `${payload}.${b64u(sign(payload))}`;
            return { url: `${baseUrl}/descarga/${token}/${encodeURIComponent(spec.name)}`, expires_at: new Date(exp * 1000).toISOString() };
        },
        verify(token) {
            const [payload, sig] = token.split(".");
            if (!payload || !sig || token.length > 4096) return null;
            const want = sign(payload);
            const got = Buffer.from(sig, "base64url");
            if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
            try {
                const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LinkSpec & { exp: number };
                if (typeof j.exp !== "number" || j.exp * 1000 < now().getTime()) return null;
                if (typeof j.url !== "string" || typeof j.name !== "string" || typeof j.mime !== "string" || typeof j.course_id !== "number") return null;
                return { url: j.url, name: j.name, mime: j.mime, course_id: j.course_id, ...(typeof j.entry === "string" ? { entry: j.entry } : {}) };
            } catch {
                return null;
            }
        },
    };
}
