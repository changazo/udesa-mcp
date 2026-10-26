/**
 * Cuestionarios sintéticos CON ESTADO (alta por formulario y overrides por AJAX). Datos inventados.
 * Trampas ([T] §20 y prueba real): los overrides no visibles se descartan sin aviso (ids vacío);
 * el límite de tiempo sólo se guarda con la casilla timelimit[enabled].
 */
import { COURSE, SITE, STUDENT_A, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";
import type { SyntheticW2 } from "./fake-w2.js";

export const QUIZ_ID = 7701;
export const QUIZ_CMID = 9701;

interface Quiz {
    id: number;
    cmid: number;
    name: string;
    timeopen: number;
    timeclose: number;
    timelimit: number;
    attempts: number;
}
interface Override {
    id: number;
    quiz: number;
    userid: number | null;
    groupid?: number | null;
    timeopen: number | null;
    timeclose: number | null;
    timelimit: number | null;
    attempts: number | null;
    password: string | null;
}

/** Fecha del selector (zona -03:00) → Unix; 0 sin casilla. */
function selector(b: URLSearchParams, key: string): number {
    if (b.get(`${key}[enabled]`) !== "1") return 0;
    const n = (k: string) => Number(b.get(`${key}[${k}]`) ?? 0);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") + 3, n("minute")) / 1000;
}

export class SyntheticQuizzes {
    readonly quizzes: Quiz[] = [{ id: QUIZ_ID, cmid: QUIZ_CMID, name: "Cuestionario sintético", timeopen: 0, timeclose: 0, timelimit: 0, attempts: 0 }];
    readonly overrides: Override[] = [];
    /** Moodle descarta el override (no visible) y devuelve ids vacío. */
    dropSilently = false;
    readonly posts: Record<string, string>[] = [];
    private seq = 3000;

    constructor(fake: FakeMoodle, w2: SyntheticW2) {
        w2.extraModules.push({ id: QUIZ_CMID, modname: "quiz", name: "Cuestionario sintético", section: 3, visible: true });
        fake.overrides.set("mod_quiz_get_quizzes_by_courses", () => ({ quizzes: this.quizzes.map((q) => ({ ...q, coursemodule: q.cmid, course: COURSE })), warnings: [] }));
        fake.web.ajax.set("mod_quiz_get_overrides", (a) => ({ overrides: this.overrides.filter((o) => o.quiz === Number(a.quizid)) }));
        fake.web.ajax.set("mod_quiz_save_overrides", (a) => {
            const d = a.data as { quizid: number; overrides: Record<string, number>[] };
            if (this.dropSilently) return { ids: [] };
            const o = d.overrides[0]!;
            if (this.overrides.some((x) => x.quiz === d.quizid && (o.groupid ? x.groupid === o.groupid : x.userid === o.userid))) throw Object.assign(new Error("Ya existe"), { errorcode: "invalidparameter" });
            const id = this.seq++;
            this.overrides.push({ id, quiz: d.quizid, userid: o.userid ?? null, groupid: o.groupid ?? null, timeopen: o.timeopen ?? null, timeclose: o.timeclose ?? null, timelimit: o.timelimit ?? null, attempts: o.attempts ?? null, password: "SECRETO-NO-DEBE-SALIR" });
            return { ids: [id] };
        });
        // Edición de una excepción existente por formulario (ADR-099): la contraseña se conserva.
        const dateHtml = (key: string, unix: number | null) => {
            const d = new Date((unix ?? 0) * 1000 - 3 * 3600_000);
            const parts: [string, number][] = [["day", d.getUTCDate()], ["month", d.getUTCMonth() + 1], ["year", d.getUTCFullYear()], ["hour", d.getUTCHours()], ["minute", d.getUTCMinutes()]];
            return `<input type="checkbox" name="${key}[enabled]" value="1"${unix ? " checked" : ""}>${parts.map(([k, v]) => `<select name="${key}[${k}]"><option value="${v}" selected>${v}</option></select>`).join("")}`;
        };
        fake.web.pages.set("/mod/quiz/overrideedit.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const o = this.overrides.find((x) => x.id === Number(q.id ?? b.get("id")));
            if (!o) return { body: "<html><body>No existe</body></html>" };
            if (req.method === "GET")
                return { body: `<html><body><form method="post"><input type="hidden" name="id" value="${o.id}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__mod_quiz_form_edit_override_form" value="1"><input type="hidden" name="userid" value="${o.userid ?? ""}"><input type="password" name="password" value="${o.password ?? ""}">${dateHtml("timeopen", o.timeopen)}${dateHtml("timeclose", o.timeclose)}<input type="text" name="timelimit[number]" value="${(o.timelimit ?? 0) / 60}"><select name="timelimit[timeunit]"><option value="60" selected>min</option></select><input type="checkbox" name="timelimit[enabled]" value="1"${o.timelimit ? " checked" : ""}><select name="attempts">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}"${(o.attempts ?? 0) === n ? " selected" : ""}>${n}</option>`).join("")}</select><input type="submit" name="submitbutton" value="Guardar"></form></body></html>` };
            if (b.get("sesskey") !== WEB_SESSKEY) return { body: "<html>sesskey</html>" };
            this.posts.push(Object.fromEntries(b));
            Object.assign(o, { timeopen: selector(b, "timeopen") || null, timeclose: selector(b, "timeclose") || null, timelimit: b.get("timelimit[enabled]") === "1" ? Number(b.get("timelimit[number]")) * 60 : null, attempts: Number(b.get("attempts") ?? 0) || null, password: b.get("password") });
            return { status: 303, body: null, headers: { location: `${SITE}/mod/quiz/overrides.php?cmid=${QUIZ_CMID}` } };
        });
        fake.web.ajax.set("mod_quiz_delete_overrides", (a) => {
            const d = a.data as { quizid: number; ids: number[] };
            const i = this.overrides.findIndex((o) => o.id === d.ids[0] && o.quiz === d.quizid);
            if (i < 0) throw Object.assign(new Error("No existe"), { errorcode: "overridemissingdelete" });
            this.overrides.splice(i, 1);
            return { ids: d.ids };
        });
        const modedit = fake.web.pages.get("/course/modedit.php")!;
        fake.web.pages.set("/course/modedit.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            if (q.add !== "quiz" && !b.get("_qf__mod_quiz_mod_form")) return modedit(q, req);
            if (req.method === "GET") {
                const date = (k: string) => `<input type="checkbox" name="${k}[enabled]" value="1">${["day", "month", "year", "hour", "minute"].map((p) => `<select name="${k}[${p}]"><option value="1" selected>1</option></select>`).join("")}`;
                return {
                    body: `<html><body><form action="${SITE}/course/modedit.php" method="post"><input type="hidden" name="course" value="${q.course}"><input type="hidden" name="section" value="${q.section}"><input type="hidden" name="add" value="quiz"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__mod_quiz_mod_form" value="1"><input type="text" name="name" value=""><textarea name="introeditor[text]"></textarea><input type="hidden" name="introeditor[format]" value="1">${date("timeopen")}${date("timeclose")}<input type="checkbox" name="timelimit[enabled]" value="1"><input type="text" name="timelimit[number]" value="0"><select name="timelimit[timeunit]"><option value="60" selected>min</option></select><select name="attempts"><option value="0" selected>0</option></select><input type="text" name="quizpassword" value=""><select name="visible"><option value="1" selected>1</option><option value="0">0</option></select><input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>`,
                };
            }
            this.posts.push(Object.fromEntries(b));
            const id = this.seq++;
            const cmid = 9800 + this.quizzes.length;
            const tl = b.get("timelimit[enabled]") === "1" ? Number(b.get("timelimit[number]")) * 60 : 0; // trampa real
            this.quizzes.push({ id, cmid, name: b.get("name") ?? "", timeopen: selector(b, "timeopen"), timeclose: selector(b, "timeclose"), timelimit: tl, attempts: Number(b.get("attempts") ?? 0) });
            w2.extraModules.push({ id: cmid, modname: "quiz", name: b.get("name") ?? "", section: Number(b.get("section")), visible: b.get("visible") === "1" });
            return { status: 303, body: null, headers: { location: `${SITE}/mod/quiz/view.php?id=${cmid}` } };
        });
    }

    overrideFor(userId: number) {
        return this.overrides.find((o) => o.userid === userId);
    }
}

export { STUDENT_A };
