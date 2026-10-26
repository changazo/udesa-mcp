/**
 * Libro de calificaciones sintético CON ESTADO (ADR-096): ítems (item.php, index.php?action=delete,
 * action.php), notas (grade.php) e informe del calificador (recalcula). Trampas reales:
 * - un ítem con notas pendientes de recálculo no se bloquea (hasta abrir el informe del calificador);
 * - con notas, el formulario del ítem no dibuja el tipo de nota;
 * - las notas se muestran con coma decimal.
 * Datos 100 % inventados.
 */
import { COURSE, SITE, STUDENT_A, STUDENT_B, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";

interface Item {
    id: number;
    type: "manual" | "mod";
    name: string;
    idnumber: string;
    gradetype: string;
    scaleid: string;
    max: number;
    min: number;
    pass: number;
    hidden: boolean;
    locked: boolean;
    needsupdate: boolean;
}
interface Grade {
    overridden: boolean;
    final: string;
    excluded: boolean;
    hidden: boolean;
    locked: boolean;
    feedback: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const comma = (n: number) => n.toFixed(2).replace(".", ",");

export class SyntheticGradebook {
    readonly items = new Map<number, Item>();
    readonly grades = new Map<string, Grade>();
    /** Moodle «acepta» pero no guarda (para sin_efecto). */
    noop = false;
    private seq = 8800;

    constructor(fake: FakeMoodle) {
        this.items.set(8701, { id: 8701, type: "mod", name: "Tarea con escala", idnumber: "", gradetype: "2", scaleid: "52", max: 2, min: 1, pass: 0, hidden: false, locked: false, needsupdate: false });
        this.grades.set(`8701:${STUDENT_A}`, { overridden: false, final: "2", excluded: false, hidden: false, locked: false, feedback: "" });
        // Notas por participante de los ítems manuales (sobre lo que ya responda otro sintético).
        const prev = fake.overrides.get("gradereport_user_get_grade_items");
        fake.overrides.set("gradereport_user_get_grade_items", (p) => {
            const before = (prev ? prev(p) : null) as { usergrades?: { userid: number; gradeitems: unknown[] }[] } | null;
            const users = Number(p.userid) ? [Number(p.userid)] : [STUDENT_A, STUDENT_B];
            return {
                usergrades: users.map((u) => ({
                    userid: u,
                    gradeitems: [...(before?.usergrades?.find((x) => x.userid === u)?.gradeitems ?? []), ...[...this.items.values()].map((i) => {
                        const g = this.grades.get(`${i.id}:${u}`);
                        return { id: i.id, graderaw: g && g.final !== "" ? Number(g.final.replace(",", ".")) : null };
                    })],
                })),
                warnings: [],
            };
        });
        fake.overrides.set("core_grades_get_gradeitems", (p) => ({ gradeItems: Number(p.courseid) === COURSE ? [...this.items.values()].map((i) => ({ id: String(i.id), itemname: i.name, category: "Curso" })) : [], warnings: [] }));
        const pages = fake.web.pages;
        const bad = { body: "<html><body>no</body></html>" };
        pages.set("/grade/report/grader/index.php", () => {
            for (const i of this.items.values()) i.needsupdate = false;
            return { body: "<html><body>informe</body></html>" };
        });
        pages.set("/grade/edit/tree/item.php", (q, req) => {
            if (req.method === "GET") return { body: this.itemHtml(Number(q.id)) };
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("sesskey") !== WEB_SESSKEY || b.get("_qf__edit_item_form") !== "1") return bad;
            if (this.noop) return { status: 303, body: null, headers: { location: `${SITE}/grade/edit/tree/index.php?id=${COURSE}` } };
            const id = Number(b.get("id"));
            const it: Item = id ? this.items.get(id)! : { id: this.seq++, type: "manual", name: "", idnumber: "", gradetype: "1", scaleid: "", max: 100, min: 0, pass: 0, hidden: false, locked: false, needsupdate: true };
            const n = (k: string) => Number((b.get(k) ?? "").replace(",", "."));
            Object.assign(it, { name: b.get("itemname") ?? it.name, idnumber: b.get("idnumber") ?? it.idnumber, ...(b.has("gradetype") ? { gradetype: b.get("gradetype") } : {}), scaleid: b.get("scaleid") ?? it.scaleid, max: b.has("grademax") ? n("grademax") : it.max, min: b.has("grademin") ? n("grademin") : it.min, pass: b.has("gradepass") ? n("gradepass") : it.pass, hidden: b.getAll("hidden").at(-1) === "1" });
            this.items.set(it.id, it);
            return { status: 303, body: null, headers: { location: `${SITE}/grade/edit/tree/index.php?id=${COURSE}` } };
        });
        pages.set("/grade/edit/tree/index.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const it = this.items.get(Number(b.get("eid")?.replace("ig", "")));
            if (req.method !== "POST" || b.get("sesskey") !== WEB_SESSKEY || b.get("action") !== "delete" || b.get("confirm") !== "1" || !it || it.type !== "manual") return bad;
            if (!this.noop) this.items.delete(it.id);
            return { status: 303, body: null, headers: { location: `${SITE}/grade/edit/tree/index.php?id=${COURSE}` } };
        });
        pages.set("/grade/edit/tree/action.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            const it = this.items.get(Number(b.get("eid")?.replace("ig", "")));
            if (req.method !== "POST" || b.get("sesskey") !== WEB_SESSKEY || !it) return bad;
            const a = b.get("action");
            if (!this.noop) {
                if (a === "hide" || a === "show") it.hidden = a === "hide";
                // Trampa real: con notas pendientes de recálculo, set_locked no hace nada.
                if ((a === "lock" && !it.needsupdate) || a === "unlock") it.locked = a === "lock";
            }
            return { status: 303, body: null, headers: { location: `${SITE}/grade/edit/tree/index.php?id=${COURSE}` } };
        });
        pages.set("/grade/edit/tree/grade.php", (q, req) => {
            if (req.method === "GET") return { body: this.gradeHtml(Number(q.itemid), Number(q.userid)) };
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("sesskey") !== WEB_SESSKEY || b.get("_qf__edit_grade_form") !== "1") return bad;
            const it = this.items.get(Number(b.get("itemid")))!;
            const g = this.grade(it.id, Number(b.get("userid")));
            if (!this.noop) {
                const ov = b.get("overridden") === "1";
                if (it.type === "mod") {
                    g.overridden = ov;
                    if (ov) g.final = b.get("finalgrade") ?? g.final;
                    else g.final = "2";
                } else g.final = b.get("finalgrade") ?? g.final;
                g.excluded = b.getAll("excluded").at(-1) === "1";
                g.hidden = b.get("hidden") === "1";
                g.locked = b.getAll("locked").at(-1) === "1";
                g.feedback = b.get("feedback[text]") ?? g.feedback;
                it.needsupdate = true;
            }
            return { status: 303, body: null, headers: { location: `${SITE}/grade/report/grader/index.php?id=${COURSE}` } };
        });
    }

    grade(itemId: number, userId: number): Grade {
        const k = `${itemId}:${userId}`;
        if (!this.grades.has(k)) this.grades.set(k, { overridden: false, final: "", excluded: false, hidden: false, locked: false, feedback: "" });
        return this.grades.get(k)!;
    }

    private itemHtml(id: number): string {
        const it = this.items.get(id);
        const hasGrades = !!it && [...this.grades.keys()].some((k) => k.startsWith(`${id}:`) && this.grades.get(k)!.final !== "");
        // Con notas, Moodle muestra el tipo como texto (sin select).
        const type = hasGrades ? "<span>Valor</span>" : `<select name="gradetype">${["0", "1", "2", "3"].map((v) => `<option value="${v}"${(it?.gradetype ?? "1") === v ? " selected" : ""}>${v}</option>`).join("")}</select><select name="scaleid"><option value="52"${it?.scaleid === "52" ? " selected" : ""}>Aprobado - Desaprobado</option></select>`;
        const nums = !it || it.gradetype === "1" ? `<input type="text" name="grademax" value="${comma(it?.max ?? 100)}"><input type="text" name="grademin" value="${comma(it?.min ?? 0)}">` : "";
        return `<html><body><form action="${SITE}/grade/edit/tree/item.php" method="post"><input type="hidden" name="id" value="${id}"><input type="hidden" name="courseid" value="${COURSE}"><input type="hidden" name="itemtype" value="${it?.type ?? "manual"}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__edit_item_form" value="1"><input type="text" name="itemname" value="${esc(it?.name ?? "")}"><input type="text" name="idnumber" value="${esc(it?.idnumber ?? "")}">${type}${nums}<input type="text" name="gradepass" value="${comma(it?.pass ?? 0)}"><input type="hidden" name="hidden" value="0"><input type="checkbox" name="hidden" value="1"${it?.hidden ? " checked" : ""}><input type="hidden" name="locked" value="0"><input type="checkbox" name="locked" value="1"${it?.locked ? " checked" : ""}><input type="submit" name="submitbutton" value="Guardar"></form></body></html>`;
    }

    private gradeHtml(itemId: number, userId: number): string {
        const it = this.items.get(itemId);
        if (!it) return "<html><body>no</body></html>";
        const g = this.grade(itemId, userId);
        const final = it.gradetype === "2" ? `<select name="finalgrade"><option value="-1">Sin calificación</option><option value="1"${g.final === "1" ? " selected" : ""}>Desaprobado</option><option value="2"${g.final === "2" ? " selected" : ""}>Aprobado</option></select>` : `<input type="text" name="finalgrade" value="${g.final === "" ? "" : comma(Number(g.final.replace(",", ".")))}">`;
        const ov = it.type === "mod" ? `<input type="checkbox" name="overridden" value="1"${g.overridden ? " checked" : ""}>` : "";
        return `<html><body><form action="${SITE}/grade/edit/tree/grade.php" method="post"><input type="hidden" name="itemid" value="${itemId}"><input type="hidden" name="userid" value="${userId}"><input type="hidden" name="courseid" value="${COURSE}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__edit_grade_form" value="1">${ov}${final}<input type="hidden" name="excluded" value="0"><input type="checkbox" name="excluded" value="1"${g.excluded ? " checked" : ""}><input type="checkbox" name="hidden" value="1"${g.hidden ? " checked" : ""}><input type="hidden" name="locked" value="0"><input type="checkbox" name="locked" value="1"${g.locked ? " checked" : ""}><textarea name="feedback[text]">${esc(g.feedback)}</textarea><input type="hidden" name="feedback[format]" value="1"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>`;
    }
}
