import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile, packageRoot, parseProfile } from "../../src/config/profile.js";
import { CampusError } from "../../src/errors.js";
import { makeHarness } from "../fixtures/harness.js";
import {
    ANON_ASSIGN,
    ASSIGN,
    COURSE,
    OTHER_ASSIGN,
    OTHER_COURSE,
    STUDENT_A,
    STUDENT_B,
    STUDENT_C,
    STUDENT_INJECTION,
    syntheticProfileJson,
    TEACH_COURSE_2,
} from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

const TEACHING = { course_scope: "teaching", allowed_course_ids: [] };

describe("perfil udesa-docente y alcance por rol", () => {
    it("el perfil versionado udesa-docente carga (alcance en enrolled-scope.test.ts)", () => {
        const p = loadProfile({ profileId: "udesa-docente", env: {} });
        expect(p.course_scope).toBe("enrolled");
        expect(p.teacher_role_shortnames).toEqual(["editingteacher", "teacher"]);
        expect(p.read_only).toBe(true);
        const raw = JSON.parse(readFileSync(join(packageRoot(), "profiles", "udesa-docente.json"), "utf8"));
        expect(raw.announcement_forum_id).toBeNull();
    });

    it("validaciones: allowlist vacía o foro fijo con varios cursos son errores", () => {
        expect(() => parseProfile(syntheticProfileJson({ allowed_course_ids: [] }))).toThrow(CampusError);
        expect(() => parseProfile(syntheticProfileJson({ ...TEACHING, announcement_forum_id: 3001 }))).toThrow(CampusError);
    });

    it("lista sólo cursos con rol docente; los de estudiante quedan afuera", async () => {
        const h = await makeHarness({ profile: TEACHING });
        const r = await h.app.service.listCourses();
        expect(r.data.map((c) => c.course_id).sort()).toEqual([COURSE, TEACH_COURSE_2]);
        expect(r.data.find((c) => c.course_id === TEACH_COURSE_2)!.roles).toEqual(["teacher"]);
        expect(JSON.stringify(r)).not.toContain("OTRO");
        expect(JSON.stringify(r)).not.toContain("docente@campus.example.test"); // el perfil de usuario se descarta
    });

    it("curso de estudiante → POLICY_DENIED antes de consultar su contenido", async () => {
        const h = await makeHarness({ profile: TEACHING });
        await h.app.service.listCourses();
        const before = h.fake.callsOf("core_course_get_contents").length;
        expect(await codeOf(h.app.service.getCourse(OTHER_COURSE))).toBe("POLICY_DENIED");
        expect(h.fake.callsOf("core_course_get_contents").length).toBe(before);
        // curso docente nuevo: accesible sin tocar el perfil
        expect((await h.app.service.getCourse(TEACH_COURSE_2)).data.course_id).toBe(TEACH_COURSE_2);
    });

    it("excluded_course_ids saca un curso docente del alcance", async () => {
        const h = await makeHarness({ profile: { ...TEACHING, excluded_course_ids: [TEACH_COURSE_2] } });
        expect((await h.app.service.listCourses()).data.map((c) => c.course_id)).toEqual([COURSE]);
        expect(await codeOf(h.app.service.getCourse(TEACH_COURSE_2))).toBe("POLICY_DENIED");
    });

    it("si falla la consulta de roles es un error, nunca «sin cursos» ni «todos»", async () => {
        const h = await makeHarness({ profile: TEACHING });
        h.fake.overrides.set("core_user_get_course_user_profiles", () => ({ exception: "required_capability_exception", errorcode: "nopermissions", message: "No" }));
        expect(await codeOf(h.app.service.listCourses())).toBe("MOODLE_PERMISSION_DENIED");
        expect(await codeOf(h.app.service.getCourse(COURSE))).toBe("MOODLE_PERMISSION_DENIED");
    });

    it("el alcance se cachea: dos consultas seguidas no repiten la resolución de roles", async () => {
        const h = await makeHarness({ profile: TEACHING });
        await h.app.service.getCourse(COURSE);
        const n = h.fake.callsOf("core_user_get_course_user_profiles").length;
        await h.app.service.getCourse(TEACH_COURSE_2);
        expect(h.fake.callsOf("core_user_get_course_user_profiles").length).toBe(n);
    });
});

describe("tareas", () => {
    it("lista tareas del curso con fechas, tipos y consigna; filtra las de otros cursos", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listAssignments(COURSE);
        expect(r.data.assignments.map((a) => a.assignment_id).sort()).toEqual([ASSIGN, ANON_ASSIGN]);
        const tp1 = r.data.assignments.find((a) => a.assignment_id === ASSIGN)!;
        expect(tp1.submission.types).toEqual(["file", "onlinetext"]);
        expect(tp1.submission.max_files).toBe(3);
        expect(tp1.dates.grading_due).toBeNull(); // 0 ≠ 1970
        expect(tp1.intro_markdown).toBe("Consigna del **TP1**.");
        expect(r.data.assignments.find((a) => a.assignment_id === ANON_ASSIGN)!.anonymous_grading).toBe(true);
        expect(r.warnings.join(" ")).toMatch(/prórrogas/);
    });
});

describe("entregas (datos de estudiantes)", () => {
    it("estado por participante con totales; sin email, legajo, usuario ni notas", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmissionStatus({ course_id: COURSE, assignment_id: ASSIGN });
        expect(r.data.summary).toMatchObject({ participants: 3, submitted: 1, not_submitted: 2, requires_grading: 1, extensions_granted: 1, late: 1 });
        expect(r.data.summary.by_status).toEqual({ submitted: 1, new: 1, draft: 1 });
        const ana = r.data.participants.find((p) => p.participant_id === STUDENT_A)!;
        expect(ana).toMatchObject({ name: "Ana Sintética", groups: ["Comisión A"], status: "submitted", late: true });
        expect(r.data.participants.find((p) => p.participant_id === STUDENT_B)!.late).toBeNull(); // con prórroga
        const text = JSON.stringify(r);
        for (const leaked of ["ana@campus", "L-0001", '"username"', "8,00"]) expect(text).not.toContain(leaked);
        expect(r.warnings.join(" ")).toMatch(/datos de estudiantes/);
    });

    it("corrección anónima: etiquetas de Moodle y sin cruzar fechas de entrega", async () => {
        const h = await makeHarness();
        const before = h.fake.callsOf("mod_assign_get_submissions").length;
        const r = await h.app.service.getSubmissionStatus({ course_id: COURSE, assignment_id: ANON_ASSIGN });
        expect(r.data.participants.map((p) => p.name)).toEqual(["Participante 1", "Participante 2"]);
        expect(r.data.participants.every((p) => p.last_modified === null && p.late === null)).toBe(true);
        expect(h.fake.callsOf("mod_assign_get_submissions").length).toBe(before);
    });

    it("tarea de otro curso → RESOURCE_OUT_OF_SCOPE antes de listar participantes", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getSubmissionStatus({ course_id: COURSE, assignment_id: OTHER_ASSIGN }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.callsOf("mod_assign_list_participants")).toHaveLength(0);
        expect(await codeOf(h.app.service.getSubmissionStatus({ course_id: OTHER_COURSE, assignment_id: OTHER_ASSIGN }))).toBe("POLICY_DENIED");
    });

    it("entrega de un participante: archivos y texto, sin nota ni devolución; el texto del alumno es dato", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_A });
        expect(r.data.status).toBe("submitted");
        expect(r.data.late).toBe(true);
        expect(r.data.grading_status).toBe("graded");
        expect(r.data.online_text.markdown).toBe(STUDENT_INJECTION);
        expect(r.data.files.map((f) => f.name)).toEqual(["tp1.py", "entrega.zip", "captura.png"]);
        const text = JSON.stringify(r);
        expect(text).not.toContain("8,00");
        expect(text).not.toContain("DEVOLUCION-PRIVADA");
        const file = await h.app.service.readFile({ file_ref: r.data.files[0]!.ref });
        expect(file.data.text).toBe("def f(x):\n    return x * 2\n");
        expect(file.data.file.origin.kind).toBe("submission");
    });

    it("participante que no está en la tarea → bloqueo sin pedir su entrega", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: 999 }))).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.callsOf("mod_assign_get_submission_status")).toHaveLength(0);
        // un participante válido sí
        expect((await h.app.service.getSubmission({ course_id: COURSE, assignment_id: ASSIGN, participant_id: STUDENT_C })).data.status).toBe("new");
    });
});

describe("calendario y recursos", () => {
    it("eventos del curso ordenados, sin los de otros cursos; rango inválido es error", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listEvents({ course_id: COURSE });
        expect(r.data.events.map((e) => e.event_id)).toEqual([5000, 5001, 5003]);
        expect(r.data.events[0]!.end).not.toBeNull();
        const call = h.fake.callsOf("core_calendar_get_calendar_events")[0]!;
        expect(call.params["options[userevents]"]).toBe("0");
        expect(await codeOf(h.app.service.listEvents({ course_id: COURSE, from: "2026-10-10", to: "2026-10-01" }))).toBe("POLICY_DENIED");
        expect(await codeOf(h.app.service.listEvents({ course_id: COURSE, from: "ayer" }))).toBe("POLICY_DENIED");
    });

    it("recursos: páginas con extracto, enlaces sin secretos, archivos como file_ref; nada de otros cursos", async () => {
        const h = await makeHarness();
        const r = await h.app.service.listResources(COURSE);
        expect(r.data.pages.map((p) => p.page_id)).toEqual([1201]);
        expect(r.data.pages[0]!.excerpt_truncated).toBe(true);
        expect(r.data.urls[0]!.url).toBe("https://colab.example.org/nb?x=1");
        expect(r.data.files[0]!.files[0]!.ref).toMatch(/^file_/);
        expect(JSON.stringify(r)).not.toContain("NO DEBE EXPONERSE");
    });

    it("página completa paginada; página de otro curso bloqueada", async () => {
        const h = await makeHarness();
        const p1 = await h.app.service.getPage({ course_id: COURSE, page_id: 1201 });
        expect(p1.data.content_markdown.startsWith("## Reglas")).toBe(true);
        expect(p1.coverage.has_more).toBe(false); // 3000 chars de límite en el perfil sintético alcanzan
        expect(await codeOf(h.app.service.getPage({ course_id: COURSE, page_id: 1299 }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });
});
