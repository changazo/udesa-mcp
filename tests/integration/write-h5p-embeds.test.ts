import { beforeEach, describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { clearH5pCache } from "../../src/h5p/editor.js";
import { readZip } from "../../src/h5p/zip.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { FakeH5pEditor } from "../fixtures/fake-h5p.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * iframe_embed sobre H5P.IFrameEmbed, y bloques de código en las
 * preguntas. Semánticas reales de la instalación examinada, contenido inventado.
 */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content", "edit_activity"] } } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    const editor = new FakeH5pEditor(h.fake.web);
    const uploaded: File[] = [];
    const orig = h.fake.upload!;
    h.fake.upload = (form) => {
        for (const [k, v] of form.entries()) if (k.startsWith("file_")) uploaded.push(v as File);
        return orig(form);
    };
    return { h, acts, editor, uploaded };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("h5p_content", { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
async function packageOf(f: File) {
    const zip = readZip(Buffer.from(await f.arrayBuffer()));
    return { content: JSON.parse(zip.get("content/content.json")!.toString("utf8")) as Record<string, unknown> };
}
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

const FENCED_QUESTION = "¿Qué imprime?\n\n```python\nfor n in lista:\n    if n > 0:\n        print(n)\n```";

beforeEach(() => clearH5pCache());

describe("iframe_embed (H5P.IFrameEmbed)", () => {
    it("cualquier página https: el paquete guarda la dirección y el plan advierte que la controla otro sitio", async () => {
        const { h, uploaded } = await harness();
        const p = await plan(h, { operation: "create", section: 1, name: "Simulador", content: { type: "iframe_embed", source_url: "https://example.org/sim?nivel=1&modo=a", height_px: 600 } });
        expect(p.warnings.join(" ")).toContain("Incrusta una página de https://example.org");
        expect(p.warnings.join(" ")).toContain("no recibe la identidad del estudiante");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const c = (await packageOf(uploaded[0]!)).content as { source: string; height: string };
        expect(c).toMatchObject({ source: "https://example.org/sim?nivel=1&modo=a", height: "600px" });
    });

    it("una dirección http se rechaza antes de crear nada", async () => {
        const { h, acts } = await harness();
        const e = await errOf(plan(h, { operation: "create", section: 1, name: "Externo", content: { type: "iframe_embed", source_url: "http://example.org/app/" } }));
        expect(e.code).toBe("WRITE_NOT_ALLOWED");
        expect(acts.mods.size).toBe(0);
    });
});

describe("bloques de código en H5P (FMT-01)", () => {
    it("pregunta de opción múltiple: el enunciado con código cercado llega como <pre><code> con la sangría", async () => {
        const { h, uploaded } = await harness();
        const r = await exec(h, (await plan(h, { operation: "create", section: 1, name: "Repaso: lista", content: { type: "question_set", questions: [{ kind: "multiple_choice", question: FENCED_QUESTION, answers: [{ text: "Imprime los positivos", correct: true }, { text: "Nada", correct: false }] }] } })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const json = JSON.stringify((await packageOf(uploaded[0]!)).content);
        expect(json).toContain("<pre><code>for n in lista:\\n    if n &gt; 0:\\n        print(n)</code></pre>");
        expect(json).not.toContain("```");
    });

    it("campo sin <pre> verificado (introducción del Question Set): degrada a <code> en línea, sin <pre>", async () => {
        const { h, uploaded } = await harness();
        const r = await exec(h, (await plan(h, { operation: "create", section: 1, name: "Repaso: intro", content: { type: "question_set", intro: { title: "Repaso", text: "```\nx = 1\n```" }, questions: [{ kind: "true_false", question: "x vale 1.", correct: true }] } })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const json = JSON.stringify((await packageOf(uploaded[0]!)).content);
        expect(json).toContain("<p><code>x = 1</code></p>");
        expect(json).not.toContain("<pre>");
    });
});
