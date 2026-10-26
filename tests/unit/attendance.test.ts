import { describe, expect, it } from "vitest";
import { parseRecordedStatuses, parseSessionRoster, parseWindowSessions } from "../../src/domain/attendance.js";
import { paramPolicyViolation } from "../../src/moodle/functions.js";
import { flattenParams } from "../../src/moodle/serialize.js";

const mobile = (component: string, method: string, args: Record<string, string | number>) => {
    const p: Record<string, string | number> = { component, method };
    Object.entries(args).forEach(([k, v], i) => {
        p[`args[${i}][name]`] = k;
        p[`args[${i}][value]`] = v;
    });
    return paramPolicyViolation("tool_mobile_get_content", flattenParams(p));
};

describe("candado de tool_mobile_get_content", () => {
    it("permite sólo los dos métodos de lectura de mod_attendance con sus argumentos", () => {
        expect(mobile("mod_attendance", "mobile_view_activity", { cmid: 1, courseid: 2, appversioncode: 45000 })).toBeNull();
        expect(mobile("mod_attendance", "mobile_teacher_form", { cmid: 1, courseid: 2, sessid: 3, appversioncode: 45000 })).toBeNull();
    });

    it("rechaza argumentos status* (tomarían asistencia), otros métodos, componentes y parámetros", () => {
        expect(mobile("mod_attendance", "mobile_view_activity", { cmid: 1, courseid: 2, sessid: 3, status601: 11 })).toMatch(/no permitido/);
        expect(mobile("mod_attendance", "mobile_view_activity", { cmid: 1, courseid: 2, statusall: 11 })).toMatch(/no permitido/);
        expect(mobile("mod_attendance", "mobile_view_activity", { cmid: 1, sessid: 3 })).toMatch(/sessid no permitido/);
        expect(mobile("mod_attendance", "mobile_user_form", { cmid: 1 })).toMatch(/no está permitido/);
        expect(mobile("mod_quiz", "mobile_view_activity", { cmid: 1 })).toMatch(/no está permitido/);
        const extra = flattenParams({ component: "mod_attendance", method: "mobile_view_activity", "args[0][name]": "cmid", "args[0][value]": 1, otro: 1 });
        expect(paramPolicyViolation("tool_mobile_get_content", extra)).toMatch(/otro no permitido/);
        expect(paramPolicyViolation("core_course_get_contents", flattenParams({ courseid: 1 }))).toBeNull();
    });
});

describe("parser de las vistas móviles de asistencia", () => {
    it("extrae sesiones de la ventana con hora y grupo", () => {
        const html = `<core-course-module-info></core-course-module-info>
            <ion-card><h2>lun 3 ago, 9:00 - 10:30</h2><h3>Comisión &amp; A</h3><h3></h3>
            <ion-button [args]="{cmid: 5, courseid: 7, sessid: 8654, timestamp: 1790000000}">x</ion-button></ion-card>
            <ion-card><h2>mar 20 oct, 9:00</h2><h3></h3><h3>Presente</h3></ion-card>`;
        expect(parseWindowSessions(html)).toEqual([{ session_id: 8654, time_text: "lun 3 ago, 9:00 - 10:30", group: "Comisión & A" }]);
        expect(parseWindowSessions("<p>nada</p>")).toEqual([]);
    });

    it("extrae estados y alumnos sin duplicar el «marcar a todos»", () => {
        const radios = `<ion-radio value="11">P</ion-radio><ion-radio value="12">A</ion-radio>`;
        const html = `<div class="attendance_mobile_teacher_form"><ion-radio-group [(ngModel)]="CONTENT_OTHERDATA.statusall">${radios}</ion-radio-group>
            <ion-item title="Ana"><h2>Ana</h2></ion-item><ion-radio-group [(ngModel)]="CONTENT_OTHERDATA.status601">${radios}</ion-radio-group>
            <ion-item title="Beto &amp; Cía"></ion-item><ion-radio-group [(ngModel)]="CONTENT_OTHERDATA.status602">${radios}</ion-radio-group></div>`;
        const r = parseSessionRoster(html);
        expect(r.recognized).toBe(true);
        expect(r.statuses).toEqual([
            { status_id: 11, acronym: "P" },
            { status_id: 12, acronym: "A" },
        ]);
        expect(r.students).toEqual([
            { participant_id: 601, name: "Ana" },
            { participant_id: 602, name: "Beto & Cía" },
        ]);
        expect(parseSessionRoster("<div>otra cosa</div>").recognized).toBe(false);
    });

    it("lee los estados registrados de otherdata en lista o en objeto", () => {
        expect([...parseRecordedStatuses([{ name: "status601", value: "11" }, { name: "statusall", value: "11" }, { name: "x", value: 1 }])]).toEqual([[601, 11]]);
        expect([...parseRecordedStatuses({ status602: 12 })]).toEqual([[602, 12]]);
        expect(parseRecordedStatuses(undefined).size).toBe(0);
    });
});
