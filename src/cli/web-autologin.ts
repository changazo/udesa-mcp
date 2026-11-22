import { CampusError, toPublicError } from "../errors.js";
import type { MetadataStore } from "../session/metadata.js";
import type { SecretStore } from "../session/secret-store.js";
import { cliCommand } from "../util/cli-command.js";
import { AUTOLOGIN_MAX_PER_DAY, AUTOLOGIN_MIN_INTERVAL_MS, autoLoginStatus, forgetAutoLogin, saveLogin, trustExpiry } from "../web/autologin.js";
import { AUTOLOGIN_ENV, type LocalConnection } from "../web/local-connection.js";
import { passwordLogin } from "../web/login.js";
import type { WebTransport } from "../web/transport.js";
import { promptHidden, promptVisible, requireTty } from "./prompt.js";

export { AUTOLOGIN_ENV };

export interface AutoLoginCommandDeps {
    web: WebTransport;
    local: LocalConnection;
    secrets: SecretStore;
    metadata: MetadataStore;
    profileId: string;
    siteUrl: string;
    /** Entrada del humano (tests). */
    prompt?: { visible: (q: string) => Promise<string>; hidden: (q: string) => Promise<string>; requireTty: () => void };
    out?: (s: string) => void;
    err?: (s: string) => void;
}

/**
 * `auth web autologin enable|disable|status` (lo corre el humano). Desde ADR-142 el login automático es el
 * método recomendado en la PC (decisión del dueño); la contraseña se escribe sólo en esta terminal y la
 * sesión y la confianza quedan en el registro de la conexión de esta PC, el mismo que usan los servidores.
 */
export async function webAutologinCommand(action: string | undefined, w: AutoLoginCommandDeps): Promise<number> {
    const out = w.out ?? ((s: string) => process.stdout.write(`${s}\n`));
    const err = w.err ?? ((s: string) => process.stderr.write(`${s}\n`));
    const ask = w.prompt ?? { visible: promptVisible, hidden: promptHidden, requireTty };
    const cmd = (rest: string) => `${cliCommand()} auth web ${rest} --profile ${w.profileId}`;
    const svc = await w.local.service();
    if (action === "enable") {
        ask.requireTty();
        const blocked = await svc.terminalBlock();
        if (blocked) {
            err(`${blocked.message}${blocked.retry_at ? ` Probá después de ${new Date(blocked.retry_at).toLocaleString("es-AR")}.` : ""} No se pidió la contraseña.`);
            return 1;
        }
        out("Login web automático (método recomendado en la PC, ADR-142): guarda tu contraseña del Campus en el Administrador de credenciales");
        out("para que el MCP local inicie sesión en la web solo cuando la sesión vence. La contraseña se escribe sólo acá, nunca en el chat.");
        const username = (await ask.visible("Usuario del Campus: ")).trim();
        const password = await ask.hidden("Contraseña (no se muestra): ");
        if (!username || !password) {
            err("Usuario y contraseña son obligatorios. No se guardó nada.");
            return 2;
        }
        out("Iniciando sesión en la web del Campus (un solo intento)...");
        await svc.noteTerminalAttempt();
        try {
            const r = await passwordLogin(w.web, {
                username,
                password,
                remembered: await svc.trustForLogin(),
                askCode: async () => {
                    out("El Campus te mandó un código de verificación al correo.");
                    return (await ask.hidden("Código de 6 dígitos (no se muestra): ")).trim();
                },
            });
            // Recién con el login verificado se guarda la contraseña; sesión y confianza van al registro (generación nueva).
            await saveLogin(w.secrets, w.profileId, w.siteUrl, { username, password });
            await svc.adoptLogin(r);
            out(`Listo: sesión web iniciada (userid ${r.snapshot.user_id}, segundo factor: ${r.mfa}).`);
            const exp = r.trust_expires_at ?? trustExpiry(r.remembered);
            out(exp ? `El Campus confía en esta PC como dispositivo hasta ${new Date(exp).toLocaleString("es-AR")}. Para renovarla antes: ${cmd("panel")}.` : "Aviso: el Campus no dejó la cookie de dispositivo de confianza; cada login automático podría pedir un código.");
            out(`Segunda llave: agregá ${AUTOLOGIN_ENV}=true en la entrada del cliente MCP (serve o serve-full) y abrí una sesión nueva.`);
            return 0;
        } catch (e) {
            const pe = toPublicError(e);
            await svc.noteTerminalFailure(pe.code).catch(() => undefined);
            err(`No se pudo iniciar sesión: ${pe.code}. ${pe.message}`);
            err("No se guardó la contraseña.");
            return 1;
        }
    }
    if (action === "disable") {
        await forgetAutoLogin(w.secrets, w.metadata, w.profileId, w.siteUrl);
        await svc.forgetTrust();
        out("Login web automático desactivado: se borraron la contraseña del Administrador de credenciales y la confianza del dispositivo.");
        out(`La sesión web abierta sigue hasta que venza. Respaldo sin contraseña: ${cmd("import")} --clipboard.`);
        out("No cierra sesiones en el Campus. Corte de emergencia: cambiar la contraseña del Campus (cierra todas las sesiones).");
        return 0;
    }
    if (action === "status" || action === undefined) {
        const connection = await svc.publicStatus();
        const auto = await autoLoginStatus(svc.autoLoginBackend());
        out(
            JSON.stringify(
                {
                    connection,
                    autologin: { ...auto, second_key_for_servers: `${AUTOLOGIN_ENV}=true en la entrada del cliente MCP`, limits: { min_interval_minutes: AUTOLOGIN_MIN_INTERVAL_MS / 60_000, max_per_day: AUTOLOGIN_MAX_PER_DAY } },
                },
                null,
                2,
            ),
        );
        const a = connection.action as { label?: string; command?: string | null } | null;
        if (a?.command) err(`${a.label}: ${a.command}`);
        return 0;
    }
    throw new CampusError("CONFIG_INVALID", `Uso: ${cliCommand()} auth web autologin [enable|disable|status] --profile <id>`);
}
