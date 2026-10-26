import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { W2_ASSIGN_CMID } from "../fixtures/fake-w2.js";
import { SyntheticSections } from "../fixtures/fake-sections.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness(courses = ["delete_content", "create_section"]) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: courses } } });
    return { h, s: new SyntheticSections(h.fake, h.w2) };
}
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("agregar una sección (ADR-067)", () => {
    it("al final; la sección nueva sale de la relectura (la respuesta trae todas, la primera es la 0); deshacer la borra si está vacía", async () => {
        const { h } = await harness();
        const r = await exec(h, (await plan(h, "create_section", {})).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(r.moodle_ids.section_number).toEqual([4]);
        const created = r.moodle_ids.section_id![0]!;
        expect(created).not.toBe(100); // nunca la sección 0
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(h.w2.sections.map((s) => s.section)).toEqual([0, 1, 2, 3]);
    });

    it("con actividades, el deshacer se niega (sería R4)", async () => {
        const { h } = await harness();
        const r = await exec(h, (await plan(h, "create_section", {})).plan_id);
        h.w2.extraModules.push({ id: 5555, modname: "page", name: "p", section: 4, visible: false });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        expect(u.undoable).toBe(false);
    });
});

describe("borrar una actividad o una sección (R4, ADR-067)", () => {
    it("actividad: confirm_name exacto, R4 sin aprobación (perfil sin umbral), verificada; sin deshacer automático", async () => {
        const { h } = await harness();
        h.w2.extraModules.push({ id: 6001, modname: "page", name: "Apunte viejo", section: 2, visible: true });
        expect((await errOf(plan(h, "delete_content", { course_module_id: 6001, confirm_name: "Apunte" }))).message).toMatch(/no coincide/);
        const p = await plan(h, "delete_content", { course_module_id: 6001, confirm_name: "Apunte viejo" });
        expect(p.risk).toBe("R4");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.w2.extraModules.some((m) => m.id === 6001)).toBe(false);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        expect(u.undoable).toBe(false);
    });

    it("sección con contenido: el plan lista lo que se borra; se borran sección y actividades; las siguientes se renumeran", async () => {
        const { h } = await harness();
        h.w2.extraModules.push({ id: 6002, modname: "url", name: "Link", section: 3, visible: true });
        const p = await plan(h, "delete_content", { section_number: 3, confirm_name: "Tema 3" });
        const listed = (p.payload_preview as { delete: { modules: { cmid: number }[] } }).delete.modules.map((m) => m.cmid);
        expect(listed).toContain(6002);
        expect(listed).toEqual(h.w2.extraModules.filter((m) => m.section === 3).map((m) => m.id));
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(h.w2.sections.map((s) => s.name)).toEqual(["General", "Tema 1", "Tema 2"]);
        expect(h.w2.extraModules.some((m) => listed.includes(m.id))).toBe(false);
    });

    it("Moodle salta el borrado sin error → sin_efecto, nunca «ok»", async () => {
        const { h, s } = await harness();
        s.skipDelete = true;
        expect((await exec(h, (await plan(h, "delete_content", { section_number: 2, confirm_name: "Tema 2" })).plan_id)).status).toBe("sin_efecto");
    });

    it("varias actividades de una vez (ADR-119): una por ítem, cada una con su nombre; el plan cuenta y nombra; un nombre equivocado no borra nada", async () => {
        const { h } = await harness();
        h.w2.extraModules.push({ id: 6101, modname: "page", name: "Pág A", section: 1, visible: true }, { id: 6102, modname: "label", name: "Etiq B", section: 2, visible: true });
        expect((await errOf(plan(h, "delete_content", { activities: [{ course_module_id: 6101, confirm_name: "Pág A" }, { course_module_id: 6102, confirm_name: "otra" }] }))).message).toMatch(/no coincide/);
        expect((await errOf(plan(h, "delete_content", { course_module_id: 6101, activities: [{ course_module_id: 6101, confirm_name: "Pág A" }, { course_module_id: 6102, confirm_name: "Etiq B" }] }))).message).toMatch(/uno solo/);
        const p = await plan(h, "delete_content", { activities: [{ course_module_id: 6101, confirm_name: "Pág A" }, { course_module_id: 6102, confirm_name: "Etiq B" }] });
        expect(p.risk).toBe("R4");
        expect(p.summary).toBe("BORRAR 2 actividades (1 página, 1 etiqueta), sin archivos adjuntos.");
        expect(p.items).toHaveLength(2);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.w2.extraModules.some((m) => m.id === 6101 || m.id === 6102)).toBe(false);
    });

    it("rechazos: ambos o ninguno, ajena, subsección como actividad; R4 por escalada se admite (ADR-118)", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, "delete_content", { confirm_name: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "delete_content", { course_module_id: W2_ASSIGN_CMID, section_number: 1, confirm_name: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "delete_content", { course_module_id: 4242, confirm_name: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        h.w2.extraModules.push({ id: 6003, modname: "subsection", name: "Sub", section: 1, visible: true });
        expect((await errOf(plan(h, "delete_content", { course_module_id: 6003, confirm_name: "Sub" }))).message).toMatch(/subsección/);
        // Un curso real sin fecha de habilitación escala el riesgo: create_section (R1) no llega a R4, pero
        // delete_content (R4) sigue en R4 y se admite.
        const real = await makeWriteHarness({ policy: { sandbox_course_ids: [], courses: { [String(COURSE)]: ["delete_content"] } } });
        new SyntheticSections(real.fake, real.w2);
        real.w2.extraModules.push({ id: 6004, modname: "page", name: "P", section: 1, visible: true });
        expect((await real.app.engine.plan("delete_content", { course_id: COURSE, course_module_id: 6004, confirm_name: "P" }, "test")).risk).toBe("R4");
    });
});
