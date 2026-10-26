/**
 * Banco de preguntas sintético CON ESTADO para la importación (formulario import.php + borrador por
 * upload.php) y su deshacer (delete.php confirmado con md5). Datos inventados. Trampa real ([C] §6.2):
 * Moodle NO deduplica: reimportar crea preguntas repetidas.
 */
import { createHash } from "node:crypto";
import { SITE, USER_ID, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";

export const CAT_DEFAULT = 5100;
export const CAT_OTHER = 5101;
export const CTX = 6100;

export class SyntheticQuestionBank {
    readonly questions: { id: number; category: number; name: string; qtype: string }[] = [{ id: 9001, category: CAT_DEFAULT, name: "Existente 1", qtype: "multichoice" }];
    readonly uploaded = new Map<number, { filename: string; content: string }[]>();
    readonly posts: Record<string, string>[] = [];
    /** Preguntas en borrador: no figuran entre los candidatos (inventario). */
    readonly drafts = new Set<number>();
    /** Moodle responde status=false (sin permiso sobre la pregunta). */
    denyStatus = false;
    /** El archivo tiene un error y Moodle aborta (página de error). */
    failImport = false;
    private seq = 9100;

    constructor(fake: FakeMoodle) {
        fake.upload = (form) => {
            const itemid = 777_000 + this.uploaded.size + 1;
            const files = [...form.entries()].filter(([k]) => k.startsWith("file_")).map(([, v]) => v as File);
            const list: { filename: string; content: string }[] = [];
            this.uploaded.set(itemid, list);
            return Promise.all(files.map(async (f) => (list.push({ filename: f.name, content: await f.text() }), { filename: f.name, filepath: "/", itemid, userid: USER_ID }))) as unknown;
        };
        fake.web.ajax.set("core_question_get_random_question_summaries", (a) => {
            const qs = this.questions.filter((q) => q.category === Number(a.categoryid) && Number(a.contextid) === CTX && !this.drafts.has(q.id));
            const off = Number(a.offset);
            return { totalcount: qs.length, questions: qs.slice(off, off + Number(a.limit)).map((q) => ({ id: q.id, category: q.category, name: q.name, qtype: q.qtype })) };
        });
        fake.web.ajax.set("qbank_editquestion_set_status", (a) => {
            const id = Number(a.questionid);
            if (this.denyStatus || !this.questions.some((q) => q.id === id)) return { status: false, error: "" };
            if (a.status === "draft") this.drafts.add(id);
            else this.drafts.delete(id);
            return { status: true, error: "" };
        });
        fake.web.pages.set("/question/bank/importquestions/import.php", (q, req) => {
            if (req.method === "GET") {
                return {
                    body: `<html><body><div role="main"><form action="${SITE}/question/bank/importquestions/import.php" method="post"><input type="hidden" name="cmid" value="${q.cmid}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__qbank_importquestions_form_question_import_form" value="1"><input type="radio" name="format" value="gift"><input type="radio" name="format" value="xml" checked><select name="category"><option value="${CAT_DEFAULT},${CTX}" selected>Por defecto para Cuestionario (1)</option><option value="${CAT_OTHER},${CTX}">&nbsp;&nbsp;&nbsp;Unidad 2 (0)</option></select><input type="checkbox" name="catfromfile" value="1" checked><input type="checkbox" name="contextfromfile" value="1" checked><select name="matchgrades"><option value="error" selected>e</option></select><select name="stoponerror"><option value="1" selected>s</option></select><input type="hidden" name="newfile" value="111"><input type="submit" name="submitbutton" value="Importar"></form></div></body></html>`,
                };
            }
            const b = new URLSearchParams(req.body ?? "");
            this.posts.push(Object.fromEntries(b));
            if (this.failImport) return { body: `<html><body><div class="errorbox alert alert-danger"><p class="errormessage">Error al importar</p></div></body></html>` };
            const file = this.uploaded.get(Number(b.get("newfile")))?.[0];
            const [cat] = (b.get("category") ?? "").split(",").map(Number);
            if (!file) return { body: "<html><body>uploadproblem</body></html>" };
            const names = b.get("format") === "xml" ? [...file.content.matchAll(/<name>\s*<text>([^<]*)<\/text>/g)].map((m) => m[1]!.trim()) : [...file.content.matchAll(/^::([^:]+)::/gm)].map((m) => m[1]!.trim());
            for (const n of names) this.questions.push({ id: this.seq++, category: cat!, name: n, qtype: "multichoice" });
            return { body: `<html><body><div role="main"><p>Importando ${names.length} preguntas</p><form method="get" action="${SITE}/question/edit.php?cmid=${b.get("cmid")}&amp;category=${b.get("category")}"><button type="submit">Continuar</button></form></div></body></html>` };
        });
        fake.web.pages.set("/question/bank/deletequestion/delete.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            this.posts.push(Object.fromEntries(b));
            const list = b.get("deleteselected") ?? "";
            if (b.get("sesskey") !== WEB_SESSKEY || createHash("md5").update(list).digest("hex") !== b.get("confirm")) return { body: `<html><body><div class="errorbox"><p class="errormessage">invalidconfirm</p></div></body></html>` };
            const ids = new Set(list.split(",").map(Number));
            for (let i = this.questions.length - 1; i >= 0; i--) if (ids.has(this.questions[i]!.id)) this.questions.splice(i, 1);
            return { status: 303, body: null, headers: { location: `${SITE}${b.get("returnurl")}` } };
        });
    }

    namesIn(category: number) {
        return this.questions.filter((q) => q.category === category).map((q) => q.name);
    }
}
