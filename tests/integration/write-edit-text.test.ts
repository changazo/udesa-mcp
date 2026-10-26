import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** Cuatro actividades sintéticas con descripción (y contenido / nota) editables por modedit.php?update. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_activity"] } } });
    const acts = new Map<number, { kind: string; name: string; intro: string; content?: string; grade?: number }>([
        [9811, { kind: "assign", name: "TP", intro: "<p>Consigna vieja</p>", grade: 100 }],
        [9812, { kind: "quiz", name: "Parcial", intro: "" }],
        [9813, { kind: "forum", name: "Debate", intro: "<p>Foro</p>" }],
        [9814, { kind: "page", name: "Guía", intro: "", content: "<p>Viejo</p>" }],
        [9815, { kind: "url", name: "Link", intro: "", content: "https://a.example/" }],
        [9816, { kind: "label", name: "Aviso", intro: "<p>Texto viejo</p>" }],
    ]);
    for (const [id, a] of acts) h.w2.extraModules.push({ id, modname: a.kind, name: a.name, section: 1, visible: true, ...(a.kind === "label" ? { description: a.intro } : {}) });
    const grades: number[] = [];
    const posts: Record<string, string>[] = [];
    const state = { noop: false };
    const rows = (kind: string, extra: (cm: number) => Record<string, unknown>) => [...acts].filter(([, a]) => a.kind === kind).map(([cm, a]) => ({ id: cm + 1000, coursemodule: cm, course: COURSE, name: a.name, intro: a.intro, ...extra(cm) }));
    h.fake.overrides.set("mod_assign_get_assignments", () => ({ courses: [{ id: COURSE, assignments: rows("assign", (cm) => ({ cmid: cm, grade: acts.get(cm)!.grade })) }], warnings: [] }));
    h.fake.overrides.set("mod_quiz_get_quizzes_by_courses", () => ({ quizzes: rows("quiz", () => ({})), warnings: [] }));
    h.fake.overrides.set("mod_forum_get_forums_by_courses", () => rows("forum", (cm) => ({ cmid: cm })));
    h.fake.overrides.set("mod_url_get_urls_by_courses", () => ({ urls: rows("url", (cm) => ({ externalurl: acts.get(cm)!.content })), warnings: [] }));
    h.fake.overrides.set("mod_page_get_pages_by_courses", () => ({ pages: [...acts].filter(([, a]) => a.kind === "page").map(([cm, a]) => ({ id: cm + 1000, coursemodule: cm, course: COURSE, name: a.name, intro: a.intro, content: a.content })), warnings: [] }));
    h.fake.overrides.set("mod_assign_get_grades", () => ({ assignments: [{ assignmentid: 8651, grades: grades.map((g, i) => ({ userid: i + 1, grade: g.toFixed(5) })) }], warnings: [] }));
    const prev = h.fake.web.pages.get("/course/modedit.php")!;
    h.fake.web.pages.set("/course/modedit.php", (q, req) => {
        const b = new URLSearchParams(req.body ?? "");
        const cm = Number(q.update ?? b.get("update") ?? 0);
        const a = acts.get(cm);
        if (!a) return prev(q, req);
        const qf = `_qf__mod_${a.kind}_mod_form`;
        if (req.method === "GET") {
            return {
                body: `<html><body><form action="${SITE}/course/modedit.php" method="post"><input type="hidden" name="update" value="${cm}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="${qf}" value="1"><input type="text" name="name" value="${a.name}"><textarea name="introeditor[text]">${a.intro}</textarea><input type="hidden" name="introeditor[format]" value="1"><input type="hidden" name="forcesubscribe" value="3">${a.kind === "page" ? `<textarea name="page[text]">${a.content}</textarea>` : ""}${a.kind === "url" ? `<input type="text" name="externalurl" value="${a.content}">` : ""}${a.grade !== undefined ? `<input type="hidden" name="grade[modgrade_type]" value="point"><input type="text" name="grade[modgrade_point]" value="${a.grade}">` : ""}<input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton2" value="Guardar"></form></body></html>`,
            };
        }
        posts.push(Object.fromEntries(b));
        if (!state.noop) {
            a.intro = b.get("introeditor[text]") ?? a.intro;
            if (a.kind === "page") a.content = b.get("page[text]") ?? a.content;
            if (a.kind === "url") a.content = b.get("externalurl") ?? a.content;
            if (a.kind === "label") h.w2.extraModules.find((m) => m.id === cm)!.description = a.intro;
            if (a.grade !== undefined) a.grade = Number(b.get("grade[modgrade_point]") ?? a.grade);
        }
        return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
    });
    return { h, acts, grades, posts, state };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("edit_activity_text", { course_id: COURSE, ...input }, "test");
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

describe("editar descripción, contenido de página y nota máxima (ADR-075)", () => {
    it("descripción de tarea, cuestionario y foro + nota de la tarea; el resto del formulario vuelve intacto; deshacer", async () => {
        const { h, acts, posts } = await harness();
        for (const cm of [9811, 9812, 9813]) {
            const r = await exec(h, (await plan(h, { course_module_id: cm, description: "Leer el **apunte**.", ...(cm === 9811 ? { max_grade: 20 } : {}) })).plan_id);
            expect(r.status).toBe("aplicado_verificado");
            expect(acts.get(cm)!.intro).toContain("<strong>apunte</strong>");
            const u = await h.app.engine.planUndo(r.action_id, "test");
            if (!u.undoable) throw new Error(u.reason);
            expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        }
        expect(acts.get(9811)).toMatchObject({ intro: "<p>Consigna vieja</p>", grade: 100 });
        expect(posts.find((p) => p._qf__mod_forum_mod_form)).toMatchObject({ forcesubscribe: "3", name: "Debate", submitbutton2: "1" });
        expect(posts.every((p) => !("coursecontentnotification" in p))).toBe(true);
    });

    it("contenido de una página", async () => {
        const { h, acts } = await harness();
        expect((await exec(h, (await plan(h, { course_module_id: 9814, content: "# Nuevo" })).plan_id)).status).toBe("aplicado_verificado");
        expect(acts.get(9814)!.content).toContain("Nuevo");
    });

    it("rechazos: content fuera de páginas, max_grade fuera de tareas o con notas, sin cambios; no aplica → sin_efecto", async () => {
        const { h, grades, state } = await harness();
        expect((await errOf(plan(h, { course_module_id: 9812, content: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { course_module_id: 9813, max_grade: 10 }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { course_module_id: 9811 }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { course_module_id: 9811, max_grade: 100 }))).message).toMatch(/ya es la nota/);
        grades.push(7);
        expect((await errOf(plan(h, { course_module_id: 9811, max_grade: 20 }))).message).toMatch(/ya tiene 1 nota/);
        expect((await errOf(plan(h, { course_module_id: 4242, description: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        state.noop = true;
        expect((await exec(h, (await plan(h, { course_module_id: 9813, description: "Otra" })).plan_id)).status).toBe("sin_efecto");
    });
});

describe("enlaces y etiquetas (ADR-076)", () => {
    it("dirección y descripción de un enlace; texto de una etiqueta; deshacer; rechazos", async () => {
        const { h, acts } = await harness();
        const r = await exec(h, (await plan(h, { course_module_id: 9815, external_url: "https://b.example/x", description: "Ver **esto**" })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(acts.get(9815)!.content).toBe("https://b.example/x");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(acts.get(9815)!.content).toBe("https://a.example/");
        expect((await exec(h, (await plan(h, { course_module_id: 9816, description: "Texto **nuevo**" })).plan_id)).status).toBe("aplicado_verificado");
        expect((await errOf(plan(h, { course_module_id: 9816, description: "" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { course_module_id: 9811, external_url: "https://c.example/" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { course_module_id: 9815, external_url: "ftp://c.example/" }))).code).toBe("WRITE_NOT_ALLOWED");
    });
});
