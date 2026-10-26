/**
 * Asistencia sintética CON ESTADO (mod_attendance 2025122100) para las escrituras de W4. Datos 100 %
 * inventados (sitio .test). Trampas reales ([T] §21 y prueba real del 2026-10-19):
 * - mobile_view_activity responde «éxito» aunque no escriba (silentNoop);
 * - retomar borra las observaciones (remarks);
 * - el formulario de sesiones evalúa casillas con isset(): addmultiply=0 → 404;
 * - los umbrales de aviso de la actividad pueden mandar correos (warnings.php con tabla).
 */
import { COURSE, SITE, STUDENT_A, STUDENT_B, USER_ID, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";
import type { SyntheticW2 } from "./fake-w2.js";

export const ATT_CMID = 9600;
export const OTHER_ATT_CMID = 9601;
export const ST = { P: 11, R: 12, FJ: 13, FI: 14 } as const;

interface Session {
    id: number;
    cmid: number;
    date: string; // AAAA-MM-DD
    start: string; // HH:MM
    end: string;
    description?: string;
    records: Map<number, number>;
    remarks: Map<number, string>;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const hour12 = (hm: string) => {
    const [h, m] = hm.split(":").map(Number) as [number, number];
    const suffix = h < 12 ? "AM" : "PM";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}${m ? `:${String(m).padStart(2, "0")}` : ""}${suffix}`;
};

export class SyntheticAttendance {
    readonly sessions = new Map<number, Session>();
    warningsConfigured = false;
    /** El plugin responde «éxito» y no escribe nada. */
    silentNoop = false;
    readonly posts: Record<string, string>[] = [];
    private seq = 40000;

    constructor(fake: FakeMoodle, w2: SyntheticW2) {
        w2.extraModules.push({ id: ATT_CMID, modname: "attendance", name: "Asistencia sintética", section: 3, visible: true });
        w2.extraModules.push({ id: OTHER_ATT_CMID, modname: "attendance", name: "Otra asistencia", section: 3, visible: true });
        this.add({ cmid: ATT_CMID, date: "2026-10-20", start: "19:00", end: "20:00" }, new Map([[STUDENT_A, ST.P]]), new Map([[STUDENT_A, "Llegó con permiso"]]));
        this.add({ cmid: OTHER_ATT_CMID, date: "2026-10-22", start: "10:00", end: "11:00" });
        const pages = fake.web.pages;
        pages.set("/mod/attendance/manage.php", (q) => ({ body: this.managePage(Number(q.id)) }));
        pages.set("/mod/attendance/warnings.php", () => ({
            body: `<html><body><div role="main"><p>Los umbrales de advertencia…</p>${this.warningsConfigured ? '<table class="generaltable"><tr><td>75%</td></tr></table>' : ""}<button>Añadir aviso</button></div></body></html>`,
        }));
        pages.set("/mod/attendance/sessions.php", (q, req) => this.sessionsPhp(q, req));
        const modedit = pages.get("/course/modedit.php")!;
        pages.set("/course/modedit.php", (q, req) => {
            const b = new URLSearchParams(req.body ?? "");
            if (q.add === "attendance" || b.get("_qf__mod_attendance_mod_form")) return this.modedit(q, req, w2);
            return modedit(q, req);
        });
        fake.overrides.set("tool_mobile_get_content", (p) => this.mobile(p));
    }

    private add(s: Omit<Session, "id" | "records" | "remarks">, records = new Map<number, number>(), remarks = new Map<number, string>()) {
        const id = this.seq++;
        this.sessions.set(id, { ...s, id, records, remarks });
        return id;
    }

    /** Filas crudas agregadas al final de la tabla de manage.php (para simular cambios de plantilla). */
    extraManageRows = "";

    private managePage(cmid: number) {
        const rows = [...this.sessions.values()]
            .filter((s) => s.cmid === cmid)
            .map((s) => {
                const d = new Date(`${s.date}T12:00:00Z`);
                const date = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
                const taken = s.records.size > 0;
                const take = `${SITE}/mod/attendance/take.php?id=${cmid}&amp;sessionid=${s.id}&amp;grouptype=0`;
                const wrap = (x: string) => (taken ? `<a title="Cambiar asistencia" href="${take}"><nobr>${x}</nobr></a>` : `<nobr>${x}</nobr>`);
                return `<tr class=""><td class="cell c0"><input class="attendancesesscheckbox" type="checkbox" value="${s.id}" name="sessid[]" /></td><td class="cell c1">${wrap(date)}</td><td class="cell c2">${wrap(`${hour12(s.start)} - ${hour12(s.end)}`)}</td><td class="cell c3">Todos los estudiantes</td><td class="cell c4"><div class="text_to_html">Sesión</div></td><td class="cell c5 lastcol">x</td></tr>`;
            })
            .join("");
        return `<html><body><div class="attsessions_manage_table"><form><div class="generalbox"><table class="generaltable"><thead><tr><th>x</th></tr></thead><tbody>${rows}${this.extraManageRows}</tbody></table></div></form></div></body></html>`;
    }

    private sessionsPhp(q: Record<string, string>, req: { method: string; body: string | null }) {
        if (req.method === "GET" && q.action === "2") {
            const s = this.sessions.get(Number(q.sessionid));
            if (!s || s.cmid !== Number(q.id)) return { status: 404, body: "<html>No existe</html>" };
            const sel = (name: string, v: string) => `<select name="${name}"><option value="0">0</option><option value="${Number(v)}" selected>${v}</option></select>`;
            const [y, mo, d] = s.date.split("-");
            return {
                body: `<html><body><form action="${SITE}/mod/attendance/sessions.php" method="post"><input type="hidden" name="id" value="${s.cmid}"><input type="hidden" name="action" value="2"><input type="hidden" name="sessionid" value="${s.id}"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__mod_attendance_form_updatesession" value="1">${sel("sessiondate[day]", d!)}${sel("sessiondate[month]", mo!)}${sel("sessiondate[year]", y!)}${sel("sestime[starthour]", s.start.slice(0, 2))}${sel("sestime[startminute]", s.start.slice(3))}${sel("sestime[endhour]", s.end.slice(0, 2))}${sel("sestime[endminute]", s.end.slice(3))}<textarea name="sdescription[text]">${s.description ?? ""}</textarea><input type="hidden" name="sdescription[format]" value="1"><input type="checkbox" name="calendarevent" value="1" checked><input type="checkbox" name="studentscanmark" value="1"><input type="submit" name="submitbutton" value="Guardar cambios"></form></body></html>`,
            };
        }
        if (req.method === "GET") {
            return {
                body: `<html><body><div class="logininfo"><a href="${SITE}/user/profile.php?id=${USER_ID}">Docente</a></div><form action="${SITE}/mod/attendance/sessions.php" method="post">
<input type="hidden" name="id" value="${q.id}"><input type="hidden" name="action" value="1"><input type="hidden" name="sessiontype" value="0"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__mod_attendance_form_addsession" value="1">
<select name="sessiondate[day]"><option value="19" selected>19</option></select><select name="sessiondate[month]"><option value="10" selected>10</option></select><select name="sessiondate[year]"><option value="2026" selected>2026</option></select>
<select name="sestime[starthour]"><option value="0" selected>0</option></select><select name="sestime[startminute]"><option value="0" selected>0</option></select><select name="sestime[endhour]"><option value="0" selected>0</option></select><select name="sestime[endminute]"><option value="0" selected>0</option></select>
<textarea name="sdescription[text]"></textarea><input type="hidden" name="sdescription[format]" value="1"><input type="hidden" name="sdescription[itemid]" value="5555">
<input type="checkbox" name="calendarevent" value="1" checked><input type="checkbox" name="addmultiply" value="1"><input type="checkbox" name="studentscanmark" value="1"><input type="checkbox" name="autoassignstatus" value="1">
<input type="submit" name="submitbutton" value="Agregar"></form></body></html>`,
            };
        }
        const b = new URLSearchParams(req.body ?? "");
        this.posts.push(Object.fromEntries(b));
        if (b.get("sesskey") !== WEB_SESSKEY) return { body: "<html>Invalid sesskey</html>" };
        const cmid = Number(b.get("id"));
        if (b.get("action") === "3" && b.get("confirm") === "1") {
            const s = this.sessions.get(Number(b.get("sessionid")));
            if (!s || s.cmid !== cmid) return { status: 404, body: "<html>No existe</html>" };
            this.sessions.delete(s.id);
            return { status: 303, body: null, headers: { location: `${SITE}/mod/attendance/manage.php?id=${cmid}` } };
        }
        if (b.get("action") === "2" && b.get("_qf__mod_attendance_form_updatesession") === "1") {
            const s = this.sessions.get(Number(b.get("sessionid")));
            if (!s || s.cmid !== cmid || b.has("studentscanmark")) return { status: 404, body: "<html>Error</html>" };
            const two = (k: string) => String(Number(b.get(k))).padStart(2, "0");
            if (!this.silentNoop) Object.assign(s, { date: `${b.get("sessiondate[year]")}-${two("sessiondate[month]")}-${two("sessiondate[day]")}`, start: `${two("sestime[starthour]")}:${two("sestime[startminute]")}`, end: `${two("sestime[endhour]")}:${two("sestime[endminute]")}`, description: b.get("sdescription[text]") ?? s.description });
            return { status: 303, body: null, headers: { location: `${SITE}/mod/attendance/manage.php?id=${cmid}` } };
        }
        if (b.get("action") === "1" && b.get("_qf__mod_attendance_form_addsession") === "1") {
            // Trampa real: el plugin usa isset(): una casilla presente (aunque valga 0) cuenta como marcada.
            if (b.has("addmultiply")) return { status: 404, body: "<html>Error</html>" };
            const two = (k: string) => String(Number(b.get(k))).padStart(2, "0");
            this.add({ cmid, date: `${b.get("sessiondate[year]")}-${two("sessiondate[month]")}-${two("sessiondate[day]")}`, start: `${two("sestime[starthour]")}:${two("sestime[startminute]")}`, end: `${two("sestime[endhour]")}:${two("sestime[endminute]")}` });
            return { status: 303, body: null, headers: { location: `${SITE}/mod/attendance/manage.php?id=${cmid}` } };
        }
        return { status: 404, body: "<html>Error</html>" };
    }

    private modedit(q: Record<string, string>, req: { method: string; body: string | null }, w2: SyntheticW2) {
        if (req.method === "GET") {
            return {
                body: `<html><body><form action="${SITE}/course/modedit.php" method="post"><input type="hidden" name="course" value="${q.course}"><input type="hidden" name="section" value="${q.section}"><input type="hidden" name="module" value="29"><input type="hidden" name="modulename" value="attendance"><input type="hidden" name="add" value="attendance"><input type="hidden" name="sesskey" value="${WEB_SESSKEY}"><input type="hidden" name="_qf__mod_attendance_mod_form" value="1"><input type="text" name="name" value="Asistencia"><textarea name="introeditor[text]"></textarea><input type="hidden" name="introeditor[format]" value="1"><select name="grade[modgrade_type]"><option value="point" selected>Puntos</option><option value="none">Ninguna</option></select><input type="text" name="grade[modgrade_point]" value="100"><select name="visible"><option value="1" selected>Mostrar</option><option value="0">Ocultar</option></select><input type="checkbox" name="coursecontentnotification" value="1"><input type="submit" name="submitbutton" value="Guardar"></form></body></html>`,
            };
        }
        const b = new URLSearchParams(req.body ?? "");
        this.posts.push(Object.fromEntries(b));
        const id = 9700 + w2.extraModules.length;
        w2.extraModules.push({ id, modname: "attendance", name: b.get("name") ?? "", section: Number(b.get("section")), visible: b.get("visible") === "1" });
        return { status: 303, body: null, headers: { location: `${SITE}/mod/attendance/view.php?id=${id}` } };
    }

    private mobile(p: Record<string, string>) {
        const args = new Map<string, string>();
        for (const [k, v] of Object.entries(p)) {
            const m = /^args\[(\d+)\]\[name\]$/.exec(k);
            if (m) args.set(v, p[`args[${m[1]}][value]`] ?? "");
        }
        const s = this.sessions.get(Number(args.get("sessid")));
        if (p.method === "mobile_teacher_form") {
            if (!s) return { exception: "dml_missing_record_exception", errorcode: "invalidrecord", message: "No existe" };
            const radios = Object.entries(ST).map(([acr, id]) => `<ion-radio value="${id}">${acr}</ion-radio>`).join("");
            const user = (id: number, name: string) => `<span class="attendance_user_row"><ion-item class="ion-text-wrap" title="${name}"><h2>${name}</h2></ion-item><ion-radio-group [(ngModel)]="CONTENT_OTHERDATA.status${id}">${radios}</ion-radio-group></span>`;
            return {
                templates: [{ id: "main", html: `<div class="attendance_mobile_teacher_form">${user(STUDENT_A, "Ana Sintética")}${user(STUDENT_B, "Beto Sintético")}</div>` }],
                otherdata: [...s.records].map(([u, st]) => ({ name: `status${u}`, value: String(st) })),
            };
        }
        if (p.method === "mobile_view_activity") {
            const marks = [...args].filter(([k]) => /^status\d+$/.test(k));
            if (s && marks.length && !this.silentNoop) {
                for (const [k, v] of marks) {
                    const uid = Number(k.slice(6));
                    s.records.set(uid, Number(v));
                    s.remarks.set(uid, ""); // retomar borra las observaciones
                }
            }
            return { templates: [{ id: "main", html: '<div class="attendance_mobile_view">Asistencia tomada con éxito</div>' }], otherdata: [] };
        }
        return { exception: "moodle_exception", errorcode: "invalidparameter", message: "x" };
    }
}

export { COURSE };
