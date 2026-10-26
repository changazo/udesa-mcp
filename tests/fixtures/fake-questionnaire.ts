/**
 * Encuesta sintética CON ESTADO (mod_questionnaire; ADR-097): página de preguntas, formulario de una
 * pregunta (agregar por type_id, editar por qid) y borrado por delq. Como el plugin real, guardar y borrar
 * responden con la página de preguntas (200), no con una redirección. Datos 100 % inventados.
 */
import { SITE, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";

export const QNR_CMID = 9950;
interface Q {
    id: number;
    type: number;
    name: string;
    required: string;
    content: string;
    choices: string;
    length: string;
    precise: string;
}
const LABELS: Record<number, string> = { 1: "Sí/No", 2: "Cuadro de texto", 3: "Texto amplio", 4: "Botones de radio", 5: "Comprobar Casillas", 6: "Lista desplegable", 8: "Escala Likert", 9: "Fecha", 10: "Numérico", 100: "Descripción" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export class SyntheticQuestionnaire {
    readonly questions: Q[] = [{ id: 32, type: 4, name: "Sentido", required: "y", content: "<p>¿Cuál?</p>", choices: "Uno\nDos", length: "0", precise: "0" }];
    noop = false;
    private seq = 40;

    constructor(fake: FakeMoodle) {
        fake.web.pages.set("/mod/questionnaire/questions.php", (q, req) => {
            if (Number(q.id ?? new URLSearchParams(req.body ?? "").get("id")) !== QNR_CMID) return { body: "<html>no</html>" };
            if (req.method === "GET") return { body: q.action === "question" ? this.formHtml(q) : this.mainHtml(q.moveq ? Number(q.moveq) : undefined) };
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("sesskey") !== WEB_SESSKEY) return { body: "<html>sesskey</html>" };
            const here = [...b.keys()].map((k) => /^moveherebutton\[(\d+)\]$/.exec(k)?.[1]).find(Boolean);
            if (b.get("moveq") && here) {
                const i = this.questions.findIndex((x) => x.id === Number(b.get("moveq")));
                if (!this.noop && i >= 0) this.questions.splice(Number(here) - 1, 0, ...this.questions.splice(i, 1));
                return { body: this.mainHtml() };
            }
            if (b.get("delq")) {
                if (!this.noop) this.questions.splice(this.questions.findIndex((x) => x.id === Number(b.get("delq"))), 1);
                return { body: this.mainHtml() };
            }
            if (b.get("_qf__mod_questionnaire_edit_question_form") !== "1") return { body: "<html>no</html>" };
            const qid = Number(b.get("qid"));
            const data = { name: b.get("name") ?? "", required: b.get("required") ?? "n", content: b.get("content[text]") ?? "", choices: b.get("allchoices") ?? "", length: b.get("length") ?? "0", precise: b.get("precise") ?? "0" };
            if (!this.noop) {
                if (qid) Object.assign(this.questions.find((x) => x.id === qid)!, data);
                else this.questions.push({ id: this.seq++, type: Number(b.get("type_id")), ...data });
            }
            return { body: this.mainHtml() };
        });
    }

    private mainHtml(moveq?: number): string {
        const rows = this.questions.map((x, i) => `<div class="qn-container"><div class="qnums">posición ${i + 1}</div><input value="${x.id}" name="movebutton[${x.id}]" type="image"><input value="${x.id}" name="editbutton[${x.id}]" type="image"><input value="${x.id}" name="removebutton[${x.id}]" type="image"> [${LABELS[x.type]}] (${esc(x.name)})</div>`).join("");
        return `<html><body><form action="questions.php" method="post"><input type="hidden" name="id" value="${QNR_CMID}"><input type="hidden" name="_qf__mod_questionnaire_questions_form" value="1"><select name="type_id"><option value="4" selected>Radio</option></select>${moveq ? `<input type="hidden" name="moveq" value="${moveq}">${this.questions.map((x, i) => (x.id === moveq ? "" : `<input type="image" name="moveherebutton[${i + 1}]" value="${x.id}">`)).join("")}` : ""}${rows}<input type="submit" name="addqbutton" value="Añadir"></form></body></html>`;
    }

    private formHtml(q: Record<string, string>): string {
        const x = q.qid ? this.questions.find((y) => y.id === Number(q.qid)) : undefined;
        if (q.qid && !x) return "<html><body>No existe</body></html>";
        const type = x?.type ?? Number(q.type_id);
        const radio = (name: string, value: string, cur: string) => `<input type="radio" name="${name}" value="${value}"${cur === value ? " checked" : ""}>`;
        return `<html><body><form action="${SITE}/mod/questionnaire/questions.php" method="post"><input type="hidden" name="id" value="${QNR_CMID}"><input type="hidden" name="qid" value="${x?.id ?? 0}"><input type="hidden" name="type_id" value="${type}"><input type="hidden" name="action" value="question"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__mod_questionnaire_edit_question_form" value="1"><input type="text" name="name" value="${esc(x?.name ?? "")}">${type === 100 ? "" : radio("required", "y", x?.required ?? "n") + radio("required", "n", x?.required ?? "n")}<input type="text" name="length" value="${x?.length ?? "0"}"><input type="text" name="precise" value="${x?.precise ?? "0"}"><textarea name="content[text]">${esc(x?.content ?? "")}</textarea><input type="hidden" name="content[format]" value="1">${[4, 5, 6, 8].includes(type) ? `<textarea name="allchoices">${esc(x?.choices ?? "")}</textarea>` : ""}<input type="submit" name="submitbutton" value="Guardar"></form></body></html>`;
    }
}
