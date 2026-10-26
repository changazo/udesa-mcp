import { describe, expect, it } from "vitest";
import { gradeTextWithoutAdvanced, parseAdvancedGrading } from "../../src/domain/grading-form.js";
import { makeHarness } from "../fixtures/harness.js";
import { ASSIGN, COURSE, STUDENT_A } from "../fixtures/fake-moodle.js";

/** Rúbrica como la arma gradingform_rubric_renderer (Moodle 5.1) en modo revisión, con datos sintéticos. */
const level = (c: number, l: number, def: string, score: string, checked: boolean, cls: string) =>
    `<td id="rubric0-criteria-${c}-levels-${l}" class="text-break level ${cls}${checked ? " checked" : ""}" style="width: 50%;" tabindex="0" aria-label="${def}, ${score} puntos" role="radio" aria-checked="${checked}"><div class="level-wrapper"><div class="definition" id="rubric0-criteria-${c}-levels-${l}-definition-container">${def}</div><div class="score d-inline"><span id="rubric0-criteria-${c}-levels-${l}-score" class="scorevalue">${score}</span> puntos</div></div></td>`;
const criterion = (c: number, desc: string, levels: string, remark: string | null, cls: string) =>
    `<tr class="criterion ${cls}" id="rubric0-criteria-${c}"><td class="description" id="rubric0-criteria-${c}-description-cell" tabindex="0" aria-label="Criterio ${desc}">${desc}</td><td class="levels"><table id="rubric0-criteria-${c}-levels-table" role="none"><tr id="rubric0-criteria-${c}-levels" aria-label="Niveles" role="radiogroup">${levels}</tr></table></td>${remark === null ? "" : `<td class="remark" id="rubric0-criteria-${c}-remark" tabindex="0" aria-label="Observación">${remark}</td>`}</tr>`;
export const RUBRIC_HTML = `<div class="advancedgrade"><div id="rubric-rubric0" class="clearfix gradingform_rubric review"><table class="criteria" id="rubric0-criteria"><caption class="visually-hidden">Rúbrica</caption>${criterion(
    11,
    "Claridad",
    level(11, 101, "Confuso", "0", false, "first odd") + level(11, 102, "Claro &amp; ordenado", "2", true, "last even"),
    "Muy bien",
    "first odd",
)}${criterion(12, "Pruebas", level(12, 201, "Sin pruebas", "0", false, "first odd") + level(12, 202, "Con pruebas", "1,5", false, "last even"), "", "last even")}</table></div></div>8,00 / 10,00`;

/** Guía de evaluación (gradingform_guide_renderer, modo revisión). */
export const GUIDE_HTML = `<div class="advancedgrade"><div id="guide-guide0" class="clearfix gradingform_guide review"><table class="criteria" id="guide0-criteria"><tr class="criterion first odd" id="guide0-criteria-21"><td class="description" id="guide0-criteria-21-shortname-cell" tabindex="0"><div class="criterionshortname">Análisis</div><div class="criteriondescription"><p>Profundidad del análisis</p></div><div class="criteriondescriptionmarkers"><p>Para docentes</p></div><div class="criteriondescriptionscore">5</div></td><td class="remark" tabindex="0" id="guide0-criteria-21-remark" aria-describedby="guide0-criteria-21-remark-desc"><div class="hidden" id="guide0-criteria-21-remark-desc">Observación para Análisis</div><div>Buen análisis</div></td><td class="score" tabindex="0" id="guide0-criteria-21-score"><div>4 / 5</div></td></tr></table></div></div>4,00 / 5,00`;

describe("calificación avanzada en la devolución (ADR-041)", () => {
    it("rúbrica: criterios, niveles con puntaje, nivel elegido y observación", () => {
        const g = parseAdvancedGrading(RUBRIC_HTML)!;
        expect(g.method).toBe("rubrica");
        expect(g.recognized).toBe(true);
        if (g.method !== "rubrica") throw new Error("tipo");
        expect(g.criteria).toEqual([
            {
                criterion_id: 11,
                description: "Claridad",
                levels: [
                    { level_id: 101, definition: "Confuso", score: 0, selected: false },
                    { level_id: 102, definition: "Claro & ordenado", score: 2, selected: true },
                ],
                selected_level_id: 102,
                remark: "Muy bien",
            },
            {
                criterion_id: 12,
                description: "Pruebas",
                levels: [
                    { level_id: 201, definition: "Sin pruebas", score: 0, selected: false },
                    { level_id: 202, definition: "Con pruebas", score: 1.5, selected: false },
                ],
                selected_level_id: null,
                remark: null,
            },
        ]);
        expect(gradeTextWithoutAdvanced(RUBRIC_HTML)).toBe("8,00 / 10,00");
    });

    it("guía de evaluación: texto del criterio, observación y puntaje sobre el máximo", () => {
        const g = parseAdvancedGrading(GUIDE_HTML)!;
        expect(g).toMatchObject({ method: "guia", recognized: true });
        if (g.method !== "guia") throw new Error("tipo");
        expect(g.criteria[0]).toMatchObject({ criterion_id: 21, remark: "Buen análisis", score: 4, max_score: 5 });
        expect(g.criteria[0]!.criterion_text).toContain("Análisis");
        expect(gradeTextWithoutAdvanced(GUIDE_HTML)).toBe("4,00 / 5,00");
    });

    it("nota simple: sin calificación avanzada; estructura desconocida: recognized=false con texto, nunca vacía", () => {
        expect(parseAdvancedGrading("8,00 / 10,00")).toBeNull();
        expect(parseAdvancedGrading(null)).toBeNull();
        const odd = parseAdvancedGrading('<div class="clearfix gradingform_rubric">Otra estructura</div>')!;
        expect(odd).toMatchObject({ method: "rubrica", recognized: false, criteria: [] });
        expect(odd.text).toContain("Otra estructura");
    });

    it("campus_get_submission con include_feedback incluye la rúbrica y la nota sin el bloque de rúbrica", async () => {
        const h = await makeHarness();
        h.fake.feedbackDisplay = RUBRIC_HTML;
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A, include_feedback: true });
        const fb = r.data.feedback!;
        expect(fb.grade_display).toBe("8,00 / 10,00");
        expect(fb.advanced_grading).toMatchObject({ method: "rubrica", recognized: true });
    });
});
