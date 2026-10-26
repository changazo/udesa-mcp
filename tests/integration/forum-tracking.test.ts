import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import { COURSE, NEWS_FORUM, OTHER_DISCUSSION, SITE } from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

async function someDiscussion(h: Awaited<ReturnType<typeof makeHarness>>) {
    const list = await h.app.service.listAnnouncements({ course_id: COURSE, limit: 5 });
    const d = list.data.announcements.find((a) => (a.num_replies ?? 0) > 0) ?? list.data.announcements[0]!;
    return d;
}

describe("lectura de foros con seguimiento (ADR-030, excepción ADR-039)", () => {
    it("foro bajo seguimiento: lee el hilo completo y declara que Moodle marcó los posts como leídos", async () => {
        const h = await makeHarness();
        h.fake.forumsTracked = true;
        const d = await someDiscussion(h);
        const r = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: d.ref.discussion_id });
        expect(r.data).toMatchObject({ read_mode: "completo", marked_read: true });
        expect(r.data.posts.length).toBeGreaterThan(1);
        expect(r.warnings.join(" ")).toMatch(/marcó sus posts como leídos/);
        // La verificación de pertenencia sigue antes del lector de posts.
        const order = h.fake.calls.map((c) => c.fn);
        expect(order.indexOf("mod_forum_get_forum_discussions")).toBeLessThan(order.indexOf("mod_forum_get_discussion_posts"));
    });

    it("con avoid_mark_read: nunca llama al lector de posts y entrega sólo el primer post", async () => {
        const h = await makeHarness();
        h.fake.forumsTracked = true;
        const d = await someDiscussion(h);
        const r = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: d.ref.discussion_id, avoid_mark_read: true });
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(0);
        expect(r.data).toMatchObject({ read_mode: "primer_post", replies_omitted: d.num_replies });
        expect(r.data.posts).toHaveLength(1);
        expect(r.data.posts[0]!.post_id).toBe(d.first_post_id);
        expect(r.coverage.complete).toBe(false);
        expect(r.source.wsfunctions).not.toContain("mod_forum_get_discussion_posts");
    });

    it("con avoid_mark_read, el cursor de un primer post largo conserva el modo aunque no se repita el parámetro", async () => {
        const h = await makeHarness();
        h.fake.forumsTracked = true;
        const d = h.fake.discussions.find((x) => x.discussion === 6004)!;
        d.message = `<p>${"Texto largo del aviso. ".repeat(300)}</p>`;
        const r1 = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6004, avoid_mark_read: true });
        expect(r1.data.read_mode).toBe("primer_post");
        expect(r1.coverage.next_cursor).toBeTruthy();
        const r2 = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6004, cursor: r1.coverage.next_cursor! });
        expect(r2.data.read_mode).toBe("primer_post");
        expect(r2.data.posts[0]!.char_range.start).toBe(r1.data.posts[0]!.char_range.end);
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(0);
        // Contradecir el modo del cursor se rechaza, sin leer el hilo.
        expect(await codeOf(h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6004, cursor: r1.coverage.next_cursor!, avoid_mark_read: false }))).toBe("POLICY_DENIED");
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(0);
    });

    it("un cursor de lectura completa no se reusa con avoid_mark_read (no vuelve al primer post)", async () => {
        const h = await makeHarness();
        const r1 = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6005 });
        expect(r1.coverage.next_cursor).toBeTruthy();
        expect(await codeOf(h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6005, cursor: r1.coverage.next_cursor!, avoid_mark_read: true }))).toBe("POLICY_DENIED");
        const r2 = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6005, cursor: r1.coverage.next_cursor!, avoid_mark_read: false });
        expect(r2.data.read_mode).toBe("completo");
    });

    it("foro sin seguimiento: hilo completo, sin marcado", async () => {
        const h = await makeHarness();
        const d = await someDiscussion(h);
        const r = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: d.ref.discussion_id });
        expect(r.data).toMatchObject({ read_mode: "completo", marked_read: false });
        expect(r.warnings.join(" ")).not.toMatch(/marcó/);
        const order = h.fake.calls.map((c) => c.fn);
        expect(order.lastIndexOf("mod_forum_get_forums_by_courses")).toBeLessThan(order.indexOf("mod_forum_get_discussion_posts"));
    });

    it("discusión ajena: se rechaza sin haber llamado al lector de posts", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getDiscussion({ course_id: COURSE, discussion_id: OTHER_DISCUSSION }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(0);
    });

    it("con seguimiento, el adjunto del primer post (un aviso) se resuelve por el listado, sin leer ni marcar el hilo", async () => {
        const h = await makeHarness();
        h.fake.forumsTracked = true;
        const list = await h.app.service.listAnnouncements({ course_id: COURSE, limit: 50 });
        const a = list.data.announcements.find((x) => x.attachments.length > 0)!;
        const r = await h.app.service.readFile({ file_ref: a.attachments[0]!.ref });
        expect(r.data.file).toMatchObject({ name: "consigna.txt", origin: { kind: "post", id: a.first_post_id } });
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(0);
        expect(r.warnings.join(" ")).not.toMatch(/marcó/);
    });

    it("con seguimiento, el adjunto de una respuesta lee el hilo y avisa que se marcó como leído", async () => {
        const h = await makeHarness();
        h.fake.forumsTracked = true;
        const d = h.fake.discussions.find((x) => x.discussion === 6003)!;
        const replyId = d.id + 100000;
        const attachment = { filename: "consigna.txt", url: `${SITE}/webservice/pluginfile.php/55/mod_forum/attachment/${replyId}/consigna.txt`, filesize: 40, mimetype: "text/plain" };
        h.fake.overrides.set("mod_forum_get_discussion_posts", () => ({
            posts: [
                { id: d.id, subject: d.subject, message: d.message, messageformat: 1, author: { id: 1, fullname: "Docente Sintético" }, discussionid: 6003, parentid: 0, timecreated: d.created, isdeleted: false, attachments: [] },
                { id: replyId, subject: "Re", message: "<p>Adjunto</p>", messageformat: 1, author: { id: 2, fullname: "Estudiante Sintético" }, discussionid: 6003, parentid: d.id, timecreated: d.created + 60, isdeleted: false, attachments: [attachment] },
            ],
            forumid: NEWS_FORUM,
            courseid: COURSE,
            warnings: [],
        }));
        const thread = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6003 });
        const ref = thread.data.posts.find((p) => p.post_id === replyId)!.attachments[0]!.ref;
        const r = await h.app.service.readFile({ file_ref: ref });
        expect(r.data.file).toMatchObject({ name: "consigna.txt", origin: { kind: "post", id: replyId } });
        expect(r.warnings.join(" ")).toMatch(/marcó sus posts como leídos/);
    });

    it("con seguimiento, el adjunto de una respuesta se resuelve leyendo el hilo; un post inexistente no", async () => {
        const h = await makeHarness();
        h.fake.forumsTracked = true;
        const d = await someDiscussion(h);
        const ref = `file_p.${COURSE}.${d.ref.discussion_id}.${d.first_post_id + 100000}.0123abcd`;
        // La respuesta sintética no tiene adjuntos: el localizador no resuelve, pero sí se leyó el hilo.
        expect(await codeOf(h.app.service.readFile({ file_ref: ref }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(1);
    });
});

describe("búsqueda en respuestas de foros", () => {
    it("por defecto busca sólo en asunto y primer post, sin abrir discusiones", async () => {
        const h = await makeHarness();
        const r = await h.app.service.searchForums({ course_id: COURSE, query: "Respuesta" });
        expect(r.data.matches).toHaveLength(0);
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(0);
    });

    it("include_replies: encuentra respuestas, identifica el post y declara el marcado de leídos", async () => {
        const h = await makeHarness();
        h.fake.forumsTracked = true;
        const r = await h.app.service.searchForums({ course_id: COURSE, query: "respuesta", include_replies: true });
        expect(r.data.include_replies).toBe(true);
        expect(r.data.matches.length).toBeGreaterThan(0);
        const m = r.data.matches[0]!;
        expect(m).toMatchObject({ is_first_post: false, author_name: "Estudiante Sintético" });
        expect(m.source_url).toMatch(/discuss\.php\?d=\d+#p\d+$/);
        expect(r.data.marked_read_discussions).toBe(r.data.discussions_opened);
        expect(r.warnings.join(" ")).toMatch(/marcó sus posts como leídos/);
        // Una llamada al lector por discusión abierta; el fixture tiene menos discusiones que el límite.
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(r.data.discussions_opened);
        expect(r.data.discussions_opened).toBeLessThanOrEqual(60);
        expect(r.coverage.complete).toBe(true);
    });

    it("include_replies: no abre (ni marca) discusiones sin respuestas; su primer post se busca en el listado", async () => {
        const h = await makeHarness();
        h.fake.forumsTracked = true;
        const r = await h.app.service.searchForums({ course_id: COURSE, query: "mesa de examen", include_replies: true });
        expect(r.data.matches).toHaveLength(1);
        expect(r.data.matches[0]).toMatchObject({ post_id: 7007, is_first_post: true, author_name: "Docente Sintético", ref: { discussion_id: 6007 } });
        const openedIds = h.fake.callsOf("mod_forum_get_discussion_posts").map((c) => Number(c.params.discussionid));
        expect(openedIds).not.toContain(6007);
        expect(openedIds).toHaveLength(r.data.discussions_opened);
        expect(r.data.discussions_listed_only).toBe(1);
        expect(r.data.marked_read_discussions).toBe(r.data.discussions_opened);
        expect(r.coverage.complete).toBe(true);
    });

    it("include_replies: el límite de 60 cuenta sólo discusiones con respuestas y se declara", async () => {
        const h = await makeHarness();
        const base = h.fake.discussions[10]!;
        for (let i = 0; i < 40; i++) {
            h.fake.discussions.push({ ...base, id: 8000 + i, discussion: 6100 + i, subject: `Extra ${i}`, name: `Extra ${i}`, numreplies: 1 });
        }
        const r = await h.app.service.searchForums({ course_id: COURSE, query: "respuesta", include_replies: true });
        expect(r.data.discussions_opened).toBe(60);
        expect(h.fake.callsOf("mod_forum_get_discussion_posts")).toHaveLength(60);
        expect(r.coverage.complete).toBe(false);
        expect(r.coverage.truncation_reason).toMatch(/Se abrieron 60 de 69 discusiones con respuestas/);
    });

    it("include_replies con since: sólo discusiones con actividad y posts desde esa fecha", async () => {
        const h = await makeHarness();
        const r = await h.app.service.searchForums({ course_id: COURSE, query: "respuesta", include_replies: true, since: "2100-01-01" });
        expect(r.data.discussions_opened).toBe(0);
        expect(r.data.matches).toEqual([]);
        expect(r.coverage.complete).toBe(true);
    });
});
