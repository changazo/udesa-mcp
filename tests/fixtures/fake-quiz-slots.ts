/**
 * Estructura sintética de un cuestionario CON ESTADO: edit.php?addquestion (agrega un slot y
 * redirige) y edit_rest.php action=DELETE (quita un slot y responde {"deleted":true}). Con intentos,
 * Moodle rechaza ambas (check_can_be_edited). Datos inventados.
 */
import { SITE, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";
import { QUIZ_CMID, QUIZ_ID } from "./fake-quiz.js";
import type { SyntheticQuestionBank } from "./fake-qimport.js";

export class SyntheticQuizSlots {
    readonly slots: { id: number; qid: number; random?: { category: number; sub: boolean }; max?: number }[] = [{ id: 501, qid: 9001 }];
    /** Moodle no aplica la nota máxima (para probar sin_efecto). */
    maxNoop = false;
    hasAttempts = false;
    /** Slots (por id) SIN salto de página después: van en la misma página que el siguiente. */
    readonly joined = new Set<number>();
    /** Secciones: `firstslot` = número de slot donde empieza (la primera, en 1). */
    readonly sections: { id: number; firstslot: number; heading: string; shuffle: boolean }[] = [{ id: 700, firstslot: 1, heading: "", shuffle: false }];
    /** Moodle «acepta» los cambios de páginas y secciones sin aplicarlos. */
    layoutNoop = false;
    /** Moodle agrega OTRA pregunta (para probar diferencias). */
    wrongQuestion = false;
    private seq = 600;

    constructor(fake: FakeMoodle, bank: SyntheticQuestionBank) {
        const slotHtml = (qid: number) => {
            const q = bank.questions.find((x) => x.id === qid);
            return `<span class="questionname">${q?.name ?? "?"}</span><a href="${SITE}/question/bank/editquestion/question.php?id=${qid}&amp;cmid=${QUIZ_CMID}">editar</a>`;
        };
        const randomHtml = (r: { category: number; sub: boolean }) => {
            const filter = encodeURIComponent(JSON.stringify({ category: { jointype: 1, values: [String(r.category)], filteroptions: { includesubcategories: r.sub } } }));
            return `<a data-action="editrandomquestion" href="#">x</a> Aleatoria <a class="mod_quiz_random_qbank_link" href="${SITE}/question/edit.php?cmid=${QUIZ_CMID}&amp;filter=${filter}">ver</a>`;
        };
        fake.web.ajax.set("mod_quiz_get_edit_grading_page_data", (a) =>
            JSON.stringify({ quizid: a.quizid, sections: Number(a.quizid) === QUIZ_ID ? [{ displayname: "S", slots: this.slots.map((s, i) => ({ id: s.id, displaynumber: String(i + 1), displayname: s.random ? randomHtml(s.random) : slotHtml(s.qid), maxmark: (s.max ?? 1).toFixed(2).replace(".", ","), choices: [] })) }] : [], gradeitems: [] }),
        );
        fake.web.ajax.set("mod_quiz_update_slots", (a) => {
            const o = (a.slots as { id: number; maxmark: number }[])[0]!;
            const s = this.slots.find((x) => x.id === o.id);
            if (!s) throw Object.assign(new Error("slot"), { errorcode: "invalidrecord" });
            if (!this.maxNoop) s.max = o.maxmark;
            return { warnings: [] };
        });
        const pages = () => {
            let page = 0;
            return this.slots.map((s, i) => {
                if (i === 0 || this.sections.some((x) => x.firstslot === i + 1) || !this.joined.has(this.slots[i - 1]!.id)) page++;
                return page;
            });
        };
        const layoutHtml = () => {
            const p = pages();
            let out = "";
            this.slots.forEach((s, i) => {
                const sec = this.sections.find((x) => x.firstslot === i + 1);
                if (sec) out += `${i ? "</ul></li>" : ""}<li id="section-${sec.id}" class="section main clearfix" data-sectionname="x"><h3><span class="sectioninstance"><span class="instancesection${sec.heading ? "" : " visually-hidden"}">${sec.heading || "Sección sin título"}</span></span></h3><input type="checkbox" id="shuffle-${sec.id}" value="1" data-action="shuffle_questions"${sec.shuffle ? ' checked="checked"' : ""} /><ul class="section">`;
                if (i === 0 || p[i] !== p[i - 1]) out += `<li class="pagenumber activity yui3-dd-drop page" id="page-${p[i]}">Página ${p[i]}</li>`;
                out += `<li class="activity slot" id="slot-${s.id}">${i + 1}</li>`;
            });
            return out ? `<ul class="slots">${out}</ul></li></ul>` : "";
        };
        const redirect = { status: 303, body: null, headers: { location: `${SITE}/mod/quiz/edit.php?cmid=${QUIZ_CMID}` } };
        fake.web.pages.set("/mod/quiz/repaginate.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            if (req.method !== "POST" || b.get("sesskey") !== WEB_SESSKEY || b.get("quizid") !== String(QUIZ_ID)) return { body: "<html><body>no</body></html>" };
            if (this.hasAttempts) return denied();
            const s = this.slots[Number(b.get("slot")) - 1];
            if (!s) return { body: "<html><body>no</body></html>" };
            if (!this.layoutNoop) {
                if (b.get("repag") === "1") this.joined.add(s.id);
                else this.joined.delete(s.id);
            }
            return redirect;
        });
        const denied = () => ({ body: `<html><body><div class="box errorbox alert alert-danger"><p class="errormessage">No se puede editar: el cuestionario ya tiene intentos</p></div></body></html>` });
        fake.web.pages.set("/mod/quiz/edit.php", (q, req) => {
            if (req.method === "GET") {
                const warn = this.hasAttempts ? `<div class="statusdisplay">No se pueden agregar ni quitar preguntas porque el cuestionario tiene intentos. (<a href="${SITE}/mod/quiz/report.php?id=${QUIZ_CMID}&amp;mode=overview">Intentos: 3</a>)</div>` : "";
                return { body: `<html><body id="page-mod-quiz-edit"><div role="main"><a href="${SITE}/mod/quiz/report.php?id=${QUIZ_CMID}&amp;mode=overview">Resultados</a>${warn}${layoutHtml()}</div></body></html>` };
            }
            const b = new URLSearchParams(req.body ?? "");
            if (req.method !== "POST" || b.get("sesskey") !== WEB_SESSKEY || q.cmid !== String(QUIZ_CMID)) return { body: "<html><body>edit</body></html>" };
            if (this.hasAttempts) return denied();
            if (b.get("repaginate") === "1") {
                const per = Number(b.get("questionsperpage"));
                if (!this.layoutNoop) {
                    this.joined.clear();
                    let onPage = 0;
                    this.slots.forEach((s, i) => {
                        if (this.sections.some((x) => x.firstslot === i + 1)) onPage = 0;
                        onPage++;
                        const next = this.slots[i + 1];
                        if (next && !this.sections.some((x) => x.firstslot === i + 2) && (per === 0 || onPage < per)) this.joined.add(s.id);
                        else onPage = 0;
                    });
                }
                return redirect;
            }
            if (q.addsectionatpage) {
                const first = pages().indexOf(Number(q.addsectionatpage));
                if (first < 1) return { body: "<html><body><div class=\"box errorbox\"><p class=\"errormessage\">No</p></div></body></html>" };
                if (!this.layoutNoop) this.sections.push({ id: this.seq++, firstslot: first + 1, heading: "", shuffle: false });
                this.sections.sort((a, b2) => a.firstslot - b2.firstslot);
                return redirect;
            }
            if (b.get("addrandom") === "1") {
                for (let i = 0; i < Number(b.get("randomcount")); i++) this.slots.push({ id: this.seq++, qid: 0, random: { category: Number(b.get("categoryid")), sub: b.get("recurse") === "1" } });
                return { status: 303, body: null, headers: { location: `${SITE}/mod/quiz/edit.php?cmid=${QUIZ_CMID}` } };
            }
            const qid = Number(b.get("addquestion"));
            if (!bank.questions.some((x) => x.id === qid)) return { body: `<html><body><div class="box errorbox"><p class="errormessage">No existe</p></div></body></html>` };
            this.slots.push({ id: this.seq++, qid: this.wrongQuestion ? 9001 : qid });
            return { status: 303, body: null, headers: { location: `${SITE}/mod/quiz/edit.php?cmid=${QUIZ_CMID}` } };
        });
        fake.web.pages.set("/mod/quiz/edit_rest.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("sesskey") === WEB_SESSKEY && b.get("class") === "section") {
                const sec = this.sections.find((x) => x.id === Number(b.get("id")));
                if (!sec) return { body: "<html><body><div class=\"box errorbox\"><p class=\"errormessage\">Bad section ID</p></div></body></html>" };
                if (b.get("action") === "DELETE") {
                    if (this.hasAttempts) return denied();
                    if (!this.layoutNoop) this.sections.splice(this.sections.indexOf(sec), 1);
                    return { body: JSON.stringify({ deleted: true }), contentType: "application/json" };
                }
                if (b.get("field") === "updatesectiontitle") {
                    if (!this.layoutNoop) sec.heading = b.get("newheading") ?? "";
                    return { body: JSON.stringify({ instancesection: sec.heading }), contentType: "application/json" };
                }
                if (!this.layoutNoop) sec.shuffle = b.get("newshuffle") === "1";
                return { body: JSON.stringify({ instanceshuffle: sec.shuffle ? 1 : 0 }), contentType: "application/json" };
            }
            if (b.get("sesskey") !== WEB_SESSKEY || b.get("action") !== "DELETE" || b.get("class") !== "resource") return { body: "null" };
            if (this.hasAttempts) return denied();
            const i = this.slots.findIndex((s) => s.id === Number(b.get("id")));
            if (i < 0) return { body: `<html><body><div class="box errorbox"><p class="errormessage">Bad slot ID</p></div></body></html>` };
            this.slots.splice(i, 1);
            return { body: JSON.stringify({ newsummarks: "1,00", deleted: true, newnumquestions: this.slots.length }), contentType: "application/json" };
        });
    }
}
