/**
 * Calificación avanzada sintética CON ESTADO (ADR-095): una tarea con área de calificación, editores de
 * rúbrica y guía (manage.php, form/<método>/edit.php) y el formulario CLÁSICO de calificación
 * (view.php?action=grade) con escala, rúbrica, guía, comentario, estado del flujo y archivos de
 * retroalimentación en un borrador. Datos 100 % inventados. Usa los borradores de SyntheticActivities.
 */
import { COURSE, SITE, STUDENT_A, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";
import type { SyntheticActivities } from "./fake-activities.js";
import type { SyntheticW2 } from "./fake-w2.js";

export const G_ASSIGN = 8650;
export const G_CMID = 9900;
export const G_CONTEXT = 99000;
export const G_AREA = 600;

type Method = "points" | "scale" | "rubric" | "guide";
interface Def {
    name: string;
    rubric: { id: number; description: string; levels: { id: number; definition: string; score: number }[] }[];
    guide: { id: number; shortname: string; description: string; markers: string; max: number }[];
    comments: string[];
}
interface UserState {
    grade: string | null;
    rubric: Map<number, { level: number; remark: string }>;
    guide: Map<number, { score: string; remark: string }>;
    comment: string;
    files: string[];
    workflow: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class SyntheticGrading {
    method: Method = "rubric";
    scale = [
        { value: "1", label: "Desaprobado" },
        { value: "2", label: "Aprobado" },
    ];
    def: Def | null = null;
    defid = 0;
    workflowEnabled = false;
    readonly users = new Map<number, UserState>();
    /** Formularios de calificación recibidos (para comprobar lo que se envió). */
    readonly posts: Record<string, string>[] = [];
    /** Moodle «acepta» pero no guarda (para sin_efecto). */
    noop = false;
    private seq = 3000;

    constructor(fake: FakeMoodle, w2: SyntheticW2, private readonly acts: SyntheticActivities) {
        w2.assignments.push({ id: G_ASSIGN, cmid: G_CMID, name: "Tarea avanzada", section: 1, visible: true, grade: 10, duedate: 0, allowsubmissionsfromdate: 0, cutoffdate: 0, gradingduedate: 0, timemodified: 0 });
        const o = fake.overrides;
        const wrap = (fn: string, mine: (p: Record<string, string>) => boolean, handler: (p: Record<string, string>) => unknown) => {
            const prev = o.get(fn);
            o.set(fn, (p) => (mine(p) ? handler(p) : prev!(p)));
        };
        const contents = o.get("core_course_get_contents")!;
        o.set("core_course_get_contents", (p) => (contents(p) as { modules: { id: number; contextid?: number }[] }[]).map((s) => ({ ...s, modules: s.modules.map((m) => (m.id === G_CMID ? { ...m, contextid: G_CONTEXT } : m)) })));
        wrap("mod_assign_list_participants", (p) => Number(p.assignid) === G_ASSIGN, () => [{ id: STUDENT_A, fullname: "Estudiante A", submissionstatus: "submitted" }]);
        wrap("mod_assign_get_grades", (p) => Number(p["assignmentids[0]"]) === G_ASSIGN, () => ({
            assignments: [{ assignmentid: G_ASSIGN, grades: [...this.users.entries()].filter(([, u]) => u.grade !== null || u.rubric.size || u.guide.size).map(([userid, u]) => ({ userid, attemptnumber: 0, grade: this.computed(u) })) }],
            warnings: [],
        }));
        wrap("mod_assign_get_submission_status", (p) => Number(p.assignid) === G_ASSIGN, (p) => {
            const u = this.users.get(Number(p.userid));
            return { feedback: u ? { plugins: [{ type: "comments", editorfields: [{ name: "comments", text: u.comment, format: 1 }] }, { type: "file", fileareas: [{ area: "feedback_files", files: u.files.map((filename) => ({ filename, filesize: 1 })) }] }] } : null, lastattempt: { submission: { id: 1, userid: Number(p.userid), status: "submitted" } }, warnings: [] };
        });
        const web = fake.web.pages;
        web.set("/grade/grading/manage.php", (q, req) => {
            if (req.method === "POST") {
                const b = new URLSearchParams(req.body ?? "");
                if (b.get("sesskey") !== WEB_SESSKEY || Number(b.get("areaid")) !== G_AREA || Number(b.get("deleteform")) !== this.defid || b.get("confirmed") !== "1") return { body: "<html><body>no</body></html>" };
                if (!this.noop) this.def = null;
                return { status: 303, body: null, headers: { location: `${SITE}/grade/grading/manage.php?areaid=${G_AREA}` } };
            }
            if (Number(q.contextid) !== G_CONTEXT) return { status: 404, body: "<html>no</html>" };
            const editor = this.method === "rubric" || this.method === "guide" ? `<a href="${SITE}/grade/grading/form/${this.method}/edit.php?areaid=${G_AREA}">Editar</a>` : "";
            const del = this.def ? `<a href="${SITE}/grade/grading/manage.php?areaid=${G_AREA}&amp;deleteform=${this.defid}">Borrar</a>` : "";
            return { body: `<html><body><a href="${SITE}/grade/grading/manage.php?areaid=${G_AREA}&amp;setmethod=">m</a>${editor}${del}</body></html>` };
        });
        for (const m of ["rubric", "guide"] as const) {
            web.set(`/grade/grading/form/${m}/edit.php`, (q, req) => {
                if (req.method === "GET") return { body: this.editorHtml(m) };
                const b = new URLSearchParams(req.body ?? "");
                if (b.get("sesskey") !== WEB_SESSKEY || b.get(`_qf__gradingform_${m}_edit${m}`) !== "1") return { body: "<html><body>no</body></html>" };
                if (!this.noop) this.saveDefinition(m, b);
                return { status: 303, body: null, headers: { location: `${SITE}/grade/grading/manage.php?areaid=${G_AREA}` } };
            });
        }
        web.set("/mod/assign/view.php", (q, req) => {
            if (req.method === "GET") {
                if (q.action !== "grade" || Number(q.id) !== G_CMID) return { body: "<html><body>tarea</body></html>" };
                return { body: this.gradeFormHtml(Number(q.userid)) };
            }
            const b = new URLSearchParams(req.body ?? "");
            const uid = Number(b.get("userid"));
            if (b.get("sesskey") !== WEB_SESSKEY || b.get(`_qf__mod_assign_grade_form_${uid}`) !== "1" || b.get("action") !== "submitgrade") return { body: "<html><body>no</body></html>" };
            this.posts.push(Object.fromEntries(b));
            if (!this.noop) this.saveGrade(uid, b);
            return { status: 303, body: null, headers: { location: `${SITE}/mod/assign/view.php?id=${G_CMID}&action=grading` } };
        });
    }

    user(uid: number): UserState {
        if (!this.users.has(uid)) this.users.set(uid, { grade: null, rubric: new Map(), guide: new Map(), comment: "", files: [], workflow: "notmarked" });
        return this.users.get(uid)!;
    }

    /** Nota que guardaría Moodle (rúbrica: suma/máximo × 10; guía: suma de puntajes). */
    private computed(u: UserState): string {
        if (this.method === "rubric" && this.def) {
            const max = this.def.rubric.reduce((s, c) => s + Math.max(...c.levels.map((l) => l.score)), 0);
            const sum = this.def.rubric.reduce((s, c) => s + (c.levels.find((l) => l.id === u.rubric.get(c.id)?.level)?.score ?? 0), 0);
            return ((sum / max) * 10).toFixed(5);
        }
        if (this.method === "guide") return [...u.guide.values()].reduce((s, g) => s + Number(g.score), 0).toFixed(5);
        return Number(u.grade ?? -1).toFixed(5);
    }

    private editorHtml(m: "rubric" | "guide"): string {
        const d = this.def;
        let rows = "";
        if (m === "rubric") {
            const crit = d?.rubric.length ? d.rubric : [{ id: 0, description: "", levels: [0, 1, 2].map((i) => ({ id: i, definition: "", score: i })) }];
            crit.forEach((c, i) => {
                const cid = c.id ? String(c.id) : "NEWID1";
                rows += `<input type="hidden" name="rubric[criteria][${cid}][sortorder]" value="${i + 1}"><textarea name="rubric[criteria][${cid}][description]">${esc(c.description)}</textarea>`;
                for (const l of c.levels) {
                    const lid = c.id ? String(l.id) : `NEWID${l.id}`;
                    rows += `<textarea name="rubric[criteria][${cid}][levels][${lid}][definition]">${esc(l.definition)}</textarea><input type="text" name="rubric[criteria][${cid}][levels][${lid}][score]" value="${l.score}"><input type="submit" name="rubric[criteria][${cid}][levels][${lid}][delete]" value="Eliminar">`;
                }
            });
        } else {
            const crit = d?.guide.length ? d.guide : [{ id: 0, shortname: "", description: "", markers: "", max: 0 }];
            crit.forEach((c, i) => {
                const cid = c.id ? String(c.id) : "NEWID1";
                rows += `<input type="hidden" name="guide[criteria][${cid}][sortorder]" value="${i + 1}"><input type="text" name="guide[criteria][${cid}][shortname]" value="${esc(c.shortname)}"><textarea name="guide[criteria][${cid}][description]">${esc(c.description)}</textarea><textarea name="guide[criteria][${cid}][descriptionmarkers]">${esc(c.markers)}</textarea><input type="text" name="guide[criteria][${cid}][maxscore]" value="${c.id ? c.max : ""}">`;
            });
            (d?.comments ?? []).forEach((x, i) => (rows += `<input type="hidden" name="guide[comments][${700 + i}][sortorder]" value="${i + 1}"><textarea name="guide[comments][${700 + i}][description]">${esc(x)}</textarea>`));
        }
        return `<html><body><form action="${SITE}/grade/grading/form/${m}/edit.php" method="post"><input type="hidden" name="areaid" value="${G_AREA}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__gradingform_${m}_edit${m}" value="1"><input type="text" name="name" value="${esc(d?.name ?? "")}">${rows}<input type="submit" name="save${m}" value="Guardar"></form></body></html>`;
    }

    private saveDefinition(m: "rubric" | "guide", b: URLSearchParams) {
        const keys = [...b.keys()];
        const ids = (re: RegExp) => [...new Set(keys.map((k) => re.exec(k)?.[1]).filter((x): x is string => !!x))];
        // Criterios que no llegan se borran (como Moodle): queda exactamente lo enviado.
        const def: Def = { name: b.get("name") ?? "", rubric: [], guide: [], comments: [] };
        if (m === "rubric") {
            for (const c of ids(/^rubric\[criteria\]\[(NEWID\d+)\]\[description\]$/)) {
                const levels = ids(new RegExp(`^rubric\\[criteria\\]\\[${c}\\]\\[levels\\]\\[(NEWID\\d+)\\]\\[definition\\]$`)).map((l) => ({ id: this.seq++, definition: b.get(`rubric[criteria][${c}][levels][${l}][definition]`) ?? "", score: Number(b.get(`rubric[criteria][${c}][levels][${l}][score]`)) }));
                def.rubric.push({ id: this.seq++, description: b.get(`rubric[criteria][${c}][description]`) ?? "", levels });
            }
        } else {
            for (const c of ids(/^guide\[criteria\]\[(NEWID\d+)\]\[shortname\]$/)) {
                const p = `guide[criteria][${c}]`;
                def.guide.push({ id: this.seq++, shortname: b.get(`${p}[shortname]`) ?? "", description: b.get(`${p}[description]`) ?? "", markers: b.get(`${p}[descriptionmarkers]`) ?? "", max: Number(b.get(`${p}[maxscore]`)) });
            }
            def.comments = ids(/^guide\[comments\]\[(NEWID\d+)\]\[description\]$/).map((c) => b.get(`guide[comments][${c}][description]`) ?? "");
        }
        this.def = def;
        this.defid = this.seq++;
    }

    private gradeFormHtml(uid: number): string {
        const u = this.user(uid);
        let body = "";
        // Como Moodle en español: la nota se muestra con coma decimal.
        if (this.method === "points") body = `<input type="text" name="grade" value="${(u.grade ?? "").replace(".", ",")}">`;
        if (this.method === "scale") body = `<select name="grade"><option value="-1">Sin calificación</option>${this.scale.map((s) => `<option value="${s.value}"${u.grade === s.value ? " selected" : ""}>${s.label}</option>`).join("")}</select>`;
        if (this.method === "rubric")
            for (const c of this.def?.rubric ?? []) {
                body += `<td class="description" id="advancedgrading-criteria-${c.id}-description-cell">${esc(c.description)}</td>`;
                for (const l of c.levels) body += `<td id="advancedgrading-criteria-${c.id}-levels-${l.id}"><input type="radio" name="advancedgrading[criteria][${c.id}][levelid]" value="${l.id}"${u.rubric.get(c.id)?.level === l.id ? " checked" : ""} /><div class="definition" id="advancedgrading-criteria-${c.id}-levels-${l.id}-definition-container">${esc(l.definition)}</div><div class="score"><span id="advancedgrading-criteria-${c.id}-levels-${l.id}-score" class="scorevalue">${l.score}</span> puntos</div></td>`;
                body += `<textarea name="advancedgrading[criteria][${c.id}][remark]">${esc(u.rubric.get(c.id)?.remark ?? "")}</textarea>`;
            }
        if (this.method === "guide")
            for (const c of this.def?.guide ?? [])
                body += `<tr class="criterion" id="advancedgrading-criteria-${c.id}"><td><div class="criterionshortname">${esc(c.shortname)}</div></td><td><textarea name="advancedgrading[criteria][${c.id}][remark]">${esc(u.guide.get(c.id)?.remark ?? "")}</textarea></td><td class="score"><input type="text" name="advancedgrading[criteria][${c.id}][score]" value="${u.guide.get(c.id)?.score ?? ""}" /><div>/${c.max}</div></td></tr>`;
        const draft = 777_000 + this.seq++;
        this.acts.drafts.set(draft, u.files.map((filename) => ({ filename, filesize: 1 })));
        const wf = this.workflowEnabled ? `<select name="workflowstate">${["notmarked", "inmarking", "readyforrelease", "released"].map((s) => `<option value="${s}"${u.workflow === s ? " selected" : ""}>${s}</option>`).join("")}</select>` : "";
        return `<html><body><form class="gradeform mform" action="${SITE}/mod/assign/view.php" method="post"><input type="hidden" name="id" value="${G_CMID}"><input type="hidden" name="userid" value="${uid}"><input type="hidden" name="action" value="submitgrade"><input type="hidden" name="attemptnumber" value="-1"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__mod_assign_grade_form_${uid}" value="1">${body}<textarea name="assignfeedbackcomments_editor[text]">${esc(u.comment)}</textarea><input type="hidden" name="assignfeedbackcomments_editor[format]" value="1"><input type="hidden" name="files_${uid}_filemanager" value="${draft}">${wf}<select name="sendstudentnotifications"><option value="1" selected>Sí</option><option value="0">No</option></select><input type="submit" name="savegrade" value="Guardar"></form></body></html>`;
    }

    private saveGrade(uid: number, b: URLSearchParams) {
        const u = this.user(uid);
        if (b.has("grade")) u.grade = b.get("grade") === "-1" ? null : b.get("grade");
        for (const [k, v] of b) {
            const m = /^advancedgrading\[criteria\]\[(\d+)\]\[(levelid|score|remark)\]$/.exec(k);
            if (!m) continue;
            const cid = Number(m[1]);
            if (this.method === "rubric") {
                const cur = u.rubric.get(cid) ?? { level: 0, remark: "" };
                if (m[2] === "levelid") cur.level = Number(v);
                if (m[2] === "remark") cur.remark = v;
                u.rubric.set(cid, cur);
            } else {
                const cur = u.guide.get(cid) ?? { score: "", remark: "" };
                if (m[2] === "score") cur.score = v;
                if (m[2] === "remark") cur.remark = v;
                u.guide.set(cid, cur);
            }
        }
        u.comment = b.get("assignfeedbackcomments_editor[text]") ?? u.comment;
        if (b.has("workflowstate")) u.workflow = b.get("workflowstate")!;
        u.files = (this.acts.drafts.get(Number(b.get(`files_${uid}_filemanager`))) ?? []).map((f) => f.filename).sort();
    }
}
