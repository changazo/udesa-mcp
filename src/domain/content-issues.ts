import { isIP } from "node:net";
import type { CourseContents } from "../moodle/schemas.js";
import { stripSecretParams } from "../util/redact.js";
import { CampusError } from "../errors.js";
import { defaultResolve, isPublicAddress, type ChatFileDeps } from "../write/chat-files.js";
import { htmlAttr, htmlChildren, isHtmlElement, isHtmlText, htmlRowCells, htmlTableRows, htmlTextOf, norm, parseHtmlFragment, type HtmlElement, type HtmlNode } from "../write/html-patch.js";

/**
 * Revisión de accesibilidad y formato del texto enriquecido que escribe el docente (ADR-139): resúmenes de
 * sección, etiquetas, contenido de páginas y descripciones de actividades. Sólo lee: parsea el HTML con
 * parse5 (el mismo parser del parche, ADR-136) y aplica reglas heurísticas. Opcionalmente verifica enlaces
 * externos con las salvaguardas de las descargas de ChatGPT (direcciones públicas, sin credenciales,
 * redirecciones revisadas), sin cookies ni token y nunca contra el propio Campus.
 */

export type ContentKind = "section_summary" | "label" | "page" | "description";
export type Severity = "alta" | "media" | "baja";

export interface ContentLocation {
    kind: ContentKind;
    /** Número de la sección principal (las subsecciones informan la de su sección). */
    section_number: number | null;
    course_module_id?: number;
    /** Nombre de la sección o del elemento. */
    name: string | null;
    /** Nombre de la subsección, si el texto está dentro de una. */
    in_subsection?: string | null;
}

export interface ContentIssue {
    location: ContentLocation;
    rule: string;
    severity: Severity;
    /** Fragmento de TEXTO (nunca HTML), hasta 120 caracteres. */
    evidence: string;
    suggestion: string;
}

export interface ContentText {
    location: ContentLocation;
    html: string;
}

/** Severidad por regla (fija: el resultado se puede contar y filtrar sin leer cada problema). */
export const RULES = {
    img_alt_missing: "alta",
    img_alt_empty: "media",
    img_alt_filename: "media",
    table_no_headers: "media",
    table_empty: "baja",
    link_text_empty: "alta",
    link_text_vague: "media",
    link_text_url: "baja",
    link_new_window: "baja",
    low_contrast: "media",
    heading_skip: "media",
    heading_empty: "media",
    all_caps: "baja",
    empty_paragraphs: "baja",
} as const satisfies Record<string, Severity>;
export type RuleId = keyof typeof RULES;

// ---------- Selección de textos ----------

type Section = CourseContents[number];
export interface PageContent {
    coursemodule: number;
    content?: string | null;
    contentformat?: number | null;
}

export interface ContentSelection {
    /** Textos en el orden de la página del curso; las páginas son un lugar a completar con su contenido. */
    items: ({ text: ContentText } | { page: { cmid: number; location: ContentLocation } })[];
    pages: number;
}

/**
 * Textos del alcance pedido, en el orden de la página del curso: resumen de la sección, y por cada elemento
 * su descripción (o el texto de la etiqueta) y, en las páginas, su contenido. Las subsecciones (Moodle 5)
 * se recorren dentro de su sección. Falla con RESOURCE_OUT_OF_SCOPE si el filtro no existe en el curso.
 */
export function selectContentTexts(sections: CourseContents, filter: { section_number?: number; course_module_id?: number }): ContentSelection {
    const delegated = new Map<number, Section>();
    for (const s of sections) if (s.component === "mod_subsection" && s.itemid) delegated.set(s.itemid, s);
    const top = sections.filter((s) => !(s.component === "mod_subsection" && s.itemid));
    const chosen = filter.section_number !== undefined ? top.filter((s) => s.section === filter.section_number) : top;
    if (filter.section_number !== undefined && !chosen.length) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El curso no tiene una sección principal número ${filter.section_number}.`);
    const items: ContentSelection["items"] = [];
    let pages = 0;
    const nested = new Set<number>();
    let found = filter.course_module_id === undefined;

    // `all`: todo el contenido de la sección (sin filtro de actividad, o la subsección pedida por su cmid).
    const walk = (s: Section, number: number | null, sub: string | null, all: boolean) => {
        const inSub = sub !== null ? { in_subsection: sub } : {};
        if (all && s.summary && s.summary.trim()) items.push({ text: { location: { kind: "section_summary", section_number: number, name: s.name ?? null, ...inSub }, html: s.summary } });
        for (const m of s.modules) {
            if (m.modname === "subsection" && m.instance) {
                const d = delegated.get(m.instance);
                // Moodle no permite subsecciones anidadas; el límite evita ciclos con datos raros.
                if (d && sub === null) {
                    nested.add(d.id);
                    const picked = m.id === filter.course_module_id;
                    if (picked) found = true;
                    walk(d, number, d.name ?? m.name ?? null, all || picked);
                }
                continue;
            }
            if (!all && m.id !== filter.course_module_id) continue;
            found = true;
            const location: ContentLocation = { kind: m.modname === "label" ? "label" : "description", section_number: number, course_module_id: m.id, name: m.name ?? null, ...inSub };
            if (m.description && m.description.trim()) items.push({ text: { location, html: m.description } });
            if (m.modname === "page") {
                items.push({ page: { cmid: m.id, location: { ...location, kind: "page" } } });
                pages++;
            }
        }
    };
    const everything = filter.course_module_id === undefined;
    for (const s of chosen) walk(s, s.section ?? null, null, everything);
    // Subsecciones sin módulo visible que las contenga (sólo en la vista completa), como en campus_get_course.
    if (filter.section_number === undefined) for (const s of sections) if (s.component === "mod_subsection" && s.itemid && !nested.has(s.id)) walk(s, s.section ?? null, s.name ?? "", everything);
    if (!found) throw new CampusError("RESOURCE_OUT_OF_SCOPE", filter.section_number !== undefined ? `La actividad ${filter.course_module_id} no está en la sección ${filter.section_number} del curso.` : `La actividad ${filter.course_module_id} no pertenece al curso.`);
    return { items, pages };
}

/** Completa el contenido de las páginas en su lugar. `pages` null = no se pudo leer (se cuentan como faltantes). */
export function withPageContents(sel: ContentSelection, pages: PageContent[] | null): { texts: ContentText[]; missing: number; non_html: number } {
    const byCmid = new Map((pages ?? []).map((p) => [p.coursemodule, p]));
    const texts: ContentText[] = [];
    let missing = 0;
    let nonHtml = 0;
    for (const it of sel.items) {
        if ("text" in it) {
            texts.push(it.text);
            continue;
        }
        const page = byCmid.get(it.page.cmid);
        if (!page) missing++;
        // Texto plano (2) o Markdown (4) no es HTML: no hay marcado que revisar.
        else if (page.contentformat === 2 || page.contentformat === 4) nonHtml++;
        else if (page.content && page.content.trim()) texts.push({ location: it.page.location, html: page.content });
    }
    return { texts, missing, non_html: nonHtml };
}

// ---------- Reglas sobre el HTML ----------

const snippet = (s: string, max = 120) => {
    const t = norm(s);
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const lower = (e: HtmlElement, name: string) => (htmlAttr(e, name) ?? "").trim().toLowerCase();
const HEADING = /^h([1-6])$/;
const MEDIA = new Set(["img", "iframe", "video", "audio", "object", "embed", "svg", "input", "canvas", "hr", "table"]);

function* elementsOf(n: HtmlNode): Generator<HtmlElement> {
    for (const k of htmlChildren(n)) {
        if (isHtmlElement(k)) {
            yield k;
            yield* elementsOf(k);
        } else if ("childNodes" in k) yield* elementsOf(k);
    }
}

/** Nombre accesible aproximado: aria-label o texto más los alt de las imágenes de adentro. */
function accessibleName(e: HtmlElement): string {
    const aria = norm(htmlAttr(e, "aria-label") ?? "");
    if (aria) return aria;
    const parts: string[] = [];
    const walk = (n: HtmlNode) => {
        if (isHtmlText(n)) parts.push(n.value);
        else if (isHtmlElement(n) && n.tagName === "img") parts.push(` ${htmlAttr(n, "alt") ?? ""} `);
        else for (const k of htmlChildren(n)) walk(k);
    };
    walk(e);
    return norm(parts.join(""));
}

const fold = (s: string) =>
    s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

/** Textos de enlace que no dicen adónde llevan (comparados sin tildes ni signos). */
const VAGUE_LINK_TEXTS = new Set(
    [
        "aquí", "aqui", "acá", "aca", "click aquí", "clic aquí", "click acá", "clic acá", "cliqueá aquí", "hacé click aquí", "hacé clic aquí", "haz clic aquí", "haga clic aquí",
        "hacé click acá", "hacé clic acá", "presioná aquí", "pulsa aquí", "ingresá aquí", "ingresá acá", "link", "enlace", "este enlace", "este link", "el enlace", "el link", "link aquí",
        "ver", "ver más", "más", "leer más", "más info", "más información", "here", "click here", "click", "this link", "link here", "more", "read more", "learn more", "this",
    ].map(fold),
);
const NEW_WINDOW_HINT = /(nueva|otra)\s+(ventana|pesta[ñn]a)|se abre (en|aparte)|new (window|tab)|opens in/i;
const FILENAME_ALT = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic)$|^(img|image|imagen|dsc|dscn|pxl|screenshot|captura)[\s_-]?\d|^(captura de pantalla|screenshot|screen shot)\b|^(imagen|image|foto|picture|img|logo|icono|icon|grafico|gráfico)\s*\d*$/i;

function imageName(e: HtmlElement): string {
    const src = (htmlAttr(e, "src") ?? "").trim();
    if (!src) return "imagen sin src";
    if (/^data:/i.test(src)) return "imagen incrustada (data:)";
    const path = src.split(/[?#]/)[0]!;
    let name = path.slice(path.lastIndexOf("/") + 1);
    try {
        name = decodeURIComponent(name);
    } catch {
        /* se deja como está */
    }
    return `imagen «${snippet(name, 60)}»`;
}

const DECORATIVE_ROLES = new Set(["presentation", "none"]);

function checkImage(e: HtmlElement, add: (rule: RuleId, evidence: string, suggestion: string) => void) {
    const alt = htmlAttr(e, "alt");
    const decorative = DECORATIVE_ROLES.has(lower(e, "role")) || lower(e, "aria-hidden") === "true";
    const labelled = norm(htmlAttr(e, "aria-label") ?? "") || norm(htmlAttr(e, "aria-labelledby") ?? "");
    if (alt === null) {
        if (labelled) return;
        if (decorative) add("img_alt_missing", imageName(e), "Está marcada como decorativa pero le falta alt=\"\": en el editor, tildá «Decorativa» al editar la imagen para que lo agregue.");
        else add("img_alt_missing", imageName(e), "Agregá un texto alternativo que diga lo que la imagen comunica (qué muestra y para qué está). Si es decorativa, tildá «Decorativa» en el editor.");
        return;
    }
    const a = norm(alt);
    if (!a) {
        if (!decorative && !labelled) add("img_alt_empty", imageName(e), "alt vacío sin marca de decorativa: si la imagen transmite información, describila; si es sólo adorno, tildá «Decorativa» en el editor (agrega role=\"presentation\").");
        return;
    }
    if (FILENAME_ALT.test(a)) add("img_alt_filename", `${imageName(e)}, alt «${snippet(a, 50)}»`, "El texto alternativo parece un nombre de archivo: reemplazalo por una descripción de lo que muestra la imagen.");
}

function checkTable(e: HtmlElement, add: (rule: RuleId, evidence: string, suggestion: string) => void) {
    const rows = htmlTableRows(e);
    const text = norm(htmlTextOf(e));
    const hasMedia = [...elementsOf(e)].some((x) => x.tagName === "img" || x.tagName === "iframe" || x.tagName === "video");
    if (!text && !hasMedia) {
        add("table_empty", `tabla de ${rows.length} fila(s) sin texto`, "La tabla no tiene texto: si sólo se usa para ubicar elementos, conviene quitarla; si es de diseño, marcala con role=\"presentation\".");
        return;
    }
    if (DECORATIVE_ROLES.has(lower(e, "role"))) return; // tabla de diseño declarada
    if (rows.length < 2) return; // sin fila de datos, no hay encabezado que pedir
    const hasHeader = [...elementsOf(e)].some((x) => x.tagName === "th" || x.tagName === "thead");
    if (hasHeader) return;
    const first = htmlRowCells(rows[0]!).map((c) => norm(htmlTextOf(c))).join(" | ");
    add("table_no_headers", `primera fila: ${snippet(first || "(vacía)", 100)}`, "La tabla no tiene celdas de encabezado: marcá la primera fila como encabezado (en el editor: Tabla → Propiedades de la fila → Encabezado; queda como <th scope=\"col\">) para que los lectores de pantalla anuncien la columna de cada dato.");
}

function checkLink(e: HtmlElement, add: (rule: RuleId, evidence: string, suggestion: string) => void) {
    const href = (htmlAttr(e, "href") ?? "").trim();
    if (!href) return;
    const name = accessibleName(e);
    const target = lower(e, "target");
    const host = (() => {
        try {
            return new URL(href).hostname;
        } catch {
            return null;
        }
    })();
    const where = host ? ` → ${host}` : "";
    if (!name) {
        add("link_text_empty", `enlace sin texto${where}`, "El enlace no tiene texto ni imagen con alt: agregá un texto que diga adónde lleva.");
        return;
    }
    if (/^(https?:\/\/|www\.)\S+$/i.test(name)) add("link_text_url", `«${snippet(stripSecretParams(name), 100)}»`, "El texto del enlace es la dirección: reemplazala por un texto que diga adónde lleva (p. ej. «Programa de la materia (PDF)»). Un lector de pantalla la lee carácter por carácter.");
    else if (VAGUE_LINK_TEXTS.has(fold(name))) add("link_text_vague", `«${snippet(name, 60)}»${where}`, "El texto del enlace no dice adónde lleva fuera de contexto: usá el nombre del destino (p. ej. «Guía de trabajos prácticos» en vez de «click aquí»).");
    if (target === "_blank" && !NEW_WINDOW_HINT.test(`${name} ${htmlAttr(e, "title") ?? ""}`)) {
        add("link_new_window", `«${snippet(name, 60)}»${where}`, "Se abre en una pestaña nueva sin avisarlo: agregá «(se abre en una pestaña nueva)» al texto, o quitá la apertura en ventana nueva.");
    }
}

/** Párrafo vacío: sin texto (ni espacios no separables) ni contenido no textual. */
function isEmptyParagraph(e: HtmlElement): boolean {
    if (e.tagName !== "p") return false;
    if (norm(htmlTextOf(e))) return false;
    return ![...elementsOf(e)].some((x) => MEDIA.has(x.tagName));
}

function checkEmptyRuns(parent: HtmlNode, add: (rule: RuleId, evidence: string, suggestion: string) => void) {
    let run = 0;
    let before = "";
    const flush = () => {
        if (run >= 3) add("empty_paragraphs", `${run} párrafos vacíos seguidos${before ? ` después de «${snippet(before, 60)}»` : ""}`, "Hay varios párrafos vacíos usados como espacio: borralos (el espacio entre bloques lo da el tema). Un lector de pantalla los anuncia como «en blanco».");
        run = 0;
    };
    for (const k of htmlChildren(parent)) {
        if (isHtmlText(k)) {
            if (!norm(k.value)) continue;
            flush();
            before = k.value;
            continue;
        }
        if (!isHtmlElement(k)) continue; // comentarios
        if (isEmptyParagraph(k)) {
            run++;
            continue;
        }
        flush();
        const t = norm(htmlTextOf(k));
        if (t) before = t;
    }
    flush();
}

const BLOCKS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "blockquote", "dd", "dt", "figcaption"]);

function checkAllCaps(e: HtmlElement, add: (rule: RuleId, evidence: string, suggestion: string) => void) {
    if ([...elementsOf(e)].some((x) => BLOCKS.has(x.tagName))) return; // se evalúa el bloque más interno
    const text = norm(htmlTextOf(e));
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    const upper = text.match(/\p{Lu}/gu)?.length ?? 0;
    if (letters >= 40 && text.split(" ").length >= 6 && upper / letters >= 0.9) {
        add("all_caps", `«${snippet(text, 80)}»`, "Texto largo todo en mayúsculas: cuesta leerlo y algunos lectores de pantalla lo deletrean. Escribilo en minúsculas y destacá con negrita o un encabezado.");
    }
}

// ---------- Contraste (sólo estilos en línea) ----------

export type Rgba = [number, number, number, number];

const NAMED_COLORS: Record<string, [number, number, number]> = {
    white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], orange: [255, 165, 0],
    gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], lightgray: [211, 211, 211], lightgrey: [211, 211, 211], darkgray: [169, 169, 169],
    darkgrey: [169, 169, 169], dimgray: [105, 105, 105], dimgrey: [105, 105, 105], gainsboro: [220, 220, 220], whitesmoke: [245, 245, 245],
    maroon: [128, 0, 0], navy: [0, 0, 128], purple: [128, 0, 128], teal: [0, 128, 128], olive: [128, 128, 0], lime: [0, 255, 0], aqua: [0, 255, 255],
    cyan: [0, 255, 255], fuchsia: [255, 0, 255], magenta: [255, 0, 255], pink: [255, 192, 203], brown: [165, 42, 42], gold: [255, 215, 0],
    lightblue: [173, 216, 230], lightgreen: [144, 238, 144], lightyellow: [255, 255, 224], beige: [245, 245, 220], khaki: [240, 230, 140],
    coral: [255, 127, 80], salmon: [250, 128, 114], violet: [238, 130, 238], indigo: [75, 0, 130], darkblue: [0, 0, 139], darkred: [139, 0, 0],
    darkgreen: [0, 100, 0], orangered: [255, 69, 0], skyblue: [135, 206, 235], lightskyblue: [135, 206, 250], lightcoral: [240, 128, 128],
};

/** Color CSS (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() y nombres básicos); null si no se puede interpretar. */
export function parseCssColor(raw: string): Rgba | null {
    const v = raw.replace(/!important/i, "").trim().toLowerCase();
    if (v === "transparent") return [0, 0, 0, 0];
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
    if (hex) {
        let h = hex[1]!;
        if (h.length <= 4) h = [...h].map((c) => c + c).join("");
        const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
        return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    const fn = /^rgba?\(\s*([^)]*)\)$/.exec(v);
    if (fn) {
        const parts = fn[1]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
        if (parts.length < 3 || parts.length > 4) return null;
        const ch = (p: string) => (p.endsWith("%") ? (parseFloat(p) * 255) / 100 : parseFloat(p));
        const [r, g, b] = parts.slice(0, 3).map(ch) as [number, number, number];
        const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
        if (![r, g, b, a].every(Number.isFinite)) return null;
        const clamp = (x: number, max: number) => Math.min(Math.max(x, 0), max);
        return [clamp(r, 255), clamp(g, 255), clamp(b, 255), clamp(a, 1)];
    }
    const named = NAMED_COLORS[v];
    return named ? [...named, 1] : null;
}

const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgba) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const over = (fg: Rgba, bg: Rgba): Rgba => {
    const a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
};

/** Relación de contraste WCAG 2.x entre dos colores (el primero se compone sobre el segundo si es translúcido). */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
    const a = luminance(over(fg, bg));
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const WHITE: Rgba = [255, 255, 255, 1];

/** Declaraciones de un atributo style (la última gana, como en CSS). */
function styleOf(e: HtmlElement): Map<string, string> {
    const out = new Map<string, string>();
    for (const decl of (htmlAttr(e, "style") ?? "").split(";")) {
        const i = decl.indexOf(":");
        if (i > 0) out.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
    }
    return out;
}

const toHex = ([r, g, b]: Rgba) => `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

interface Ctx {
    /** Fondo declarado más cercano: un color, o «desconocido» (imagen, degradado, variable). */
    bg: Rgba | "unknown" | null;
    /** Tamaño de letra en px, si se declaró. */
    size: number | null;
    bold: boolean;
}

const HEADING_PX = [32, 24, 18.72, 16, 13.28, 10.72];

function fontPx(v: string, inherited: number | null): number | null {
    const m = /^([\d.]+)(px|pt|em|rem|%)$/.exec(v.trim().toLowerCase());
    if (m) {
        const n = parseFloat(m[1]!);
        const base = inherited ?? 16;
        return m[2] === "px" ? n : m[2] === "pt" ? (n * 4) / 3 : m[2] === "%" ? (n * base) / 100 : m[2] === "em" ? n * base : n * 16;
    }
    const kw: Record<string, number> = { "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48 };
    return kw[v.trim().toLowerCase()] ?? inherited;
}

function backgroundOf(e: HtmlElement, style: Map<string, string>): Rgba | "unknown" | null {
    const raw = style.get("background-color") ?? style.get("background") ?? htmlAttr(e, "bgcolor");
    if (raw === undefined || raw === null || !raw.trim()) return null;
    const c = parseCssColor(raw);
    if (c) return c[3] === 0 ? null : c[3] < 1 ? over(c, WHITE) : c;
    // Shorthand con un solo color entre otras palabras (p. ej. «#fff no-repeat»); con imagen o degradado, desconocido.
    if (/url\(|gradient|var\(/i.test(raw)) return "unknown";
    const tokens = raw.split(/\s+(?![^(]*\))/).map(parseCssColor).filter((x): x is Rgba => x !== null);
    return tokens.length === 1 ? (tokens[0]![3] < 1 ? over(tokens[0]!, WHITE) : tokens[0]!) : "unknown";
}

/** Texto propio de un elemento: sin el de descendientes que declaran su propio color. */
function ownText(e: HtmlElement): string {
    const parts: string[] = [];
    const walk = (n: HtmlNode, root: boolean) => {
        if (isHtmlText(n)) parts.push(n.value);
        else if (isHtmlElement(n) && !root && (styleOf(n).has("color") || htmlAttr(n, "color") !== null)) return;
        else for (const k of htmlChildren(n)) walk(k, false);
    };
    walk(e, true);
    return norm(parts.join(""));
}

function checkContrast(root: HtmlNode, add: (rule: RuleId, evidence: string, suggestion: string, severity?: Severity) => void) {
    const walk = (n: HtmlNode, ctx: Ctx) => {
        for (const k of htmlChildren(n)) {
            if (!isHtmlElement(k)) {
                if ("childNodes" in k) walk(k, ctx);
                continue;
            }
            const style = styleOf(k);
            const bg = backgroundOf(k, style);
            const h = HEADING.exec(k.tagName);
            const weight = style.get("font-weight")?.toLowerCase();
            const next: Ctx = {
                bg: bg ?? ctx.bg,
                size: style.has("font-size") ? fontPx(style.get("font-size")!, ctx.size) : h ? HEADING_PX[Number(h[1]) - 1]! : ctx.size,
                bold: ctx.bold || !!h || k.tagName === "strong" || k.tagName === "b" || weight === "bold" || weight === "bolder" || (weight !== undefined && Number(weight) >= 700),
            };
            const rawColor = style.get("color") ?? (k.tagName === "font" ? htmlAttr(k, "color") : null);
            if (rawColor && next.bg !== "unknown") {
                const fg = parseCssColor(rawColor);
                const text = fg ? ownText(k) : "";
                if (fg && fg[3] > 0 && text) {
                    const background = next.bg ?? WHITE;
                    const ratio = contrastRatio(fg, background);
                    const large = (next.size ?? 16) >= 24 || (next.bold && (next.size ?? 16) >= 18.66);
                    const min = large ? 3 : 4.5;
                    if (ratio < min) {
                        add(
                            "low_contrast",
                            `«${snippet(text, 60)}»: ${toHex(over(fg, background))} sobre ${toHex(background)}${next.bg ? "" : " (fondo blanco supuesto)"}, ${ratio.toFixed(2)}:1`,
                            `Contraste insuficiente (mínimo ${min}:1 para ${large ? "texto grande" : "texto normal"}, WCAG 1.4.3): oscurecé el color del texto o quitá el color en línea para usar el del tema.`,
                            ratio < 3 ? "alta" : "media",
                        );
                    }
                }
            }
            walk(k, next);
        }
    };
    walk(root, { bg: null, size: null, bold: false });
}

/** Problemas de UN texto, en orden de documento. */
export function analyzeHtml(html: string, location: ContentLocation): ContentIssue[] {
    const root = parseHtmlFragment(html);
    const out: ContentIssue[] = [];
    const add = (rule: RuleId, evidence: string, suggestion: string, severity?: Severity) => out.push({ location, rule, severity: severity ?? RULES[rule], evidence: snippet(evidence), suggestion });
    let prevHeading: number | null = null;
    checkEmptyRuns(root, add);
    for (const e of elementsOf(root)) {
        if (e.tagName === "img") checkImage(e, add);
        else if (e.tagName === "table") checkTable(e, add);
        else if (e.tagName === "a") checkLink(e, add);
        const h = HEADING.exec(e.tagName);
        if (h) {
            const level = Number(h[1]);
            const name = accessibleName(e);
            if (!name) add("heading_empty", `encabezado h${level} vacío`, "Encabezado sin texto: borralo o escribile un título (los lectores de pantalla navegan por encabezados).");
            else if (prevHeading !== null && level > prevHeading + 1) add("heading_skip", `h${prevHeading} → h${level}: «${snippet(name, 60)}»`, `Salto de nivel de encabezado: usá h${prevHeading + 1} (o reorganizá los niveles) para que la estructura se pueda recorrer en orden.`);
            prevHeading = level;
        }
        if (BLOCKS.has(e.tagName)) checkAllCaps(e, add);
        if (e.tagName !== "p" && htmlChildren(e).some((k) => isHtmlElement(k) && k.tagName === "p")) checkEmptyRuns(e, add);
    }
    checkContrast(root, add);
    return out;
}

/** Enlaces http(s) de un texto, tal como están (sin decodificar ni seguir). */
export function linksOf(html: string): string[] {
    const out: string[] = [];
    for (const e of elementsOf(parseHtmlFragment(html))) {
        if (e.tagName !== "a") continue;
        const href = (htmlAttr(e, "href") ?? "").trim();
        if (/^https?:\/\//i.test(href)) out.push(href);
    }
    return out;
}

// ---------- Verificación de enlaces ----------

export type LinkStatus = "ok" | "roto" | "no_verificado";

export interface LinkCheck {
    /** Dirección mostrada sin parámetros de acceso ni credenciales. */
    url: string;
    status: LinkStatus;
    http_status: number | null;
    reason: string | null;
    /** Destino final si hubo redirecciones (sin parámetros de acceso). */
    final_url: string | null;
    occurrences: number;
    location: ContentLocation;
}

export type LinkCheckDeps = ChatFileDeps & {
    /** Reloj en ms (para los plazos); por defecto Date.now. */
    now?: () => number;
};

export const LINK_CHECK_MAX = 30;
const LINK_CONCURRENCY = 4;
const LINK_TIMEOUT_MS = 5_000;
const LINK_MAX_REDIRECTS = 3;
/** Plazo por enlace (incluidas redirecciones y el GET de respaldo) y plazo total de la verificación. */
const LINK_BUDGET_MS = 10_000;
const LINKS_TOTAL_BUDGET_MS = 25_000;
/** Parámetros que pueden llevar una credencial del Campus: esos enlaces no se piden. */
const ACCESS_PARAMS = /^(wstoken|privatetoken|sesskey|token)$/i;

const sameSite = (host: string, campusHost: string) => host === campusHost || host.endsWith(`.${campusHost}`);

/** Motivo por el que una URL no se pide (null = se puede pedir). Misma vara que las descargas de ChatGPT, más http. */
async function refusal(u: URL, campusHost: string, resolve: (h: string) => Promise<string[]>): Promise<string | null> {
    if (u.protocol !== "https:" && u.protocol !== "http:") return "sólo se verifican enlaces http(s)";
    if (u.username || u.password) return "la dirección lleva usuario o contraseña: no se pide";
    if ([...u.searchParams.keys()].some((k) => ACCESS_PARAMS.test(k))) return "la dirección lleva parámetros de acceso: no se pide";
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (sameSite(host, campusHost)) return "enlace al Campus: requiere sesión, no se verifica";
    if (u.port && !((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80"))) return "puerto no estándar: no se pide";
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
        try {
            addresses = await resolve(host);
        } catch {
            return "no se pudo resolver el nombre del servidor";
        }
    }
    if (!addresses.length) return "no se pudo resolver el nombre del servidor";
    if (!addresses.every(isPublicAddress)) return "apunta a una dirección no pública: no se pide";
    return null;
}

async function request(fetchImpl: typeof fetch, url: string, method: "HEAD" | "GET", timeoutMs: number): Promise<Response> {
    if (timeoutMs <= 0) throw new DOMException("plazo agotado", "TimeoutError");
    // Sin cookies ni credenciales: el pedido no lleva nada del Campus ni de la cuenta.
    const res = await fetchImpl(url, { method, redirect: "manual", credentials: "omit", headers: { accept: "*/*" }, signal: AbortSignal.timeout(Math.min(LINK_TIMEOUT_MS, timeoutMs)) });
    if (method === "GET") await res.body?.cancel().catch(() => undefined);
    return res;
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

async function checkOne(raw: string, campusHost: string, deps: Required<LinkCheckDeps>, totalDeadline: number): Promise<Pick<LinkCheck, "status" | "http_status" | "reason" | "final_url">> {
    const deadline = Math.min(deps.now() + LINK_BUDGET_MS, totalDeadline);
    const left = () => deadline - deps.now();
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { status: "no_verificado", http_status: null, reason: "dirección mal formada", final_url: null };
    }
    const first = url.href;
    for (let hop = 0; ; hop++) {
        const why = await refusal(url, campusHost, deps.resolve);
        if (why) return { status: "no_verificado", http_status: null, reason: hop ? `redirige a ${stripSecretParams(url.href)}: ${why}` : why, final_url: hop ? stripSecretParams(url.href) : null };
        let res: Response;
        const lost = (e: unknown) => ({ status: "no_verificado" as const, http_status: null, reason: isTimeout(e) ? "tiempo agotado" : "sin respuesta (red)", final_url: url.href !== first ? stripSecretParams(url.href) : null });
        try {
            res = await request(deps.fetchImpl, url.href, "HEAD", left());
            // Muchos servidores no atienden HEAD: cualquier respuesta que no sea 2xx/3xx se confirma con GET.
            if (res.status >= 400) res = await request(deps.fetchImpl, url.href, "GET", left());
        } catch (e) {
            // Si HEAD agotó el plazo, un GET también lo haría.
            if (isTimeout(e)) return lost(e);
            try {
                res = await request(deps.fetchImpl, url.href, "GET", left());
            } catch (e2) {
                return lost(e2);
            }
        }
        const final = url.href !== first ? stripSecretParams(url.href) : null;
        if (res.status >= 300 && res.status < 400) {
            const next = res.headers.get("location");
            if (!next) return { status: "no_verificado", http_status: res.status, reason: "redirección sin destino", final_url: final };
            if (hop >= LINK_MAX_REDIRECTS) return { status: "no_verificado", http_status: res.status, reason: "demasiadas redirecciones", final_url: final };
            try {
                url = new URL(next, url);
            } catch {
                return { status: "no_verificado", http_status: res.status, reason: "redirección a una dirección mal formada", final_url: final };
            }
            continue;
        }
        if (res.status >= 200 && res.status < 300) return { status: "ok", http_status: res.status, reason: null, final_url: final };
        if (res.status === 404 || res.status === 410) return { status: "roto", http_status: res.status, reason: res.status === 404 ? "no encontrado" : "eliminado", final_url: final };
        const reason = res.status === 401 || res.status === 403 ? "requiere acceso" : res.status === 429 ? "el servidor limitó los pedidos" : res.status >= 500 ? "error del servidor" : "respuesta no concluyente";
        return { status: "no_verificado", http_status: res.status, reason, final_url: final };
    }
}

/**
 * Verifica hasta LINK_CHECK_MAX enlaces distintos (de a LINK_CONCURRENCY, 5 s por pedido, 10 s por enlace y
 * 25 s en total, para no agotar la invocación remota). Sólo da «roto» con 404 o 410; lo inalcanzable o
 * ambiguo queda «no_verificado» con el motivo.
 */
export async function checkLinks(found: { url: string; location: ContentLocation }[], campusUrl: string, deps: LinkCheckDeps = {}): Promise<{ results: LinkCheck[]; distinct: number; skipped: number }> {
    const full: Required<LinkCheckDeps> = { fetchImpl: deps.fetchImpl ?? ((i, init) => fetch(i, init)), resolve: deps.resolve ?? defaultResolve, now: deps.now ?? Date.now };
    const totalDeadline = full.now() + LINKS_TOTAL_BUDGET_MS;
    const campusHost = new URL(campusUrl).hostname.toLowerCase();
    const unique = new Map<string, { location: ContentLocation; occurrences: number }>();
    for (const f of found) {
        const u = unique.get(f.url);
        if (u) u.occurrences++;
        else unique.set(f.url, { location: f.location, occurrences: 1 });
    }
    const entries = [...unique.entries()];
    const todo = entries.slice(0, LINK_CHECK_MAX);
    const results: LinkCheck[] = new Array(todo.length);
    let next = 0;
    const worker = async () => {
        for (let i = next++; i < todo.length; i = next++) {
            const [raw, meta] = todo[i]!;
            const r: Pick<LinkCheck, "status" | "http_status" | "reason" | "final_url"> =
                full.now() >= totalDeadline ? { status: "no_verificado", http_status: null, reason: "no se alcanzó a verificar (plazo total agotado)", final_url: null } : await checkOne(raw, campusHost, full, totalDeadline);
            results[i] = { url: stripSecretParams(raw), ...r, occurrences: meta.occurrences, location: meta.location };
        }
    };
    await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, todo.length) }, worker));
    return { results, distinct: entries.length, skipped: entries.length - todo.length };
}

// ---------- Resumen ----------

export function summarize(issues: ContentIssue[]) {
    const by_severity: Record<Severity, number> = { alta: 0, media: 0, baja: 0 };
    const by_rule: Partial<Record<RuleId, number>> = {};
    for (const i of issues) {
        by_severity[i.severity]++;
        by_rule[i.rule as RuleId] = (by_rule[i.rule as RuleId] ?? 0) + 1;
    }
    return { issues_total: issues.length, by_severity, by_rule };
}
