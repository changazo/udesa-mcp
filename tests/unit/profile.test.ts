import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalSiteUrl, checkEnvAgainstProfile, loadProfile, packageRoot, parseProfile } from "../../src/config/profile.js";
import { CampusError } from "../../src/errors.js";
import { syntheticProfileJson } from "../fixtures/fake-moodle.js";

const code = (fn: () => unknown) => {
    try {
        fn();
    } catch (e) {
        return e instanceof CampusError ? e.code : "OTHER";
    }
    return "NO_ERROR";
};

describe("perfil (CFG)", () => {
    it("CFG-01: acepta el perfil real del repo (HTTPS, sin query, curso 12345)", () => {
        const p = loadProfile({ profileId: "udesa-curso", env: {} });
        expect(p.site_url).toBe("https://campusvirtual.udesa.edu.ar");
        expect(p.allowed_course_ids).toEqual([12345]);
        expect(p.announcement_forum_id).toBeNull(); // no se inventa el ID del foro
        expect(p.read_only).toBe(true);
    });

    it("CFG-01: el perfil del repo coincide con el ejemplo del hand-off salvo formato", () => {
        const repo = JSON.parse(readFileSync(join(packageRoot(), "profiles", "udesa-curso.json"), "utf8"));
        const handoff = JSON.parse(readFileSync(join(packageRoot(), "tests", "fixtures", "handoff", "profile.example.json"), "utf8"));
        expect(repo).toEqual(handoff);
    });

    it.each([
        ["http://campus.example.test", "HTTP"],
        ["https://user:pw@campus.example.test", "credenciales"],
        ["https://campus.example.test/?a=1", "query"],
        ["https://campus.example.test/#x", "fragmento"],
        ["https://campus.example.test:8443", "puerto"],
        ["https://campus.example.test/%2e%2e/x", "codificado"],
        ["no-es-url", "inválida"],
    ])("CFG-02: rechaza base_url %s (%s)", (url) => {
        expect(code(() => canonicalSiteUrl(url))).toBe("CONFIG_INVALID");
    });

    it("canoniza la barra final", () => {
        expect(canonicalSiteUrl("https://campus.example.test/")).toBe("https://campus.example.test");
        expect(canonicalSiteUrl("https://campus.example.test/moodle/")).toBe("https://campus.example.test/moodle");
    });

    it("CFG-02: rechaza login_url de otro origen", () => {
        expect(code(() => parseProfile(syntheticProfileJson({ web_login_url: "https://otro.example.test/login" })))).toBe("CONFIG_INVALID");
    });

    it("rechaza claves con forma de secreto y claves desconocidas", () => {
        expect(code(() => parseProfile({ ...syntheticProfileJson(), password: "x" }))).toBe("CONFIG_INVALID");
        expect(code(() => parseProfile({ ...syntheticProfileJson(), wstoken: "x" }))).toBe("CONFIG_INVALID");
        expect(code(() => parseProfile({ ...syntheticProfileJson(), extra: 1 }))).toBe("CONFIG_INVALID");
    });

    it("no permite desactivar sólo-lectura ni guardar contraseña desde el JSON", () => {
        expect(code(() => parseProfile(syntheticProfileJson({ read_only: false })))).toBe("CONFIG_INVALID");
        expect(code(() => parseProfile(syntheticProfileJson({ store_password: true })))).toBe("CONFIG_INVALID");
        expect(code(() => parseProfile(syntheticProfileJson({ export_to_repository: true })))).toBe("CONFIG_INVALID");
    });

    it("CFG-03: el entorno sólo confirma; un conflicto es error explícito, sin fallback", () => {
        const p = parseProfile(syntheticProfileJson());
        expect(() => checkEnvAgainstProfile(p, { CAMPUS_BASE_URL: "https://campus.example.test/" })).not.toThrow();
        expect(code(() => checkEnvAgainstProfile(p, { CAMPUS_BASE_URL: "https://otro-campus.example.test" }))).toBe("CONFIG_INVALID");
        expect(code(() => checkEnvAgainstProfile(p, { CAMPUS_ALLOWED_COURSE_IDS: "4242,1" }))).toBe("CONFIG_INVALID");
        expect(code(() => checkEnvAgainstProfile(p, { CAMPUS_READ_ONLY: "false" }))).toBe("CONFIG_INVALID");
        expect(code(() => checkEnvAgainstProfile(p, { CAMPUS_PROFILE: "otro" }))).toBe("CONFIG_INVALID");
    });

    it("exige elegir perfil explícitamente y valida el identificador", () => {
        expect(code(() => loadProfile({ env: {} }))).toBe("CONFIG_INVALID");
        expect(code(() => loadProfile({ profileId: "../etc", env: {} }))).toBe("CONFIG_INVALID");
        expect(code(() => loadProfile({ profileId: "no-existe", env: {} }))).toBe("CONFIG_INVALID");
    });
});
