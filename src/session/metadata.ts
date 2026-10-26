import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Metadata NO secreta de la sesión: método, identidad validada y fechas. El token vive en el
 * keyring; acá nunca. Se guarda fuera del repositorio, en el directorio de estado del usuario.
 */
export const SessionMetadataSchema = z.object({
    schema_version: z.literal("1.0"),
    profile_id: z.string(),
    site_url: z.string(),
    service: z.string(),
    auth_method: z.enum(["native", "browser"]),
    identity: z.object({ site_url: z.string(), user_id: z.number().int().positive(), validated_at: z.string() }),
    obtained_at: z.string(),
});
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

export interface MetadataStore {
    read(): SessionMetadata | null;
    write(m: SessionMetadata): void;
    delete(): void;
    /** Archivo auxiliar no secreto (p. ej. último reporte de capacidades). */
    readJson(name: string): unknown;
    writeJson(name: string, data: unknown): void;
    readonly location: string;
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.CAMPUS_STATE_DIR) return env.CAMPUS_STATE_DIR;
    if (process.platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "udesa-campus-mcp");
    return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "udesa-campus-mcp");
}

export class FileMetadataStore implements MetadataStore {
    readonly location: string;
    constructor(stateDir: string, profileId: string) {
        this.location = join(stateDir, "profiles", profileId);
    }
    read(): SessionMetadata | null {
        const parsed = SessionMetadataSchema.safeParse(this.readJson("session.json"));
        return parsed.success ? parsed.data : null;
    }
    write(m: SessionMetadata): void {
        this.writeJson("session.json", m);
    }
    delete(): void {
        rmSync(join(this.location, "session.json"), { force: true });
        rmSync(join(this.location, "capability-report.json"), { force: true });
    }
    readJson(name: string): unknown {
        try {
            return JSON.parse(readFileSync(join(this.location, name), "utf8"));
        } catch {
            return null;
        }
    }
    writeJson(name: string, data: unknown): void {
        mkdirSync(this.location, { recursive: true });
        const target = join(this.location, name);
        const tmp = `${target}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        renameSync(tmp, target);
    }
}

export class MemoryMetadataStore implements MetadataStore {
    readonly location = "memory";
    private files = new Map<string, unknown>();
    read() {
        const parsed = SessionMetadataSchema.safeParse(this.files.get("session.json"));
        return parsed.success ? parsed.data : null;
    }
    write(m: SessionMetadata) {
        this.files.set("session.json", structuredClone(m));
    }
    delete() {
        this.files.delete("session.json");
        this.files.delete("capability-report.json");
    }
    readJson(name: string) {
        return this.files.get(name) ?? null;
    }
    writeJson(name: string, data: unknown) {
        this.files.set(name, structuredClone(data));
    }
}
