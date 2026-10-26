import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import { ASSIGN, COURSE, OTHER_COURSE, OTHER_DISCUSSION, STUDENT_A } from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

async function moduleRef() {
    const h = await makeHarness();
    const course = await h.app.service.getCourse(COURSE);
    const ref = course.data.sections[0]!.modules.find((m) => m.course_module_id === 9003)!.files.find((f) => f.name === "consigna.txt")!.ref;
    return { h, ref };
}

describe("file_ref como localizador corto y sin estado", () => {
    it("es corta, legible y no contiene URL ni secretos", async () => {
        const { ref } = await moduleRef();
        expect(ref).toMatch(/^file_m\.4242\.9003\.[0-9a-f]{8}$/);
        expect(ref.length).toBeLessThan(40);
    });

    it("otra instancia, sin memoria compartida, la resuelve contra Moodle (caso Vercel)", async () => {
        const { ref } = await moduleRef();
        const fresh = await makeHarness();
        const r = await fresh.app.service.readFile({ file_ref: ref });
        expect(r.data.text).toBe("Consigna sintética: entregar el TP.");
    });

    it("localizadores manipulados se rechazan sin exponer nada", async () => {
        const { h, ref } = await moduleRef();
        const hash = ref.split(".").at(-1)!;
        expect(await codeOf(h.app.service.readFile({ file_ref: `file_m.${OTHER_COURSE}.9003.${hash}` }))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.readFile({ file_ref: `file_m.${COURSE}.123456.${hash}` }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.readFile({ file_ref: `file_m.${COURSE}.9003.00000000` }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.readFile({ file_ref: "file_inventado" }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.readFile({ file_ref: `file_m.${COURSE}.9003.1.2.${hash}` }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("entrega: un participante ajeno a la tarea no se resuelve", async () => {
        const h = await makeHarness();
        const sub = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A });
        const ref = sub.data.files[0]!.ref;
        expect(ref).toMatch(new RegExp(`^file_s\\.${COURSE}\\.${ASSIGN}\\.${STUDENT_A}\\.[0-9a-f]{8}$`));
        const forged = ref.replace(`.${STUDENT_A}.`, ".999.");
        expect(await codeOf(h.app.service.readFile({ file_ref: forged }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("post: una discusión de otro curso no se resuelve aunque el curso declarado sea válido", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.readFile({ file_ref: `file_p.${COURSE}.${OTHER_DISCUSSION}.9100.00000000` }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });
});
