import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-093: wikis por grupo e individuales (un subwiki por grupo o participante). Datos inventados. */
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["manage_activity_entries"] } } });
    const acts = new SyntheticActivities(h.fake, h.w2);
    const g = acts.add({ kind: "wiki", name: "Wiki por grupos", intro: "", wiki: { mode: "collaborative", first: "Inicio", subwiki: null, pages: [], subs: [{ id: 801, group: 12, user: 0, pages: [{ id: 901, title: "Inicio", content: "<p>Grupo A</p>" }] }, { id: null, group: 13, user: 0, pages: [] }] } });
    const ind = acts.add({ kind: "wiki", name: "Wiki individual", intro: "", wiki: { mode: "individual", first: "Inicio", subwiki: null, pages: [], subs: [{ id: 802, group: 0, user: 42, pages: [{ id: 902, title: "Inicio", content: "<p>Mía</p>" }] }] } });
    return { h, g, ind };
}
const run = async (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.execute((await h.app.engine.plan("wiki_page", { course_id: COURSE, ...input }, "test")).plan_id, h.confirmer, "test");
async function undo(h: WriteHarness, actionId: string) {
    const u = await h.app.engine.planUndo(actionId, "test");
    if (!u.undoable) throw new Error(u.reason);
    return h.app.engine.execute(u.plan.plan_id, h.confirmer, "test");
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

describe("wikis por grupo e individuales (ADR-093)", () => {
    it("editar la página del subwiki de un grupo; deshacer; sin group_id el error lista los subwikis", async () => {
        const { h, g } = await harness();
        const r = await run(h, { course_module_id: g.id, group_id: 12, operation: "edit", page_id: 901, content: "Grupo A **v2**" });
        expect(r.status).toBe("aplicado_verificado");
        expect(g.wiki!.subs![0]!.pages[0]!.content).toBe("<p>Grupo A <strong>v2</strong></p>");
        expect((await undo(h, r.action_id)).status).toBe("aplicado_verificado");
        const e = await errOf(h.app.engine.plan("wiki_page", { course_id: COURSE, course_module_id: g.id, operation: "edit", page_id: 901, content: "x" }, "test"));
        expect(e.code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(e.message).toMatch(/grupo 12; grupo 13/);
    });

    it("primera página en el subwiki todavía sin crear de otro grupo (Moodle lo crea); deshacer la borra", async () => {
        const { h, g } = await harness();
        const r = await run(h, { course_module_id: g.id, group_id: 13, operation: "add", title: "Inicio", content: "Grupo B" });
        expect(r.status).toBe("aplicado_verificado");
        expect(h.fake.callsOf("mod_wiki_new_page").at(-1)!.params).toMatchObject({ wikiid: String(g.instance), groupid: "13", userid: "0" });
        const sub = g.wiki!.subs![1]!;
        expect(sub.id).not.toBeNull();
        expect(sub.pages.map((p) => p.title)).toEqual(["Inicio"]);
        // La primera página no se borra: el deshacer de esta alta se rechaza.
        expect((await h.app.engine.planUndo(r.action_id, "test").catch((x: CampusError) => x)).toString()).toMatch(/primera página/);
        const r2 = await run(h, { course_module_id: g.id, group_id: 13, operation: "add", title: "Notas", content: "n" });
        expect((await undo(h, r2.action_id)).status).toBe("aplicado_verificado");
        expect(sub.pages.map((p) => p.title)).toEqual(["Inicio"]);
    });

    it("wiki individual: user_id obligatorio; agregar en la del participante", async () => {
        const { h, ind } = await harness();
        expect((await errOf(h.app.engine.plan("wiki_page", { course_id: COURSE, course_module_id: ind.id, operation: "add", title: "X", content: "y" }, "test"))).message).toMatch(/individual/);
        const r = await run(h, { course_module_id: ind.id, user_id: 42, operation: "add", title: "Ideas", content: "Algo" });
        expect(r.status).toBe("aplicado_verificado");
        expect(ind.wiki!.subs![0]!.pages.map((p) => p.title)).toEqual(["Inicio", "Ideas"]);
        expect((await errOf(h.app.engine.plan("wiki_page", { course_id: COURSE, course_module_id: ind.id, user_id: 43, operation: "add", title: "X", content: "y" }, "test"))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });
});
