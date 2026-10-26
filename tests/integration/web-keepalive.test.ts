import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { MemoryMetadataStore } from "../../src/session/metadata.js";
import { checkWebSession, humanDuration, readWebState, recordCheck, recordPublished, remoteInSync } from "../../src/web/keepalive.js";
import { decodeConsoleOutput, durationMinutes, keepaliveArguments, parseTaskXml, taskName, taskXml, validateEvery } from "../../src/web/keepalive-task.js";
import { MemorySecretStore } from "../../src/session/secret-store.js";
import { encodeSnapshot, KeyringWebSessionSource } from "../../src/web/session.js";
import { assertAjax } from "../../src/web/policy.js";
import { MemoryWebSessionSource, revisionOf } from "../../src/web/session.js";
import { SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { WEB_SESSION_OK } from "../fixtures/fake-web.js";
import { makeHarness } from "../fixtures/harness.js";

const cookies = [{ name: "MoodleSession", value: WEB_SESSION_OK, expires: null }];
const web = () => new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies, revision: revisionOf(cookies), imported_at: "x" });
const TIME = "core_session_time_remaining";
const NOW = new Date("2026-10-19T12:00:00.000Z");

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("keepalive de la sesión web", () => {
    it("renueva con la página de identidad y mide el límite de inactividad", async () => {
        const h = await makeHarness({ webSource: web() });
        h.fake.web.ajax.set(TIME, (a) => {
            expect(a).toEqual({});
            return { userid: USER_ID, timeremaining: 7200 };
        });
        const c = await checkWebSession(h.app.web!, () => NOW);
        expect(c).toMatchObject({ user_id: USER_ID, inactivity_limit_seconds: 7200, expires_if_idle_at: "2026-10-19T14:00:00.000Z", rotated: false, warnings: [] });
        expect(c.revision).toBe(revisionOf(cookies));
        // Sólo la identidad y la medición; ninguna otra ruta ni función.
        expect(h.fake.web.requests.map((r) => `${r.path}${r.query.info ? `:${r.query.info}` : ""}`)).toEqual(["/user/preferences.php", `/lib/ajax/service.php:${TIME}`]);
    });

    it("si el Campus no informa el tiempo restante, la sesión igual queda verificada (con aviso)", async () => {
        const h = await makeHarness({ webSource: web() });
        const c = await checkWebSession(h.app.web!, () => NOW);
        expect(c.inactivity_limit_seconds).toBeNull();
        expect(c.warnings[0]).toMatch(/No se pudo medir/);
    });

    it("tiempo de otra sesión, o vencida: no se informa un límite falso", async () => {
        const h = await makeHarness({ webSource: web() });
        h.fake.web.ajax.set(TIME, () => ({ userid: 0, timeremaining: 7200 }));
        expect((await checkWebSession(h.app.web!)).inactivity_limit_seconds).toBeNull();
        h.fake.web.ajax.set(TIME, () => ({ userid: USER_ID, timeremaining: 0 }));
        expect(await codeOf(checkWebSession(h.app.web!))).toBe("AUTH_REQUIRED");
    });

    it("revisión: un token móvil vencido no se informa como sesión web vencida ni la descarta", async () => {
        const src = web();
        const h = await makeHarness({ loggedIn: false, webSource: src });
        let caught: unknown;
        try {
            await checkWebSession(h.app.web!);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(CampusError);
        expect((caught as CampusError).details).toMatchObject({ component: "mobile_token" });
        expect((caught as CampusError).message).toMatch(/Token del servicio móvil/);
        expect(src.snapshot).not.toBeNull();
        const store = new MemoryMetadataStore();
        recordCheck(store, "keepalive", { error: caught, at: NOW });
        expect(readWebState(store).last_check).toMatchObject({ ok: false, code: "AUTH_REQUIRED", component: "mobile_token" });
    });

    it("revisión: descartar la sesión vencida no borra una importada mientras tanto", async () => {
        const fresh = [{ name: "MoodleSession", value: "nueva00000000000000000000", expires: null }];
        const snap = (c: typeof cookies) => ({ v: 1 as const, origin: SITE, path_prefix: "", user_id: USER_ID, cookies: c, revision: revisionOf(c), imported_at: "x" });
        const mem = new MemoryWebSessionSource(snap(fresh));
        await mem.invalidate(revisionOf(cookies));
        expect(mem.snapshot?.revision).toBe(revisionOf(fresh));
        const secrets = new MemorySecretStore();
        const kr = new KeyringWebSessionSource(secrets, "cuenta");
        await kr.save(snap(fresh));
        await kr.invalidate(revisionOf(cookies));
        expect((await kr.load())?.revision).toBe(revisionOf(fresh));
        await kr.invalidate(revisionOf(fresh));
        expect(await kr.load()).toBeNull();
        await secrets.set("cuenta", encodeSnapshot(snap(fresh)));
        await kr.invalidate();
        expect(await kr.load()).toBeNull();
    });

    it("sesión vencida o ausente: AUTH_REQUIRED explícito", async () => {
        const h = await makeHarness({ webSource: new MemoryWebSessionSource(null) });
        expect(await codeOf(checkWebSession(h.app.web!))).toBe("AUTH_REQUIRED");
        const dead = [{ name: "MoodleSession", value: "vencida000000000000000000", expires: null }];
        const h2 = await makeHarness({ webSource: new MemoryWebSessionSource({ v: 1, origin: SITE, path_prefix: "", user_id: USER_ID, cookies: dead, revision: revisionOf(dead), imported_at: "x" }) });
        expect(await codeOf(checkWebSession(h2.app.web!))).toBe("AUTH_REQUIRED");
    });

    it("una rotación cambia la revisión y deja al remoto desincronizado", async () => {
        const h = await makeHarness({ webSource: web() });
        h.fake.web.ajax.set(TIME, () => ({ userid: USER_ID, timeremaining: 3600 }));
        h.fake.web.rotateTo = "rotada0123456789abcdef0123";
        const c = await checkWebSession(h.app.web!);
        expect(c.rotated).toBe(true);
        expect(c.revision).not.toBe(revisionOf(cookies));
        const store = new MemoryMetadataStore();
        recordPublished(store, revisionOf(cookies), NOW);
        expect(remoteInSync(readWebState(store), c.revision)).toBe(false);
        expect(remoteInSync(readWebState(store), revisionOf(cookies))).toBe(true);
        expect(remoteInSync({}, c.revision)).toBeNull();
    });

    it("el estado local guarda resultados sin cookies ni sesskey", async () => {
        const h = await makeHarness({ webSource: web() });
        h.fake.web.ajax.set(TIME, () => ({ userid: USER_ID, timeremaining: 3600 }));
        const store = new MemoryMetadataStore();
        recordCheck(store, "keepalive", await checkWebSession(h.app.web!, () => NOW));
        recordCheck(store, "keepalive", { error: new CampusError("AUTH_REQUIRED", "x"), at: NOW });
        const s = readWebState(store);
        expect(s.last_check).toEqual({ at: NOW.toISOString(), ok: false, code: "AUTH_REQUIRED", source: "keepalive" });
        expect(JSON.stringify(s)).not.toContain(WEB_SESSION_OK);
    });

    it("política: la medición no acepta argumentos", () => {
        expect(() => assertAjax(TIME, {})).not.toThrow();
        expect(() => assertAjax(TIME, { sid: "x" })).toThrow(/Argumentos no admitidos/);
        expect(() => assertAjax("core_session_touch", {})).toThrow(/no admitida/);
    });

    it("duraciones legibles", () => {
        expect(humanDuration(1800)).toBe("30 min");
        expect(humanDuration(7200)).toBe("2 h");
        expect(humanDuration(28800 + 1800)).toBe("8 h 30 min");
    });
});

describe("tarea programada del keepalive", () => {
    const spec = { nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\a & b\\build\\cli.js", target: { profileId: "udesa-docente" }, everyMinutes: 30, user: "PC\\usuario", conhostPath: "C:\\Windows\\System32\\conhost.exe", start: new Date(2026, 9, 19, 9, 5, 0) };

    it("XML: intervalo, inicio de sesión, sin ventana, con batería, sin secretos y con escapes", () => {
        const xml = taskXml(spec);
        expect(xml).toContain("<Interval>PT30M</Interval>");
        expect(xml).toContain("<StartBoundary>2026-10-19T09:05:00</StartBoundary>");
        expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
        expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
        expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
        expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
        expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
        expect(xml).toContain("C:\\a &amp; b\\build\\cli.js");
        expect(xml).not.toMatch(/MoodleSession|sesskey|wstoken|token=/i);
        const parsed = parseTaskXml(xml);
        expect(parsed).toEqual({ arguments: keepaliveArguments(spec.nodePath, spec.cliPath, spec.target), every_minutes: 30, enabled: true });
        // Como la exporta Windows: sin los valores por defecto.
        expect(parseTaskXml(xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Hidden>")).enabled).toBe(true);
        expect(parseTaskXml(xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>")).enabled).toBe(false);
        expect(parsed.arguments).toBe('--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\a & b\\build\\cli.js" auth web keepalive --profile udesa-docente --quiet');
    });

    it("revisión del 2026-10-19: archivo de perfil y directorio de estado viajan a la tarea; sin comillas en rutas", () => {
        const a = keepaliveArguments("C:\\node.exe", "C:\\cli.js", { profileId: "p", profileFile: "C:\\Perfiles\\año.json", stateDir: "D:\\estado" });
        expect(a).toBe('--headless "C:\\node.exe" "C:\\cli.js" auth web keepalive --profile-file "C:\\Perfiles\\año.json" --state-dir "D:\\estado" --quiet');
        expect(() => keepaliveArguments("C:\\node.exe", "C:\\cli.js", { profileId: "p", stateDir: 'D:\\x" & calc' })).toThrow(/comillas/);
    });

    it("revisión: Windows puede normalizar el intervalo (PT1H, PT1H30M, P1D)", () => {
        expect(durationMinutes("PT45M")).toBe(45);
        expect(durationMinutes("PT1H")).toBe(60);
        expect(durationMinutes("PT1H30M")).toBe(90);
        expect(durationMinutes("P1D")).toBe(1440);
        for (const bad of ["P", "PT", "1H", "PTxM"]) expect(durationMinutes(bad)).toBeNull();
        expect(parseTaskXml(taskXml({ ...spec, everyMinutes: 30 }).replace("PT30M", "PT1H")).every_minutes).toBe(60);
    });

    it("revisión: la salida de schtasks en la página OEM (CP850/437) se lee bien; UTF-8 también", () => {
        expect(decodeConsoleOutput(Buffer.from([0x73, 0x65, 0x73, 0x69, 0xa2, 0x6e, 0x20, 0x61, 0xa4, 0x6f]))).toBe("sesión año");
        expect(decodeConsoleOutput(Buffer.from("C:\\Users\\José Muñoz", "utf8"))).toBe("C:\\Users\\José Muñoz");
    });

    it("intervalo y perfil validados", () => {
        expect(validateEvery(undefined)).toBe(30);
        expect(validateEvery("10")).toBe(10);
        for (const bad of ["4", "241", "1.5", "x", "-30"]) expect(() => validateEvery(bad)).toThrow(/--every/);
        expect(taskName("udesa-docente")).toBe("udesa-campus-mcp web-keepalive udesa-docente");
        expect(() => taskName('x" & calc')).toThrow(/perfil/);
    });
});
