import { describe, expect, it } from "vitest";
import { appSiteCheck, requestNativeToken } from "../../src/auth/native.js";
import { CampusError } from "../../src/errors.js";
import { accountFor, makeHarness } from "../fixtures/harness.js";
import { OTHER_USER_TOKEN, PASSWORD, SITE, USER_ID, VALID_TOKEN } from "../fixtures/fake-moodle.js";

async function codeOf(p: Promise<unknown>) {
    try {
        await p;
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : `OTHER:${(e as Error).message}`;
    }
}

describe("login nativo y sesión", () => {
    it("AUTH-01: el candidato se valida contra sitio e identidad antes de persistir", async () => {
        const h = await makeHarness({ loggedIn: false });
        const candidate = await requestNativeToken(h.profile, { username: "docente", password: PASSWORD }, h.fake.fetch);
        expect(h.secrets.size).toBe(0); // todavía nada persistido
        const identity = await h.app.session.adoptCandidate(candidate, "native");
        expect(identity).toMatchObject({ site_url: SITE, user_id: USER_ID });
        expect(await h.secrets.get(accountFor(h.profile))).toBe(VALID_TOKEN);
        expect(h.metadata.read()?.auth_method).toBe("native");
        expect(h.fake.callsOf("core_webservice_get_site_info")).toHaveLength(1);
    });

    it("AUTH-02: HTTP 200 con error de Moodle no es éxito", async () => {
        const h = await makeHarness({ loggedIn: false });
        h.fake.tokenMode = "error200";
        expect(await codeOf(requestNativeToken(h.profile, { username: "docente", password: PASSWORD }, h.fake.fetch))).toBe("SERVICE_UNAVAILABLE");
    });

    it("AUTH-03: credenciales inválidas → un único intento, error saneado", async () => {
        const h = await makeHarness({ loggedIn: false });
        const e = await requestNativeToken(h.profile, { username: "docente", password: "mala" }, h.fake.fetch).catch((x) => x);
        expect(e).toBeInstanceOf(CampusError);
        expect(e.code).toBe("AUTH_REJECTED");
        expect(e.moodleErrorcode).toBe("invalidlogin");
        expect(e.message).not.toContain("mala");
        expect(h.fake.tokenRequests).toHaveLength(1);
    });

    it("HTML inesperado, redirección y red se distinguen de contraseña incorrecta", async () => {
        const h = await makeHarness({ loggedIn: false });
        h.fake.tokenMode = "html";
        expect(await codeOf(requestNativeToken(h.profile, { username: "docente", password: PASSWORD }, h.fake.fetch))).toBe("UNEXPECTED_RESPONSE");
        h.fake.tokenMode = "redirect";
        expect(await codeOf(requestNativeToken(h.profile, { username: "docente", password: PASSWORD }, h.fake.fetch))).toBe("SERVICE_UNAVAILABLE");
        h.fake.tokenMode = "network";
        expect(await codeOf(requestNativeToken(h.profile, { username: "docente", password: PASSWORD }, h.fake.fetch))).toBe("NETWORK_ERROR");
        expect(h.fake.foreign).toEqual([]); // la redirección a otro origen no se siguió
    });

    it("AUTH-05: token rechazado al validar no se persiste ni reemplaza la sesión", async () => {
        const h = await makeHarness({ loggedIn: true });
        h.fake.tokenMode = "badtoken";
        const candidate = await requestNativeToken(h.profile, { username: "docente", password: PASSWORD }, h.fake.fetch);
        expect(await codeOf(h.app.session.adoptCandidate(candidate, "native"))).toBe("AUTH_REJECTED");
        expect(await h.secrets.get(accountFor(h.profile))).toBe(VALID_TOKEN);
    });

    it("AUTH-05: sitio inesperado no se acepta", async () => {
        const h = await makeHarness({ loggedIn: false });
        h.fake.siteurl = "https://otro.example.test";
        expect(await codeOf(h.app.session.adoptCandidate(VALID_TOKEN, "native"))).toBe("IDENTITY_MISMATCH");
        expect(h.secrets.size).toBe(0);
    });

    it("AUTH-05/BR-07: otra identidad no reemplaza la sesión sin confirmación explícita", async () => {
        const h = await makeHarness({ loggedIn: true });
        expect(await codeOf(h.app.session.adoptCandidate(OTHER_USER_TOKEN, "browser"))).toBe("IDENTITY_MISMATCH");
        expect(await h.secrets.get(accountFor(h.profile))).toBe(VALID_TOKEN);
        expect(h.metadata.read()?.auth_method).toBe("native");
        await h.app.session.adoptCandidate(OTHER_USER_TOKEN, "browser", { replaceIdentity: true });
        expect(h.metadata.read()?.identity.user_id).toBe(999);
    });

    it("misma identidad por otro método: se acepta y conserva sitio + userid", async () => {
        const h = await makeHarness({ loggedIn: true });
        const id = await h.app.session.adoptCandidate(VALID_TOKEN, "browser");
        expect(id.user_id).toBe(USER_ID);
        expect(h.metadata.read()?.auth_method).toBe("browser");
    });

    it("AUTH-06: contraseña y token no aparecen en logs, metadata ni estado público", async () => {
        const h = await makeHarness({ loggedIn: false });
        const candidate = await requestNativeToken(h.profile, { username: "docente", password: PASSWORD }, h.fake.fetch);
        await h.app.session.adoptCandidate(candidate, "native");
        await h.app.service.listAnnouncements({ course_id: 4242, limit: 2 });
        const status = await h.app.session.status(true);
        const everything = [...h.logs, JSON.stringify(h.metadata.read()), JSON.stringify(status)].join("\n");
        expect(everything).not.toContain(PASSWORD);
        expect(everything).not.toContain(VALID_TOKEN);
        expect(everything).not.toContain("P".repeat(64)); // privatetoken
        expect(everything).not.toContain("PRIVADA-NO-DEBE-SALIR");
    });

    it("AUTH-07: sin keyring no hay fallback a texto plano", async () => {
        const h = await makeHarness({ loggedIn: false });
        h.secrets.available = false;
        expect(await codeOf(h.app.session.probeSecretStore())).toBe("SECRET_STORE_UNAVAILABLE");
        expect(await codeOf(h.app.session.adoptCandidate(VALID_TOKEN, "native"))).toBe("SECRET_STORE_UNAVAILABLE");
        expect(h.metadata.read()).toBeNull();
    });

    it("AUTH-08: token vencido → AUTH_REQUIRED, sin renovar con una contraseña inexistente", async () => {
        const h = await makeHarness({ loggedIn: true });
        h.fake.validTokens.delete(VALID_TOKEN);
        const e = await h.app.service.listCourses().catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(e.humanAction).toContain("cli.js auth login --profile");
        // la siguiente consulta no vuelve a golpear Moodle con el token rechazado
        const before = h.fake.calls.length;
        expect(await codeOf(h.app.service.getCourse(4242))).toBe("AUTH_REQUIRED");
        expect(h.fake.calls.length).toBe(before);
        expect(h.fake.tokenRequests).toHaveLength(0);
        const status = await h.app.session.status(false);
        expect(status.requires_human_login).toBe(true);
        // El humano vuelve a loguearse (otro proceso escribe un token nuevo): el servidor lo toma sin reiniciar.
        const fresh = "abcdefabcdefabcdefabcdefabcdef12";
        h.fake.validTokens.set(fresh, 501);
        await h.secrets.set(accountFor(h.profile), fresh);
        expect((await h.app.session.status(false)).requires_human_login).toBe(false);
        expect((await h.app.service.listCourses()).data).toHaveLength(1);
    });

    it("AUTH-09: verificaciones simultáneas comparten un único request", async () => {
        const h = await makeHarness({ loggedIn: true });
        h.fake.calls.length = 0;
        h.fake.delayMs = 20;
        await Promise.all(Array.from({ length: 10 }, () => h.app.session.verify()));
        expect(h.fake.callsOf("core_webservice_get_site_info")).toHaveLength(1);
    });

    it("sin sesión: AUTH_REQUIRED con instrucción humana, nunca un resultado vacío", async () => {
        const h = await makeHarness({ loggedIn: false });
        const e = await h.app.service.listAnnouncements({ course_id: 4242 }).catch((x) => x);
        expect(e.code).toBe("AUTH_REQUIRED");
        expect(h.fake.calls).toHaveLength(0);
    });

    it("logout local borra token y metadata sin llamar a Moodle", async () => {
        const h = await makeHarness({ loggedIn: true });
        const before = h.fake.calls.length;
        expect(await h.app.session.logoutLocal()).toEqual({ removed_token: true });
        expect(h.secrets.size).toBe(0);
        expect(h.metadata.read()).toBeNull();
        expect(h.fake.calls.length).toBe(before);
    });

    it("appsitecheck es sólo una pista", async () => {
        const h = await makeHarness({ loggedIn: false });
        expect(await appSiteCheck(h.profile, h.fake.fetch)).toEqual({ result: "ok", errorcode: null });
    });
});
