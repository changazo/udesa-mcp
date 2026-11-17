import { describe, expect, it } from "vitest";
import { analyzeHtml, checkLinks, contrastRatio, parseCssColor, type ContentLocation, type LinkCheckDeps } from "../../src/domain/content-issues.js";

/** Revisión de accesibilidad y formato (ADR-139): reglas sobre HTML sintético y verificación de enlaces sin red. */

const LOC: ContentLocation = { kind: "label", section_number: 1, course_module_id: 77, name: "Etiqueta sintética" };
const rules = (html: string) => analyzeHtml(html, LOC).map((i) => i.rule);
const only = (html: string, rule: string) => analyzeHtml(html, LOC).filter((i) => i.rule === rule);

describe("imágenes", () => {
    it("sin alt, alt vacío sin marca, alt con nombre de archivo; decorativa marcada no es problema", () => {
        expect(rules('<p><img src="https://campus.example.test/pluginfile.php/1/x/diagrama.png?token=abc"></p>')).toEqual(["img_alt_missing"]);
        const missing = only('<img src="https://campus.example.test/pluginfile.php/1/x/diagrama.png?token=abc">', "img_alt_missing")[0]!;
        expect(missing.severity).toBe("alta");
        expect(missing.evidence).toBe("imagen «diagrama.png»");
        expect(missing.evidence).not.toContain("token");
        expect(rules('<img src="a.png" alt="">')).toEqual(["img_alt_empty"]);
        expect(rules('<img src="a.png" alt="IMG_2031.jpg">')).toEqual(["img_alt_filename"]);
        expect(rules('<img src="a.png" alt="Captura de pantalla 2026-03-01">')).toEqual(["img_alt_filename"]);
        expect(rules('<img src="a.png" alt="" role="presentation">')).toEqual([]);
        expect(rules('<img src="a.png" alt="Diagrama del ciclo del agua con sus cuatro etapas">')).toEqual([]);
        expect(rules('<img src="a.png" aria-label="Logo de la universidad">')).toEqual([]);
    });
});

describe("tablas", () => {
    it("sin encabezados sugiere marcar la primera fila; con <th> o <thead> no; tabla vacía aparte", () => {
        const html = "<table><tbody><tr><td>Día</td><td>Tema</td></tr><tr><td>Lunes</td><td>Funciones</td></tr></tbody></table>";
        const [t] = only(html, "table_no_headers");
        expect(t!.evidence).toBe("primera fila: Día | Tema");
        expect(t!.suggestion).toMatch(/primera fila como encabezado/);
        expect(rules("<table><tr><th>Día</th></tr><tr><td>Lunes</td></tr></table>")).toEqual([]);
        expect(rules("<table><thead><tr><td>Día</td></tr></thead><tr><td>Lunes</td></tr></table>")).toEqual([]);
        expect(rules('<table role="presentation"><tr><td>a</td></tr><tr><td>b</td></tr></table>')).toEqual([]);
        expect(rules("<table><tr><td> </td><td>&nbsp;</td></tr></table>")).toEqual(["table_empty"]);
    });
});

describe("enlaces", () => {
    it("texto vago en castellano e inglés, sin texto, URL como texto y pestaña nueva sin aviso", () => {
        expect(rules('<a href="https://ejemplo.org/guia">Click aquí</a>')).toEqual(["link_text_vague"]);
        expect(rules('<a href="https://ejemplo.org/guia">acá</a>')).toEqual(["link_text_vague"]);
        expect(rules('<a href="https://ejemplo.org/guia">here</a>')).toEqual(["link_text_vague"]);
        expect(rules('<a href="https://ejemplo.org/guia">Este enlace.</a>')).toEqual(["link_text_vague"]);
        expect(rules('<a href="https://ejemplo.org/guia">Guía de trabajos prácticos</a>')).toEqual([]);
        expect(rules('<a href="https://ejemplo.org/guia"><img src="x.png" alt=""></a>')).toContain("link_text_empty");
        expect(rules('<a href="https://ejemplo.org/guia"><img src="x.png" alt="Guía de trabajos prácticos"></a>')).toEqual([]);
        const url = only('<a href="https://ejemplo.org/g?token=SECRETO">https://ejemplo.org/g?token=SECRETO</a>', "link_text_url")[0]!;
        expect(url.evidence).not.toContain("SECRETO");
        expect(rules('<a href="https://ejemplo.org/guia" target="_blank">Guía de trabajos prácticos</a>')).toEqual(["link_new_window"]);
        expect(rules('<a href="https://ejemplo.org/guia" target="_blank">Guía (se abre en una pestaña nueva)</a>')).toEqual([]);
        expect(only('<a href="https://ejemplo.org/guia" target="_blank">Guía</a>', "link_new_window")[0]!.severity).toBe("baja");
    });
});

describe("contraste", () => {
    it("colores CSS: hex corto y largo, rgb()/rgba(), nombres básicos; desconocidos null", () => {
        expect(parseCssColor("#fff")).toEqual([255, 255, 255, 1]);
        expect(parseCssColor("#777777")).toEqual([119, 119, 119, 1]);
        expect(parseCssColor("rgb(255, 0, 0)")).toEqual([255, 0, 0, 1]);
        expect(parseCssColor("rgba(0,0,0,0.5)")).toEqual([0, 0, 0, 0.5]);
        expect(parseCssColor("rgb(0 0 0 / 50%)")).toEqual([0, 0, 0, 0.5]);
        expect(parseCssColor("Gray !important")).toEqual([128, 128, 128, 1]);
        expect(parseCssColor("var(--color)")).toBeNull();
        expect(parseCssColor("currentcolor")).toBeNull();
    });

    it("relación WCAG: negro/blanco 21:1, #777 sobre blanco ≈ 4.48:1", () => {
        expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
        expect(contrastRatio([119, 119, 119, 1], [255, 255, 255, 1])).toBeCloseTo(4.48, 2);
    });

    it("color en línea bajo sobre fondo blanco supuesto; fondo en línea y texto grande cambian el umbral", () => {
        const [low] = only('<p><span style="color: #aaaaaa">Entrega hasta el viernes</span></p>', "low_contrast");
        expect(low!.severity).toBe("alta");
        expect(low!.evidence).toMatch(/«Entrega hasta el viernes»: #aaaaaa sobre #ffffff \(fondo blanco supuesto\), 2\.32:1/);
        expect(only('<p style="color:#777">Texto normal</p>', "low_contrast")[0]!.severity).toBe("media");
        expect(rules('<p style="color:#333">Texto legible</p>')).toEqual([]);
        // Blanco sobre azul oscuro en línea: bien; amarillo sobre blanco: mal.
        expect(rules('<div style="background-color:#003366"><span style="color:#fff">Aviso</span></div>')).toEqual([]);
        expect(rules('<font color="yellow">Atención</font>')).toEqual(["low_contrast"]);
        // #777 alcanza 3:1, suficiente para texto grande (h1 o 24px), no para texto normal.
        expect(rules('<h1 style="color:#777">Unidad 1</h1>')).toEqual([]);
        expect(rules('<p><span style="font-size: 24px; color: #777">Grande</span></p>')).toEqual([]);
        // Fondo con imagen o degradado: no se evalúa.
        expect(rules('<div style="background: url(x.png)"><span style="color:#eee">Sobre imagen</span></div>')).toEqual([]);
        // Sin texto propio no hay nada que leer.
        expect(rules('<span style="color:#eee"><span style="color:#000">Texto negro</span></span>')).toEqual([]);
    });
});

describe("estructura y formato", () => {
    it("salto de nivel de encabezado, encabezado vacío, mayúsculas sostenidas y párrafos vacíos apilados", () => {
        const skip = only("<h2>Unidad</h2><p>x</p><h5>Detalle</h5>", "heading_skip");
        expect(skip).toHaveLength(1);
        expect(skip[0]!.evidence).toBe("h2 → h5: «Detalle»");
        expect(skip[0]!.suggestion).toMatch(/usá h3/);
        expect(rules("<h3>Unidad</h3><h4>Tema</h4><h3>Otra</h3>")).toEqual([]);
        expect(rules("<h4></h4>")).toEqual(["heading_empty"]);
        expect(rules("<p>LA ENTREGA DEL TRABAJO PRÁCTICO ES OBLIGATORIA PARA TODOS LOS ESTUDIANTES</p>")).toEqual(["all_caps"]);
        expect(rules("<p>IMPORTANTE: leer</p>")).toEqual([]);
        const empty = only("<p>Bienvenidos</p><p></p><p>&nbsp;</p><p><br></p><p>Fin</p>", "empty_paragraphs");
        expect(empty).toHaveLength(1);
        expect(empty[0]!.evidence).toBe("3 párrafos vacíos seguidos después de «Bienvenidos»");
        expect(rules("<p>a</p><p></p><p></p><p>b</p>")).toEqual([]);
        expect(rules("<div><p></p><p></p><p></p></div>")).toEqual(["empty_paragraphs"]);
        expect(rules('<p></p><p><img src="x.png" alt="Mapa"></p><p></p>')).toEqual([]);
    });

    it("la evidencia es texto (sin HTML) de hasta 120 caracteres y lleva la ubicación", () => {
        const long = `<table><tr>${"<td><b>Columna</b> con texto largo</td>".repeat(10)}</tr><tr><td>x</td></tr></table>`;
        const [t] = analyzeHtml(long, LOC);
        expect(t!.evidence.length).toBeLessThanOrEqual(120);
        expect(t!.evidence).not.toMatch(/[<>]/);
        expect(t!.location).toEqual(LOC);
    });
});

describe("verificación de enlaces (sin red)", () => {
    const SITE = "https://campus.example.test";
    function fake(routes: Record<string, number | [number, string]>, dns: Record<string, string[]> = {}): LinkCheckDeps & { asked: { url: string; method: string; init: RequestInit | undefined }[] } {
        const asked: { url: string; method: string; init: RequestInit | undefined }[] = [];
        return {
            asked,
            resolve: async (host) => {
                if (host === "no-existe.example") throw new Error("ENOTFOUND");
                return dns[host] ?? ["93.184.216.34"];
            },
            fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";
                asked.push({ url, method, init });
                const r = routes[`${method} ${url}`] ?? routes[url];
                if (r === undefined) throw new TypeError("fetch failed");
                const [status, location] = Array.isArray(r) ? r : [r, null];
                return new Response(method === "HEAD" || status === 204 || (status >= 300 && status < 400) ? null : "x", { status, headers: location ? { location } : {} });
            }) as typeof fetch,
        };
    }
    const at = (url: string) => ({ url, location: LOC });

    it("ok, roto (404/410), HEAD rechazado con GET de respaldo, sin respuesta = no verificado", async () => {
        const d = fake({
            "https://ok.example/a": 200,
            "https://roto.example/b": 404,
            "https://borrado.example/c": 410,
            "HEAD https://sinhead.example/d": 405,
            "GET https://sinhead.example/d": 200,
            "https://privado.example/e": 403,
            "https://caido.example/f": 503,
        });
        const r = await checkLinks(["https://ok.example/a", "https://roto.example/b", "https://borrado.example/c", "https://sinhead.example/d", "https://privado.example/e", "https://caido.example/f", "https://mudo.example/g", "https://ok.example/a"].map(at), SITE, d);
        const by = Object.fromEntries(r.results.map((x) => [x.url, x]));
        expect(by["https://ok.example/a"]).toMatchObject({ status: "ok", http_status: 200, occurrences: 2 });
        expect(by["https://roto.example/b"]).toMatchObject({ status: "roto", http_status: 404 });
        expect(by["https://borrado.example/c"]).toMatchObject({ status: "roto", http_status: 410 });
        expect(by["https://sinhead.example/d"]).toMatchObject({ status: "ok", http_status: 200 });
        expect(by["https://privado.example/e"]).toMatchObject({ status: "no_verificado", http_status: 403, reason: "requiere acceso" });
        expect(by["https://caido.example/f"]).toMatchObject({ status: "no_verificado", http_status: 503 });
        expect(by["https://mudo.example/g"]).toMatchObject({ status: "no_verificado", http_status: null });
        expect(r.distinct).toBe(7);
        // Sin cookies ni credenciales y sin seguir redirecciones solo.
        for (const a of d.asked) expect(a.init).toMatchObject({ redirect: "manual", credentials: "omit" });
        for (const a of d.asked) expect(JSON.stringify(a.init?.headers ?? {})).not.toMatch(/cookie|authorization/i);
    });

    it("SSRF: no pide a direcciones privadas, locales ni de metadatos, ni con credenciales, puertos raros o el Campus", async () => {
        const d = fake({}, { "interno.example": ["10.0.0.5"], "mixto.example": ["93.184.216.34", "127.0.0.1"] });
        const urls = [
            "http://127.0.0.1/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "https://interno.example/x",
            "https://mixto.example/x",
            "https://usuario:clave@ok.example/x",
            "https://ok.example:8443/x",
            "https://ok.example/x?wstoken=abc",
            "https://campus.example.test/mod/page/view.php?id=1",
            "https://cdn.campus.example.test/a.png",
            "https://no-existe.example/x",
        ];
        const r = await checkLinks(urls.map(at), SITE, d);
        expect(d.asked).toEqual([]);
        expect(r.results.every((x) => x.status === "no_verificado")).toBe(true);
        const reason = (u: string) => r.results.find((x) => x.url === u || x.url.startsWith(u))!.reason;
        expect(reason("http://127.0.0.1/admin")).toMatch(/no pública/);
        expect(reason("http://169.254.169.254/")).toMatch(/no pública/);
        expect(reason("https://mixto.example/x")).toMatch(/no pública/);
        expect(reason("https://campus.example.test/mod/page")).toBe("enlace al Campus: requiere sesión, no se verifica");
        expect(reason("https://cdn.campus.example.test/a.png")).toMatch(/requiere sesión/);
        expect(reason("https://ok.example:8443/x")).toMatch(/puerto/);
        expect(reason("https://no-existe.example/x")).toMatch(/resolver/);
        // Se muestran sin credenciales ni parámetros de acceso.
        expect(JSON.stringify(r.results)).not.toMatch(/clave|wstoken=abc/);
    });

    it("redirecciones: se revisa cada destino; a una dirección privada o al Campus se corta sin pedirla", async () => {
        const d = fake(
            {
                "https://corto.example/a": [301, "https://destino.example/final"],
                "https://destino.example/final": 200,
                "https://trampa.example/a": [302, "http://interno.example/admin"],
                "https://login.example/a": [302, "https://campus.example.test/login/index.php"],
                "https://bucle.example/a": [302, "https://bucle.example/a"],
            },
            { "interno.example": ["192.168.0.10"] },
        );
        const r = await checkLinks(["https://corto.example/a", "https://trampa.example/a", "https://login.example/a", "https://bucle.example/a"].map(at), SITE, d);
        const by = Object.fromEntries(r.results.map((x) => [x.url, x]));
        expect(by["https://corto.example/a"]).toMatchObject({ status: "ok", final_url: "https://destino.example/final" });
        expect(by["https://trampa.example/a"]).toMatchObject({ status: "no_verificado" });
        expect(by["https://trampa.example/a"]!.reason).toMatch(/no pública/);
        expect(by["https://login.example/a"]!.reason).toMatch(/Campus/);
        expect(by["https://bucle.example/a"]).toMatchObject({ status: "no_verificado", reason: "demasiadas redirecciones" });
        expect(d.asked.some((a) => a.url.includes("interno.example") || a.url.includes("campus.example.test"))).toBe(false);
    });

    it("plazos: un HEAD que agota el tiempo no se repite con GET; agotado el plazo total, el resto queda sin verificar", async () => {
        let clock = 0;
        const asked: string[] = [];
        const deps: LinkCheckDeps = {
            now: () => clock,
            resolve: async () => ["93.184.216.34"],
            fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
                asked.push(`${init?.method} ${String(input)}`);
                if (String(input).includes("lento")) {
                    clock += 26_000;
                    throw new DOMException("timeout", "TimeoutError");
                }
                return new Response(null, { status: 200 });
            }) as typeof fetch,
        };
        const r = await checkLinks([at("https://lento.example/a")], SITE, deps);
        expect(r.results[0]).toMatchObject({ status: "no_verificado", reason: "tiempo agotado" });
        expect(asked).toEqual(["HEAD https://lento.example/a"]);
        clock = 0;
        asked.length = 0;
        // Los cuatro primeros (lentos) agotan el plazo total: el quinto ya no se pide.
        const many = await checkLinks(["https://lento.example/1", "https://lento.example/2", "https://lento.example/3", "https://lento.example/4", "https://ok.example/5"].map(at), SITE, deps);
        expect(many.results[4]).toMatchObject({ status: "no_verificado", reason: "no se alcanzó a verificar (plazo total agotado)" });
        expect(asked).not.toContain("HEAD https://ok.example/5");
    });

    it("hasta 30 enlaces distintos por llamada, de a 4 a la vez", async () => {
        let active = 0;
        let peak = 0;
        const deps: LinkCheckDeps = {
            resolve: async () => ["93.184.216.34"],
            fetchImpl: (async () => {
                active++;
                peak = Math.max(peak, active);
                await new Promise((r) => setTimeout(r, 2));
                active--;
                return new Response(null, { status: 200 });
            }) as unknown as typeof fetch,
        };
        const urls = Array.from({ length: 35 }, (_, i) => at(`https://ok.example/${i}`));
        const r = await checkLinks(urls, SITE, deps);
        expect(r.results).toHaveLength(30);
        expect(r.skipped).toBe(5);
        expect(peak).toBeLessThanOrEqual(4);
    });
});
