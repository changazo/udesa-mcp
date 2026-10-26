import { CampusError } from "../errors.js";

/**
 * Almacén del token Moodle. No hay fallback a texto plano (AUTH-07): si el keyring del sistema
 * no está disponible, la operación falla con SECRET_STORE_UNAVAILABLE.
 */
export interface SecretStore {
    readonly kind: "os_keyring" | "memory" | "env";
    get(account: string): Promise<string | null>;
    set(account: string, secret: string): Promise<void>;
    delete(account: string): Promise<boolean>;
}

export const KEYRING_SERVICE = "udesa-campus-mcp";

/** Cuenta del keyring: aplicación + perfil + origen canónico + servicio. */
export function secretAccount(profileId: string, siteUrl: string, service: string): string {
    return `${profileId}|${siteUrl}|${service}`;
}

export class KeyringSecretStore implements SecretStore {
    readonly kind = "os_keyring" as const;

    private async entry(account: string) {
        try {
            const { AsyncEntry } = await import("@napi-rs/keyring");
            return new AsyncEntry(KEYRING_SERVICE, account);
        } catch {
            throw unavailable();
        }
    }

    async get(account: string): Promise<string | null> {
        const e = await this.entry(account);
        try {
            return (await e.getPassword()) ?? null;
        } catch {
            throw unavailable();
        }
    }

    async set(account: string, secret: string): Promise<void> {
        const e = await this.entry(account);
        try {
            await e.setPassword(secret);
        } catch {
            throw unavailable();
        }
    }

    async delete(account: string): Promise<boolean> {
        const e = await this.entry(account);
        try {
            return await e.deleteCredential();
        } catch {
            throw unavailable();
        }
    }
}

/**
 * Modo remoto: el token viene de una variable de entorno sensible del despliegue (cargada por el
 * dueño con `campus remote push-token`). Es de sólo lectura: el servidor no puede reemplazarlo.
 */
export class EnvSecretStore implements SecretStore {
    readonly kind = "env" as const;
    constructor(private readonly token: string | null) {}
    async get() {
        return this.token;
    }
    async set(): Promise<void> {
        throw new CampusError("POLICY_DENIED", "En modo remoto el token sólo se reemplaza con la CLI y un nuevo despliegue.");
    }
    async delete(): Promise<boolean> {
        throw new CampusError("POLICY_DENIED", "En modo remoto el token sólo se borra desde la configuración del despliegue.");
    }
}

/** Sólo para tests y simulaciones; nunca se selecciona desde un perfil. */
export class MemorySecretStore implements SecretStore {
    readonly kind = "memory" as const;
    private readonly data = new Map<string, string>();
    available = true;

    async get(account: string) {
        if (!this.available) throw unavailable();
        return this.data.get(account) ?? null;
    }
    async set(account: string, secret: string) {
        if (!this.available) throw unavailable();
        this.data.set(account, secret);
    }
    async delete(account: string) {
        if (!this.available) throw unavailable();
        return this.data.delete(account);
    }
    /** Para aserciones de tests: cuántos secretos hay guardados. */
    get size() {
        return this.data.size;
    }
}

const unavailable = () =>
    new CampusError("SECRET_STORE_UNAVAILABLE", "El almacén seguro del sistema (keyring) no está disponible. No se guarda el token en texto plano.", {
        humanAction: "En Windows se usa el Administrador de credenciales; en Linux hace falta Secret Service. Ver docs/CONFIGURACION_LOCAL.md.",
    });
