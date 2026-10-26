import { decodeEntities, htmlToText } from "./html.js";

/**
 * Calificación avanzada de una entrega (rúbrica o guía de evaluación) a partir del HTML que Moodle
 * pone en `feedback.gradefordisplay` (mod_assign_get_submission_status). Ese HTML lo arman los
 * renderers oficiales de Moodle 5.1 (grade/grading/form/rubric|guide/renderer.php, modo «revisión»
 * para docentes y «vista» para estudiantes). Si la estructura no se reconoce, se devuelve
 * recognized=false con el texto plano: nunca una rúbrica vacía.
 */

export interface RubricCriterion {
    criterion_id: number;
    description: string | null;
    levels: { level_id: number; definition: string | null; score: number | null; selected: boolean }[];
    selected_level_id: number | null;
    remark: string | null;
}

export interface GuideCriterion {
    criterion_id: number;
    /** Nombre, descripción y puntaje máximo del criterio, como texto. */
    criterion_text: string | null;
    remark: string | null;
    score: number | null;
    max_score: number | null;
}

export type AdvancedGrading =
    | { method: "rubrica"; recognized: boolean; criteria: RubricCriterion[]; text: string | null }
    | { method: "guia"; recognized: boolean; criteria: GuideCriterion[]; text: string | null };

const plain = (html: string | undefined) => {
    const t = decodeEntities((html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    return t || null;
};
const num = (s: string | null) => {
    if (s === null) return null;
    const m = /-?\d+(?:[.,]\d+)?/.exec(s);
    return m ? Number(m[0].replace(",", ".")) : null;
};

/** Divide el HTML en tramos por criterio (`<tr class="criterion…" id="…-criteria-<id>">`). */
function criterionChunks(html: string): { id: number; chunk: string }[] {
    const starts = [...html.matchAll(/<tr\b[^>]*class="criterion[^"]*"[^>]*id="[^"]*-criteria-(\d{1,12})"[^>]*>/g)];
    return starts.map((m, i) => ({ id: Number(m[1]), chunk: html.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index : undefined) }));
}

function parseRubric(html: string): RubricCriterion[] {
    return criterionChunks(html).map(({ id, chunk }) => {
        const levels = [...chunk.matchAll(/<td\b([^>]*\bid="[^"]*-criteria-\d{1,12}-levels-(\d{1,12})"[^>]*)>([\s\S]*?)<\/td>/g)].map((m) => {
            const attrs = m[1]!;
            const body = m[3]!;
            const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
            return {
                level_id: Number(m[2]),
                definition: plain(/<div\b[^>]*class="definition[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(body)?.[1]),
                score: num(plain(/<span\b[^>]*class="scorevalue"[^>]*>([\s\S]*?)<\/span>/.exec(body)?.[1])),
                selected: /aria-checked="true"/.test(attrs) || /(^|\s)checked(\s|$)/.test(cls),
            };
        });
        const selected = levels.find((l) => l.selected);
        return {
            criterion_id: id,
            description: plain(/<td\b[^>]*class="description[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(chunk)?.[1]),
            levels,
            selected_level_id: selected ? selected.level_id : null,
            remark: plain(/<td\b[^>]*class="remark"[^>]*>([\s\S]*?)<\/td>/.exec(chunk)?.[1]),
        };
    });
}

function parseGuide(html: string): GuideCriterion[] {
    return criterionChunks(html).map(({ id, chunk }) => {
        const title = /<td\b[^>]*class="description[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(chunk)?.[1];
        // La celda de observación incluye un rótulo oculto (div.hidden) antes del texto.
        const remarkCell = /<td\b[^>]*class="remark"[^>]*>([\s\S]*?)<\/td>/.exec(chunk)?.[1]?.replace(/<div\b[^>]*class="hidden"[^>]*>[\s\S]*?<\/div>/, "");
        const scoreText = plain(/<td\b[^>]*class="score"[^>]*>([\s\S]*?)<\/td>/.exec(chunk)?.[1]);
        const parts = scoreText?.split("/") ?? [];
        return {
            criterion_id: id,
            criterion_text: title ? htmlToText(title).replace(/\s+\n/g, "\n").trim() || null : null,
            remark: plain(remarkCell),
            score: parts.length === 2 ? num(parts[0]!.trim() || null) : null,
            max_score: parts.length === 2 ? num(parts[1]!.trim() || null) : num(plain(/<div\b[^>]*class="criteriondescriptionscore"[^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1])),
        };
    });
}

/** null si el HTML no tiene calificación avanzada (nota simple). */
export function parseAdvancedGrading(html: string | null | undefined): AdvancedGrading | null {
    if (!html) return null;
    const rubric = /class="[^"]*\bgradingform_rubric\b/.test(html);
    const guide = /class="[^"]*\bgradingform_guide\b/.test(html);
    if (!rubric && !guide) return null;
    const text = htmlToText(html).slice(0, 8000) || null;
    if (rubric) {
        const criteria = parseRubric(html);
        return { method: "rubrica", recognized: criteria.length > 0 && criteria.every((c) => c.levels.length > 0), criteria, text };
    }
    const criteria = parseGuide(html);
    return { method: "guia", recognized: criteria.length > 0, criteria, text };
}

/** Texto de la nota sin la calificación avanzada (lo que Moodle agrega después del bloque «advancedgrade»). */
export function gradeTextWithoutAdvanced(html: string): string | null {
    const idx = html.lastIndexOf('class="advancedgrade"');
    if (idx < 0) return htmlToText(html).slice(0, 200) || null;
    // El bloque advancedgrade termina con su </div> de cierre; lo que sigue es el contenido por defecto (la nota).
    const tail = html.slice(html.lastIndexOf("<div", idx));
    let depth = 0;
    const re = /<(\/?)div\b[^>]*>/g;
    let m: RegExpExecArray | null;
    let end = -1;
    while ((m = re.exec(tail))) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) {
            end = m.index + m[0].length;
            break;
        }
    }
    return end < 0 ? null : htmlToText(tail.slice(end)).slice(0, 200) || null;
}
