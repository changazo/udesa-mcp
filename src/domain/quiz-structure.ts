import { CampusError } from "../errors.js";
import { decodeEntities } from "./html.js";

/**
 * Estructura docente de un cuestionario desde mod_quiz_get_edit_grading_page_data (AJAX, sólo
 * lectura; ADR-033). Esa función exporta secciones, slots reales (id de base de datos, número
 * mostrado, nombre y nota máxima) e ítems de calificación. NO trae saltos de página, versiones
 * ni slots que no son preguntas (por ejemplo, descripciones): se declaran desconocidos.
 */

export type SlotKind = "fija" | "aleatoria" | "no_resuelta";

export interface QuizSlotOut {
    slot_id: number;
    /** Número que ve el docente (puede ser texto, p. ej. «i» o un número personalizado). */
    display_number: string;
    position: number;
    kind: SlotKind;
    /** Nombre de la pregunta (span «questionname» de Moodle). */
    name: string | null;
    /** Comienzo del enunciado que Moodle muestra junto al nombre (recortado por Moodle), si lo hay. */
    text_snippet: string | null;
    question_type_label: string | null;
    /** Sólo para preguntas fijas cuando la cuenta puede editarlas (se lee del enlace de edición). */
    question_id: number | null;
    random_rule: { bank_course_module_id: number | null; category_id: number | null; include_subcategories: boolean | null; other_conditions: string[] } | null;
    max_mark_raw: string | null;
    max_mark: number | null;
    grade_item_id: number | null;
    notes: string[];
}

export interface QuizStructureOut {
    sections: { name: string | null; slots: QuizSlotOut[] }[];
    grade_items: { grade_item_id: number; name: string | null; used: boolean | null; sum_marks_raw: string | null }[];
}

const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim() || null;

/** «1,50» → 1.5; «1.234,5» → 1234.5; «2.00» → 2. Devuelve null si no es un número. */
export function parseLocalizedMark(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).replace(/\s/g, "");
    if (!/^-?[\d.,]+$/.test(s)) return null;
    if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
    else if (s.includes(",")) s = s.replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function hrefs(html: string): URL[] {
    const out: URL[] = [];
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
        try {
            out.push(new URL(decodeEntities(m[1]!), "https://placeholder.invalid"));
        } catch {
            /* enlace inválido: se ignora */
        }
    }
    return out;
}

const spanText = (html: string, cls: string) => {
    const m = new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</span>`).exec(html);
    return m ? text(m[1]!) : null;
};

function classifySlot(displayname: string): Pick<QuizSlotOut, "kind" | "name" | "text_snippet" | "question_type_label" | "question_id" | "random_rule" | "notes"> {
    const snippet = spanText(displayname, "questiontext");
    const notes: string[] = [];
    const typeLabel = /<img[^>]*class="[^"]*activityicon[^"]*"[^>]*(?:title|alt)="([^"]*)"/i.exec(displayname)?.[1] ?? /<img[^>]*(?:title|alt)="([^"]+)"[^>]*class="[^"]*activityicon/i.exec(displayname)?.[1] ?? null;
    if (/invalidquestiontype|badge bg-danger/i.test(displayname)) notes.push("El Campus marca la pregunta como de tipo no disponible o categoría faltante.");
    const isRandom = /data-action="editrandomquestion"|mod_quiz_random_qbank_link/.test(displayname);
    if (isRandom) {
        const link = hrefs(displayname).find((u) => u.pathname.endsWith("/question/edit.php"));
        let rule: QuizSlotOut["random_rule"] = null;
        if (link) {
            const cmid = Number(link.searchParams.get("cmid"));
            let category: number | null = null;
            let sub: boolean | null = null;
            const other: string[] = [];
            try {
                const filter = JSON.parse(link.searchParams.get("filter") ?? "{}") as Record<string, { values?: unknown[]; filteroptions?: Record<string, unknown> | { name: string; value: unknown }[] }>;
                for (const [k, cond] of Object.entries(filter)) {
                    if (k === "category") {
                        const v = Number(cond?.values?.[0]);
                        category = Number.isInteger(v) && v > 0 ? v : null;
                        const fo = cond?.filteroptions;
                        const inc = Array.isArray(fo) ? fo.find((o) => o.name === "includesubcategories")?.value : fo?.includesubcategories;
                        sub = inc === undefined ? null : inc === true || inc === 1 || inc === "1" || inc === "true";
                    } else {
                        other.push(k);
                    }
                }
            } catch {
                notes.push("La regla aleatoria no se pudo interpretar.");
            }
            rule = { bank_course_module_id: Number.isInteger(cmid) && cmid > 0 ? cmid : null, category_id: category, include_subcategories: sub, other_conditions: other };
        }
        const unresolved = !rule || rule.category_id === null || /missingcategory|bg-danger/.test(displayname);
        // El nombre visible de la regla («Aleatoria (…)») sin los enlaces de acción.
        const name = text(displayname.replace(/<a[^>]*mod_quiz_random_qbank_link[^>]*>[\s\S]*?<\/a>/, ""));
        return { kind: unresolved ? "no_resuelta" : "aleatoria", name: spanText(displayname, "questionname") ?? name, text_snippet: snippet, question_type_label: typeLabel, question_id: null, random_rule: rule, notes };
    }
    const edit = hrefs(displayname).find((u) => u.pathname.endsWith("/question/bank/editquestion/question.php"));
    const qid = edit ? Number(edit.searchParams.get("id")) : NaN;
    const questionId = Number.isInteger(qid) && qid > 0 ? qid : null;
    if (questionId === null) notes.push("Moodle no expone el ID de esta pregunta para tu cuenta (sin permiso de edición).");
    return { kind: questionId === null ? "no_resuelta" : "fija", name: spanText(displayname, "questionname") ?? text(displayname), text_snippet: snippet, question_type_label: typeLabel, question_id: questionId, random_rule: null, notes };
}

/** Interpreta el JSON de la página de calificación. Estructura desconocida → UNEXPECTED_RESPONSE (nunca un vacío). */
export function parseGradingPageData(raw: unknown, quizId: number): QuizStructureOut {
    let data: unknown = raw;
    if (typeof raw === "string") {
        try {
            data = JSON.parse(raw);
        } catch {
            throw new CampusError("UNEXPECTED_RESPONSE", "La estructura del cuestionario no es JSON interpretable.");
        }
    }
    const d = data as { quizid?: unknown; sections?: unknown; gradeitems?: unknown };
    if (!d || typeof d !== "object" || !Array.isArray(d.sections) || (d.quizid !== undefined && Number(d.quizid) !== quizId)) {
        throw new CampusError("UNEXPECTED_RESPONSE", "La estructura del cuestionario no tiene el formato esperado o es de otro cuestionario.");
    }
    let position = 0;
    const sections = (d.sections as { displayname?: unknown; slots?: unknown }[]).map((s) => {
        if (!Array.isArray(s.slots)) throw new CampusError("UNEXPECTED_RESPONSE", "Sección sin lista de slots.");
        return {
            name: typeof s.displayname === "string" ? text(s.displayname) : null,
            slots: (s.slots as { id?: unknown; displaynumber?: unknown; displayname?: unknown; maxmark?: unknown; choices?: unknown }[]).map((sl) => {
                const id = Number(sl.id);
                if (!Number.isInteger(id) || id <= 0) throw new CampusError("UNEXPECTED_RESPONSE", "Slot sin identificador válido.");
                const raw = sl.maxmark === undefined || sl.maxmark === null ? null : String(sl.maxmark);
                const chosen = Array.isArray(sl.choices) ? (sl.choices as { id?: unknown; isselected?: unknown }[]).find((c) => c.isselected === true && Number(c.id) > 0) : undefined;
                return {
                    slot_id: id,
                    display_number: String(sl.displaynumber ?? ""),
                    position: ++position,
                    ...classifySlot(typeof sl.displayname === "string" ? sl.displayname : ""),
                    max_mark_raw: raw,
                    max_mark: parseLocalizedMark(raw),
                    grade_item_id: chosen ? Number(chosen.id) : null,
                };
            }),
        };
    });
    const grade_items = Array.isArray(d.gradeitems)
        ? (d.gradeitems as { id?: unknown; displayname?: unknown; name?: unknown; isused?: unknown; summarks?: unknown }[]).map((g) => ({
              grade_item_id: Number(g.id),
              name: typeof g.displayname === "string" ? text(g.displayname) : typeof g.name === "string" ? g.name : null,
              used: typeof g.isused === "boolean" ? g.isused : null,
              sum_marks_raw: g.summarks === undefined ? null : String(g.summarks),
          }))
        : [];
    return { sections, grade_items };
}

// ---------- Páginas y secciones (web: mod/quiz/edit.php; ADR-091) ----------

export interface QuizLayout {
    /** En orden. `heading` vacío = sección sin título (Moodle muestra un rótulo oculto). */
    sections: { section_id: number; heading: string; shuffle: boolean; first_slot: number | null; first_page: number | null }[];
    /** En orden; `number` = número de slot (1..n), como lo usa repaginate.php. */
    slots: { slot_id: number; number: number; page: number; section_id: number }[];
}

/**
 * Secciones, páginas y slots de la página de edición del cuestionario, en el orden del documento:
 * `<li id="section-N">` (cabecera en `span.instancesection`, con `visually-hidden` si no tiene título;
 * casilla `shuffle-N`), `<li … id="page-N">` y `<li … id="slot-N">`. Página irreconocible → null.
 */
export function parseQuizLayout(html: string): QuizLayout | null {
    if (!/id="page-mod-quiz-edit"|class="[^"]*mod-quiz-edit-content/.test(html)) return null;
    const sections: QuizLayout["sections"] = [];
    const slots: QuizLayout["slots"] = [];
    let page: number | null = null;
    const re = /<li\b[^>]*\bid="section-(\d+)"[^>]*>|<li\b[^>]*\bid="page-(\d+)"[^>]*>|<li\b[^>]*\bid="slot-(\d+)"[^>]*>|<span class="instancesection( visually-hidden)?">([^<]*)<\/span>|<input\b[^>]*\bid="shuffle-(\d+)"[^>]*>/g;
    for (const m of html.matchAll(re)) {
        const cur = sections.at(-1);
        if (m[1]) sections.push({ section_id: Number(m[1]), heading: "", shuffle: false, first_slot: null, first_page: null });
        else if (m[2]) page = Number(m[2]);
        else if (m[3]) {
            if (!cur || page === null) return null;
            slots.push({ slot_id: Number(m[3]), number: slots.length + 1, page, section_id: cur.section_id });
            cur.first_slot ??= slots.length;
            cur.first_page ??= page;
        } else if (m[5] !== undefined) {
            if (cur && !m[4]) cur.heading = decodeEntities(m[5]).trim();
        } else if (m[6] && cur && Number(m[6]) === cur.section_id) cur.shuffle = /\bchecked\b/.test(m[0]);
    }
    if (slots.length && !sections.length) return null;
    return { sections, slots };
}
