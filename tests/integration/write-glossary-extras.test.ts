import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-102: alias y categorías de entradas de glosario, y categorías del glosario. Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_activity_entries"] } } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    const g = acts.add({ kind: "glossary", name: "Glosario", intro: "", entries: [{ id: 80, concept: "Átomo", definition: "<p>Unidad</p>", aliases: ["átomos"], categories: [7] }], glossaryCategories: [{ id: 7, name: "Química" }, { id: 8, name: "Física" }] });
    return { h, acts, g };
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

describe("alias y categorías de glosarios (ADR-102)", () => {
    it("editar sólo la definición CONSERVA alias y categorías (Moodle los reescribe con lo enviado)", async () => {
        const { h, g } = await harness();
        const r = await run(h, "glossary_entry", { course_module_id: g.id, operation: "edit", entry_id: 80, definition: "Unidad **mínima**" });
        expect(r.status).toBe("aplicado_verificado");
        expect(g.entries![0]).toMatchObject({ aliases: ["átomos"], categories: [7] });
    });

    it("cambiar alias y categorías; deshacer; categoría ajena rechazada", async () => {
        const { h, g } = await harness();
        const r = await run(h, "glossary_entry", { course_module_id: g.id, operation: "edit", entry_id: 80, aliases: ["atom", "átomo"], categories: [7, 8] });
        expect(r.status).toBe("aplicado_verificado");
        expect(g.entries![0]).toMatchObject({ aliases: ["atom", "átomo"], categories: [7, 8] });
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(g.entries![0]).toMatchObject({ aliases: ["átomos"], categories: [7] });
        expect((await errOf(h.app.engine.plan("glossary_entry", { course_id: COURSE, course_module_id: g.id, operation: "edit", entry_id: 80, categories: [99] }, "test"))).message).toMatch(/99.*7 = Química/);
    });

    it("agregar con alias y categoría; borrar y recrear con el deshacer conserva alias y categorías", async () => {
        const { h, g } = await harness();
        const a = await run(h, "glossary_entry", { course_module_id: g.id, operation: "add", concept: "Ion", definition: "Carga", aliases: ["iones"], categories: [7] });
        expect(a.status).toBe("aplicado_verificado");
        const id = a.moodle_ids.entry_id![0]!;
        const d = await run(h, "glossary_entry", { course_module_id: g.id, operation: "delete", entry_id: id });
        expect((await undo(h, d.action_id)).status).toBe("aplicado_verificado");
        expect(g.entries!.find((e) => e.concept === "Ion")).toMatchObject({ aliases: ["iones"], categories: [7] });
    });

    it("categorías: agregar, renombrar y borrar con sus deshacer; nombre repetido rechazado", async () => {
        const { h, g } = await harness();
        const a = await run(h, "glossary_category", { course_module_id: g.id, operation: "add", name: "Biología" });
        expect(a.status).toBe("aplicado_verificado");
        const id = a.moodle_ids.category_id![0]!;
        const r = await run(h, "glossary_category", { course_module_id: g.id, operation: "rename", category_id: id, name: "Biología general" });
        expect(r.status).toBe("aplicado_verificado");
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        expect(g.glossaryCategories!.find((c) => c.id === id)!.name).toBe("Biología");
        expect((await undo(h, a.action_id)).status).toBe("aplicado_verificado");
        expect(g.glossaryCategories!.map((c) => c.name)).toEqual(["Química", "Física"]);
        expect((await errOf(h.app.engine.plan("glossary_category", { course_id: COURSE, course_module_id: g.id, operation: "add", name: "química" }, "test"))).message).toMatch(/Ya hay/);
        const del = await run(h, "glossary_category", { course_module_id: g.id, operation: "delete", category_id: 8 });
        expect(del.status).toBe("aplicado_verificado");
        expect((await undo(h, del.action_id)).status).toBe("aplicado_verificado");
        expect(g.glossaryCategories!.map((c) => c.name)).toContain("Física");
    });
});
