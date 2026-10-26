import { describe, expect, it } from "vitest";
import { buildPackage, ContentFactory, defaultsOf, type SemField, translate, validateParams } from "../../src/h5p/semantics.js";
import { readZip, writeZip } from "../../src/h5p/zip.js";

/** ADR-110: semántica, validación y paquete H5P con una biblioteca inventada. */
const PARENT: SemField[] = [
    { name: "title", type: "text" },
    { name: "mode", type: "select", options: [{ value: "a" }, { value: "b" }], default: "a" },
    { name: "single", type: "group", fields: [{ name: "only", type: "text", default: "x" }] },
    { name: "texts", type: "group", fields: [{ name: "next", type: "text", default: "Next" }, { name: "back", type: "text", default: "Back" }] },
    { name: "items", type: "list", max: 2, field: { name: "item", type: "library", options: ["H5P.Child 1.2"] } },
    { name: "color", type: "text", optional: true, default: null },
];
const CHILD: SemField[] = [{ name: "text", type: "text" }];
const sem = (l: string) => ({ "H5P.Parent 1.0": PARENT, "H5P.Child 1.2": CHILD })[l];

describe("semántica H5P (ADR-110)", () => {
    it("valores por defecto: grupos de un solo campo se aplanan; traducción superpuesta", () => {
        expect(defaultsOf(PARENT)).toEqual({ mode: "a", single: "x", texts: { next: "Next", back: "Back" }, items: [], color: null });
        const es = translate(PARENT, [{}, {}, {}, { fields: [{ default: "Siguiente" }, { label: "Atrás" }] }]);
        expect(defaultsOf(es).texts).toEqual({ next: "Siguiente", back: "Back" });
    });

    it("validación: campo desconocido, select fuera de opciones, subbiblioteca no admitida, máximo de lista, falta de texto", () => {
        const f = new ContentFactory(sem);
        expect(validateParams("H5P.Parent 1.0", f.params("H5P.Parent 1.0", { title: "T", items: [f.lib("H5P.Child 1.2", { text: "hola" }, "c")] }), sem)).toEqual([]);
        const bad = { title: "T", mode: "z", extra: 1, items: [{ library: "H5P.Other 1.0", params: {} }, f.lib("H5P.Child 1.2", { text: 5 }, "c"), f.lib("H5P.Child 1.2", {}, "c")] };
        const errs = validateParams("H5P.Parent 1.0", bad as never, sem).join(" | ");
        expect(errs).toMatch(/extra: campo desconocido/);
        expect(errs).toMatch(/mode: valor "z" no admitido/);
        expect(errs).toMatch(/H5P.Other 1.0 no está entre las bibliotecas admitidas/);
        expect(errs).toMatch(/items: como mucho 2/);
        expect(errs).toMatch(/<H5P.Child>.text: se esperaba texto/);
        expect(errs).toMatch(/items\[2\]<H5P.Child>.text: falta/);
    });

    it("versiones de subbibliotecas desde el padre; semánticas faltantes se anotan", () => {
        const f = new ContentFactory(sem);
        expect(f.option("H5P.Parent 1.0", ["items"], "H5P.Child")).toBe("H5P.Child 1.2");
        expect(() => f.option("H5P.Parent 1.0", ["items"], "H5P.Nope")).toThrow(/no admite H5P.Nope/);
        const g = new ContentFactory(() => undefined);
        g.lib(g.option("H5P.Parent 1.0", ["items"], "H5P.Child"), {}, "x");
        expect([...g.missing]).toEqual(["H5P.Parent 1.0"]);
    });

    it("paquete: sólo h5p.json y content.json, dependencias de los subcontenidos; ZIP legible", () => {
        const f = new ContentFactory(sem);
        const { data, libraries } = buildPackage("H5P.Parent 1.0", f.params("H5P.Parent 1.0", { title: "T", items: [f.lib("H5P.Child 1.2", { text: "a" }, "c")] }), "Título");
        expect(libraries).toEqual(["H5P.Parent 1.0", "H5P.Child 1.2"]);
        const z = readZip(data);
        expect([...z.keys()]).toEqual(["h5p.json", "content/content.json"]);
        expect(JSON.parse(z.get("h5p.json")!.toString()).preloadedDependencies).toEqual([{ machineName: "H5P.Parent", majorVersion: 1, minorVersion: 0 }, { machineName: "H5P.Child", majorVersion: 1, minorVersion: 2 }]);
        expect(readZip(writeZip([["ñ.txt", "año"]])).get("ñ.txt")!.toString()).toBe("año");
    });
});
