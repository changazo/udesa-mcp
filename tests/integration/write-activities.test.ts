import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { resultError } from "../../src/write/engine.js";
import { checkWriteAjax, checkWriteForm, checkWriteFormQuery, WRITE_WEB_FORMS } from "../../src/write/functions.js";
import { parseFormFields } from "../../src/write/web.js";
import { COURSE, NOW_UNIX, STUDENT_A, VALID_TOKEN } from "../fixtures/fake-moodle.js";
import { WEB_SESSKEY, WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

const CAPS = ["create_assignment", "grant_extension", "lock_submissions"];
const harness = () => makeWriteHarness({ policy: { courses: { [String(COURSE)]: CAPS } } });
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const posts = (h: WriteHarness) => h.fake.web.requests.filter((r) => r.path === "/course/modedit.php" && r.method === "POST");

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

const DUE = Math.floor(NOW_UNIX / 3600) * 3600 + 7 * 86_400;

describe("crear una tarea por formulario web (ADR-050)", () => {
    it("plan: oculta por defecto (R1), fechas y opciones explícitas, sin notificaciones; no abre el formulario al planificar", async () => {
        const h = await harness();
        const p = await plan(h, "create_assignment", { name: "TP de prueba", section: 1, due: iso(DUE), intro: "Consigna **breve**" });
        expect(p.risk).toBe("R1");
        expect(p.items[0]).toMatchObject({ function: "course_modedit_assign_add", via: "form" });
        expect(p.payload_preview).toMatchObject({ visible: false, cutoff: "sin fecha", max_grade: 100, submission_types: { online_text: true, files: true } });
        expect(String((p.payload_preview as { notifications: string }).notifications)).toMatch(/ninguna/);
        expect(h.w2.formGets).toHaveLength(0);
    });

    it("sección inexistente, fechas desordenadas o sin tipo de entrega: rechazo en el plan, sin abrir el formulario (crearía secciones)", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "create_assignment", { name: "x", section: 9 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect((await errOf(plan(h, "create_assignment", { name: "x", section: 1, allow_from: iso(DUE), due: iso(DUE - 3600) }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "create_assignment", { name: "x", section: 1, online_text: false, files: false }))).code).toBe("WRITE_NOT_ALLOWED");
        expect(h.w2.formGets).toHaveLength(0);
    });

    it("ejecución: GET + un POST; conserva los valores del formulario, fuerza las notificaciones en 0; verificada; deshacer la borra (cm_delete)", async () => {
        const h = await harness();
        const p = await plan(h, "create_assignment", { name: "TP de prueba", section: 1, due: iso(DUE), allow_from: iso(DUE - 7 * 86_400) });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(posts(h)).toHaveLength(1);
        const created = h.w2.assignments.find((a) => a.name === "TP de prueba")!;
        expect(created).toMatchObject({ visible: false, section: 1, duedate: DUE, cutoffdate: 0 });
        expect(created.posted).toMatchObject({
            coursecontentnotification: "0",
            sendnotifications: "0",
            sendlatenotifications: "0",
            sendstudentnotifications: "0",
            visible: "0",
            "cutoffdate[enabled]": "0",
            "gradingduedate[enabled]": "0",
            // Valores del formulario que no tocó el plan: se conservan.
            module: "24",
            assignsubmission_comments_enabled: "1",
            "introeditor[itemid]": "123456",
            submitbutton: "1",
        });
        expect(created.posted).not.toHaveProperty("submitbutton2");
        expect(r.moodle_ids).toMatchObject({ cmid: [created.cmid], assignment_id: [created.id] });

        // Con la tarea creada se pueden dar prórrogas y bloquear entregas sobre ella.
        const ext = await exec(h, (await plan(h, "extension", { assignment_id: created.id, participant_ids: [STUDENT_A], until: iso(DUE + 86_400) })).plan_id);
        expect(ext.status).toBe("aplicado_verificado");

        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error("debería poder deshacerse");
        expect(u.plan.items[0]).toMatchObject({ function: "core_courseformat_update_course", via: "ajax" });
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(h.w2.assignments.some((a) => a.cmid === created.cmid)).toBe(false);
    });

    it("errores del formulario (200 con el formulario) → MOODLE_REJECTED con el mensaje", async () => {
        const h = await harness();
        const r = await exec(h, (await plan(h, "create_assignment", { name: "   ", section: 1 })).plan_id);
        expect(r.status).toBe("rechazado_por_moodle");
        expect(resultError(r)?.message).toMatch(/Debe suministrar un valor/);
    });

    it("HTTP 500 después de crear: no reenvía; reconcilia por nombre y verifica", async () => {
        const h = await harness();
        h.w2.formMode = "500_after";
        const r = await exec(h, (await plan(h, "create_assignment", { name: "Única", section: 2 })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(posts(h)).toHaveLength(1);
        expect(h.w2.assignments.filter((a) => a.name === "Única")).toHaveLength(1);
    });

    it("sesión web vencida en el envío: AUTH_REQUIRED y el plan sigue pendiente", async () => {
        const h = await harness();
        h.w2.formMode = "login";
        const p = await plan(h, "create_assignment", { name: "x", section: 1 });
        expect((await errOf(exec(h, p.plan_id))).code).toBe("AUTH_REQUIRED");
        expect((await h.app.engine.getPlan(p.plan_id)).state.status).toBe("pendiente");
    });

    it("sin sesskey, cookies ni token en planes, auditoría ni logs", async () => {
        const h = await harness();
        await exec(h, (await plan(h, "create_assignment", { name: "Secretos", section: 1 })).plan_id);
        const plans = readdirSync(join(h.dir, "plans")).map((f) => readFileSync(join(h.dir, "plans", f), "utf8")).join("\n");
        const all = [plans, readFileSync(join(h.dir, "write-audit.jsonl"), "utf8"), h.logs.join("\n")].join("\n");
        for (const s of [WEB_SESSKEY, WEB_SESSION_OK, VALID_TOKEN]) expect(all).not.toContain(s);
        expect(all).toContain("form:course_modedit_assign_add");
    });
});

describe("allowlist web de escritura", () => {
    it("formulario: campos fuera de la allowlist, notificar o parámetros de GET inválidos se rechazan", () => {
        const base = { name: "x", visible: "0", coursecontentnotification: "0", sendnotifications: "0", sendlatenotifications: "0", sendstudentnotifications: "0" };
        const code = (fn: () => unknown) => {
            try {
                fn();
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        expect(code(() => checkWriteForm("course_modedit_assign_add", base))).toBe("OK");
        expect(code(() => checkWriteForm("course_modedit_assign_add", { ...base, coursecontentnotification: "1" }))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteForm("course_modedit_assign_add", { ...base, sendstudentnotifications: "1" }))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteForm("course_modedit_assign_add", { ...base, availabilityconditionsjson: "{}" }))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteForm("course_modedit_quiz_add", base))).toBe("POLICY_DENIED");
        const spec = WRITE_WEB_FORMS.find((s) => s.id === "course_modedit_assign_add")!;
        expect(code(() => checkWriteFormQuery(spec, { add: "assign", course: "1", section: "1" }))).toBe("OK");
        expect(code(() => checkWriteFormQuery(spec, { add: "forum", course: "1", section: "1" }))).toBe("POLICY_DENIED");
        expect(code(() => checkWriteFormQuery(spec, { add: "assign", course: "1", section: "1", update: "5" }))).toBe("POLICY_DENIED");
    });

    it("AJAX: cm_delete y section_delete de UN id; otras acciones y genéricos, rechazados", () => {
        const code = (m: string, a: Record<string, unknown>) => {
            try {
                checkWriteAjax(m, a);
                return "OK";
            } catch (e) {
                return (e as CampusError).code;
            }
        };
        expect(code("core_courseformat_update_course", { action: "cm_delete", courseid: 1, ids: [5] })).toBe("OK");
        expect(code("core_courseformat_update_course", { action: "cm_delete", courseid: 1, ids: [5, 6] })).toBe("POLICY_DENIED");
        // Desde ADR-067 section_delete está en la allowlist (sólo con la intención delete_content), de a un id.
        expect(code("core_courseformat_update_course", { action: "section_delete", courseid: 1, ids: [5] })).toBe("OK");
        expect(code("core_courseformat_update_course", { action: "section_delete", courseid: 1, ids: [5, 6] })).toBe("POLICY_DENIED");
        expect(code("core_courseformat_update_course", { action: "section_duplicate", courseid: 1, ids: [5] })).toBe("POLICY_DENIED");
        expect(code("core_courseformat_update_course", { action: "cm_delete", courseid: 1, ids: [5], targetcmid: 2 })).toBe("POLICY_DENIED");
        expect(code("core_update_inplace_editable", { component: "core_course" })).toBe("POLICY_DENIED");
    });

    it("parser del formulario: casillas sin marcar se omiten, selects toman el seleccionado, textareas su texto", () => {
        const html = `<form><input type="hidden" name="_qf__x" value="1"><input type="text" name="name" value="A &amp; B">
<input type="checkbox" name="c1" value="1"><input type="checkbox" name="c2" value="1" checked><input type="submit" name="go" value="Ir">
<select name="s"><option value="a">A</option><option value="b" selected>B</option></select><select name="t"><option value="x">X</option></select>
<textarea name="ta">hola &lt;b&gt;</textarea><input type="text" name="dis" value="1" disabled></form>`;
        expect(parseFormFields(html, "_qf__x")).toEqual([
            ["_qf__x", "1"],
            ["name", "A & B"],
            ["c2", "1"],
            ["s", "b"],
            ["t", "x"],
            ["ta", "hola <b>"],
        ]);
        expect(parseFormFields(html, "_qf__otro")).toBeNull();
    });
});
