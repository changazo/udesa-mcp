import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chromeCandidates, chromeRenderer, findChrome, type HtmlRenderer, type SpawnFn } from "../../src/documents/render.js";
import { cropRows, decodePng, encodePng, findMarkerTop, pngSize, type RawPng } from "../../src/documents/png.js";
import { CampusError } from "../../src/errors.js";
import { END_MARKER_RGB, extractPreviewFields, genericPreviewFields, planPreview, PREVIEW_EXTRACTORS, previewPage, sanitizeForPreview, type PreviewPlan } from "../../src/write/plan-preview.js";

/** ADR-140: vista previa de cambios de texto enriquecido (extractores, saneamiento, página, PNG y Chrome falso). */

const plan = (intent: string, payload_preview: Record<string, unknown>, items: PreviewPlan["items"] = []): PreviewPlan => ({ plan_id: "pl_aaaaaaaaaaaaaaaa", intent, payload_preview, items });

function errOf(fn: () => unknown): CampusError {
    try {
        fn();
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

/** PNG RGBA de `h` filas blancas con una franja marcadora en [markerAt, markerAt+6). */
function fakeShot(w: number, h: number, markerAt: number | null): Buffer {
    const data = Buffer.alloc(w * h * 4, 255);
    if (markerAt !== null)
        for (let y = markerAt; y < Math.min(h, markerAt + 6); y++)
            for (let x = 0; x < w; x++) data.set([...END_MARKER_RGB, 255], (y * w + x) * 4);
    return encodePng({ width: w, height: h, channels: 4, data });
}

describe("extractores por intención (ADR-140)", () => {
    it("section_summary: before_html/after_html", () => {
        const f = extractPreviewFields(plan("section_summary", { section: { id: 1 }, before_html: "<p>a</p>", after_html: "<p>b</p>" }));
        expect(f).toEqual([{ field: "summary", label: "Resumen de la sección", before_html: "<p>a</p>", after_html: "<p>b</p>" }]);
    });

    it("patch_section_summary: items[].expected.{prior_html, html}", () => {
        const f = extractPreviewFields(plan("patch_section_summary", { table: {} }, [{ item_id: "i1", description: "Celda", expected: { html: "<p>nuevo</p>", prior_html: "<p>viejo</p>" } }]));
        expect(f).toEqual([{ field: "items.i1", label: "Resumen de la sección", before_html: "<p>viejo</p>", after_html: "<p>nuevo</p>" }]);
    });

    it("edit_activity_text: descripción y contenido, cada uno con antes y después", () => {
        const f = extractPreviewFields(plan("edit_activity_text", { activity: {}, description: { before_html: "<p>d0</p>", after_html: "<p>d1</p>" }, content: { before_html: "", after_html: "<p>c1</p>" } }));
        expect(f.map((x) => [x.field, x.before_html, x.after_html])).toEqual([
            ["description", "<p>d0</p>", "<p>d1</p>"],
            ["content", "", "<p>c1</p>"],
        ]);
    });

    it("create_content: página o etiqueta, sólo después", () => {
        expect(extractPreviewFields(plan("create_content", { type: "page", content_html: "<p>x</p>" }))).toEqual([{ field: "content_html", label: "Contenido de la página", before_html: null, after_html: "<p>x</p>" }]);
        expect(extractPreviewFields(plan("create_content", { type: "label", text_html: "<p>y</p>" }))[0]!.label).toBe("Texto de la etiqueta");
    });

    it("post_edit: «(sin cambios)» no es un texto que dibujar", () => {
        expect(extractPreviewFields(plan("post_edit", { before: { message_html: "<p>a</p>" }, after: { message_html: "<p>b</p>" } }))[0]).toMatchObject({ before_html: "<p>a</p>", after_html: "<p>b</p>" });
        expect(errOf(() => extractPreviewFields(plan("post_edit", { before: { message_html: "<p>a</p>" }, after: { subject: "x", message_html: "(sin cambios)" } }))).code).toBe("UNSUPPORTED_CONTENT");
    });

    it("una intención nueva sin fila usa el genérico: items[].expected.{prior_html, html}", () => {
        expect(PREVIEW_EXTRACTORS["plan_patch_html_futuro"]).toBeUndefined();
        const f = extractPreviewFields(plan("plan_patch_html_futuro", {}, [{ item_id: "i1", description: "Reemplazar enlace", expected: { prior_html: "<a>1</a>", html: "<a>2</a>" } }]));
        expect(f).toEqual([{ field: "items.i1", label: "Reemplazar enlace", before_html: "<a>1</a>", after_html: "<a>2</a>" }]);
    });

    it("genérico: payload_preview.<clave>.{before_html, after_html} y before/after.<x>_html", () => {
        expect(genericPreviewFields(plan("x", { intro: { before_html: "<p>a</p>", after_html: "<p>b</p>" } })).map((f) => f.field)).toEqual(["intro"]);
        expect(genericPreviewFields(plan("x", { before: { body_html: "<p>a</p>" }, after: { body_html: "<p>b</p>" } })).map((f) => f.field)).toEqual(["body_html"]);
    });

    it("un plan sin texto enriquecido: error claro, no una lista vacía", () => {
        const e = errOf(() => extractPreviewFields(plan("rename", { before: "Viejo", after: "Nuevo" }, [{ item_id: "i1", expected: { name: "Nuevo" } }])));
        expect(e.code).toBe("UNSUPPORTED_CONTENT");
        expect(e.message).toContain("No hay vista previa para este plan");
    });
});

describe("saneamiento y página (ADR-140)", () => {
    it("quita scripts, metadatos, estilos propios y atributos on*; @@PLUGINFILE@@ → recuadro; data: se dibuja", () => {
        const html = `<p onclick="alert(1)" class="lead vp-end">Hola<script>alert(2)</script></p><meta http-equiv="refresh" content="0;url=https://x.test"><style>body{}</style><link rel="stylesheet" href="https://x.test/a.css"><img src="@@PLUGINFILE@@/icono.png" alt="Horarios" width="32"><img src="https://campus.test/pluginfile.php/5/mod_page/content/foto%20grande.jpg" alt="Foto"><img src="data:image/png;base64,AAAA" alt="ok" onerror="x()"><iframe src="https://h5p.test/embed/1" width="600" height="300"></iframe><svg><script>1</script><image href="https://x.test/i.png"/></svg><form action="https://x.test"><input type="image" src="https://x.test/b.png"></form>`;
        const { html: out, stats } = sanitizeForPreview(html);
        expect(out).not.toMatch(/<script|onclick|onerror|<meta|<style|<link|<iframe|https:\/\/x\.test|refresh/i);
        expect(out).toContain('class="lead"');
        expect(out).toContain("Imagen del Campus: icono.png");
        expect(out).toContain("Imagen del Campus: foto grande.jpg · «Foto»");
        expect(out).toContain('src="data:image/png;base64,AAAA"');
        expect(out).toContain("Contenido incrustado (iframe: h5p.test)");
        expect(stats).toMatchObject({ images: 2, inline_images: 1, embeds: 1 });
        expect(stats.removed).toBeGreaterThanOrEqual(4);
    });

    it("la página trae la CSP antes que nada: sin scripts, sin red salvo imágenes data:, estilos por nonce", () => {
        const page = previewPage("<p>x</p>", "ANTES · Resumen", "before", "NONCE123");
        const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)![1]!;
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("script-src 'none'");
        expect(csp).toContain("img-src data:;");
        expect(csp).not.toContain("https:");
        expect(csp).toContain("style-src-elem 'nonce-NONCE123'");
        expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<style"));
        expect(page).toContain('<style nonce="NONCE123">');
        expect(page).toContain("ANTES · Resumen");
        expect(page).toContain('<div class="vp-end"></div></body>');
        expect(previewPage("  ", "x", "after")).toContain("(vacío)");
        // El rótulo se escapa.
        expect(previewPage("", "<b>x</b>", "after")).toContain("&lt;b&gt;x&lt;/b&gt;");
    });
});

describe("PNG (ADR-140)", () => {
    it("codifica, decodifica, encuentra la franja final y recorta", () => {
        const png = fakeShot(40, 100, 60);
        expect(pngSize(png)).toEqual({ width: 40, height: 100 });
        const raw = decodePng(png)!;
        expect(raw).toMatchObject({ width: 40, height: 100, channels: 4 });
        expect(findMarkerTop(raw, END_MARKER_RGB)).toBe(60);
        const c = decodePng(encodePng(cropRows(raw, 60)))!;
        expect([c.width, c.height]).toEqual([40, 60]);
        expect(findMarkerTop(c, END_MARKER_RGB)).toBe(-1);
        expect(findMarkerTop(decodePng(fakeShot(40, 100, null))!, END_MARKER_RGB)).toBe(-1);
    });

    it("decodifica los cinco filtros (fila a fila) de un PNG RGB", () => {
        const w = 5;
        const h = 5;
        const data = Buffer.from(Array.from({ length: w * h * 3 }, (_, i) => (i * 37) % 256));
        const stride = w * 3;
        const rows: Buffer[] = [];
        for (let y = 0; y < h; y++) {
            const f = y; // 0..4
            const row = Buffer.alloc(stride + 1);
            row[0] = f;
            for (let x = 0; x < stride; x++) {
                const v = data[y * stride + x]!;
                const a = x >= 3 ? data[y * stride + x - 3]! : 0;
                const b = y > 0 ? data[(y - 1) * stride + x]! : 0;
                const c = x >= 3 && y > 0 ? data[(y - 1) * stride + x - 3]! : 0;
                const p = a + b - c;
                const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
                row[x + 1] = (v - [0, a, b, (a + b) >> 1, pr][f]!) & 0xff;
            }
            rows.push(row);
        }
        // Se arma el PNG a mano con esos filtros reutilizando el codificador para los chunks.
        const base = encodePng({ width: w, height: h, channels: 3, data } as RawPng);
        const idatAt = base.indexOf("IDAT", 0, "latin1") - 4;
        const head = base.subarray(0, idatAt);
        const body = deflateSync(Buffer.concat(rows));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(body.length);
        const png = Buffer.concat([head, len, Buffer.from("IDAT", "latin1"), body, Buffer.alloc(4), base.subarray(base.length - 12)]);
        expect(decodePng(png)!.data.equals(data)).toBe(true);
    });
});

describe("Chrome/Edge (ADR-140)", () => {
    it("CAMPUS_CHROME_PATH manda; después Chrome y Edge en las rutas de Windows", () => {
        const env = { CAMPUS_CHROME_PATH: "D:/portable/chrome.exe", PROGRAMFILES: "C:/PF", "PROGRAMFILES(X86)": "C:/PF86", LOCALAPPDATA: "C:/U/AppData/Local" };
        expect(findChrome(env, "win32", (p) => p === "D:/portable/chrome.exe")).toBe("D:/portable/chrome.exe");
        const c = chromeCandidates(env, "win32").map((p) => p.replace(/\\/g, "/"));
        expect(c[0]).toBe("C:/PF/Google/Chrome/Application/chrome.exe");
        expect(c).toContain("C:/PF86/Microsoft/Edge/Application/msedge.exe");
        expect(c).toContain("C:/U/AppData/Local/Google/Chrome/Application/chrome.exe");
        const edge = c.find((p) => p.endsWith("msedge.exe"))!;
        expect(findChrome({ ...env, CAMPUS_CHROME_PATH: "" }, "win32", (p) => p.replace(/\\/g, "/") === edge)?.replace(/\\/g, "/")).toBe(edge);
        expect(chromeCandidates({}, "darwin")[0]).toContain("Google Chrome.app");
        expect(chromeCandidates({}, "linux")).toContain("/usr/bin/chromium");
    });

    it("invoca el navegador sin red y con perfil temporal; lee la captura y borra la carpeta", async () => {
        const calls: { cmd: string; args: string[]; html: string }[] = [];
        const spawnFn: SpawnFn = (cmd, args) => {
            const p = new EventEmitter() as EventEmitter & { kill: () => void };
            p.kill = () => {};
            const shot = args.find((a) => a.startsWith("--screenshot="))!.slice("--screenshot=".length);
            const url = args[args.length - 1]!;
            const html = readFileSync(new URL(url), "utf8");
            calls.push({ cmd, args, html });
            setImmediate(() => {
                writeFileSync(shot, fakeShot(10, 20, 5));
                p.emit("close", 0);
            });
            return p as never;
        };
        const r = chromeRenderer("C:/x/msedge.exe", spawnFn);
        expect(r.browser).toBe("msedge");
        const out = await r.screenshot("<p>hola</p>", { width: 900, height: 2400 });
        expect(pngSize(out.png)).toEqual({ width: 10, height: 20 });
        expect(out.temp_removed).toBe(true);
        const { args, html } = calls[0]!;
        expect(calls[0]!.cmd).toBe("C:/x/msedge.exe");
        expect(html).toBe("<p>hola</p>");
        for (const a of ["--headless=new", "--host-resolver-rules=MAP * ~NOTFOUND", "--window-size=900,2400", "--disable-extensions", "--no-first-run"]) expect(args).toContain(a);
        expect(args.some((a) => a === "--no-sandbox")).toBe(false);
        const profile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
        const shot = args.find((a) => a.startsWith("--screenshot="))!.slice("--screenshot=".length);
        expect(dirname(profile)).toBe(dirname(shot));
        expect(existsSync(dirname(shot))).toBe(false);
        expect(args[args.length - 1]).toMatch(/^file:\/\/.*vista\.html$/);
    });

    it("sin captura o si el navegador no arranca: UNSUPPORTED_CONTENT, y la carpeta se borra igual", async () => {
        let dir = "";
        const noShot: SpawnFn = (_c, args) => {
            const p = new EventEmitter() as EventEmitter & { kill: () => void };
            p.kill = () => {};
            dir = dirname(args.find((a) => a.startsWith("--screenshot="))!.slice(13));
            setImmediate(() => p.emit("close", 21));
            return p as never;
        };
        await expect(chromeRenderer("chrome", noShot).screenshot("x", { width: 10, height: 10 })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT" });
        expect(existsSync(dir)).toBe(false);
        const broken: SpawnFn = () => {
            const p = new EventEmitter() as EventEmitter & { kill: () => void };
            p.kill = () => {};
            setImmediate(() => p.emit("error", new Error("ENOENT")));
            return p as never;
        };
        await expect(chromeRenderer("chrome", broken).screenshot("x", { width: 10, height: 10 })).rejects.toThrow(/No se pudo ejecutar chrome: ENOENT/);
    });
});

describe("planPreview con un renderer falso (ADR-140)", () => {
    const fake = (markerAt: number | null): HtmlRenderer & { pages: string[] } => {
        const pages: string[] = [];
        return { browser: "falso", pages, screenshot: async (html, size) => (pages.push(html), { png: fakeShot(size.width, size.height, markerAt), temp_removed: true }) };
    };

    it("antes y después rotulados, recortados a la franja final; advertencias de imágenes", async () => {
        const r = fake(700);
        const p = plan("section_summary", { before_html: '<p><img src="@@PLUGINFILE@@/a.png">x</p>', after_html: "<p>y</p>" });
        const { result, blocks } = await planPreview({ ...p, state: { status: "pendiente" } }, r, new Date("2026-11-17T12:00:00Z"));
        expect(blocks.map((b) => b.type)).toEqual(["text", "image", "text", "image"]);
        expect((blocks[0] as { text: string }).text).toContain("ANTES · Resumen de la sección");
        expect((blocks[2] as { text: string }).text).toContain("DESPUÉS · Resumen de la sección");
        const img = blocks[1] as { data: string; mimeType: string };
        expect(img.mimeType).toBe("image/png");
        expect(pngSize(Buffer.from(img.data, "base64"))).toEqual({ width: 900, height: 700 });
        expect(result).toMatchObject({ plan_id: p.plan_id, intent: "section_summary", plan_status: "pendiente", images: 2, coverage: { complete: true }, source: { rendered_at: "2026-11-17T12:00:00.000Z" } });
        expect((result.fields as { before: { cut: boolean; placeholders: { images: number } } }[])[0]!.before).toMatchObject({ cut: false, height: 700, placeholders: { images: 1 } });
        expect((result.warnings as string[]).join(" ")).toMatch(/recuadros.*no usa la red/);
        expect(r.pages[0]).toContain("Content-Security-Policy");
        expect(r.pages[0]).toContain("Imagen del Campus: a.png");
    });

    it("sin franja final: imagen cortada a 2400 px con advertencia; sin «antes» al crear", async () => {
        const { result, blocks } = await planPreview(plan("create_content", { content_html: "<p>z</p>" }), fake(null));
        expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
        expect(result.coverage).toMatchObject({ complete: false });
        expect((result.warnings as string[]).join(" ")).toContain("más alto que 2400 px");
        expect((result.warnings as string[]).join(" ")).toContain("no hay «antes»");
    });

    it("sin Chrome ni Edge: UNSUPPORTED_CONTENT con la variable de entorno", async () => {
        await expect(planPreview(plan("section_summary", { before_html: "a", after_html: "b" }), null)).rejects.toThrow(/CAMPUS_CHROME_PATH/);
    });
});
