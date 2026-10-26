import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { W2_GROUP } from "../fixtures/fake-w2.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-082: ajustes por catálogo, modo de grupos y restricciones, sobre un cuestionario y un libro sintéticos. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_activity"] } } });
    const state: Record<number, Record<string, string>> = {
        9901: { grademethod: "1", navmethod: "free", marksclosed: "0", groupmode: "0", availabilityconditionsjson: "" },
        9902: { numbering: "1", customtitles: "0", availabilityconditionsjson: "" },
    };
    const kinds: Record<number, string> = { 9901: "quiz", 9902: "book" };
    h.w2.extraModules.push({ id: 9901, modname: "quiz", name: "Parcial", section: 1, visible: true }, { id: 9902, modname: "book", name: "Libro", section: 1, visible: true }, { id: 9903, modname: "turnitintooltwo", name: "TII", section: 1, visible: true });
    const posts: Record<string, string>[] = [];
    const flags = { noop: false };
    const prev = h.fake.web.pages.get("/course/modedit.php")!;
    h.fake.web.pages.set("/course/modedit.php", (q, req) => {
        const b = new URLSearchParams(req.body ?? "");
        const cm = Number(q.update ?? b.get("update") ?? 0);
        const st = state[cm];
        if (!st) return prev(q, req);
        const qf = `_qf__mod_${kinds[cm]}_mod_form`;
        if (req.method === "GET") {
            const sel = (name: string, opts: string[]) => `<select name="${name}">${opts.map((o) => `<option value="${o}"${st[name] === o ? " selected" : ""}>${o}</option>`).join("")}</select>`;
            const box = (name: string) => `<input type="checkbox" name="${name}" value="1"${st[name] === "1" ? " checked" : ""}>`;
            const body =
                kinds[cm] === "quiz"
                    ? sel("grademethod", ["1", "2", "3", "4"]) + sel("navmethod", ["free", "sequential"]) + box("marksclosed") + sel("groupmode", ["0", "1", "2"])
                    : sel("numbering", ["0", "1", "2", "3"]) + box("customtitles");
            return { body: `<html><body><form action="${SITE}/course/modedit.php" method="post"><input type="hidden" name="update" value="${cm}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="${qf}" value="1"><input type="text" name="name" value="x">${body}<textarea name="availabilityconditionsjson">${st.availabilityconditionsjson!.replace(/"/g, "&quot;")}</textarea><input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton2" value="Guardar"></form></body></html>` };
        }
        posts.push(Object.fromEntries(b));
        if (!flags.noop) {
            for (const k of Object.keys(st)) {
                if (["marksclosed", "customtitles"].includes(k)) st[k] = b.get(k) === null ? "0" : "1";
                else if (b.has(k)) st[k] = b.get(k)!;
            }
        }
        return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
    });
    return { h, state, posts, flags };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("activity_settings", { course_id: COURSE, ...input }, "test");
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

describe("ajustes de una actividad por catálogo (ADR-082)", () => {
    it("select, casilla simple (en 0 se omite) y modo de grupos; sólo lo que cambia; sin notificar; deshacer", async () => {
        const { h, state, posts } = await harness();
        const r = await exec(h, (await plan(h, { course_module_id: 9901, settings: { grade_method: "average", navigation: "sequential", review_marks_closed: true, group_mode: "separate" } })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(state[9901]).toMatchObject({ grademethod: "2", navmethod: "sequential", marksclosed: "1", groupmode: "1" });
        expect(posts.at(-1)).not.toHaveProperty("coursecontentnotification");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(state[9901]).toMatchObject({ grademethod: "1", navmethod: "free", marksclosed: "0", groupmode: "0" });
        expect(posts.at(-1)).not.toHaveProperty("marksclosed");
    });

    it("restricciones: fechas y grupos arman el JSON de condiciones; null las quita; deshacer vuelve al JSON anterior", async () => {
        const { h, state } = await harness();
        const r = await exec(h, (await plan(h, { course_module_id: 9902, restrictions: { from: "2026-11-01T08:00", until: "2026-12-01T00:00", group_ids: [W2_GROUP], show_when_unmet: false } })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const j = JSON.parse(state[9902]!.availabilityconditionsjson!);
        expect(j).toEqual({ op: "&", c: [{ type: "date", d: ">=", t: Date.UTC(2026, 10, 1, 11, 0) / 1000 }, { type: "date", d: "<", t: Date.UTC(2026, 11, 1, 3, 0) / 1000 }, { type: "group", id: W2_GROUP }], showc: [false, false, false] });
        const cleared = await exec(h, (await plan(h, { course_module_id: 9902, restrictions: null })).plan_id);
        expect(cleared.status).toBe("aplicado_verificado");
        expect(state[9902]!.availabilityconditionsjson).toBe("");
        const u = await h.app.engine.planUndo(cleared.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(JSON.parse(state[9902]!.availabilityconditionsjson!).c).toHaveLength(3);
    });

    it("rechazos: clave fuera del catálogo, valor no admitido, ajuste que el formulario no trae, Turnitin, sin cambios, grupo ajeno; Moodle no aplica → sin_efecto", async () => {
        const { h, flags } = await harness();
        expect((await errOf(plan(h, { course_module_id: 9901, settings: { quizpassword: "x" } }))).message).toMatch(/no es un ajuste editable/);
        expect((await errOf(plan(h, { course_module_id: 9901, settings: { grade_method: "best" } }))).message).toMatch(/valores admitidos/);
        expect((await errOf(plan(h, { course_module_id: 9902, settings: { group_mode: "visible" } }))).message).toMatch(/no está disponible/);
        expect((await errOf(plan(h, { course_module_id: 9903, settings: { group_mode: "visible" } }))).message).toMatch(/Turnitin/);
        expect((await errOf(plan(h, { course_module_id: 9901, settings: { grade_method: "highest" } }))).message).toMatch(/ya son los actuales/);
        expect((await errOf(plan(h, { course_module_id: 9902, restrictions: { group_ids: [999] } }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, { course_module_id: 9902, restrictions: { from: "2026-12-01T00:00", until: "2026-11-01T00:00" } }))).message).toMatch(/posterior/);
        flags.noop = true;
        expect((await exec(h, (await plan(h, { course_module_id: 9902, settings: { numbering: "bullets", custom_titles: true } })).plan_id)).status).toBe("sin_efecto");
    });
});

describe("duplicar una actividad (ADR-082)", () => {
    it("copia en la misma sección con la misma visibilidad; deshacer la borra; Turnitin rechazado", async () => {
        const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content"] } } });
        h.w2.extraModules.push({ id: 9911, modname: "book", name: "Libro", section: 2, visible: false }, { id: 9912, modname: "turnitintooltwo", name: "TII", section: 2, visible: true });
        const prev = h.fake.web.ajax.get("core_courseformat_update_course")!;
        h.fake.web.ajax.set("core_courseformat_update_course", (a) => {
            if (a.action !== "cm_duplicate") return prev(a);
            const src = h.w2.extraModules.find((m) => m.id === (a.ids as number[])[0])!;
            h.w2.extraModules.push({ ...src, id: 9990, name: `${src.name} (copia)` });
            return "[]";
        });
        const p = await h.app.engine.plan("duplicate_activity", { course_id: COURSE, course_module_id: 9911 }, "test");
        expect(p.risk).toBe("R1");
        const r = await h.app.engine.execute(p.plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(r.moodle_ids.cmid).toEqual([9990]);
        expect(h.w2.extraModules.find((m) => m.id === 9990)).toMatchObject({ section: 2, visible: false });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await h.app.engine.execute(u.plan.plan_id, h.confirmer, "test")).status).toBe("aplicado_verificado");
        expect(h.w2.extraModules.some((m) => m.id === 9990)).toBe(false);
        expect((await errOf(h.app.engine.plan("duplicate_activity", { course_id: COURSE, course_module_id: 9912 }, "test"))).message).toMatch(/servicio externo/);
    });
});
