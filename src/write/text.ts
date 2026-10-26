import { createHash } from "node:crypto";
import { htmlToText } from "../domain/html.js";

/**
 * Texto del docente → HTML que se envía a Moodle (directiva §8.1: «formato forzado a HTML: el
 * Markdown se convierte en el servidor y el plan muestra el HTML resultante»). Conversor mínimo y
 * cerrado: todo se escapa y sólo se generan párrafos, saltos, títulos, listas, negrita, cursiva,
 * código y enlaces http(s)/mailto. El HTML que llega como «html» se envía tal cual (Moodle lo
 * limpia al mostrarlo) y el plan lo muestra.
 */
export type TextFormat = "markdown" | "html" | "texto";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, (_m, text: string, href: string) => `<a href="${href}">${text}</a>`);
    return out;
}

export function markdownToHtml(md: string): string {
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    const out: string[] = [];
    let para: string[] = [];
    let list: { tag: "ul" | "ol"; items: string[] } | null = null;
    const flushPara = () => {
        if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
        para = [];
    };
    const flushList = () => {
        if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
        list = null;
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        const h = /^(#{1,4})\s+(.+)$/.exec(line);
        const ul = /^\s*[-*]\s+(.+)$/.exec(line);
        const ol = /^\s*\d+[.)]\s+(.+)$/.exec(line);
        if (!line.trim()) {
            flushPara();
            flushList();
        } else if (h) {
            flushPara();
            flushList();
            const level = Math.min(6, h[1]!.length + 2); // # → h3: los títulos del foro ya usan h1/h2
            out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
        } else if (ul || ol) {
            flushPara();
            const tag = ul ? "ul" : "ol";
            if (list && list.tag !== tag) flushList();
            list ??= { tag, items: [] };
            list.items.push((ul ?? ol)![1]!);
        } else {
            flushList();
            para.push(line);
        }
    }
    flushPara();
    flushList();
    return out.join("\n");
}

export function toHtml(text: string, format: TextFormat): string {
    if (format === "html") return text;
    if (format === "texto") return text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n");
    return markdownToHtml(text);
}

/** Texto comparable: sin etiquetas, entidades resueltas y espacios colapsados (Moodle reformatea el HTML al devolverlo). */
export function comparable(html: string | null | undefined): string {
    return htmlToText(html ?? "").replace(/\s+/g, " ").trim();
}

export const textHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
