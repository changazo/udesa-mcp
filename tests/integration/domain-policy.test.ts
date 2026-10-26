import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { READ_FUNCTIONS } from "../../src/moodle/functions.js";
import { makeHarness } from "../fixtures/harness.js";
import { COURSE, INJECTION, NEWS_CMID, NEWS_FORUM, NOW_UNIX, OTHER_COURSE, OTHER_DISCUSSION, OTHER_FORUM, QA_FORUM, VALID_TOKEN } from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("cursos y estructura", () => {
    it("lista sólo cursos permitidos", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listCourses();
        expect(r.data.map((c) => c.course_id)).toEqual([COURSE]);
        expect(JSON.stringify(r)).not.toContain("OTRO");
        expect(r.source).toMatchObject({ system: "moodle", site_url: "https://campus.example.test" });
        expect(r.coverage.complete).toBe(true);
    });

    it("POL-01: curso no permitido se bloquea antes de consultar", async () => {
        const h = await makeHarness();
        const before = h.fake.calls.length;
        expect(await codeOf(h.app.service.getCourse(OTHER_COURSE))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.listForums(OTHER_COURSE))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.listAnnouncements({ course_id: OTHER_COURSE }))).toBe("POLICY_DENIED");
        expect(h.fake.calls.length).toBe(before);
    });

    it("DATA-03: módulo oculto no se presenta como visible para alumnos; enlaces sin token", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getCourse(COURSE);
        const mods = r.data.sections[0]!.modules;
        const material = mods.find((m) => m.course_module_id === 9003)!;
        expect(material.visible_to_all_students).toBe(false);
        expect(mods.find((m) => m.course_module_id === NEWS_CMID)!.visible_to_all_students).toBeNull();
        expect(material.external_links).toEqual(["https://docs.example.org/guia"]);
        // archivo externo descartado; los del Campus como file_ref opaco
        expect(material.files.map((f) => f.name)).toEqual(["consigna.txt", "programa.pdf", "grande.txt", "redirige.txt", "pagina.html"]);
        expect(material.files.every((f) => f.ref.startsWith("file_") && !f.source_url?.includes("token"))).toBe(true);
        expect(r.data.sections[0]!.summary).toBe("Bienvenida & reglas");
    });
});

describe("foros y Avisos", () => {
    it("FOR-01: identifica Avisos por type=news, con IDs diferenciados", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listForums(COURSE);
        expect(r.data.announcement_forum).toMatchObject({ status: "detected", forum_id: NEWS_FORUM });
        const news = r.data.forums.find((f) => f.forum_id === NEWS_FORUM)!;
        expect(news).toMatchObject({ course_module_id: NEWS_CMID, type: "news" });
        expect(r.data.forums.some((f) => f.forum_id === OTHER_FORUM)).toBe(false);
    });

    it("FOR-02: dos foros news → ambigüedad visible, sin elegir uno", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_forum_get_forums_by_courses", () => [
            { id: NEWS_FORUM, course: COURSE, type: "news", name: "Avisos", cmid: NEWS_CMID },
            { id: QA_FORUM, course: COURSE, type: "news", name: "Avisos 2", cmid: 9002 },
        ]);
        const r = await h.app.service.listForums(COURSE);
        expect(r.data.announcement_forum.status).toBe("ambiguous");
        expect(r.data.announcement_forum.candidates).toHaveLength(2);
        const e = await h.app.service.listAnnouncements({ course_id: COURSE }).catch((x) => x);
        expect(e.code).toBe("AMBIGUOUS_RESOURCE");
        expect(e.details.candidates).toHaveLength(2);
    });

    it("FOR-02: un announcement_forum_id configurado se valida contra el curso", async () => {
        const ok = await makeHarness({ profile: { announcement_forum_id: NEWS_FORUM } });
        expect((await ok.app.service.listForums(COURSE)).data.announcement_forum.status).toBe("configured");
        const bad = await makeHarness({ profile: { announcement_forum_id: OTHER_FORUM } });
        expect(await codeOf(bad.app.service.listForums(COURSE))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("FOR-03: pagina, deduplica y declara cobertura best_effort", async () => {
        const h = await makeHarness();
        const first = await h.app.service.listAnnouncements({ course_id: COURSE, limit: 20 });
        expect(first.data.announcements).toHaveLength(20);
        expect(first.coverage).toMatchObject({ complete: false, has_more: true, consistency: "best_effort", pages_read: 1 });
        const second = await h.app.service.listAnnouncements({ course_id: COURSE, cursor: first.coverage.next_cursor!, limit: 20 });
        expect(second.data.announcements).toHaveLength(10);
        expect(second.coverage).toMatchObject({ has_more: false, complete: false, pages_read: 2 });
        const ids = [...first.data.announcements, ...second.data.announcements].map((a) => a.ref.discussion_id);
        expect(new Set(ids).size).toBe(30);
        // Una consulta completa desde el inicio sí es complete=true.
        const all = await h.app.service.listAnnouncements({ course_id: COURSE, limit: 50 });
        expect(all.coverage).toMatchObject({ complete: true, has_more: false, pages_read: 2 });
    });

    it("FOR-03: un cambio entre páginas no duplica resultados", async () => {
        const h = await makeHarness();
        let callsSeen = 0;
        h.fake.overrides.set("mod_forum_get_forum_discussions", (params) => {
            callsSeen++;
            const all = h.fake.discussions.slice(0, 26);
            const page = Number(params.page);
            // la segunda página repite un elemento de la primera (corrimiento por un aviso nuevo)
            return { discussions: page === 0 ? all.slice(0, 25) : all.slice(24, 26), warnings: [] };
        });
        const r = await h.app.service.listAnnouncements({ course_id: COURSE, limit: 50 });
        expect(callsSeen).toBe(2);
        expect(r.data.announcements).toHaveLength(26);
    });

    it("FOR-04: fechas distintas preservadas; since incluye actividad reciente de un aviso viejo", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listAnnouncements({ course_id: COURSE, since: new Date((NOW_UNIX - 3 * 86_400) * 1000).toISOString().replace(".000", ""), limit: 50 });
        const subjects = r.data.announcements.map((a) => a.subject);
        expect(subjects).toContain("Aviso sintético 29"); // creado hace 30 días, actividad hace 1 h
        expect(subjects).toContain("Aviso sintético 0");
        expect(subjects).not.toContain("Aviso sintético 10");
        const old = r.data.announcements.find((a) => a.subject === "Aviso sintético 29")!;
        expect(old.pinned).toBe(true);
        expect(old.dates.created!.unix).toBeLessThan(old.dates.last_activity!.unix);
        expect(old.dates.display_start).toBeNull(); // 0 ≠ 1970
        expect(r.coverage.complete).toBe(true);
    });

    it("visibilidad: grupo y publicación programada no se presentan como visibles para todos", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listAnnouncements({ course_id: COURSE, limit: 50 });
        const by = (n: number) => r.data.announcements.find((a) => a.subject === `Aviso sintético ${n}`)!;
        expect(by(1).visible_to_all_students).toBe(false);
        expect(by(1).audience.group_id).toBe(12);
        expect(by(2).visible_to_all_students).toBe(false);
        expect(by(2).audience.scheduled_in_future).toBe(true);
        expect(by(5).visible_to_all_students).toBeNull();
    });

    it("DATA-01: instrucciones dentro de un aviso son texto fuente y no cambian nada", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listAnnouncements({ course_id: COURSE, limit: 50 });
        const a = r.data.announcements.find((x) => x.subject === "Aviso sintético 0")!;
        expect(a.body_markdown).toBe(INJECTION);
        expect(r.content_policy).toMatch(/no confiables/);
        expect(h.fake.foreign).toEqual([]);
        expect(await codeOf(h.app.service.getCourse(OTHER_COURSE))).toBe("POLICY_DENIED");
    });

    it("FOR-05: cuerpo recortado en la lista, completo y continuable en la discusión", async () => {
        const h = await makeHarness();
        await h.app.service.listAnnouncements({ course_id: COURSE, limit: 50 });
        const d1 = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6005 });
        expect(d1.coverage.has_more).toBe(true);
        expect(d1.coverage.next_cursor).toBeTruthy();
        const reply = d1.data.posts[1]!;
        expect(reply.content_truncated).toBe(true);
        expect(reply.char_range.end).toBeLessThan(reply.char_range.total);
        const d2 = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6005, cursor: d1.coverage.next_cursor! });
        expect(d2.data.posts[0]!.char_range.start).toBe(reply.char_range.end);
    });

    it("FOR-06: permiso denegado o timeout son errores, no listas vacías", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_forum_get_forum_discussions", () => ({ exception: "required_capability_exception", errorcode: "nopermissions", message: "Sorry, but you do not currently have permissions" }));
        expect(await codeOf(h.app.service.listAnnouncements({ course_id: COURSE }))).toBe("MOODLE_PERMISSION_DENIED");
        // Falla de red persistente: se reintenta una lectura idempotente y termina en NETWORK_ERROR.
        const h2 = await makeHarness();
        let attempts = 0;
        h2.fake.overrides.set("mod_forum_get_forum_discussions", () => {
            attempts++;
            throw new TypeError("fetch failed");
        });
        expect(await codeOf(h2.app.service.listAnnouncements({ course_id: COURSE }))).toBe("NETWORK_ERROR");
        expect(attempts).toBe(3);
    });
});

describe("pertenencia de discusiones (POL-02)", () => {
    it("curso permitido + discusión ajena: se bloquea sin exponer contenido", async () => {
        const h = await makeHarness();
        const e = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: OTHER_DISCUSSION }).catch((x) => x);
        expect(e.code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(JSON.stringify(e)).not.toContain("NO DEBE EXPONERSE");
    });

    it("discusión sin courseid en la respuesta: se valida por el foro del curso", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_forum_get_discussion_posts", () => ({ posts: [{ id: 1, subject: "x", message: "y", timecreated: 1, discussionid: OTHER_DISCUSSION }], forumid: OTHER_FORUM }));
        expect(await codeOf(h.app.service.getDiscussion({ course_id: COURSE, discussion_id: OTHER_DISCUSSION }))).toBe("RESOURCE_OUT_OF_SCOPE");
        h.fake.overrides.set("mod_forum_get_discussion_posts", () => ({ posts: [{ id: 1, subject: "x", message: "y", timecreated: 1 }] }));
        expect(await codeOf(h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 123456 }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("forum_id declarado que no coincide se rechaza", async () => {
        const h = await makeHarness();
        await h.app.service.listAnnouncements({ course_id: COURSE, limit: 5 });
        expect(await codeOf(h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6000, forum_id: QA_FORUM }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });

    it("discusión propia: posts completos, ordenados y con procedencia", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: 6003 });
        expect(r.data.ref).toEqual({ course_id: COURSE, course_module_id: NEWS_CMID, forum_id: NEWS_FORUM, discussion_id: 6003 });
        expect(r.data.posts.map((p) => p.post_id)).toEqual([7003, 107003]);
        expect(r.data.posts[0]!.body_markdown).toBe("Cuerpo del aviso 3. Entrega **TP0** el 1/11.");
        expect(r.data.posts[0]!.attachments.map((a) => a.name)).toEqual(["consigna.txt"]); // el externo se descarta
        expect(r.source.source_url).toBe("https://campus.example.test/mod/forum/discuss.php?d=6003");
        expect(r.coverage.complete).toBe(true);
    });

    it("cursor manipulado o de otro curso se rechaza", async () => {
        const h = await makeHarness();
        const forged = Buffer.from(JSON.stringify({ v: 1, c: OTHER_COURSE, f: OTHER_FORUM, p: 0, o: 0, s: null, l: 10 })).toString("base64url");
        expect(await codeOf(h.app.service.listAnnouncements({ course_id: COURSE, cursor: forged }))).toBe("RESOURCE_OUT_OF_SCOPE");
        const forged2 = Buffer.from(JSON.stringify({ v: 1, c: COURSE, f: OTHER_FORUM, p: 0, o: 0, s: null, l: 10 })).toString("base64url");
        expect(await codeOf(h.app.service.listAnnouncements({ course_id: COURSE, cursor: forged2 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.listAnnouncements({ course_id: COURSE, cursor: "basura" }))).toBe("POLICY_DENIED");
    });
});

describe("archivos", () => {
    async function refs() {
        const h = await makeHarness();
        const course = await h.app.service.getCourse(COURSE);
        const files = Object.fromEntries(course.data.sections[0]!.modules.find((m) => m.course_module_id === 9003)!.files.map((f) => [f.name, f.ref]));
        return { h, files };
    }

    it("lee un archivo de texto autorizado por file_ref, sin token en la salida", async () => {
        const { h, files } = await refs();
        const r = await h.app.service.readFile({ file_ref: files["consigna.txt"]! });
        expect(r.data.text).toBe("Consigna sintética: entregar el TP.");
        expect(r.coverage.complete).toBe(true);
        expect(JSON.stringify(r)).not.toContain(VALID_TOKEN);
        expect(h.logs.join("\n")).not.toContain(VALID_TOKEN);
    });

    it("FILE-01: redirect a otro origen bloqueado; nunca se envía el token afuera", async () => {
        const { h, files } = await refs();
        expect(await codeOf(h.app.service.readFile({ file_ref: files["redirige.txt"]! }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.foreign).toEqual([]);
    });

    it("FILE-02: archivo que excede el límite se corta con error controlado", async () => {
        const { h, files } = await refs();
        expect(await codeOf(h.app.service.readFile({ file_ref: files["grande.txt"]! }))).toBe("UNSUPPORTED_CONTENT");
    });

    it("FILE-03: PDF con texto se lee por páginas; formato sin soporte (Office) no se descarga", async () => {
        const { h, files } = await refs();
        const r = await h.app.service.readFile({ file_ref: files["programa.pdf"]! });
        expect(r.data.modality).toBe("pdf_text");
        expect(r.data.num_pages).toBe(2);
        expect(r.data.text).toContain("Programa sintetico");
        expect(r.data.text).toContain("--- Página 2 ---");
        expect(r.coverage.complete).toBe(true);
    });

    it("FILE-04: HTML con scripts se convierte a texto sin ejecutar", async () => {
        const { h, files } = await refs();
        const r = await h.app.service.readFile({ file_ref: files["pagina.html"]! });
        expect(r.data.text).toBe("# Título\n\nHola clic");
        expect(r.data.modality).toBe("html_as_text");
    });

    it("POL-03: no se aceptan URLs ni refs inventadas; misma-host fuera de pluginfile se bloquea", async () => {
        const { h } = await refs();
        expect(await codeOf(h.app.service.readFile({ file_ref: "file_inventado" }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(await codeOf(h.app.service.readFile({ file_ref: "https://campus.example.test/webservice/pluginfile.php/999/x.txt" }))).toBe("RESOURCE_OUT_OF_SCOPE");
        const t = h.app.session.transport;
        for (const bad of [
            "https://campus.example.test/course/view.php?id=7777",
            "https://campus.example.test/webservice/pluginfile.php/%2e%2e/x",
            "https://campus.example.test/webservice/pluginfile.php/../../admin",
            "http://campus.example.test/webservice/pluginfile.php/1/x",
            "https://u:p@campus.example.test/webservice/pluginfile.php/1/x",
            "https://campus.example.test.evil.example.com/webservice/pluginfile.php/1/x",
        ]) {
            expect(() => t.normalizeFileUrl(bad), bad).toThrow(CampusError);
        }
        expect(t.normalizeFileUrl("https://campus.example.test/pluginfile.php/1/a.txt?token=x&forcedownload=1")).toBe("https://campus.example.test/webservice/pluginfile.php/1/a.txt?forcedownload=1");
    });
});

describe("superficie de solo lectura", () => {
    it("POL-04: una función no permitida se bloquea en el transporte aunque se invoque internamente", async () => {
        const h = await makeHarness();
        const before = h.fake.calls.length;
        const t = h.app.session.transport as unknown as { call: (fn: string, p: object, s: unknown) => Promise<unknown> };
        expect(await codeOf(t.call("mod_forum_add_discussion", { forumid: NEWS_FORUM, subject: "x", message: "y" }, { safeParse: () => ({ success: true }) }))).toBe("POLICY_DENIED");
        expect(await codeOf(t.call("mod_forum_view_forum", { forumid: NEWS_FORUM }, { safeParse: () => ({ success: true }) }))).toBe("POLICY_DENIED");
        expect(h.fake.calls.length).toBe(before);
    });

    it("parámetros reservados no pueden sobreescribirse", async () => {
        const h = await makeHarness();
        const t = h.app.session.transport;
        expect(await codeOf(t.call("core_course_get_contents", { courseid: COURSE, wsfunction: "mod_forum_add_discussion" }, { safeParse: () => ({ success: true }) } as never))).toBe("POLICY_DENIED");
        expect(await codeOf(t.call("core_course_get_contents", { courseid: COURSE, wstoken: "otro" }, { safeParse: () => ({ success: true }) } as never))).toBe("POLICY_DENIED");
    });

    it("todo el recorrido sólo invoca funciones de lectura de la allowlist", async () => {
        const h = await makeHarness();
        await h.app.service.listCourses();
        await h.app.service.getCourse(COURSE);
        const list = await h.app.service.listAnnouncements({ course_id: COURSE, limit: 50 });
        await h.app.service.getDiscussion({ course_id: COURSE, discussion_id: list.data.announcements[0]!.ref.discussion_id });
        const used = new Set(h.fake.calls.map((c) => c.fn));
        for (const fn of used) expect(READ_FUNCTIONS as readonly string[]).toContain(fn);
        expect([...used].some((fn) => /_view_|_add_|_update_|_delete_|_send_|_save_|_submit_|^enrol_/.test(fn))).toBe(false);
    });

    it("CAP-02: función listada pero permiso denegado queda registrada como denied, no como inexistente", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("core_course_get_contents", () => ({ exception: "require_login_exception", errorcode: "requireloginerror", message: "Course or activity not accessible." }));
        expect(await codeOf(h.app.service.getCourse(COURSE))).toBe("MOODLE_PERMISSION_DENIED");
        expect(h.app.recorder.get("read_course")).toMatchObject({ status: "denied", course_id: COURSE });
    });

    it("función no listada en el servicio → FUNCTION_NOT_AVAILABLE y degradación puntual", async () => {
        const h = await makeHarness();
        h.fake.overrides.set("mod_forum_get_forums_by_courses", () => ({ exception: "webservice_access_exception", errorcode: "accessexception", message: "Access control exception" }));
        h.fake.overrides.set("core_webservice_get_site_info", () => ({ userid: 501, siteurl: "https://campus.example.test", functions: [{ name: "core_course_get_contents", version: "1" }] }));
        await h.app.session.verify();
        const r = await h.app.service.listForums(COURSE);
        expect(r.warnings.join(" ")).toMatch(/no está disponible/);
        expect(r.data.forums.map((f) => f.forum_id).sort()).toEqual([NEWS_FORUM, QA_FORUM]);
        expect(r.data.announcement_forum.status).toBe("ambiguous"); // sólo pista por nombre, no se elige
    });
});
