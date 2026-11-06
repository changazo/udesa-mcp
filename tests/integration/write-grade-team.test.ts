import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { resultError } from "../../src/write/engine.js";
import { COURSE, STUDENT_A, STUDENT_B, STUDENT_C } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { G_ASSIGN, SyntheticGrading } from "../fixtures/fake-grading.js";
import { makeWriteHarness } from "../fixtures/write-harness.js";

const GROUP = 12, OTHER = 13, GROUPING = 99;

async function harness(opts: { allowNotify?: boolean; notifiable?: number[]; defaultNotify?: boolean } = {}) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["grade_submission", "edit_activity"] }, allow_participant_notifications: opts.allowNotify ?? false, notifiable_user_ids: opts.notifiable ?? [], notify_students_default: opts.defaultNotify ?? false } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    const g = new SyntheticGrading(h.fake, h.w2, acts);
    g.method = "scale";
    const members = new Map<number, number[]>([[STUDENT_A, [GROUP]], [STUDENT_B, [GROUP]], [STUDENT_C, [OTHER]]]);
    const o = h.fake.overrides;
    const assignments = o.get("mod_assign_get_assignments")!;
    o.set("mod_assign_get_assignments", (p) => {
        const result = assignments(p) as { courses: { assignments: { id: number }[] }[] };
        return { ...result, courses: result.courses.map((c) => ({ ...c, assignments: c.assignments.map((a) => a.id === G_ASSIGN ? { ...a, teamsubmission: 1, teamsubmissiongroupingid: GROUPING } : a) })) };
    });
    const people = () => [...members].map(([id, groups]) => ({ id, fullname: `Estudiante ${id}`, groups: groups.map((g) => ({ id: g, name: `Grupo ${g}` })), submissionstatus: "submitted" }));
    o.set("core_group_get_course_groups", () => [{ id: GROUP, courseid: COURSE, name: "Equipo" }, { id: OTHER, courseid: COURSE, name: "Otro" }]);
    o.set("core_enrol_get_enrolled_users", people);
    o.set("mod_assign_list_participants", people);
    o.set("gradereport_user_get_grade_items", (p) => {
        const id = Number(p.userid);
        return { usergrades: [{ userid: id, gradeitems: [{ id: 1, itemmodule: "assign", iteminstance: G_ASSIGN, graderaw: g.user(id).grade === null ? null : Number(g.user(id).grade), gradeislocked: false, gradeisoverridden: false, locked: false }] }], warnings: [] };
    });
    h.fake.web.pages.set("/group/assign.php", () => ({ body: `<select name="removeselect[]"><option value="${GROUP}.">Equipo</option><option value="${OTHER}.">Otro</option></select>` }));
    return { h, g, members };
}

async function error(p: Promise<unknown>) {
    try { await p; } catch (e) { if (e instanceof CampusError) return e; throw e; }
    throw new Error("se esperaba un error");
}

const request = { course_id: COURSE, assignment_id: G_ASSIGN, participant_id: STUDENT_A, group_id: GROUP, apply_to_group: true, grade: "Desaprobado", feedback_comment: "Reentrega, por favor." };

describe("calificación de entrega grupal", () => {
    it("muestra y califica a cada integrante sin applytoall, y verifica la escala y el comentario", async () => {
        const { h, g } = await harness();
        const plan = await h.app.engine.plan("grade_advanced", request, "test");
        expect(plan.payload_preview.group).toMatchObject({ group_id: GROUP, members: [{ id: STUDENT_A }, { id: STUDENT_B }] });
        expect(plan.items).toHaveLength(2);
        const result = await h.app.engine.execute(plan.plan_id, h.confirmer, "test");
        expect(result.status).toBe("aplicado_verificado");
        expect(result.items).toHaveLength(2);
        expect(g.posts).toHaveLength(2);
        expect(g.posts.every((x) => x.applytoall === "0" && x.sendstudentnotifications === "0")).toBe(true);
        expect(g.user(STUDENT_A).grade).toBe("1");
        expect(g.user(STUDENT_B).grade).toBe("1");
        expect(g.user(STUDENT_A).comment).toContain("Reentrega");
        expect(g.user(STUDENT_B).comment).toContain("Reentrega");
        expect(g.users.has(STUDENT_C)).toBe(false);
        expect((await h.app.engine.planUndo(result.action_id, "test")).undoable).toBe(false);
    });

    it("no acepta un grupo equivocado, ambiguo ni alcance grupal implícito", async () => {
        const { h, g, members } = await harness();
        expect((await error(h.app.engine.plan("grade_advanced", { ...request, group_id: OTHER }, "test"))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await error(h.app.engine.plan("grade_advanced", { ...request, apply_to_group: false, group_id: undefined }, "test"))).code).toBe("WRITE_NOT_ALLOWED");
        members.set(STUDENT_B, [GROUP, OTHER]);
        expect((await error(h.app.engine.plan("grade_advanced", request, "test"))).code).toBe("WRITE_NOT_ALLOWED");
        expect(g.posts).toHaveLength(0);
    });

    it("rechaza integrantes duplicados en lugar de escribirles dos veces", async () => {
        const { h, g } = await harness();
        const original = h.fake.overrides.get("core_enrol_get_enrolled_users")!;
        h.fake.overrides.set("core_enrol_get_enrolled_users", (p) => {
            const users = original(p) as Record<string, unknown>[];
            return [...users, users[0]];
        });
        expect((await error(h.app.engine.plan("grade_advanced", request, "test"))).code).toBe("UNEXPECTED_RESPONSE");
        expect(g.posts).toHaveLength(0);
    });

    it("no escribe si cambia la membresía entre el plan y la ejecución", async () => {
        const { h, g, members } = await harness();
        const plan = await h.app.engine.plan("grade_advanced", request, "test");
        members.set(STUDENT_B, [OTHER]);
        expect((await error(h.app.engine.execute(plan.plan_id, h.confirmer, "test"))).code).toBe("PLAN_STALE");
        expect(g.posts).toHaveLength(0);
    });

    it("no escribe si cambia el intento de entrega entre plan y ejecución", async () => {
        const { h, g } = await harness();
        const original = h.fake.overrides.get("mod_assign_get_submission_status")!;
        let attempt = 0;
        h.fake.overrides.set("mod_assign_get_submission_status", (p) => {
            const data = original(p) as { lastattempt: { submission: Record<string, unknown> } };
            data.lastattempt.submission.attemptnumber = attempt;
            return data;
        });
        const plan = await h.app.engine.plan("grade_advanced", request, "test");
        attempt = 1;
        expect((await error(h.app.engine.execute(plan.plan_id, h.confirmer, "test"))).code).toBe("PLAN_STALE");
        expect(g.posts).toHaveLength(0);
    });

    it("no abre la entrega ni crea un registro vacío si el grupo no tiene entrega", async () => {
        const { h, g } = await harness();
        const people = h.fake.overrides.get("mod_assign_list_participants")!;
        h.fake.overrides.set("mod_assign_list_participants", (p) => (people(p) as Record<string, unknown>[]).map((x) => ({ ...x, submissionstatus: "" })));
        expect((await error(h.app.engine.plan("grade_advanced", request, "test"))).code).toBe("WRITE_NOT_ALLOWED");
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(0);
        expect(g.posts).toHaveLength(0);
    });

    it("rechaza notas bloqueadas o sobrescritas antes de escribir", async () => {
        const { h, g } = await harness();
        const original = h.fake.overrides.get("gradereport_user_get_grade_items")!;
        h.fake.overrides.set("gradereport_user_get_grade_items", (p) => {
            const data = original(p) as { usergrades: { gradeitems: Record<string, unknown>[] }[] };
            if (Number(p.userid) === STUDENT_B) data.usergrades[0]!.gradeitems[0]!.gradeislocked = true;
            return data;
        });
        expect((await error(h.app.engine.plan("grade_advanced", request, "test"))).code).toBe("WRITE_NOT_ALLOWED");
        expect(g.posts).toHaveLength(0);
    });

    it("detecta una nota que Moodle guardó en el formulario pero no en el libro", async () => {
        const { h } = await harness();
        const original = h.fake.overrides.get("gradereport_user_get_grade_items")!;
        h.fake.overrides.set("gradereport_user_get_grade_items", (p) => {
            const data = original(p) as { usergrades: { gradeitems: Record<string, unknown>[] }[] };
            if (Number(p.userid) === STUDENT_B && data.usergrades[0]!.gradeitems[0]!.graderaw !== null) data.usergrades[0]!.gradeitems[0]!.graderaw = 2;
            return data;
        });
        const plan = await h.app.engine.plan("grade_advanced", request, "test");
        const result = await h.app.engine.execute(plan.plan_id, h.confirmer, "test");
        expect(result.status).not.toBe("aplicado_verificado");
        expect(result.items.find((i) => i.item_id === "i2")?.verification.differences).toEqual(expect.arrayContaining([expect.objectContaining({ field: "libro de calificaciones" })]));
    });

    it("rechaza archivos y ámbitos de grupo incorrectos", async () => {
        const { h, g } = await harness();
        expect((await error(h.app.engine.plan("grade_advanced", { ...request, add_feedback_file_paths: ["/tmp/a"] }, "test"))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await error(h.app.engine.plan("grade_advanced", { ...request, group_id: 999 }, "test"))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(g.posts).toHaveLength(0);
    });

    it("solicita avisar a cada integrante cuando el perfil lo permite", async () => {
        const { h, g } = await harness({ allowNotify: true });
        const plan = await h.app.engine.plan("grade_advanced", { ...request, notify_student: true }, "test");
        expect(plan.payload_preview.notify_student).toBe(true);
        expect(plan.side_effects.join(" ")).toMatch(/notificar a cada integrante/);
        expect((await h.app.engine.execute(plan.plan_id, h.confirmer, "test")).status).toBe("aplicado_verificado");
        expect(g.posts).toHaveLength(2);
        expect(g.posts.every((x) => x.applytoall === "0" && x.sendstudentnotifications === "1")).toBe(true);
    });

    it("exige permiso para todos los integrantes antes de abrir formularios o guardar", async () => {
        const { h, g } = await harness({ notifiable: [STUDENT_A] });
        expect((await error(h.app.engine.plan("grade_advanced", { ...request, notify_student: true }, "test"))).code).toBe("WRITE_NOT_ALLOWED");
        expect(g.posts).toHaveLength(0);
    });

    it("usa la preferencia del perfil y permite desactivarla explícitamente", async () => {
        const { h, g } = await harness({ allowNotify: true, defaultNotify: true });
        const p = await h.app.engine.plan("grade_advanced", { ...request, notify_student: false }, "test");
        expect(p.payload_preview.notify_student).toBe(false);
        expect((await h.app.engine.execute(p.plan_id, h.confirmer, "test")).status).toBe("aplicado_verificado");
        expect(g.posts.every((x) => x.sendstudentnotifications === "0")).toBe(true);
        const other = await harness({ allowNotify: true, defaultNotify: true });
        const defaultPlan = await other.h.app.engine.plan("grade_advanced", request, "test");
        expect(defaultPlan.payload_preview.notify_student).toBe(true);
        expect((await other.h.app.engine.execute(defaultPlan.plan_id, other.h.confirmer, "test")).status).toBe("aplicado_verificado");
        expect(other.g.posts.every((x) => x.sendstudentnotifications === "1")).toBe(true);
    });

    it("al replanificar una aplicación parcial no vuelve a escribir al integrante ya correcto", async () => {
        const { h, g } = await harness();
        g.user(STUDENT_A).grade = "1";
        g.user(STUDENT_A).comment = "<p>Reentrega, por favor.</p>";
        const plan = await h.app.engine.plan("grade_advanced", request, "test");
        expect(plan.items).toHaveLength(1);
        expect(plan.items[0]!.target.user_id).toBe(STUDENT_B);
        const result = await h.app.engine.execute(plan.plan_id, h.confirmer, "test");
        expect(result.status).toBe("aplicado_verificado");
        expect(g.posts).toHaveLength(1);
        expect(Number(g.posts[0]!.userid)).toBe(STUDENT_B);
    });

    it("al replanificar con aviso no repite el aviso a quien ya quedó correcto", async () => {
        const { h, g } = await harness({ allowNotify: true });
        g.user(STUDENT_A).grade = "1";
        g.user(STUDENT_A).comment = "<p>Reentrega, por favor.</p>";
        const plan = await h.app.engine.plan("grade_advanced", { ...request, notify_student: true }, "test");
        expect(plan.items.map((i) => i.target.user_id)).toEqual([STUDENT_B]);
        expect(plan.side_effects.join(" ")).toMatch(/ya tienen el estado pedido.*no.*reciben este aviso/);
        expect((await h.app.engine.execute(plan.plan_id, h.confirmer, "test")).status).toBe("aplicado_verificado");
        expect(g.posts).toHaveLength(1);
        expect(g.posts[0]).toMatchObject({ sendstudentnotifications: "1" });
    });

    it("reporta aplicación parcial si falla la segunda escritura", async () => {
        const { h, g } = await harness();
        const page = h.fake.web.pages.get("/mod/assign/view.php")!;
        h.fake.web.pages.set("/mod/assign/view.php", (q, req) => {
            if (req.method === "POST" && Number(new URLSearchParams(req.body ?? "").get("userid")) === STUDENT_B) return { status: 500, body: "error" };
            return page(q, req);
        });
        const plan = await h.app.engine.plan("grade_advanced", request, "test");
        const result = await h.app.engine.execute(plan.plan_id, h.confirmer, "test");
        expect(result.partial).toBe(true);
        expect(resultError(result)?.code).toBe("PARTIAL_APPLIED");
        expect(g.user(STUDENT_A).grade).toBe("1");
        expect(g.user(STUDENT_B).grade).toBeNull();
        expect(g.posts).toHaveLength(1);
    });
});
