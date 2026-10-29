import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { DISPLAY_NAMES, KIND_SETTINGS, RESOURCE_DISPLAY, URL_DISPLAY } from "../../src/write/settings-catalog.js";
import { SyntheticContent } from "../fixtures/fake-content.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * ADR-131: presentación de un archivo (resource) como `display` = automatic | embed | new_window | force_download |
 * open | popup, en el ajuste de un archivo existente y en el alta. La opción tiene que figurar en el formulario del
 * sitio antes de enviar; deshacer restaura el valor crudo anterior (incluido el marco, 2, si Moodle lo ofrece).
 */

const SIX = ["0", "1", "3", "4", "5", "6"];
/** Formulario de edición de un archivo: además de display, campos ajenos que tienen que volver tal cual. */
const resourceForm = (display: string, offered: string[], update = "9905", extra = "", showsize = true) =>
    `<html><body><form action="${SITE}/course/modedit.php" method="post">${extra}<input type="hidden" name="update" value="${update}"><input type="hidden" name="_qf__mod_resource_mod_form" value="1"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="text" name="name" value="Apunte de clase"><textarea name="introeditor[text]">&lt;p&gt;Guía&lt;/p&gt;</textarea><input type="hidden" name="introeditor[format]" value="1"><input type="hidden" name="files" value="4242"><select name="display">${offered.map((o) => `<option value="${o}"${o === display ? " selected" : ""}>${o}</option>`).join("")}</select><input type="text" name="popupwidth" value="620"><input type="text" name="popupheight" value="450"><input type="checkbox" name="printintro" value="1" checked><input type="checkbox" name="showsize" value="1"${showsize ? " checked" : ""}><select name="visible"><option value="1" selected>1</option><option value="0">0</option></select><input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton2" value="Guardar"></form></body></html>`;

/** Moodle ofrece las presentaciones habilitadas más la actual (resourcelib_get_displayoptions). */
async function settingsHarness(enabled: string[], initial = "0") {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["edit_activity"] } } });
    h.w2.extraModules.push({ id: 9905, modname: "resource", name: "Apunte de clase", section: 1, visible: true });
    const state = { display: initial, showsize: true };
    const posts: Record<string, string>[] = [];
    const prev = h.fake.web.pages.get("/course/modedit.php")!;
    h.fake.web.pages.set("/course/modedit.php", (q, req) => {
        const b = new URLSearchParams(req.body ?? "");
        if (Number(q.update ?? b.get("update") ?? 0) !== 9905) return prev(q, req);
        const offered = [...new Set([...enabled, state.display])].sort();
        if (req.method === "GET") return { body: resourceForm(state.display, offered, String(q.update ?? "9905"), "", state.showsize) };
        posts.push(Object.fromEntries(b));
        // Como el select de Moodle: un valor que no ofrece se descarta.
        if (b.has("display") && offered.includes(b.get("display")!)) state.display = b.get("display")!;
        state.showsize = b.get("showsize") === "1";
        return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
    });
    return { h, state, posts };
}

const plan = (h: WriteHarness, settings: Record<string, unknown>) => h.app.engine.plan("activity_settings", { course_id: COURSE, course_module_id: 9905, settings }, "test");
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

describe("catálogo de presentaciones", () => {
    it("las seis de un archivo van a RESOURCELIB_DISPLAY_*; el enlace conserva sus tres", () => {
        expect(RESOURCE_DISPLAY).toEqual({ automatic: "0", embed: "1", new_window: "3", force_download: "4", open: "5", popup: "6" });
        expect(URL_DISPLAY).toEqual({ automatic: "0", embed: "1", open: "5" });
        expect(KIND_SETTINGS.resource!.display).toMatchObject({ field: "display", control: "select", values: RESOURCE_DISPLAY, restore: ["2"], offered_only: true });
        expect(KIND_SETTINGS.url!.display).toMatchObject({ values: URL_DISPLAY, restore: ["2", "3", "4", "6"], offered_only: true });
        expect(DISPLAY_NAMES["2"]).toBe("frame");
    });
});

describe("presentación de un archivo existente (ajustes)", () => {
    it("cada una de las seis se aplica y se verifica por relectura; el resto del formulario vuelve tal cual", async () => {
        for (const [name, raw] of Object.entries(RESOURCE_DISPLAY)) {
            const initial = raw === "4" ? "5" : "4";
            const { h, state, posts } = await settingsHarness(SIX, initial);
            const p = await plan(h, { display: name });
            expect(p.payload_preview).toMatchObject({ changes: [{ setting: "display", field: "display", before: initial, after: raw, before_name: DISPLAY_NAMES[initial], after_name: name }] });
            const r = await exec(h, p.plan_id);
            expect(r.status, name).toBe("aplicado_verificado");
            expect(state.display).toBe(raw);
            expect(posts[0]).toMatchObject({ display: raw, name: "Apunte de clase", "introeditor[text]": "<p>Guía</p>", files: "4242", popupwidth: "620", popupheight: "450", printintro: "1", showsize: "1", visible: "1" });
            expect(posts[0]).not.toHaveProperty("coursecontentnotification");
        }
    });

    it("force_download → open y deshacer vuelve a force_download", async () => {
        const { h, state } = await settingsHarness(SIX, "4");
        const r = await exec(h, (await plan(h, { display: "open" })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(state.display).toBe("5");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect(u.plan.payload_preview).toMatchObject({ changes: [{ before: "5", after: "4", before_name: "open", after_name: "force_download" }] });
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(state.display).toBe("4");
    });

    it("deshacer restaura el marco (2) si el formulario lo ofrece; si no, se rechaza sin enviar", async () => {
        const withFrame = await settingsHarness([...SIX, "2"], "2");
        const r = await exec(withFrame.h, (await plan(withFrame.h, { display: "open" })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const u = await withFrame.h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(withFrame.h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(withFrame.state.display).toBe("2");

        // Sitio sin marco: Moodle sólo lo ofrece mientras es el valor actual; después de cambiarlo, ya no.
        const noFrame = await settingsHarness(SIX, "2");
        const r2 = await exec(noFrame.h, (await plan(noFrame.h, { display: "open" })).plan_id);
        expect(r2.status).toBe("aplicado_verificado");
        const e = await errOf(noFrame.h.app.engine.planUndo(r2.action_id, "test"));
        expect(e.code).toBe("WRITE_NOT_ALLOWED");
        expect(e.message).toContain("no se puede restaurar");
        expect(noFrame.posts).toHaveLength(1);
        expect(noFrame.state.display).toBe("5");
    });

    it("rechazos sin enviar: valor desconocido, opción que el sitio no ofrece, y el valor actual", async () => {
        const { h, posts } = await settingsHarness(["0", "1", "4", "5"], "5");
        for (const v of ["frame", "new", "download", "bogus", 2]) expect((await errOf(plan(h, { display: v }))).code).toBe("WRITE_NOT_ALLOWED");
        const notOffered = await errOf(plan(h, { display: "popup" }));
        expect(notOffered.message).toContain("Opciones ofrecidas: 0, 1, 4, 5");
        expect((await errOf(plan(h, { display: "open" }))).message).toContain("ya son los actuales");
        expect(posts).toHaveLength(0);
    });

    it("display junto con otro ajuste del archivo: sólo cambia lo pedido", async () => {
        const { h, posts, state } = await settingsHarness(SIX, "0");
        const r = await exec(h, (await plan(h, { display: "open", show_size: false })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(posts[0]).toMatchObject({ display: "5", printintro: "1", popupwidth: "620" });
        expect(posts[0]).not.toHaveProperty("showsize");
        expect(state).toEqual({ display: "5", showsize: false });
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
        if (req.method === "GET" && q.add === "resource") return { body: resourceForm("0", offered, "", `<input type="hidden" name="course" value="${q.course}"><input type="hidden" name="section" value="${q.section}"><input type="hidden" name="add" value="resource">`).replace('name="files" value="4242"', 'name="files" value="111"') };
        if (req.method === "GET" && q.update && shown.has(Number(q.update))) return { body: resourceForm(shown.get(Number(q.update))!, offered, String(q.update)) };
        const r = synthetic(q, req);
        if (req.method === "POST" && b.get("add") === "resource") {
            posts.push(Object.fromEntries(b));
            const cmid = /id=(\d+)/.exec((r as { headers?: { location?: string } }).headers?.location ?? "")?.[1];
            if (cmid) shown.set(Number(cmid), b.get("display") ?? "0");
        }
        return r;
    });
    const path = join(mkdtempSync(join(tmpdir(), "campus-disp-")), "poo.pdf");
    writeFileSync(path, "%PDF-1.4\n%prueba\n");
    return { h, c, posts, shown, path };
}
const planCreate = (h: WriteHarness, path: string, input: Record<string, unknown>) => h.app.engine.plan("create_content", { course_id: COURSE, section: 1, type: "resource", name: "PDF de prueba", file_path: path, ...input }, "test");

describe("presentación al crear un archivo", () => {
    it("open se envía, figura en el plan y se verifica releyendo el formulario, además del archivo", async () => {
        const { h, c, posts, shown, path } = await createHarness(SIX);
        const p = await planCreate(h, path, { display: "open" });
        expect(p.payload_preview).toMatchObject({ display: "open", visible: false });
        const r = await h.app.engine.execute(p.plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(r.verification.checked).toEqual(expect.arrayContaining(["file", "display"]));
        expect(posts[0]).toMatchObject({ display: "5", visible: "0" });
        expect([...shown.values()]).toEqual(["5"]);
        expect([...c.resources.values()][0]).toEqual([{ filename: "poo.pdf", filesize: 17 }]);
    });

    it("sin display queda el valor por defecto del formulario y no se verifica", async () => {
        const { h, posts, path } = await createHarness(SIX);
        const r = await h.app.engine.execute((await planCreate(h, path, {})).plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(r.verification.checked).not.toContain("display");
        expect(posts[0]).toMatchObject({ display: "0" });
    });

    it("presentación no ofrecida: se rechaza sin crear; un enlace no admite las propias de un archivo", async () => {
        const { h, posts, path } = await createHarness(["0", "5"]);
        const e = await errOf(planCreate(h, path, { display: "popup" }));
        expect(e.code).toBe("WRITE_NOT_ALLOWED");
        expect(e.message).toContain("Opciones ofrecidas: 0, 5");
        expect(posts).toHaveLength(0);
        for (const v of ["force_download", "new_window", "popup"]) {
            const u = await errOf(h.app.engine.plan("create_content", { course_id: COURSE, section: 1, type: "url", name: "E", external_url: "https://www.udesa.edu.ar/", display: v }, "test"));
            expect(u.message).toContain("display admite: automatic, embed, open");
        }
        expect((await errOf(h.app.engine.plan("create_content", { course_id: COURSE, section: 1, type: "page", name: "P", content: "x", display: "open" }, "test"))).message).toContain("no corresponde: display");
    });
});
