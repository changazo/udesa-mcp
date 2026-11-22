import { describe, expect, it } from "vitest";
import { pushWebSessionRefusal, remoteAutologinCommand, type RemoteAutoLoginDeps, type RemoteAutoLoginOptions } from "../../src/cli/remote-autologin.js";
import { CampusError } from "../../src/errors.js";
import { parseBootstrap } from "../../src/remote/connection-contracts.js";
import { createLogger } from "../../src/util/logger.js";
import { loadLogin, saveLogin, saveTrust } from "../../src/web/autologin.js";
import { decodeSnapshot } from "../../src/web/session.js";
import { FakeLogin, LOGIN_PASSWORD, LOGIN_USER } from "../fixtures/fake-login.js";
import { SITE, USER_ID } from "../fixtures/fake-moodle.js";
import { makeHarness } from "../fixtures/harness.js";

/** CLI de recuperación (ADR-141, directiva §10): Vercel, prompts y Campus falsos; datos sintéticos. */

interface Opts {
    keyring?: boolean;
    failAdd?: (name: string) => boolean;
    deployOk?: boolean;
    retry?: string;
}

async function setup(o: Opts = {}) {
    const h = await makeHarness();
    const login = new FakeLogin(h.fake.web, SITE, USER_ID);
    if (o.keyring ?? true) await saveLogin(h.secrets, h.profile.profile_id, SITE, { username: LOGIN_USER, password: LOGIN_PASSWORD });
    const env = new Map<string, { value: string; sensitive: boolean }>();
    const adds: string[] = [];
    const removed: string[] = [];
    const prompts: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    let deploys = 0;
    let failAdd = o.failAdd;
    const deps: Partial<RemoteAutoLoginDeps> = {
        vercelEnvAdd: async (name, value, opts) => {
            adds.push(name);
            if (failAdd?.(name)) throw new CampusError("CONFIG_INVALID", `vercel env add ${name} falló (código 1): Error de red simulado`);
            env.set(name, { value, sensitive: opts.sensitive });
        },
        vercelEnvRm: async (name) => {
            removed.push(name);
            return "absent";
        },
        vercelDeploy: async () => {
            deploys++;
            return (o.deployOk ?? true) ? { ok: true, code: 0, stderr_tail: "" } : { ok: false, code: 1, stderr_tail: "Error: build failed" };
        },
        vercelAvailable: async () => true,
        vercelProjectLinked: () => true,
        buildExists: () => true,
        requireTty: () => {},
        promptVisible: async (q) => {
            prompts.push(q);
            if (/Usuario/.test(q)) return LOGIN_USER;
            if (/Reintentar/.test(q)) return o.retry ?? "n";
            return "";
        },
        promptHidden: async (q) => {
            prompts.push(q);
            if (/Código/.test(q)) return login.lastCode ?? "";
            if (/Contraseña/.test(q)) return LOGIN_PASSWORD;
            return "";
        },
        fetch: h.fake.fetch,
        env: {},
        out: (s) => stdout.push(s),
        err: (s) => stderr.push(s),
    };
    const wiring = { profile: h.profile, app: h.app, secrets: h.secrets, metadata: h.metadata, logger: createLogger(() => {}, "warn") };
    const run = (action: string | undefined, opts: RemoteAutoLoginOptions = {}) => remoteAutologinCommand(action, wiring, opts, deps);
    return {
        h,
        login,
        env,
        adds,
        removed,
        prompts,
        stdout,
        stderr,
        run,
        deploys: () => deploys,
        setFailAdd: (f: ((n: string) => boolean) | undefined) => (failAdd = f),
        record: () => h.metadata.readJson("remote-autologin.json") as { last_epoch?: number; history?: Array<Record<string, unknown>> } | null,
        text: () => [...stdout, ...stderr].join("\n"),
    };
}

/** Secretos que nunca deben aparecer en la salida ni en el historial local. */
function secretsOf(s: Awaited<ReturnType<typeof setup>>): string[] {
    const raw = s.env.get("CAMPUS_WEB_BOOTSTRAP")?.value;
    const list = [LOGIN_PASSWORD, ...s.login.emails];
    if (raw) {
        const b = JSON.parse(raw) as { trust: Array<{ value: string }>; session: string };
        list.push(raw, b.session, ...b.trust.map((c) => c.value), ...decodeSnapshot(b.session).cookies.map((c) => c.value));
    }
    return list;
}

describe("campus remote autologin renew (ADR-141)", () => {
    it("camino feliz: un login con código, UN sobre válido, segunda llave, legacy borradas y sin secretos en la salida", async () => {
        const s = await setup();
        expect(await s.run("renew")).toBe(0);
        expect(s.login.emails).toHaveLength(1);
        expect(s.adds).toEqual(["CAMPUS_WEB_BOOTSTRAP", "CAMPUS_WEB_AUTOLOGIN"]);
        const boot = s.env.get("CAMPUS_WEB_BOOTSTRAP")!;
        expect(boot.sensitive).toBe(true);
        expect(s.env.get("CAMPUS_WEB_AUTOLOGIN")).toEqual({ value: "true", sensitive: false });
        const b = parseBootstrap(boot.value, USER_ID);
        expect(b.mode).toBe("enabled");
        if (b.mode !== "enabled") throw new Error("modo");
        expect(b.login).toEqual({ username: LOGIN_USER, password: LOGIN_PASSWORD });
        expect(b.session.user_id).toBe(USER_ID);
        const own = b.trust.find((c) => c.name === `MFA_TOKEN_${USER_ID}`)!;
        // Vencimiento real de la cookie (28 días del Campus falso), no fabricado.
        expect(own.expires! * 1000 - Date.now()).toBeGreaterThan(27.9 * 86_400_000);
        expect(s.removed.sort()).toEqual(["CAMPUS_WEB_LOGIN", "CAMPUS_WEB_SESSION", "CAMPUS_WEB_TRUST"]);
        expect(s.deploys()).toBe(0);
        const t = s.text();
        expect(t).toMatch(/candidate_validated/);
        expect(t).toMatch(/configuration_published_pending_deploy/);
        expect(t).toMatch(/vercel deploy --prod/);
        expect(t).toMatch(/\/admin\/conexion/);
        expect(t).not.toMatch(/deployed_pending_verification|verificad[oa] correctamente|Listo: sesión remota/);
        for (const secret of secretsOf(s)) {
            expect(t).not.toContain(secret);
            expect(JSON.stringify(s.record())).not.toContain(secret);
        }
        const last = s.record()!.history!.at(-1)!;
        expect(last.state).toBe("configuration_published_pending_deploy");
        expect(last.activation_epoch).toBe(b.activation_epoch);
        expect(last.trust_expires_at).toBe(new Date(own.expires! * 1000).toISOString());
    });

    it("no reusa la confianza de la PC: el Campus emite una nueva (pide código aunque haya MFA_TOKEN local)", async () => {
        const s = await setup();
        await s.run("renew");
        // La confianza recién emitida queda en el keyring local, como si fuera la de la PC.
        const b = JSON.parse(s.env.get("CAMPUS_WEB_BOOTSTRAP")!.value) as { trust: Array<{ name: string; value: string; expires: number | null }> };
        await saveTrust(s.h.secrets, s.h.profile.profile_id, SITE, b.trust);
        await s.run("renew");
        expect(s.login.emails).toHaveLength(2);
    });

    it("activation_epoch monotónico entre corridas, aunque el reloj quede atrás", async () => {
        const s = await setup();
        await s.run("renew");
        const e1 = parseBootstrap(s.env.get("CAMPUS_WEB_BOOTSTRAP")!.value, USER_ID).activation_epoch;
        // Historial con un epoch en el futuro (reloj atrasado ahora): el siguiente igual lo supera.
        const rec = s.record()!;
        s.h.metadata.writeJson("remote-autologin.json", { ...rec, last_epoch: e1 + 3_600_000 });
        await s.run("renew");
        const e2 = parseBootstrap(s.env.get("CAMPUS_WEB_BOOTSTRAP")!.value, USER_ID).activation_epoch;
        expect(e2).toBe(e1 + 3_600_001);
        await s.run("renew", { minEpoch: String(e2 + 50) });
        const e3 = parseBootstrap(s.env.get("CAMPUS_WEB_BOOTSTRAP")!.value, USER_ID).activation_epoch;
        expect(e3).toBe(e2 + 51);
    });

    it("con --redeploy y deploy exitoso: deployed_pending_verification, nunca «verified»", async () => {
        const s = await setup();
        expect(await s.run("renew", { redeploy: true, baseUrl: "https://remoto.example.test" })).toBe(0);
        expect(s.deploys()).toBe(1);
        const t = s.text();
        expect(t).toMatch(/deployed_pending_verification/);
        expect(t).toContain("https://remoto.example.test/admin/conexion");
        expect(t).toMatch(/Activar y verificar recuperación/);
        expect(t).not.toMatch(/\bverified\b/);
        expect(s.record()!.history!.at(-1)!.state).toBe("deployed_pending_verification");
    });

    it("deploy fallido: queda configuration_published_pending_deploy y se puede reintentar sólo el deploy, sin otro código", async () => {
        const s = await setup({ deployOk: false });
        expect(await s.run("renew", { redeploy: true })).toBe(1);
        expect(s.record()!.history!.at(-1)!.state).toBe("configuration_published_pending_deploy");
        expect(s.stderr.join("\n")).toMatch(/«deploy»/);
        expect(s.text()).not.toMatch(/deployed_pending_verification/);
        const emails = s.login.emails.length;
        expect(await s.run("deploy")).toBe(1);
        expect(s.login.emails).toHaveLength(emails);
        expect(s.deploys()).toBe(2);
    });

    it("sin contraseña en el keyring: la pide acá (usuario visible, contraseña oculta) y no la guarda", async () => {
        const s = await setup({ keyring: false });
        expect(await s.run("renew")).toBe(0);
        expect(s.prompts.some((q) => /Usuario/.test(q))).toBe(true);
        expect(s.prompts.some((q) => /Contraseña/.test(q))).toBe(true);
        expect(s.env.has("CAMPUS_WEB_BOOTSTRAP")).toBe(true);
        expect(await loadLogin(s.h.secrets, s.h.profile.profile_id, SITE)).toBeNull();
    });

    it("sin cookie de confianza (el Campus no pidió MFA): no se publica nada", async () => {
        const s = await setup();
        s.login.mfaEnabled = false;
        expect(await s.run("renew")).toBe(1);
        expect(s.adds).toEqual([]);
        expect(s.stderr.join("\n")).toMatch(/«confianza»/);
    });

    it("confianza con menos de un día de margen: no se publica nada", async () => {
        const s = await setup();
        s.login.trustSeconds = 3600;
        expect(await s.run("renew")).toBe(1);
        expect(s.adds).toEqual([]);
    });

    it("falla la carga del sobre en Vercel: no afirma publicación ni despliega", async () => {
        const s = await setup({ failAdd: (n) => n === "CAMPUS_WEB_BOOTSTRAP" });
        expect(await s.run("renew", { redeploy: true })).toBe(1);
        const t = s.text();
        expect(t).not.toMatch(/configuration_published_pending_deploy|Publicadas/);
        expect(t).toMatch(/«carga de CAMPUS_WEB_BOOTSTRAP»/);
        expect(s.deploys()).toBe(0);
        expect(s.removed).toEqual([]);
        expect(s.record()!.history!.at(-1)!.state).toBe("publish_failed");
        for (const secret of secretsOf(s)) expect(t).not.toContain(secret);
    });

    it("falla la segunda llave: publicación incompleta, sin deploy ni «publicada»", async () => {
        const s = await setup({ failAdd: (n) => n === "CAMPUS_WEB_AUTOLOGIN" });
        expect(await s.run("renew", { redeploy: true })).toBe(1);
        expect(s.text()).toMatch(/INCOMPLETA/);
        expect(s.deploys()).toBe(0);
        expect(s.record()!.history!.at(-1)!.state).toBe("publish_incomplete");
    });

    it("reintento de publicación en la misma corrida: mismo sobre (mismo epoch), sin otro código", async () => {
        const s = await setup({ retry: "s" });
        let first = true;
        s.setFailAdd((n) => {
            if (n === "CAMPUS_WEB_BOOTSTRAP" && first) {
                first = false;
                return true;
            }
            return false;
        });
        expect(await s.run("renew")).toBe(0);
        expect(s.login.emails).toHaveLength(1);
        expect(s.adds).toEqual(["CAMPUS_WEB_BOOTSTRAP", "CAMPUS_WEB_BOOTSTRAP", "CAMPUS_WEB_AUTOLOGIN"]);
        expect(s.record()!.history!.at(-1)!.state).toBe("configuration_published_pending_deploy");
    });

    it("preflight: sin proyecto de Vercel vinculado no pide credenciales ni inicia sesión", async () => {
        const s = await setup();
        const r = await remoteAutologinCommand("renew", { profile: s.h.profile, app: s.h.app, secrets: s.h.secrets, metadata: s.h.metadata, logger: createLogger(() => {}, "warn") }, {}, {
            vercelProjectLinked: () => false,
            vercelAvailable: async () => true,
            buildExists: () => true,
            requireTty: () => {},
            out: () => {},
            err: (x) => s.stderr.push(x),
        });
        expect(r).toBe(2);
        expect(s.login.emails).toHaveLength(0);
        expect(s.stderr.join("\n")).toMatch(/proyecto de Vercel/);
    });

    it("--base-url inválido se rechaza antes del login", async () => {
        const s = await setup();
        expect(await s.run("renew", { baseUrl: "http://inseguro.example.test/x" })).toBe(2);
        expect(s.login.emails).toHaveLength(0);
    });

    it("enable es compatible: mismo núcleo, sin desplegar, con nota de renew", async () => {
        const s = await setup();
        expect(await s.run("enable", { redeploy: true })).toBe(0);
        expect(s.deploys()).toBe(0);
        expect(s.text()).toMatch(/«enable» ahora es «renew»/);
        expect(parseBootstrap(s.env.get("CAMPUS_WEB_BOOTSTRAP")!.value, USER_ID).mode).toBe("enabled");
    });
});

describe("disable, status y push-web-session (ADR-141)", () => {
    it("disable publica el sobre disabled con epoch mayor, la segunda llave en false y borra legacy", async () => {
        const s = await setup();
        await s.run("renew");
        const e1 = parseBootstrap(s.env.get("CAMPUS_WEB_BOOTSTRAP")!.value, USER_ID).activation_epoch;
        expect(await s.run("disable")).toBe(0);
        const b = parseBootstrap(s.env.get("CAMPUS_WEB_BOOTSTRAP")!.value, USER_ID);
        expect(b.mode).toBe("disabled");
        expect(Object.keys(JSON.parse(s.env.get("CAMPUS_WEB_BOOTSTRAP")!.value)).sort()).toEqual(["activation_epoch", "mode", "v"]);
        expect(b.activation_epoch).toBeGreaterThan(e1);
        expect(s.env.get("CAMPUS_WEB_AUTOLOGIN")).toEqual({ value: "false", sensitive: false });
        expect(s.removed.filter((n) => n === "CAMPUS_WEB_LOGIN")).toHaveLength(2);
        expect(s.text()).toMatch(/hasta que vence/);
        expect(s.record()!.history!.at(-1)!.mode).toBe("disabled");
    });

    it("status: historial local, aclara que no es el estado vivo y avisa con 7 días", async () => {
        const s = await setup();
        s.login.trustSeconds = 5 * 86_400;
        await s.run("renew");
        s.stdout.length = 0;
        s.stderr.length = 0;
        expect(await s.run("status")).toBe(0);
        const j = JSON.parse(s.stdout.join("\n")) as Record<string, unknown>;
        expect(j.note).toMatch(/NO es el estado vivo/);
        expect(j.live_state).toMatch(/campus_get_status/);
        expect(j.trust_days_left).toBe(4);
        expect(s.stderr.join("\n")).toMatch(/vence en 4 día/);
        for (const secret of secretsOf(s)) expect(s.stdout.join("\n")).not.toContain(secret);
    });

    it("push-web-session se rechaza con la instrucción precisa", () => {
        const lines: string[] = [];
        expect(pushWebSessionRefusal("sintetico", (x) => lines.push(x))).toBe(2);
        const t = lines.join("\n");
        expect(t).toMatch(/retirado/);
        expect(t).toMatch(/\/admin\/conexion/);
        expect(t).toMatch(/remote autologin renew --profile sintetico --redeploy/);
        expect(t).toMatch(/No se publicó nada/);
    });
});
