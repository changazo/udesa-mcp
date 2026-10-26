/**
 * Edición sintética de fechas por modedit.php?update=<cmid> (tarea y cuestionario). El GET sirve la
 * configuración actual (con casillas de fecha marcadas o no y otros campos que tienen que volver
 * intactos); el POST aplica lo recibido. Datos inventados.
 */
import { SITE, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";
import type { SyntheticW2 } from "./fake-w2.js";
import type { SyntheticQuizzes } from "./fake-quiz.js";

/** Fecha del selector (zona -03:00) → Unix; 0 sin casilla. */
function selector(b: URLSearchParams, key: string): number {
    if (b.get(`${key}[enabled]`) !== "1") return 0;
    const n = (k: string) => Number(b.get(`${key}[${k}]`) ?? 0);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") + 3, n("minute")) / 1000;
}
function dateHtml(key: string, unix: number) {
    const d = new Date((unix || 0) * 1000 - 3 * 3600_000);
    const parts: [string, number][] = [["day", d.getUTCDate()], ["month", d.getUTCMonth() + 1], ["year", d.getUTCFullYear()], ["hour", d.getUTCHours()], ["minute", d.getUTCMinutes()]];
    return `${unix ? `<input type="checkbox" name="${key}[enabled]" value="1" checked>` : `<input type="checkbox" name="${key}[enabled]" value="1">`}${parts.map(([p, v]) => `<select name="${key}[${p}]"><option value="${v}" selected>${v}</option></select>`).join("")}`;
}

export class SyntheticDateEdits {
    readonly posts: Record<string, string>[] = [];
    /** Moodle ignora el cambio de vencimiento (para probar sin_efecto). */
    ignoreDue = false;

    constructor(fake: FakeMoodle, w2: SyntheticW2, quizzes: SyntheticQuizzes) {
        const modedit = fake.web.pages.get("/course/modedit.php")!;
        fake.web.pages.set("/course/modedit.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const cmid = Number(q.update ?? b.get("update") ?? 0);
            const assign = w2.assignments.find((a) => a.cmid === cmid);
            const quiz = quizzes.quizzes.find((x) => x.cmid === cmid);
            if (!cmid || (!assign && !quiz)) return modedit(q, req);
            const qf = assign ? "_qf__mod_assign_mod_form" : "_qf__mod_quiz_mod_form";
            if (req.method === "GET") {
                const dates = assign
                    ? ["allowsubmissionsfromdate", "duedate", "cutoffdate", "gradingduedate"].map((k) => dateHtml(k, (assign as unknown as Record<string, number>)[k]!)).join("")
                    : `${dateHtml("timeopen", quiz!.timeopen)}${dateHtml("timeclose", quiz!.timeclose)}<input type="checkbox" name="timelimit[enabled]" value="1"${quiz!.timelimit ? " checked" : ""}><input type="text" name="timelimit[number]" value="${quiz!.timelimit / 60}"><select name="attempts"><option value="${quiz!.attempts}" selected>x</option></select>`;
                return {
                    body: `<html><body><form action="${SITE}/course/modedit.php" method="post"><input type="hidden" name="update" value="${cmid}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="${qf}" value="1"><input type="text" name="name" value="${assign?.name ?? quiz!.name}"><input type="hidden" name="sendnotifications" value="1"><input type="hidden" name="secreto_conservado" value="sí">${dates}<input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton2" value="Guardar"></form></body></html>`,
                };
            }
            this.posts.push(Object.fromEntries(b));
            if (assign) {
                const a = assign as unknown as Record<string, number>;
                for (const k of ["allowsubmissionsfromdate", "duedate", "cutoffdate", "gradingduedate"]) if (!(k === "duedate" && this.ignoreDue)) a[k] = selector(b, k);
            } else {
                quiz!.timeopen = selector(b, "timeopen");
                quiz!.timeclose = selector(b, "timeclose");
                quiz!.timelimit = b.get("timelimit[enabled]") === "1" ? Number(b.get("timelimit[number]")) * 60 : 0;
                quiz!.attempts = Number(b.get("attempts") ?? 0);
            }
            return { status: 303, body: null, headers: { location: `${SITE}/course/view.php?id=1` } };
        });
    }
}
