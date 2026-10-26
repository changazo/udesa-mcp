import { CampusError } from "../errors.js";

/**
 * Parser XML mínimo y seguro (directiva §7.5): sin DTD, sin entidades externas ni declaradas,
 * con límites de profundidad, nodos y texto aplicados mientras se lee. Suficiente para el
 * formato Moodle XML de preguntas. No resuelve ni sigue URLs.
 */
export interface XmlElement {
    name: string;
    attrs: Record<string, string>;
    children: XmlElement[];
    /** Texto directo (incluye CDATA), concatenado. */
    text: string;
}

export interface XmlLimits {
    maxDepth: number;
    maxNodes: number;
    maxTextChars: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = { maxDepth: 64, maxNodes: 50_000, maxTextChars: 8_000_000 };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, (m, e: string) => {
        if (e[0] === "#") {
            const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
        }
        const v = ENTITIES[e];
        if (v === undefined) throw bad(`entidad no permitida &${e};`);
        return v;
    });
}

const bad = (why: string) => new CampusError("UNSUPPORTED_CONTENT", `XML rechazado: ${why}.`);

export function parseXml(input: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlElement {
    if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw bad("contiene DTD o entidades declaradas");
    const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
    const stack: XmlElement[] = [root];
    let i = 0;
    let nodes = 0;
    let textChars = 0;
    const n = input.length;
    const addText = (t: string) => {
        textChars += t.length;
        if (textChars > limits.maxTextChars) throw bad("texto demasiado grande");
        stack[stack.length - 1]!.text += t;
    };
    while (i < n) {
        const lt = input.indexOf("<", i);
        if (lt === -1) {
            if (input.slice(i).trim()) addText(decode(input.slice(i)));
            break;
        }
        if (lt > i) {
            const raw = input.slice(i, lt);
            if (stack.length > 1) addText(decode(raw));
            else if (raw.trim()) throw bad("texto fuera del elemento raíz");
        }
        if (input.startsWith("<?", lt)) {
            const end = input.indexOf("?>", lt + 2);
            if (end === -1) throw bad("instrucción sin cerrar");
            i = end + 2;
        } else if (input.startsWith("<!--", lt)) {
            const end = input.indexOf("-->", lt + 4);
            if (end === -1) throw bad("comentario sin cerrar");
            i = end + 3;
        } else if (input.startsWith("<![CDATA[", lt)) {
            const end = input.indexOf("]]>", lt + 9);
            if (end === -1) throw bad("CDATA sin cerrar");
            if (stack.length > 1) addText(input.slice(lt + 9, end));
            i = end + 3;
        } else if (input.startsWith("</", lt)) {
            const end = input.indexOf(">", lt + 2);
            if (end === -1) throw bad("etiqueta de cierre sin terminar");
            const name = input.slice(lt + 2, end).trim();
            const top = stack.pop();
            if (!top || top.name !== name || stack.length === 0) throw bad(`cierre inesperado </${name}>`);
            i = end + 1;
        } else if (input.startsWith("<!", lt)) {
            throw bad("declaración no permitida");
        } else {
            const end = findTagEnd(input, lt + 1);
            if (end === -1) throw bad("etiqueta sin terminar");
            let body = input.slice(lt + 1, end);
            const selfClosing = body.endsWith("/");
            if (selfClosing) body = body.slice(0, -1);
            const m = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(body);
            if (!m) throw bad("nombre de etiqueta inválido");
            const el: XmlElement = { name: m[1]!, attrs: parseAttrs(m[2]!), children: [], text: "" };
            if (++nodes > limits.maxNodes) throw bad("demasiados nodos");
            const parent = stack[stack.length - 1]!;
            if (parent === root && root.children.length > 0) throw bad("más de un elemento raíz");
            parent.children.push(el);
            if (!selfClosing) {
                stack.push(el);
                if (stack.length - 1 > limits.maxDepth) throw bad("profundidad excesiva");
            }
            i = end + 1;
        }
    }
    if (stack.length !== 1) throw bad("elementos sin cerrar");
    const top = root.children[0];
    if (!top) throw bad("sin elemento raíz");
    return top;
}

function findTagEnd(s: string, from: number): number {
    let quote: string | null = null;
    for (let i = from; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") return i;
    }
    return -1;
}

function parseAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    let consumed = "";
    while ((m = re.exec(s))) {
        out[m[1]!] = decode(m[3] ?? m[4] ?? "");
        consumed += m[0];
    }
    if (s.replace(re, "").trim()) throw bad("atributos mal formados");
    void consumed;
    return out;
}

/** Utilidades de navegación. */
export const child = (el: XmlElement | undefined, name: string) => el?.children.find((c) => c.name === name);
export const childrenOf = (el: XmlElement | undefined, name: string) => el?.children.filter((c) => c.name === name) ?? [];
export const textOf = (el: XmlElement | undefined) => (el ? el.text.trim() : null);
/** Texto del hijo <text> de un nodo de Moodle XML (p. ej. <questiontext><text>…</text></questiontext>). */
export const innerText = (el: XmlElement | undefined) => (el ? textOf(child(el, "text")) : null);
