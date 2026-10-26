import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticContent } from "../fixtures/fake-content.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content"] } } });
    return { h, c: new SyntheticContent(h.fake, h.w2) };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("create_content", { course_id: COURSE, section: 1, ...input }, "test");
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

async function roundTrip(h: WriteHarness, input: Record<string, unknown>) {
    const p = await plan(h, input);
    const r = await exec(h, p.plan_id);
    expect(r.status, JSON.stringify(r.differences)).toBe("aplicado_verificado");
    const u = await h.app.engine.planUndo(r.action_id, "test");
    if (!u.undoable) throw new Error(u.reason);
    expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
    return { p, r };
}

describe("crear contenido (§8.9, ADR-064)", () => {
    it("página oculta con contenido Markdown → HTML, sin notificar; verificada; deshacer la borra", async () => {
        const { h, c } = await harness();
        const { p, r } = await roundTrip(h, { type: "page", name: "Guía", content: "# Hola\n\nTexto **fuerte**." });
        expect(p.risk).toBe("R1");
        expect(r.verification.checked).toContain("content");
        expect(c.posts[0]).toMatchObject({ name: "Guía", visible: "0", "page[format]": "1" });
        expect(c.posts[0]!["page[text]"]).toContain("<strong>fuerte</strong>");
        expect(c.posts[0]).not.toHaveProperty("coursecontentnotification");
    });

    it("enlace http(s) verificado; etiqueta (submitbutton2, sin cmid en la redirección) con nombre derivado del texto", async () => {
        const { h, c } = await harness();
        await roundTrip(h, { type: "url", name: "UdeSA", external_url: "https://www.udesa.edu.ar/" });
        const { r } = await roundTrip(h, { type: "label", text: "Atención: **leer** antes de la clase" });
        expect(r.verification.checked).toContain("text");
        expect(c.posts[1]).toMatchObject({ name: "Atención: leer antes de la clase", submitbutton2: "1" });
    });

    it("archivo: el plan no sube nada; al ejecutar sube al borrador y lo pone en files; verificado por nombre y tamaño", async () => {
        const { h, c } = await harness();
        const path = join(mkdtempSync(join(tmpdir(), "campus-res-")), "apunte.txt");
        writeFileSync(path, "contenido del apunte");
        const p = await plan(h, { type: "resource", name: "Apunte", file_path: path });
        expect(c.drafts.size).toBe(0);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(c.posts[0]!.files).toBe("888001");
        expect([...c.resources.values()][0]).toEqual([{ filename: "apunte.txt", filesize: 20 }]);
    });

    it("URL guardada distinta → aplicado_con_diferencias", async () => {
        const { h, c } = await harness();
        c.mangleUrl = true;
        expect((await exec(h, (await plan(h, { type: "url", name: "X", external_url: "https://a.example/" })).plan_id)).status).toBe("aplicado_con_diferencias");
    });

    it("rechazos: falta el dato del tipo, dato de otro tipo, sección inexistente, URL no http, etiqueta con intro, sin nombre", async () => {
        const { h } = await harness();
        const code = async (input: Record<string, unknown>) => (await errOf(plan(h, input))).code;
        expect(await code({ type: "page", name: "x" })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ type: "page", name: "x", content: "a", external_url: "https://a.example/" })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ type: "page", name: "x", content: "a", section: 99 })).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await code({ type: "url", name: "x", external_url: "javascript:alert(1)" })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ type: "url", name: "x", external_url: "https://u:p@a.example/" })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ type: "label", text: "a", intro: "b" })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({ type: "url", external_url: "https://a.example/" })).toBe("WRITE_NOT_ALLOWED");
    });
});

describe("crear un foro (ADR-070)", () => {
    it("suscripción deshabilitada por defecto (la automática del formulario se pisa), calificación sin notificar; verificado", async () => {
        const { h, c } = await harness();
        const p = await plan(h, { type: "forum", name: "Debate", whole_forum_grade: 10 });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(r.verification.checked).toEqual(expect.arrayContaining(["forcesubscribe", "grade_forum"]));
        expect(c.posts[0]).toMatchObject({ forcesubscribe: "3", "grade_forum[modgrade_type]": "point", "grade_forum[modgrade_point]": "10", grade_forum_notify: "0", type: "general" });
        expect((await errOf(plan(h, { type: "page", name: "x", content: "y", subscription: "optional" }))).code).toBe("WRITE_NOT_ALLOWED");
    });
});
