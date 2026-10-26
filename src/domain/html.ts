import { stripSecretParams } from "../util/redact.js";

/**
 * HTML de Moodle → texto con Markdown liviano para el agente. No ejecuta nada, no sigue enlaces,
 * descarta <script>/<style> y conserva el texto tal cual (sin reescribir fechas ni consignas).
 * Moodle messageformat: 0 = MOODLE, 1 = HTML, 2 = PLAIN, 4 = MARKDOWN.
 */
export function sourceToText(message: string | null | undefined, format: number | null | undefined): string {
    if (!message) return "";
    if (format === 2 || format === 4) return normalizeWhitespace(message);
    return htmlToText(message);
}

const NAMED: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", iexcl: "¡", iquest: "¿",
    aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
    Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
    laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…", ldquo: "“", rdquo: "”",
    lsquo: "‘", rsquo: "’", deg: "°", ordm: "º", ordf: "ª", middot: "·", bull: "•", euro: "€",
};

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
        if (body[0] === "#") {
            const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
        }
        return NAMED[body] ?? m;
    });
}

function attr(tag: string, name: string): string | null {
    const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
}

function safeHref(href: string | null): string | null {
    if (!href) return null;
    const h = href.trim();
    if (!/^(https?:|mailto:)/i.test(h)) return null; // javascript:, data:, relativos → descartados
    return stripSecretParams(h);
}

export function htmlToText(html: string): string {
    let s = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style|head|template|noscript|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<(script|style|iframe|object|embed)\b[^>]*\/?>/gi, "");
    s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
        const text = inner.replace(/<[^>]+>/g, "").trim();
        const href = safeHref(attr(` ${attrs}`, "href"));
        if (!href) return text;
        return text && decodeEntities(text) !== href ? `[${text}](${href})` : href;
    });
    s = s.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
        const alt = attr(` ${attrs}`, "alt");
        return alt ? `[imagen: ${alt}]` : "[imagen]";
    });
    s = s
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, "**$2**")
        .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, "*$2*")
        .replace(/<\/(p|div|h[1-6]|ul|ol|table|blockquote|pre|section|article)\s*>/gi, "\n\n")
        .replace(/<\/(tr|li)\s*>/gi, "\n")
        .replace(/<\/t[dh]\s*>/gi, " | ")
        .replace(/<[^>]+>/g, "");
    return normalizeWhitespace(decodeEntities(s));
}

function normalizeWhitespace(s: string): string {
    return s
        .replace(/\r\n?/g, "\n")
        .replace(/ /g, " ")
        .split("\n")
        .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export interface Slice {
    text: string;
    truncated: boolean;
    start: number;
    end: number;
    total: number;
}

/** Corta por caracteres (code points) con rango explícito para continuar (FOR-05). */
export function sliceText(text: string, start: number, maxChars: number): Slice {
    const chars = Array.from(text);
    const s = Math.max(0, Math.min(start, chars.length));
    const e = Math.min(chars.length, s + Math.max(0, maxChars));
    return { text: chars.slice(s, e).join(""), truncated: e < chars.length, start: s, end: e, total: chars.length };
}
