import { createHash } from "node:crypto";
import { htmlToText } from "../domain/html.js";
import { CampusError } from "../errors.js";

/**
 * Texto del docente → HTML que se envía a Moodle (directiva §8.1: «formato forzado a HTML: el
 * Markdown se convierte en el servidor y el plan muestra el HTML resultante»). Conversor mínimo y
 * cerrado: todo se escapa y sólo se generan párrafos, saltos, títulos, listas, tablas (con la fila
 * separadora estándar), negrita, cursiva, código, imágenes http(s) y enlaces http(s)/mailto (ADR-136). El HTML que llega como «html» se envía tal cual (Moodle lo
 * limpia al mostrarlo) y el plan lo muestra.
 */
export type TextFormat = "markdown" | "html" | "texto";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    // Imagen antes que enlace: si no, «![x](url)» quedaba como «!» más un enlace (ADR-136).
    out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, alt: string, src: string) => `<img src="${src}" alt="${alt}">`);
    out = out.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, (_m, text: string, href: string) => `<a href="${href}">${text}</a>`);
    return out;
}

/** Celdas de una fila de tabla Markdown (`| a | b |`), con `\|` como barra literal. */
function tableCells(line: string): string[] {
    const t = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const looksLikeRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);

function table(head: string, sep: string, rows: string[]): string {
    const cols = tableCells(head);
    const align = tableCells(sep).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
    const cell = (tag: "th" | "td", text: string, i: number) => `<${tag}${align[i] ? ` style="text-align: ${align[i]};"` : ""}>${inline(text)}</${tag}>`;
    const body = rows.map((r) => {
        const c = tableCells(r);
        return `<tr>${cols.map((_, i) => cell("td", c[i] ?? "", i)).join("")}</tr>`;
    });
    return `<table><thead><tr>${cols.map((c, i) => cell("th", c, i)).join("")}</tr></thead><tbody>${body.join("")}</tbody></table>`;
}

/**
 * Cómo se muestran los bloques cercados (```). `pre` los envuelve en `<pre><code>` (Moodle lo admite).
 * `inline` es para campos que no admiten `<pre>` (H5P según la semántica instalada): baja a `<code>` con
 * saltos `<br>` y la sangría como espacios no separables, para que el código siga legible.
 */
export type CodeBlocks = "pre" | "inline";

// Después de ``` puede venir cualquier rótulo sin comillas invertidas («python», «c#», «js title="x"»).
const FENCE_OPEN = /^\s*```[^`]*$/;
const FENCE_CLOSE = /^\s*```\s*$/;

function codeBlock(lines: string[], mode: CodeBlocks): string {
    const escaped = lines.map((l) => esc(l.replace(/\t/g, "    ")));
    if (mode === "pre") return `<pre><code>${escaped.join("\n")}</code></pre>`;
    return `<p><code>${escaped.map((l) => l.replace(/^ +/, (sp) => "&nbsp;".repeat(sp.length))).join("<br>")}</code></p>`;
}

export function markdownToHtml(md: string, codeBlocks: CodeBlocks = "pre"): string {
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    const out: string[] = [];
    let para: string[] = [];
    let list: { tag: "ul" | "ol"; items: string[] } | null = null;
    let fence: string[] | null = null;
    const flushPara = () => {
        if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
        para = [];
    };
    const flushList = () => {
        if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
        list = null;
    };
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        // Dentro de un bloque cercado no se interpreta nada: cada línea es código tal cual.
        if (fence) {
            if (FENCE_CLOSE.test(raw)) {
                out.push(codeBlock(fence, codeBlocks));
                fence = null;
            } else fence.push(raw);
            continue;
        }
        if (FENCE_OPEN.test(raw)) {
            flushPara();
            flushList();
            fence = [];
            continue;
        }
        const line = raw.trimEnd();
        // Tabla: encabezado + fila separadora (`|---|:--:|`) + filas con barras (ADR-136).
        if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
            flushPara();
            flushList();
            const rows: string[] = [];
            let j = i + 2;
            while (j < lines.length && lines[j]!.trim() && lines[j]!.includes("|")) rows.push(lines[j++]!);
            out.push(table(line, lines[i + 1]!, rows));
            i = j - 1;
            continue;
        }
        // Filas con barras sin la fila separadora: no se convierten en un párrafo con «|» (antes pasaba en silencio).
        if (looksLikeRow(line) && looksLikeRow(lines[i + 1] ?? "")) {
            throw new CampusError("WRITE_NOT_ALLOWED", "Esto parece una tabla Markdown sin la fila separadora (| --- | --- |) debajo del encabezado. Agregala o escribí el texto sin barras al principio y al final.");
        }
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
    // Un bloque sin cierre se toma como código hasta el final, en vez de perderse.
    if (fence) out.push(codeBlock(fence, codeBlocks));
    return out.join("\n");
}

export function toHtml(text: string, format: TextFormat, codeBlocks: CodeBlocks = "pre"): string {
    if (format === "html") return text;
    if (format === "texto") return text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n");
    return markdownToHtml(text, codeBlocks);
}

/** Texto comparable: sin etiquetas, entidades resueltas y espacios colapsados (Moodle reformatea el HTML al devolverlo). */
export function comparable(html: string | null | undefined): string {
    return htmlToText(html ?? "").replace(/\s+/g, " ").trim();
}

export const textHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
