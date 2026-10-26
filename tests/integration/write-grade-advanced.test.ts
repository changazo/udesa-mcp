import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { parseGradeForm } from "../../src/write/intents/grade-advanced.js";
import { COURSE, STUDENT_A } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { G_ASSIGN, G_CMID, SyntheticGrading } from "../fixtures/fake-grading.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-095: rúbricas y guías (definición y calificación), escalas y archivos de retroalimentación. Datos inventados. */
async function harness(method: "points" | "scale" | "rubric" | "guide" = "rubric") {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["grade_submission", "edit_activity"] } } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    const g = new SyntheticGrading(h.fake, h.w2, acts);
    g.method = method;
    return { h, g, acts };
}
const run = async (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test")).plan_id, h.confirmer, "test");
async function undo(h: WriteHarness, actionId: string) {
    const u = await h.app.engine.planUndo(actionId, "test");
    if (!u.undoable) throw new Error(u.reason);
    return h.app.engine.execute(u.plan.plan_id, h.confirmer, "test");
}
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}
const RUBRIC = [
    { description: "Claridad", levels: [{ definition: "Confuso", score: 0 }, { definition: "Claro", score: 4 }] },
    { description: "Contenido", levels: [{ definition: "Incompleto", score: 0 }, { definition: "Completo", score: 6 }] },
];

describe("calificación avanzada (ADR-095)", () => {
    it("definir una rúbrica (sólo criterios nuevos), reemplazarla y deshacer; borrarla y deshacer", async () => {
        const { h, g } = await harness("rubric");
        const r = await run(h, "grading_definition", { course_module_id: G_CMID, operation: "define", name: "Rúbrica", rubric: RUBRIC });
        expect(r.status).toBe("aplicado_verificado");
        expect(g.def!.rubric.map((c) => [c.description, c.levels.map((l) => l.score)])).toEqual([["Claridad", [0, 4]], ["Contenido", [0, 6]]]);
        const rep = await run(h, "grading_definition", { course_module_id: G_CMID, operation: "define", rubric: [RUBRIC[0]] });
        expect(rep.status).toBe("aplicado_verificado");
        expect(g.def!.rubric.map((c) => c.description)).toEqual(["Claridad"]);
        expect((await undo(h, rep.action_id)).status).toBe("aplicado_verificado");
        expect(g.def!.rubric.map((c) => c.description)).toEqual(["Claridad", "Contenido"]);
        const del = await run(h, "grading_definition", { course_module_id: G_CMID, operation: "delete" });
        expect(del.status).toBe("aplicado_verificado");
        expect(g.def).toBeNull();
        expect((await undo(h, del.action_id)).status).toBe("aplicado_verificado");
        expect(g.def!.rubric).toHaveLength(2);
        expect((await errOf(h.app.engine.plan("grading_definition", { course_id: COURSE, course_module_id: G_CMID, operation: "define", guide: [{ shortname: "X", max_score: 2 }] }, "test"))).message).toMatch(/rúbrica/);
    });

    it("calificar con rúbrica: un nivel por criterio, observación y archivo; cambiar y deshacer; nunca notifica", async () => {
        const { h, g } = await harness("rubric");
        await run(h, "grading_definition", { course_module_id: G_CMID, operation: "define", name: "Rúbrica", rubric: RUBRIC });
        const dir = mkdtempSync(join(tmpdir(), "mcp-fb-"));
        writeFileSync(join(dir, "devolucion.txt"), "Bien");
        const g1 = await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, rubric: [{ criterion: "Claridad", level: "Claro", remark: "Muy claro" }, { criterion: "Contenido", level: 6 }], feedback_comment: "Bien", add_feedback_file_paths: [join(dir, "devolucion.txt")] });
        expect(g1.status).toBe("aplicado_verificado");
        const u = g.user(STUDENT_A);
        expect(u.files).toEqual(["devolucion.txt"]);
        expect([...u.rubric.values()].map((x) => x.remark)).toEqual(["Muy claro", ""]);
        expect(g.posts.at(-1)).toMatchObject({ sendstudentnotifications: "0", applytoall: "0" });
        // ADR-120: avisar sólo a una cuenta de prueba del sandbox; este participante no lo es.
        expect((await errOf(h.app.engine.plan("grade_advanced", { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, rubric: [{ criterion: "Claridad", level: 0 }], notify_student: true }, "test"))).message).toMatch(/no está permitido/);
        const g2 = await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, rubric: [{ criterion: "Claridad", level: "Confuso" }], remove_feedback_files: ["devolucion.txt"] });
        expect(g2.status).toBe("aplicado_verificado");
        expect(u.files).toEqual([]);
        expect((await undo(h, g2.action_id)).status).toBe("aplicado_verificado");
        expect(g.def!.rubric[0]!.levels.find((l) => l.id === u.rubric.get(g.def!.rubric[0]!.id)!.level)!.definition).toBe("Claro");
        expect((await errOf(h.app.engine.plan("grade_advanced", { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, rubric: [{ criterion: "Estilo", level: 1 }] }, "test"))).message).toMatch(/no tiene/);
        expect((await errOf(h.app.engine.plan("grade_advanced", { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, grade: 8 }, "test"))).message).toMatch(/rúbrica/);
    });

    it("primera calificación sin nota previa: sin deshacer; rúbrica incompleta rechazada", async () => {
        const { h } = await harness("rubric");
        await run(h, "grading_definition", { course_module_id: G_CMID, operation: "define", name: "Rúbrica", rubric: RUBRIC });
        expect((await errOf(h.app.engine.plan("grade_advanced", { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, rubric: [{ criterion: "Claridad", level: "Claro" }] }, "test"))).message).toMatch(/cada criterio/);
        const r = await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, rubric: [{ criterion: "Claridad", level: "Claro" }, { criterion: "Contenido", level: "Completo" }] });
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);
    });

    it("guía: puntaje por criterio dentro del máximo; deshacer", async () => {
        const { h, g } = await harness("guide");
        await run(h, "grading_definition", { course_module_id: G_CMID, operation: "define", name: "Guía", guide: [{ shortname: "Redacción", max_score: 4 }, { shortname: "Análisis", max_score: 6 }], comments: ["Ver fuentes"] });
        expect(g.def!.comments).toEqual(["Ver fuentes"]);
        expect((await errOf(h.app.engine.plan("grade_advanced", { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, guide: [{ criterion: "Redacción", score: 5 }, { criterion: "Análisis", score: 1 }] }, "test"))).message).toMatch(/0 a 4/);
        await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, guide: [{ criterion: "Redacción", score: 3 }, { criterion: "Análisis", score: 5 }] });
        const r = await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, guide: [{ criterion: "Análisis", score: 6, remark: "Excelente" }] });
        expect(r.status).toBe("aplicado_verificado");
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect([...g.user(STUDENT_A).guide.values()].map((x) => x.score)).toEqual(["3", "5"]);
    });

    it("escala: por el texto del ítem; ítem inexistente lista la escala; flujo de trabajo nunca «liberada»", async () => {
        const { h, g } = await harness("scale");
        g.workflowEnabled = true;
        expect((await errOf(h.app.engine.plan("grade_advanced", { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, grade: "Excelente" }, "test"))).message).toMatch(/2 = Aprobado/);
        await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, grade: "Aprobado" });
        const r = await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, grade: "Desaprobado", workflow_state: "readyforrelease" });
        expect(r.status).toBe("aplicado_verificado");
        expect(g.user(STUDENT_A)).toMatchObject({ grade: "1", workflow: "readyforrelease" });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(g.user(STUDENT_A)).toMatchObject({ grade: "2", workflow: "notmarked" });
        g.user(STUDENT_A).workflow = "released";
        expect((await errOf(h.app.engine.plan("grade_advanced", { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, grade: "Desaprobado" }, "test"))).message).toMatch(/liberada/);
    });

    it("si Moodle no guarda, sin_efecto; parser: formulario ajeno → null", async () => {
        const { h, g } = await harness("points");
        expect((await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, grade: 8.25 })).status).toBe("aplicado_verificado");
        g.noop = true;
        const r = await run(h, "grade_advanced", { assignment_id: G_ASSIGN, participant_id: STUDENT_A, grade: 8 }).catch((e: CampusError) => e.details?.result as { status: string });
        expect(r.status).toBe("sin_efecto");
        expect(parseGradeForm("<html><form><input name='x'></form></html>", STUDENT_A)).toBeNull();
    });

    it("campus_plan_grade (puntos) rechaza una tarea con rúbrica y remite a la avanzada (ADR-099)", async () => {
        const { h } = await harness("rubric");
        await run(h, "grading_definition", { course_module_id: G_CMID, operation: "define", name: "Rúbrica", rubric: RUBRIC });
        expect((await errOf(h.app.engine.plan("grade", { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, grade: 8 }, "test"))).message).toMatch(/rúbrica: usá campus_plan_grade_advanced/);
    });
});
