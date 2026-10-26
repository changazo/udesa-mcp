import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { MemorySecretStore } from "../../src/session/secret-store.js";
import { assertAjax, assertWebRoute } from "../../src/web/policy.js";
import {
    EnvWebSessionSource,
    KeyringWebSessionSource,
    MemoryWebSessionSource,
    encodeSnapshot,
    parseCookieInput,
    revisionOf,
    type WebSessionSnapshot,
} from "../../src/web/session.js";
import { SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK, WEB_SESSION_OTHER, WEB_SESSKEY } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";

const snap = (value: string, userId = USER_ID): WebSessionSnapshot => {
    const cookies = [{ name: "MoodleSession", value, expires: null }];
    return { v: 1, origin: SITE, path_prefix: "", user_id: userId, cookies, revision: revisionOf(cookies), imported_at: "2026-10-19T00:00:00.000Z" };
};

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

const GRADING = "mod_quiz_get_edit_grading_page_data";

describe("sesión web: aceptación (§5.4)", () => {
    it("inicio en frío con snapshot válido: identidad verificada y AJAX admitido", async () => {
        const h = await makeHarness({ webSource: new EnvWebSessionSource(encodeSnapshot(snap(WEB_SESSION_OK))) });
        h.fake.web.ajax.set(GRADING, () => JSON.stringify({ quizid: 1 }));
        const op = await h.app.web!.open();
        const data = await op.ajax<string>(GRADING, { quizid: 1 });
        expect(JSON.parse(data)).toEqual({ quizid: 1 });
        const reqs = h.fake.web.requests;
        expect(reqs[0]!.path).toBe("/user/preferences.php");
        expect(reqs[1]!.query.sesskey).toBe(WEB_SESSKEY);
        expect(reqs.every((r) => r.cookie === `MoodleSession=${WEB_SESSION_OK}`)).toBe(true);
    });

    it("snapshot vencido (redirección a login): AUTH_REQUIRED y la revisión queda descartada en esa instancia", async () => {
        const src = new EnvWebSessionSource(encodeSnapshot(snap("vencida00000000000000000")));
        const h = await makeHarness({ webSource: src });
        expect(await codeOf(h.app.web!.open())).toBe("AUTH_REQUIRED");
        expect(await src.load()).toBeNull();
    });

    it("página de login con HTTP 200 no se toma como sesión válida", async () => {
        const src = new MemoryWebSessionSource(snap("vencida00000000000000000"));
        const h = await makeHarness({ webSource: src });
        h.fake.web.loginMode = "page200";
        expect(await codeOf(h.app.web!.open())).toBe("AUTH_REQUIRED");
        expect(src.snapshot).toBeNull();
    });

    it("identidad equivocada: la página válida de otra cuenta no entrega datos", async () => {
        const h = await makeHarness({ webSource: new MemoryWebSessionSource(snap(WEB_SESSION_OTHER)) });
        h.fake.web.ajax.set(GRADING, () => "{}");
        expect(await codeOf(h.app.web!.open())).toBe("IDENTITY_MISMATCH");
        expect(h.fake.web.requests.filter((r) => r.path === "/lib/ajax/service.php")).toHaveLength(0);
    });

    it("snapshot importado para otra cuenta: se rechaza antes de emitir red", async () => {
        const h = await makeHarness({ webSource: new MemoryWebSessionSource(snap(WEB_SESSION_OK, 999)) });
        expect(await codeOf(h.app.web!.open())).toBe("IDENTITY_MISMATCH");
        expect(h.fake.web.requests).toHaveLength(0);
    });

    it("rotación durante la importación: se guarda la cookie rotada y nada ajeno a Moodle", async () => {
        const h = await makeHarness({ webSource: new MemoryWebSessionSource(null) });
        h.fake.web.rotateTo = "rotadaenimport0000000000";
        const s = await h.app.web!.validateImport(parseCookieInput(`MoodleSession=${WEB_SESSION_OK}; _ga=xyz`), new Date());
        expect(s.cookies.map((c) => `${c.name}=${c.value}`)).toEqual(["MoodleSession=rotadaenimport0000000000"]);
        expect(s.revision).toBe(revisionOf(s.cookies));
    });

    it("remoto: la rotación vive sólo en la operación; la siguiente invocación pide renovación explícita", async () => {
        const raw = encodeSnapshot(snap(WEB_SESSION_OK));
        const h1 = await makeHarness({ webSource: new EnvWebSessionSource(raw) });
        h1.fake.web.ajax.set(GRADING, () => "{}");
        h1.fake.web.rotateTo = "rotadaenpeticion00000000";
        const op = await h1.app.web!.open();
        await op.ajax(GRADING, { quizid: 1 });
        await h1.app.web!.afterOperation(op);
        // Nueva instancia, mismo snapshot configurado: el Campus ya invalidó la cookie anterior.
        const h2 = await makeHarness({ webSource: new EnvWebSessionSource(raw) });
        h2.fake.web.sessions.delete(WEB_SESSION_OK);
        expect(await codeOf(h2.app.web!.open())).toBe("AUTH_REQUIRED");
    });

    it("local: una rotación validada se persiste en el keyring y la siguiente operación la usa", async () => {
        const secrets = new MemorySecretStore();
        const src = new KeyringWebSessionSource(secrets, "p|s|web_session");
        await src.save(snap(WEB_SESSION_OK));
        const h = await makeHarness({ webSource: src });
        h.fake.web.rotateTo = "rotadalocal0000000000000";
        const op = await h.app.web!.open();
        await h.app.web!.afterOperation(op);
        expect((await src.load())!.cookies[0]!.value).toBe("rotadalocal0000000000000");
        await h.app.web!.open();
        expect(h.fake.web.requests.at(-1)!.cookie).toBe("MoodleSession=rotadalocal0000000000000");
    });

    it("configuración reemplazada por una revisión nueva: se usa la nueva", async () => {
        const h = await makeHarness({ webSource: new EnvWebSessionSource(encodeSnapshot(snap("vencida00000000000000000"))) });
        expect(await codeOf(h.app.web!.open())).toBe("AUTH_REQUIRED");
        const h2 = await makeHarness({ webSource: new EnvWebSessionSource(encodeSnapshot(snap(WEB_SESSION_OK))) });
        await expect(h2.app.web!.open()).resolves.toBeTruthy();
    });

    it("redirección a otro origen: se bloquea sin reenviar credenciales", async () => {
        const h = await makeHarness({ webSource: new MemoryWebSessionSource(snap(WEB_SESSION_OK)) });
        h.fake.web.redirectTo = "https://evil.example.test/robar";
        expect(await codeOf(h.app.web!.open())).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(h.fake.foreign).toHaveLength(0);
    });

    it("redirección a otra página del Campus: no se sigue (la política audita la ruta pedida)", async () => {
        const h = await makeHarness({ webSource: new MemoryWebSessionSource(snap(WEB_SESSION_OK)) });
        h.fake.web.redirectTo = "https://campus.example.test/mod/attendance/view.php?id=1";
        expect(await codeOf(h.app.web!.open())).toBe("UNEXPECTED_RESPONSE");
        expect(h.fake.web.requests.map((r) => r.path)).not.toContain("/mod/attendance/view.php");
    });

    it("sin keyring local: SECRET_STORE_UNAVAILABLE, sin respaldo en archivo", async () => {
        const secrets = new MemorySecretStore();
        secrets.available = false;
        const src = new KeyringWebSessionSource(secrets, "p|s|web_session");
        const h = await makeHarness({ webSource: src });
        expect(await codeOf(h.app.web!.open())).toBe("SECRET_STORE_UNAVAILABLE");
    });

    it("sin sesión web, las lecturas REST siguen funcionando", async () => {
        const h = await makeHarness();
        expect(h.app.web).toBeNull();
        await expect(h.app.service.listCourses()).resolves.toBeTruthy();
    });
});

describe("política web (antes de emitir red)", () => {
    it("rechaza rutas, parámetros prohibidos y valores inválidos", () => {
        expect(() => assertWebRoute("question_export_one", { id: "1", cmid: "2", sesskey: "x" })).toThrow(/prohibido/);
        expect(() => assertWebRoute("quiz_responses", { id: "1", mode: "responses", regrade: "1" })).toThrow(/prohibido/);
        expect(() => assertWebRoute("quiz_responses", { id: "1", mode: "overview" })).toThrow(/Valor no admitido/);
        expect(() => assertWebRoute("course_log", { id: "1", chooselog: "1", tsort: "time" })).toThrow(/prohibido/);
        expect(() => assertWebRoute("course_log", { id: "1" })).toThrow(/Falta/);
        expect(() => assertWebRoute("question_export_one", { id: "1", cmid: "2", extra: "x" })).toThrow(/no admitido/);
    });

    it("rechaza AJAX no admitido o con argumentos fuera de contrato, sin emitir la petición", async () => {
        const h = await makeHarness({ webSource: new MemoryWebSessionSource(snap(WEB_SESSION_OK)) });
        const op = await h.app.web!.open();
        const before = h.fake.web.requests.length;
        expect(await codeOf(op.ajax("core_user_get_users_by_field", {}))).toBe("POLICY_DENIED");
        expect(await codeOf(op.ajax(GRADING, { quizid: 1, extra: 2 }))).toBe("POLICY_DENIED");
        expect(await codeOf(op.ajax("core_question_get_random_question_summaries", { categoryid: 1, includesubcategories: false, tagids: [], contextid: 2, limit: 5000, offset: 0 }))).toBe("POLICY_DENIED");
        expect(h.fake.web.requests.length).toBe(before);
        expect(() => assertAjax("core_question_search_shared_banks", { contextid: 1, search: "", requiredcapabilities: ["edit"] })).toThrow();
    });

    it("ningún error ni log contiene la cookie ni el sesskey", async () => {
        const h = await makeHarness({ webSource: new MemoryWebSessionSource(snap(WEB_SESSION_OK)) });
        h.fake.web.ajax.set(GRADING, () => {
            throw Object.assign(new Error(`falló con sesskey=${WEB_SESSKEY} y MoodleSession=${WEB_SESSION_OK}`), { errorcode: "x" });
        });
        const op = await h.app.web!.open();
        const e = await op.ajax(GRADING, { quizid: 1 }).catch((x) => x as CampusError);
        const text = JSON.stringify({ message: (e as Error).message, logs: h.logs });
        expect(text).not.toContain(WEB_SESSION_OK);
        expect(text).not.toContain(WEB_SESSKEY);
    });
});

describe("importación de la cookie", () => {
    it("acepta el valor solo o la cabecera completa y descarta cookies ajenas a Moodle", () => {
        expect(parseCookieInput("abcdefghijklmnop")).toEqual([{ name: "MoodleSession", value: "abcdefghijklmnop", expires: null }]);
        expect(parseCookieInput("Cookie: _ga=1; MoodleSession=abcdefghij1234; MOODLEID1_=x%25y; G_ENABLED_IDPS=google").map((c) => c.name)).toEqual(["MoodleSession", "MOODLEID1_"]);
        expect(() => parseCookieInput("_ga=1; other=2")).toThrow(/MoodleSession/);
        expect(() => parseCookieInput("a\nb")).toThrow();
    });
});
