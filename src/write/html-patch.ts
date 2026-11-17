import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { CampusError } from "../errors.js";
import type { Difference } from "./plan.js";

/**
 * Edición conservativa de HTML existente (ADR-136). El HTML que guardó Moodle NO se reconstruye: se parsea
 * con parse5 (con posiciones en el original) sólo para ubicar UN nodo de texto, y se reemplaza ese intervalo
 * del string original. Todo lo demás (atributos, estilos, imágenes, enlaces, espacios) queda byte a byte.
 * Además: una firma estructural canónica para verificar después de guardar (Moodle puede reformatear
 * espacios, pero nunca puede perderse una tabla, un atributo o el texto de otra celda sin que se note).
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

const isEl = (n: Node): n is Element => "tagName" in n;
const isText = (n: Node): n is TextNode => n.nodeName === "#text";
const kids = (n: Node): Node[] => ("childNodes" in n ? (n.childNodes as Node[]) : []);

/** Espacios colapsados (incluido el no separable). Sólo para buscar y comparar, nunca para reescribir. */
export const norm = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

function parse(html: string) {
    return parseFragment(html, { sourceCodeLocationInfo: true }) as unknown as Node;
}

function textOf(n: Node): string {
    if (isText(n)) return n.value;
    return kids(n).map(textOf).join("");
}

function textNodes(n: Node, out: TextNode[] = []): TextNode[] {
    if (isText(n)) out.push(n);
    else for (const k of kids(n)) textNodes(k, out);
    return out;
}

function elements(n: Node, tag: string, out: Element[] = []): Element[] {
    if (isEl(n) && n.tagName === tag) out.push(n);
    for (const k of kids(n)) elements(k, tag, out);
    return out;
}

/** Filas de UNA tabla (a través de thead/tbody/tfoot), sin entrar en tablas anidadas. */
function rowsOf(table: Element): Element[] {
    const out: Element[] = [];
    const walk = (n: Node) => {
        for (const k of kids(n)) {
            if (!isEl(k) || k.tagName === "table") continue;
            if (k.tagName === "tr") out.push(k);
            else walk(k);
        }
    };
    walk(table);
    return out;
}

const cellsOf = (tr: Element) => kids(tr).filter((k): k is Element => isEl(k) && (k.tagName === "td" || k.tagName === "th"));
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value ?? null;
const same = (a: string, b: string) => norm(a).toLocaleLowerCase("es") === norm(b).toLocaleLowerCase("es");

/** Escapa como TEXTO HTML: nunca se interpreta como marcado. */
export const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface CellPatchSpec {
    headers_contain: string[];
    row_match: Record<string, string>;
    column: string;
    expected_text: string;
    replacement_text: string;
}

export interface CellPatchResult {
    html: string;
    table: { index: number; headers: string[] };
    row: { index: number; cells: string[] };
    column: string;
    before: string;
    after: string;
    /** El intervalo reemplazado en el HTML original (para mostrar la diferencia focalizada). */
    offset: number;
    before_fragment: string;
    after_fragment: string;
}

const reject = (msg: string): never => {
    throw new CampusError("WRITE_NOT_ALLOWED", msg);
};

/**
 * Cambia el texto de UNA celda de UNA tabla. Exige una sola tabla con esos encabezados, una sola fila que
 * cumpla todas las condiciones, una sola celda y que su texto sea exactamente el esperado. Si algo es ambiguo
 * (celdas combinadas, texto repartido en varios nodos), rechaza antes de escribir.
 */
export function patchTableCell(html: string, spec: CellPatchSpec): CellPatchResult {
    const repl = norm(spec.replacement_text);
    if (!repl) reject("replacement_text no puede quedar vacío.");
    if (/[\u0000-\u001f\u007f]/.test(spec.replacement_text)) reject("replacement_text no puede tener saltos de línea ni caracteres de control.");
    if (!norm(spec.expected_text)) reject("expected_text no puede quedar vacío.");
    if (norm(spec.expected_text) === repl) reject("El texto nuevo es igual al actual.");
    const root = parse(html);
    const tables = elements(root, "table");
    if (!tables.length) reject("El resumen no tiene tablas.");
    // Fila de encabezados: la primera fila que contiene todos los pedidos (pueden estar en <td>, sin <thead>).
    const located = tables
        .map((t, index) => {
            const rows = rowsOf(t);
            const hi = rows.findIndex((r) => spec.headers_contain.every((h) => cellsOf(r).some((c) => same(textOf(c), h))));
            return { t, index, rows, hi };
        })
        .filter((x) => x.hi >= 0);
    if (!located.length) reject(`Ninguna tabla tiene una fila con los encabezados ${spec.headers_contain.map((h) => `«${h}»`).join(", ")}. Tablas: ${tables.map((t, i) => `${i + 1}: ${(rowsOf(t)[0] ? cellsOf(rowsOf(t)[0]!).map((c) => norm(textOf(c))).join(" | ") : "sin filas").slice(0, 120)}`).join("; ")}.`);
    if (located.length > 1) reject(`Hay ${located.length} tablas con esos encabezados: agregá encabezados para distinguirlas.`);
    const { t, index, rows, hi } = located[0]!;
    if (rows.some((r) => cellsOf(r).some((c) => Number(attr(c, "colspan") ?? 1) > 1 || Number(attr(c, "rowspan") ?? 1) > 1))) reject("La tabla tiene celdas combinadas (colspan/rowspan): la columna de cada celda no es inequívoca.");
    const headers = cellsOf(rows[hi]!).map((c) => norm(textOf(c)));
    const col = (name: string) => {
        const idx = headers.flatMap((h, i) => (same(h, name) ? [i] : []));
        if (idx.length !== 1) reject(idx.length ? `El encabezado «${name}» aparece ${idx.length} veces.` : `La tabla no tiene la columna «${name}». Columnas: ${headers.join(" | ")}.`);
        return idx[0]!;
    };
    const target = col(spec.column);
    const conds = Object.entries(spec.row_match).map(([h, v]) => ({ i: col(h), h, v }));
    if (!conds.length) reject("row_match necesita al menos una condición.");
    const candidates = rows.slice(hi + 1).filter((r) => conds.every((c) => norm(textOf(cellsOf(r)[c.i] ?? ({ childNodes: [] } as unknown as Node))) === norm(c.v)));
    if (candidates.length !== 1) reject(candidates.length ? `${candidates.length} filas cumplen ${conds.map((c) => `${c.h}=«${c.v}»`).join(" y ")}: agregá condiciones.` : `Ninguna fila cumple ${conds.map((c) => `${c.h}=«${c.v}»`).join(" y ")}.`);
    const row = candidates[0]!;
    const cell = cellsOf(row)[target];
    if (!cell) reject(`La fila no tiene celda en la columna «${spec.column}».`);
    const current = norm(textOf(cell!));
    if (current !== norm(spec.expected_text)) reject(`La celda dice «${current}», no «${norm(spec.expected_text)}»: no se cambia nada.`);
    const parts = textNodes(cell!).filter((n) => norm(n.value));
    if (parts.length !== 1) reject("El texto de la celda está repartido en varios nodos (formato parcial): no se puede cambiar sin tocar su formato.");
    const loc = parts[0]!.sourceCodeLocation;
    if (!loc) reject("No se pudo ubicar la celda en el HTML original.");
    const raw = html.slice(loc!.startOffset, loc!.endOffset);
    const lead = /^\s*/.exec(raw)![0];
    const trail = /\s*$/.exec(raw.slice(lead.length))![0];
    const fresh = `${lead}${escapeText(repl)}${trail}`;
    const out = html.slice(0, loc!.startOffset) + fresh + html.slice(loc!.endOffset);
    // Control antes de enviar: el resultado sólo puede diferir en ese texto.
    const a = htmlSignature(html);
    const b = htmlSignature(out);
    const diff = a.flatMap((x, i) => (x !== b[i] ? [i] : []));
    if (a.length !== b.length || diff.length !== 1 || b[diff[0]!] !== `#${repl}`) throw new CampusError("WRITE_NOT_ALLOWED", "La edición alteraría otra parte del HTML: no se envía.");
    return {
        html: out,
        table: { index: index + 1, headers },
        row: { index: rowsOf(t).indexOf(row) + 1, cells: cellsOf(row).map((c) => norm(textOf(c))) },
        column: headers[target]!,
        before: current,
        after: repl,
        offset: loc!.startOffset,
        before_fragment: raw,
        after_fragment: fresh,
    };
}

/**
 * Firma estructural canónica: elementos con sus atributos (ordenados, espacios colapsados) y textos sin
 * espacios de más. Igual firma = mismo contenido para el lector, aunque Moodle cambie saltos de línea.
 */
export function htmlSignature(html: string): string[] {
    const out: string[] = [];
    const walk = (n: Node) => {
        if (isText(n)) {
            const t = norm(n.value);
            if (t) out.push(`#${t}`);
            return;
        }
        if (isEl(n)) {
            const attrs = [...n.attrs].map((a) => `${a.name}=${norm(a.value)}`).sort();
            out.push(`<${n.tagName}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
            for (const k of kids(n)) walk(k);
            out.push(`</${n.tagName}>`);
            return;
        }
        for (const k of kids(n)) walk(k);
    };
    walk(parse(html));
    return out;
}

/** Rasgos que nunca pueden perderse sin aviso. */
export function htmlFeatures(html: string) {
    const root = parse(html);
    const all: Element[] = [];
    const walk = (n: Node) => {
        if (isEl(n)) all.push(n);
        for (const k of kids(n)) walk(k);
    };
    walk(root);
    const count = (tag: string) => all.filter((e) => e.tagName === tag).length;
    return {
        tables: count("table"),
        rows: count("tr"),
        cells: all.filter((e) => e.tagName === "td" || e.tagName === "th").length,
        images: all.filter((e) => e.tagName === "img").map((e) => attr(e, "src") ?? ""),
        links: all.filter((e) => e.tagName === "a" && attr(e, "href")).map((e) => attr(e, "href")!),
        media: all.filter((e) => ["iframe", "video", "audio", "object", "embed"].includes(e.tagName)).length,
        styles: all.filter((e) => attr(e, "style") !== null).length,
        classes: all.filter((e) => attr(e, "class") !== null).length,
        cell_texts: all.filter((e) => e.tagName === "td" || e.tagName === "th").map((e) => norm(textOf(e))),
    };
}

/** Lo que `after` perdió respecto de `before` (tablas, imágenes, enlaces, estilos, clases, multimedia). */
export function structureLoss(before: string, after: string): string[] {
    const a = htmlFeatures(before);
    const b = htmlFeatures(after);
    const lost: string[] = [];
    if (b.tables < a.tables) lost.push(`${a.tables - b.tables} tabla(s)`);
    else if (b.rows < a.rows || b.cells < a.cells) lost.push("filas o celdas de tablas");
    const missing = (x: string[], y: string[]) => x.filter((v) => !y.includes(v));
    if (missing(a.images, b.images).length) lost.push(`${missing(a.images, b.images).length} imagen(es)`);
    if (missing(a.links, b.links).length) lost.push(`${missing(a.links, b.links).length} enlace(s)`);
    if (b.media < a.media) lost.push("contenido multimedia incrustado");
    if (b.styles < a.styles) lost.push("estilos (atributo style)");
    if (b.classes < a.classes) lost.push("clases (atributo class)");
    return lost;
}

/** Diferencias legibles entre lo esperado y lo releído, para el resultado de la verificación. */
export function structureDifferences(expected: string, observed: string): Difference[] {
    const out: Difference[] = [];
    const a = htmlFeatures(expected);
    const b = htmlFeatures(observed);
    for (const k of ["tables", "rows", "cells", "media", "styles", "classes"] as const) if (a[k] !== b[k]) out.push({ field: k, expected: a[k], observed: b[k] });
    for (const k of ["images", "links", "cell_texts"] as const) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ field: k, expected: a[k], observed: b[k] });
    if (!out.length) out.push({ field: "html", expected: "misma estructura y atributos", observed: "difiere en atributos o en el texto fuera de las tablas" });
    return out;
}
