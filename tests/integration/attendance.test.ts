import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import { ATT_SESSION, COURSE, OTHER_COURSE, STUDENT_A, STUDENT_B, STUDENT_C, TEACH_COURSE_2 } from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("asistencia", () => {
    it("trae el registro por alumno de la sesión de la ventana y el resumen del libro", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getAttendance({ course_id: COURSE });
        const act = r.data.activities[0]!;
        expect(act.course_module_id).toBe(9403);
        const s = act.sessions_in_window[0]!;
        expect(s).toMatchObject({ session_id: ATT_SESSION, time_text: "lun 3 ago, 9:00 - 10:30", group: "Comisión A", taken: true });
        expect(s.records).toEqual([
            { participant_id: STUDENT_A, name: "Ana Sintética", status: "P" },
            { participant_id: STUDENT_B, name: "Beto & Cía", status: "A" },
            { participant_id: STUDENT_C, name: "Caro Sintética", status: null },
        ]);
        expect(s.counts).toEqual({ P: 1, A: 1, "sin registrar": 1 });
        const gb = r.data.gradebook_summary[0]!;
        expect(gb.name).toBe("Asistencia");
        expect(gb.students.map((x) => x.value)).toEqual([90, 50]);
        expect(r.coverage.complete).toBe(true);
        expect(r.warnings.join(" ")).toContain("include_history");
    });

    it("nunca envía argumentos que tomen asistencia", async () => {
        const h = await makeHarness();
        await h.app.service.getAttendance({ course_id: COURSE });
        expect(h.fake.mobileArgs.length).toBe(2);
        for (const a of h.fake.mobileArgs) expect(Object.keys(a).filter((k) => /^status/.test(k))).toEqual([]);
        expect(h.fake.mobileArgs[1]).toMatchObject({ sessid: String(ATT_SESSION) });
    });

    it("un curso sin actividad de asistencia lo dice, sin llamar a la app móvil", async () => {
        const h = await makeHarness({ profile: { allowed_course_ids: [COURSE, TEACH_COURSE_2] } });
        const r = await h.app.service.getAttendance({ course_id: TEACH_COURSE_2 });
        expect(r.data.activities).toEqual([]);
        expect(r.warnings.join(" ")).toContain("no tiene una actividad de Asistencia");
        expect(h.fake.mobileArgs).toHaveLength(0);
    });

    it("con una allowlist, un curso donde la cuenta no es docente se rechaza antes de la app móvil (podría autoregistrar asistencia)", async () => {
        const h = await makeHarness({ profile: { allowed_course_ids: [COURSE, OTHER_COURSE] } });
        expect(await codeOf(h.app.service.getAttendance({ course_id: OTHER_COURSE }))).toBe("POLICY_DENIED");
        expect(h.fake.mobileArgs).toHaveLength(0);
        // En un curso con rol docente, la lectura sigue.
        await expect(h.app.service.getAttendance({ course_id: COURSE })).resolves.toBeTruthy();
    });

    it("un curso fuera del perfil se rechaza", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getAttendance({ course_id: OTHER_COURSE }))).toBe("POLICY_DENIED");
    });
});
