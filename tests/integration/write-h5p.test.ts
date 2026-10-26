import { beforeEach, describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { clearH5pCache, offeredLibraries } from "../../src/h5p/editor.js";
import { readZip } from "../../src/h5p/zip.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { FakeH5pEditor } from "../fixtures/fake-h5p.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-110: contenido H5P generado por el MCP. Semánticas reales, contenido inventado. */
async function harness(opts: { remote?: boolean } = {}) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content", "edit_activity"] } }, ...opts });
    const acts = new SyntheticActivities(h.fake, h.w2);
    const editor = new FakeH5pEditor(h.fake.web);
    // Guarda los bytes subidos al borrador (el paquete generado).
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
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}
async function packageOf(f: File) {
    const zip = readZip(Buffer.from(await f.arrayBuffer()));
    return { h5p: JSON.parse(zip.get("h5p.json")!.toString("utf8")), content: JSON.parse(zip.get("content/content.json")!.toString("utf8")), names: [...zip.keys()] };
}

const MC = { kind: "multiple_choice", question: "¿Qué pasa con el **precio**?", answers: [{ text: "Sube <rápido>", correct: true, feedback: "Bien" }, { text: "Baja", correct: false }] };
const TF = { kind: "true_false", question: "La oferta sube con el precio.", correct: true };
const DW = { kind: "drag_words", task: "Arrastrá.", text: "El *precio* sube.", distractors: ["costo"] };
const FB = { kind: "fill_blanks", lines: ["Un bien *inferior* baja con el ingreso.", "Son *sustitutos/reemplazos*."] };

beforeEach(() => clearH5pCache());

describe("contenido H5P generado (ADR-110)", () => {
    it("Question Set: plan R1 sin escribir, paquete sin bibliotecas con defaults en castellano; alta verificada por el paquete; deshacer lo borra", async () => {
        const { h, acts, editor, uploaded } = await harness();
        const p = await plan(h, { operation: "create", section: 1, name: "Repaso: oferta", content: { type: "question_set", intro: { title: "Repaso", text: "Cuatro preguntas." }, questions: [MC, TF, DW, FB] } });
        expect(p.risk).toBe("R1");
        expect(editor.requests).toEqual(["group:" + COURSE, "contentbank:7777", "editor:H5P.QuestionSet 1.21", "libraries", "library:H5P.QuestionSet 1.21", "library:H5P.MultiChoice 1.16", "library:H5P.TrueFalse 1.8", "library:H5P.DragText 1.10", "library:H5P.Blanks 1.14"]);
        expect((p.payload_preview as { h5p: { libraries: string[] } }).h5p.libraries).toEqual(["H5P.QuestionSet 1.21", "H5P.Blanks 1.14", "H5P.DragText 1.10", "H5P.MultiChoice 1.16", "H5P.TrueFalse 1.8"]);
        expect(acts.mods.size).toBe(0);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const m = [...acts.mods.values()][0]!;
        expect(m).toMatchObject({ kind: "h5pactivity", name: "Repaso: oferta", visible: false });
        const pkg = await packageOf(uploaded[0]!);
        expect(uploaded[0]!.name).toBe("repaso-oferta.h5p");
        expect(pkg.names.sort()).toEqual(["content/content.json", "content/mcp-spec.json", "h5p.json"]); // ADR-114: el esquema viaja en el paquete
        expect(pkg.h5p).toMatchObject({ mainLibrary: "H5P.QuestionSet", language: "es" });
        expect(pkg.h5p.preloadedDependencies[0]).toEqual({ machineName: "H5P.QuestionSet", majorVersion: 1, minorVersion: 21 });
        const c = pkg.content;
        expect(c.introPage).toMatchObject({ showIntroPage: true, title: "Repaso" });
        expect(c.texts.finishButton).toBe("Terminar"); // traducción del Campus
        expect(c.questions.map((q: { library: string }) => q.library)).toEqual(["H5P.MultiChoice 1.16", "H5P.TrueFalse 1.8", "H5P.DragText 1.10", "H5P.Blanks 1.14"]);
        expect(c.questions[0].params.question).toContain("<strong>precio</strong>");
        expect(c.questions[0].params.answers[0]).toMatchObject({ text: "<div>Sube &lt;rápido&gt;</div>", correct: true, tipsAndFeedback: { chosenFeedback: "<div>Bien</div>" } });
        expect(c.questions[0].subContentId).toMatch(/^[0-9a-f-]{36}$/);
        expect(c.questions[1].params.correct).toBe("true");
        expect(c.questions[2].params).toMatchObject({ textField: "El *precio* sube.", distractors: "*costo*" });
        expect(c.questions[3].params.questions).toEqual(["<p>Un bien *inferior* baja con el ingreso.</p>", "<p>Son *sustitutos/reemplazos*.</p>"]);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
    });

    it("Course Presentation, Interactive Book e Interactive Video: estructura y versiones de las subbibliotecas", async () => {
        const { h, uploaded } = await harness();
        await exec(h, (await plan(h, { operation: "create", section: 1, name: "Presentación", content: { type: "course_presentation", slides: [{ title: "Inicio", blocks: [{ kind: "text", markdown: "# Hola" }] }, { blocks: [{ kind: "text", markdown: "Pregunta:" }, MC] }] } })).plan_id);
        const cp = (await packageOf(uploaded[0]!)).content;
        expect(cp.presentation.slides).toHaveLength(2);
        expect(cp.presentation.slides[0].keywords).toEqual([{ main: "Inicio" }]);
        expect(cp.presentation.slides[0].elements[0].action.params.text).toBe("<h2>Hola</h2>"); // H5P sólo admite h2 y h3
        expect(cp.presentation.slides[1].elements.map((e: { y: number; height: number; action: { library: string } }) => [e.y, e.height, e.action.library])).toEqual([[4, 44, "H5P.AdvancedText 1.1"], [52, 44, "H5P.MultiChoice 1.16"]]);

        await exec(h, (await plan(h, { operation: "create", section: 1, name: "Libro", content: { type: "interactive_book", cover: "Un libro", chapters: [{ title: "La demanda", blocks: [{ kind: "text", markdown: "Texto" }, TF] }] } })).plan_id);
        const ib = (await packageOf(uploaded[1]!)).content;
        expect(ib.showCoverPage).toBe(true);
        expect(ib.chapters[0]).toMatchObject({ library: "H5P.Column 1.22", metadata: { title: "La demanda" } });
        expect(ib.chapters[0].params.content[1]).toMatchObject({ useSeparator: "auto", content: { library: "H5P.TrueFalse 1.8" } });

        const iv = { type: "interactive_video", video_url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", interactions: [{ at_seconds: 15, question: MC }, { at_seconds: 40, until_seconds: 45, question: TF, display: "button" }], bookmarks: [{ at_seconds: 0, label: "Inicio" }], summary: [{ correct: "Pausa", wrong: ["No pausa"] }] };
        expect((await exec(h, (await plan(h, { operation: "create", section: 1, name: "Video", content: iv })).plan_id)).status).toBe("aplicado_verificado");
        const v = (await packageOf(uploaded[2]!)).content.interactiveVideo;
        expect(v.video.files).toEqual([{ path: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", mime: "video/YouTube", copyright: { license: "U" } }]);
        expect(v.assets.interactions.map((i: { duration: { from: number; to: number }; displayType: string }) => [i.duration.from, i.duration.to, i.displayType])).toEqual([[15, 25, "poster"], [40, 45, "button"]]);
        expect(v.summary.task).toMatchObject({ library: "H5P.Summary 1.10", params: { summaries: [{ summary: ["<p>Pausa</p>", "<p>No pausa</p>"] }] } });
        expect(v.assets.bookmarks).toEqual([{ time: 0, label: "Inicio" }]);
    });

    it("validación contra la semántica del Campus: un campo de otra versión frena el plan; video y marcas inválidos; tipo no ofrecido", async () => {
        const { h, editor } = await harness();
        const mc = editor.semantics.get("H5P.MultiChoice 1.16")!;
        editor.semantics.set("H5P.MultiChoice 1.16", { ...mc, semantics: (mc.semantics as { name: string }[]).filter((f) => f.name !== "answers") });
        expect((await errOf(plan(h, { operation: "create", section: 1, name: "X", content: { type: "question_set", questions: [MC] } }))).message).toMatch(/no coincide con la versión instalada.*answers: campo desconocido/);
        clearH5pCache();
        editor.semantics.set("H5P.MultiChoice 1.16", mc);
        expect((await errOf(plan(h, { operation: "create", section: 1, name: "X", content: { type: "interactive_video", video_url: "https://vimeo.com/123", interactions: [] } }))).message).toMatch(/Video no admitido/);
        await expect(plan(h, { operation: "create", section: 1, name: "X", content: { type: "question_set", questions: [{ kind: "drag_words", task: "x", text: "sin marcas" }] } })).rejects.toThrow(/asteriscos/);
        editor.offered = ["H5P.QuestionSet 1.21"];
        expect((await errOf(plan(h, { operation: "create", section: 1, name: "X", content: { type: "interactive_book", chapters: [{ title: "a", blocks: [TF] }] } }))).message).toMatch(/no ofrece H5P.InteractiveBook/);
        expect((await errOf(plan(h, { operation: "create", name: "X", content: { type: "question_set", questions: [TF] } }))).message).toMatch(/section y name/);
    });

    it("replace: reemplaza el paquete de una actividad H5P (R3, sin deshacer); otra actividad se rechaza", async () => {
        const { h, acts, uploaded } = await harness();
        const m = acts.add({ kind: "h5pactivity", name: "Repaso", intro: "", files: [{ filename: "repaso.h5p", filesize: 10 }] });
        const p = await plan(h, { operation: "replace", course_module_id: m.id, content: { type: "question_set", questions: [TF] } });
        expect(p.risk).toBe("R3");
        expect(p.items[0]!.function).toBe("course_modedit_h5pactivity_update_files");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(m.files!.map((f) => f.filename)).toEqual([uploaded[0]!.name]);
        expect(uploaded[0]!.name).toMatch(/^repaso-[a-z0-9]+\.h5p$/); // mismo nombre que el anterior: se distingue
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);
        const page = acts.add({ kind: "book", name: "Libro", intro: "", chapters: [] });
        expect((await errOf(plan(h, { operation: "replace", course_module_id: page.id, content: { type: "question_set", questions: [TF] } }))).message).toMatch(/no es una actividad H5P/);
    });

    it("remoto: el paquete viaja dentro del plan (sin archivos locales) y se puede ejecutar", async () => {
        const { h, acts } = await harness({ remote: true });
        const p = await plan(h, { operation: "create", section: 1, name: "Remoto", content: { type: "question_set", questions: [TF] } });
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect([...acts.mods.values()][0]!.files![0]!.filename).toBe("remoto.h5p");
    });

    it("ADR-111: Branching Scenario (nodos por id), Dialog Cards, Chart, Timeline y Accordion", async () => {
        const { h, uploaded } = await harness();
        const make = async (name: string, content: Record<string, unknown>) => {
            const r = await exec(h, (await plan(h, { operation: "create", section: 1, name, content })).plan_id);
            expect(r.status, name).toBe("aplicado_verificado");
            return (await packageOf(uploaded.at(-1)!)).content;
        };
        const bs = await make("Escenario", {
            type: "branching_scenario",
            title: "Café",
            start: { title: "Sos el dueño", subtitle: "Elegí" },
            nodes: [
                { kind: "text", id: "intro", markdown: "Subió el grano.", next: "decision" },
                { kind: "choice", id: "decision", question: "¿Qué hacés?", options: [{ text: "Subir", next: "sube" }, { text: "Cerrar", next: "end", end: { title: "Cerraste", score: 0 } }] },
                { kind: "text", id: "sube", markdown: "Vendés menos.", next: "end", end: { title: "Precio alto", subtitle: "Depende", score: 2 } },
            ],
        });
        const c = bs.branchingScenario.content;
        expect(c.map((x: { type: { library: string }; nextContentId: number }) => [x.type.library, x.nextContentId])).toEqual([["H5P.AdvancedText 1.1", 1], ["H5P.BranchingQuestion 1.0", 2], ["H5P.AdvancedText 1.1", -1]]);
        expect(c[1].type.params.branchingQuestion.alternatives.map((a: { nextContentId: number }) => a.nextContentId)).toEqual([2, -1]);
        expect(c[2].feedback).toEqual({ title: "<p>Precio alto</p>", subtitle: "<p>Depende</p>", endScreenScore: 2 });
        // Defaults en profundidad (como el editor): cada nodo trae su grupo feedback aunque no termine.
        expect(c[0].feedback).toEqual({});
        expect(c[1].type.params.branchingQuestion.alternatives[0].feedback).toEqual({});
        expect(bs.branchingScenario.startScreen.startScreenTitle).toBe("<p>Sos el dueño</p>");
        await expect(plan(h, { operation: "create", section: 1, name: "X", content: { type: "branching_scenario", title: "x", nodes: [{ kind: "text", id: "a", markdown: "x", next: "zz" }] } })).rejects.toThrow(/apunta a «zz»/);

        const dc = await make("Tarjetas", { type: "dialog_cards", title: "Conceptos", mode: "repetition", cards: [{ front: "Elasticidad", back: "Cambio <relativo>", tip_front: "pista" }] });
        expect(dc).toMatchObject({ mode: "repetition", dialogs: [{ text: "<p>Elasticidad</p>", answer: "<p>Cambio &lt;relativo&gt;</p>", tips: { front: "pista" } }] });

        const ch = await make("Gráfico", { type: "chart", chart_type: "pie", title: "Datos", items: [{ label: "A", value: 2 }, { label: "B", value: 3, color: "#123456" }] });
        expect(ch).toMatchObject({ graphMode: "pieChart", figureDefinition: "Datos", listOfTypes: [{ text: "A", value: 2, color: "#0b5cad" }, { text: "B", value: 3, color: "#123456" }] });

        const tl = await make("Línea", { type: "timeline", title: "Independencia", events: [{ date: "1810-05-25", title: "Revolución", text: "Cabildo **abierto**" }, { date: "1816-07", end_date: "1816-07-09", title: "Congreso", media_url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" }, { date: "-300", title: "Antes" }], eras: [{ start: "1810", end: "1820", title: "Década" }] });
        expect(tl.timeline.date.map((d: { startDate: string; endDate?: string }) => [d.startDate, d.endDate ?? null])).toEqual([["1810,05,25", null], ["1816,07", "1816,07,09"], ["-300", null]]);
        expect(tl.timeline.date[1].asset).toEqual({ media: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" });
        expect(tl.timeline.date[0].asset).toEqual({}); // el reproductor lee asset.thumbnail aunque no haya medio
        expect(tl.timeline.era).toEqual([{ startDate: "1810", endDate: "1820", headline: "Década" }]);

        const ac = await make("Acordeón", { type: "accordion", heading: "h3", panels: [{ title: "Uno", markdown: "Texto **uno**" }] });
        expect(ac).toMatchObject({ hTag: "h3", panels: [{ title: "Uno", content: { library: "H5P.AdvancedText 1.1", params: { text: "<p>Texto <strong>uno</strong></p>" } } }] });
    });

    it("ADR-116: python_exercise arma un Iframe Embedder a la mini-app, con la consigna en el fragmento", async () => {
        const { h, uploaded } = await harness();
        const r = await exec(h, (await plan(h, { operation: "create", section: 1, name: "Área", content: { type: "python_exercise", title: "Área", statement: "Escribí `area(b, h)`.", function_name: "area", tests: [{ input: "2, 3", expected: "6" }, { input: "1, 1", expected: "1", hidden: true }] } })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const c = (await packageOf(uploaded[0]!)).content;
        expect(c).toMatchObject({ width: "100%", height: "650px", resizeSupported: false });
        const u = new URL(c.source);
        expect(u.origin + u.pathname).toBe("https://udesa-campus-lab.vercel.app/apps/python/");
        expect(u.search).toBe("");
        const cfg = JSON.parse(Buffer.from(u.hash.replace("#c=", ""), "base64url").toString("utf8"));
        expect(cfg).toMatchObject({ v: 1, function_name: "area", starter_code: "def area():\n    pass\n", tests: [{ args: "2, 3", expected: "6" }, { args: "1, 1", expected: "1", hidden: true }] });
        await expect(plan(h, { operation: "create", section: 1, name: "X", content: { type: "python_exercise", title: "x", statement: "x", function_name: "no valido!", tests: [{ input: "", expected: "1" }] } })).rejects.toThrow(/Nombre de función/);
    });

    it("tipos ofrecidos: se leen del menú del banco de contenido", () => {
        expect(offeredLibraries('<a href="https://x/contentbank/edit.php?contextid=1&amp;plugin=h5p&library=H5P.QuestionSet 1.21">a</a><a href="/contentbank/edit.php?contextid=1&plugin=h5p&library=H5P.Chart%201.2">b</a><a href="/contentbank/edit.php?library=evil">c</a>')).toEqual(["H5P.QuestionSet 1.21", "H5P.Chart 1.2"]);
    });
});
