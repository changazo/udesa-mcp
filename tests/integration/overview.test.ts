import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import { ASSIGN, ASSIGN_CMID, COURSE, OTHER_COURSE } from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("resumen de actividades", () => {
    it("normaliza las celdas: nombre, fecha, número, acción con alerta y enlace sin token", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourseOverview({ course_id: COURSE, modname: "assign" });
        const t = r.data.types[0]!;
        expect(t.columns.map((c) => c.label)).toEqual(["Nombre", "Fecha de entrega", "Entregas", "Acciones"]);
        const cells = Object.fromEntries(t.activities[0]!.cells.map((c) => [c.key, c]));
        expect(t.activities[0]!.course_module_id).toBe(ASSIGN_CMID);
        expect(cells.name).toMatchObject({ value: "TP1 sintético", text: "Sección: General" });
        expect(cells.duedate!.date).not.toBeNull();
        expect(cells.submissions).toMatchObject({ label: "Entregas", value: 2, text: "2 de 3" });
        expect(cells.actions).toMatchObject({ alert: { label: "Pendientes por calificar", count: 2 } });
        expect(cells.actions!.link).not.toContain("token=");
    });

    it("sin modname recorre los tipos del curso, omite recursos y avisa los que no tienen resumen", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourseOverview({ course_id: COURSE });
        expect(r.data.types.map((t) => t.modname)).toEqual(["assign", "quiz"]);
        const quiz = r.data.types[1]!.activities[0]!.cells.find((c) => c.key === "totalattempts")!;
        expect(quiz).toMatchObject({ value: "6", details: [{ label: "Intentos permitidos", value: "2" }] });
        const asked = h.fake.callsOf("core_courseformat_get_overview_information").map((c) => c.params.modname);
        expect(asked).not.toContain("resource");
        expect(asked).not.toContain("label");
        expect(r.warnings.join(" ")).toContain("no tiene resumen");
    });

    it("rechaza cursos fuera del perfil y modname inválidos", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getCourseOverview({ course_id: OTHER_COURSE }))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.getCourseOverview({ course_id: COURSE, modname: "assign;drop" }))).toBe("POLICY_DENIED");
    });
});

describe("pendientes con el resumen", () => {
    it("usa «Pendientes por calificar» del resumen cuando está disponible", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listPending({});
        const tp1 = r.data.to_grade.find((x) => x.assignment_id === ASSIGN)!;
        expect(tp1).toMatchObject({ requires_grading: 2, submitted: 2, method: "resumen", course_module_id: ASSIGN_CMID });
        // Con el resumen no hace falta consultar entrega por entrega.
        expect(h.fake.callsOf("mod_assign_list_participants")).toHaveLength(0);
    });

    it("si el resumen falla, calcula alumno por alumno y lo informa", async () => {
        const h = await makeHarness();
        h.fake.overviewFails = true;
        const r = await h.app.service.listPending({});
        const tp1 = r.data.to_grade.find((x) => x.assignment_id === ASSIGN)!;
        expect(tp1).toMatchObject({ requires_grading: 1, submitted: 1, late: 1, method: "calculado" });
        expect(r.warnings.join(" ")).toContain("Cursos calculados sin el resumen");
        expect(r.coverage.complete).toBe(true);
    });
});
