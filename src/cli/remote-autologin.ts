import type { App } from "../app.js";
import type { Profile } from "../config/profile.js";
import { CampusError, toPublicError } from "../errors.js";
import type { MetadataStore } from "../session/metadata.js";
import type { SecretStore } from "../session/secret-store.js";
import { cliCommand } from "../util/cli-command.js";
import type { Logger } from "../util/logger.js";
import { loadLogin, loadTrust, trustExpiry } from "../web/autologin.js";
import { recordPublished } from "../web/keepalive.js";
import { passwordLogin, TRUST_COOKIE } from "../web/login.js";
import { encodeSnapshot, MemoryWebSessionSource } from "../web/session.js";
import { WebTransport, webUserAgent } from "../web/transport.js";
import { promptHidden, requireTty } from "./prompt.js";
import { vercelEnvAdd, vercelEnvRm } from "./remote.js";

/**
 * `campus remote autologin enable|disable|status` (ADR-127). Lo corre el humano en su PC.
 *
 * `enable` reusa la contraseña del login automático local (keyring) y hace UN login nuevo que pide el
 * código del correo: así el remoto tiene su propio dispositivo de confianza («remoto»), que no pisa
 * ni comparte el de la PC. Recién con el login verificado publica en Vercel, como variables
 * sensibles, la contraseña (CAMPUS_WEB_LOGIN), la confianza (CAMPUS_WEB_TRUST) y la sesión resultante
 * (CAMPUS_WEB_SESSION), más la segunda llave CAMPUS_WEB_AUTOLOGIN=true. Después hay que redesplegar.
 */

const STATE_FILE = "remote-autologin.json";
const VARS = ["CAMPUS_WEB_AUTOLOGIN", "CAMPUS_WEB_LOGIN", "CAMPUS_WEB_TRUST"] as const;

interface RemoteAutoLoginRecord {
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

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export async function remoteAutologinCommand(action: string | undefined, w: RemoteAutoLoginWiring): Promise<number> {
    const p = w.profile;
    const cmd = (rest: string) => `${cliCommand()} ${rest} --profile ${p.profile_id}`;
    if (action === "enable") {
        requireTty();
        const creds = await loadLogin(w.secrets, p.profile_id, p.site_url);
        if (!creds) {
            err(`No hay contraseña guardada en esta PC. Activá primero el login automático local (${cmd("auth web autologin enable")}): el remoto reusa esa contraseña.`);
            return 2;
        }
        // De la PC sólo se reusa MOODLEID1_ (evita el aviso de «nuevo inicio»); la confianza del remoto es propia.
        const remembered = (await loadTrust(w.secrets, p.profile_id, p.site_url)).filter((c) => !TRUST_COOKIE.test(c.name));
        const web = new WebTransport({
            siteUrl: p.site_url,
            source: new MemoryWebSessionSource(),
            expectedUserId: async () => (await w.app.session.verified()).info.userid,
            logger: w.logger,
            timeoutMs: p.limits.http_timeout_seconds * 1000,
            renewHint: "",
            userAgent: webUserAgent("remoto"),
        });
        out("Login web automático en el servidor remoto (ADR-127). Se hace UN login con tu contraseña guardada en esta PC,");
        out("como dispositivo «remoto»: el Campus te va a mandar un código al correo. Ese dispositivo de confianza es sólo del remoto.");
        out("Si el correo trae un enlace para avisar que no fuiste vos, NO lo uses: revoca el factor de toda la cuenta (ADR-121).");
        let r;
        try {
            r = await passwordLogin(web, {
                username: creds.username,
                password: creds.password,
                remembered,
                askCode: async () => {
                    out("El Campus te mandó un código de verificación al correo.");
                    return (await promptHidden("Código de 6 dígitos (no se muestra): ")).trim();
                },
            });
        } catch (e) {
            const pe = toPublicError(e);
            err(`No se pudo iniciar sesión: ${pe.code}. ${pe.message}`);
            err("No se publicó nada en Vercel.");
            return 1;
        }
        const trustExp = r.trust_expires_at ?? trustExpiry(r.remembered);
        if (!r.remembered.some((c) => TRUST_COOKIE.test(c.name)) || !trustExp) {
            // Sin confianza, el remoto no puede iniciar sesión solo (no tiene canal para el código).
            err("El Campus no dejó la cookie de dispositivo de confianza: el remoto no podría iniciar sesión sin código. No se publicó nada.");
            return 1;
        }
        try {
            await vercelEnvAdd("CAMPUS_WEB_LOGIN", JSON.stringify(creds), { sensitive: true });
            await vercelEnvAdd("CAMPUS_WEB_TRUST", JSON.stringify(r.remembered), { sensitive: true });
            await vercelEnvAdd("CAMPUS_WEB_SESSION", encodeSnapshot(r.snapshot), { sensitive: true });
            await vercelEnvAdd("CAMPUS_WEB_AUTOLOGIN", "true", { sensitive: false });
        } catch (e) {
            const pe = toPublicError(e);
            err(`Falló la carga en Vercel: ${pe.message}`);
            err(`Puede haber quedado a medias: corré ${cmd("remote autologin disable")} o repetí enable.`);
            return 1;
        }
        const now = new Date();
        recordPublished(w.metadata, r.snapshot.revision, now);
        w.metadata.writeJson(STATE_FILE, { enabled_at: now.toISOString(), trust_expires_at: trustExp } satisfies RemoteAutoLoginRecord);
        out(`Listo: sesión remota iniciada (userid ${r.snapshot.user_id}, segundo factor: ${r.mfa}).`);
        out(`El Campus confía en el dispositivo «remoto» hasta ${new Date(trustExp).toLocaleString("es-AR")}. Antes de esa fecha, repetí este comando.`);
        out("Contraseña, confianza y sesión quedaron como variables sensibles de Vercel (no se muestran). Aplicalo con: vercel deploy --prod");
        return 0;
    }
    if (action === "disable") {
        const removed: string[] = [];
        for (const name of VARS) if ((await vercelEnvRm(name)) === "removed") removed.push(name);
        const prev = (w.metadata.readJson(STATE_FILE) as RemoteAutoLoginRecord | null) ?? {};
        w.metadata.writeJson(STATE_FILE, { ...prev, disabled_at: new Date().toISOString() } satisfies RemoteAutoLoginRecord);
        out(removed.length ? `Borradas de Vercel: ${removed.join(", ")}. Aplicalo con: vercel deploy --prod` : "No había variables del login automático remoto en Vercel.");
        out("No cierra la sesión que el remoto ya tenga abierta: queda hasta que vence o la cerrás en Preferencias → Sesiones del navegador.");
        return 0;
    }
    if (action === "status" || action === undefined) {
        const rec = (w.metadata.readJson(STATE_FILE) as RemoteAutoLoginRecord | null) ?? {};
        const exp = rec.trust_expires_at ?? null;
        const days = exp ? Math.floor((Date.parse(exp) - Date.now()) / 86_400_000) : null;
        const enabled = !!rec.enabled_at && (!rec.disabled_at || rec.disabled_at < rec.enabled_at);
        out(JSON.stringify({ enabled_from_this_pc: enabled, enabled_at: rec.enabled_at ?? null, trust_expires_at: exp, trust_days_left: days, remote_state: "en campus_get_status del conector remoto (web_autologin)" }, null, 2));
        if (enabled && days !== null && days <= 3) err(`La confianza del remoto vence en ${days} día(s): renovala con ${cmd("remote autologin enable")} y vercel deploy --prod.`);
        return 0;
    }
    throw new CampusError("CONFIG_INVALID", `Uso: ${cliCommand()} remote autologin [enable|disable|status] --profile <id>`);
}
