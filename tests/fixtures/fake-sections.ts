/**
 * Secciones sintéticas CON ESTADO: section_add (al final) y section_delete (con sus actividades)
 * sobre la estructura de SyntheticW2. Trampas reales: la respuesta de section_add trae el estado de
 * TODAS las secciones (la primera es la 0), y section_delete renumera las siguientes.
 */
import type { FakeMoodle } from "./fake-moodle.js";
import type { SyntheticW2 } from "./fake-w2.js";

export class SyntheticSections {
    /** Moodle «salta» el borrado sin error (course_can_delete_section falso). */
    skipDelete = false;
    private seq = 700;

    constructor(fake: FakeMoodle, w2: SyntheticW2) {
        const prev = fake.web.ajax.get("core_courseformat_update_course")!;
        fake.web.ajax.set("core_courseformat_update_course", (args) => {
            if (args.action === "section_add") {
                const n = Math.max(...w2.sections.map((s) => s.section)) + 1;
                w2.sections.push({ id: this.seq++, section: n, name: "Nueva sección", visible: true });
                return JSON.stringify(w2.sections.map((s) => ({ name: "section", action: "put", fields: { id: s.id, number: s.section } })));
            }
            if (args.action === "section_delete") {
                const id = (args.ids as number[])[0];
                const i = w2.sections.findIndex((s) => s.id === id);
                if (i < 0 || this.skipDelete) return "[]";
                const num = w2.sections[i]!.section;
                if (num === 0) return "[]";
                w2.sections.splice(i, 1);
                for (let k = w2.extraModules.length - 1; k >= 0; k--) if (w2.extraModules[k]!.section === num) w2.extraModules.splice(k, 1);
                for (let k = w2.assignments.length - 1; k >= 0; k--) if (w2.assignments[k]!.section === num) w2.assignments.splice(k, 1);
                for (const s of w2.sections) if (s.section > num) s.section--;
                for (const m of w2.extraModules) if (m.section > num) m.section--;
                for (const a of w2.assignments) if (a.section > num) a.section--;
                return "[]";
            }
            return prev(args);
        });
    }
}
