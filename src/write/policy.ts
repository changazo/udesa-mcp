import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CampusError } from "../errors.js";
import { resolveProfileAlias, findSecretLikeKeys, loadProfile, packageRoot, type Profile } from "../config/profile.js";

/**
 * Perfil y política de escritura (directiva de escrituras §5.1, ADR-044).
 *
 * Un perfil de escritura es un archivo aparte, con su propio esquema, que REFERENCIA a un perfil de
 * lectura: de él toma sitio, servicio, credenciales (mismo token y misma sesión web), identidad y
 * alcance de cursos. Los perfiles de lectura siguen con `read_only: true` literal (ADR-004) y su
 * esquema rechaza cualquier clave de escritura.
 */

/** Capacidades de escritura previstas por la directiva. Que exista el nombre no implica que haya una intención. */
export const WRITE_CAPABILITIES = [
    "post_announcement",
    "reply_forum",
    "edit_own_post",
    "pin_lock_discussion",
    "calendar_event",
    "grant_extension",
    "lock_submissions",
    "submission_comment",
    "send_message",
    "grade_submission",
    "take_attendance",
    "quiz_override",
    "course_visibility",
    "rename_content",
    /** W4: mover actividades (se habilita aparte de mostrar/ocultar). */
    "move_content",
    /** Calificación manual de preguntas de cuestionarios (ADR-071). */
    "grade_quiz",
    /** Calificar el foro completo (ADR-070). */
    "grade_forum",
    /** Agregar secciones (ADR-067). */
    "create_section",
    /** Borrar actividades o secciones (R4, ADR-067). */
    "delete_content",
    /** Borrar intentos de cuestionarios y devolver a borrador o borrar entregas (ADR-119). */
    "delete_student_work",
    /** Excepciones de fechas de tareas por participante (ADR-066). */
    "assign_override",
    /** Capítulos de libros, entradas de glosarios y bases de datos, páginas de wikis (ADR-077). */
    "manage_activity_entries",
    /** Borrar posts de cualquier autor y mover discusiones (ADR-094). */
    "moderate_forum",
    /** Ítems y notas del libro de calificaciones (ADR-096). */
    "manage_gradebook",
    /** Cambiar fechas y límites de actividades existentes (ADR-065). */
    "edit_activity",
    /** Crear página, enlace, etiqueta o archivo (ADR-064). */
    "create_content",
    /** Agregar y quitar preguntas de un cuestionario (ADR-063). */
    "edit_quiz",
    /** Importar preguntas a un banco del curso (ADR-059). */
    "import_questions",
    /** Crear grupos y fijar los grupos de un participante (ADR-058). */
    "manage_groups",
    /** Crear un cuestionario vacío por formulario web (ADR-056). */
    "create_quiz",
    /** Crear una actividad de asistencia por formulario web (ADR-055). */
    "create_attendance",
    /** Crear una tarea por formulario web (W6 adelantada, ADR-050). */
    "create_assignment",
    /** Intención de prueba de W0: sólo existe contra el Moodle sintético (sitio `.test`). */
    "synthetic_test",
] as const;
export type WriteCapability = (typeof WRITE_CAPABILITIES)[number];

export const RISKS = ["R1", "R2", "R3", "R4"] as const;
export type Risk = (typeof RISKS)[number];

export const riskRank = (r: Risk) => RISKS.indexOf(r);
export const maxRisk = (a: Risk, b: Risk): Risk => (riskRank(a) >= riskRank(b) ? a : b);
export const raiseRisk = (r: Risk, levels = 1): Risk => RISKS[Math.min(RISKS.length - 1, riskRank(r) + levels)]!;

const ProfileId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Capability = z.enum(WRITE_CAPABILITIES);

/** Una capacidad por curso: el nombre solo, o con la fecha en que el dueño la habilitó (informativa, ADR-126). */
const CourseGrant = z.union([Capability, z.strictObject({ capability: Capability, enabled_on: Day })]);

const WritePolicySchema = z.strictObject({
    enabled: z.boolean(),
    /** Cursos sandbox (escritura libre del dueño, ADR-043): sin escalada de riesgo por «curso real». */
    sandbox_course_ids: z.array(z.number().int().positive()).default([]),
    /**
     * Capacidades habilitadas por curso. Una entrada propia reemplaza a `all_courses` para ese curso:
     * con lista vacía, el curso no admite escrituras.
     */
    courses: z.record(z.string().regex(/^[1-9]\d{0,11}$/), z.array(CourseGrant)),
    /**
     * Capacidades para cualquier otro curso del alcance de lectura donde la cuenta tenga rol de escritura
     * (ADR-122/125). Vacío = sólo los cursos de `courses`.
     */
    all_courses: z.array(CourseGrant).default([]),
    limits: z.strictObject({
        max_items_per_plan: z.number().int().min(1).max(30),
        max_messages_per_plan: z.number().int().min(0).max(1),
        max_actions_per_day: z.number().int().min(1).max(2000),
        max_messages_per_day: z.number().int().min(0).max(20),
    }),
    notify_students_default: z.boolean(),
    /** Desde qué riesgo la confirmación va fuera del modelo. Nunca más laxo que R2. */
    /** Desde qué riesgo hace falta aprobación humana fuera del chat; "nunca" = sin aprobaciones (ADR-061, decisión del dueño). */
    require_out_of_band_from_risk: z.enum(["R1", "R2", "nunca"]),
    /** Guardar en la auditoría el texto del docente (si no, sólo hash y largo). El de estudiantes, nunca. */
    audit_teacher_text: z.boolean().default(false),
    /**
     * Decisión del dueño (ADR-048): en los cursos sandbox la confirmación puede quedar en el cliente
     * (el agente ejecuta sin pasar por el humano). Nunca aplica a cursos que no son sandbox.
     */
    sandbox_confirmation: z.enum(["fuera_de_banda", "cliente"]).default("fuera_de_banda"),
    /**
     * false (por defecto): se rechaza en el plan toda escritura que notificaría a participantes
     * (p. ej. publicar en un foro con suscripción forzada o inicial).
     */
    allow_participant_notifications: z.boolean().default(false),
    /**
     * ADR-115: participantes a los que SÍ se puede notificar aunque allow_participant_notifications sea
     * false (cuentas de prueba que el dueño agregó al sandbox). Sólo vale en cursos sandbox y para
     * notificaciones a UNA persona (calificar su entrega o su intento); no para foros ni asistencia.
     */
    notifiable_user_ids: z.array(z.number().int().positive()).max(20).default([]),
    /**
     * ADR-118: desde qué riesgo un plan que se confirma en el cliente necesita que el USUARIO lo apruebe
     * antes de ejecutarse: el servidor se lo pregunta (elicitación) o el agente se lo plantea y pasa sus
     * palabras (user_approval). "nunca" = sin ese requisito.
     */
    human_in_the_loop_from_risk: z.enum(["R1", "R2", "R3", "R4", "nunca"]).default("R3"),
    confirmation: z
        .strictObject({
            /** Diálogo nativo de Windows al ejecutar (si no, sólo la terminal). */
            dialog: z.boolean(),
            dialog_timeout_seconds: z.number().int().min(15).max(120),
        })
        .default({ dialog: true, dialog_timeout_seconds: 120 }),
});

const WriteProfileFileSchema = z.strictObject({
    schema_version: z.literal("1.0"),
    profile_kind: z.literal("write"),
    profile_id: ProfileId,
    /** Perfil de lectura cuyas credenciales, identidad y alcance usa este perfil. */
    read_profile: ProfileId,
    read_only: z.literal(false),
    write_policy: WritePolicySchema,
});

export interface CapabilityGrant {
    capability: WriteCapability;
    /** Fecha en que el dueño habilitó la capacidad. Sólo informativa desde ADR-126 (ya no escala el riesgo). */
    enabled_on: string | null;
}

export interface WritePolicy {
    enabled: boolean;
    sandbox_course_ids: number[];
    courses: Map<number, CapabilityGrant[]>;
    /** Capacidades para los cursos sin entrada propia (ADR-125). */
    all_courses: CapabilityGrant[];
    limits: z.infer<typeof WritePolicySchema>["limits"];
    notify_students_default: boolean;
    require_out_of_band_from_risk: Risk | "nunca";
    audit_teacher_text: boolean;
    sandbox_confirmation: "fuera_de_banda" | "cliente";
    allow_participant_notifications: boolean;
    notifiable_user_ids: number[];
    human_in_the_loop_from_risk: Risk | "nunca";
    confirmation: { dialog: boolean; dialog_timeout_seconds: number };
}

export interface WriteProfile {
    profile_id: string;
    /** Perfil de lectura: el núcleo de lectura sigue con read_only=true; las escrituras van por WriteTransport. */
    read_profile: Profile;
    policy: WritePolicy;
    /** El sitio es sintético (dominio reservado .test): sólo ahí existen las intenciones de prueba. */
    synthetic_site: boolean;
}

/** Dominio reservado para pruebas (RFC 6761): nunca es el Campus real. */
export function isSyntheticSite(siteUrl: string): boolean {
    try {
        return new URL(siteUrl).hostname.toLowerCase().endsWith(".test");
    } catch {
        return false;
    }
}

export function parseWriteProfile(json: unknown, readProfile: Profile, expectedId?: string): WriteProfile {
    if (json && typeof json === "object") {
        const bad = findSecretLikeKeys(json);
        if (bad.length) throw new CampusError("CONFIG_INVALID", `El perfil de escritura contiene claves con forma de secreto (${bad.join(", ")}).`);
    }
    const parsed = WriteProfileFileSchema.safeParse(json);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
        throw new CampusError("CONFIG_INVALID", `Perfil de escritura inválido: ${issues}`);
    }
    const p = parsed.data;
    if (expectedId && p.profile_id !== expectedId) throw new CampusError("CONFIG_INVALID", `El archivo declara profile_id=${p.profile_id}, no ${expectedId}.`);
    if (p.read_profile !== readProfile.profile_id) throw new CampusError("CONFIG_INVALID", `El perfil de lectura cargado (${readProfile.profile_id}) no es el que declara el perfil de escritura (${p.read_profile}).`);
    if (p.profile_id === p.read_profile) throw new CampusError("CONFIG_INVALID", "El perfil de escritura necesita un profile_id propio, distinto del de lectura.");
    const synthetic = isSyntheticSite(readProfile.site_url);
    const toGrants = (key: string, list: z.infer<typeof CourseGrant>[]): CapabilityGrant[] => {
        const grants = list.map((g) => (typeof g === "string" ? { capability: g, enabled_on: null } : { capability: g.capability, enabled_on: g.enabled_on }));
        const names = grants.map((g) => g.capability);
        if (new Set(names).size !== names.length) throw new CampusError("CONFIG_INVALID", `write_policy.${key} repite capacidades.`);
        if (!synthetic && names.includes("synthetic_test")) {
            throw new CampusError("CONFIG_INVALID", "La capacidad synthetic_test sólo existe contra el Moodle sintético (sitio .test).");
        }
        return grants;
    };
    const courses = new Map<number, CapabilityGrant[]>();
    for (const [key, list] of Object.entries(p.write_policy.courses)) {
        const courseId = Number(key);
        const grants = toGrants(`courses.${key}`, list);
        if (readProfile.course_scope === "allowlist" && !readProfile.allowed_course_ids.includes(courseId)) {
            throw new CampusError("CONFIG_INVALID", `El curso ${courseId} no está en la allowlist del perfil de lectura ${readProfile.profile_id}.`);
        }
        if (readProfile.excluded_course_ids.includes(courseId)) throw new CampusError("CONFIG_INVALID", `El curso ${courseId} está excluido en el perfil de lectura.`);
        courses.set(courseId, grants);
    }
    const wp = p.write_policy;
    return {
        profile_id: p.profile_id,
        read_profile: readProfile,
        synthetic_site: synthetic,
        policy: {
            enabled: wp.enabled,
            sandbox_course_ids: wp.sandbox_course_ids,
            courses,
            all_courses: toGrants("all_courses", wp.all_courses),
            limits: wp.limits,
            notify_students_default: wp.notify_students_default,
            require_out_of_band_from_risk: wp.require_out_of_band_from_risk,
            audit_teacher_text: wp.audit_teacher_text,
            sandbox_confirmation: wp.sandbox_confirmation,
            allow_participant_notifications: wp.allow_participant_notifications,
            notifiable_user_ids: wp.notifiable_user_ids,
            human_in_the_loop_from_risk: wp.human_in_the_loop_from_risk,
            confirmation: wp.confirmation,
        },
    };
}

/**
 * Carga un perfil de escritura y su perfil de lectura. `CAMPUS_PROFILE`, si está, tiene que
 * nombrar al perfil de escritura; el resto de las variables se controla contra el de lectura.
 */
export function loadWriteProfile(opts: { profileId?: string; profileFile?: string; env?: NodeJS.ProcessEnv; readProfileFile?: string }): WriteProfile {
    opts = { ...opts, profileId: resolveProfileAlias(opts.profileId) };
    const env = opts.env ?? process.env;
    if (!opts.profileId && !opts.profileFile) throw new CampusError("CONFIG_INVALID", "Indicá --profile <id> o --profile-file <ruta> del perfil de escritura.");
    if (opts.profileId && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(opts.profileId)) throw new CampusError("CONFIG_INVALID", "Identificador de perfil inválido.");
    const file = opts.profileFile ? resolve(opts.profileFile) : join(packageRoot(), "profiles", `${opts.profileId}.json`);
    let json: unknown;
    try {
        json = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        throw new CampusError("CONFIG_INVALID", `No se pudo leer el perfil de escritura en ${file}.`);
    }
    const kind = json && typeof json === "object" ? (json as { profile_kind?: unknown; read_profile?: unknown }) : {};
    if (kind.profile_kind !== "write") throw new CampusError("CONFIG_INVALID", `${opts.profileId ?? file} no es un perfil de escritura (falta profile_kind: "write").`);
    if (typeof kind.read_profile !== "string") throw new CampusError("CONFIG_INVALID", "El perfil de escritura no declara read_profile.");
    const writeId = (json as { profile_id?: unknown }).profile_id;
    if (env.CAMPUS_PROFILE && env.CAMPUS_PROFILE !== writeId) throw new CampusError("CONFIG_INVALID", "CAMPUS_PROFILE no coincide con el perfil de escritura.");
    const { CAMPUS_PROFILE: _ignored, ...rest } = env;
    // Con --profile-file, el perfil de lectura se busca primero junto al archivo; si no, en profiles/.
    const sibling = opts.profileFile && /^[a-z0-9][a-z0-9-]{0,62}$/.test(kind.read_profile) ? join(dirname(file), `${kind.read_profile}.json`) : null;
    const readFile = opts.readProfileFile ?? (sibling && existsSync(sibling) ? sibling : null);
    const readProfile = loadProfile(readFile ? { profileFile: readFile, env: rest } : { profileId: kind.read_profile, env: rest });
    if (readProfile.profile_id !== kind.read_profile) throw new CampusError("CONFIG_INVALID", `El perfil de lectura ${readProfile.profile_id} no es el declarado (${kind.read_profile}).`);
    return parseWriteProfile(json, readProfile, opts.profileId);
}

/**
 * Doble llave (directiva §5.1): el servidor de escritura sólo arranca con un perfil de escritura
 * Y `CAMPUS_WRITE_ENABLED=true`. Ninguna de las dos sola alcanza.
 */
export function assertWriteServerMayStart(profile: WriteProfile, env: NodeJS.ProcessEnv = process.env): void {
    if (env.CAMPUS_WRITE_ENABLED !== "true") {
        throw new CampusError("WRITE_DISABLED", "El servidor de escritura necesita CAMPUS_WRITE_ENABLED=true en el entorno, además del perfil de escritura (doble llave).", {
            humanAction: "Agregá CAMPUS_WRITE_ENABLED=true sólo en la entrada udesa-campus-escritura del cliente MCP.",
        });
    }
    if (!profile.policy.enabled) throw new CampusError("WRITE_DISABLED", `El perfil ${profile.profile_id} tiene write_policy.enabled=false.`);
}

/** ¿Se puede notificar a estas personas en este curso? (perfil general o cuentas de prueba del sandbox, ADR-115). */
export function mayNotify(policy: WritePolicy, courseId: number, userIds: readonly number[]): boolean {
    if (policy.allow_participant_notifications) return true;
    return userIds.length > 0 && policy.sandbox_course_ids.includes(courseId) && userIds.every((id) => policy.notifiable_user_ids.includes(id));
}

/** Capacidades de un curso: su entrada propia o, si no tiene, las de todos los cursos (ADR-125). */
export function grantsFor(policy: WritePolicy, courseId: number): CapabilityGrant[] {
    return policy.courses.get(courseId) ?? policy.all_courses;
}

export function grantFor(policy: WritePolicy, courseId: number, capability: WriteCapability): CapabilityGrant | null {
    return grantsFor(policy, courseId).find((g) => g.capability === capability) ?? null;
}

/**
 * Riesgo calculado por el servidor (§4), nunca por el modelo. Parte del riesgo que declara la
 * intención para el plan concreto y aplica las escaladas de la directiva.
 */
export function computeRisk(input: { base: Risk; capability: WriteCapability; items: number; courseId: number; policy: WritePolicy; now: Date }): { risk: Risk; reasons: string[] } {
    let risk = input.base;
    const reasons = [`Riesgo base de la intención: ${input.base}.`];
    if (input.base === "R2" && input.items > 5) {
        risk = raiseRisk(risk);
        reasons.push(`Más de 5 ítems en un plan R2 (${input.items}): sube un nivel.`);
    }
    if (input.capability === "send_message" && input.items > 1) {
        risk = raiseRisk(risk);
        reasons.push("Más de un mensaje en el plan: sube un nivel.");
    }
    // ADR-126: un curso real ya no sube el riesgo por sí solo (antes, las dos primeras semanas desde enabled_on).
    return { risk, reasons };
}
