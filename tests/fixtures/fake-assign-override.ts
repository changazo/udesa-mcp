/**
 * Excepciones (overrides) sintéticas de tareas CON ESTADO: lista overrides.php, formulario
 * overrideedit.php (alta y edición) y overridedelete.php. Trampa real ([T] §18): un alta para un
 * usuario que ya tiene override lo FUSIONA y borra el anterior. Datos inventados.
 */
import { SITE, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";
import type { SyntheticW2 } from "./fake-w2.js";

interface Ovr {
    id: number;
    cmid: number;
    userid: number;
    groupid?: number;
    allowsubmissionsfromdate: number;
    duedate: number;
    cutoffdate: number;
}
const KEYS = ["allowsubmissionsfromdate", "duedate", "cutoffdate"] as const;

function selector(b: URLSearchParams, key: string): number {
    if (b.get(`${key}[enabled]`) !== "1") return 0;
    const n = (k: string) => Number(b.get(`${key}[${k}]`) ?? 0);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") + 3, n("minute")) / 1000;
}
function dateHtml(key: string, unix: number) {
    const d = new Date(unix * 1000 - 3 * 3600_000);
    const parts: [string, number][] = [["day", d.getUTCDate()], ["month", d.getUTCMonth() + 1], ["year", d.getUTCFullYear()], ["hour", d.getUTCHours()], ["minute", d.getUTCMinutes()]];
    return `<input type="checkbox" name="${key}[enabled]" value="1"${unix ? " checked" : ""}>${parts.map(([p, v]) => `<select name="${key}[${p}]"><option value="${v}" selected>${v}</option></select>`).join("")}`;
}

export class SyntheticAssignOverrides {
    readonly overrides: Ovr[] = [];
    /** Moodle «acepta» la edición pero no cambia nada. */
    noopEdit = false;
    readonly posts: Record<string, string>[] = [];
    /** Moodle guarda otro vencimiento (para probar diferencias). */
    shiftDue = 0;
    private seq = 190;

    constructor(fake: FakeMoodle, w2: SyntheticW2) {
        const form = (cmid: number, o: Omit<Ovr, "id" | "cmid"> | null, extra: string) => {
            const a = w2.assignments.find((x) => x.cmid === cmid)!;
            const v = o ?? { userid: 0, allowsubmissionsfromdate: a.allowsubmissionsfromdate, duedate: a.duedate, cutoffdate: a.cutoffdate };
            return `<html><body><div role="main"><form action="${SITE}/mod/assign/overrideedit.php" method="post">${extra}<input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__assign_override_form" value="1">${o ? (o.groupid ? `<input type="hidden" name="groupid" value="${o.groupid}">` : `<input type="hidden" name="userid" value="${o.userid}">`) : (extra.includes("addgroup") ? `<select name="groupid"><option value="">Elegir</option></select>` : `<select name="userid"><option value="">Elegir</option></select>`)}${KEYS.map((k) => dateHtml(k, v[k])).join("")}<input type="submit" name="submitbutton" value="Guardar"></form></div></body></html>`;
        };
        fake.web.pages.set("/mod/assign/overrides.php", (q) => {
            const list = this.overrides.filter((o) => o.cmid === Number(q.cmid) && (q.mode === "group" ? !!o.groupid : !o.groupid));
            const rows = list.map((o) => `<tr><td>Usuario ${o.userid}</td><td><a href="${SITE}/mod/assign/overrideedit.php?id=${o.id}&amp;action=edit">Editar</a><a href="${SITE}/mod/assign/overridedelete.php?id=${o.id}&amp;sesskey=${WEB_SESSKEY}">Borrar</a></td></tr>`).join("");
            return { body: `<html><body><a href="${SITE}/mod/assign/overrideedit.php?action=adduser&amp;cmid=${q.cmid}">Añadir</a><div role="main">${list.length ? `<table>${rows}</table>` : "Actualmente no hay anulaciones de usuario."}</div></body></html>` };
        });
        fake.web.pages.set("/mod/assign/overrideedit.php", (q, req) => {
            if (req.method === "GET") {
                if (q.id) {
                    const o = this.overrides.find((x) => x.id === Number(q.id));
                    return o ? { body: form(o.cmid, o, `<input type="hidden" name="id" value="${o.id}">`) } : { body: `<html><body><div class="box errorbox"><p class="errormessage">No existe</p></div></body></html>` };
                }
                return { body: form(Number(q.cmid), null, `<input type="hidden" name="action" value="${q.action}"><input type="hidden" name="cmid" value="${q.cmid}">`) };
            }
            const b = new URLSearchParams(req.body ?? "");
            this.posts.push(Object.fromEntries(b));
            // Edición de una existente (id): se actualiza en el lugar, con el mismo id (ADR-099).
            const editing = this.overrides.find((o) => o.id === Number(b.get("id")));
            if (editing) {
                if (!this.noopEdit) Object.assign(editing, { allowsubmissionsfromdate: selector(b, "allowsubmissionsfromdate"), duedate: selector(b, "duedate"), cutoffdate: selector(b, "cutoffdate") });
                return { status: 303, body: null, headers: { location: `${SITE}/mod/assign/overrides.php?cmid=${editing.cmid}&mode=user` } };
            }
            const cmid = Number(b.get("cmid") ?? q.cmid);
            const userid = Number(b.get("userid") ?? 0);
            const groupid = Number(b.get("groupid") ?? 0) || undefined;
            // Trampa: fusiona con uno existente del mismo usuario (o grupo) y lo borra.
            const prev = this.overrides.findIndex((o) => o.cmid === cmid && (groupid ? o.groupid === groupid : !o.groupid && o.userid === userid));
            if (prev >= 0) this.overrides.splice(prev, 1);
            const o: Ovr = { id: this.seq++, cmid, userid, groupid, allowsubmissionsfromdate: selector(b, "allowsubmissionsfromdate"), duedate: selector(b, "duedate") + this.shiftDue, cutoffdate: selector(b, "cutoffdate") };
            this.overrides.push(o);
            return { status: 303, body: null, headers: { location: `${SITE}/mod/assign/overrides.php?cmid=${cmid}&mode=user` } };
        });
        fake.web.pages.set("/mod/assign/overridedelete.php", (_q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            if (b.get("sesskey") !== WEB_SESSKEY || b.get("confirm") !== "1") return { body: "<html><body>¿Confirmar?</body></html>" };
            const i = this.overrides.findIndex((o) => o.id === Number(b.get("id")));
            if (i >= 0) this.overrides.splice(i, 1);
            return { status: 303, body: null, headers: { location: `${SITE}/mod/assign/overrides.php` } };
        });
    }
}
