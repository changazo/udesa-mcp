import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";
import { HORARIOS, PATCH } from "../fixtures/html-horarios.js";

/**
 * ADR-136: campus_plan_patch_section_summary contra el Moodle sintético (formulario de la sección y
 * core_course_get_contents), y el blindaje del reemplazo total (campus_plan_section_summary).
 */

const SECTION_ID = 101;
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
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Sección 1 con un resumen guardado. El formulario lo sirve escapado en el textarea (como Moodle) con un borrador
 * propio por apertura; `store` decide qué guarda Moodle de lo que llega (por defecto, tal cual).
 */
async function harness(initial = HORARIOS, store: (sent: string) => string = (x) => x) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["rename_content"] } } });
    const state = { summary: initial, opens: 0 };
    const posts: Record<string, string>[] = [];
    const prev = h.fake.overrides.get("core_course_get_contents")!;
    h.fake.overrides.set("core_course_get_contents", (p) => (prev(p) as { id: number }[]).map((s) => ({ ...s, summary: s.id === SECTION_ID ? state.summary : "" })));
    h.fake.web.pages.set("/course/editsection.php", (q, req) => {
        if (req.method === "GET") {
            const draft = 7000 + ++state.opens;
            const shown = state.summary.replace(/@@PLUGINFILE@@\//g, `${SITE}/draftfile.php/5/user/draft/${draft}/`);
            return { body: `<html><body><form action="${SITE}/course/editsection.php" method="post"><input type="hidden" name="id" value="${q.id}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__editsection_form" value="1"><input type="text" name="name" value="Tema 1"><textarea name="summary_editor[text]">${escapeHtml(shown)}</textarea><input type="hidden" name="summary_editor[format]" value="1"><input type="hidden" name="summary_editor[itemid]" value="${draft}"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>` };
        }
        const b = new URLSearchParams(req.body ?? "");
        posts.push(Object.fromEntries(b));
        state.summary = store(b.get("summary_editor[text]") ?? "");
        return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=${COURSE}` } };
    });
    return { h, state, posts };
}
const patch = (h: WriteHarness, extra: Record<string, unknown> = {}) => plan(h, "patch_section_summary", { section_number: 1, table_match: { headers_contain: PATCH.headers_contain }, row_match: PATCH.row_match, column: PATCH.column, expected_text: PATCH.expected_text, replacement_text: PATCH.replacement_text, ...extra });
const EXPECTED = (() => {
    const at = HORARIOS.lastIndexOf("Martes (extraordinario)");
    return HORARIOS.slice(0, at) + "Miércoles" + HORARIOS.slice(at + "Martes (extraordinario)".length);
})();

describe("campus_plan_patch_section_summary (ADR-136)", () => {
    it("el plan muestra UNA modificación de texto; el POST lleva HTML renderizable con formato 1 y el resto del formulario tal cual; verificado; deshacer restaura el HTML exacto", async () => {
        const { h, state, posts } = await harness();
        const p = await patch(h);
        expect(p.payload_preview).toMatchObject({ column: "Día", before: "Martes (extraordinario)", after: "Miércoles", row: { cells: ["Consultas", "Juan Cruz Changazo", "Martes (extraordinario)", "19:00 a 20:30", "Meet"] }, diff: { before_fragment: "Martes (extraordinario)", after_fragment: "Miércoles" } });
        expect(p.risk).toBe("R2");
        const r = await exec(h, p.plan_id);
        expect(r.status, JSON.stringify(r.differences)).toBe("aplicado_verificado");
        expect(r.verification.checked).toContain("html_estructura");
        expect(posts[0]).toMatchObject({ "summary_editor[format]": "1", name: "Tema 1", id: String(SECTION_ID) });
        // El texto enviado conserva @@PLUGINFILE@@ (la imagen sigue siendo la del área de la sección) y no está escapado.
        expect(posts[0]!["summary_editor[text]"]).toBe(EXPECTED);
        expect(posts[0]).not.toHaveProperty("coursecontentnotification");
        expect(state.summary).toBe(EXPECTED);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(state.summary).toBe(HORARIOS);
    });

    it("Moodle guarda el mismo texto pero sin la tabla: nunca aplicado_verificado, y dice qué se perdió", async () => {
        const flatten = (sent: string) => `<p>${sent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}</p>`;
        const { h } = await harness(HORARIOS, flatten);
        const r = await exec(h, (await patch(h)).plan_id);
        expect(r.status).toBe("aplicado_con_diferencias");
        expect(r.differences.map((d) => d.field)).toEqual(expect.arrayContaining(["tables", "rows", "cells", "images", "links", "styles"]));
    });

    it("Moodle pierde sólo un atributo (style): tampoco es verificado", async () => {
        const { h } = await harness(HORARIOS, (sent) => sent.replace(' style="width: 100%;"', ""));
        const r = await exec(h, (await patch(h)).plan_id);
        expect(r.status).toBe("aplicado_con_diferencias");
        expect(r.differences.map((d) => d.field)).toContain("styles");
    });

    it("precondición obsoleta (cambió sólo un style o un href desde el plan): PLAN_STALE y ningún POST", async () => {
        for (const change of [(s: string) => s.replace("color: #000000;", "color: #ff0000;"), (s: string) => s.replace("tzg-yemr-aqq", "otra-sala")]) {
            const { h, state, posts } = await harness();
            const p = await patch(h);
            state.summary = change(state.summary);
            expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
            expect(posts).toHaveLength(0);
        }
    });

    it("ambigüedad o texto distinto: rechazo en el plan, sin POST", async () => {
        const { h, posts } = await harness();
        expect((await errOf(patch(h, { expected_text: "Jueves" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(patch(h, { row_match: { Día: "Martes (extraordinario)" } }))).code).toBe("WRITE_NOT_ALLOWED");
        expect(posts).toHaveLength(0);
    });
});

describe("campus_plan_section_summary blindado (ADR-136)", () => {
    it("un reemplazo en Markdown que perdería la tabla, la imagen y los enlaces se rechaza y sugiere el patch", async () => {
        const { h, posts } = await harness();
        const e = await errOf(plan(h, "section_summary", { section_number: 1, summary: "**Horarios**: consultas los miércoles." }));
        expect(e.code).toBe("WRITE_NOT_ALLOWED");
        expect(e.message).toContain("campus_plan_patch_section_summary");
        expect(e.details?.lost).toEqual(expect.arrayContaining(["1 tabla(s)", "1 imagen(es)"]));
        expect(posts).toHaveLength(0);
    });

    it("con allow_structure_loss explícito el plan es R3 y advierte la pérdida", async () => {
        const { h } = await harness();
        const p = await plan(h, "section_summary", { section_number: 1, summary: "Texto nuevo", allow_structure_loss: true });
        expect(p.risk).toBe("R3");
        expect(p.summary).toContain("PERDIENDO");
        expect(p.warnings.join(" ")).toContain("allow_structure_loss");
    });

    it("una tabla en Markdown llega como <table>; si Moodle la guardara como texto, no es aplicado_verificado", async () => {
        const md = "| Clase | Día |\n|---|---|\n| Consultas | Miércoles |";
        const ok = await harness("<p>Viejo</p>");
        expect((await exec(ok.h, (await plan(ok.h, "section_summary", { section_number: 1, summary: md })).plan_id)).status).toBe("aplicado_verificado");
        expect(ok.posts[0]!["summary_editor[text]"]).toContain("<table>");
        const flat = await harness("<p>Viejo</p>", (sent) => `<p>${sent.replace(/<[^>]+>/g, " ")}</p>`);
        const r = await exec(flat.h, (await plan(flat.h, "section_summary", { section_number: 1, summary: md })).plan_id);
        expect(r.status).not.toBe("aplicado_verificado");
        expect(r.differences.map((d) => d.field)).toContain("structure");
    });
});
