import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { SyntheticContent } from "../fixtures/fake-content.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * Presentación de un enlace (URL) como `display` = automatic | embed | open, en el ajuste de
 * una URL existente y en el alta. Antes de enviar, la opción tiene que figurar en el formulario del sitio.
 */

const urlForm = (display: string, offered: string[], update = "9904", extra = "", qf = "_qf__mod_url_mod_form") =>
    `<html><body><form action="${SITE}/course/modedit.php" method="post">${extra}<input type="hidden" name="update" value="${update}"><input type="hidden" name="${qf}" value="1"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="text" name="name" value="Enlace de prueba"><input type="text" name="externalurl" value="https://www.udesa.edu.ar/"><select name="display">${offered.map((o) => `<option value="${o}"${o === display ? " selected" : ""}>${o}</option>`).join("")}</select><input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton2" value="Guardar"></form></body></html>`;

async function settingsHarness(offered: string[], initial = "0") {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_activity"] } } });
    h.w2.extraModules.push({ id: 9904, modname: "url", name: "Enlace de prueba", section: 1, visible: true });
    const state = { display: initial };
    const posts: Record<string, string>[] = [];
    const prev = h.fake.web.pages.get("/course/modedit.php")!;
    h.fake.web.pages.set("/course/modedit.php", (q, req) => {
        const b = new URLSearchParams(req.body ?? "");
        if (Number(q.update ?? b.get("update") ?? 0) !== 9904) return prev(q, req);
        if (req.method === "GET") return { body: urlForm(state.display, offered, String(q.update ?? "9904")) };
        posts.push(Object.fromEntries(b));
        if (b.has("display")) state.display = b.get("display")!;
        return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
    });
    return { h, state, posts };
}

const plan = (h: WriteHarness, settings: Record<string, unknown>) => h.app.engine.plan("activity_settings", { course_id: COURSE, course_module_id: 9904, settings }, "test");
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

describe("presentación de una URL existente (ajustes)", () => {
    it("embed se aplica si el sitio lo ofrece: verificado por relectura del formulario; deshacer vuelve al valor anterior", async () => {
        const { h, state, posts } = await settingsHarness(["0", "1", "5"]);
        const p = await plan(h, { display: "embed" });
        expect(p.payload_preview).toMatchObject({ changes: [{ setting: "display", field: "display", before: "0", after: "1" }] });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(posts[0]).toMatchObject({ display: "1" });
        expect(state.display).toBe("1");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(state.display).toBe("0");
    });

    it("deshacer devuelve un valor previo fuera del catálogo (6, ventana emergente)", async () => {
        const { h, state } = await settingsHarness(["0", "1", "5", "6"], "6");
        const r = await exec(h, (await plan(h, { display: "embed" })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(state.display).toBe("1");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(state.display).toBe("6");
    });

    it("si el sitio no ofrece embed, se rechaza antes de planear: ningún envío al formulario", async () => {
        const { h, state, posts } = await settingsHarness(["0", "5"]);
        const e = await errOf(plan(h, { display: "embed" }));
        expect(e.code).toBe("WRITE_NOT_ALLOWED");
        expect(e.message).toContain("Opciones ofrecidas: 0, 5");
        expect(posts).toHaveLength(0);
        expect(state.display).toBe("0");
    });

    it("frame, new o popup no están en el catálogo: se rechazan sin leer nada", async () => {
        const { h, posts } = await settingsHarness(["0", "1", "5"]);
        for (const v of ["frame", "new", "popup"]) expect((await errOf(plan(h, { display: v }))).code).toBe("WRITE_NOT_ALLOWED");
        expect(posts).toHaveLength(0);
    });
});

async function createHarness(offered: string[]) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content"] } } });
    const c = new SyntheticContent(h.fake, h.w2);
    const synthetic = h.fake.web.pages.get("/course/modedit.php")!;
    const shown = new Map<number, string>();
    const posts: Record<string, string>[] = [];
    h.fake.web.pages.set("/course/modedit.php", (q, req) => {
        const b = new URLSearchParams(req.body ?? "");
        if (req.method === "GET" && q.add === "url") return { body: urlForm("0", offered, "", `<input type="hidden" name="course" value="${q.course}"><input type="hidden" name="section" value="${q.section}"><input type="hidden" name="add" value="url">`) };
        if (req.method === "GET" && q.update && shown.has(Number(q.update))) return { body: urlForm(shown.get(Number(q.update))!, offered, String(q.update)) };
        const r = synthetic(q, req);
        if (req.method === "POST" && b.has("externalurl")) {
            posts.push(Object.fromEntries(b));
            const cmid = /id=(\d+)/.exec((r as { headers?: { location?: string } }).headers?.location ?? "")?.[1];
            if (cmid) shown.set(Number(cmid), b.get("display") ?? "0");
        }
        return r;
    });
    return { h, c, posts, shown };
}
const planCreate = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("create_content", { course_id: COURSE, section: 1, type: "url", name: "Enlace", external_url: "https://www.udesa.edu.ar/", ...input }, "test");

describe("presentación al crear un enlace", () => {
    it("embed se envía y se verifica releyendo el formulario de la actividad creada", async () => {
        const { h, posts, shown } = await createHarness(["0", "1", "5"]);
        const r = await h.app.engine.execute((await planCreate(h, { display: "embed" })).plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(r.verification.checked).toContain("display");
        expect(posts[0]).toMatchObject({ display: "1", visible: "0" });
        expect([...shown.values()]).toEqual(["1"]);
    });

    it("si el sitio no ofrece la presentación pedida, se rechaza sin crear el enlace", async () => {
        const { h, posts } = await createHarness(["0", "5"]);
        const e = await errOf(planCreate(h, { display: "embed" }));
        expect(e.code).toBe("WRITE_NOT_ALLOWED");
        expect(posts).toHaveLength(0);
    });

    it("sin display el alta sigue igual que antes: el valor que envía es el del formulario de Moodle y no se verifica", async () => {
        const { h, posts } = await createHarness(["0", "1", "5"]);
        const r = await h.app.engine.execute((await planCreate(h, {})).plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(r.verification.checked).not.toContain("display");
        expect(posts[0]).toMatchObject({ display: "0" });
    });
});
