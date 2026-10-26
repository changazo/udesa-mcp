import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { ASSIGN_CMID, COURSE, NEWS_CMID, QUIZ, QUIZ_CMID, SITE, STUDENT_A, STUDENT_B, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";

const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
const web = () => new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" });

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("configuración legible (§11)", () => {
    it("tarea: fechas configuradas y desactivadas, entrega, grupos separados, restricciones presentes", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: ASSIGN_CMID });
        const s = r.data.settings as Record<string, Record<string, unknown>>;
        expect(s.dates!.due).toMatchObject({ state: "configurada" });
        expect(s.dates!.remind_grade_by).toEqual({ value: null, state: "desactivada" });
        expect(s.submission).toMatchObject({ files: true, max_files: 3, online_text: true, max_attempts: "ilimitados", drafts_require_submit: true, comments: null });
        expect(s.groups).toMatchObject({ group_mode: "separados", team_submission: false });
        expect(r.data.visibility.restrictions).toMatchObject({ state: "configuradas", condition_types: ["date", "group"] });
        // Con restricciones, que el docente la vea no prueba que la vean todos.
        expect(r.data.visibility.visible_to_students).toBeNull();
        expect(h.fake.web.requests).toHaveLength(0);
    });

    it("tarea con participante: fechas efectivas calculadas por Moodle", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: ASSIGN_CMID, participant_id: STUDENT_A });
        expect((r.data.effective_for_participant as { dates: { status: string } }).dates.status).toBe("ok");
    });

    it("cuestionario: límites con 0 interpretado por contrato y sin contraseña", async () => {
        const h = await makeHarness();
        const r = await h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: QUIZ_CMID });
        const s = r.data.settings as Record<string, unknown>;
        expect((s.dates as Record<string, unknown>).close).toEqual({ value: null, state: "desactivada" });
        expect(s.time_limit_seconds).toBe(1800);
        expect(s.attempts).toBe(2);
        expect(s.password).toBe("excluida (no se lee)");
        expect(JSON.stringify(r)).not.toContain("CLAVE-QUIZ-SECRETA");
        expect(r.coverage.detail!.unknown_fields).toContain("review_options");
    });

    it("overrides del cuestionario (web): sin contraseña; con participante, sólo los suyos y los de sus grupos", async () => {
        const h = await makeHarness({ webSource: web() });
        h.fake.web.ajax.set("mod_quiz_get_overrides", () => ({
            overrides: [
                { id: 1, quiz: QUIZ, userid: STUDENT_A, groupid: null, timeopen: null, timeclose: 1790500000, timelimit: null, attempts: 3, password: "CLAVE-OVERRIDE" },
                { id: 2, quiz: QUIZ, userid: null, groupid: 1, timeopen: null, timeclose: null, timelimit: 3600, attempts: null, password: null },
                { id: 3, quiz: QUIZ, userid: null, groupid: 2, timeopen: null, timeclose: null, timelimit: 60, attempts: null, password: null },
                { id: 4, quiz: QUIZ, userid: STUDENT_B, groupid: null, timeopen: null, timeclose: null, timelimit: null, attempts: 9, password: null },
            ],
        }));
        const r = await h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: QUIZ_CMID, participant_id: STUDENT_A, include_overrides: true });
        const ov = r.data.overrides as { target: string; participant_id: number | null; group_id: number | null; attempts: unknown; time_limit_seconds: unknown }[];
        expect(ov.map((o) => [o.target, o.participant_id, o.group_id])).toEqual([
            ["participante", STUDENT_A, null],
            ["grupo", null, 1],
        ]);
        expect(ov[0]!.time_limit_seconds).toBe("sin_cambio");
        expect(JSON.stringify(r)).not.toContain("CLAVE-OVERRIDE");
    });

    it("otro tipo de actividad o actividad ajena: error explícito", async () => {
        const h = await makeHarness();
        expect(await codeOf(h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: NEWS_CMID }))).toBe("UNSUPPORTED_CONTENT");
        expect(await codeOf(h.app.service.getActivitySettings({ course_id: COURSE, course_module_id: 123456 }))).toBe("RESOURCE_OUT_OF_SCOPE");
    });
});
