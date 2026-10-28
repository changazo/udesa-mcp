import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { embedSource, LAB_BASE_URL } from "../../src/h5p/content-types.js";
import { markdownToHtml, toHtml } from "../../src/write/text.js";

/** FMT-01: bloques cercados (```) y direcciones de los recursos incrustados (iframe_embed). */

describe("bloques de código cercados (FMT-01)", () => {
    it("un bloque con indentación se emite como <pre><code>: sin interpretar Markdown ni HTML y con la sangría intacta", () => {
        const md = "¿Qué devuelve?\n\n```python\nfor n in lista:\n    if n > 0 and n < 9:\n        print(\"*ok*\")\n```";
        expect(markdownToHtml(md)).toBe('<p>¿Qué devuelve?</p>\n<pre><code>for n in lista:\n    if n &gt; 0 and n &lt; 9:\n        print(&quot;*ok*&quot;)</code></pre>');
    });

    it("el código no se ejecuta como HTML: <script> queda como texto", () => {
        const html = toHtml("```html\n<script>alert(1)</script>\n```", "markdown");
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("<script>");
    });

    it("un bloque sin cierre toma el resto como código, sin perder líneas", () => {
        expect(markdownToHtml("```\nx = 1\ny = 2")).toBe("<pre><code>x = 1\ny = 2</code></pre>");
    });

    it("las tabulaciones pasan a cuatro espacios", () => {
        expect(markdownToHtml("```\nif a:\n\tb()\n```")).toContain("    b()");
    });

    it.each([
        ["c#", "```c#\nint x;\n```"],
        ["un espacio antes del lenguaje", "``` python\nx = 1\n```"],
        ["atributos", "```js title=\"x\"\nlet a;\n```"],
    ])("una apertura con %s abre el bloque y el texto posterior sigue siendo Markdown", (_nombre, bloque) => {
        const html = markdownToHtml(`${bloque}\nTexto después\n\n# Título`);
        expect(html).toContain("<pre><code>");
        expect(html).toContain("<p>Texto después</p>");
        expect(html).toContain("<h3>Título</h3>");
    });

    it("modo inline (campos H5P sin <pre>): saltos con <br> y sangría con espacios no separables", () => {
        expect(markdownToHtml("```python\nif a:\n    b()\n```", "inline")).toBe("<p><code>if a:<br>&nbsp;&nbsp;&nbsp;&nbsp;b()</code></p>");
    });
});

describe("dirección de un recurso incrustado (iframe_embed)", () => {
    // Lo que el Iframe Embedder de H5P hace con `source` al cargarlo (sin entidades, porque no se admiten < > ").
    const delivered = (source: string) => encodeURI(source);

    it.each([
        ["un sitio cualquiera", "https://www.geogebra.org/calculator"],
        ["una mini-aplicación del laboratorio", `${LAB_BASE_URL}/apps/python/#c=abc`],
        ["parámetros con &", "https://example.org/app?a=1&b=2#x"],
        ["un puerto propio", "https://example.org:8443/app"],
    ])("acepta %s y llega intacta al navegador", (_nombre, url) => {
        expect(delivered(embedSource(url))).toBe(new URL(url).href);
    });

    it("una dirección con espacios codificados se guarda sin codificar y el embed la recompone", () => {
        const source = embedSource("https://example.org/a%20b/");
        expect(source).toBe("https://example.org/a b/");
        expect(delivered(source)).toBe("https://example.org/a%20b/");
    });

    it.each([
        ["http (sin TLS)", "http://example.org/"],
        ["usuario y contraseña", "https://u:p@example.org/"],
        ["javascript:", "javascript:alert(1)"],
        ["data:", "data:text/html,<script>alert(1)</script>"],
        ["dirección no válida", "no es una url"],
        ["un & codificado (%26), que el embed alteraría", "https://example.org/?q=a%26b"],
        ["un # codificado (%23), que el embed alteraría", "https://example.org/?q=a%23b"],
        ["comillas codificadas", "https://example.org/?q=%22x%22"],
        ["un enlace real de Python Tutor (lleva %3A)", "https://pythontutor.com/iframe-embed.html#code=def%20f()%3A%0A%20%20return%201&py=311"],
        ["un retorno de carro codificado (%0D)", "https://example.org/?a=%0D"],
        ["un NUL codificado (%00)", "https://example.org/?a=%00"],
    ])("rechaza %s", (_nombre, url) => {
        expect(() => embedSource(url)).toThrow(CampusError);
    });

    it("rechaza una dirección más larga que el límite", () => {
        expect(() => embedSource(`https://example.org/${"a".repeat(5600)}`)).toThrow(CampusError);
    });
});
