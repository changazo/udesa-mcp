import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handlePanel, type FormClaims, type PanelEnv, type PanelUi } from "../remote/connection-handler.js";
import type { ConnectionReason } from "../remote/connection-contracts.js";
import type { ConnectionService, RenewalOutcome } from "../remote/connection-service.js";
import { esc, page } from "../remote/page.js";

/**
 * Panel de conexión de esta PC (ADR-142): el mismo panel que el remoto, servido por la CLI del humano
 * (`campus auth web panel`) sólo en 127.0.0.1, en un puerto aleatorio y por poco tiempo.
 *
 * - La credencial es el secreto de 32 bytes de la ruta (`/<secreto>/conexion`), que conoce sólo quien
 *   corrió el comando; más el vínculo con el navegador (cookie HttpOnly, SameSite=Strict, acotada a esa ruta).
 * - Host exacto (`127.0.0.1:<puerto>`, frena el DNS rebinding) y Origin exacto en cada POST.
 * - Formularios firmados con una clave de esta ejecución, de un solo uso, de hasta 4 KB → 303 → GET.
 * - Nunca pide la contraseña: si no hay login automático, muestra el comando de la terminal.
 * - Se cierra solo después de una renovación verificada, a los 15 minutos sin uso, o con Ctrl+C.
 */

export const LOCAL_PANEL_IDLE_MS = 15 * 60_000;
const MAX_BODY = 4097;
const FORM_TTL_MS = 10 * 60_000;

export interface LocalPanelOptions {
    service: ConnectionService;
    /** Prefijo de la CLI y perfil, para los comandos que muestra el panel. */
    cli: string;
    profileId: string;
    idleMs?: number;
    now?: () => Date;
    log?: (event: string, fields: Record<string, unknown>) => void;
    /** Puerto fijo (tests); por defecto, uno libre al azar. */
    port?: number;
}

export interface LocalPanel {
    url: string;
    port: number;
    /** Termina con el motivo del cierre. */
    done: Promise<{ reason: "committed" | "idle" | "closed"; last: RenewalOutcome | null }>;
    close(): void;
}

function sign(key: Buffer, claims: FormClaims & { exp: number }): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const mac = createHmac("sha256", key).update(`connform-local:v1\n${body}`).digest("base64url");
    return `${body}.${mac}`;
}

function verify(key: Buffer, token: string, now: number): FormClaims {
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!m) throw new Error("formato");
    const expected = createHmac("sha256", key).update(`connform-local:v1\n${m[1]}`).digest();
    const got = Buffer.from(m[2]!, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error("firma");
    const c = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")) as FormClaims & { exp: number };
    if (typeof c.exp !== "number" || c.exp <= now) throw new Error("vencido");
    return c;
}

/** Arma el entorno del panel local (exportado para los tests de punta a punta sin red). */
export function localPanelEnv(o: { secret: string; port: number; cli: string; profileId: string; now: () => Date; onOutcome?: PanelEnv["onOutcome"] }): PanelEnv {
    const key = randomBytes(32);
    const path = `/${o.secret}/conexion`;
    const cmd = (rest: string) => `<code>${esc(`${o.cli} ${rest} --profile ${o.profileId}`)}</code>`;
    return {
        path,
        origin: `http://127.0.0.1:${o.port}`,
        bindCookie: "campus_local_connection",
        // Sin `Secure`: la página es http://127.0.0.1 (el panel no sale de la PC). Acotada a la ruta secreta.
        bindCookieAttrs: `Path=/${o.secret}; HttpOnly; SameSite=Strict; Max-Age=3600`,
        bindHash: (value) => createHmac("sha256", key).update(`conn-bind-local:v1\n${value}`).digest("base64url"),
        signForm: async (c) => sign(key, { ...c, exp: o.now().getTime() + FORM_TTL_MS }),
        verifyForm: async (token, sub, action, bind) => {
            const c = verify(key, token, o.now().getTime());
            if (c.sub !== sub || c.action !== action || c.bind !== bind || typeof c.jti !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(c.jti)) throw new Error("formulario");
            return { renewal_id: typeof c.renewal_id === "string" ? c.renewal_id : null, jti: c.jti };
        },
        // El secreto de la ruta ya se comprobó antes de llegar acá: quien la tiene es el dueño de esta PC.
        ownerOf: async () => "local",
        login: async () => new Response("No encontrado", { status: 404 }),
        title: "Conexión con el Campus · esta PC",
        texts: {
            noKv: "<p>El estado de la conexión de esta PC no está disponible.</p>",
            unresolvable: (r: ConnectionReason) =>
                r === "api_token_invalid" || r === "identity_mismatch"
                    ? `<p>Desde el panel no se puede resolver: renová el token en tu terminal con ${cmd("auth login")}.</p>`
                    : `<p>Desde el panel no se puede resolver: volvé a activar el login automático en tu terminal con ${cmd("auth web autologin enable")} (pide la contraseña sólo ahí).</p>`,
            noAutologin: `<p>Esta PC no tiene el login web automático configurado, así que el panel no puede renovar nada. Es el método recomendado: activalo en tu terminal con ${cmd("auth web autologin enable")} (la contraseña se escribe sólo ahí, nunca en esta página ni en el chat).</p><p>Respaldo: importar la cookie <code>MoodleSession</code> del navegador con ${cmd("auth web import")} y <code>--clipboard</code>.</p>`,
            startNote: "Al pulsar, este equipo inicia sesión en el Campus y el Campus te manda un código al correo.",
            footer: "Este panel sólo responde en esta PC y se cierra solo al terminar o después de 15 minutos sin uso. Nada de lo que hagas acá cambia el freno, los límites ni las aprobaciones de escrituras.",
        },
        onOutcome: o.onOutcome,
    };
}

const SECURITY_HEADERS: Record<string, string> = {
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
};

export const localPanelUi: PanelUi = {
    html: (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "same-origin", ...SECURITY_HEADERS } }),
    page: (title, body) => page(title, body),
    esc,
    readBody: (req) => req.text(),
    log: () => {},
};

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) return null;
        chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
}

async function writeResponse(res: ServerResponse, r: Response) {
    const headers: Record<string, string | string[]> = {};
    r.headers.forEach((v, k) => {
        if (k !== "set-cookie") headers[k] = v;
    });
    const cookies = r.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
}

export async function startLocalPanel(o: LocalPanelOptions): Promise<LocalPanel> {
    const now = o.now ?? (() => new Date());
    const log = o.log ?? (() => {});
    const secret = randomBytes(32).toString("base64url");
    let server: Server;
    let finished = false;
    let last: RenewalOutcome | null = null;
    let resolveDone!: (v: { reason: "committed" | "idle" | "closed"; last: RenewalOutcome | null }) => void;
    const done = new Promise<{ reason: "committed" | "idle" | "closed"; last: RenewalOutcome | null }>((r) => (resolveDone = r));
    let idle: NodeJS.Timeout | null = null;
    const stop = (reason: "committed" | "idle" | "closed") => {
        if (idle) clearTimeout(idle);
        server.close();
        server.closeAllConnections?.();
        resolveDone({ reason, last });
    };
    const touchIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => stop("idle"), o.idleMs ?? LOCAL_PANEL_IDLE_MS);
        idle.unref?.();
    };
    let env: PanelEnv;
    server = createServer(async (req, res) => {
        touchIdle();
        try {
            const port = (server.address() as AddressInfo).port;
            // Host exacto: un nombre que resuelve a 127.0.0.1 (DNS rebinding) no llega al panel.
            if (req.headers.host !== `127.0.0.1:${port}`) {
                log("connection_panel", { outcome: "host_rejected" });
                return writeResponse(res, localPanelUi.html(page("No encontrado", "<p>Esta dirección no existe.</p>"), 421));
            }
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
            if (url.pathname !== env.path && !url.pathname.startsWith(`${env.path}/`)) return writeResponse(res, localPanelUi.html(page("No encontrado", "<p>Esta dirección no existe.</p>"), 404));
            const body = req.method === "POST" ? await readBody(req) : null;
            if (req.method === "POST" && body === null) return writeResponse(res, localPanelUi.html(page("No se cambió nada", "<p>Formulario demasiado grande.</p>"), 413));
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
            const request = new Request(url, { method: req.method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
            const response = await handlePanel(request, url.pathname, env, o.service, { ...localPanelUi, log }, now);
            await writeResponse(res, response);
            // Después de mostrar el resultado de una renovación verificada, el panel se cierra.
            if (finished && req.method === "GET") setTimeout(() => stop("committed"), 300).unref?.();
        } catch (e) {
            log("connection_panel_error", { error: e instanceof Error ? e.name : "error" });
            if (!res.headersSent) await writeResponse(res, localPanelUi.html(page("No se pudo completar", "<p>Ocurrió un error en el panel. No se reintentó nada: recargá la página para ver el estado actual.</p>"), 500));
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(o.port ?? 0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    env = localPanelEnv({
        secret,
        port,
        cli: o.cli,
        profileId: o.profileId,
        now,
        onOutcome: (out) => {
            last = out;
            if (out.state === "committed" && out.diagnostic?.result === "ready") finished = true;
        },
    });
    touchIdle();
    return { url: `http://127.0.0.1:${port}${env.path}`, port, done, close: () => stop("closed") };
}
