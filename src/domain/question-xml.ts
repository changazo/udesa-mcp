import { CampusError } from "../errors.js";
import { child, childrenOf, innerText, parseXml, textOf, type XmlElement } from "../documents/xml.js";
import { htmlToText, sliceText } from "./html.js";

/**
 * Normalización de preguntas en Moodle XML (directiva §7.4). Una definición de pregunta no tiene
 * respuestas de estudiantes: `answers` son las opciones/respuestas definidas por el docente, con
 * su fracción. Los nodos de categoría no son preguntas. El valor exportado de `hidden` lo
 * normaliza el exportador y no se trata como estado original de la versión.
 */

export interface QText {
    format: string | null;
    /** Texto fuente tal como viene (HTML u otro formato), recortado si es enorme. */
    original: string | null;
    /** Versión legible normalizada (Markdown simple). */
    markdown: string | null;
    truncated: boolean;
}

export interface EmbeddedFile {
    /** Ubicación semántica: «questiontext», «answer[2].feedback», «generalfeedback»… */
    location: string;
    name: string;
    path: string;
    /** Orden de aparición dentro de la pregunta (parte del localizador). */
    ordinal: number;
    /** Tamaño decodificado estimado, sin decodificar el contenido. */
    bytes: number;
}

export interface NormalizedQuestion {
    type: string;
    interpretation: "completa" | "parcial" | "opaca";
    name: string | null;
    idnumber: string | null;
    question_text: QText | null;
    general_feedback: QText | null;
    default_grade: number | null;
    penalty: number | null;
    answers: { text: QText | null; fraction: number | null; fraction_raw: string | null; feedback: QText | null; extra: Record<string, unknown> }[];
    hints: QText[];
    type_data: Record<string, unknown>;
    /** Elementos presentes en el XML que este parser no interpretó. */
    uninterpreted_fields: string[];
    files: EmbeddedFile[];
}

const TEXT_CAP = 20_000;
const num = (v: string | null | undefined) => {
    if (v === null || v === undefined || v.trim() === "") return null;
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
};
const bool = (v: string | null | undefined) => {
    if (v === null || v === undefined) return null;
    const t = v.trim().toLowerCase();
    return t === "1" || t === "true" ? true : t === "0" || t === "false" ? false : null;
};

function qtext(el: XmlElement | undefined): QText | null {
    if (!el) return null;
    const format = el.attrs.format ?? null;
    const raw = innerText(el);
    if (raw === null || raw === "") return { format, original: raw === "" ? "" : null, markdown: raw === "" ? "" : null, truncated: false };
    const original = sliceText(raw, 0, TEXT_CAP);
    const md = format === "html" || format === "moodle_auto_format" ? htmlToText(raw) : raw;
    const mdSlice = sliceText(md, 0, TEXT_CAP);
    return { format, original: original.text, markdown: mdSlice.text, truncated: original.truncated || mdSlice.truncated };
}

/** Recorre los <file> embebidos en orden, con su ubicación semántica. */
function collectFiles(q: XmlElement): { files: EmbeddedFile[]; payloads: Map<number, string> } {
    const files: EmbeddedFile[] = [];
    const payloads = new Map<number, string>();
    let ordinal = 0;
    const walk = (el: XmlElement, location: string) => {
        const counters = new Map<string, number>();
        for (const c of el.children) {
            if (c.name === "file") {
                const data = c.text.replace(/\s+/g, "");
                const name = c.attrs.name ?? "archivo";
                // Nombre del XML: sólo como etiqueta; nunca como ruta del sistema de archivos.
                if (/[\\/]|^\.\.?$/.test(name)) continue;
                ordinal++;
                files.push({ location: location || "question", name, path: c.attrs.path ?? "/", ordinal, bytes: Math.floor((data.length * 3) / 4) });
                payloads.set(ordinal, data);
                continue;
            }
            const idx = (counters.get(c.name) ?? 0) + 1;
            counters.set(c.name, idx);
            const repeated = el.children.filter((x) => x.name === c.name).length > 1;
            walk(c, `${location ? `${location}.` : ""}${c.name}${repeated ? `[${idx}]` : ""}`);
        }
    };
    walk(q, "");
    return { files, payloads };
}

const COMMON = new Set(["name", "questiontext", "generalfeedback", "defaultgrade", "penalty", "hidden", "idnumber", "answer", "hint", "tags", "file"]);

type TypeParser = (q: XmlElement) => { data: Record<string, unknown>; known: string[]; complete: boolean };

const feedbackTriplet = (q: XmlElement) => ({
    correct_feedback: qtext(child(q, "correctfeedback")),
    partially_correct_feedback: qtext(child(q, "partiallycorrectfeedback")),
    incorrect_feedback: qtext(child(q, "incorrectfeedback")),
    show_num_correct: child(q, "shownumcorrect") ? true : null,
});
const FEEDBACK_KEYS = ["correctfeedback", "partiallycorrectfeedback", "incorrectfeedback", "shownumcorrect"];

/**
 * qformat_xml exporta dos tipos con otro nombre (`get_qtype`: match → matching, multianswer → cloze).
 * Se normalizan al qtype interno, el mismo que informan el inventario y campus_list_questions.
 */
const XML_QTYPE_ALIASES: Record<string, string> = { matching: "match", cloze: "multianswer" };

/** Registro de parsers por qtype (tipos core de la primera entrega). */
const PARSERS: Record<string, TypeParser> = {
    multichoice: (q) => ({
        data: {
            single: bool(textOf(child(q, "single"))),
            shuffle_answers: bool(textOf(child(q, "shuffleanswers"))),
            answer_numbering: textOf(child(q, "answernumbering")),
            show_standard_instruction: bool(textOf(child(q, "showstandardinstruction"))),
            ...feedbackTriplet(q),
        },
        known: ["single", "shuffleanswers", "answernumbering", "showstandardinstruction", ...FEEDBACK_KEYS],
        complete: true,
    }),
    truefalse: () => ({ data: {}, known: [], complete: true }),
    shortanswer: (q) => ({ data: { case_sensitive: bool(textOf(child(q, "usecase"))) }, known: ["usecase"], complete: true }),
    numerical: (q) => ({
        data: {
            units: childrenOf(child(q, "units"), "unit").map((u) => ({ name: textOf(child(u, "unit_name")), multiplier: num(textOf(child(u, "multiplier"))) })),
            unit_grading_type: num(textOf(child(q, "unitgradingtype"))),
            unit_penalty: num(textOf(child(q, "unitpenalty"))),
            show_units: num(textOf(child(q, "showunits"))),
            units_left: bool(textOf(child(q, "unitsleft"))),
        },
        known: ["units", "unitgradingtype", "unitpenalty", "showunits", "unitsleft"],
        complete: true,
    }),
    match: (q) => ({
        data: {
            shuffle_answers: bool(textOf(child(q, "shuffleanswers"))),
            pairs: childrenOf(q, "subquestion").map((s) => ({ prompt: qtext(s), answer: innerText(child(s, "answer")) })),
            ...feedbackTriplet(q),
        },
        known: ["shuffleanswers", "subquestion", ...FEEDBACK_KEYS],
        complete: true,
    }),
    essay: (q) => ({
        data: {
            response_format: textOf(child(q, "responseformat")),
            response_required: bool(textOf(child(q, "responserequired"))),
            response_field_lines: num(textOf(child(q, "responsefieldlines"))),
            min_word_limit: num(textOf(child(q, "minwordlimit"))),
            max_word_limit: num(textOf(child(q, "maxwordlimit"))),
            attachments: num(textOf(child(q, "attachments"))),
            attachments_required: num(textOf(child(q, "attachmentsrequired"))),
            max_bytes: num(textOf(child(q, "maxbytes"))),
            file_types: textOf(child(q, "filetypeslist")),
            grader_info: qtext(child(q, "graderinfo")),
            response_template: qtext(child(q, "responsetemplate")),
        },
        known: ["responseformat", "responserequired", "responsefieldlines", "minwordlimit", "maxwordlimit", "attachments", "attachmentsrequired", "maxbytes", "filetypeslist", "graderinfo", "responsetemplate"],
        complete: true,
    }),
    description: () => ({ data: {}, known: [], complete: true }),
};

export interface ParsedExport {
    /**
     * category_path: ruta del último nodo de categoría anterior a la pregunta (exportación con
     * «withcategories»), p. ej. «$module$/top/Unidad 2/Ejercicios». null si el archivo no trae
     * nodos de categoría. Es metadato del archivo, no un ID de categoría.
     */
    questions: { question: NormalizedQuestion; payloads: Map<number, string>; category_path: string | null }[];
    category_nodes: number;
    /** Rutas de categoría en el orden del archivo (incluye categorías vacías que Moodle agrega para conservar la jerarquía). */
    category_paths: string[];
}

/** Interpreta un archivo Moodle XML. Un XML válido sin preguntas devuelve una lista vacía declarada. */
export function parseQuestionXml(xml: string): ParsedExport {
    const root = parseXml(xml);
    if (root.name !== "quiz") throw new CampusError("UNEXPECTED_RESPONSE", "El archivo no es una exportación Moodle XML (falta <quiz>).");
    let category = 0;
    let currentPath: string | null = null;
    const categoryPaths: string[] = [];
    const questions: ParsedExport["questions"] = [];
    for (const q of childrenOf(root, "question")) {
        const rawType = q.attrs.type ?? "";
        const type = XML_QTYPE_ALIASES[rawType] ?? rawType;
        if (type === "category") {
            category++;
            currentPath = innerText(child(q, "category"))?.trim() || null;
            if (currentPath !== null) categoryPaths.push(currentPath);
            continue;
        }
        const parser = PARSERS[type];
        const typeOut = parser ? parser(q) : { data: {}, known: [], complete: false };
        const known = new Set([...COMMON, ...typeOut.known]);
        const uninterpreted = [...new Set(q.children.map((c) => c.name).filter((n) => !known.has(n)))];
        const { files, payloads } = collectFiles(q);
        const answers = childrenOf(q, "answer").map((a) => {
            const raw = a.attrs.fraction ?? null;
            const pct = num(raw);
            const extra: Record<string, unknown> = {};
            if (type === "numerical") extra.tolerance = num(textOf(child(a, "tolerance")));
            return { text: qtext(a), fraction: pct === null ? null : pct / 100, fraction_raw: raw, feedback: qtext(child(a, "feedback")), extra };
        });
        questions.push({
            question: {
                type,
                interpretation: !parser ? "opaca" : typeOut.complete && uninterpreted.length === 0 ? "completa" : "parcial",
                name: innerText(child(q, "name")),
                idnumber: textOf(child(q, "idnumber")) || null,
                question_text: qtext(child(q, "questiontext")),
                general_feedback: qtext(child(q, "generalfeedback")),
                default_grade: num(textOf(child(q, "defaultgrade"))),
                penalty: num(textOf(child(q, "penalty"))),
                answers: parser ? answers : [],
                hints: childrenOf(q, "hint").map((h) => qtext(h)!).filter(Boolean),
                type_data: typeOut.data,
                uninterpreted_fields: parser ? uninterpreted : [...new Set(q.children.map((c) => c.name).filter((n) => !COMMON.has(n)))],
                files,
            },
            payloads,
            category_path: currentPath,
        });
    }
    return { questions, category_nodes: category, category_paths: categoryPaths };
}
