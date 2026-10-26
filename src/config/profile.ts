import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CampusError } from "../errors.js";
import { isValidTimeZone } from "../util/time.js";

/**
 * Perfil no secreto. `strictObject` rechaza claves desconocidas: un perfil con `password` o
 * `token` no carga. Los literales `read_only: true` y `store_password: false` reflejan el alcance
 * del primer hito; habilitar otra cosa requiere cambiar código y tests, no sólo un JSON.
 */
const LimitsSchema = z.strictObject({
    http_timeout_seconds: z.number().int().min(1).max(120),
    max_concurrent_requests: z.number().int().min(1).max(8),
    max_pages_per_request: z.number().int().min(1).max(50),
    max_file_bytes: z.number().int().min(1).max(100 * 1024 * 1024),
    max_text_chars_per_result: z.number().int().min(1000).max(200_000),
});

const ProfileFileSchema = z.strictObject({
    schema_version: z.literal("1.0"),
    profile_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    base_url: z.string(),
    web_login_url: z.string().nullable().optional(),
    service: z.string().regex(/^[a-z0-9_]{1,100}$/),
    /**
     * `allowlist`: sólo los cursos de allowed_course_ids.
     * `teaching`: los cursos donde el usuario VERIFICADO tiene un rol docente según Moodle,
     * resueltos en tiempo de ejecución (nunca a partir de lo que diga el modelo).
     * `enrolled`: todos los cursos donde el usuario VERIFICADO está matriculado, con cualquier rol
     * (ADR-122); los datos de terceros siguen exigiendo rol docente en cada curso.
     */
    course_scope: z.enum(["allowlist", "teaching", "enrolled"]).default("allowlist"),
    allowed_course_ids: z.array(z.number().int().positive()),
    teacher_role_shortnames: z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).min(1).default(["editingteacher", "teacher"]),
    /** Roles con los que se puede ESCRIBIR en un curso (ADR-122), además de la allowlist del perfil de escritura. */
    write_role_shortnames: z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).min(1).default(["editingteacher", "manager", "coursecreator"]),
    excluded_course_ids: z.array(z.number().int().positive()).default([]),
    announcement_forum_id: z.number().int().positive().nullable(),
    preferred_auth_method: z.enum(["native", "browser"]),
    read_only: z.literal(true),
    store_password: z.literal(false),
    secret_backend: z.literal("os_keyring"),
    timezone: z.string(),
    limits: LimitsSchema,
    export_to_repository: z.literal(false),
});

export type ProfileFile = z.infer<typeof ProfileFileSchema>;

export interface Profile extends Omit<ProfileFile, "base_url"> {
    /** wwwroot canónico: https, sin barra final, sin query, fragmento ni credenciales. */
    site_url: string;
    origin: string;
}

const SECRET_KEY = /pass(word)?|token|secret|cookie|private|session|credential/i;
const POLICY_KEYS = new Set(["store_password", "secret_backend"]);

/** Valida y canoniza la URL base (CFG-01/CFG-02). */
export function canonicalSiteUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new CampusError("CONFIG_INVALID", "base_url no es una URL válida.");
    }
    if (url.protocol !== "https:") throw new CampusError("CONFIG_INVALID", "base_url debe usar HTTPS.");
    if (url.username || url.password) throw new CampusError("CONFIG_INVALID", "base_url no puede incluir usuario ni contraseña.");
    if (url.search || raw.includes("?")) throw new CampusError("CONFIG_INVALID", "base_url no puede tener query.");
    if (url.hash || raw.includes("#")) throw new CampusError("CONFIG_INVALID", "base_url no puede tener fragmento.");
    if (url.port && url.port !== "443") throw new CampusError("CONFIG_INVALID", "base_url no puede usar un puerto no estándar.");
    if (/%2e|%2f|%5c|\\/i.test(raw)) throw new CampusError("CONFIG_INVALID", "base_url contiene separadores codificados.");
    const path = url.pathname.replace(/\/+$/, "");
    if (path.split("/").some((seg) => seg === "." || seg === "..")) {
        throw new CampusError("CONFIG_INVALID", "base_url contiene segmentos relativos.");
    }
    return `${url.origin}${path}`;
}

export function parseProfile(json: unknown, expectedId?: string): Profile {
    if (json && typeof json === "object") {
        const bad = findSecretLikeKeys(json);
        if (bad.length) {
            throw new CampusError(
                "CONFIG_INVALID",
                `El perfil contiene claves con forma de secreto (${bad.join(", ")}). Los secretos van al keyring mediante la CLI, nunca al perfil.`,
            );
        }
    }
    const parsed = ProfileFileSchema.safeParse(json);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
        throw new CampusError("CONFIG_INVALID", `Perfil inválido: ${issues}`);
    }
    const p = parsed.data;
    if (expectedId && p.profile_id !== expectedId) {
        throw new CampusError("CONFIG_INVALID", `El archivo declara profile_id=${p.profile_id}, no ${expectedId}.`);
    }
    if (p.course_scope === "allowlist" && p.allowed_course_ids.length === 0) {
        throw new CampusError("CONFIG_INVALID", "Con course_scope=allowlist, allowed_course_ids necesita al menos un curso.");
    }
    if (p.course_scope !== "allowlist" && p.announcement_forum_id !== null) {
        throw new CampusError("CONFIG_INVALID", `Con course_scope=${p.course_scope} hay varios cursos: announcement_forum_id debe ser null (se detecta por curso).`);
    }
    if (!isValidTimeZone(p.timezone)) throw new CampusError("CONFIG_INVALID", `Zona horaria desconocida: ${p.timezone}`);
    if (new Set(p.allowed_course_ids).size !== p.allowed_course_ids.length) {
        throw new CampusError("CONFIG_INVALID", "allowed_course_ids tiene duplicados.");
    }
    const site_url = canonicalSiteUrl(p.base_url);
    const origin = new URL(site_url).origin;
    if (p.web_login_url) {
        let login: URL;
        try {
            login = new URL(p.web_login_url);
        } catch {
            throw new CampusError("CONFIG_INVALID", "web_login_url no es una URL válida.");
        }
        if (login.origin !== origin || login.username || login.password) {
            throw new CampusError("CONFIG_INVALID", "web_login_url debe pertenecer al mismo origen que base_url.");
        }
    }
    const { base_url: _omit, ...rest } = p;
    return { ...rest, site_url, origin };
}

export function findSecretLikeKeys(obj: object, prefix = ""): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        // store_password y secret_backend son campos de política del esquema, no secretos.
        if (SECRET_KEY.test(k) && !POLICY_KEYS.has(path)) out.push(path);
        if (v && typeof v === "object" && !Array.isArray(v)) out.push(...findSecretLikeKeys(v, path));
    }
    return out;
}

/**
 * Variables de entorno: sólo pueden CONFIRMAR el perfil, nunca sobreescribirlo (CFG-03).
 * Un conflicto es un error explícito; no hay fallback a otro campus.
 */
export function checkEnvAgainstProfile(profile: Profile, env: NodeJS.ProcessEnv = process.env): void {
    const conflicts: string[] = [];
    const check = (name: string, matches: (v: string) => boolean) => {
        const v = env[name];
        if (v !== undefined && v !== "" && !matches(v)) conflicts.push(name);
    };
    check("CAMPUS_PROFILE", (v) => v === profile.profile_id);
    check("CAMPUS_BASE_URL", (v) => {
        try {
            return canonicalSiteUrl(v) === profile.site_url;
        } catch {
            return false;
        }
    });
    check("CAMPUS_SERVICE", (v) => v === profile.service);
    check("CAMPUS_ALLOWED_COURSE_IDS", (v) => {
        const ids = v.split(",").map((s) => Number(s.trim()));
        return ids.length === profile.allowed_course_ids.length && ids.every((id) => profile.allowed_course_ids.includes(id));
    });
    check("CAMPUS_AUTH_METHOD", (v) => v === "native" || v === "browser");
    check("CAMPUS_READ_ONLY", (v) => v === "true");
    check("CAMPUS_STORE_PASSWORD", (v) => v === "false");
    check("CAMPUS_TIMEZONE", (v) => v === profile.timezone);
    if (conflicts.length) {
        throw new CampusError(
            "CONFIG_INVALID",
            `Variables de entorno en conflicto con el perfil ${profile.profile_id}: ${conflicts.join(", ")}. ` +
                "El entorno no puede cambiar campus, cursos, servicio ni política; editá el perfil explícitamente.",
        );
    }
}

/** Raíz del paquete (donde están profiles/ y schemas/), independiente del cwd del agente. */
export function packageRoot(): string {
    // build/config/profile.js o src/config/profile.ts → dos niveles arriba.
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Nombres de perfil para el usuario (ADR-062): docente-lectura (sólo lectura) y docente-completo
 * (lecturas + escrituras en un conector). Apuntan a los perfiles con sus ids internos de siempre,
 * que siguen funcionando como alias: el keyring y el estado local están guardados con esos ids.
 */
export const PROFILE_ALIASES: Readonly<Record<string, string>> = { "docente-lectura": "udesa-docente", "docente-completo": "udesa-docente-escritura" };

export function resolveProfileAlias<T extends string | undefined>(id: T): T {
    return (id && Object.hasOwn(PROFILE_ALIASES, id) ? PROFILE_ALIASES[id] : id) as T;
}

export function loadProfile(opts: { profileId?: string; profileFile?: string; env?: NodeJS.ProcessEnv }): Profile {
    opts = { ...opts, profileId: resolveProfileAlias(opts.profileId) };
    const env = opts.env ?? process.env;
    if (!opts.profileId && !opts.profileFile) {
        throw new CampusError("CONFIG_INVALID", "Indicá --profile <id> o --profile-file <ruta>. No hay perfil por defecto.");
    }
    if (opts.profileId && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(opts.profileId)) {
        throw new CampusError("CONFIG_INVALID", "Identificador de perfil inválido.");
    }
    const file = opts.profileFile ? resolve(opts.profileFile) : join(packageRoot(), "profiles", `${opts.profileId}.json`);
    let raw: string;
    try {
        raw = readFileSync(file, "utf8");
    } catch {
        throw new CampusError("CONFIG_INVALID", `No se pudo leer el perfil en ${file}.`);
    }
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        throw new CampusError("CONFIG_INVALID", `El perfil ${file} no es JSON válido.`);
    }
    if (json && typeof json === "object" && (json as { profile_kind?: unknown }).profile_kind === "write") {
        // Un perfil de escritura nunca arranca el servidor de lectura ni pasa por su esquema (ADR-044).
        throw new CampusError("CONFIG_INVALID", `${opts.profileId ?? file} es un perfil de escritura: sólo lo usan el servidor completo (campus serve-full), el de escritura (campus serve-write) y los comandos campus write.`);
    }
    const profile = parseProfile(json, opts.profileId);
    checkEnvAgainstProfile(profile, env);
    return profile;
}
