/**
 * Calendario, tareas y comentarios sintéticos CON ESTADO para W2. Datos 100 % inventados (sitio .test).
 * Trampas de la investigación ([F] §4–§5, [T] §13–§14):
 * - sin permiso, create_calendar_events NO lanza excepción: devuelve el aviso nopermissions sin crear;
 * - repeats=N crea N ocurrencias con repeatid; delete con un id inexistente aborta;
 * - save_user_extensions devuelve el aviso couldnotgrantextensions (sin cambiar nada) si la fecha es
 *   anterior al vencimiento o el usuario no puede entregar;
 * - el área submission_comments_upgrade firma el comentario como el estudiante.
 */
import { COURSE, NOW_UNIX, SITE, STUDENT_A, STUDENT_B, STUDENT_C, USER_ID, type FakeMoodle } from "./fake-moodle.js";
import { WEB_SESSKEY } from "./fake-web.js";

export const W2_ASSIGN = 801;
export const W2_ASSIGN_CMID = 9101;
export const W2_SUBMISSION_A = 9500;
export const W2_GROUP = 12;
export const DUE = NOW_UNIX + 7 * 86_400;
export const CUTOFF = NOW_UNIX + 14 * 86_400;

interface CalEvent {
    id: number;
    name: string;
    description: string;
    courseid: number;
    groupid: number;
    userid: number;
    repeatid: number;
    eventtype: string;
    timestart: number;
    timeduration: number;
}

export interface SynthAssign {
    id: number;
    cmid: number;
    name: string;
    section: number;
    visible: boolean;
    duedate: number;
    allowsubmissionsfromdate: number;
    cutoffdate: number;
    gradingduedate: number;
    timemodified: number;
    grade?: number;
    markingworkflow?: number;
    /** Visibilidad previa a ocultar la sección (visibleold). */
    visibleold?: boolean;
    /** Lo que llegó en el POST (para verificar que nunca se pidió notificar). */
    posted?: Record<string, string>;
}

/** Fecha del selector de Moodle (zona -03:00) → Unix; 0 si está deshabilitada. */
function selectorDate(b: URLSearchParams, key: string): number {
    if (b.get(`${key}[enabled]`) !== "1") return 0;
    const n = (k: string) => Number(b.get(`${key}[${k}]`) ?? 0);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") + 3, n("minute")) / 1000;
}

export class SyntheticW2 {
    readonly events = new Map<number, CalEvent>();
    /** Grupos de los que la cuenta es miembro: get_calendar_events omite los eventos de los demás (como en UdeSA). */
    readonly memberGroups = new Set<number>();
    readonly assignments: SynthAssign[] = [
        { id: W2_ASSIGN, cmid: W2_ASSIGN_CMID, name: "TP sintético", section: 1, visible: true, grade: 10, duedate: DUE, allowsubmissionsfromdate: NOW_UNIX - 30 * 86_400, cutoffdate: CUTOFF, gradingduedate: 0, timemodified: NOW_UNIX - 86_400 },
    ];
    /** Otros módulos del curso (p. ej. asistencias) para core_course_get_contents. */
    readonly extraModules: { id: number; modname: string; name: string; section: number; visible: boolean; description?: string; contextid?: number; instance?: number; contents?: Record<string, unknown>[] }[] = [];
    readonly sections = [0, 1, 2, 3].map((n) => ({ id: 100 + n, section: n, name: n === 0 ? "General" : `Tema ${n}`, visible: true }));
    /** Moodle «acepta» las acciones de estructura pero no cambia nada. */
    layoutNoop = false;
    /** Cómo responde el próximo POST del formulario: ok, 500 tras crear (incierto) o la página de login. */
    formMode: "ok" | "500_after" | "login" = "ok";
    /** GETs del formulario recibidos (cada uno reserva un área borrador en Moodle real). */
    formGets: Record<string, string>[] = [];
    allowedTypes = ["user", "course", "group"];
    /** Moodle «acepta» pero no crea el evento (aviso nopermissions). */
    calendarDenied = false;
    readonly extensions = new Map<number, number>();
    readonly locked = new Set<number>();
    readonly grades = new Map<number, { grade: number; comment: string; timemodified: number }>();
    readonly gradingForms: Record<string, string>[] = [];
    gradeLocked = false;
    gradingNoop = false;
    readonly comments = new Map<number, { id: number; itemid: number; userid: number; content: string; timecreated: number }>();
    commentsEnabled = true;
    /** Entregas vacías creadas por get_submission_status (ADR-051): debe quedar vacío. */
    readonly createdSubmissions: number[] = [];
    private seq = 100;
    private clock = NOW_UNIX;

    constructor(fake: FakeMoodle) {
        const o = fake.overrides;
        o.set("core_calendar_get_allowed_event_types", () => ({ allowedeventtypes: this.allowedTypes, warnings: [] }));
        o.set("core_group_get_course_groups", () => [
            { id: W2_GROUP, courseid: COURSE, name: "Comisión A" },
            { id: 13, courseid: COURSE, name: "Comisión B" },
        ]);
        o.set("core_calendar_get_calendar_events", (p) => this.getEvents(p));
        o.set("core_calendar_create_calendar_events", (p) => this.createEvent(p));
        o.set("core_calendar_delete_calendar_events", (p) => this.deleteEvent(p));
        // Formulario de edición del calendario por servicio web (hora local UTC-3, como el perfil).
        o.set("core_calendar_submit_create_update_form", (p) => {
            const fd = new URLSearchParams(p.formdata ?? "");
            const e = this.events.get(Number(fd.get("id")));
            if (!e || fd.get("_qf__core_calendar_local_event_forms_update") !== "1") return { exception: "dml_missing_record_exception", errorcode: "invalidrecord", message: "No existe" };
            const n = (k: string) => Number(fd.get(`timestart[${k}]`));
            if (!fd.get("name") || fd.get("eventtype") !== e.eventtype || (e.eventtype === "group" && Number(fd.get("groupid")) !== e.groupid)) return { validationerror: true };
            if (!this.calendarDenied) Object.assign(e, { name: fd.get("name"), description: fd.get("description[text]") ?? "", timestart: Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") + 3, n("minute")) / 1000, timeduration: fd.get("duration") === "2" ? Number(fd.get("timedurationminutes")) * 60 : 0 });
            return { event: { ...e }, validationerror: false };
        });
        // Vista mensual: muestra también los eventos de grupos ajenos (hora local UTC-3).
        o.set("core_calendar_get_calendar_monthly_view", (p) => {
            const inMonth = [...this.events.values()].filter((e) => {
                const d = new Date((e.timestart - 3 * 3600) * 1000);
                return e.courseid === Number(p.courseid) && d.getUTCFullYear() === Number(p.year) && d.getUTCMonth() + 1 === Number(p.month);
            });
            return { weeks: [{ days: [{ events: inMonth.map((e) => ({ ...e, descriptionformat: 1, modulename: "", course: { id: e.courseid } })) }] }] };
        });
        o.set("core_calendar_get_calendar_event_by_id", (p) => {
            const e = this.events.get(Number(p.eventid));
            return e ? { event: { ...e, descriptionformat: 1, modulename: "", course: { id: e.courseid } }, warnings: [] } : { exception: "dml_missing_record_exception", errorcode: "invalidrecord", message: "No existe" };
        });
        o.set("mod_assign_get_assignments", () => ({
            courses: [{ id: COURSE, assignments: this.assignments.map((a) => ({ id: a.id, cmid: a.cmid, course: COURSE, name: a.name, grade: a.grade ?? 100, markingworkflow: a.markingworkflow ?? 0, duedate: a.duedate, allowsubmissionsfromdate: a.allowsubmissionsfromdate, cutoffdate: a.cutoffdate, gradingduedate: a.gradingduedate, timemodified: a.timemodified })) }],
            warnings: [],
        }));
        o.set("core_course_get_contents", () =>
            this.sections.map((s) => ({
                id: s.id,
                section: s.section,
                name: s.name,
                visible: s.visible ? 1 : 0,
                modules: [
                    ...this.assignments.filter((a) => a.section === s.section).map((a) => ({ id: a.cmid, name: a.name, instance: a.id, modname: "assign", visible: a.visible ? 1 : 0, contextid: 80_000 + a.cmid })),
                    ...this.extraModules.filter((m) => m.section === s.section).map((m) => ({ id: m.id, name: m.name, modname: m.modname, visible: m.visible ? 1 : 0, ...(m.description !== undefined ? { description: m.description } : {}), ...(m.contextid !== undefined ? { contextid: m.contextid } : {}), ...(m.instance !== undefined ? { instance: m.instance } : {}), ...(m.contents !== undefined ? { contents: m.contents } : {}) })),
                ],
            })),
        );
        o.set("core_course_get_courses_by_field", () => ({ courses: [{ id: COURSE, format: "topics" }], warnings: [] }));
        // Gestión de la calificación avanzada: por defecto, calificación simple (sin editor de rúbrica ni guía).
        fake.web.pages.set("/grade/grading/manage.php", (q) => ({ body: `<html><body><a href="${SITE}/grade/grading/manage.php?areaid=${q.contextid}&amp;setmethod=">Método</a></body></html>` }));
        fake.web.ajax.set("core_update_inplace_editable", (args) => {
            const value = String(args.value ?? "").trim();
            if (args.itemtype === "activityname" && args.component === "core_course") {
                const a = this.assignments.find((x) => x.cmid === Number(args.itemid));
                if (!a) throw Object.assign(new Error("No existe"), { errorcode: "invalidrecord" });
                if (value && !this.layoutNoop) a.name = value; // vacío: no-op sin error
                return { value: a.name };
            }
            if (args.itemtype === "sectionname" && args.component === "format_topics") {
                const s = this.sections.find((x) => x.id === Number(args.itemid));
                if (!s) throw Object.assign(new Error("No existe"), { errorcode: "invalidrecord" });
                if (!this.layoutNoop) s.name = value || `Tema ${s.section}`;
                return { value: s.name };
            }
            throw Object.assign(new Error("Componente incorrecto"), { errorcode: "invalidparameter" });
        });
        fake.web.pages.set("/course/modedit.php", (q, req) => this.modedit(q, req));
        fake.web.ajax.set("core_courseformat_update_course", (args) => {
            const ids = args.ids as number[];
            if (args.action !== "cm_delete") return this.layoutAction(String(args.action), ids[0]!, args);
            const i = this.assignments.findIndex((a) => a.cmid === ids[0]);
            const j = this.extraModules.findIndex((m) => m.id === ids[0]);
            if (i < 0 && j < 0) throw Object.assign(new Error("No existe"), { errorcode: "unexistingcmid" });
            if (i >= 0) this.assignments.splice(i, 1);
            else this.extraModules.splice(j, 1);
            return "[]";
        });
        // B no tiene registro de entrega: submissionstatus = '' (Moodle) y get_submission_status lo crearía.
        o.set("mod_assign_list_participants", () => [
            { id: STUDENT_A, fullname: "Estudiante A", submissionstatus: "submitted" },
            { id: STUDENT_B, fullname: "Estudiante B", submissionstatus: this.createdSubmissions.includes(STUDENT_B) ? "new" : "" },
        ]);
        o.set("mod_assign_get_grades", (p) => ({
            assignments: [{ assignmentid: Number(p["assignmentids[0]"]), grades: [...this.grades.entries()].map(([userid, g]) => ({ userid, attemptnumber: 0, grade: g.grade.toFixed(5), grader: USER_ID, timemodified: g.timemodified })) }],
            warnings: [],
        }));
        o.set("gradereport_user_get_grade_items", (p) => ({
            // userid 0 = todos los participantes (como Moodle).
            usergrades: (Number(p.userid) ? [Number(p.userid)] : [STUDENT_A, STUDENT_B]).map((userid) => ({ userid, gradeitems: [{ id: 1, itemmodule: "assign", iteminstance: W2_ASSIGN, gradeislocked: this.gradeLocked, gradeisoverridden: false, locked: false }] })),
            warnings: [],
        }));
        o.set("mod_assign_submit_grading_form", (p) => {
            const f = new URLSearchParams(JSON.parse(p.jsonformdata ?? '""') as string);
            this.gradingForms.push(Object.fromEntries(f));
            const uid = Number(p.userid);
            const raw = f.get("grade") ?? "";
            const value = raw === "" ? 0 : Number(raw); // trampa real: «sin nota» por el formulario queda 0
            if (value < 0 || value > 10) return [{ item: "assign", itemid: uid, warningcode: "couldnotsavegrade", message: "Form validation failed." }];
            if (uid !== STUDENT_A && !this.createdSubmissions.includes(uid)) this.createdSubmissions.push(uid); // calificar crea la entrega
            if (this.gradingNoop) return [];
            this.grades.set(uid, { grade: value, comment: f.get("assignfeedbackcomments_editor[text]") ?? "", timemodified: ++this.clock });
            return [];
        });
        o.set("mod_assign_get_user_flags", (p) => ({
            assignments: [
                {
                    assignmentid: Number(p["assignmentids[0]"]),
                    userflags: [STUDENT_A, STUDENT_B]
                        .filter((u) => this.extensions.has(u) || this.locked.has(u))
                        .map((u, i) => ({ id: i + 1, userid: u, locked: this.locked.has(u) ? 1 : 0, mailed: 0, extensionduedate: this.extensions.get(u) ?? 0, allocatedmarker: 0 })),
                },
            ],
            warnings: [],
        }));
        o.set("mod_assign_get_submission_status", (p) => {
            const uid = Number(p.userid);
            if (uid !== STUDENT_A && !this.createdSubmissions.includes(uid)) this.createdSubmissions.push(uid);
            const g = this.grades.get(uid);
            return {
                feedback: g ? { grade: { grade: g.grade.toFixed(5) }, plugins: [{ type: "comments", name: "Comentarios", editorfields: [{ name: "comments", text: g.comment, format: 1 }] }] } : null,
                lastattempt: {
                    submission: uid === STUDENT_A ? { id: W2_SUBMISSION_A, userid: uid, status: "submitted" } : null,
                    locked: this.locked.has(uid),
                    extensionduedate: this.extensions.get(uid) ?? 0,
                },
                warnings: [],
            };
        });
        o.set("mod_assign_save_user_extensions", (p) => {
            const uid = Number(p["userids[0]"]);
            const date = Number(p["dates[0]"]);
            if (![STUDENT_A, STUDENT_B].includes(uid) || (date !== 0 && date < DUE)) return [{ item: "assign", itemid: uid, warningcode: "couldnotgrantextensions", message: "No" }];
            if (date === 0) this.extensions.delete(uid);
            else this.extensions.set(uid, date);
            return [];
        });
        o.set("mod_assign_lock_submissions", (p) => this.lockOp(p, true));
        o.set("mod_assign_unlock_submissions", (p) => this.lockOp(p, false));
        o.set("core_comment_add_comments", (p) => {
            if (!this.commentsEnabled) return { exception: "comment_exception", errorcode: "commentsnotenabled", message: "Comentarios deshabilitados" };
            const id = 7700 + this.seq++;
            // Trampa: el área «upgrade» firma como el dueño de la entrega.
            const userid = p["comments[0][area]"] === "submission_comments_upgrade" ? STUDENT_A : USER_ID;
            const c = { id, itemid: Number(p["comments[0][itemid]"]), userid, content: p["comments[0][content]"] ?? "", timecreated: ++this.clock };
            this.comments.set(id, c);
            return [{ id, content: `<p>${c.content}</p>`, format: 0, timecreated: c.timecreated, userid, fullname: "Docente Sintético", delete: true }];
        });
        o.set("core_comment_delete_comments", (p) => {
            const id = Number(p["comments[0]"]);
            if (!this.comments.has(id)) return { exception: "comment_exception", errorcode: "nopermissiontodelentry", message: "No existe" };
            this.comments.delete(id);
            return { warnings: [] };
        });
        o.set("core_comment_get_comments", (p) => ({
            comments: [...this.comments.values()].filter((c) => c.itemid === Number(p.itemid)).map((c) => ({ id: c.id, content: `<p>${c.content}</p>`, format: 0, timecreated: c.timecreated, userid: c.userid, fullname: "x" })),
            count: this.comments.size,
            warnings: [],
        }));
    }

    private layoutAction(action: string, id: number, args: Record<string, unknown>) {
        if (this.layoutNoop) return "[]";
        const a = this.assignments.find((x) => x.cmid === id);
        const s = this.sections.find((x) => x.id === id);
        switch (action) {
            case "cm_show":
            case "cm_hide":
                if (!a) throw Object.assign(new Error("No existe"), { errorcode: "unexistingcmid" });
                a.visible = action === "cm_show";
                return "[]";
            case "section_hide":
            case "section_show": {
                if (!s) throw Object.assign(new Error("No existe"), { errorcode: "unexistingsectionid" });
                s.visible = action === "section_show";
                for (const m of this.assignments.filter((x) => x.section === s.section)) {
                    if (!s.visible) {
                        m.visibleold = m.visible;
                        m.visible = false;
                    } else m.visible = m.visibleold ?? m.visible;
                }
                return "[]";
            }
            case "cm_move": {
                if (!a) throw Object.assign(new Error("No existe"), { errorcode: "unexistingcmid" });
                this.assignments.splice(this.assignments.indexOf(a), 1);
                if (typeof args.targetcmid === "number") {
                    const t = this.assignments.find((x) => x.cmid === args.targetcmid)!;
                    a.section = t.section;
                    this.assignments.splice(this.assignments.indexOf(t), 0, a);
                } else {
                    a.section = this.sections.find((x) => x.id === args.targetsectionid)!.section;
                    this.assignments.push(a);
                }
                // Trampa [C §1.3]: entrar a una sección oculta oculta la actividad.
                if (!this.sections.find((x) => x.section === a.section)!.visible && a.visible) {
                    a.visibleold = true;
                    a.visible = false;
                }
                return "[]";
            }
            case "section_move_after": {
                if (!s) throw Object.assign(new Error("No existe"), { errorcode: "unexistingsectionid" });
                const t = this.sections.find((x) => x.id === args.targetsectionid)!;
                this.sections.splice(this.sections.indexOf(s), 1);
                this.sections.splice(this.sections.indexOf(t) + 1, 0, s);
                // Moodle renumera las secciones (el contenido va con su sección).
                const old = new Map(this.sections.map((x) => [x.id, x.section]));
                this.sections.forEach((x, i) => (x.section = i));
                for (const m of [...this.assignments, ...this.extraModules]) {
                    const from = [...old].find(([, n]) => n === m.section)?.[0];
                    if (from !== undefined) m.section = this.sections.find((x) => x.id === from)!.section;
                }
                return "[]";
            }
            default:
                throw Object.assign(new Error("acción no prevista"), { errorcode: "invalidaction" });
        }
    }

    private formHtml(q: Record<string, string>, error: string | null) {
        const date = (k: string, enabled: boolean) =>
            `<input type="checkbox" name="${k}[enabled]" value="1"${enabled ? " checked" : ""}>` +
            ["day", "month", "year", "hour", "minute"].map((p) => `<select name="${k}[${p}]"><option value="1" selected>1</option><option value="2">2</option></select>`).join("");
        return `<html><body><div class="logininfo"><a href="${SITE}/user/profile.php?id=${USER_ID}">Docente</a></div>
<form autocomplete="off" action="${SITE}/course/modedit.php" method="post">
<input name="course" type="hidden" value="${q.course ?? ""}"><input name="coursemodule" type="hidden" value=""><input name="section" type="hidden" value="${q.section ?? ""}">
<input name="module" type="hidden" value="24"><input name="modulename" type="hidden" value="assign"><input name="instance" type="hidden" value="">
<input name="add" type="hidden" value="assign"><input name="update" type="hidden" value="0"><input name="return" type="hidden" value="0"><input name="sr" type="hidden" value="-1">
<input name="sesskey" type="hidden" value="${WEB_SESSKEY}"><input name="_qf__mod_assign_mod_form" type="hidden" value="1">
<input type="text" name="name" value="">${error ? `<div class="form-control-feedback invalid-feedback" id="id_error_name">${error}</div>` : ""}
<textarea name="introeditor[text]"></textarea><input type="hidden" name="introeditor[format]" value="1"><input type="hidden" name="introeditor[itemid]" value="123456">
${date("allowsubmissionsfromdate", true)}${date("duedate", true)}${date("cutoffdate", false)}${date("gradingduedate", true)}
<input type="checkbox" name="assignsubmission_onlinetext_enabled" value="1"><input type="checkbox" name="assignsubmission_file_enabled" value="1" checked>
<input type="checkbox" name="assignsubmission_comments_enabled" value="1" checked>
<select name="sendnotifications"><option value="0">No</option><option value="1" selected>Sí</option></select>
<select name="sendlatenotifications"><option value="0" selected>No</option><option value="1">Sí</option></select>
<select name="sendstudentnotifications"><option value="0">No</option><option value="1" selected>Sí</option></select>
<select name="grade[modgrade_type]"><option value="point" selected>Puntos</option></select><input type="text" name="grade[modgrade_point]" value="100">
<select name="visible"><option value="1" selected>Mostrar</option><option value="0">Ocultar</option></select>
<input type="checkbox" name="coursecontentnotification" value="1">
<input type="submit" name="submitbutton2" value="Guardar y volver"><input type="submit" name="submitbutton" value="Guardar y mostrar"><input type="submit" name="cancel" value="Cancelar">
</form></body></html>`;
    }

    private modedit(q: Record<string, string>, req: { method: string; body: string | null }) {
        if (req.method === "GET") {
            this.formGets.push(q);
            return { body: this.formHtml(q, null) };
        }
        const b = new URLSearchParams(req.body ?? "");
        if (this.formMode === "login") return { status: 303, body: null, headers: { location: `${SITE}/login/index.php` } };
        if (b.get("sesskey") !== WEB_SESSKEY || b.get("_qf__mod_assign_mod_form") !== "1") return { body: "<html>Invalid sesskey</html>" };
        const name = (b.get("name") ?? "").trim();
        if (!name) return { body: this.formHtml(Object.fromEntries(b), "Debe suministrar un valor aquí.") };
        const a: SynthAssign = {
            id: 900 + this.seq,
            cmid: 9900 + this.seq++,
            name,
            section: Number(b.get("section")),
            visible: b.get("visible") === "1",
            duedate: selectorDate(b, "duedate"),
            allowsubmissionsfromdate: selectorDate(b, "allowsubmissionsfromdate"),
            cutoffdate: selectorDate(b, "cutoffdate"),
            gradingduedate: selectorDate(b, "gradingduedate"),
            timemodified: ++this.clock,
            posted: Object.fromEntries(b),
        };
        if (a.duedate && a.allowsubmissionsfromdate && a.duedate < a.allowsubmissionsfromdate) return { body: this.formHtml(Object.fromEntries(b), "El vencimiento no puede ser anterior.") };
        this.assignments.push(a);
        if (this.formMode === "500_after") return { status: 500, body: "error" };
        return { status: 303, body: null, headers: { location: `${SITE}/mod/assign/view.php?id=${a.cmid}` } };
    }

    private lockOp(p: Record<string, string>, lock: boolean) {
        const uid = Number(p["userids[0]"]);
        if (![STUDENT_A, STUDENT_B, STUDENT_C].includes(uid)) return { exception: "dml_missing_record_exception", errorcode: "invalidrecord", message: "Usuario inexistente" };
        if (lock) this.locked.add(uid);
        else this.locked.delete(uid);
        return [];
    }

    private getEvents(p: Record<string, string>) {
        const from = Number(p["options[timestart]"] ?? 0);
        const to = Number(p["options[timeend]"] ?? Number.MAX_SAFE_INTEGER);
        const courses = Object.entries(p).filter(([k]) => k.startsWith("events[courseids]")).map(([, v]) => Number(v));
        const events = [...this.events.values()].filter((e) => courses.includes(e.courseid) && e.timestart >= from && e.timestart <= to && (e.eventtype !== "group" || this.memberGroups.has(e.groupid)));
        return { events: events.map((e) => ({ ...e, format: 1, modulename: null })), warnings: [] };
    }

    private createEvent(p: Record<string, string>) {
        const type = p["events[0][eventtype]"] ?? "user";
        if (this.calendarDenied || !this.allowedTypes.includes(type)) return { events: [], warnings: [{ item: p["events[0][name]"], warningcode: "nopermissions", message: "Sin permiso" }] };
        const n = Math.max(1, Number(p["events[0][repeats]"] ?? 0));
        const first = 5000 + this.seq;
        this.seq += n;
        const out: CalEvent[] = [];
        for (let i = 0; i < n; i++) {
            const e: CalEvent = {
                id: first + i,
                name: p["events[0][name]"] ?? "",
                description: p["events[0][description]"] ?? "",
                courseid: Number(p["events[0][courseid]"] ?? 0),
                groupid: Number(p["events[0][groupid]"] ?? 0),
                userid: USER_ID,
                repeatid: n > 1 ? first : 0,
                eventtype: type,
                timestart: Number(p["events[0][timestart]"]) + i * 7 * 86_400,
                timeduration: Number(p["events[0][timeduration]"] ?? 0),
            };
            this.events.set(e.id, e);
            out.push(e);
        }
        return { events: out, warnings: [] };
    }

    private deleteEvent(p: Record<string, string>) {
        if (p["events[0][repeat]"] === undefined) return { exception: "invalid_parameter_exception", errorcode: "invalidparameter", message: "repeat requerido" };
        const id = Number(p["events[0][eventid]"]);
        const e = this.events.get(id);
        if (!e) return { exception: "dml_missing_record_exception", errorcode: "invalidrecord", message: "No existe" };
        this.events.delete(id);
        // Sin repeat, si se borra el padre se promueve el siguiente como padre de la serie.
        if (e.repeatid === id) {
            const rest = [...this.events.values()].filter((x) => x.repeatid === id).sort((a, b) => a.timestart - b.timestart);
            for (const x of rest) x.repeatid = rest[0]!.id;
        }
        return null;
    }
}
