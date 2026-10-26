import { afterEach, describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { FakeLtiTools } from "../fixtures/fake-lti.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-117: herramienta LTI del laboratorio y actividad con ejercicio de Python. Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content"] } } });
    return { h, acts: new SyntheticActivities(h.fake, h.w2), lti: new FakeLtiTools(h.fake.web) };
}
const run = async (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test")).plan_id, h.confirmer, "test");
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}
const EX = { title: "Promedio", statement: "Escribí `promedio(xs)`.", function_name: "promedio", tests: [{ input: "[2, 4]", expected: "3.0" }, { input: "[1]", expected: "1.0", hidden: true }] };

const SECRET = "secreto-de-prueba-inventado";

describe("laboratorio LTI (ADR-117)", () => {
    afterEach(() => {
        delete process.env.CAMPUS_LAB_LTI11_SECRET;
    });

    it("LTI 1.1 por defecto: clave fija y secreto del entorno al enviar, que nunca figura en el plan ni en el resultado", async () => {
        const { h, lti } = await harness();
        expect((await errOf(h.app.engine.plan("lab_lti_tool", { course_id: COURSE }, "test"))).message).toMatch(/CAMPUS_LAB_LTI11_SECRET/);
        process.env.CAMPUS_LAB_LTI11_SECRET = SECRET;
        const plan = await h.app.engine.plan("lab_lti_tool", { course_id: COURSE }, "test");
        expect(JSON.stringify(plan)).not.toContain(SECRET);
        const r = await h.app.engine.execute(plan.plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(JSON.stringify(r)).not.toContain(SECRET);
        expect(lti.tools.at(-1)!.fields).toMatchObject({ lti_typename: "Laboratorio UdeSA", lti_ltiversion: "LTI-1p0", lti_toolurl: "https://udesa-campus-lab.vercel.app/api/lti/launch11", lti_resourcekey: "udesa-lab", lti_password: SECRET, lti_sendname: "0", lti_sendemailaddr: "0", lti_acceptgrades: "1" });
        expect(r.moodle_ids.typeid).toEqual([188]);
    });

    it("LTI 1.3: registra la herramienta con URLs fijas, sin nombre ni correo, y da el ID de cliente para el laboratorio", async () => {
        const { h, lti } = await harness();
        const r = await run(h, "lab_lti_tool", { lti_version: "1.3" });
        expect(r.status).toBe("aplicado_verificado");
        const t = lti.tools.at(-1)!;
        expect(t.fields).toMatchObject({ lti_typename: "Laboratorio UdeSA", lti_ltiversion: "1.3.0", lti_keytype: "JWK_KEYSET", lti_toolurl: "https://udesa-campus-lab.vercel.app/api/lti/launch", lti_publickeyset: "https://udesa-campus-lab.vercel.app/api/lti/jwks", lti_initiatelogin: "https://udesa-campus-lab.vercel.app/api/lti/login", lti_sendname: "0", lti_sendemailaddr: "0", ltiservice_gradesynchronization: "1" });
        expect(r.moodle_ids.typeid).toEqual([188]);
        expect(JSON.stringify(r)).toContain("cli188:188");
        expect((await errOf(h.app.engine.plan("lab_lti_tool", { course_id: COURSE }, "test"))).message).toMatch(/ya tiene/);
    });

    it("actividad LTI: herramienta del curso, consigna en parámetros, nota por puntos, oculta; deshacer la borra; sin herramienta se rechaza", async () => {
        const { h, acts } = await harness();
        expect((await errOf(h.app.engine.plan("lab_lti_exercise", { course_id: COURSE, section: 1, name: "Ej", exercise: EX }, "test"))).message).toMatch(/registrala antes/);
        await run(h, "lab_lti_tool", { lti_version: "1.3" });
        const r = await run(h, "lab_lti_exercise", { section: 1, name: "Ejercicio: promedio", max_grade: 20, exercise: EX });
        expect(r.status).toBe("aplicado_verificado");
        const m = [...acts.mods.values()].find((x) => x.kind === "lti")!;
        expect(m).toMatchObject({ name: "Ejercicio: promedio", visible: false, lti: { typeid: 188, grade: 20, acceptgrades: true } });
        const cfg = JSON.parse(Buffer.from(m.lti!.custom.replace(/^ejercicio=/, ""), "base64url").toString("utf8"));
        expect(cfg).toMatchObject({ function_name: "promedio", tests: [{ args: "[2, 4]", expected: "3.0" }, { args: "[1]", expected: "1.0", hidden: true }] });
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await h.app.engine.execute(u.plan.plan_id, h.confirmer, "test")).status).toBe("aplicado_verificado");
    });
});
