import { CampusError } from "../errors.js";
import { attr, cellsOf, elements, escapeText, htmlSignature, isEl, kids, norm, parse, rowsOf, same, textNodes, textOf, type Element, type Node } from "./html-patch.js";

/**
 * ADR-137: más ediciones en el lugar sobre HTML guardado, con la misma regla que ADR-136: se ubican nodos con
 * parse5 (posiciones en el original) y se reemplazan intervalos del string original; nunca se reserializa el
 * DOM. Cada operación se controla antes de enviar contra la firma estructural: el resultado sólo puede diferir
 * en lo pedido.
 */

const reject = (msg: string): never => {
    throw new CampusError("WRITE_NOT_ALLOWED", msg);
};
const guard = (ok: boolean) => {
    if (!ok) throw new CampusError("WRITE_NOT_ALLOWED", "La edición alteraría otra parte del HTML: no se envía.");
};
const CONTROL = /[\u0000-\u001f\u007f]/;

interface Edit {
    start: number;
    end: number;
    text: string;
}

/** Aplica reemplazos de intervalos (sin superposiciones), del final al principio para no correr posiciones. */
function applyEdits(html: string, edits: Edit[]): string {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    sorted.forEach((e, i) => {
        if (i && e.end > sorted[i - 1]!.start) throw new CampusError("WRITE_NOT_ALLOWED", "Dos cambios caen sobre la misma parte del HTML.");
    });
    return sorted.reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), html);
}

// ---------- tablas ----------

export interface LocatedTable {
    table: Element;
    index: number;
    headers: string[];
    /** Filas de datos (después de la de encabezados). */
    dataRows: Element[];
    col(name: string): number;
    row(match: Record<string, string>): Element;
}

/** Una sola tabla con una fila que tenga todos esos encabezados (pueden estar en <td>); sin celdas combinadas. */
export function locateTable(html: string, headersContain: string[]): LocatedTable {
    const tables = elements(parse(html), "table");
    if (!tables.length) reject("El texto no tiene tablas.");
    const located = tables
        .map((t, index) => {
            const rows = rowsOf(t);
            return { t, index, rows, hi: rows.findIndex((r) => headersContain.every((h) => cellsOf(r).some((c) => same(textOf(c), h)))) };
        })
        .filter((x) => x.hi >= 0);
    if (!located.length) reject(`Ninguna tabla tiene una fila con los encabezados ${headersContain.map((h) => `«${h}»`).join(", ")}. Tablas: ${tables.map((t, i) => `${i + 1}: ${(rowsOf(t)[0] ? cellsOf(rowsOf(t)[0]!).map((c) => norm(textOf(c))).join(" | ") : "sin filas").slice(0, 120)}`).join("; ")}.`);
    if (located.length > 1) reject(`Hay ${located.length} tablas con esos encabezados: agregá encabezados para distinguirlas.`);
    const { t, index, rows, hi } = located[0]!;
    if (rows.some((r) => cellsOf(r).some((c) => Number(attr(c, "colspan") ?? 1) > 1 || Number(attr(c, "rowspan") ?? 1) > 1))) reject("La tabla tiene celdas combinadas (colspan/rowspan): la columna de cada celda no es inequívoca.");
    const headers = cellsOf(rows[hi]!).map((c) => norm(textOf(c)));
    const dataRows = rows.slice(hi + 1);
    const col = (name: string) => {
        const idx = headers.flatMap((h, i) => (same(h, name) ? [i] : []));
        if (idx.length !== 1) reject(idx.length ? `El encabezado «${name}» aparece ${idx.length} veces.` : `La tabla no tiene la columna «${name}». Columnas: ${headers.join(" | ")}.`);
        return idx[0]!;
    };
    const row = (match: Record<string, string>) => {
        const conds = Object.entries(match).map(([h, v]) => ({ i: col(h), h, v }));
        if (!conds.length) reject("Para ubicar una fila hace falta al menos una condición (columna → texto).");
        const found = dataRows.filter((r) => conds.every((c) => norm(cellsOf(r)[c.i] ? textOf(cellsOf(r)[c.i]!) : "") === norm(c.v)));
        if (found.length !== 1) reject(found.length ? `${found.length} filas cumplen ${conds.map((c) => `${c.h}=«${c.v}»`).join(" y ")}: agregá condiciones.` : `Ninguna fila cumple ${conds.map((c) => `${c.h}=«${c.v}»`).join(" y ")}.`);
        return found[0]!;
    };
    return { table: t, index: index + 1, headers, dataRows, col, row };
}

const rowCells = (r: Element) => cellsOf(r).map((c) => norm(textOf(c)));

/** Cambio del texto de una celda: reemplaza su único nodo de texto, o lo agrega en el elemento más interno si está vacía. */
function cellEdit(html: string, cell: Element, value: string): Edit | null {
    const parts = textNodes(cell).filter((n) => norm(n.value));
    if (parts.length > 1) reject("El texto de una celda está repartido en varios nodos (formato parcial): no se puede cambiar sin tocar su formato.");
    if (parts.length === 1) {
        const loc = parts[0]!.sourceCodeLocation!;
        const raw = html.slice(loc.startOffset, loc.endOffset);
        const lead = /^\s*/.exec(raw)![0];
        const trail = /\s*$/.exec(raw.slice(lead.length))![0];
        return { start: loc.startOffset, end: loc.endOffset, text: `${lead}${escapeText(value)}${trail}` };
    }
    if (!value) return null;
    // Celda vacía: dentro del elemento más interno de una cadena de hijos únicos (p. ej. <td><p></p></td>).
    let host: Element = cell;
    for (;;) {
        const els = kids(host).filter((k): k is Element => isEl(k));
        if (els.length !== 1 || ["img", "br", "a"].includes(els[0]!.tagName)) break;
        host = els[0]!;
    }
    const at = host.sourceCodeLocation!.startTag!.endOffset;
    return { start: at, end: at, text: escapeText(value) };
}

export interface CellChange {
    row_match: Record<string, string>;
    column: string;
    expected_text: string;
    replacement_text: string;
}

export function patchCells(html: string, headersContain: string[], changes: CellChange[]) {
    if (!changes.length) reject("Indicá al menos un cambio de celda.");
    const t = locateTable(html, headersContain);
    const seen = new Set<Element>();
    const out = changes.map((c) => {
        const repl = norm(c.replacement_text);
        if (!repl) reject("replacement_text no puede quedar vacío.");
        if (CONTROL.test(c.replacement_text)) reject("replacement_text no puede tener saltos de línea ni caracteres de control.");
        if (norm(c.expected_text) === repl) reject(`El texto nuevo de ${c.column} es igual al actual.`);
        const r = t.row(c.row_match);
        const cell = cellsOf(r)[t.col(c.column)];
        if (!cell) reject(`La fila no tiene celda en la columna «${c.column}».`);
        if (seen.has(cell!)) reject("Dos cambios apuntan a la misma celda.");
        seen.add(cell!);
        const current = norm(textOf(cell!));
        if (current !== norm(c.expected_text)) reject(`La celda ${c.column} de esa fila dice «${current}», no «${norm(c.expected_text)}»: no se cambia nada.`);
        if (textNodes(cell!).filter((n) => norm(n.value)).length !== 1) reject("El texto de una celda está repartido en varios nodos (formato parcial): no se puede cambiar sin tocar su formato.");
        const edit = cellEdit(html, cell!, repl)!;
        return { edit, row_index: t.dataRows.indexOf(r) + 1, row_cells: rowCells(r), column: t.headers[t.col(c.column)]!, before: current, after: repl, before_fragment: html.slice(edit.start, edit.end), after_fragment: edit.text };
    });
    const result = applyEdits(html, out.map((o) => o.edit));
    const a = htmlSignature(html);
    const b = htmlSignature(result);
    const diff = a.flatMap((x, i) => (x !== b[i] ? [i] : []));
    guard(a.length === b.length && diff.length === out.length && diff.every((i) => out.some((o) => b[i] === `#${o.after}`)));
    return { html: result, table: { index: t.index, headers: t.headers }, changes: out.map(({ edit, ...rest }) => ({ ...rest, offset: edit.start })) };
}

/** `needle` aparece como bloque contiguo en `hay` exactamente donde quedaría tras insertarlo en `at`. */
const spliced = (hay: string[], base: string[], piece: string[]) => {
    if (hay.length !== base.length + piece.length) return false;
    for (let k = 0; k <= base.length; k++) {
        if (JSON.stringify([...base.slice(0, k), ...piece, ...base.slice(k)]) === JSON.stringify(hay)) return true;
    }
    return false;
};
const rowSignature = (rowHtml: string) => htmlSignature(`<table><tbody>${rowHtml}</tbody></table>`).slice(2, -2);

/**
 * Agrega una fila copiando el formato de otra (la indicada, o la última): mismos atributos y envoltorios en cada
 * celda, con el texto nuevo. Las columnas sin valor quedan vacías.
 */
export function addRow(html: string, headersContain: string[], values: Record<string, string>, afterRow?: Record<string, string>) {
    const t = locateTable(html, headersContain);
    if (!t.dataRows.length) reject("La tabla no tiene filas de datos para copiar su formato.");
    const template = afterRow ? t.row(afterRow) : t.dataRows[t.dataRows.length - 1]!;
    for (const k of Object.keys(values)) t.col(k);
    for (const v of Object.values(values)) if (CONTROL.test(v)) reject("Los valores no pueden tener saltos de línea ni caracteres de control.");
    const wanted = t.headers.map((h) => norm(Object.entries(values).find(([k]) => same(k, h))?.[1] ?? ""));
    if (wanted.every((v) => !v)) reject("La fila nueva no tiene ningún valor.");
    const loc = template.sourceCodeLocation!;
    const raw = html.slice(loc.startOffset, loc.endOffset);
    const cells = cellsOf(template);
    if (cells.length !== t.headers.length) reject("La fila modelo no tiene una celda por columna.");
    const edits = cells.flatMap((c, i) => {
        const e = cellEdit(html, c, wanted[i]!);
        return e ? [{ ...e, start: e.start - loc.startOffset, end: e.end - loc.startOffset }] : [];
    });
    const rowHtml = applyEdits(raw, edits);
    const sep = /\s*$/.exec(html.slice(0, loc.startOffset))![0];
    const result = html.slice(0, loc.endOffset) + sep + rowHtml + html.slice(loc.endOffset);
    guard(spliced(htmlSignature(result), htmlSignature(html), rowSignature(rowHtml)));
    guard(JSON.stringify(rowCells(locateTable(result, headersContain).dataRows[t.dataRows.indexOf(template) + 1]!)) === JSON.stringify(wanted));
    return { html: result, table: { index: t.index, headers: t.headers }, template_row: { index: t.dataRows.indexOf(template) + 1, cells: rowCells(template) }, new_row: Object.fromEntries(t.headers.map((h, i) => [h, wanted[i]!])), offset: loc.endOffset, after_fragment: sep + rowHtml };
}

/** Quita UNA fila de datos (no la de encabezados). `expected` (columna → texto) confirma que es la correcta. */
export function deleteRow(html: string, headersContain: string[], match: Record<string, string>) {
    const t = locateTable(html, headersContain);
    const r = t.row(match);
    const loc = r.sourceCodeLocation!;
    const sep = /\s*$/.exec(html.slice(0, loc.startOffset))![0];
    const result = html.slice(0, loc.startOffset - sep.length) + html.slice(loc.endOffset);
    const removed = html.slice(loc.startOffset, loc.endOffset);
    guard(spliced(htmlSignature(html), htmlSignature(result), rowSignature(removed)));
    return { html: result, table: { index: t.index, headers: t.headers }, deleted_row: { index: t.dataRows.indexOf(r) + 1, cells: rowCells(r) }, offset: loc.startOffset, before_fragment: removed };
}

// ---------- enlaces ----------

/** Dirección admitida como destino de un enlace: http(s) o mailto, sin credenciales ni caracteres de control. */
export function checkLinkUrl(raw: string): string {
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        return reject(`«${raw.slice(0, 80)}» no es una dirección válida.`);
    }
    if (!["https:", "http:", "mailto:"].includes(u.protocol)) reject("Sólo direcciones http(s) o mailto.");
    if (u.username || u.password) reject("La dirección no puede llevar usuario ni contraseña.");
    if (CONTROL.test(raw)) reject("La dirección no puede tener caracteres de control.");
    return raw.trim();
}

/**
 * Reemplaza el destino de los enlaces (<a href>) que apuntan EXACTAMENTE a `oldUrl`. Si el texto visible del
 * enlace es la propia dirección, también se actualiza. Las menciones de la dirección como texto suelto no se
 * tocan: se informan.
 */
export function replaceLinks(html: string, oldUrl: string, newUrl: string) {
    const root = parse(html);
    const anchors = elements(root, "a").filter((a) => attr(a, "href") === oldUrl);
    const edits: Edit[] = [];
    const hits = anchors.map((a) => {
        const loc = a.sourceCodeLocation!.attrs!["href"]!;
        edits.push({ start: loc.startOffset, end: loc.endOffset, text: `href="${escapeText(newUrl)}"` });
        const parts = textNodes(a).filter((n) => norm(n.value));
        const textIsUrl = parts.length === 1 && norm(parts[0]!.value) === oldUrl;
        if (textIsUrl) edits.push(cellEdit(html, a, newUrl)!);
        return { offset: loc.startOffset, text: norm(textOf(a)).slice(0, 120), text_replaced: textIsUrl };
    });
    const inAnchors = new Set(anchors.flatMap((a) => textNodes(a)));
    const mentions = textNodes(root).filter((n) => !inAnchors.has(n) && n.value.includes(oldUrl)).length;
    if (!hits.length) return { html, hits, plain_text_mentions: mentions };
    const result = applyEdits(html, edits);
    const a = htmlSignature(html);
    const b = htmlSignature(result);
    const changed = a.flatMap((x, i) => (x !== b[i] ? [i] : []));
    guard(a.length === b.length && changed.length === hits.length + hits.filter((h) => h.text_replaced).length);
    return { html: result, hits, plain_text_mentions: mentions };
}

// ---------- inserción ----------

/** Agrega un fragmento al principio o al final, sin tocar el resto. */
export function insertFragment(html: string, fragment: string, position: "start" | "end") {
    const result = position === "end" ? `${html}${html && !html.endsWith("\n") ? "\n" : ""}${fragment}` : `${fragment}\n${html}`;
    const base = htmlSignature(html);
    const piece = htmlSignature(fragment);
    const got = htmlSignature(result);
    guard(JSON.stringify(got) === JSON.stringify(position === "end" ? [...base, ...piece] : [...piece, ...base]));
    return result;
}

