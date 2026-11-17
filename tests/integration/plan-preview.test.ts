import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { chromeRenderer, findChrome, type HtmlRenderer } from "../../src/documents/render.js";
import { decodePng, encodePng, pngSize } from "../../src/documents/png.js";
import { createLogger } from "../../src/util/logger.js";
import { END_MARKER_RGB, previewPage } from "../../src/write/plan-preview.js";
import { createWriteServer } from "../../src/write/server.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY } from "../fixtures/fake-web.js";
import { HORARIOS, PATCH } from "../fixtures/html-horarios.js";
import { makeWriteHarness, parseTool, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * ADR-140: campus_get_plan_preview sobre un plan guardado de verdad (patch_section_summary contra el Moodle
 * sintético), con un renderer falso; y, si hay Chrome o Edge en esta computadora, un dibujo real.
 */

const SECTION_ID = 101;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Sección 1 con el resumen de horarios (como en write-section-patch.test.ts). */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["rename_content", "synthetic_test"] } } });
    const prev = h.fake.overrides.get("core_course_get_contents")!;
    h.fake.overrides.set("core_course_get_contents", (p) => (prev(p) as { id: number }[]).map((s) => ({ ...s, summary: s.id === SECTION_ID ? HORARIOS : "" })));
    h.fake.web.pages.set("/course/editsection.php", (q) => ({
        body: `<html><body><form action="${SITE}/course/editsection.php" method="post"><input type="hidden" name="id" value="${q.id}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__editsection_form" value="1"><input type="text" name="name" value="Tema 1"><textarea name="summary_editor[text]">${escapeHtml(HORARIOS)}</textarea><input type="hidden" name="summary_editor[format]" value="1"><input type="hidden" name="summary_editor[itemid]" value="7001"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>`,
    }));
    return h;
}

const patchPlan = (h: WriteHarness) =>
    h.app.engine.plan("patch_section_summary", { course_id: COURSE, section_number: 1, table_match: { headers_contain: PATCH.headers_contain }, row_match: PATCH.row_match, column: PATCH.column, expected_text: PATCH.expected_text, replacement_text: PATCH.replacement_text }, "test");

async function connect(h: WriteHarness, mode: "local" | "remoto", htmlRenderer?: HtmlRenderer | null) {
    const server = createWriteServer({ engine: h.app.engine, confirmer: h.confirmer, intents: h.app.intents, logger: createLogger(() => {}, "debug"), mode, ...(htmlRenderer !== undefined ? { htmlRenderer } : {}) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cliente-vista", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };

const fakeRenderer = (): HtmlRenderer & { pages: string[] } => {
    const pages: string[] = [];
    return {
        browser: "falso",
        pages,
        async screenshot(html, size) {
            pages.push(html);
            const data = Buffer.alloc(size.width * size.height * 4, 255);
            for (let y = 300; y < 306; y++) for (let x = 0; x < size.width; x++) data.set([...END_MARKER_RGB, 255], (y * size.width + x) * 4);
            return { png: encodePng({ width: size.width, height: size.height, channels: 4, data }), temp_removed: true };
        },
    };
};

describe("campus_get_plan_preview (ADR-140)", () => {
    it("plan de parche de sección: JSON con origen y advertencias, y dos imágenes rotuladas (antes y después)", async () => {
        const h = await harness();
        const p = await patchPlan(h);
        const r = fakeRenderer();
        const client = await connect(h, "local", r);
        const tool = (await client.listTools()).tools.find((t) => t.name === "campus_get_plan_preview")!;
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(["plan_id"]);
        const res = (await client.callTool({ name: "campus_get_plan_preview", arguments: { plan_id: p.plan_id } })) as { isError?: boolean; content: Block[] };
        expect(res.isError ?? false).toBe(false);
        expect(res.content.map((b) => b.type)).toEqual(["text", "text", "image", "text", "image"]);
        const out = parseTool(res);
        expect(out).toMatchObject({ plan_id: p.plan_id, intent: "patch_section_summary", plan_status: "pendiente", images: 2, coverage: { complete: true } });
        expect(out.fields[0]).toMatchObject({ field: "items.i1", label: "Resumen de la sección", identical: false });
        expect(res.content[1]!.text).toContain("ANTES");
        expect(res.content[3]!.text).toContain("DESPUÉS");
        expect(pngSize(Buffer.from(res.content[2]!.data!, "base64"))).toEqual({ width: 900, height: 300 });
        // El HTML del plan llegó saneado a la página: la imagen @@PLUGINFILE@@ es un recuadro y el «después» trae el cambio.
        expect(r.pages[0]).toContain("Imagen del Campus: icono.png");
        expect(r.pages[0]).not.toContain("@@PLUGINFILE@@");
        expect(r.pages[1]).toContain("Miércoles");
        expect(r.pages[0]).toContain("Martes (extraordinario)");
        // No escribe ni lee el Campus.
        expect(h.fake.web.requests.filter((q) => q.method === "POST")).toHaveLength(0);
    });

    it("en remoto: UNSUPPORTED_CONTENT con el motivo, sin intentar dibujar", async () => {
        const h = await harness();
        const p = await patchPlan(h);
        const r = fakeRenderer();
        const res = (await (await connect(h, "remoto", r)).callTool({ name: "campus_get_plan_preview", arguments: { plan_id: p.plan_id } })) as { isError?: boolean; content: Block[] };
        expect(res.isError).toBe(true);
        expect(parseTool(res).error).toMatchObject({ code: "UNSUPPORTED_CONTENT" });
        expect(parseTool(res).error.message).toContain("sólo funciona en el servidor local");
        expect(r.pages).toHaveLength(0);
    });

    it("plan sin texto enriquecido o sin navegador: error claro, no un resultado vacío", async () => {
        const h = await harness();
        const marker = await h.app.engine.plan("marcador_sintetico", { course_id: COURSE, changes: [{ marker_id: 1, value: "x" }] }, "test");
        const client = await connect(h, "local", fakeRenderer());
        const res = (await client.callTool({ name: "campus_get_plan_preview", arguments: { plan_id: marker.plan_id } })) as { isError?: boolean; content: Block[] };
        expect(res.isError).toBe(true);
        expect(parseTool(res).error.message).toContain("No hay vista previa para este plan");
        const p = await patchPlan(h);
        const none = (await (await connect(h, "local", null)).callTool({ name: "campus_get_plan_preview", arguments: { plan_id: p.plan_id } })) as { isError?: boolean; content: Block[] };
        expect(none.isError).toBe(true);
        expect(parseTool(none).error.message).toContain("CAMPUS_CHROME_PATH");
        const missing = (await client.callTool({ name: "campus_get_plan_preview", arguments: { plan_id: "pl_aaaaaaaaaaaaaaaa" } })) as { isError?: boolean };
        expect(missing.isError).toBe(true);
    });

    // Dibujo real con el Chrome/Edge de esta computadora (se omite en CI). CAMPUS_PREVIEW_OUT guarda los PNG.
    it.skipIf(!findChrome())("dibujo real con Chrome/Edge local: PNG de ≤1200 px de ancho, recortado al contenido", { timeout: 90_000 }, async () => {
        const h = await harness();
        const p = await patchPlan(h);
        const client = await connect(h, "local");
        const res = (await client.callTool({ name: "campus_get_plan_preview", arguments: { plan_id: p.plan_id } })) as { isError?: boolean; content: Block[] };
        expect(res.isError ?? false, JSON.stringify(res.content[0])).toBe(false);
        const images = res.content.filter((b) => b.type === "image").map((b) => Buffer.from(b.data!, "base64"));
        expect(images).toHaveLength(2);
        for (const png of images) {
            const s = pngSize(png)!;
            expect(s.width).toBeLessThanOrEqual(1200);
            expect(s.height).toBeGreaterThan(100);
            expect(s.height).toBeLessThan(2400);
        }
        const out = process.env.CAMPUS_PREVIEW_OUT;
        if (out) {
            mkdirSync(out, { recursive: true });
            images.forEach((png, i) => writeFileSync(join(out, `vista-${i === 0 ? "antes" : "despues"}.png`), png));
            writeFileSync(join(out, "vista.json"), res.content[0]!.text!);
        }
    });
    // Sin el saneamiento, la CSP impide los scripts (sin ella la página queda roja) y la CSP y el proxy inexistente
    // impiden la red (cada uno por separado): HTML hostil contra un servidor local que cuenta pedidos.
    it.skipIf(!findChrome())("dibujo real: scripts y red bloqueados aunque el HTML no se sanee", { timeout: 90_000 }, async () => {
        let hits = 0;
        const srv = createServer((_q, r) => {
            hits++;
            r.end("x");
        });
        await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
        const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        try {
            const hostile = `<script>document.documentElement.style.background="#ff0000";document.body.innerHTML="";</script><p>texto</p><img src="${base}/a.png"><iframe src="${base}/f"></iframe><link rel="stylesheet" href="${base}/s.css"><div style="width:50px;height:50px;background:url(${base}/b.png)"></div><video src="${base}/v.mp4"></video><object data="${base}/o"></object><p><img src=x onerror="document.body.style.background='#ff0000'"></p>`;
            const shot = await chromeRenderer(findChrome()!).screenshot(previewPage(hostile, "ANTES · prueba", "before"), { width: 300, height: 400 });
            expect(shot.temp_removed).toBe(true);
            const raw = decodePng(shot.png)!;
            let red = 0;
            for (let i = 0; i < raw.data.length; i += raw.channels) if (raw.data[i] === 255 && raw.data[i + 1] === 0 && raw.data[i + 2] === 0) red++;
            expect(red).toBe(0);
            expect(hits).toBe(0);
        } finally {
            srv.close();
        }
    });
});
