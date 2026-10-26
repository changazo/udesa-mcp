import { readFileSync, readdirSync } from "node:fs";
import { SITE } from "./fake-moodle.js";
import { type FakeWeb, WEB_SESSKEY } from "./fake-web.js";

/**
 * Editor H5P falso (ADR-110): contexto del curso en el formulario de grupo, banco de contenido con los
 * tipos que ofrece, editor con la clave del AJAX y AJAX de bibliotecas con las semánticas reales de
 * `tests/fixtures/h5p/`. Registra cada pedido para comprobar que no se guarda nada.
 */

export const COURSE_CONTEXT = 7777;
const TOKEN = "tok3n";
const DIR = new URL("./h5p/", import.meta.url);

export class FakeH5pEditor {
    readonly requests: string[] = [];
    readonly semantics = new Map<string, { semantics: unknown[]; language: unknown }>();
    /** Tipos que ofrece el banco de contenido (por defecto, los que arma el MCP). */
    offered = ["H5P.QuestionSet 1.21", "H5P.CoursePresentation 1.27", "H5P.InteractiveBook 1.15", "H5P.InteractiveVideo 1.28", "H5P.BranchingScenario 1.11", "H5P.Dialogcards 1.9", "H5P.Chart 1.2", "H5P.Timeline 1.1", "H5P.Accordion 1.0", "H5P.IFrameEmbed 1.0"];

    constructor(web: FakeWeb) {
        for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
            const lib = f.replace(/\.json$/, "").replace(/-(\d+\.\d+)$/, " $1");
            this.semantics.set(lib, JSON.parse(readFileSync(new URL(f, DIR), "utf8")));
        }
        web.pages.set("/group/group.php", (q) => {
            this.requests.push(`group:${q.courseid}`);
            return { body: `<html><head><script>M.cfg = {"wwwroot":"${SITE}","sesskey":"${WEB_SESSKEY}","contextid":${COURSE_CONTEXT}};</script></head><body><form action="${SITE}/group/group.php" method="post"><input name="name"></form></body></html>` };
        });
        web.pages.set("/contentbank/index.php", (q) => {
            this.requests.push(`contentbank:${q.contextid}`);
            const links = this.offered.map((l) => `<a class="dropdown-item" href="${SITE}/contentbank/edit.php?contextid=${q.contextid}&amp;plugin=h5p&library=${l}">${l}</a>`).join("");
            return { body: `<html><body><div class="dropdown-menu">${links}</div></body></html>` };
        });
        web.pages.set("/contentbank/edit.php", (q) => {
            this.requests.push(`editor:${q.library}`);
            if (q.contextid !== String(COURSE_CONTEXT) || !this.offered.includes(q.library ?? "")) return { status: 404, body: '<html><body><div class="box errorbox alert alert-danger">No disponible</div></body></html>' };
            const ajax = `${SITE}/h5p/ajax.php?sesskey=${WEB_SESSKEY}&token=${TOKEN}&action=`.replace(/\//g, "\\/");
            return { body: `<html><body><script>var H5PIntegration = {"editor":{"ajaxPath":"${ajax}","filesPath":""}};</script></body></html>` };
        });
        web.pages.set("/h5p/ajax.php", (q, req) => {
            if (req.method !== "GET" || q.token !== TOKEN || q.sesskey !== WEB_SESSKEY || q.action !== "libraries") return { status: 403, body: "[]", contentType: "application/json" };
            if (!q.machineName) {
                this.requests.push("libraries");
                const list = [...this.semantics.keys()].filter((l) => this.offered.includes(l)).map((l) => {
                    const [name, v] = l.split(" ");
                    const [major, minor] = v!.split(".").map(Number);
                    return { name, title: name, majorVersion: major, minorVersion: minor };
                });
                return { body: JSON.stringify(list), contentType: "application/json; charset=utf-8" };
            }
            const lib = `${q.machineName} ${q.majorVersion}.${q.minorVersion}`;
            this.requests.push(`library:${lib}`);
            const s = this.semantics.get(lib);
            if (!s) return { body: "null", contentType: "application/json" };
            return { body: JSON.stringify({ name: q.machineName, version: { major: q.majorVersion, minor: q.minorVersion }, semantics: s.semantics, language: s.language ? JSON.stringify(s.language) : null }), contentType: "application/json; charset=utf-8" };
        });
    }
}
