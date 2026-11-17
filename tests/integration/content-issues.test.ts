import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import type { LinkCheckDeps } from "../../src/domain/content-issues.js";
import { makeHarness, type Harness } from "../fixtures/harness.js";
import { COURSE, OTHER_COURSE, SITE, VALID_TOKEN } from "../fixtures/fake-moodle.js";

/** campus_get_content_issues (ADR-139): revisión de accesibilidad y formato sobre un curso sintético. */

const SECTIONS = [
    {
        id: 10,
        name: "General",
        section: 0,
        summary: '<p>Bienvenidos</p><p></p><p>&nbsp;</p><p></p><p><img src="https://campus.example.test/webservice/pluginfile.php/1/course/section/10/portada.png"></p>',
        modules: [
            { id: 801, modname: "label", name: "Horarios", description: "<table><tr><td>Día</td><td>Hora</td></tr><tr><td>Lunes</td><td>10:00</td></tr></table>" },
            { id: 802, modname: "forum", name: "Avisos", instance: 1, description: "" },
        ],
    },
    {
        id: 11,
        name: "Unidad 1",
        section: 1,
        summary: '<h2>Unidad 1</h2><h5>Lecturas</h5><p><a href="https://biblio.example.org/apunte">click aquí</a> y <a href="https://roto.example.org/viejo" target="_blank">Programa</a></p>',
        modules: [
            { id: 803, modname: "page", name: "Reglas", instance: 1201, description: '<p><span style="color:#bbbbbb">Leer antes de empezar</span></p>' },
            { id: 804, modname: "assign", name: "TP1", instance: 5, description: '<p>Consigna en <a href="https://campus.example.test/mod/resource/view.php?id=9">el Campus</a></p>' },
            { id: 805, modname: "subsection", name: "Extra", instance: 31 },
        ],
    },
    { id: 31, name: "Extra", section: 5, component: "mod_subsection", itemid: 31, summary: "<h4></h4>", modules: [{ id: 806, modname: "label", name: "Nota", description: "<p>TODOS LOS ESTUDIANTES DEBEN TRAER LA COMPUTADORA CARGADA A LA CLASE PRÁCTICA</p>" }] },
];

const PAGES = {
    pages: [
        { id: 1201, coursemodule: 803, course: COURSE, name: "Reglas", content: '<h3>Reglas</h3><img src="x.png" alt="IMG_0001.jpg"><a href="https://ok.example.org/reglamento">Reglamento académico</a>', contentformat: 1 },
        { id: 1299, coursemodule: 9299, course: OTHER_COURSE, name: "Página ajena", content: "<img src='NO-DEBE-REVISARSE.png'>", contentformat: 1 },
    ],
    warnings: [],
};

async function harness(opts: { linkCheck?: LinkCheckDeps } = {}) {
    const h = await makeHarness(opts);
    h.fake.overrides.set("core_course_get_contents", () => SECTIONS);
    h.fake.overrides.set("mod_page_get_pages_by_courses", () => PAGES);
    return h;
}

function linkDeps(): LinkCheckDeps & { asked: { url: string; init?: RequestInit }[] } {
    const asked: { url: string; init?: RequestInit }[] = [];
    return {
        asked,
        resolve: async () => ["93.184.216.34"],
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            asked.push({ url, init });
            if (url.startsWith("https://roto.example.org/")) return new Response(null, { status: 404 });
            if (url.startsWith("https://biblio.example.org/")) throw new TypeError("fetch failed");
            return new Response(null, { status: 200 });
        }) as typeof fetch,
    };
}

async function connect(h: Harness) {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([h.app.server().connect(serverT), client.connect(clientT)]);
    return client;
}

describe("revisión de accesibilidad y formato del curso", () => {
    it("recorre resúmenes, etiquetas, descripciones, páginas y subsecciones, en orden y con ubicación", async () => {
        const h = await harness();
        const r = await h.app.service.getContentIssues({ course_id: COURSE });
        const got = r.data.issues.map((i) => `${i.location.kind}:${i.location.course_module_id ?? `s${i.location.section_number}`}:${i.rule}`);
        expect(got).toEqual([
            "section_summary:s0:empty_paragraphs",
            "section_summary:s0:img_alt_missing",
            "label:801:table_no_headers",
            "section_summary:s1:heading_skip",
            "section_summary:s1:link_text_vague",
            "section_summary:s1:link_new_window",
            "description:803:low_contrast",
            "page:803:img_alt_filename",
            "section_summary:s1:heading_empty",
            "label:806:all_caps",
        ]);
        const sub = r.data.issues.find((i) => i.rule === "heading_empty")!;
        expect(sub.location).toEqual({ kind: "section_summary", section_number: 1, name: "Extra", in_subsection: "Extra" });
        expect(r.data.summary).toMatchObject({ texts_inspected: 8, issues_total: 10, by_severity: { alta: 2, media: 5, baja: 3 }, by_rule: { empty_paragraphs: 1, img_alt_missing: 1, low_contrast: 1 } });
        expect(r.data.inspected.by_kind).toEqual({ section_summary: 3, label: 2, page: 1, description: 2 });
        expect(r.source.wsfunctions).toEqual(["core_course_get_contents", "mod_page_get_pages_by_courses"]);
        expect(r.coverage).toMatchObject({ complete: true, has_more: false, next_cursor: null });
        expect(r.data.link_checks).toBeNull();
        expect(r.warnings.join(" ")).toMatch(/heurística/);
        expect(r.warnings.join(" ")).toMatch(/sólo colores en línea/);
        expect(r.content_policy).toMatch(/no confiables/);
        // Nada de otro curso, ni HTML en la evidencia.
        expect(JSON.stringify(r)).not.toContain("NO-DEBE-REVISARSE");
        for (const i of r.data.issues) expect(i.evidence).not.toMatch(/<[a-z]/i);
        // Sólo lecturas.
        expect(h.fake.calls.map((c) => c.fn).filter((f) => !["core_webservice_get_site_info", "core_enrol_get_users_courses", "core_course_get_contents", "mod_page_get_pages_by_courses"].includes(f))).toEqual([]);
    });

    it("filtros: una sección (con su subsección) o un solo elemento; los que no existen se rechazan", async () => {
        const h = await harness();
        const s1 = await h.app.service.getContentIssues({ course_id: COURSE, section_number: 1 });
        expect(new Set(s1.data.issues.map((i) => i.location.section_number))).toEqual(new Set([1]));
        expect(s1.data.summary.issues_total).toBe(7);
        const page = await h.app.service.getContentIssues({ course_id: COURSE, course_module_id: 803 });
        expect(page.data.issues.map((i) => `${i.location.kind}:${i.rule}`)).toEqual(["description:low_contrast", "page:img_alt_filename"]);
        const label = await h.app.service.getContentIssues({ course_id: COURSE, course_module_id: 801 });
        expect(label.source.wsfunctions).toEqual(["core_course_get_contents"]);
        await expect(h.app.service.getContentIssues({ course_id: COURSE, section_number: 9 })).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
        await expect(h.app.service.getContentIssues({ course_id: COURSE, course_module_id: 999 })).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
        await expect(h.app.service.getContentIssues({ course_id: COURSE, section_number: 0, course_module_id: 803 })).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
        await expect(h.app.service.getContentIssues({ course_id: OTHER_COURSE })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    });

    it("paginado con cursor: mismas condiciones; un cursor de otra revisión se rechaza", async () => {
        const h = await harness();
        const p1 = await h.app.service.getContentIssues({ course_id: COURSE, limit: 4 });
        expect(p1.data.issues).toHaveLength(4);
        expect(p1.coverage).toMatchObject({ complete: false, has_more: true });
        const p2 = await h.app.service.getContentIssues({ course_id: COURSE, limit: 4, cursor: p1.coverage.next_cursor! });
        const p3 = await h.app.service.getContentIssues({ course_id: COURSE, limit: 4, cursor: p2.coverage.next_cursor! });
        expect([...p1.data.issues, ...p2.data.issues, ...p3.data.issues]).toHaveLength(10);
        expect(p3.coverage.next_cursor).toBeNull();
        expect(p3.data.issue_range).toEqual({ start: 8, end: 10, total: 10 });
        await expect(h.app.service.getContentIssues({ course_id: COURSE, limit: 4, section_number: 1, cursor: p1.coverage.next_cursor! })).rejects.toMatchObject({ code: "RESOURCE_OUT_OF_SCOPE" });
        await expect(h.app.service.getContentIssues({ course_id: COURSE, cursor: "no-es-un-cursor" })).rejects.toBeInstanceOf(CampusError);
    });

    it("si no se pueden leer las páginas, cobertura parcial con el motivo (no se presenta como sin problemas)", async () => {
        const h = await harness();
        h.fake.overrides.set("mod_page_get_pages_by_courses", () => ({ exception: "required_capability_exception", errorcode: "nopermissions", message: "Sorry" }));
        const r = await h.app.service.getContentIssues({ course_id: COURSE });
        expect(r.coverage.complete).toBe(false);
        expect(r.coverage.detail.omitted).toEqual([expect.objectContaining({ what: "contenido de páginas", count: 1 })]);
        expect(r.warnings.join(" ")).toMatch(/No se pudo leer el contenido de las páginas/);
        expect(r.data.issues.some((i) => i.location.kind === "page")).toBe(false);
        // Pedida sólo esa página, el error es la respuesta.
        await expect(h.app.service.getContentIssues({ course_id: COURSE, course_module_id: 803 })).rejects.toBeInstanceOf(CampusError);
    });

    it("check_links: verifica enlaces externos sin token ni cookies y no pide los del Campus", async () => {
        const deps = linkDeps();
        const h = await harness({ linkCheck: deps });
        const r = await h.app.service.getContentIssues({ course_id: COURSE, check_links: true });
        const lc = r.data.link_checks as { distinct_links: number; checked: number; ok: number; roto: number; no_verificado: number; results: { url: string; status: string; reason: string | null; location: { kind: string } }[] };
        expect(lc).toMatchObject({ distinct_links: 4, checked: 4, ok: 1, roto: 1, no_verificado: 2 });
        const by = Object.fromEntries(lc.results.map((x) => [x.url, x]));
        expect(by["https://roto.example.org/viejo"]).toMatchObject({ status: "roto", location: { kind: "section_summary" } });
        expect(by["https://biblio.example.org/apunte"]).toMatchObject({ status: "no_verificado" });
        expect(by[`${SITE}/mod/resource/view.php?id=9`]).toMatchObject({ status: "no_verificado", reason: "enlace al Campus: requiere sesión, no se verifica" });
        expect(by["https://ok.example.org/reglamento"]).toMatchObject({ status: "ok", location: { kind: "page" } });
        expect(deps.asked.some((a) => a.url.startsWith(SITE))).toBe(false);
        for (const a of deps.asked) expect(JSON.stringify(a)).not.toContain(VALID_TOKEN);
        // El transporte del Campus no se usa para los enlaces externos.
        expect(h.fake.foreign).toEqual([]);
        expect(r.warnings.join(" ")).toMatch(/sin cookies ni token/);
        // Con cursor no se repite.
        const again = await h.app.service.getContentIssues({ course_id: COURSE, check_links: true, limit: 4 });
        const p2 = await h.app.service.getContentIssues({ course_id: COURSE, check_links: true, limit: 4, cursor: again.coverage.next_cursor! });
        expect(p2.data.link_checks).toBeNull();
        expect(p2.warnings.join(" ")).toMatch(/sólo en la primera página/);
    });

    it("por MCP: herramienta de lectura en el catálogo, resultado con source/coverage/warnings", async () => {
        const h = await harness();
        const client = await connect(h);
        const { tools } = await client.listTools();
        const t = tools.find((x) => x.name === "campus_get_content_issues")!;
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(["check_links", "course_id", "course_module_id", "cursor", "limit", "section_number"]);
        const res = await client.callTool({ name: "campus_get_content_issues", arguments: { course_id: COURSE, section_number: 0 } });
        expect(res.isError).toBeFalsy();
        const body = JSON.parse((res.content as { text: string }[])[0]!.text);
        expect(body.data.summary.issues_total).toBe(3);
        expect(body.source).toMatchObject({ system: "moodle", course_id: COURSE });
        expect(body.coverage.detail.scope).toMatchObject({ section_number: 0, check_links: false });
        const denied = await client.callTool({ name: "campus_get_content_issues", arguments: { course_id: OTHER_COURSE } });
        expect(denied.isError).toBe(true);
    });
});
