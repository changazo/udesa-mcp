import { CampusError } from "../errors.js";
import type { Profile } from "../config/profile.js";
import { CourseUserProfilesSchema, UserCoursesSchema } from "../moodle/schemas.js";
import type { SessionManager } from "../session/session-manager.js";
import type { Logger } from "../util/logger.js";

export interface ScopedCourse {
    course_id: number;
    shortname: string | null;
    fullname: string | null;
    visible: boolean | null;
    startdate: number | null;
    enddate: number | null;
    /** Roles del usuario verificado en el curso (en course_scope=teaching y enrolled). */
    roles: string[] | null;
}

export interface ResolvedScope {
    mode: "allowlist" | "teaching" | "enrolled";
    courses: ScopedCourse[];
    /** IDs permitidos que la cuenta no tiene matriculados (sólo allowlist). */
    missing: number[];
    resolved_at: string;
}

const TTL_MS = 30 * 60_000;

/**
 * Qué cursos puede consultar el servidor. En `teaching` y `enrolled`, la lista sale de Moodle para el
 * usuario VERIFICADO (cursos matriculados, con su rol en cada uno; `teaching` se queda sólo con los de
 * rol docente). Un fallo al resolver es un error: nunca se trata como «sin cursos» ni se cae a «todos».
 *
 * Además del alcance, los roles deciden dos cosas por curso (ADR-122): los datos de terceros exigen
 * rol docente o superior (`assertTeacher`) y las escrituras, rol de profesor, gestor o superior (`assertWriter`).
 */
export class CourseScope {
    private cache: { at: number; scope: ResolvedScope } | null = null;
    private inflight: Promise<ResolvedScope> | null = null;
    /** Roles por curso con course_scope=allowlist (allí la resolución no los trae). */
    private readonly allowlistRoles = new Map<number, { at: number; roles: Promise<string[]> }>();

    constructor(
        private readonly profile: Profile,
        private readonly session: SessionManager,
        private readonly logger: Logger,
        private readonly now: () => number = Date.now,
    ) {}

    async resolve(force = false): Promise<ResolvedScope> {
        if (!force && this.cache && this.now() - this.cache.at < TTL_MS) return this.cache.scope;
        this.inflight ??= this.doResolve().finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }

    async allowedIds(): Promise<number[]> {
        return (await this.resolve()).courses.map((c) => c.course_id);
    }

    async assert(courseId: number): Promise<void> {
        if (this.profile.course_scope === "allowlist") {
            // Bloqueo inmediato, sin consultar a Moodle (POL-01).
            if (!this.profile.allowed_course_ids.includes(courseId)) throw denied(courseId, "allowlist");
            return;
        }
        if (this.profile.excluded_course_ids.includes(courseId)) throw denied(courseId, "excluded");
        if (!(await this.allowedIds()).includes(courseId)) throw denied(courseId, this.profile.course_scope);
    }

    /** Roles de la cuenta verificada en un curso permitido (valida el alcance primero). */
    async rolesIn(courseId: number): Promise<string[]> {
        await this.assert(courseId);
        if (this.profile.course_scope !== "allowlist") {
            const c = (await this.resolve()).courses.find((x) => x.course_id === courseId);
            if (!c?.roles) throw new CampusError("UNEXPECTED_RESPONSE", `No se pudieron determinar tus roles en el curso ${courseId}.`);
            return c.roles;
        }
        const hit = this.allowlistRoles.get(courseId);
        if (hit && this.now() - hit.at < TTL_MS) return hit.roles;
        const roles = this.session.verified().then((site) => this.ownRoles(site.info.userid, courseId));
        this.allowlistRoles.set(courseId, { at: this.now(), roles });
        // Un fallo no queda cacheado (ni equivale a «sin roles»): la próxima consulta vuelve a preguntar.
        roles.catch(() => this.allowlistRoles.delete(courseId));
        return roles;
    }

    /** Roles que ven datos de terceros: los docentes y los de escritura (gestor o superior también). */
    staffRoles(): string[] {
        return [...new Set([...this.profile.teacher_role_shortnames, ...this.profile.write_role_shortnames])];
    }

    async isTeacher(courseId: number): Promise<boolean> {
        const staff = this.staffRoles();
        return (await this.rolesIn(courseId)).some((r) => staff.includes(r));
    }

    /** Datos de terceros (entregas, notas, intentos, participantes, reportes…): exigen rol docente o superior en el curso. */
    async assertTeacher(courseId: number, what: string): Promise<void> {
        const roles = await this.rolesIn(courseId);
        const staff = this.staffRoles();
        if (roles.some((r) => staff.includes(r))) return;
        throw new CampusError(
            "POLICY_DENIED",
            `En el curso ${courseId} tu rol es ${describeRoles(roles)}: ${what} son datos de terceros y exigen rol docente o superior (${staff.join(", ")}). No se consultaron.`,
        );
    }

    /** Escrituras: curso en el alcance y rol de profesor, gestor o superior (la allowlist de escritura se controla aparte). */
    async assertWriter(courseId: number): Promise<void> {
        const roles = await this.rolesIn(courseId);
        if (roles.some((r) => this.profile.write_role_shortnames.includes(r))) return;
        throw new CampusError(
            "POLICY_DENIED",
            `En el curso ${courseId} tu rol es ${describeRoles(roles)}: para escribir hace falta rol de profesor, gestor o superior (${this.profile.write_role_shortnames.join(", ")}). No se armó ningún plan.`,
        );
    }

    private async ownRoles(userId: number, courseId: number): Promise<string[]> {
        // Moodle deduplica por usuario si se piden varios cursos juntos: una consulta por curso.
        const profiles = await this.session.transport.call("core_user_get_course_user_profiles", { userlist: [{ userid: userId, courseid: courseId }] }, CourseUserProfilesSchema);
        return (profiles.find((p) => p.id === userId)?.roles ?? []).map((r) => r.shortname);
    }

    private async doResolve(): Promise<ResolvedScope> {
        const site = await this.session.verified();
        const t = this.session.transport;
        const enrolled = await t.call("core_enrol_get_users_courses", { userid: site.info.userid }, UserCoursesSchema);
        const base = (c: (typeof enrolled)[number]): ScopedCourse => ({
            course_id: c.id,
            shortname: c.shortname ?? null,
            fullname: c.fullname ?? null,
            visible: c.visible == null ? null : c.visible === 1,
            startdate: c.startdate ?? null,
            enddate: c.enddate ?? null,
            roles: null,
        });
        let scope: ResolvedScope;
        if (this.profile.course_scope === "allowlist") {
            const allowed = this.profile.allowed_course_ids;
            scope = {
                mode: "allowlist",
                courses: enrolled.filter((c) => allowed.includes(c.id)).map(base),
                missing: allowed.filter((id) => !enrolled.some((c) => c.id === id)),
                resolved_at: new Date(this.now()).toISOString(),
            };
        } else {
            const mode = this.profile.course_scope;
            const teacherRoles = new Set(this.profile.teacher_role_shortnames);
            const candidates = enrolled.filter((c) => !this.profile.excluded_course_ids.includes(c.id));
            const withRoles = await Promise.all(candidates.map(async (c) => ({ ...base(c), roles: await this.ownRoles(site.info.userid, c.id) })));
            scope = {
                mode,
                // `enrolled`: cualquier rol (también estudiante); `teaching`: sólo rol docente.
                courses: mode === "enrolled" ? withRoles : withRoles.filter((c) => c.roles.some((r) => teacherRoles.has(r))),
                missing: [],
                resolved_at: new Date(this.now()).toISOString(),
            };
        }
        this.logger.log("info", "course_scope_resolved", { mode: scope.mode, courses: scope.courses.length });
        this.cache = { at: this.now(), scope };
        return scope;
    }

    invalidate() {
        this.cache = null;
        this.allowlistRoles.clear();
    }
}

function describeRoles(roles: string[]) {
    return roles.length ? roles.join(", ") : "ninguno";
}

function denied(courseId: number, why: "allowlist" | "excluded" | "teaching" | "enrolled") {
    const reason =
        why === "allowlist"
            ? "no está en la allowlist del perfil"
            : why === "excluded"
              ? "está excluido en el perfil"
              : why === "teaching"
                ? "no figura entre tus cursos con rol docente en Moodle"
                : "no figura entre los cursos donde estás matriculado en Moodle";
    return new CampusError("POLICY_DENIED", `El curso ${courseId} ${reason}. No se consultó su contenido.`);
}
