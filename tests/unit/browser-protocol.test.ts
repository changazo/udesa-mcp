import { describe, expect, it } from "vitest";
import { createLaunch, expectedSiteHash, parseCallback, TransactionStore } from "../../src/auth/browser.js";
import { CampusError } from "../../src/errors.js";
import { SITE, syntheticProfile } from "../fixtures/fake-moodle.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const profile = syntheticProfile();
const callback = (scheme: string, hash: string, token = TOKEN, priv?: string) =>
    `${scheme}://token=${Buffer.from([hash, token, ...(priv ? [priv] : [])].join(":::")).toString("base64")}`;

const codeOf = (fn: () => unknown) => {
    try {
        fn();
        return "NO_ERROR";
    } catch (e) {
        return e instanceof CampusError ? e.code : "OTHER";
    }
};

describe("protocolo browser (offline, datos sintéticos)", () => {
    it("construye el lanzamiento móvil sin secretos y con passport aleatorio", () => {
        const a = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 0 });
        const b = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 0 });
        const url = new URL(a.launch_url);
        expect(url.origin + url.pathname).toBe(`${SITE}/admin/tool/mobile/launch.php`);
        expect(url.searchParams.get("service")).toBe("moodle_mobile_app");
        expect(url.searchParams.get("urlscheme")).toBe("udesacampusmcp");
        expect(a.transaction.passport).not.toBe(b.transaction.passport);
        expect(a.transaction.passport).toMatch(/^[a-f0-9]{48}$/);
    });

    it("BR-05: nunca usa el esquema de la app oficial", () => {
        expect(codeOf(() => createLaunch(profile, { urlscheme: "moodlemobile" }))).toBe("POLICY_DENIED");
    });

    it("BR-01: un retorno válido se consume una sola vez", () => {
        const store = new TransactionStore();
        const { transaction } = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 1000 });
        store.add(transaction);
        const raw = callback("udesacampusmcp", expectedSiteHash(SITE, transaction.passport), TOKEN, "P".repeat(64));
        const out = store.consume(raw, { profile_id: profile.profile_id, site_url: SITE }, 2000);
        expect(out.token).toBe(TOKEN);
        // BR-03: repetido
        expect(codeOf(() => store.consume(raw, { profile_id: profile.profile_id, site_url: SITE }, 2000))).toBe("BROWSER_CALLBACK_REJECTED");
    });

    it("BR-02: hash de otro sitio o passport no coincide", () => {
        const store = new TransactionStore();
        const { transaction } = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 0 });
        store.add(transaction);
        const wrongSite = callback("udesacampusmcp", expectedSiteHash("https://otro.example.test", transaction.passport));
        expect(codeOf(() => store.consume(wrongSite, { profile_id: profile.profile_id, site_url: SITE }, 1))).toBe("BROWSER_CALLBACK_REJECTED");
        expect(store.activeCount).toBe(1); // un retorno ajeno no quema la transacción legítima
    });

    it("BR-02: retorno correcto pero para otro perfil se rechaza y quema la transacción", () => {
        const store = new TransactionStore();
        const { transaction } = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 0 });
        store.add(transaction);
        const raw = callback("udesacampusmcp", expectedSiteHash(SITE, transaction.passport));
        expect(codeOf(() => store.consume(raw, { profile_id: "otro", site_url: SITE }, 1))).toBe("BROWSER_CALLBACK_REJECTED");
        expect(store.activeCount).toBe(0);
    });

    it("BR-03: transacción expirada", () => {
        const store = new TransactionStore();
        const { transaction } = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 0, ttlMs: 1000 });
        store.add(transaction);
        const raw = callback("udesacampusmcp", expectedSiteHash(SITE, transaction.passport));
        expect(codeOf(() => store.consume(raw, { profile_id: profile.profile_id, site_url: SITE }, 5000))).toBe("BROWSER_CALLBACK_REJECTED");
    });

    it("BR-05: esquema distinto del solicitado", () => {
        const store = new TransactionStore();
        const { transaction } = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 0 });
        store.add(transaction);
        const raw = callback("moodlemobile", expectedSiteHash(SITE, transaction.passport));
        expect(codeOf(() => store.consume(raw, { profile_id: profile.profile_id, site_url: SITE }, 1))).toBe("BROWSER_CALLBACK_REJECTED");
    });

    it.each([
        ["", "vacío"],
        ["x".repeat(5000), "largo"],
        ["udesacampusmcp://otra=abc", "formato"],
        ["udesacampusmcp://token=%%%", "base64"],
        [`udesacampusmcp://token=${Buffer.from("solo-un-campo").toString("base64")}`, "campos"],
        [`udesacampusmcp://token=${Buffer.from(`${"a".repeat(32)}:::corto`).toString("base64")}`, "token"],
    ])("BR-04: payload inválido (%#) sin eco del payload", (raw) => {
        try {
            parseCallback(raw);
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(CampusError);
            expect((e as CampusError).code).toBe("BROWSER_CALLBACK_REJECTED");
            if (raw.length > 20) expect((e as Error).message).not.toContain(raw.slice(16, 40));
        }
    });
});

describe("protocolo browser: proveedor OAuth y esquema forzado", () => {
    it("el lanzamiento incluye oauthsso cuando hay proveedor", () => {
        const { launch_url } = createLaunch(profile, { urlscheme: "udesacampusmcp", oauthssoId: 4 });
        expect(new URL(launch_url).searchParams.get("oauthsso")).toBe("4");
    });

    it("importador manual: acepta el esquema oficial forzado por el sitio sólo si se pide, y lo informa", () => {
        const store = new TransactionStore();
        const { transaction } = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 0 });
        store.add(transaction);
        const raw = callback("moodlemobile", expectedSiteHash(SITE, transaction.passport));
        const out = store.consume(raw, { profile_id: profile.profile_id, site_url: SITE }, 1, { acceptForcedScheme: true });
        expect(out).toMatchObject({ token: TOKEN, forced_scheme: true });
        // otro esquema ajeno nunca se acepta
        const store2 = new TransactionStore();
        const t2 = createLaunch(profile, { urlscheme: "udesacampusmcp", now: 0 }).transaction;
        store2.add(t2);
        const evil = callback("otraapp", expectedSiteHash(SITE, t2.passport));
        expect(codeOf(() => store2.consume(evil, { profile_id: profile.profile_id, site_url: SITE }, 1, { acceptForcedScheme: true }))).toBe("BROWSER_CALLBACK_REJECTED");
    });

    it("configuración pública: sólo proveedores del propio Campus", async () => {
        const { fetchPublicLoginConfig } = await import("../../src/auth/browser.js");
        const fake = async () =>
            Response.json([{ data: { typeoflogin: 1, launchurl: `${SITE}/admin/tool/mobile/launch.php`, identityproviders: [
                { name: " Google institucional", url: `${SITE}/auth/oauth2/login.php?id=4&sesskey=x` },
                { name: "Ajeno", url: "https://evil.example.com/auth/oauth2/login.php?id=9" },
            ] } }]);
        const cfg = await fetchPublicLoginConfig(profile, fake as unknown as typeof fetch);
        expect(cfg).toEqual({ typeoflogin: 1, launchurl: `${SITE}/admin/tool/mobile/launch.php`, identity_providers: [{ id: 4, name: "Google institucional" }] });
    });
});

describe("página de lanzamiento visible", () => {
    it("confirmed=1 sólo si se pide (para copiar el retorno con clic derecho)", () => {
        expect(new URL(createLaunch(profile, { urlscheme: "udesacampusmcp", oauthssoId: 4, showLaunchPage: true }).launch_url).searchParams.get("confirmed")).toBe("1");
        expect(new URL(createLaunch(profile, { urlscheme: "udesacampusmcp" }).launch_url).searchParams.has("confirmed")).toBe(false);
    });
});

describe("barra final que agrega Windows al manejador de esquema", () => {
    it("acepta el retorno con una barra final agregada, y no cambia nada si no la hay", () => {
        const hash = expectedSiteHash(SITE, "p".repeat(48));
        const raw = callback("udesacampusmcp", hash);
        expect(parseCallback(raw + "/").token).toBe(TOKEN);
        expect(parseCallback(raw).token).toBe(TOKEN);
    });

    it("también con privatetoken y base64 sin relleno", () => {
        const hash = expectedSiteHash(SITE, "q".repeat(48));
        const raw = callback("udesacampusmcp", hash, TOKEN, "P".repeat(63));
        expect(parseCallback(raw + "/")).toMatchObject({ token: TOKEN, had_private_token: true });
    });

    it("dos barras extra o basura no se aceptan", () => {
        const raw = callback("udesacampusmcp", expectedSiteHash(SITE, "r".repeat(48)));
        expect(codeOf(() => parseCallback(raw + "//"))).toBe("BROWSER_CALLBACK_REJECTED");
        expect(codeOf(() => parseCallback(raw + "/x"))).toBe("BROWSER_CALLBACK_REJECTED");
    });
});
