import { createHmac, randomBytes } from "node:crypto";
import { parseStoredLogin } from "../web/autologin.js";
import type { ConnectionStatusDeps } from "../mcp/server.js";
import { CONNECTION_REASONS, reasonMessage, type ConnectionReason, type RenewalState } from "./connection-contracts.js";
import type { ConnectionConfig, ConnectionService, RenewalOutcome } from "./connection-service.js";
import type { RemoteConfig } from "./config.js";
import type { TokenSigner } from "./oauth.js";
import type { KvSecretBox } from "./web-store.js";

/**
 * Panel de la conexión con el Campus. Una sola implementación para los dos lugares:
 * - remoto (ADR-141), `/admin/conexion`: dueño autenticado con su GitHub (misma cookie de aprobador) Y
 *   vínculo con el navegador (`__Host-campus_connection`, aleatorio; el desafío guarda sólo su HMAC);
 * - local (ADR-142), `http://127.0.0.1:<puerto>/<secreto>/conexion`: el secreto de la ruta es la
 *   credencial (lo conoce sólo quien corrió el comando) más el mismo vínculo con el navegador.
 * En los dos: GET sólo muestra (nunca inicia login ni manda correos). Cada acción es un POST con el Origin
 * exacto, formulario firmado de propósito propio y de un solo uso → 303 → GET.
 * Funciona con escrituras apagadas, freno abierto o interruptor manual: no depende del almacén de escrituras.
 */

export const CONNECTION_PATH = "/admin/conexion";
const BIND_COOKIE = "__Host-campus_connection";
const FORM_TTL_S = 600;
const MAX_FORM_BYTES = 4096;
export const PANEL_ACTIONS = ["iniciar", "completar", "cancelar", "diagnosticar", "activar"] as const;
type Action = (typeof PANEL_ACTIONS)[number];
const STATES: RenewalState[] = ["idle", "starting", "awaiting_code", "submitting", "candidate_ready", "committed", "failed", "uncertain", "expired", "cancelled", "superseded"];
const TZ = "America/Argentina/Buenos_Aires";

/** Configuración de la conexión desde la configuración remota validada (sobre v2 o legacy epoch 0). */
export function connectionConfig(cfg: RemoteConfig, box: KvSecretBox): ConnectionConfig {
    const w = cfg.web;
    const login = cfg.autologin ? parseStoredLogin(cfg.autologin.login) : null;
    if (w.bootstrap) {
        return { epoch: w.bootstrap.activation_epoch, fingerprint: box.fingerprint(`bootstrap\n${w.bootstrapRaw}`), mode: w.bootstrap.mode === "disabled" ? "disabled" : login ? "enabled" : "session_only", login, bootstrap: w.bootstrap, legacy: { loginRaw: null, trustRaw: null, sessionSeedRaw: null } };
    }
    return {
        epoch: 0,
        fingerprint: login ? box.fingerprint(`legacy\n${cfg.autologin!.login}\n${cfg.autologin!.trust ?? ""}`) : "session-only",
        mode: login ? "enabled" : "session_only",
        login,
        bootstrap: null,
        legacy: { loginRaw: cfg.autologin?.login ?? null, trustRaw: cfg.autologin?.trust ?? null, sessionSeedRaw: w.sessionSeed },
    };
}

/** Lo que usa campus_get_status (lectura y completo): estado sin red, probe web aislado y diagnóstico completo. */
export function connectionStatusDeps(conn: ConnectionService): ConnectionStatusDeps {
    return { status: () => conn.publicStatus(), probeWeb: () => conn.probeWeb(), diagnose: () => conn.diagnose() };
}

export interface ConnectionUi {
    html: (body: string, status?: number) => Response;
    page: (title: string, body: string) => string;
    esc: (s: string) => string;
    readBody: (req: Request) => Promise<string>;
    approverOf: (req: Request) => Promise<string | null>;
    adminLogin: () => Promise<Response>;
    log: (event: string, fields: Record<string, unknown>) => void;
}

export interface FormClaims {
    sub: string;
    action: string;
    bind: string;
    renewal_id: string | null;
    epoch: number;
    generation: number;
    jti: string;
}

/** Lo que distingue al panel remoto del local. Todo lo demás (estados, formularios, textos) es común. */
export interface PanelEnv {
    /** Ruta base del panel (sin barra final). */
    path: string;
    /** Origin exacto que tiene que traer cada POST. */
    origin: string;
    /** Nombre de la cookie de vínculo y sus atributos. */
    bindCookie: string;
    bindCookieAttrs: string;
    bindHash: (value: string) => string;
    signForm: (c: FormClaims) => Promise<string>;
    verifyForm: (token: string, sub: string, action: string, bind: string) => Promise<{ renewal_id: string | null; jti: string }>;
    /** Dueño autenticado del panel (sub), o null. */
    ownerOf: (req: Request) => Promise<string | null>;
    /** Respuesta cuando falta el dueño en un GET (remoto: login con GitHub). */
    login: () => Promise<Response>;
    title: string;
    texts: {
        noKv: string;
        /** HTML de lo que no se resuelve desde el panel (motivo de recuperación fuera del panel). */
        unresolvable: (r: ConnectionReason) => string;
        noAutologin: string;
        startNote: string;
        footer: string;
    };
    /** Aviso del resultado de cada acción (el panel local se cierra solo al terminar). */
    onOutcome?: (out: RenewalOutcome, action: Action) => void;
}

export interface PanelUi {
    html: (body: string, status?: number) => Response;
    page: (title: string, body: string) => string;
    esc: (s: string) => string;
    readBody: (req: Request) => Promise<string>;
    log: (event: string, fields: Record<string, unknown>) => void;
}

function cookieOf(req: Request, name: string): string | null {
    const raw = req.headers.get("cookie") ?? "";
    for (const part of raw.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === name) return v.join("=") || null;
    }
    return null;
}

/** Entorno del panel remoto (ADR-141). */
export function remotePanelEnv(cfg: RemoteConfig, signer: TokenSigner, ui: ConnectionUi): PanelEnv {
    return {
        path: CONNECTION_PATH,
        origin: cfg.baseUrl,
        bindCookie: BIND_COOKIE,
        bindCookieAttrs: "Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800",
        bindHash: (value) => createHmac("sha256", Buffer.from(cfg.signingSecret)).update(`udesa-campus-mcp:conn-bind:v1\n${value}`).digest("base64url"),
        signForm: (c) => signer.signConnectionForm(c),
        verifyForm: (t, sub, action, bind) => signer.verifyConnectionForm(t, sub, action, bind),
        ownerOf: (req) => ui.approverOf(req),
        login: () => ui.adminLogin(),
        title: "Conexión con el Campus",
        texts: {
            noKv: "<p>Este servidor no tiene configurado el almacén compartido (KV): la conexión web no se puede renovar desde el panel. Usá la recuperación desde la PC.</p>",
            unresolvable: () => "<p>Desde el panel no se puede resolver: hace falta la recuperación desde la PC (<code>campus remote autologin renew --redeploy</code>).</p>",
            noAutologin: "<p>Este servidor no tiene el login automático configurado: no se puede renovar desde el panel. Usá la recuperación desde la PC.</p>",
            startNote: "Al pulsar, el servidor inicia sesión en el Campus y el Campus te manda un código al correo.",
            footer: "Esta página es tu sesión de GitHub en el panel; la conexión con el Campus es otra cosa. Nada de lo que hagas acá cambia el freno, los límites ni las aprobaciones de escrituras.",
        },
    };
}

function localTime(iso: string | null): string {
    if (!iso) return "—";
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "—";
    return new Intl.DateTimeFormat("es-AR", { timeZone: TZ, dateStyle: "full", timeStyle: "short" }).format(new Date(ms));
}

function remaining(iso: string | null, now: Date): string {
    if (!iso) return "";
    const ms = Date.parse(iso) - now.getTime();
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "vencida";
    // «Menos de un día» no se redondea a «vencida».
    const days = Math.floor(ms / 86_400_000);
    if (days >= 1) return `faltan ${days} día(s)`;
    const hours = Math.floor(ms / 3_600_000);
    return hours >= 1 ? `faltan ${hours} hora(s), menos de un día` : "falta menos de una hora";
}

/** Rutas `/admin/conexion*` del remoto. `conn` null = sin KV (el panel lo explica). */
export async function handleConnection(req: Request, path: string, cfg: RemoteConfig, signer: TokenSigner, conn: ConnectionService | null, ui: ConnectionUi, now: () => Date): Promise<Response> {
    return handlePanel(req, path, remotePanelEnv(cfg, signer, ui), conn, ui, now);
}

/** Panel genérico (remoto o local): `env.path` muestra, `env.path/<acción>` actúa. */
export async function handlePanel(req: Request, path: string, env: PanelEnv, conn: ConnectionService | null, ui: PanelUi, now: () => Date): Promise<Response> {
    const sub = await env.ownerOf(req);
    if (req.method === "GET" && path === env.path) {
        if (!sub) return env.login();
        return renderPage(req, env, conn, ui, sub, now);
    }
    const action = path.slice(env.path.length + 1) as Action;
    if (req.method !== "POST" || !path.startsWith(`${env.path}/`) || !PANEL_ACTIONS.includes(action)) return ui.html(ui.page("No encontrado", "<p>Esta dirección no existe.</p>"), 404);
    // CSRF: Origin exacto (sin fallback si falta), cuerpo acotado y de formulario, dueño y vínculo del navegador.
    if (req.headers.get("origin") !== env.origin) {
        ui.log("connection_panel", { outcome: "origin_rejected" });
        return ui.html(ui.page("No se cambió nada", "<p>El pedido no salió de este panel (origen inválido o ausente).</p>"), 403);
    }
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers.get("content-type") ?? "") || Number(req.headers.get("content-length") ?? 0) > MAX_FORM_BYTES) return ui.html(ui.page("No se cambió nada", "<p>Formulario inválido.</p>"), 400);
    if (!sub) return ui.html(ui.page("Sesión del panel vencida", `<p>Tu sesión del panel venció (no la conexión con el Campus). Volvé a abrir <a href="${env.path}">el panel</a>.</p>`), 401);
    const bind = cookieOf(req, env.bindCookie);
    if (!bind) return ui.html(ui.page("No se cambió nada", `<p>Este navegador no tiene el vínculo del panel. Volvé a abrir <a href="${env.path}">el panel</a>.</p>`), 403);
    const body = await ui.readBody(req);
    if (body.length > MAX_FORM_BYTES) return ui.html(ui.page("No se cambió nada", "<p>Formulario demasiado grande.</p>"), 413);
    const form = new URLSearchParams(body);
    const bh = env.bindHash(bind);
    let token: { renewal_id: string | null; jti: string };
    try {
        token = await env.verifyForm(form.get("form") ?? "", sub, action, bh);
    } catch {
        ui.log("connection_panel", { action, outcome: "form_invalid" });
        return ui.html(ui.page("No se cambió nada", `<p>El formulario venció, es de otra acción o de otro navegador. Volvé a abrir <a href="${env.path}">el panel</a>.</p>`), 409);
    }
    if (!conn) return back(env, null);
    if (!(await conn.store.consumeOnce(`conn_${token.jti}`, FORM_TTL_S))) {
        ui.log("connection_panel", { action, outcome: "replay" });
        return back(env, null); // repetir el mismo formulario no produce efectos nuevos: se muestra el estado
    }
    let out: RenewalOutcome;
    if (action === "iniciar") out = await conn.start(bh, { rearm: form.get("rearm") === "1" });
    else if (action === "completar") out = await conn.complete(token.renewal_id ?? "", form.get("code") ?? "", bh);
    else if (action === "cancelar") out = await conn.cancel(token.renewal_id ?? "", bh);
    else if (action === "activar") out = await conn.activate();
    else {
        const resumed = await conn.resume();
        const report = await conn.diagnose();
        out = resumed.state === "committed" ? resumed : { state: "idle", renewal_id: null, reason: null, message: "", diagnostic: report };
    }
    ui.log("connection_panel", { action, state: out.state, reason: out.reason });
    env.onOutcome?.(out, action);
    return back(env, out);
}

/** POST → 303 → GET, con el resultado como valores de listas cerradas (nunca texto libre en la URL). */
function back(env: PanelEnv, out: RenewalOutcome | null): Response {
    const q = new URLSearchParams();
    if (out) {
        q.set("estado", out.state);
        if (out.reason) q.set("motivo", out.reason);
        if (out.input_error) q.set("codigo", "formato");
        if (out.diagnostic) q.set("diag", out.diagnostic.result);
    }
    return new Response(null, { status: 303, headers: { location: `${env.path}${q.size ? `?${q}` : ""}`, "cache-control": "no-store", "referrer-policy": "same-origin" } });
}

const FLASH: Partial<Record<RenewalState, string>> = {
    awaiting_code: "Ingresá el código de seis dígitos del correo que acabás de solicitar.",
    committed: "La renovación quedó guardada.",
    expired: "Este proceso venció. Iniciá una nueva renovación.",
    cancelled: "Renovación cancelada.",
    uncertain: "No pudimos confirmar el resultado del intento. No vamos a reenviar el código automáticamente.",
    superseded: "Este proceso fue reemplazado o no corresponde a este navegador. Leé el estado actual.",
    submitting: "La renovación ya está en curso.",
    starting: "La renovación ya está en curso.",
};

async function renderPage(req: Request, env: PanelEnv, conn: ConnectionService | null, ui: PanelUi, sub: string, now: () => Date): Promise<Response> {
    const e = ui.esc;
    let bind = cookieOf(req, env.bindCookie);
    const setBind = !bind;
    bind ??= randomBytes(24).toString("base64url");
    const bh = env.bindHash(bind);
    const finish = (title: string, body: string) => {
        const res = ui.html(ui.page(title, body));
        // Con "no-referrer" Chrome manda `Origin: null` en los POST del formulario (Fetch, §append
        // a request Origin header) y el control de origen los rechaza. "same-origin" conserva el
        // Origin del propio sitio y no filtra nada hacia afuera.
        res.headers.set("referrer-policy", "same-origin");
        if (setBind) res.headers.append("set-cookie", `${env.bindCookie}=${bind}; ${env.bindCookieAttrs}`);
        return res;
    };
    if (!conn) return finish(env.title, env.texts.noKv);
    const url = new URL(req.url);
    const st = url.searchParams.get("estado") as RenewalState | null;
    const reason = url.searchParams.get("motivo") as ConnectionReason | null;
    const flashState = st && STATES.includes(st) ? st : null;
    const flashReason = reason && (CONNECTION_REASONS as readonly string[]).includes(reason) ? reason : null;
    const diag = url.searchParams.get("diag");
    let flash = "";
    if (url.searchParams.get("codigo") === "formato") flash = "El código son seis dígitos: no se envió nada.";
    else if (flashState === "committed") flash = diag === "ready" ? "Conexión renovada y verificada." : "La renovación quedó guardada. No pudimos comprobar la conexión.";
    else if (flashState === "failed" && flashReason === "otp_rejected") flash = "El Campus no aceptó el código: puede ser incorrecto o haber vencido.";
    else if (flashState === "failed" && flashReason) flash = reasonMessage(flashReason);
    else if (flashState === "idle" && diag) flash = diag === "ready" ? "Comprobación terminada: la conexión funciona." : "Comprobación terminada con problemas (ver abajo).";
    else if (flashState && FLASH[flashState]) flash = FLASH[flashState]!;

    let rec;
    let status: Record<string, unknown>;
    try {
        rec = await conn.record();
        status = await conn.publicStatus();
    } catch {
        return finish(env.title, `<p class="warn">El almacén de la conexión no responde o su registro está dañado. No se inicia nada. Probá de nuevo en unos minutos; si sigue, usá la recuperación desde la PC.</p>`);
    }
    const t = now();
    const forms = async (action: Action, label: string, extra = "", renewalId: string | null = null, secondary = false) => {
        const token = await env.signForm({ sub, action, bind: bh, renewal_id: renewalId, epoch: rec.config_epoch, generation: rec.auth_generation, jti: randomBytes(18).toString("base64url") });
        return `<form method="post" action="${env.path}/${action}" style="margin-top:12px"><input type="hidden" name="form" value="${e(token)}">${extra}<button type="submit"${secondary ? ' style="background:#5b6475"' : ""}>${e(label)}</button></form>`;
    };
    const trust = status.device_trust as { state: string; expires_at: string | null };
    const last = rec.last_diagnostic && rec.last_diagnostic.auth_generation === rec.auth_generation ? rec.last_diagnostic : null;
    const trustLabel: Record<string, string> = { valid: "vigente", expiring: "vence pronto", expired: "vencida", missing: "no hay", not_applicable: "no aplica (sin login automático)" };
    const rows = [
        ["Confianza del dispositivo", `${trustLabel[trust.state] ?? "desconocida"}${trust.expires_at && trust.state !== "not_applicable" ? ` · hasta ${localTime(trust.expires_at)} (${remaining(trust.expires_at, t)})` : ""}`],
        ["Sesión web publicada", rec.active?.session_sealed ? "sí" : "no"],
        ["Última comprobación", last ? `${last.result === "ready" ? "correcta" : last.result === "pending" ? "pendiente" : "con problemas"}${last.finished_at ? ` · ${localTime(last.finished_at)}` : ""}` : "sin comprobar en esta generación"],
    ];
    if (last && last.result !== "pending") {
        for (const [k, label] of [["api_token", "API de Moodle (token)"], ["web_session", "Sesión web"], ["identity", "Identidad"], ["persistence", "Persistencia"]] as const) rows.push([label, last.checks[k].state === "ok" ? "correcta" : last.checks[k].state === "unknown" ? "desconocida (sin respuesta)" : last.checks[k].state === "failed" ? "falló" : "sin comprobar"]);
    }
    const table = `<table style="width:100%;border-collapse:collapse;margin:12px 0">${rows.map(([k, v]) => `<tr><th style="text-align:left;padding:4px 12px 4px 0;vertical-align:top">${e(k!)}</th><td>${e(v!)}</td></tr>`).join("")}</table>`;
    const p = rec.control.pending;
    const r = conn.reasonOf(rec);
    let main = "";
    const steps = "<p style=\"color:var(--muted)\">Pedir código → Confirmar código → Verificar conexión</p>";
    if (r === "activation_pending") {
        main = `<p>Hay una configuración de recuperación publicada desde la PC que falta activar. Se verifica su sesión sin pedir contraseña ni código.</p>${await forms("activar", "Activar y verificar recuperación")}`;
    } else if (p && p.state === "awaiting_code" && Date.parse(p.expires_at) > t.getTime() && p.browser_hash === bh) {
        main = `${steps}<p>Ingresá el código de seis dígitos del correo que acabás de solicitar (vale hasta ${localTime(p.expires_at)}).</p>${await forms("completar", "Confirmar y verificar", `<label for="code">Código del correo</label><br><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required style="font:inherit;font-size:1.3rem;letter-spacing:.2em;padding:8px;width:9em" aria-describedby="code-help"><p id="code-help" style="color:var(--muted);font-size:.9rem">Seis dígitos; podés pegarlo. Si el correo trae un enlace para avisar que no fuiste vos, no lo uses.</p>`, p.renewal_id)}${await forms("cancelar", "Cancelar", "", p.renewal_id, true)}<details style="margin-top:12px"><summary>No recibí el código</summary><p>Revisá la carpeta de spam del correo institucional y esperá un par de minutos. Si no llega, cancelá: podés iniciar otra renovación cuando se cumpla la pausa entre intentos (10 minutos después de un intento fallido).</p></details>`;
    } else if (r === "renewal_in_progress") {
        main = `<p>La renovación ya está en curso${p && p.browser_hash !== bh ? " (en otro navegador o proceso)" : ""}. Esperá y recargá esta página.</p>`;
    } else if (r === "attempt_uncertain") {
        const claimOver = !p?.claim_until || Date.parse(p.claim_until) <= t.getTime();
        main = `<p class="warn">No pudimos confirmar el resultado de un intento anterior. No vamos a reenviar el código automáticamente. Revisá tus sesiones en el Campus (Preferencias → Sesiones del navegador).</p>${claimOver ? await forms("iniciar", "Iniciar otra renovación", '<input type="hidden" name="rearm" value="1">') : "<p>Esperá unos minutos antes de iniciar otra.</p>"}`;
    } else if (r && ["credentials_rejected", "manual_disable", "config_incomplete", "config_conflict", "api_token_invalid", "identity_mismatch"].includes(r)) {
        main = `<p class="warn">${e(reasonMessage(r))}</p>${env.texts.unresolvable(r)}`;
    } else if (r === "stale_instance" || r === "kv_unavailable") {
        main = `<p class="warn">${e(reasonMessage(r))}</p><p>Recargá en unos minutos.</p>`;
    } else if (conn.config.mode === "enabled") {
        const why = r === "trust_expired" || r === "trust_missing" || r === "session_expired" ? "La conexión web del Campus necesita renovar la confianza del dispositivo." : r === "trust_expiring" ? "La confianza del dispositivo vence pronto: podés renovarla ahora." : r === "otp_rejected" ? "El último código no fue aceptado: podés iniciar otra renovación." : "La conexión funciona. Si querés, podés renovar la confianza antes de que venza.";
        main = `${steps}<p>${e(why)}</p><p style="color:var(--muted);font-size:.9rem">${e(env.texts.startNote)}</p>${await forms("iniciar", "Enviar código y renovar")}`;
    } else {
        main = env.texts.noAutologin;
    }
    const recheck = rec.active ? await forms("diagnosticar", "Repetir comprobación", "", null, true) : "";
    return finish(env.title, `${flash ? `<p role="status" class="warn">${e(flash)}</p>` : ""}${table}${main}${recheck}<p style="color:var(--muted);font-size:.85rem;margin-top:18px">${e(env.texts.footer)}</p>`);
}
