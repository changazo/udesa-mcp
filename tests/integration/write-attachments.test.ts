import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { checkWriteRest } from "../../src/write/functions.js";
import { COURSE, SITE } from "../fixtures/fake-moodle.js";
import { D_STUDENT, F_QA, P_STUDENT } from "../fixtures/fake-forum.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const harness = () => makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["post_announcement", "reply_forum"] } } });
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");

function files(...specs: [string, string][]) {
    const dir = mkdtempSync(join(tmpdir(), "campus-att-"));
    return specs.map(([name, content]) => {
        const p = join(dir, name);
        writeFileSync(p, content);
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

const announce = (h: WriteHarness, attachments: string[]) => plan(h, "announcement", { forum_id: F_QA, subject: "Material", message: "Va el material.", attachments });

describe("adjuntos de foros (§8.12, ADR-057)", () => {
    it("aviso con dos adjuntos: plan sin subir nada; ejecución sube UNA vez, publica con attachmentsid y verifica nombres y tamaños; deshacer borra", async () => {
        const h = await harness();
        const paths = files(["guia.pdf", "%PDF-1.4 sintético"], ["datos.csv", "a,b\n1,2\n"]);
        const p = await announce(h, paths);
        expect(h.forums.uploads).toHaveLength(0);
        const att = (p.payload_preview as { attachments: { filename: string; bytes: number; sha256: string }[] }).attachments;
        expect(att.map((a) => a.filename)).toEqual(["guia.pdf", "datos.csv"]);
        expect(att[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(p.warnings.join(" ")).toMatch(/borrador privado/);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(r.verification.checked).toContain("attachments");
        expect(h.forums.uploads).toHaveLength(1);
        expect(h.forums.uploads[0]!.files).toEqual(["guia.pdf", "datos.csv"]);
        const call = h.fake.callsOf("mod_forum_add_discussion")[0]!;
        expect(Object.values(call.params)).toContain("attachmentsid");
        const post = [...h.forums.posts.values()].find((x) => x.subject === "Material")!;
        expect(post.attachments!.map((a) => a.filename).sort()).toEqual(["datos.csv", "guia.pdf"]);
        expect(h.logs.join("\n")).not.toContain(h.forums.uploads[0]!.token!);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error(u.reason);
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
    });

    it("respuesta con adjunto, verificada", async () => {
        const h = await harness();
        const p = await plan(h, "forum_reply", { discussion_id: D_STUDENT, message: "Te paso la corrección.", attachments: files(["correccion.txt", "ok"]) });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const post = [...h.forums.posts.values()].find((x) => x.parent === P_STUDENT && x.attachments?.length)!;
        expect(post.attachments).toEqual([{ filename: "correccion.txt", filesize: 2 }]);
    });

    it("el archivo cambió después del plan → PLAN_STALE, sin subir ni publicar", async () => {
        const h = await harness();
        const [path] = files(["guia.pdf", "versión 1"]);
        const p = await announce(h, [path!]);
        writeFileSync(path!, "versión 2 distinta");
        expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
        expect(h.forums.uploads).toHaveLength(0);
        expect(h.fake.callsOf("mod_forum_add_discussion")).toHaveLength(0);
    });

    it("error por archivo dentro de un HTTP 200 → rechazado, se limpia lo subido y no se publica", async () => {
        const h = await harness();
        h.forums.uploadError = "fileoversized";
        const r = await exec(h, (await announce(h, files(["a.txt", "a"], ["b.txt", "b"]))).plan_id);
        expect(r.status).toBe("rechazado_por_moodle");
        expect(h.fake.callsOf("mod_forum_add_discussion")).toHaveLength(0);
        expect(h.forums.draftDeletes).toEqual(["a.txt"]);
    });

    it("Moodle rechaza la publicación → el borrador subido se borra", async () => {
        const h = await harness();
        const p = await announce(h, files(["a.txt", "a"]));
        h.forums.next("exception");
        expect((await exec(h, p.plan_id)).status).toBe("rechazado_por_moodle");
        expect(h.forums.draftDeletes).toEqual(["a.txt"]);
    });

    it("descarte silencioso de Moodle (maxbytes del sitio) → aplicado_con_diferencias, nunca «ok»", async () => {
        const h = await harness();
        h.forums.dropAttachmentsOver = 3;
        const r = await exec(h, (await announce(h, files(["chico.txt", "ab"], ["grande.txt", "abcdefgh"]))).plan_id);
        expect(r.status).toBe("aplicado_con_diferencias");
        expect(r.differences.map((d) => d.field)).toEqual(["attachments"]);
    });

    it("rechazos en el plan: ruta relativa, inexistente, carpeta, vacío, nombres repetidos, más que maxattachments o maxbytes, sin permiso de adjuntar", async () => {
        const h = await harness();
        const qa = h.forums.forums.find((f) => f.id === F_QA)! as { maxattachments?: number; maxbytes?: number };
        const dir = mkdtempSync(join(tmpdir(), "campus-att-"));
        const [one] = files(["uno.txt", "1"]);
        const [same] = files(["UNO.txt", "2"]);
        const [empty] = files(["vacio.txt", ""]);
        for (const bad of [["rel/uno.txt"], [join(dir, "no-existe.txt")], [dir], [empty!], [one!, same!]]) {
            expect((await errOf(announce(h, bad))).code, bad.join()).toBe("WRITE_NOT_ALLOWED");
        }
        qa.maxattachments = 1;
        expect((await errOf(announce(h, files(["a.txt", "a"], ["b.txt", "b"])))).code).toBe("WRITE_NOT_ALLOWED");
        qa.maxattachments = 0;
        qa.maxbytes = 2;
        expect((await errOf(announce(h, files(["c.txt", "abc"])))).message).toMatch(/máximo es 2/);
        qa.maxbytes = 0;
        h.forums.canAttach = false;
        expect((await errOf(announce(h, [one!]))).code).toBe("MOODLE_PERMISSION_DENIED");
        expect(h.forums.uploads).toHaveLength(0);
    });

    it("allowlist: attachmentsid sólo entero; borrar del borrador sólo en / y con archivos", () => {
        const code = (fn: string, flat: [string, string][]) => {
            try {
                checkWriteRest(fn, flat, SITE);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        const base: [string, string][] = [["forumid", "1"], ["subject", "s"], ["message", "m"], ["groupid", "-1"], ["options[0][name]", "discussionsubscribe"], ["options[0][value]", "1"], ["options[1][name]", "discussionpinned"], ["options[1][value]", "0"]];
        expect(code("mod_forum_add_discussion", [...base, ["options[2][name]", "attachmentsid"], ["options[2][value]", "123"]])).toBe("OK");
        expect(code("mod_forum_add_discussion", [...base, ["options[2][name]", "attachmentsid"], ["options[2][value]", "x"]])).toBe("POLICY_DENIED");
        expect(code("mod_forum_add_discussion", [...base, ["options[2][name]", "inlineattachmentsid"], ["options[2][value]", "1"]])).toBe("POLICY_DENIED");
        expect(code("core_files_delete_draft_files", [["draftitemid", "5"], ["files[0][filepath]", "/"], ["files[0][filename]", "a.txt"]])).toBe("OK");
        expect(code("core_files_delete_draft_files", [["draftitemid", "5"], ["files[0][filepath]", "/x/"], ["files[0][filename]", "a.txt"]])).toBe("POLICY_DENIED");
        expect(code("core_files_delete_draft_files", [["draftitemid", "5"]])).toBe("POLICY_DENIED");
        expect(code("core_files_delete_draft_files", [["draftitemid", "5"], ["files[0][filepath]", "/"], ["files[0][filename]", "../a"]])).toBe("POLICY_DENIED");
    });
});

