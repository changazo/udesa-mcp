import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { questionNames } from "../../src/write/intents/questions.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { CAT_DEFAULT, CAT_OTHER, SyntheticQuestionBank } from "../fixtures/fake-qimport.js";
import { QUIZ_CMID, SyntheticQuizzes } from "../fixtures/fake-quiz.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["import_questions"] } } });
    new SyntheticQuizzes(h.fake, h.w2);
    return { h, bank: new SyntheticQuestionBank(h.fake) };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("question_import", { course_id: COURSE, bank_course_module_id: QUIZ_CMID, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");

function file(name: string, content: string) {
    const p = join(mkdtempSync(join(tmpdir(), "campus-q-")), name);
    writeFileSync(p, content);
    return p;
}
const GIFT = "// comentario\n$CATEGORY: $course$/Ignorada\n\n::P1 suma::¿Cuánto es 2+2?{=4 ~3 ~5}\n\n::P2 capital::La capital de Francia es {=París ~Roma}.\n";

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("importar preguntas (§8.10, ADR-059)", () => {
    it("GIFT a la categoría por defecto: plan sin subir; sube y envía newfile; sin crear categorías; verificado; deshacer borra sólo las nuevas", async () => {
        const { h, bank } = await harness();
        const p = await plan(h, { file_path: file("preguntas.gift", GIFT) });
        expect((p.payload_preview as { questions: string[] }).questions).toEqual(["P1 suma", "P2 capital"]);
        expect(bank.uploaded.size).toBe(0);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const post = bank.posts.at(-1)!;
        expect(post).toMatchObject({ format: "gift", category: `${CAT_DEFAULT},6100`, matchgrades: "error", stoponerror: "1", newfile: "777001" });
        expect(post).not.toHaveProperty("catfromfile");
        expect(post).not.toHaveProperty("contextfromfile");
        expect(bank.namesIn(CAT_DEFAULT)).toEqual(["Existente 1", "P1 suma", "P2 capital"]);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(bank.namesIn(CAT_DEFAULT)).toEqual(["Existente 1"]);
    });

    it("Moodle XML a otra categoría", async () => {
        const { h, bank } = await harness();
        const xml = `<?xml version="1.0"?><quiz><question type="truefalse"><name><text>V o F 1</text></name><questiontext format="html"><text>El agua moja.</text></questiontext><answer fraction="100"><text>true</text></answer><answer fraction="0"><text>false</text></answer></question></quiz>`;
        const r = await exec(h, (await plan(h, { file_path: file("p.xml", xml), category_id: CAT_OTHER })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(bank.namesIn(CAT_OTHER)).toEqual(["V o F 1"]);
    });

    it("rechazos en el plan: nombre ya existente (Moodle duplicaría), repetido en el archivo, GIFT sin nombre, formato, categoría ajena, módulo que no es banco", async () => {
        const { h } = await harness();
        expect((await errOf(plan(h, { file_path: file("a.gift", "::Existente 1::x{T}") }))).message).toMatch(/duplicaría/);
        expect((await errOf(plan(h, { file_path: file("b.gift", "::A::x{T}\n\n::A::y{F}") }))).message).toMatch(/repetidos/);
        expect((await errOf(plan(h, { file_path: file("c.gift", "¿sin nombre?{T}") }))).message).toMatch(/nombre/);
        expect((await errOf(plan(h, { file_path: file("d.csv", "x") }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, { file_path: file("e.gift", GIFT), category_id: 4242 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, { file_path: file("f.gift", GIFT), bank_course_module_id: 123456 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("error de Moodle al importar → rechazado y se limpia el borrador", async () => {
        const { h, bank } = await harness();
        bank.failImport = true;
        const r = await exec(h, (await plan(h, { file_path: file("g.gift", GIFT) })).plan_id);
        expect(r.status).toBe("rechazado_por_moodle");
        expect(h.fake.callsOf("core_files_delete_draft_files")).toHaveLength(1);
    });

    it("nombres GIFT con escapes y sin categorías", () => {
        expect(questionNames("::Uno\\: dos::texto{T}\n\n$CATEGORY: x\n\n::Tres::t{F}", "gift")).toEqual(["Uno: dos", "Tres"]);
    });
});
