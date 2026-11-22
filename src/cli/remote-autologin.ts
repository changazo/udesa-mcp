import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.js";
import { packageRoot, type Profile } from "../config/profile.js";
import { CampusError, toPublicError } from "../errors.js";
import type { FetchLike } from "../moodle/transport.js";
import { parseBootstrap, TRUST_WARN_MS } from "../remote/connection-contracts.js";
import type { MetadataStore } from "../session/metadata.js";
import type { SecretStore } from "../session/secret-store.js";
import { cliCommand } from "../util/cli-command.js";
import type { Logger } from "../util/logger.js";
import { loadLogin, loadTrust, type StoredLogin } from "../web/autologin.js";
import { passwordLogin, type LoginResult } from "../web/login.js";
import { encodeSnapshot, MemoryWebSessionSource, type WebCookie } from "../web/session.js";
import { WebTransport, webUserAgent } from "../web/transport.js";
import { promptHidden, promptVisible, requireTty } from "./prompt.js";
import { vercelAvailable, vercelDeployProd, vercelEnvAdd, vercelEnvRm, vercelProjectLinked, type VercelDeployResult } from "./remote.js";

/**
 * `campus remote autologin renew|enable|disable|deploy|status` (ADR-127, renovado en ADR-141). Lo corre
 * el humano en su PC. Es la recuperación EXCEPCIONAL del login web automático del remoto: la renovación
 * habitual se hace desde el panel privado (/admin/conexion).
 *
 * `renew` hace UN login aislado (dispositivo «remoto», sin la confianza de la PC) que pide el código del
 * correo, valida identidad y confianza, y publica en Vercel un único sobre sensible CAMPUS_WEB_BOOTSTRAP
 * (v2: credenciales + confianza + sesión, con activation_epoch monotónico) más la segunda llave
 * CAMPUS_WEB_AUTOLOGIN=true. Borra las variables sueltas legacy. Con --redeploy despliega. Nunca declara
 * «verificado»: eso lo hace el panel («Activar y verificar recuperación») o campus_get_status.
 *
 * La recuperación desde la PC no puede reservar el intento en el ledger remoto (directiva §10.3): es un
 * solo intento, explícito, sin reintentos automáticos de login.
 */

const STATE_FILE = "remote-autologin.json";
const BOOTSTRAP_VAR = "CAMPUS_WEB_BOOTSTRAP";
const SECOND_KEY_VAR = "CAMPUS_WEB_AUTOLOGIN";
/** Variables sueltas anteriores al sobre v2: con el bootstrap presente el servidor las ignora; se borran. */
const LEGACY_VARS = ["CAMPUS_WEB_LOGIN", "CAMPUS_WEB_TRUST", "CAMPUS_WEB_SESSION"] as const;
/** Margen mínimo de vigencia de la confianza nueva para que valga la pena publicarla. */
const TRUST_MIN_MARGIN_MS = 86_400_000;
const HISTORY_MAX = 10;

export type PublicationState = "candidate_validated" | "configuration_published_pending_deploy" | "deployed_pending_verification" | "publish_failed" | "publish_incomplete";

interface PublicationEntry {
    mode: "enabled" | "disabled";
    activation_epoch: number;
    state: PublicationState;
    published_at: string | null;
    deployed_at?: string | null;
    trust_expires_at?: string | null;
    user_id?: number;
    /** Paso que falló (sin valores). */
    failed_step?: string;
}

/**
 * Historial de publicación desde ESTA PC (no es el estado vivo del remoto). `last_epoch` es el mayor
 * activation_epoch generado acá, para que el siguiente sea siempre mayor aunque el reloj retroceda.
 * Los campos enabled_at/disabled_at/trust_expires_at son del formato anterior (sólo lectura).
 */
interface RemoteAutoLoginRecord {
    v?: 2;
    last_epoch?: number;
    history?: PublicationEntry[];
    enabled_at?: string;
    trust_expires_at?: string | null;
    disabled_at?: string;
}

export interface RemoteAutoLoginWiring {
    profile: Profile;
    app: App;
    secrets: SecretStore;
    metadata: MetadataStore;
    logger: Logger;
}

export interface RemoteAutoLoginOptions {
    /** `--redeploy`: desplegar a producción después de publicar. */
    redeploy?: boolean;
    /** `--base-url`: origen https del remoto, para enlazar el panel. */
    baseUrl?: string;
    /** `--min-epoch`: piso del activation_epoch (si el diagnóstico remoto informó uno aceptado mayor). */
    minEpoch?: string;
}

/** Dependencias inyectables (tests). Por defecto, las reales. */
export interface RemoteAutoLoginDeps {
    vercelEnvAdd: (name: string, value: string, opts: { sensitive: boolean }) => Promise<void>;
    vercelEnvRm: (name: string) => Promise<"removed" | "absent">;
    vercelDeploy: () => Promise<VercelDeployResult>;
    vercelAvailable: () => Promise<boolean>;
    vercelProjectLinked: () => boolean;
    buildExists: () => boolean;
    requireTty: () => void;
    promptVisible: (q: string) => Promise<string>;
    promptHidden: (q: string) => Promise<string>;
    fetch?: FetchLike;
    now: () => Date;
    env: NodeJS.ProcessEnv;
    out: (s: string) => void;
    err: (s: string) => void;
}

const defaultDeps = (): RemoteAutoLoginDeps => ({
    vercelEnvAdd,
    vercelEnvRm: (name) => vercelEnvRm(name),
    vercelDeploy: vercelDeployProd,
    vercelAvailable,
    vercelProjectLinked,
    buildExists: () => existsSync(join(packageRoot(), "build", "remote", "vercel.js")),
    requireTty,
    promptVisible,
    promptHidden,
    now: () => new Date(),
    env: process.env,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
});

/** Origen https válido (sin ruta, query ni credenciales) o null. */
function httpsOrigin(raw: string | undefined): string | null {
    if (!raw) return null;
    try {
        const u = new URL(raw.trim());
        if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
        return u.origin;
    } catch {
        return null;
    }
}

function readRecord(m: MetadataStore): RemoteAutoLoginRecord {
    const r = m.readJson(STATE_FILE);
    return r && typeof r === "object" ? (r as RemoteAutoLoginRecord) : {};
}

function writeRecord(m: MetadataStore, r: RemoteAutoLoginRecord) {
    m.writeJson(STATE_FILE, { ...r, v: 2, history: (r.history ?? []).slice(-HISTORY_MAX) } satisfies RemoteAutoLoginRecord);
}

/** activation_epoch monotónico: max(ahora, último local + 1, --min-epoch). Se registra antes de publicar. */
function nextEpoch(m: MetadataStore, now: Date, minEpoch: number): number {
    const rec = readRecord(m);
    const last = Number.isSafeInteger(rec.last_epoch) ? (rec.last_epoch as number) : 0;
    const epoch = Math.max(now.getTime(), last + 1, minEpoch);
    writeRecord(m, { ...rec, last_epoch: epoch });
    return epoch;
}

function pushHistory(m: MetadataStore, e: PublicationEntry) {
    const rec = readRecord(m);
    writeRecord(m, { ...rec, history: [...(rec.history ?? []), e] });
}

/** Reemplaza la última entrada del historial (misma publicación, nuevo estado). */
function updateLast(m: MetadataStore, patch: Partial<PublicationEntry>) {
    const rec = readRecord(m);
    const h = [...(rec.history ?? [])];
    const last = h.pop();
    if (!last) return;
    writeRecord(m, { ...rec, history: [...h, { ...last, ...patch }] });
}

export async function remoteAutologinCommand(action: string | undefined, w: RemoteAutoLoginWiring, opts: RemoteAutoLoginOptions = {}, injected: Partial<RemoteAutoLoginDeps> = {}): Promise<number> {
    const d: RemoteAutoLoginDeps = { ...defaultDeps(), ...injected };
    const p = w.profile;
    const cmd = (rest: string) => `${cliCommand()} ${rest} --profile ${p.profile_id}`;
    const { out, err } = d;

    // Panel: --base-url o CAMPUS_REMOTE_URL (origen https). Un --base-url inválido se rechaza antes de todo.
    let base: string | null = null;
    if (opts.baseUrl !== undefined) {
        base = httpsOrigin(opts.baseUrl);
        if (!base) {
            err("--base-url debe ser un origen https sin ruta (por ejemplo https://mi-campus.vercel.app).");
            return 2;
        }
    } else if (d.env.CAMPUS_REMOTE_URL) {
        base = httpsOrigin(d.env.CAMPUS_REMOTE_URL);
        if (!base) err("Aviso: CAMPUS_REMOTE_URL no es un origen https válido; se ignora.");
    }
    const panel = base ? `${base}/admin/conexion` : null;
    const panelLine = () =>
        panel
            ? `Abrí ${panel} y apretá «Activar y verificar recuperación».`
            : "Abrí /admin/conexion en tu remoto (anteponé su URL, p. ej. https://<tu-remoto>/admin/conexion) y apretá «Activar y verificar recuperación».";
    const verifyHint = () => {
        out(panelLine());
        out("O verificalo desde el conector MCP remoto con campus_get_status {verify: true, verify_web: true}.");
        out("Hasta esa verificación, la recuperación NO está confirmada.");
    };

    let minEpoch = 0;
    if (opts.minEpoch !== undefined) {
        minEpoch = Number(opts.minEpoch);
        if (!Number.isSafeInteger(minEpoch) || minEpoch <= 0) {
            err("--min-epoch debe ser un entero positivo (el epoch que mostró el diagnóstico del remoto).");
            return 2;
        }
        minEpoch += 1;
    }

    /** Preflight sin secretos: TTY (si hace falta), build, vínculo con Vercel y CLI de Vercel. */
    const preflight = async (tty: boolean): Promise<string | null> => {
        if (tty) {
            try {
                d.requireTty();
            } catch (e) {
                return `terminal interactiva: ${toPublicError(e).message}`;
            }
        }
        if (!d.buildExists()) return "build: falta build/remote/vercel.js. Corré npm run build.";
        if (!d.vercelProjectLinked()) return `proyecto de Vercel: el paquete no está vinculado (falta .vercel/project.json). Corré vercel link en ${packageRoot()}.`;
        if (!(await d.vercelAvailable())) return "CLI de Vercel: no se encontró el comando vercel. Instalala (npm i -g vercel) e iniciá sesión (vercel login).";
        return null;
    };

    const deploy = async (): Promise<boolean> => {
        out("Desplegando a producción (vercel deploy --prod)…");
        const r = await d.vercelDeploy();
        if (!r.ok) {
            err(`Falló el paso «deploy» (vercel deploy --prod, código ${r.code ?? "sin lanzar"}): ${r.stderr_tail || "sin detalle"}`);
            err(`La configuración quedó publicada pero NO desplegada: producción sigue con la anterior. Reintentá sin otro código con ${cmd("remote autologin deploy")} (o vercel deploy --prod).`);
            return false;
        }
        updateLast(w.metadata, { state: "deployed_pending_verification", deployed_at: d.now().toISOString() });
        out("Estado: deployed_pending_verification (desplegado; falta verificar).");
        return true;
    };

    if (action === "renew" || action === "enable") {
        if (action === "enable") out(`Nota: «enable» ahora es «renew» (${cmd("remote autologin renew")} [--redeploy]). Se ejecuta lo mismo, sin desplegar.`);
        const redeploy = action === "renew" && !!opts.redeploy;
        const failed = await preflight(true);
        if (failed) {
            err(`Falló el preflight, paso «${failed}»`);
            err("No se inició sesión ni se publicó nada.");
            return 2;
        }
        // Identidad esperada: la del token verificado del perfil (antes de pedir nada).
        let expected: number;
        try {
            expected = (await w.app.session.verified()).info.userid;
        } catch (e) {
            const pe = toPublicError(e);
            err(`Falló el paso «identidad esperada» (sesión del perfil en esta PC): ${pe.code}. ${pe.message}`);
            err(`Iniciá sesión primero con ${cmd("auth login")}. No se publicó nada.`);
            return 2;
        }

        // Credenciales: las del keyring si existen; si no, se piden acá (no hace falta el autologin local).
        let creds: StoredLogin | null = null;
        let remembered: WebCookie[] = [];
        try {
            creds = await loadLogin(w.secrets, p.profile_id, p.site_url);
            // De la PC sólo se reusa MOODLEID*_ (evita el aviso de «nuevo inicio»); la confianza del remoto es propia.
            remembered = (await loadTrust(w.secrets, p.profile_id, p.site_url)).filter((c) => /^MOODLEID\d*_/.test(c.name));
        } catch (e) {
            err(`Aviso: no se pudo leer el almacén seguro (${toPublicError(e).code}); se piden las credenciales acá.`);
        }
        if (!creds) {
            out("No hay contraseña del Campus guardada en esta PC: ingresala ahora (se usa para este login y se publica sólo dentro del sobre sensible; no se guarda en la PC).");
            const username = (await d.promptVisible("Usuario del Campus: ")).trim();
            const password = await d.promptHidden("Contraseña (no se muestra): ");
            if (!username || !password) {
                err("Falló el paso «credenciales»: usuario o contraseña vacíos. No se publicó nada.");
                return 2;
            }
            creds = { username, password };
        }

        const web = new WebTransport({
            siteUrl: p.site_url,
            source: new MemoryWebSessionSource(),
            expectedUserId: async () => expected,
            logger: w.logger,
            timeoutMs: p.limits.http_timeout_seconds * 1000,
            fetch: d.fetch,
            renewHint: "",
            userAgent: webUserAgent("remoto"),
        });
        out("Recuperación del login web automático del remoto (ADR-141). Se hace UN login como dispositivo «remoto»:");
        out("el Campus te va a mandar un código al correo. Esa confianza es sólo del remoto (no pisa la de esta PC).");
        out("Si el correo trae un enlace para avisar que no fuiste vos, NO lo uses: revoca el factor de toda la cuenta (ADR-121).");
        let r: LoginResult;
        try {
            r = await passwordLogin(web, {
                username: creds.username,
                password: creds.password,
                remembered,
                now: d.now,
                askCode: async () => {
                    out("El Campus te mandó un código de verificación al correo.");
                    return (await d.promptHidden("Código de 6 dígitos (no se muestra): ")).trim();
                },
            });
        } catch (e) {
            const pe = toPublicError(e);
            err(`Falló el paso «login en el Campus»: ${pe.code}. ${pe.message}`);
            err("No se publicó nada en Vercel. No se reintenta solo: cada intento puede sumar al bloqueo de la cuenta.");
            return 1;
        }

        // Validación de la candidata antes de publicar.
        if (r.snapshot.user_id !== expected) {
            err(`Falló el paso «identidad»: la sesión es de otra cuenta de Moodle (esperado userid ${expected}). No se publicó nada.`);
            return 1;
        }
        const own = r.remembered.find((c) => c.name === `MFA_TOKEN_${expected}`);
        const trustMs = own?.expires ? own.expires * 1000 : null;
        if (!own || !trustMs) {
            err("Falló el paso «confianza»: el Campus no dejó la cookie de dispositivo de confianza (con vencimiento). Sin ella el remoto no puede iniciar sesión solo. No se publicó nada.");
            return 1;
        }
        if (trustMs - d.now().getTime() < TRUST_MIN_MARGIN_MS) {
            err(`Falló el paso «confianza»: vence el ${new Date(trustMs).toLocaleString("es-AR")}, con menos de un día de margen. No se publicó nada.`);
            return 1;
        }
        const trustExp = new Date(trustMs).toISOString();
        const trust = r.remembered.filter((c) => c.name === own.name || /^MOODLEID\d*_/.test(c.name));
        const epoch = nextEpoch(w.metadata, d.now(), minEpoch);
        const raw = JSON.stringify({ v: 2, activation_epoch: epoch, mode: "enabled", login: creds, trust, session: encodeSnapshot(r.snapshot) });
        try {
            parseBootstrap(raw, expected);
        } catch (e) {
            err(`Falló el paso «armado del sobre»: ${toPublicError(e).message} No se publicó nada.`);
            return 1;
        }
        out(`Estado: candidate_validated (userid ${expected}, segundo factor: ${r.mfa}, confianza hasta ${new Date(trustMs).toLocaleString("es-AR")}, activation_epoch ${epoch}).`);

        // Publicación: sobre único + segunda llave; después se retiran las sueltas legacy.
        const entry: PublicationEntry = { mode: "enabled", activation_epoch: epoch, state: "publish_failed", published_at: null, trust_expires_at: trustExp, user_id: expected };
        const published = await publish(d, w.metadata, entry, raw, "true", cmd);
        if (!published) return 1;
        out(`Estado: configuration_published_pending_deploy. Publicadas ${BOOTSTRAP_VAR} (sensible, no se muestra) y ${SECOND_KEY_VAR}=true.`);
        out(`El Campus confía en el dispositivo «remoto» hasta ${new Date(trustMs).toLocaleString("es-AR")}; el panel avisa con 7 días de anticipación.`);
        if (!redeploy) {
            out("Producción todavía NO usa esta configuración. Desplegala con: vercel deploy --prod");
            out(`(o ${cmd("remote autologin deploy")}). Después:`);
            verifyHint();
            return 0;
        }
        if (!(await deploy())) return 1;
        out("Activá la sesión pronto: la sesión publicada puede vencer por inactividad antes de la activación (el panel lo informa).");
        verifyHint();
        return 0;
    }

    if (action === "deploy") {
        const failed = await preflight(false);
        if (failed) {
            err(`Falló el preflight, paso «${failed}»`);
            return 2;
        }
        const last = readRecord(w.metadata).history?.at(-1);
        if (!last || (last.state !== "configuration_published_pending_deploy" && last.state !== "deployed_pending_verification")) {
            err(`No hay una publicación completa desde esta PC pendiente de deploy. Para recuperar: ${cmd("remote autologin renew")} --redeploy.`);
            return 2;
        }
        if (!(await deploy())) return 1;
        verifyHint();
        return 0;
    }

    if (action === "disable") {
        const failed = await preflight(false);
        if (failed) {
            err(`Falló el preflight, paso «${failed}»`);
            err("No se publicó nada.");
            return 2;
        }
        const epoch = nextEpoch(w.metadata, d.now(), minEpoch);
        const raw = JSON.stringify({ v: 2, activation_epoch: epoch, mode: "disabled" });
        const entry: PublicationEntry = { mode: "disabled", activation_epoch: epoch, state: "publish_failed", published_at: null };
        if (!(await publish(d, w.metadata, entry, raw, "false", cmd))) return 1;
        out(`Estado: configuration_published_pending_deploy. Publicado ${BOOTSTRAP_VAR} en modo disabled (epoch ${epoch}) y ${SECOND_KEY_VAR}=false; borradas las variables legacy.`);
        if (!opts.redeploy) out(`Aplicalo con: vercel deploy --prod (o ${cmd("remote autologin deploy")}).`);
        else if (!(await deploy())) return 1;
        out("No cierra la sesión que el remoto ya tenga abierta: queda hasta que vence o la cerrás en Preferencias → Sesiones del navegador.");
        out("Para volver a habilitarlo hace falta una recuperación nueva (renew), con su propio código.");
        return 0;
    }

    if (action === "status" || action === undefined) {
        const rec = readRecord(w.metadata);
        const last = rec.history?.at(-1) ?? null;
        const exp = last?.mode === "enabled" ? (last.trust_expires_at ?? null) : last ? null : (rec.trust_expires_at ?? null);
        const leftMs = exp ? Date.parse(exp) - d.now().getTime() : null;
        out(
            JSON.stringify(
                {
                    note: "Historial de publicación desde esta PC; NO es el estado vivo del remoto.",
                    live_state: "campus_get_status {verify: true, verify_web: true} en el conector remoto, o el panel /admin/conexion",
                    last_publication: last,
                    last_epoch: rec.last_epoch ?? null,
                    trust_expires_at: exp,
                    trust_days_left: leftMs === null ? null : Math.floor(leftMs / 86_400_000),
                    history: rec.history ?? [],
                    legacy: rec.enabled_at || rec.disabled_at ? { enabled_at: rec.enabled_at ?? null, disabled_at: rec.disabled_at ?? null } : null,
                },
                null,
                2,
            ),
        );
        if (leftMs !== null && leftMs < TRUST_WARN_MS) {
            err(leftMs <= 0 ? "La confianza publicada desde esta PC ya venció." : `La confianza publicada desde esta PC vence en ${Math.floor(leftMs / 86_400_000)} día(s).`);
            err(`Renovala desde el panel (${panel ?? "/admin/conexion"}) o, si el panel no responde, con ${cmd("remote autologin renew")} --redeploy.`);
        }
        return 0;
    }
    throw new CampusError("CONFIG_INVALID", `Uso: ${cliCommand()} remote autologin [renew [--redeploy]|enable|disable|deploy|status] --profile <id>`);
}

/**
 * Publica el sobre como unidad: CAMPUS_WEB_BOOTSTRAP (sensible) y después la segunda llave; recién con
 * ambas cargadas borra las variables legacy (su fallo no rompe la coherencia: con bootstrap presente el
 * servidor las ignora). Si falla una carga, ofrece UN reintento con el MISMO sobre (misma candidata y
 * epoch, idempotente), sin otro login: la candidata vive sólo en memoria de este proceso.
 */
async function publish(d: RemoteAutoLoginDeps, m: MetadataStore, entry: PublicationEntry, raw: string, secondKey: "true" | "false", cmd: (s: string) => string): Promise<boolean> {
    const steps: Array<[string, () => Promise<void>]> = [
        [`carga de ${BOOTSTRAP_VAR}`, () => d.vercelEnvAdd(BOOTSTRAP_VAR, raw, { sensitive: true })],
        [`carga de ${SECOND_KEY_VAR}=${secondKey}`, () => d.vercelEnvAdd(SECOND_KEY_VAR, secondKey, { sensitive: false })],
    ];
    pushHistory(m, entry);
    let i = 0;
    let retried = false;
    while (i < steps.length) {
        const [name, run] = steps[i]!;
        try {
            await run();
            i++;
        } catch (e) {
            d.err(`Falló el paso «${name}» en Vercel: ${toPublicError(e).message}`);
            const state: PublicationState = i === 0 ? "publish_failed" : "publish_incomplete";
            updateLast(m, { state, failed_step: name });
            if (!retried && entry.mode === "enabled") {
                retried = true;
                let again = "";
                try {
                    again = (await d.promptVisible("¿Reintentar la publicación con la misma candidata, sin otro código? [s/N]: ")).trim().toLowerCase();
                } catch {
                    again = "";
                }
                if (again === "s" || again === "si" || again === "sí") {
                    i = 0;
                    continue;
                }
            }
            if (i === 0) d.err("No se publicó la configuración: producción sigue igual que antes.");
            else d.err(`Publicación INCOMPLETA: ${BOOTSTRAP_VAR} quedó cargada pero no ${SECOND_KEY_VAR}=${secondKey}. No despliegues así; repetí el comando (${cmd(entry.mode === "enabled" ? "remote autologin renew" : "remote autologin disable")}).`);
            return false;
        }
    }
    updateLast(m, { state: "configuration_published_pending_deploy", published_at: d.now().toISOString(), failed_step: undefined });
    for (const name of LEGACY_VARS) {
        try {
            await d.vercelEnvRm(name);
        } catch (e) {
            d.err(`Aviso: falló el paso «borrado de ${name}» (legacy): ${toPublicError(e).message} Con ${BOOTSTRAP_VAR} presente el servidor la ignora; borrala cuando puedas: vercel env rm ${name} production`);
        }
    }
    return true;
}

/**
 * `campus remote push-web-session` (retirado en ADR-141): con la conexión v2 el remoto ignora
 * CAMPUS_WEB_SESSION una vez que existe su registro, así que publicar la sesión de la PC no tendría efecto.
 */
export function pushWebSessionRefusal(profileId: string, err: (s: string) => void = (s) => process.stderr.write(`${s}\n`)): number {
    const cmd = (rest: string) => `${cliCommand()} ${rest} --profile ${profileId}`;
    err("remote push-web-session está retirado (ADR-141): el remoto ya no usa CAMPUS_WEB_SESSION una vez creada su conexión v2, así que publicarla no tendría efecto. No se publicó nada.");
    err("Para renovar la conexión del remoto: abrí el panel privado /admin/conexion de tu remoto y apretá «Renovar conexión con el Campus».");
    err(`Si el panel no responde (recuperación desde la PC): ${cmd("remote autologin renew")} --redeploy`);
    return 2;
}
