/**
 * Contenido sintético CON ESTADO: altas de página, URL, etiqueta y recurso por modedit.php (con el
 * archivo del recurso desde un borrador de upload.php). Datos inventados. La etiqueta vuelve al
 * curso (submitbutton2) sin cmid en la redirección.
 */
import { COURSE, SITE, USER_ID, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";
import type { SyntheticW2 } from "./fake-w2.js";

const QF: Record<string, string> = { page: "_qf__mod_page_mod_form", url: "_qf__mod_url_mod_form", label: "_qf__mod_label_mod_form", resource: "_qf__mod_resource_mod_form", forum: "_qf__mod_forum_mod_form" };

export class SyntheticContent {
    readonly pages = new Map<number, string>();
    readonly urls = new Map<number, string>();
    readonly resources = new Map<number, { filename: string; filesize: number }[]>();
    readonly forums = new Map<number, { forcesubscribe: number; grade_forum: number }>();
    readonly drafts = new Map<number, { filename: string; filesize: number }[]>();
    readonly posts: Record<string, string>[] = [];
    /** Moodle guarda otra URL (para probar diferencias). */
    mangleUrl = false;
    private seq = 9900;

    constructor(fake: FakeMoodle, w2: SyntheticW2) {
        fake.upload = async (form) => {
            const itemid = 888_000 + this.drafts.size + 1;
            const files = [...form.entries()].filter(([k]) => k.startsWith("file_")).map(([, v]) => v as File);
            this.drafts.set(itemid, files.map((f) => ({ filename: f.name, filesize: f.size })));
            return files.map((f) => ({ filename: f.name, filepath: "/", itemid, userid: USER_ID }));
        };
        fake.overrides.set("mod_page_get_pages_by_courses", () => ({ pages: [...this.pages].map(([cm, content]) => ({ coursemodule: cm, course: COURSE, content })), warnings: [] }));
        fake.overrides.set("mod_url_get_urls_by_courses", () => ({ urls: [...this.urls].map(([cm, externalurl]) => ({ coursemodule: cm, course: COURSE, externalurl })), warnings: [] }));
        fake.overrides.set("mod_forum_get_forums_by_courses", () => [...this.forums].map(([cm, f]) => ({ id: cm + 1, cmid: cm, course: COURSE, ...f })));
        fake.overrides.set("mod_resource_get_resources_by_courses", () => ({ resources: [...this.resources].map(([cm, contentfiles]) => ({ coursemodule: cm, course: COURSE, contentfiles })), warnings: [] }));
        const modedit = fake.web.pages.get("/course/modedit.php")!;
        fake.web.pages.set("/course/modedit.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const kind = Object.keys(QF).find((k) => q.add === k || b.get(QF[k]!) === "1");
            if (!kind) return modedit(q, req);
            if (req.method === "GET") {
                const button = kind === "label" ? "submitbutton2" : "submitbutton";
                return {
                    body: `<html><body><form action="${SITE}/course/modedit.php" method="post"><input type="hidden" name="course" value="${q.course}"><input type="hidden" name="section" value="${q.section}"><input type="hidden" name="add" value="${kind}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="${QF[kind]}" value="1"><input type="text" name="name" value=""><textarea name="introeditor[text]"></textarea><input type="hidden" name="introeditor[format]" value="1">${kind === "forum" ? '<input type="hidden" name="forcesubscribe" value="2"><input type="hidden" name="grade_forum[modgrade_type]" value="none"><input type="hidden" name="grade_forum_notify" value="1"><input type="hidden" name="type" value="general">' : ""}${kind === "resource" ? '<input type="hidden" name="files" value="111">' : ""}<select name="visible"><option value="1" selected>1</option><option value="0">0</option></select><input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="${button}" value="Guardar"></form></body></html>`,
                };
            }
            this.posts.push(Object.fromEntries(b));
            const cmid = this.seq++;
            const name = b.get("name") ?? "";
            if (kind === "page") this.pages.set(cmid, b.get("page[text]") ?? "");
            if (kind === "url") this.urls.set(cmid, this.mangleUrl ? "https://otro.example/" : (b.get("externalurl") ?? ""));
            if (kind === "forum") this.forums.set(cmid, { forcesubscribe: Number(b.get("forcesubscribe") ?? 2), grade_forum: b.get("grade_forum[modgrade_type]") === "point" ? Number(b.get("grade_forum[modgrade_point]")) : 0 });
            if (kind === "resource") {
                const files = this.drafts.get(Number(b.get("files")));
                if (!files?.length) return { body: `<html><body><form><input type="hidden" name="${QF.resource}" value="1"><span class="error" id="id_error_files">Requerido</span></form></body></html>` };
                this.resources.set(cmid, files);
            }
            w2.extraModules.push({ id: cmid, modname: kind, name, section: Number(b.get("section")), visible: b.get("visible") === "1", ...(kind === "label" ? { description: b.get("introeditor[text]") ?? "" } : {}) });
            const location = kind === "label" ? `${SITE}/course/view.php?id=${COURSE}#section-${b.get("section")}` : `${SITE}/mod/${kind}/view.php?id=${cmid}`;
            return { status: 303, body: null, headers: { location } };
        });
    }
}
