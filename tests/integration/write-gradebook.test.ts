import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, STUDENT_A } from "../fixtures/fake-moodle.js";
import { SyntheticGradebook } from "../fixtures/fake-gradebook.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-096: libro de calificaciones (ítems y notas). Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_gradebook"] } } });
    return { h, gb: new SyntheticGradebook(h.fake) };
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

describe("libro de calificaciones (ADR-096)", () => {
    it("ítem manual: agregar, editar y deshacer, ocultar y deshacer; los de actividades no se editan", async () => {
        const { h, gb } = await harness();
        const add = await run(h, "grade_item", { operation: "add", name: "Coloquio", max_grade: 20, pass_grade: 12 });
        expect(add.status).toBe("aplicado_verificado");
        const id = add.moodle_ids.item_id![0]!;
        expect(gb.items.get(id)).toMatchObject({ name: "Coloquio", max: 20, pass: 12, type: "manual" });
        const ed = await run(h, "grade_item", { operation: "edit", item_id: id, name: "Coloquio final", max_grade: 25.5 });
        expect(ed.status).toBe("aplicado_verificado");
        expect(gb.items.get(id)).toMatchObject({ name: "Coloquio final", max: 25.5 });
        expect((await undo(h, ed.action_id)).status).toBe("aplicado_verificado");
        expect(gb.items.get(id)).toMatchObject({ name: "Coloquio", max: 20 });
        const hide = await run(h, "grade_item", { operation: "hide", item_id: id });
        expect(gb.items.get(id)!.hidden).toBe(true);
        expect((await undo(h, hide.action_id)).status).toBe("aplicado_verificado");
        expect(gb.items.get(id)!.hidden).toBe(false);
        expect((await errOf(h.app.engine.plan("grade_item", { course_id: COURSE, operation: "edit", item_id: 8701, name: "X" }, "test"))).message).toMatch(/actividad/);
        expect((await errOf(h.app.engine.plan("grade_item", { course_id: COURSE, operation: "delete", item_id: 8701 }, "test"))).message).toMatch(/actividad/);
    });

    it("bloquear recalcula antes (Moodle no bloquea con notas pendientes); deshacer desbloquea", async () => {
        const { h, gb } = await harness();
        gb.items.get(8701)!.needsupdate = true;
        const r = await run(h, "grade_item", { operation: "lock", item_id: 8701 });
        expect(r.status).toBe("aplicado_verificado");
        expect(gb.items.get(8701)!.locked).toBe(true);
        expect(h.fake.web.requests.some((x) => x.path === "/grade/report/grader/index.php")).toBe(true);
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(gb.items.get(8701)!.locked).toBe(false);
    });

    it("nota de un ítem manual (coma decimal), excluir y retroalimentación; deshacer; borrar y recrear el ítem", async () => {
        const { h, gb } = await harness();
        const id = (await run(h, "grade_item", { operation: "add", name: "Parcial", max_grade: 20 })).moodle_ids.item_id![0]!;
        const g1 = await run(h, "gradebook_grade", { item_id: id, participant_id: STUDENT_A, grade: 15.5, feedback: "Bien" });
        expect(g1.status).toBe("aplicado_verificado");
        const g2 = await run(h, "gradebook_grade", { item_id: id, participant_id: STUDENT_A, grade: 17, excluded: true });
        expect(gb.grade(id, STUDENT_A)).toMatchObject({ final: "17", excluded: true });
        expect((await undo(h, g2.action_id)).status).toBe("aplicado_verificado");
        expect(gb.grade(id, STUDENT_A)).toMatchObject({ final: "15,50", excluded: false, feedback: "<p>Bien</p>" });
        // ADR-119: con notas cargadas, borrar el ítem es R4 y el plan dice cuántas.
        const dp = await h.app.engine.plan("grade_item", { course_id: COURSE, operation: "delete", item_id: id }, "test");
        expect(dp.risk).toBe("R4");
        expect(dp.summary).toMatch(/notas de 1 participante/);
        const del = await run(h, "grade_item", { operation: "delete", item_id: id });
        expect(del.status).toBe("aplicado_verificado");
        expect(gb.items.has(id)).toBe(false);
        const back = await undo(h, del.action_id);
        expect(back.status).toBe("aplicado_verificado");
        expect([...gb.items.values()].find((i) => i.name === "Parcial")).toMatchObject({ max: 20, type: "manual" });
    });

    it("sobrescribir la nota de una actividad (escala) y quitar la sobrescritura con el deshacer; nota bloqueada rechazada", async () => {
        const { h, gb } = await harness();
        expect((await errOf(h.app.engine.plan("gradebook_grade", { course_id: COURSE, item_id: 8701, participant_id: STUDENT_A, grade: "Excelente" }, "test"))).message).toMatch(/2 = Aprobado/);
        const r = await run(h, "gradebook_grade", { item_id: 8701, participant_id: STUDENT_A, grade: "Desaprobado" });
        expect(r.status).toBe("aplicado_verificado");
        expect(gb.grade(8701, STUDENT_A)).toMatchObject({ overridden: true, final: "1" });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(gb.grade(8701, STUDENT_A)).toMatchObject({ overridden: false, final: "2" });
        gb.grade(8701, STUDENT_A).locked = true;
        expect((await errOf(h.app.engine.plan("gradebook_grade", { course_id: COURSE, item_id: 8701, participant_id: STUDENT_A, grade: "Desaprobado" }, "test"))).message).toMatch(/bloqueada/);
    });

    it("si Moodle no guarda, sin_efecto", async () => {
        const { h, gb } = await harness();
        gb.noop = true;
        const r = await run(h, "grade_item", { operation: "hide", item_id: 8701 }).catch((e: CampusError) => e.details?.result as { status: string });
        expect(r.status).toBe("sin_efecto");
    });
});
