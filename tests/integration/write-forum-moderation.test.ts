import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { D_STUDENT, D_WELCOME, F_NEWS, F_QA, P_PRIVATE, P_STUDENT, P_STUDENT_REPLY, P_WELCOME } from "../fixtures/fake-forum.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-094: moderación de foros (borrar posts ajenos, mover discusiones). Datos inventados. */
const F_DEBATE = 3003;
async function harness() {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["moderate_forum"] } } });
    h.forums.forums.push({ id: F_DEBATE, course: COURSE, type: "general", name: "Debates", cmid: 9003, forcesubscribe: 0 });
    return h;
}
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
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

describe("moderación de foros (ADR-094)", () => {
    it("borrar la respuesta de un estudiante se lleva su rama; R4 (posts de otros, ADR-119) sin deshacer", async () => {
        const h = await harness();
        const p = await plan(h, "forum_post_delete", { discussion_id: D_WELCOME, post_id: P_STUDENT_REPLY });
        expect(p.risk).toBe("R4");
        expect(p.payload_preview).toMatchObject({ posts_by_others: 1 }); // la rama tiene además una respuesta propia
        expect(p.payload_preview).toMatchObject({ post: { author: "Estudiante A", first_post: false }, deleted_posts: 2 });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.forums.posts.has(P_STUDENT_REPLY)).toBe(false);
        expect(h.forums.posts.has(P_PRIVATE)).toBe(false);
        expect(h.forums.posts.has(P_WELCOME)).toBe(true);
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);
    });

    it("el primer post exige delete_discussion; con él se borra la discusión", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "forum_post_delete", { discussion_id: D_STUDENT, post_id: P_STUDENT }))).message).toMatch(/delete_discussion/);
        const r = await exec(h, (await plan(h, "forum_post_delete", { discussion_id: D_STUDENT, post_id: P_STUDENT, delete_discussion: true })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.forums.discussions.has(D_STUDENT)).toBe(false);
        expect((await errOf(plan(h, "forum_post_delete", { discussion_id: D_WELCOME, post_id: P_STUDENT }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("mover una discusión a otro foro y deshacer (vuelve); Avisos y el mismo foro se rechazan", async () => {
        const h = await harness();
        const r = await exec(h, (await plan(h, "forum_move_discussion", { discussion_id: D_STUDENT, to_forum_id: F_DEBATE })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.forums.discussions.get(D_STUDENT)!.forum).toBe(F_DEBATE);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        expect(u.undoable).toBe(true);
        if (u.undoable) expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(h.forums.discussions.get(D_STUDENT)!.forum).toBe(F_QA);
        expect((await errOf(plan(h, "forum_move_discussion", { discussion_id: D_STUDENT, to_forum_id: F_NEWS }))).message).toMatch(/Avisos/);
        expect((await errOf(plan(h, "forum_move_discussion", { discussion_id: D_STUDENT, to_forum_id: F_QA }))).message).toMatch(/ya está/);
        expect((await errOf(plan(h, "forum_move_discussion", { discussion_id: D_WELCOME, to_forum_id: F_DEBATE }))).message).toMatch(/Avisos/);
    });

    it("mover: si Moodle no la mueve, sin_efecto; con un post de los últimos 15 minutos se rechaza", async () => {
        const h = await harness();
        h.forums.moveNoop = true;
        const r = await exec(h, (await plan(h, "forum_move_discussion", { discussion_id: D_STUDENT, to_forum_id: F_DEBATE })).plan_id).catch((e: CampusError) => e.details?.result as { status: string });
        expect(r.status).toBe("sin_efecto");
        h.forums.moveNoop = false;
        h.forums.posts.get(P_STUDENT)!.created = h.clock.ms / 1000 - 600;
        expect((await errOf(plan(h, "forum_move_discussion", { discussion_id: D_STUDENT, to_forum_id: F_DEBATE }))).message).toMatch(/últimos 15 minutos/);
    });
});
