#!/usr/bin/env node
import { cliCommand } from "./util/cli-command.js";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp, type App } from "./app.js";
import { defaultDownloadDir } from "./mcp/downloads.js";
import { findRenderer } from "./documents/render.js";
import { requestNativeToken, appSiteCheck } from "./auth/native.js";
import { createLaunch, fetchPublicLoginConfig, TransactionStore } from "./auth/browser.js";
import { handlerCommand, handlerStatus, installHandler, sendCallback, uninstallHandler, waitForCallback } from "./auth/scheme-handler.js";
import { packageRoot } from "./config/profile.js";
import { spawn } from "node:child_process";
import { buildCapabilityReport } from "./capabilities/report.js";
import { promptHidden, promptVisible, requireTty } from "./cli/prompt.js";
import { webAutologinCommand, wireAutoLogin } from "./cli/web-autologin.js";
import { remoteAutologinCommand } from "./cli/remote-autologin.js";
import { loadProfile, type Profile } from "./config/profile.js";
import { CampusError, toPublicError } from "./errors.js";
import { defaultStateDir, FileMetadataStore } from "./session/metadata.js";
import { KeyringSecretStore } from "./session/secret-store.js";
import { encodeSnapshot, KeyringWebSessionSource, parseCookieInput, webSecretAccount, type WebSessionSource } from "./web/session.js";
import { createLogger } from "./util/logger.js";
import { checkWebSession, humanDuration, readWebState, recordCheck, recordPublished, remoteInSync } from "./web/keepalive.js";
import { currentWindowsUser, defaultConhost, installKeepaliveTask, keepaliveArguments, keepaliveTaskStatus, taskName, uninstallKeepaliveTask, validateEvery, type KeepaliveTarget } from "./web/keepalive-task.js";
import type { MetadataStore } from "./session/metadata.js";
import { newSigningSecret, vercelEnvAdd } from "./cli/remote.js";
import { assertWriteServerMayStart, loadWriteProfile } from "./write/policy.js";
import { createWriteApp, writeStateLocation, type WriteApp } from "./write/app.js";
import { resultError } from "./write/engine.js";
import { TerminalApprovalConfirmer } from "./write/confirm.js";

const USAGE = `campus — MCP del Campus Virtual (UdeSA): lecturas y, con el perfil de escritura, escrituras

Uso:
  campus auth login   --profile <id> [--method native|browser] [--replace-identity] [--idp <id>] [--no-open]
  campus auth status  --profile <id> [--verify]
  campus auth logout  --profile <id> --local
  campus diagnose     --profile <id> [--appsitecheck]
  campus serve        --profile <id>
  campus profile check --profile <id>
  campus auth copy    --profile <destino> --from <origen>   # reutiliza el token del keyring sin pedir contraseña
  campus auth handler install|uninstall|status [--scheme udesacampusmcp]   # retorno automático del login con Google (Windows)
  campus auth web import --profile <id>   # sesión web del Campus (cookie MoodleSession) para lecturas que la requieren; entrada oculta o stdin
  campus auth web status --profile <id> [--verify]   # con --verify: renueva y mide el límite de inactividad
  campus auth web keepalive --profile <id> [--quiet]   # mantiene viva la sesión web (una lectura de identidad)
  campus auth web keepalive install|uninstall|status --profile <id> [--every <min>]   # tarea programada de Windows (opcional)
  campus auth web autologin enable|disable|status --profile <id>   # login web automático con contraseña guardada (OPCIONAL, NO RECOMENDADO; ADR-088)
  campus auth web logout --profile <id> --local

Servidor remoto privado (Vercel, ver docs/REMOTO_VERCEL.md):
  campus remote configure  --profile <id> --base-url <https://…> --github-client-id <id> --github-user-id <n>
  campus remote init-secret --profile <id>      # genera OAUTH_SIGNING_SECRET (rotarlo revoca todos los tokens)
  campus remote push-token  --profile <id>      # copia el token Moodle del keyring al proyecto Vercel
  campus remote push-web-session --profile <id> # valida y publica la sesión web local como CAMPUS_WEB_SESSION (sensible)
  campus remote autologin enable|disable|status --profile <id>   # login web automático en Vercel (ADR-127): reusa la contraseña de esta PC y pide un código

Escrituras (perfil de escritura, p. ej. udesa-docente-escritura; ver docs/PROCESOS.md#escrituras):
  campus serve-full    --profile docente-completo   # UN servidor MCP con lecturas + escrituras (ADR-062); exige CAMPUS_WRITE_ENABLED=true
  campus serve-write   --profile <id>   # servidor MCP sólo de escritura; exige además CAMPUS_WRITE_ENABLED=true (doble llave)
  campus write status  --profile <id>
  campus write pending --profile <id>   # planes que esperan confirmación (sólo si el perfil fija un umbral; por defecto "nunca", ADR-061)
  campus write approve <plan_id> --profile <id>   # muestra el plan y pide el código (requiere terminal)
  campus write log     --profile <id> [--since AAAA-MM-DD]
  campus write disable --profile <id>   # interruptor general (las lecturas siguen)
  campus write enable  --profile <id>   # requiere terminal
  campus write resume  --profile <id>   # reactiva tras el freno por fallos (requiere terminal)

Opciones comunes: --profile-file <ruta> en lugar de --profile; --state-dir <ruta> en lugar de CAMPUS_STATE_DIR.
El login lo ejecuta el humano en su propia terminal; las credenciales nunca van por argumentos.`;

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            profile: { type: "string" },
            "profile-file": { type: "string" },
            "state-dir": { type: "string" },
            method: { type: "string" },
            verify: { type: "boolean" },
            local: { type: "boolean" },
            "replace-identity": { type: "boolean" },
            appsitecheck: { type: "boolean" },
            "base-url": { type: "string" },
            "github-client-id": { type: "string" },
            "github-user-id": { type: "string" },
            from: { type: "string" },
            scheme: { type: "string" },
            idp: { type: "string" },
            "no-open": { type: "boolean" },
            every: { type: "string" },
            quiet: { type: "boolean" },
            since: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [cmd, sub, arg] = positionals;
    // Equivale a CAMPUS_STATE_DIR (la tarea programada no puede pasar variables de entorno).
    if (values["state-dir"]) process.env.CAMPUS_STATE_DIR = resolvePath(values["state-dir"]);
    // Comandos sin perfil: el retorno automático (lo invoca Windows) y su instalación.
    if (cmd === "auth" && sub === "callback") return authCallback(values.scheme ?? DEFAULT_SCHEME, arg);
    if (cmd === "auth" && sub === "handler") return authHandler(arg, values.scheme ?? DEFAULT_SCHEME);
    if (values.help || !cmd) {
        out(USAGE);
        return cmd ? 0 : 1;
    }

    if (cmd === "serve-full" || cmd === "serve-write" || cmd === "write") return writeMain(cmd, sub, arg, { profile: values.profile, profileFile: values["profile-file"], since: values.since });

    const profile = loadProfile({ profileId: values.profile, profileFile: values["profile-file"] });
    const logger = createLogger(undefined, process.env.CAMPUS_LOG_LEVEL === "debug" ? "debug" : cmd === "serve" ? "info" : "warn");
    const metadata = new FileMetadataStore(defaultStateDir(), profile.profile_id);
    const webSource = new KeyringWebSessionSource(new KeyringSecretStore(), webSecretAccount(profile.profile_id, profile.site_url));
    const app = createApp({
        profile,
        secrets: new KeyringSecretStore(),
        metadata,
        logger,
        webSource,
        webRenewHint: `Importá una sesión web nueva: ${cliCommand()} auth web import --profile ${profile.profile_id}`,
        downloadDir: defaultDownloadDir(),
        renderer: findRenderer(),
    });

    switch (`${cmd}${sub ? ` ${sub}` : ""}`) {
        case "auth login":
            if ((values.method ?? profile.preferred_auth_method) === "browser") {
                return authLoginBrowser(profile, app, { scheme: values.scheme, idp: values.idp, open: !values["no-open"], replaceIdentity: !!values["replace-identity"] });
            }
            return authLogin(profile, app, values.method ?? profile.preferred_auth_method, !!values["replace-identity"]);
        case "auth copy": {
            if (!values.from) {
                err("Uso: campus auth copy --profile <destino> --from <perfil-origen>");
                return 2;
            }
            const source = loadProfile({ profileId: values.from });
            if (source.site_url !== profile.site_url || source.service !== profile.service) {
                err("Los perfiles deben apuntar al mismo sitio y servicio.");
                return 2;
            }
            const srcApp = createApp({ profile: source, secrets: new KeyringSecretStore(), metadata: new FileMetadataStore(defaultStateDir(), source.profile_id), logger });
            const token = await srcApp.session.getToken();
            const method = new FileMetadataStore(defaultStateDir(), source.profile_id).read()?.auth_method ?? "native";
            // Se valida contra Moodle (sitio + identidad) igual que un login nuevo.
            const identity = await app.session.adoptCandidate(token, method, { replaceIdentity: !!values["replace-identity"] });
            out(`Token copiado de ${source.profile_id} a ${profile.profile_id} y validado: userid ${identity.user_id}. No se mostró ni se pidió la contraseña.`);
            return 0;
        }
        case "auth status": {
            out(JSON.stringify(await app.session.status(!!values.verify), null, 2));
            return 0;
        }
        case "auth logout": {
            if (!values.local) {
                err("Sólo está soportado el borrado local: agregá --local. No se revoca el token en Moodle (podría usarlo también la app oficial).");
                return 2;
            }
            const r = await app.session.logoutLocal();
            out(r.removed_token ? "Token y metadata locales borrados. El token NO fue revocado en Moodle." : "No había token local para este perfil. Metadata local limpiada.");
            return 0;
        }
        case "auth web":
            return authWeb(arg, app, webSource, metadata, profile, { verify: !!values.verify, local: !!values.local, quiet: !!values.quiet, every: values.every, action: positionals[3], profileFile: values["profile-file"] });
        case "diagnose":
            return diagnose(profile, app, metadata, !!values.appsitecheck);
        case "serve": {
            if (app.web) await wireAutoLogin({ web: app.web, source: webSource, secrets: new KeyringSecretStore(), metadata, profileId: profile.profile_id, siteUrl: profile.site_url, logger, serverDeps: app.serverDeps });
            const server = app.server();
            await server.connect(new StdioServerTransport());
            logger.log("info", "server_started", { profile_id: profile.profile_id, read_only: profile.read_only });
            return new Promise<number>(() => {}); // vive mientras el cliente mantenga el STDIO
        }
        case "profile check": {
            out(JSON.stringify({ ok: true, profile_id: profile.profile_id, site_url: profile.site_url, service: profile.service, course_scope: profile.course_scope, allowed_course_ids: profile.allowed_course_ids, excluded_course_ids: profile.excluded_course_ids, state_dir: metadata.location }, null, 2));
            return 0;
        }
        case "remote configure": {
            const base = values["base-url"] ?? "";
            const ghId = values["github-client-id"] ?? "";
            const ghUser = values["github-user-id"] ?? "";
            if (!/^https:\/\/[a-z0-9.-]+$/i.test(base) || !/^[A-Za-z0-9._-]{4,80}$/.test(ghId) || !/^\d+$/.test(ghUser)) {
                err("Uso: campus remote configure --profile <id> --base-url https://<dominio> --github-client-id <id> --github-user-id <número>");
                return 2;
            }
            await vercelEnvAdd("PUBLIC_BASE_URL", base, { sensitive: false });
            await vercelEnvAdd("GITHUB_CLIENT_ID", ghId, { sensitive: false });
            await vercelEnvAdd("GITHUB_ALLOWED_USER_ID", ghUser, { sensitive: false });
            out("Cargadas PUBLIC_BASE_URL, GITHUB_CLIENT_ID y GITHUB_ALLOWED_USER_ID (production). Falta GITHUB_CLIENT_SECRET: vercel env add GITHUB_CLIENT_SECRET production --sensitive");
            return 0;
        }
        case "remote init-secret": {
            await vercelEnvAdd("OAUTH_SIGNING_SECRET", newSigningSecret(), { sensitive: true });
            out("OAUTH_SIGNING_SECRET generado y cargado como sensible (no se muestra). Rotarlo invalida todas las conexiones existentes. Aplicalo con: vercel --prod");
            return 0;
        }
        case "remote push-token": {
            // Se valida contra Moodle antes de copiarlo: no se sube un token vencido.
            const site = await app.session.verify();
            const token = await app.session.getToken();
            await vercelEnvAdd("CAMPUS_MOODLE_TOKEN", token, { sensitive: true });
            await vercelEnvAdd("CAMPUS_EXPECTED_USERID", String(site.info.userid), { sensitive: false });
            out("Token Moodle validado y cargado como variable sensible (no se muestra), junto con CAMPUS_EXPECTED_USERID. Aplicalo con: vercel --prod");
            return 0;
        }
        case "remote autologin":
            return remoteAutologinCommand(arg, { profile, app, secrets: new KeyringSecretStore(), metadata, logger });
        case "remote push-web-session": {
            if (!app.web) throw new CampusError("CONFIG_INVALID", "Sesión web no disponible.");
            // Se valida identidad y vigencia antes de publicar; una rotación validada se persiste primero.
            const op = await app.web.open();
            await app.web.afterOperation(op);
            const snap = await webSource.load();
            if (!snap) throw new CampusError("AUTH_REQUIRED", "No hay sesión web local para publicar.");
            await vercelEnvAdd("CAMPUS_WEB_SESSION", encodeSnapshot(snap), { sensitive: true });
            recordPublished(metadata, snap.revision, new Date());
            out(`Sesión web validada (userid ${snap.user_id}, revisión ${snap.revision}) y cargada como CAMPUS_WEB_SESSION sensible (no se muestra). Aplicala con: vercel deploy --prod`);
            out("Cada invocación remota parte de ese snapshot. Si el Campus rota o cierra la sesión, hay que volver a importarla y publicarla. Para que no venza por inactividad: campus auth web keepalive.");
            return 0;
        }
        default:
            err(`Comando desconocido: ${positionals.join(" ")}\n\n${USAGE}`);
            return 2;
    }
}

async function authLogin(profile: Profile, app: App, method: string, replaceIdentity: boolean): Promise<number> {
    if (method !== "native") throw new CampusError("CONFIG_INVALID", "--method debe ser native o browser.");
    requireTty();
    // AUTH-07: si no hay keyring, se aborta antes de pedir la contraseña.
    await app.session.probeSecretStore();
    err(`Login nativo en ${profile.site_url} (servicio ${profile.service}).`);
    err("La contraseña se envía una sola vez a login/token.php y no se guarda.");
    const username = (await promptVisible("Usuario del Campus: ")).trim();
    let password = await promptHidden("Contraseña (no se muestra): ");
    let candidate: string;
    try {
        candidate = await requestNativeToken(profile, { username, password });
    } finally {
        password = "";
    }
    const identity = await app.session.adoptCandidate(candidate, "native", { replaceIdentity });
    out(`Sesión validada: userid ${identity.user_id} en ${identity.site_url} (método native). Token guardado en el almacén seguro del sistema.`);
    out(`Siguiente paso: ${cliCommand()} diagnose --profile ${profile.profile_id}`);
    return 0;
}

/**
 * Método browser (Google institucional u otro proveedor del Campus), con importador manual del
 * retorno: el humano completa el login en su navegador normal y pega el retorno en esta terminal
 * con entrada oculta. No se lee ni se intercepta nada de Google; no se registra ningún esquema.
 */
async function authLoginBrowser(profile: Profile, app: App, opts: { scheme?: string; idp?: string; open: boolean; replaceIdentity: boolean }): Promise<number> {
    requireTty();
    await app.session.probeSecretStore();
    const cfg = await fetchPublicLoginConfig(profile);
    let idp = cfg.identity_providers[0];
    if (opts.idp) idp = cfg.identity_providers.find((p) => String(p.id) === opts.idp);
    if (!idp) {
        err(`No se encontró el proveedor de identidad${opts.idp ? ` ${opts.idp}` : ""}. Disponibles: ${cfg.identity_providers.map((p) => `${p.id} (${p.name})`).join(", ") || "ninguno"}.`);
        return 2;
    }
    const store = new TransactionStore();
    const { transaction, launch_url } = createLaunch(profile, { urlscheme: opts.scheme ?? "udesacampusmcp", ttlMs: 10 * 60_000, oauthssoId: idp.id, showLaunchPage: true });
    store.add(transaction);
    err(`Login por navegador en ${profile.site_url} con «${idp.name}» (proveedor ${idp.id}).`);
    const scheme = transaction.urlscheme;
    const expected = handlerCommand(process.execPath, cliEntry(), scheme);
    const installed = await handlerStatus(scheme).catch(() => null);
    const auto = installed !== null && installed === expected;
    if (installed !== null && !auto) err("Aviso: el esquema está registrado con otra ruta (¿se movió el proyecto o cambió Node?). Reinstalalo: campus auth handler install");
    err("1) Se abre tu navegador. Completá el login con Google como siempre. No uses F5 ni vuelvas atrás.");
    err("2) Al final vas a ver una página del Campus «Registro confirmado» con un enlace azul «Haga clic aquí si la aplicación no se abre…».");
    if (auto) {
        // Chrome no abre un esquema externo sin un clic real del usuario: el clic automático de la página se bloquea.
        err("   RETORNO AUTOMÁTICO ACTIVO: hacé CLIC (izquierdo) en ese enlace azul. El navegador pregunta si abrir una aplicación externa");
        err("   (puede figurar como Node.js o node.exe): tocá «Abrir» (podés marcar «Permitir siempre»). Aparece un instante una ventana y esta terminal sigue sola.");
        err("   Si no pregunta o no avanza: clic derecho en el enlace → «Copiar dirección del enlace» y pegalo acá abajo.");
    } else {
        err("   Clic derecho sobre ese enlace → «Copiar dirección del enlace». Empieza con «udesacampusmcp://token=» o «moodlemobile://token=».");
        err("   Si Windows ofrece abrir la app de Moodle, cancelá: el enlace sigue en la página.");
        err("   (Para que vuelva solo, sin copiar y pegar: campus auth handler install)");
    }
    err("3) Si lo pegás: acá abajo (no se muestra). No lo pegues en chats, issues ni capturas: contiene un token.");
    err(`Enlace de inicio (no tiene secretos; vence en 10 minutos): ${launch_url}`);
    if (opts.open) {
        // Sin shell: la URL no se interpreta como comando.
        spawn(process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open", process.platform === "win32" ? ["url.dll,FileProtocolHandler", launch_url] : [launch_url], {
            detached: true,
            stdio: "ignore",
        }).unref();
    }
    const ctrl = new AbortController();
    const viaChannel = auto
        ? waitForCallback(scheme, ctrl.signal).then((u) => ({ source: "automático" as const, raw: u }))
        : new Promise<never>(() => {});
    if (auto) viaChannel.catch(() => {});
    const viaPrompt = promptHidden("Retorno (no se muestra): ", ctrl.signal).then((u) => ({ source: "pegado" as const, raw: u }));
    viaPrompt.catch(() => {});
    const winner = await Promise.race([viaChannel, viaPrompt]);
    ctrl.abort();
    if (winner.source === "automático") err("Retorno recibido automáticamente desde el navegador.");
    let raw = winner.raw;
    let consumed;
    try {
        consumed = store.consume(raw.trim(), { profile_id: profile.profile_id, site_url: profile.site_url }, Date.now(), { acceptForcedScheme: true });
    } finally {
        raw = "";
    }
    const identity = await app.session.adoptCandidate(consumed.token, "browser", { replaceIdentity: opts.replaceIdentity });
    out(`Sesión validada por navegador: userid ${identity.user_id} en ${identity.site_url} (método browser, proveedor ${idp.id}, retorno ${winner.source}).`);
    if (consumed.forced_scheme) {
        out(`El Campus forzó el esquema «moodlemobile» (pedimos «${transaction.urlscheme}»): el retorno automático no es posible sin tocar la app oficial; seguí pegando el enlace.`);
    } else if (!auto) {
        out(`Para que el retorno vuelva solo la próxima vez: campus auth handler install`);
    }
    return 0;
}

const DEFAULT_SCHEME = "udesacampusmcp";

function cliEntry(): string {
    return join(packageRoot(), "build", "cli.js");
}

/**
 * Lo ejecuta Windows al abrirse `<esquema>://token=…`. Entrega el enlace al login que espera y
 * termina. Nunca imprime, guarda ni loguea el enlace.
 */
async function authCallback(scheme: string, url: string | undefined): Promise<number> {
    const pause = () => new Promise((r) => setTimeout(r, 2500));
    if (!url || !url.toLowerCase().startsWith(`${scheme}://`)) {
        err("UdeSA Campus MCP: retorno inválido; no se procesó.");
        await pause();
        return 2;
    }
    try {
        await sendCallback(scheme, url);
        out("UdeSA Campus MCP: retorno entregado a la terminal. Podés cerrar esta ventana y la pestaña del navegador.");
        await pause();
        return 0;
    } catch (e) {
        err(`UdeSA Campus MCP: ${toPublicError(e).message} Si el login sigue abierto, copiá el enlace de la página «Confirmado» y pegalo en la terminal.`);
        await pause();
        return 3;
    }
}

/** Lee todo stdin (cuando no es una terminal): permite `campus auth web import < cookie.txt`. */
async function readStdin(maxBytes = 8192): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of process.stdin) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
        total += b.byteLength;
        if (total > maxBytes) throw new CampusError("CONFIG_INVALID", "La entrada es demasiado larga para una cookie de sesión.");
        chunks.push(b);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * Sesión web del Campus (directiva §5). La cookie la copia el humano de su navegador y la pega
 * acá, oculta o por stdin; nunca por argumentos ni en el chat. Se valida (identidad + vigencia)
 * antes de guardarla en el keyring; si el Campus la rota, se guarda la versión rotada.
 */
interface AuthWebOptions {
    verify: boolean;
    local: boolean;
    quiet: boolean;
    every: string | undefined;
    /** Subacción de keepalive: install | uninstall | status. */
    action: string | undefined;
    /** `--profile-file` del comando: la tarea programada usa el mismo. */
    profileFile: string | undefined;
}

/** Perfil y estado del comando actual, para que la tarea programada use los mismos. */
function keepaliveTarget(profile: Profile, o: AuthWebOptions): KeepaliveTarget {
    return {
        profileId: profile.profile_id,
        ...(o.profileFile ? { profileFile: resolvePath(o.profileFile) } : {}),
        ...(process.env.CAMPUS_STATE_DIR ? { stateDir: resolvePath(process.env.CAMPUS_STATE_DIR) } : {}),
    };
}

/** Antigüedad de la última verificación y si es vieja para el intervalo de la tarea. */
function checkAge(lastCheckAt: string | undefined, everyMinutes: number | null, now = Date.now()) {
    if (!lastCheckAt) return { age_minutes: null, stale: null };
    const age = Math.round((now - Date.parse(lastCheckAt)) / 60_000);
    return { age_minutes: age, stale: everyMinutes === null ? null : age > everyMinutes * 2 + 5 };
}

async function authWeb(action: string | undefined, app: App, source: WebSessionSource, metadata: MetadataStore, profile: Profile, o: AuthWebOptions): Promise<number> {
    if (!app.web) throw new CampusError("CONFIG_INVALID", "Sesión web no disponible.");
    const web = app.web;
    const { verify, local } = o;
    if (action === "import") {
        const raw = process.stdin.isTTY
            ? await promptHidden("Cookie MoodleSession del Campus (o la cabecera Cookie completa; no se muestra): ")
            : await readStdin();
        const cookies = parseCookieInput(raw);
        const snapshot = await app.web.validateImport(cookies, new Date());
        await source.save(snapshot);
        out(`Sesión web validada y guardada en el almacén seguro: userid ${snapshot.user_id}, ${snapshot.cookies.length} cookie(s) de Moodle, revisión ${snapshot.revision}.`);
        out("Dura lo que dure esa sesión en el Campus: vence por inactividad o si cerrás sesión en ese navegador. Para mantenerla viva: campus auth web keepalive.");
        const state = readWebState(metadata);
        if (state.published_revision && state.published_revision !== snapshot.revision) out("El remoto tiene otra sesión publicada: si lo usás, corré campus remote push-web-session y vercel deploy --prod.");
        return 0;
    }
    if (action === "status") {
        const snap = await source.load();
        const state = readWebState(metadata);
        const remote = { published_revision: state.published_revision ?? null, published_at: state.published_at ?? null };
        const base = snap
            ? { present: true, user_id: snap.user_id, revision: snap.revision, imported_at: snap.imported_at, cookie_names: snap.cookies.map((c) => c.name), remote: { ...remote, in_sync: remoteInSync(state, snap.revision) }, last_check: state.last_check ?? null }
            : { present: false, remote, last_check: state.last_check ?? null };
        if (snap && verify) {
            // Verificar también renueva la sesión (cualquier petición autenticada lo hace).
            try {
                const c = await checkWebSession(web);
                recordCheck(metadata, "status", c);
                const { last_check: _prev, ...rest } = base;
                out(
                    JSON.stringify(
                        {
                            ...rest,
                            revision: c.revision,
                            remote: { ...remote, in_sync: remoteInSync(state, c.revision) },
                            verified: true,
                            renewed_at: c.checked_at,
                            inactivity_limit_seconds: c.inactivity_limit_seconds,
                            expires_if_idle_at: c.expires_if_idle_at,
                            warnings: c.warnings,
                        },
                        null,
                        2,
                    ),
                );
            } catch (e) {
                recordCheck(metadata, "status", { error: e, at: new Date() });
                out(JSON.stringify({ ...base, verified: false, error: toPublicError(e).code }, null, 2));
            }
            return 0;
        }
        out(JSON.stringify(base, null, 2));
        return 0;
    }
    if (action === "logout") {
        if (!local) {
            err("Agregá --local: sólo se borra la copia local. No cierra la sesión en el navegador.");
            return 2;
        }
        await source.invalidate();
        out("Sesión web local borrada. La sesión del navegador sigue abierta hasta que cierres sesión en el Campus.");
        return 0;
    }
    if (action === "keepalive") return webKeepalive(web, metadata, profile, o);
    if (action === "autologin") {
        return webAutologinCommand(o.action, { web, source, secrets: new KeyringSecretStore(), metadata, profileId: profile.profile_id, siteUrl: profile.site_url, logger: { log: () => {} } });
    }
    err("Uso: campus auth web import|status|logout|keepalive|autologin --profile <id> [--verify] [--local] [--quiet]");
    return 2;
}

/** Una lectura de identidad que renueva la sesión, más la medición del tiempo restante. */
async function keepaliveOnce(web: NonNullable<App["web"]>, metadata: MetadataStore, quiet: boolean): Promise<number> {
    const state = readWebState(metadata);
    try {
        const c = await checkWebSession(web);
        recordCheck(metadata, "keepalive", c);
        if (!quiet) {
            const when = c.expires_if_idle_at ? new Date(c.expires_if_idle_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : null;
            out(c.inactivity_limit_seconds === null ? "Sesión web viva y renovada (no se pudo medir el límite de inactividad)." : `Sesión web viva y renovada: vence tras ${humanDuration(c.inactivity_limit_seconds)} sin uso (${when} si nadie la usa).`);
            for (const w of c.warnings) err(`Aviso: ${w}`);
        }
        if (remoteInSync(state, c.revision) === false) {
            err("La cookie local cambió desde la última publicación: el remoto usa otra. Corré campus remote push-web-session y vercel deploy --prod.");
        }
        return 0;
    } catch (e) {
        recordCheck(metadata, "keepalive", { error: e, at: new Date() });
        const pe = toPublicError(e);
        const what = pe.details?.component === "mobile_token" ? "Token del servicio móvil no disponible (la sesión web no se probó)" : "Sesión web no disponible";
        err(`${what}: ${pe.code}. ${pe.human_action ?? ""}`.trim());
        return 1;
    }
}

async function webKeepalive(web: NonNullable<App["web"]>, metadata: MetadataStore, profile: Profile, o: AuthWebOptions): Promise<number> {
    const cli = cliEntry();
    if (o.action === undefined) return keepaliveOnce(web, metadata, o.quiet);
    if (o.action === "install") {
        const every = validateEvery(o.every);
        // Se instala sólo con una sesión válida y con un intervalo holgado respecto del límite medido.
        const c = await checkWebSession(web);
        recordCheck(metadata, "keepalive", c);
        if (c.inactivity_limit_seconds !== null && every * 60 > c.inactivity_limit_seconds * 0.6) {
            err(`El Campus cierra la sesión tras ${humanDuration(c.inactivity_limit_seconds)} sin uso: elegí un intervalo menor con --every (como mucho ${Math.max(1, Math.floor((c.inactivity_limit_seconds * 0.6) / 60))} min).`);
            return 2;
        }
        await installKeepaliveTask({ nodePath: process.execPath, cliPath: cli, target: keepaliveTarget(profile, o), everyMinutes: every, user: currentWindowsUser(), conhostPath: defaultConhost(), start: new Date() });
        out(`Tarea programada «${taskName(profile.profile_id)}» creada para tu usuario de Windows: cada ${every} min y al iniciar sesión, sin ventana.`);
        if (c.inactivity_limit_seconds !== null) out(`Límite de inactividad del Campus: ${humanDuration(c.inactivity_limit_seconds)}.`);
        out("Corre sólo con tu sesión de Windows iniciada y la PC encendida. Última ejecución: campus auth web status. Para quitarla: campus auth web keepalive uninstall.");
        return 0;
    }
    if (o.action === "uninstall") {
        out((await uninstallKeepaliveTask(profile.profile_id)) ? `Tarea «${taskName(profile.profile_id)}» eliminada.` : `La tarea «${taskName(profile.profile_id)}» no estaba instalada.`);
        return 0;
    }
    if (o.action === "status") {
        const t = await keepaliveTaskStatus(profile.profile_id);
        const expected = keepaliveArguments(process.execPath, cli, keepaliveTarget(profile, o));
        const state = readWebState(metadata);
        const age = checkAge(state.last_check?.at, t?.every_minutes ?? null);
        out(JSON.stringify({ task: taskName(profile.profile_id), installed: t !== null, current: t ? t.arguments === expected : null, every_minutes: t?.every_minutes ?? null, enabled: t?.enabled ?? null, last_check: state.last_check ?? null, last_check_age_minutes: age.age_minutes, last_check_stale: t ? age.stale : null }, null, 2));
        if (t && t.arguments !== expected) err("La tarea apunta a otra ruta, perfil o directorio de estado (¿se movió el proyecto o cambió Node?). Reinstalala: campus auth web keepalive install.");
        if (t && age.stale) err(`La última verificación es de hace ${humanDuration(age.age_minutes! * 60)}: la tarea no está corriendo (¿PC apagada, sesión de Windows cerrada o tarea deshabilitada?).`);
        if (state.last_check && !state.last_check.ok) err(`La última verificación falló (${state.last_check.code ?? "error"}).`);
        return 0;
    }
    err("Uso: campus auth web keepalive [install|uninstall|status] --profile <id> [--every <min>] [--quiet]");
    return 2;
}

async function authHandler(action: string | undefined, scheme: string): Promise<number> {
    const cli = cliEntry();
    if (action === "install") {
        await installHandler(scheme, process.execPath, cli);
        out(`Esquema «${scheme}» registrado para tu usuario de Windows (HKCU\\Software\\Classes\\${scheme}).`);
        out(`Abre: ${handlerCommand(process.execPath, cli, scheme)}`);
        out("Para quitarlo: campus auth handler uninstall");
        return 0;
    }
    if (action === "uninstall") {
        out((await uninstallHandler(scheme)) ? `Esquema «${scheme}» eliminado del registro de tu usuario.` : `El esquema «${scheme}» no estaba registrado.`);
        return 0;
    }
    if (action === "status") {
        const cur = await handlerStatus(scheme);
        const expected = handlerCommand(process.execPath, cli, scheme);
        out(cur === null ? `El esquema «${scheme}» no está registrado.` : cur === expected ? `Esquema «${scheme}» registrado y vigente.` : `Esquema «${scheme}» registrado con otra ruta: ${cur}\nReinstalalo con: campus auth handler install`);
        return 0;
    }
    err("Uso: campus auth handler install|uninstall|status [--scheme <esquema>]");
    return 2;
}

async function diagnose(profile: Profile, app: App, metadata: FileMetadataStore, withAppSiteCheck: boolean): Promise<number> {
    const lines: string[] = [];
    if (withAppSiteCheck) {
        try {
            const r = await appSiteCheck(profile);
            lines.push(`appsitecheck (pista sin autenticar; no prueba el servicio ni permisos): ${r.result}${r.errorcode ? ` (${r.errorcode})` : ""}`);
        } catch (e) {
            lines.push(`appsitecheck: ${toPublicError(e).code}`);
        }
    }
    const status = await app.session.status(false);
    if (!status.authenticated) {
        lines.push(`Sin sesión: ${status.notes.join(" ") || "no hay token guardado."}`);
        lines.push(`Para continuar: ${cliCommand()} auth login --profile ${profile.profile_id} --method native`);
        out(lines.join("\n"));
        return 4;
    }
    let site;
    try {
        site = await app.session.verify();
        app.recorder.record("session_identity", "allowed", null);
        lines.push(`Identidad verificada: userid ${site.info.userid} en ${profile.site_url}. Moodle ${site.info.release ?? "(release no informada)"}.`);
        lines.push(`Funciones anunciadas por el servicio: ${site.info.functions?.length ?? "desconocido"}.`);
    } catch (e) {
        const pub = toPublicError(e);
        lines.push(`No se pudo verificar el token: ${pub.code} — ${pub.message}`);
        if (pub.human_action) lines.push(pub.human_action);
        out(lines.join("\n"));
        return 5;
    }

    const step = async (label: string, fn: () => Promise<string>) => {
        try {
            lines.push(`✔ ${label}: ${await fn()}`);
        } catch (e) {
            const pub = toPublicError(e);
            lines.push(`✘ ${label}: ${pub.code} — ${pub.message}`);
        }
    };
    await step("Cursos de la cuenta (filtrados por allowlist)", async () => {
        const r = await app.service.listCourses();
        return `${r.data.map((c) => `${c.course_id} ${c.shortname ?? ""}`.trim()).join(", ") || "ninguno"}${r.warnings.length > 1 ? ` — ${r.warnings.slice(1).join(" ")}` : ""}`;
    });
    let courseIds: number[] = [];
    try {
        courseIds = await app.scope.allowedIds();
    } catch (e) {
        lines.push(`✘ Alcance de cursos: ${toPublicError(e).code}`);
    }
    for (const courseId of courseIds) {
        await step(`Estructura del curso ${courseId}`, async () => {
            const r = await app.service.getCourse(courseId);
            const t = r.data.totals;
            return `${t.sections} secciones${t.subsections ? ` y ${t.subsections} subsecciones` : ""}, ${t.modules} módulos.`;
        });
        await step(`Foros del curso ${courseId}`, async () => {
            const r = await app.service.listForums(courseId);
            const a = r.data.announcement_forum;
            if (a.forum_id === null) app.recorder.record("read_forums", "inconclusive", courseId, "AMBIGUOUS_RESOURCE");
            return `${r.data.forums.length} foros; Avisos: ${a.status}${a.forum_id ? ` (forum_id ${a.forum_id})` : ""} — ${a.evidence}`;
        });
        await step(`Avisos recientes del curso ${courseId} (sólo títulos, para comparar con la web)`, async () => {
            const r = await app.service.listAnnouncements({ course_id: courseId, limit: 3 });
            const titles = r.data.announcements.map((a) => `«${a.subject}» (${a.dates.created?.local ?? "sin fecha"})`);
            return `${titles.join("; ") || "sin avisos en la primera página"}. Cobertura: ${r.coverage.complete ? "completa" : "parcial"}.`;
        });
    }
    const report = buildCapabilityReport(profile, site, app.recorder, [], courseIds);
    metadata.writeJson("capability-report.json", report);
    lines.push(`Reporte de capacidades saneado guardado en ${join(metadata.location, "capability-report.json")} (sin username ni contenido de avisos).`);
    lines.push("Efectos: sólo lecturas académicas; Moodle puede registrar accesos en sus logs.");
    out(lines.join("\n"));
    return 0;
}

/**
 * Modo escritura (directiva de escrituras, W0). Usa el perfil de escritura, que referencia a un
 * perfil de lectura (mismo token y sesión web). El estado (planes, auditoría, interruptor) vive en
 * el directorio del perfil de escritura.
 */
async function writeMain(cmd: string, sub: string | undefined, arg: string | undefined, o: { profile?: string; profileFile?: string; since?: string }): Promise<number> {
    const wp = loadWriteProfile({ profileId: o.profile, profileFile: o.profileFile });
    const logger = createLogger(undefined, process.env.CAMPUS_LOG_LEVEL === "debug" ? "debug" : cmd.startsWith("serve-") ? "info" : "warn");
    const stateDir = defaultStateDir();
    const secrets = new KeyringSecretStore();
    const rp = wp.read_profile;
    const readMetadata = new FileMetadataStore(stateDir, rp.profile_id);
    const webSource = new KeyringWebSessionSource(secrets, webSecretAccount(rp.profile_id, rp.site_url));
    const app = createWriteApp({
        profile: wp,
        secrets,
        metadata: readMetadata,
        logger,
        location: writeStateLocation(stateDir, wp.profile_id),
        webSource,
        webRenewHint: `Importá una sesión web nueva: ${cliCommand()} auth web import --profile ${rp.profile_id}`,
        downloadDir: defaultDownloadDir(),
        renderer: findRenderer(),
    });
    if (cmd === "serve-write" || cmd === "serve-full") {
        assertWriteServerMayStart(wp);
        // Mismo login automático que el servidor de lectura: sesión, contraseña y estado del perfil de lectura.
        if (app.read.web) await wireAutoLogin({ web: app.read.web, source: webSource, secrets, metadata: readMetadata, profileId: rp.profile_id, siteUrl: rp.site_url, logger, serverDeps: app.read.serverDeps });
        const server = cmd === "serve-full" ? app.fullServer() : app.server();
        await server.connect(new StdioServerTransport());
        logger.log("info", "write_server_started", { profile_id: wp.profile_id, read_profile: rp.profile_id, intents: [...app.intents.keys()] });
        return new Promise<number>(() => {});
    }
    const human = () => {
        if (!process.stdin.isTTY) throw new CampusError("CONFIRMATION_REQUIRED", "Este comando necesita una terminal interactiva: lo corre el humano, no un agente.");
    };
    switch (sub) {
        case "status":
            out(JSON.stringify(await app.engine.status(), null, 2));
            return 0;
        case "pending": {
            const plans = await app.engine.pending();
            if (!plans.length) out("No hay planes pendientes de confirmación.");
            for (const p of plans) out(`${p.plan_id}  código ${p.confirmation_code}  ${p.risk}  curso ${p.course_id}  vence ${p.expires_at}
  ${p.summary}`);
            return 0;
        }
        case "approve":
            return writeApprove(app, arg, human);
        case "log":
            out(JSON.stringify(await app.engine.listActions(o.since), null, 2));
            return 0;
        case "disable":
            await app.engine.setSwitch(true, "cli");
            out("Escrituras DESHABILITADAS. Las lecturas siguen. Para reactivarlas: campus write enable");
            return 0;
        case "enable":
        case "resume": {
            human();
            const word = sub === "enable" ? "HABILITAR" : "REANUDAR";
            if ((await promptVisible(`Escribí ${word} para confirmar: `)).trim() !== word) {
                err("No se cambió nada.");
                return 1;
            }
            if (sub === "enable") await app.engine.setSwitch(false, "cli");
            else await app.engine.resume("cli");
            out(sub === "enable" ? "Escrituras habilitadas (sigue valiendo la doble llave del servidor)." : "Freno liberado: contador de fallos en cero.");
            return 0;
        }
        default:
            err(`Uso: campus write status|pending|approve <plan_id>|log|disable|enable|resume --profile <perfil de escritura>`);
            return 2;
    }
}

/** Aprobación por terminal: muestra el plan completo y pide el código; la aprobación queda atada al hash mostrado. */
async function writeApprove(app: WriteApp, planId: string | undefined, human: () => void): Promise<number> {
    human();
    if (!planId) {
        err("Uso: campus write approve <plan_id> --profile <perfil de escritura>");
        return 2;
    }
    const view = await app.engine.approvalView(planId);
    err("=".repeat(72));
    err(view.text);
    err("=".repeat(72));
    if ((await promptVisible(`Para APROBAR y ejecutar, escribí el código ${view.code} (cualquier otra cosa no aprueba): `)).trim().toUpperCase() !== view.code) {
        err("No aprobado. No se escribió nada.");
        return 1;
    }
    if (view.risk === "R4" && (await promptVisible("Riesgo R4: escribí CONFIRMO R4 para la segunda confirmación: ")).trim() !== "CONFIRMO R4") {
        err("No aprobado. No se escribió nada.");
        return 1;
    }
    const result = await app.engine.execute(planId, new TerminalApprovalConfirmer(view.plan_hash), "local:terminal");
    out(JSON.stringify(result, null, 2));
    const e = resultError(result);
    if (e) {
        err(`${e.code}: ${e.message}`);
        return 1;
    }
    return 0;
}

main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (e) => {
        const pub = toPublicError(e);
        err(`Error ${pub.code}: ${pub.message}`);
        if (pub.human_action) err(pub.human_action);
        process.exitCode = 1;
    },
);
