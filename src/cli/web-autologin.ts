import { CampusError, toPublicError } from "../errors.js";
import type { MetadataStore } from "../session/metadata.js";
import type { SecretStore } from "../session/secret-store.js";
import { cliCommand } from "../util/cli-command.js";
import type { ServerDeps } from "../mcp/server.js";
import type { Logger } from "../util/logger.js";
import {
    AUTOLOGIN_MAX_PER_DAY,
    AUTOLOGIN_MIN_INTERVAL_MS,
    AutoLogin,
    autoLoginStatus,
    forgetAutoLogin,
    loadLogin,
    loadTrust,
    readAutoLoginState,
    saveLogin,
    saveTrust,
    trustExpiry,
    writeAutoLoginState,
} from "../web/autologin.js";
import { windowsCodePrompt } from "../web/code-prompt.js";
import { passwordLogin } from "../web/login.js";
import type { WebSessionSource } from "../web/session.js";
import type { WebTransport } from "../web/transport.js";
import { promptHidden, promptVisible, requireTty } from "./prompt.js";

/** Segunda llave del login web automático: la variable en la entrada del cliente MCP (ADR-088). */
export const AUTOLOGIN_ENV = "CAMPUS_WEB_AUTOLOGIN";

export interface AutoLoginWiring {
    web: WebTransport;
    source: WebSessionSource;
    secrets: SecretStore;
    metadata: MetadataStore;
    profileId: string;
    siteUrl: string;
    logger: Logger;
    /** Para mostrar el estado del login automático en campus_get_status. */
    serverDeps?: ServerDeps;
}

/**
 * Servidores locales (serve, serve-full): habilita el login automático sólo con las dos llaves
 * (variable de entorno y contraseña cargada). Sin la variable no hace nada, ni lee el keyring.
 */
export async function wireAutoLogin(w: AutoLoginWiring, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (env[AUTOLOGIN_ENV] !== "true") return false;
    if (!(await loadLogin(w.secrets, w.profileId, w.siteUrl))) {
        w.logger.log("warn", "web_autologin_unconfigured", { profile_id: w.profileId });
        return false;
    }
    const auto = new AutoLogin({
        transport: w.web,
        secrets: w.secrets,
        metadata: w.metadata,
        profileId: w.profileId,
        siteUrl: w.siteUrl,
        loadSnapshot: () => w.source.load(),
        askCode: windowsCodePrompt(),
        log: (event, fields) => w.logger.log("info", event, { profile_id: w.profileId, ...fields }),
    });
    w.web.setAutoLogin(auto);
    if (w.serverDeps) w.serverDeps.webAutoLoginStatus = () => autoLoginStatus(auto.backend);
    w.logger.log("info", "web_autologin_enabled", { profile_id: w.profileId });
    return true;
}

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

/** `auth web autologin enable|disable|status` (lo corre el humano). */
export async function webAutologinCommand(action: string | undefined, w: AutoLoginWiring): Promise<number> {
    const cmd = (rest: string) => `${cliCommand()} auth web autologin ${rest} --profile ${w.profileId}`;
    if (action === "enable") {
        requireTty();
        out("Login web automático (OPCIONAL, NO RECOMENDADO; ADR-088): guarda tu contraseña del Campus en el almacén seguro del sistema");
        out("para que el MCP local inicie sesión en la web cuando la sesión venció. Usalo sólo si el keepalive no es viable.");
        const username = (await promptVisible("Usuario del Campus: ")).trim();
        const password = await promptHidden("Contraseña (no se muestra): ");
        if (!username || !password) {
            err("Usuario y contraseña son obligatorios. No se guardó nada.");
            return 2;
        }
        out("Iniciando sesión en la web del Campus (un solo intento)...");
        try {
            const r = await passwordLogin(w.web, {
                username,
                password,
                remembered: await loadTrust(w.secrets, w.profileId, w.siteUrl),
                askCode: async () => {
                    out("El Campus te mandó un código de verificación al correo.");
                    return (await promptHidden("Código de 6 dígitos (no se muestra): ")).trim();
                },
            });
            // Recién con el login verificado se guarda la contraseña.
            await saveLogin(w.secrets, w.profileId, w.siteUrl, { username, password });
            await saveTrust(w.secrets, w.profileId, w.siteUrl, r.remembered);
            await w.web.saveSnapshot(r.snapshot);
            const now = new Date().toISOString();
            writeAutoLoginState(w.metadata, { enabled_at: now, disabled: null, attempts: [], last: { at: now, ok: true, mfa: r.mfa }, trust_expires_at: r.trust_expires_at ?? trustExpiry(r.remembered) });
            out(`Listo: sesión web iniciada (userid ${r.snapshot.user_id}, segundo factor: ${r.mfa}).`);
            const exp = r.trust_expires_at ?? trustExpiry(r.remembered);
            out(exp ? `El Campus confía en este MCP como dispositivo hasta ${new Date(exp).toLocaleString("es-AR")}. Después pedirá un código nuevo.` : "Aviso: el Campus no dejó la cookie de dispositivo de confianza; cada login automático podría pedir un código.");
            out(`Segunda llave: agregá ${AUTOLOGIN_ENV}=true en la entrada del cliente MCP (serve o serve-full) y abrí una sesión nueva.`);
            return 0;
        } catch (e) {
            const pe = toPublicError(e);
            err(`No se pudo iniciar sesión: ${pe.code}. ${pe.message}`);
            err("No se guardó la contraseña.");
            return 1;
        }
    }
    if (action === "disable") {
        await forgetAutoLogin(w.secrets, w.metadata, w.profileId, w.siteUrl);
        out("Login web automático desactivado: se borraron la contraseña y las cookies recordadas del almacén seguro.");
        out("No cierra sesiones en el Campus. Corte de emergencia: cambiar la contraseña del Campus (cierra todas las sesiones).");
        return 0;
    }
    if (action === "status" || action === undefined) {
        const s = readAutoLoginState(w.metadata);
        const creds = await loadLogin(w.secrets, w.profileId, w.siteUrl);
        const trust = await loadTrust(w.secrets, w.profileId, w.siteUrl);
        const exp = trustExpiry(trust) ?? s.trust_expires_at ?? null;
        const days = exp ? Math.floor((Date.parse(exp) - Date.now()) / 86_400_000) : null;
        out(
            JSON.stringify(
                {
                    configured: creds !== null,
                    disabled: s.disabled ?? null,
                    trust_expires_at: exp,
                    trust_days_left: days,
                    last: s.last ?? null,
                    attempts_last_24h: (s.attempts ?? []).filter((a) => Date.now() - Date.parse(a) < 86_400_000).length,
                    limits: { min_interval_minutes: AUTOLOGIN_MIN_INTERVAL_MS / 60_000, max_per_day: AUTOLOGIN_MAX_PER_DAY },
                    second_key: `${AUTOLOGIN_ENV}=true en la entrada del cliente MCP`,
                },
                null,
                2,
            ),
        );
        if (s.disabled) err(`Desactivado por un rechazo del Campus. Para volver a cargar la contraseña: ${cmd("enable")}`);
        else if (days !== null && days <= 3) err(`La confianza del dispositivo vence en ${days} día(s): el próximo login pedirá un código (diálogo) o renovalo con ${cmd("enable")}.`);
        return 0;
    }
    throw new CampusError("CONFIG_INVALID", `Uso: ${cliCommand()} auth web autologin [enable|disable|status] --profile <id>`);
}
