import { describe, expect, it } from "vitest";
import { inventory } from "../../src/write/intents/delete-content.js";

/** ADR-118: lo que se borra, contado para que la pregunta al usuario sea concreta. Datos inventados. */
describe("inventario de un borrado", () => {
    it("cuenta elementos por tipo y archivos con su tamaño total", () => {
        const inv = inventory([
            { modname: "resource", contents: [{ type: "file", filesize: 2 * 1024 * 1024 }] },
            { modname: "folder", contents: [{ type: "file", filesize: 600 * 1024 }, { type: "file", filesize: 500 * 1024 }] },
            { modname: "assign", contents: [] },
            { modname: "label", contents: [] },
            { modname: "url", contents: [{ type: "url" }] },
        ]);
        expect(inv.types).toBe("1 archivo, 1 carpeta, 1 tarea, 1 etiqueta, 1 enlace");
        expect(inv.files).toBe(3);
        expect(inv.text).toBe("3 archivo(s) adjunto(s), 3,1 MB en total");
        expect(inventory([{ modname: "page", contents: [] }]).text).toBe("sin archivos adjuntos");
    });
});
