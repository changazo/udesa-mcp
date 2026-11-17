import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { htmlFeatures, htmlSignature, patchTableCell, structureLoss } from "../../src/write/html-patch.js";
import { comparable, markdownToHtml, textHash } from "../../src/write/text.js";
import { HORARIOS, PATCH } from "../fixtures/html-horarios.js";

/** ADR-136: edición puntual de una celda sin reconstruir el HTML; conversor Markdown con tablas e imágenes. */

function errOf(f: () => unknown): CampusError {
    try {
        f();
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("patchTableCell", () => {
    it("cambia sólo el texto de la celda: <p>, <span style> y todo el resto quedan byte a byte", () => {
        const r = patchTableCell(HORARIOS, PATCH);
        const at = HORARIOS.lastIndexOf("Martes (extraordinario)");
        expect(r.html).toBe(HORARIOS.slice(0, at) + "Miércoles" + HORARIOS.slice(at + "Martes (extraordinario)".length));
        // La otra fila con el mismo texto no se toca.
        expect(r.html.indexOf("Martes (extraordinario)")).toBe(HORARIOS.indexOf("Martes (extraordinario)"));
        expect(r.html).toContain('<td><p><span style="color: #000000;">Miércoles</span></p></td>');
        expect(r).toMatchObject({ table: { index: 1, headers: ["Clase", "Profesor", "Día", "Hora", "Enlace"] }, row: { index: 3 }, column: "Día", before: "Martes (extraordinario)", after: "Miércoles" });
        const a = htmlFeatures(HORARIOS);
        const b = htmlFeatures(r.html);
        expect({ ...b, cell_texts: [] }).toEqual({ ...a, cell_texts: [] });
        expect(b.cell_texts.filter((t, i) => t !== a.cell_texts[i])).toEqual(["Miércoles"]);
    });

    it("el texto nuevo se escapa como texto: <, >, &, comillas y Unicode nunca son marcado", () => {
        const r = patchTableCell(HORARIOS, { ...PATCH, replacement_text: `Mié <b>"x" & 'y'</b> ñ→✓` });
        expect(r.html).toContain("Mié &lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt; ñ→✓");
        expect(htmlFeatures(r.html).cell_texts).toContain(`Mié <b>"x" & 'y'</b> ñ→✓`);
        expect(htmlSignature(r.html).filter((t) => t === "<b>")).toHaveLength(0);
    });

    it("rechaza sin cambiar nada: tabla duplicada, encabezados ausentes, texto anterior distinto, fila ambigua o inexistente, columna repetida", () => {
        const cases: [string, Parameters<typeof patchTableCell>[1]][] = [
            [HORARIOS + HORARIOS, PATCH],
            [HORARIOS, { ...PATCH, headers_contain: ["Aula"] }],
            [HORARIOS, { ...PATCH, expected_text: "Jueves" }],
            [HORARIOS, { ...PATCH, row_match: { Día: "Martes (extraordinario)" } }],
            [HORARIOS, { ...PATCH, row_match: { Clase: "Práctica" } }],
            [HORARIOS, { ...PATCH, column: "Aula" }],
            [HORARIOS.replace("<td>Hora</td>", "<td>Día</td>"), PATCH],
            [HORARIOS, { ...PATCH, replacement_text: "Miércoles\nJueves" }],
            [HORARIOS, { ...PATCH, replacement_text: "Martes (extraordinario)" }],
            ["<p>Sin tablas</p>", PATCH],
        ];
        for (const [html, spec] of cases) expect(errOf(() => patchTableCell(html, spec)).code, JSON.stringify(spec)).toBe("WRITE_NOT_ALLOWED");
    });

    it("texto repartido en varios nodos o celdas combinadas: rechazo (no se puede cambiar sin tocar el formato)", () => {
        const split = HORARIOS.replace('<td><p><span style="color: #000000;">Martes (extraordinario)</span></p></td><td><span style="font-size', '<td><p>Martes <em>(extraordinario)</em></p></td><td><span style="font-size');
        expect(errOf(() => patchTableCell(split, PATCH)).message).toContain("varios nodos");
        const merged = HORARIOS.replace("<td>18:00</td>", '<td rowspan="2">18:00</td>');
        expect(errOf(() => patchTableCell(merged, PATCH)).message).toContain("combinadas");
    });

    it("encabezados en <th> dentro de <thead> también; nbsp y espacios sólo cuentan para buscar", () => {
        const html = `<table><thead><tr><th>Clase</th><th>Día</th></tr></thead><tbody><tr><td>Consultas&nbsp;</td><td>\n  Martes   (extraordinario)\n</td></tr></tbody></table>`;
        const r = patchTableCell(html, { headers_contain: ["clase", "DÍA"], row_match: { Clase: "Consultas" }, column: "Día", expected_text: "Martes (extraordinario)", replacement_text: "Miércoles" });
        expect(r.html).toBe(html.replace("Martes   (extraordinario)", "Miércoles"));
    });
});

describe("precondición y verificación estructural", () => {
    it("un cambio sólo de style o de href, con el mismo texto visible, cambia la huella del HTML (y la firma)", () => {
        // Sólo estilo: el texto comparable (lo que antes usaba la precondición) no lo nota.
        expect(comparable(HORARIOS.replace("color: #000000;", "color: #ff0000;"))).toBe(comparable(HORARIOS));
        for (const other of [HORARIOS.replace("color: #000000;", "color: #ff0000;"), HORARIOS.replace("tzg-yemr-aqq", "otro-enlace")]) {
            expect(textHash(other)).not.toBe(textHash(HORARIOS));
            expect(htmlSignature(other)).not.toEqual(htmlSignature(HORARIOS));
        }
    });

    it("la firma ignora saltos de línea y espacios que Moodle reformatea, pero no atributos", () => {
        expect(htmlSignature(HORARIOS.replace(/\n/g, "").replace("<td>Profesor</td>", "<td>  Profesor </td>"))).toEqual(htmlSignature(HORARIOS));
        expect(htmlSignature(HORARIOS.replace(' data-origen="moodle"', ""))).not.toEqual(htmlSignature(HORARIOS));
    });

    it("perder la tabla, la imagen, un enlace o estilos se detecta", () => {
        const flat = `<p><strong>Horarios</strong></p><p>| Clase | Profesor | Día |<br>| Consultas | Juan Cruz Changazo | Martes (extraordinario) |</p>`;
        expect(structureLoss(HORARIOS, flat)).toEqual(expect.arrayContaining(["1 tabla(s)", "1 imagen(es)", "2 enlace(s)", "estilos (atributo style)", "clases (atributo class)"]));
        expect(structureLoss(HORARIOS, patchTableCell(HORARIOS, PATCH).html)).toEqual([]);
    });
});

describe("conversor Markdown (ADR-136)", () => {
    it("una tabla estándar da <table> con encabezados, celdas, enlaces y alineación; nunca <p>| … |</p>", () => {
        const html = markdownToHtml("| Clase | Día | Enlace |\n|:---|:---:|---:|\n| Consultas | Martes | [Meet](https://meet.google.com/x) |");
        expect(html).toBe('<table><thead><tr><th style="text-align: left;">Clase</th><th style="text-align: center;">Día</th><th style="text-align: right;">Enlace</th></tr></thead><tbody><tr><td style="text-align: left;">Consultas</td><td style="text-align: center;">Martes</td><td style="text-align: right;"><a href="https://meet.google.com/x">Meet</a></td></tr></tbody></table>');
        expect(markdownToHtml("| a | b |\n|---|---|\n| x \\| y | z |")).toContain("<td>x | y</td>");
    });

    it("filas con barras sin la fila separadora: rechazo explícito (no un párrafo con barras)", () => {
        expect(() => markdownToHtml("| Clase | Día |\n| Consultas | Martes |")).toThrow(/fila separadora/);
        expect(markdownToHtml("a | b, una barra suelta")).toBe("<p>a | b, una barra suelta</p>");
    });

    it("una imagen Markdown es <img>, no «!» más un enlace; sólo http(s)", () => {
        expect(markdownToHtml("![ícono](https://x.test/i.png) y [link](https://a.test)")).toBe('<p><img src="https://x.test/i.png" alt="ícono"> y <a href="https://a.test">link</a></p>');
        expect(markdownToHtml("![x](javascript:alert(1))")).not.toContain("<img");
    });
});
