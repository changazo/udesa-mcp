import { decodeEntities } from "./html.js";

/** Pregunta de una encuesta (mod_questionnaire) tal como la lista la página de preguntas (ADR-097). */
export interface QuestionnaireRow {
    question_id: number;
    position: number | null;
    /** Tipo como lo muestra el Campus (p. ej. «Botones de radio»). */
    type: string | null;
    name: string | null;
}

/**
 * Filas de `/mod/questionnaire/questions.php`: cada `qn-container` trae «posición N», los botones con el
 * id de la pregunta (`editbutton[<id>]`) y la etiqueta «[tipo] (nombre)». Página irreconocible → null.
 */
export function parseQuestionnaireQuestions(html: string): QuestionnaireRow[] | null {
    if (!/_qf__mod_questionnaire_questions_form/.test(html)) return null;
    const rows: QuestionnaireRow[] = [];
    for (const chunk of html.split(/class="qn-container"/).slice(1)) {
        const id = /name="editbutton\[(\d+)\]"/.exec(chunk)?.[1];
        if (!id) continue;
        const text = decodeEntities(chunk.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
        const label = /\[([^\]]+)\]\s*(?:\(([^)]*)\))?/.exec(text);
        rows.push({ question_id: Number(id), position: Number(/(\d+)/.exec(/class="qnums"[^>]*>([^<]*)</.exec(chunk)?.[1] ?? "")?.[1]) || null, type: label?.[1]?.trim() ?? null, name: label?.[2]?.trim() || null });
    }
    return rows;
}
