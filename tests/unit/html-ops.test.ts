import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { renderComponent, ComponentSchema } from "../../src/write/components.js";
import { addRow, deleteRow, insertFragment, patchCells, replaceLinks } from "../../src/write/html-ops.js";
import { htmlFeatures, htmlSignature } from "../../src/write/html-patch.js";
import { HORARIOS } from "../fixtures/html-horarios.js";

/** ADR-137 y ADR-138: operaciones en el lugar y componentes con esquema cerrado. */

const H = ["Clase", "Profesor", "Día"];
function errOf(f: () => unknown): CampusError {
    try {
        f();
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("celdas", () => {
    it("varias celdas en un solo cambio; nada más se toca", () => {
        const r = patchCells(HORARIOS, H, [
            { row_match: { Clase: "Consultas" }, column: "Día", expected_text: "Martes (extraordinario)", replacement_text: "Miércoles" },
            { row_match: { Clase: "Consultas" }, column: "Hora", expected_text: "19:00 a 20:30", replacement_text: "18:00 a 19:30" },
        ]);
        expect(r.html).toBe(HORARIOS.replace('<span style="color: #000000;">Martes (extraordinario)</span></p></td><td><span style="font-size: 0.9rem;">19:00 a 20:30', '<span style="color: #000000;">Miércoles</span></p></td><td><span style="font-size: 0.9rem;">18:00 a 19:30'));
        expect(r.changes.map((c) => [c.column, c.before, c.after])).toEqual([["Día", "Martes (extraordinario)", "Miércoles"], ["Hora", "19:00 a 20:30", "18:00 a 19:30"]]);
        expect(errOf(() => patchCells(HORARIOS, H, [r.changes[0]!, r.changes[0]!].map(() => ({ row_match: { Clase: "Consultas" }, column: "Día", expected_text: "Martes (extraordinario)", replacement_text: "X" })))).message).toContain("misma celda");
    });
});

describe("filas", () => {
    it("agregar una fila copia el formato de la fila modelo (span con estilo, enlace) con los textos nuevos", () => {
        const r = addRow(HORARIOS, H, { Clase: "Práctica", Profesor: "Beto Sintético", Día: "Jueves", Hora: "10:00", Enlace: "Meet" }, { Clase: "Consultas" });
        const f0 = htmlFeatures(HORARIOS);
        const f1 = htmlFeatures(r.html);
        expect(f1.rows).toBe(f0.rows + 1);
        expect(f1.cell_texts.slice(-5)).toEqual(["Práctica", "Beto Sintético", "Jueves", "10:00", "Meet"]);
        expect(r.html).toContain('<td><p><span style="color: #000000;">Jueves</span></p></td>');
        // La fila nueva conserva el enlace de la modelo: el agente tiene que cambiarlo aparte si corresponde.
        expect(f1.links.filter((l) => l.includes("tzg-yemr-aqq"))).toHaveLength(2);
        // Todo lo anterior queda igual: la firma nueva es la vieja con la fila intercalada.
        expect(htmlSignature(r.html).length).toBeGreaterThan(htmlSignature(HORARIOS).length);
        expect(r.html.startsWith(HORARIOS.slice(0, HORARIOS.indexOf("</tr>\n</tbody>")))).toBe(true);
    });

    it("columnas omitidas quedan vacías; celda vacía de la modelo recibe el texto; sin valores o columna inexistente: rechazo", () => {
        const html = "<table><tbody><tr><td>Clase</td><td>Día</td></tr><tr><td>Teórica</td><td><p></p></td></tr></tbody></table>";
        expect(addRow(html, ["Clase", "Día"], { Día: "Lunes" }).html).toBe("<table><tbody><tr><td>Clase</td><td>Día</td></tr><tr><td>Teórica</td><td><p></p></td></tr><tr><td></td><td><p>Lunes</p></td></tr></tbody></table>");
        expect(errOf(() => addRow(html, ["Clase", "Día"], {})).code).toBe("WRITE_NOT_ALLOWED");
        expect(errOf(() => addRow(html, ["Clase", "Día"], { Aula: "3" })).code).toBe("WRITE_NOT_ALLOWED");
    });

    it("quitar una fila deja todo lo demás; la de encabezados o una ambigua no se quita", () => {
        const r = deleteRow(HORARIOS, H, { Clase: "Teórica" });
        expect(r.deleted_row.cells[0]).toBe("Teórica");
        expect(htmlFeatures(r.html).rows).toBe(htmlFeatures(HORARIOS).rows - 1);
        expect(r.html).not.toContain("Teórica");
        expect(r.html).toContain("Consultas");
        expect(errOf(() => deleteRow(HORARIOS, H, { Clase: "Clase" })).code).toBe("WRITE_NOT_ALLOWED");
        expect(errOf(() => deleteRow(HORARIOS, H, { Día: "Martes (extraordinario)" })).message).toContain("2 filas");
    });
});

describe("enlaces", () => {
    it("cambia sólo el href exacto (y el texto si era la dirección); informa menciones sueltas", () => {
        const html = '<p><a href="https://meet.google.com/old" target="_blank" class="x">Meet</a> y <a href="https://meet.google.com/old">https://meet.google.com/old</a>. Texto: https://meet.google.com/old</p><p><a href="https://meet.google.com/old-2">otro</a></p>';
        const r = replaceLinks(html, "https://meet.google.com/old", "https://meet.google.com/new?a=1&b=2");
        expect(r.hits.map((h) => h.text_replaced)).toEqual([false, true]);
        expect(r.plain_text_mentions).toBe(1);
        expect(r.html).toBe('<p><a href="https://meet.google.com/new?a=1&amp;b=2" target="_blank" class="x">Meet</a> y <a href="https://meet.google.com/new?a=1&amp;b=2">https://meet.google.com/new?a=1&amp;b=2</a>. Texto: https://meet.google.com/old</p><p><a href="https://meet.google.com/old-2">otro</a></p>');
        expect(replaceLinks(html, "https://no.example/", "https://x.example/").hits).toHaveLength(0);
    });
});

describe("componentes", () => {
    const parse = (c: unknown) => renderComponent(ComponentSchema.parse(c));

    it("cada componente da HTML cerrado con las clases del tema y declara qué tiene que verse", () => {
        expect(parse({ type: "alert", variant: "warning", title: "Importante", body: "Entrega el **viernes**." }).html).toBe('<div class="alert alert-warning" role="alert"><p><strong>Importante</strong></p><p>Entrega el <strong>viernes</strong>.</p></div>');
        expect(parse({ type: "button", text: "Ir al Meet", href: "https://meet.google.com/x" }).html).toBe('<p><a class="btn btn-primary" href="https://meet.google.com/x">Ir al Meet</a></p>');
        expect(parse({ type: "details", summary: "Ver respuesta", body: "42" }).display.map((d) => d.tag)).toEqual(["details", "summary"]);
        expect(parse({ type: "columns", left: "A", right: "B" }).html).toBe('<div class="row"><div class="col-md-6"><p>A</p></div><div class="col-md-6"><p>B</p></div></div>');
        expect(parse({ type: "table", headers: ["Clase", "Día"], rows: [["Consultas", "Miércoles"]] }).html).toBe('<table class="table table-striped"><thead><tr><th scope="col">Clase</th><th scope="col">Día</th></tr></thead><tbody><tr><td>Consultas</td><td>Miércoles</td></tr></tbody></table>');
        expect(parse({ type: "video", youtube_url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", title: "Clase 1" }).html).toContain('src="https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"');
        expect(parse({ type: "card", title: "TP1", body: "Consigna", link: { text: "Abrir", href: "https://campus.example/tp1" } }).display).toHaveLength(3);
    });

    it("los textos se escapan; enlaces sólo http(s)/mailto; videos sólo de YouTube", () => {
        const a = parse({ type: "alert", body: '<script>alert(1)</script> "x"' }).html;
        expect(a).not.toContain("<script>");
        expect(a).toContain("&lt;script&gt;");
        expect(errOf(() => parse({ type: "button", text: "x", href: "javascript:alert(1)" })).code).toBe("WRITE_NOT_ALLOWED");
        expect(errOf(() => parse({ type: "video", youtube_url: "https://evil.example/watch?v=aqz-KE-bpKQ", title: "x" })).code).toBe("WRITE_NOT_ALLOWED");
        expect(() => ComponentSchema.parse({ type: "html", html: "<b>x</b>" })).toThrow();
    });

    it("insertar al final o al principio no toca el resto", () => {
        const c = parse({ type: "alert", body: "Aviso" }).html;
        expect(insertFragment(HORARIOS, c, "end")).toBe(`${HORARIOS}\n${c}`);
        expect(insertFragment(HORARIOS, c, "start")).toBe(`${c}\n${HORARIOS}`);
        expect(insertFragment("", c, "end")).toBe(c);
    });
});
