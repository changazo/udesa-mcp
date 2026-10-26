import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { F_QA } from "../fixtures/fake-forum.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const harness = () => makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["post_announcement", "edit_own_post"] } } });
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
function files(...specs: [string, string][]) {
    const dir = mkdtempSync(join(tmpdir(), "campus-ea-"));
    return specs.map(([n, c]) => {
        const p = join(dir, n);
        writeFileSync(p, c);
        return p;
    });
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
/** Aviso propio en Consultas con dos adjuntos. */
async function withPost(h: WriteHarness) {
    const r = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Material", message: "x", attachments: files(["a.txt", "aaa"], ["b.txt", "bb"]) })).plan_id);
    return { disc: r.moodle_ids.discussion_id![0]!, post: r.moodle_ids.post_id![0]! };
}
const names = (h: WriteHarness, post: number) => (h.forums.posts.get(post)!.attachments ?? []).map((a) => a.filename).sort();

describe("cambiar adjuntos de un post propio (ADR-069)", () => {
    it("agregar conservando los actuales; verificado; deshacer quita sólo el agregado", async () => {
        const h = await harness();
        const { disc, post } = await withPost(h);
        const p = await plan(h, "post_attachments", { discussion_id: disc, post_id: post, add: files(["c.csv", "1,2"]) });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(names(h, post)).toEqual(["a.txt", "b.txt", "c.csv"]);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(names(h, post)).toEqual(["a.txt", "b.txt"]);
    });

    it("conservar uno y quitar el otro; quitar todos (keep [] → nombre inexistente, porque [] es «todos» en Moodle); sin deshacer", async () => {
        const h = await harness();
        const { disc, post } = await withPost(h);
        const r = await exec(h, (await plan(h, "post_attachments", { discussion_id: disc, post_id: post, keep: ["a.txt"] })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(names(h, post)).toEqual(["a.txt"]);
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);
        expect((await exec(h, (await plan(h, "post_attachments", { discussion_id: disc, post_id: post, keep: [] })).plan_id)).status).toBe("aplicado_verificado");
        expect(names(h, post)).toEqual([]);
        expect(h.fake.callsOf("mod_forum_prepare_draft_area_for_post").at(-1)!.params).toMatchObject({ "filestokeep[0][filename]": "__ninguno__.mcp" });
    });

    it("rechazos: post ajeno, adjunto inexistente en keep, nombre repetido, sin cambios", async () => {
        const h = await harness();
        const { disc, post } = await withPost(h);
        const code = async (i: Record<string, unknown>) => (await errOf(plan(h, "post_attachments", { discussion_id: disc, post_id: post, ...i }))).code;
        expect(await code({ keep: ["zzz.txt"] })).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await code({ add: files(["A.TXT", "x"]) })).toBe("WRITE_NOT_ALLOWED");
        expect(await code({})).toBe("WRITE_NOT_ALLOWED");
        const other = [...h.forums.posts.values()].find((p) => p.userid !== 501)!;
        expect((await errOf(plan(h, "post_attachments", { discussion_id: other.discussion, post_id: other.id, keep: [] }))).code).not.toBe("NO_ERROR");
    });
});
