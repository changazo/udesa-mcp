import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MemoryMetadataStore } from "../../src/session/metadata.js";
import { MemorySecretStore } from "../../src/session/secret-store.js";
import { createLogger } from "../../src/util/logger.js";
import { saveLogin } from "../../src/web/autologin.js";
import { LocalConnection } from "../../src/web/local-connection.js";
import { startLocalPanel, type LocalPanel } from "../../src/web/local-panel.js";
import { passwordLogin } from "../../src/web/login.js";
import { MemoryKv } from "../../src/write/store.js";
import { FakeMoodle, SITE, syntheticProfile, USER_ID, VALID_TOKEN } from "../fixtures/fake-moodle.js";
import { FakeLogin, LOGIN_PASSWORD, LOGIN_USER } from "../fixtures/fake-login.js";

/** ADR-142: panel de conexión de esta PC (127.0.0.1, secreto en la ruta, Host y Origin exactos). HTTP real, Moodle falso. */

const panels: LocalPanel[] = [];
afterEach(() => {
    for (const p of panels.splice(0)) p.close();
});

interface Res {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

function http(port: number, path: string, o: { method?: string; host?: string; origin?: string | null; cookie?: string; body?: string } = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${port}` };
        if (o.origin) headers.origin = o.origin;
        if (o.cookie) headers.cookie = o.cookie;
        if (o.body !== undefined) {
            headers["content-type"] = "application/x-www-form-urlencoded";
            headers["content-length"] = String(Buffer.byteLength(o.body));
        }
        const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        if (o.body !== undefined) req.write(o.body);
        req.end();
    });
}

async function setup(o: { autologin?: boolean; idleMs?: number } = {}) {
    const fake = new FakeMoodle();
    const login = new FakeLogin(fake.web, SITE, USER_ID);
    const secrets = new MemorySecretStore();
    const metadata = new MemoryMetadataStore();
    const profile = syntheticProfile();
    const kv = new MemoryKv();
    const logger = createLogger(() => {});
    const mk = () => new LocalConnection({ profile, secrets, metadata, logger, cli: "campus", requireSecondKey: false, kv, fetch: fake.fetch, expectedUserId: async () => USER_ID, verifyApi: async () => ({ userid: USER_ID }) });
    if (o.autologin ?? true) {
        // Puesta en marcha previa (terminal): contraseña guardada, sesión y confianza en el registro.
        const pre = mk();
        const app = createApp({ profile, secrets, metadata, logger, fetch: fake.fetch, webSource: pre.source(), webRenewHint: "x" });
        await app.session.adoptCandidate(VALID_TOKEN, "native");
        const r = await passwordLogin(app.web!, { username: LOGIN_USER, password: LOGIN_PASSWORD, remembered: [], askCode: async () => login.lastCode });
        await saveLogin(secrets, profile.profile_id, SITE, { username: LOGIN_USER, password: LOGIN_PASSWORD });
        const svc = await pre.service();
        await svc.adoptLogin(r);
        // La pausa de 2 minutos después de un éxito no aplica a este test: se corre el reloj del registro.
        await svc.store.update((rec) => (rec ? { ...rec, control: { ...rec.control, last: rec.control.last ? { ...rec.control.last, at: new Date(Date.now() - 5 * 60_000).toISOString() } : null } } : null));
    }
    const local = mk();
    const svc = await local.service();
    const panel = await startLocalPanel({ service: svc, cli: "campus", profileId: profile.profile_id, idleMs: o.idleMs });
    panels.push(panel);
    const path = new URL(panel.url).pathname;
    return { fake, login, svc, panel, path, port: panel.port, origin: `http://127.0.0.1:${panel.port}` };
}

const formOf = (html: string, action: string) => new RegExp(`action="[^"]*/${action}"[^>]*><input type="hidden" name="form" value="([^"]+)"`).exec(html)?.[1] ?? null;
const cookieOf = (r: Res) => (Array.isArray(r.headers["set-cookie"]) ? r.headers["set-cookie"][0]! : String(r.headers["set-cookie"] ?? "")).split(";")[0]!;
const loginRequests = (fake: FakeMoodle) => fake.web.requests.filter((r) => r.path.startsWith("/login/") || r.path.startsWith("/admin/tool/mfa")).length;

describe("panel local (ADR-142)", () => {
    it("GET sólo muestra: sin login ni correos, Referrer-Policy same-origin, vínculo acotado a la ruta secreta y sin campo de contraseña", async () => {
        const s = await setup();
        const before = loginRequests(s.fake);
        const emails = s.login.emails.length;
        const r = await http(s.port, s.path);
        expect(r.status).toBe(200);
        expect(r.headers["referrer-policy"]).toBe("same-origin");
        expect(cookieOf(r)).toMatch(/^campus_local_connection=/);
        expect(String(r.headers["set-cookie"])).toContain(`Path=/${s.path.split("/")[1]}`);
        expect(r.body).toContain("Enviar código y renovar");
        expect(r.body).not.toMatch(/type="password"/);
        expect(loginRequests(s.fake)).toBe(before);
        expect(s.login.emails.length).toBe(emails);
    });

    it("sólo 127.0.0.1 con el Host exacto (DNS rebinding) y con el secreto de la ruta", async () => {
        const s = await setup();
        expect((await http(s.port, s.path, { host: "evil.example:80" })).status).toBe(421);
        expect((await http(s.port, s.path, { host: `localhost:${s.port}` })).status).toBe(421);
        expect((await http(s.port, "/otro-secreto/conexion")).status).toBe(404);
        expect((await http(s.port, "/")).status).toBe(404);
    });

    it("POST sin Origin, con Origin null o ajeno: 403 sin efectos", async () => {
        const s = await setup();
        const page = await http(s.port, s.path);
        const cookie = cookieOf(page);
        const form = formOf(page.body, "iniciar")!;
        const before = loginRequests(s.fake);
        for (const origin of [null, "null", "http://evil.example", `http://localhost:${s.port}`]) {
            const r = await http(s.port, `${s.path}/iniciar`, { method: "POST", origin, cookie, body: new URLSearchParams({ form }).toString() });
            expect(r.status).toBe(403);
        }
        expect(loginRequests(s.fake)).toBe(before);
    });

    it("renovación completa: pedir código → confirmar → 303 con resultado cerrado → el panel se cierra solo", async () => {
        const s = await setup();
        const page = await http(s.port, s.path);
        const cookie = cookieOf(page);
        const r1 = await http(s.port, `${s.path}/iniciar`, { method: "POST", origin: s.origin, cookie, body: new URLSearchParams({ form: formOf(page.body, "iniciar")! }).toString() });
        expect(r1.status).toBe(303);
        expect(r1.headers.location).toBe(`${s.path}?estado=awaiting_code`);
        const page2 = await http(s.port, String(r1.headers.location), { cookie });
        const code = s.login.lastCode!;
        const r2 = await http(s.port, `${s.path}/completar`, { method: "POST", origin: s.origin, cookie, body: new URLSearchParams({ form: formOf(page2.body, "completar")!, code }).toString() });
        expect(r2.status).toBe(303);
        expect(r2.headers.location).toBe(`${s.path}?estado=committed&diag=ready`);
        const final = await http(s.port, String(r2.headers.location), { cookie });
        expect(final.body).toContain("Conexión renovada y verificada.");
        const done = await s.panel.done;
        expect(done.reason).toBe("committed");
        expect((await s.svc.record()).control.last).toMatchObject({ ok: true, source: "panel" });
    });

    it("repetir el mismo formulario no produce un segundo efecto", async () => {
        const s = await setup();
        const page = await http(s.port, s.path);
        const cookie = cookieOf(page);
        const body = new URLSearchParams({ form: formOf(page.body, "iniciar")! }).toString();
        await http(s.port, `${s.path}/iniciar`, { method: "POST", origin: s.origin, cookie, body });
        const emails = s.login.emails.length;
        const again = await http(s.port, `${s.path}/iniciar`, { method: "POST", origin: s.origin, cookie, body });
        expect(again.status).toBe(303);
        expect(again.headers.location).toBe(s.path);
        expect(s.login.emails.length).toBe(emails);
    });

    it("sin login automático: muestra el comando de la terminal (y la cookie como respaldo), sin botón para iniciar", async () => {
        const s = await setup({ autologin: false });
        const r = await http(s.port, s.path);
        expect(r.body).toContain("campus auth web autologin enable --profile");
        expect(r.body).toContain("campus auth web import --profile");
        expect(formOf(r.body, "iniciar")).toBeNull();
        expect(r.body).not.toMatch(/type="password"/);
    });

    it("se cierra solo tras el tiempo sin uso", async () => {
        const s = await setup({ autologin: false, idleMs: 60 });
        const done = await s.panel.done;
        expect(done.reason).toBe("idle");
    });
});
