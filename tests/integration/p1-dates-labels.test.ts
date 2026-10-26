import { describe, expect, it } from "vitest";
import { makeHarness } from "../fixtures/harness.js";
import { ASSIGN, COURSE, NOW_UNIX, STUDENT_A, STUDENT_B, STUDENT_C } from "../fixtures/fake-moodle.js";

const sub = (h: Awaited<ReturnType<typeof makeHarness>>, participant_id: number) =>
    h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id });

const participant = (extra: Record<string, unknown>) => () => ({
    id: STUDENT_A,
    grantedextension: false,
    blindmarking: false,
    allowsubmissionsfromdate: NOW_UNIX - 10 * 86400,
    duedate: NOW_UNIX - 3600,
    cutoffdate: 0,
    ...extra,
});

describe("fechas efectivas de una entrega (§6.1)", () => {
    it("sin override: fecha efectiva = la del participante y demora clasificada", async () => {
        const h = await makeHarness();
        const r = await sub(h, STUDENT_A);
        expect(r.data.effective_dates).toMatchObject({ status: "ok", source: "mod_assign_get_participant", extension: { granted: false } });
        expect(r.data.effective_dates.applicable_due!.unix).toBe(NOW_UNIX - 3600);
        expect(r.data.late).toBe(true);
        expect(JSON.stringify(r)).not.toContain("NO-EXPONER");
    });

    it("override de usuario o de grupo: se usa la fecha que calcula Moodle, no la base", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_assign_get_participant", participant({ duedate: NOW_UNIX + 86400 }));
        const r = await sub(h, STUDENT_A);
        expect(r.data.effective_dates.base.due!.unix).toBe(NOW_UNIX - 3600);
        expect(r.data.effective_dates.for_participant!.due!.unix).toBe(NOW_UNIX + 86400);
        expect(r.data.late).toBe(false);
    });

    it("prórroga con fecha conocida: la prórroga es la fecha aplicable", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_assign_get_participant", participant({ grantedextension: true }));
        const base = h.fake.overrides.get("mod_assign_get_submission_status");
        h.fake.overrides.set("mod_assign_get_submission_status", (p: Record<string, string>) => {
            void base;
            return {
                lastattempt: { submission: { id: 1, userid: Number(p.userid), status: "submitted", timemodified: NOW_UNIX - 1800, plugins: [] }, extensionduedate: NOW_UNIX + 3600 },
                warnings: [],
            };
        });
        const r = await sub(h, STUDENT_A);
        expect(r.data.effective_dates).toMatchObject({ status: "ok", extension: { granted: true } });
        expect(r.data.effective_dates.applicable_due!.unix).toBe(NOW_UNIX + 3600);
        expect(r.data.late).toBe(false);
    });

    it("prórroga indicada sin fecha: aplicable desconocida y demora sin clasificar", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_assign_get_participant", participant({ grantedextension: true }));
        const r = await sub(h, STUDENT_A);
        expect(r.data.effective_dates).toMatchObject({ status: "no_disponible", applicable_due: null, extension: { granted: true, due: null } });
        expect(r.data.late).toBeNull();
    });

    it("fechas desactivadas: no hay vencimiento y la entrega no es tardía", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_assign_get_participant", participant({ duedate: 0, cutoffdate: 0 }));
        const r = await sub(h, STUDENT_A);
        expect(r.data.effective_dates).toMatchObject({ status: "ok", applicable_due: null });
        expect(r.data.late).toBe(false);
    });

    it("datos efectivos ausentes: los datos base se entregan igual y la demora queda desconocida", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_assign_get_participant", () => ({ exception: "moodle_exception", errorcode: "invalidrecord", message: "x" }));
        const r = await sub(h, STUDENT_A);
        expect(r.data.status).toBe("submitted");
        expect(r.data.effective_dates).toMatchObject({ status: "no_disponible", for_participant: null });
        expect(r.data.late).toBeNull();
    });

    it("participante filtrado por la tabla del docente se distingue de «sin entrega»", async () => {
        const h = await makeHarness();
        const r = await sub(h, STUDENT_C);
        expect(r.data.effective_dates.status).toBe("participante_filtrado");
        expect(r.data.late).toBeNull();
    });

    it("prórroga del falso por defecto (B) sin fecha: desconocida", async () => {
        const h = await makeHarness();
        const r = await sub(h, STUDENT_B);
        expect(r.data.effective_dates.extension.granted).toBe(true);
        expect(r.data.effective_dates.applicable_due).toBeNull();
    });

    it("el costo de pendientes no crece con los alumnos: no consulta fechas por participante", async () => {
        const h = await makeHarness();
        await h.app.service.listPending({});
        expect(h.fake.callsOf("mod_assign_get_participant")).toHaveLength(0);
    });
});

describe("etiquetas de categoría de notas (§6.2)", () => {
    it("une por ID la etiqueta de categoría; los totales quedan sin etiqueta", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getGrades({ course_id: COURSE });
        const byName = Object.fromEntries(r.data.items.map((i) => [i.name, i.category_label]));
        expect(byName).toEqual({ "TP1 sintético": "Trabajos prácticos", Asistencia: "Curso", "Total del curso": null });
        expect(r.coverage.complete).toBe(true);
    });

    it("si la función falla, las notas siguen y sólo ese campo queda desconocido", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("core_grades_get_gradeitems", () => ({ exception: "required_capability_exception", errorcode: "nopermissions", message: "x" }));
        const r = await h.app.service.getGrades({ course_id: COURSE });
        expect(r.data.students.length).toBeGreaterThan(0);
        expect(r.data.items.every((i) => i.category_label === null)).toBe(true);
        expect(r.coverage).toMatchObject({ complete: false, detail: { unknown_fields: ["category_label"] } });
    });
});

describe("grupos de una actividad (§6.3)", () => {
    it("devuelve modo de grupos y grupos seleccionables del curso, descartando ajenos", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listGroups(COURSE, { course_module_id: 9301 });
        expect(r.data.activity).toEqual({
            course_module_id: 9301,
            group_mode: "separados",
            selectable_groups: [{ group_id: 1, name: "Comisión A" }],
            can_access_all_groups: true,
        });
    });

    it("una actividad de otro curso se rechaza sin consultar sus grupos", async () => {
        const h = await makeHarness();
        await expect(h.app.service.listGroups(COURSE, { course_module_id: 123456 })).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
        expect(h.fake.callsOf("core_group_get_activity_allowed_groups")).toHaveLength(0);
    });
});
