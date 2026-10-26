import { CampusError } from "../errors.js";

/**
 * Alcance de recursos. Registra relaciones observadas en respuestas autorizadas
 * (curso → cmid → foro → discusión → archivo) y rechaza relaciones inconsistentes (POL-01..03).
 * Un `course_id` declarado por el modelo nunca alcanza por sí solo.
 */
export interface ForumRecord {
    forum_id: number;
    course_id: number;
    cmid: number | null;
    type: string | null;
    name: string | null;
    /** Origen de la evidencia: lista de foros (con tipo) o estructura del curso (sin tipo). */
    evidence: "forums_by_courses" | "course_contents";
}

export interface DiscussionRecord {
    discussion_id: number;
    forum_id: number;
    course_id: number;
}

export type FileOriginKind = "post" | "module" | "assignment" | "submission" | "resource" | "section" | "feedback" | "question";

export interface AssignmentRecord {
    assignment_id: number;
    course_id: number;
    cmid: number;
    name: string | null;
    duedate: number | null;
    cutoffdate: number | null;
    team_submission: boolean;
    /** Corrección anónima sin identidades reveladas: no se cruzan datos que las revelen. */
    anonymous: boolean;
}

/** Archivo resuelto (desde un localizador) contra Moodle, listo para descargar. */
export interface FileRecord {
    /** URL normalizada de pluginfile, sin token. Nunca se expone con credenciales. */
    url: string;
    course_id: number;
    origin: { kind: FileOriginKind; id: number };
    name: string;
    mime_type: string | null;
    bytes: number | null;
    /** Avisos de la resolución (por ejemplo, el hilo se marcó como leído para ubicar el adjunto). */
    warnings?: string[];
}

export class ResourceRegistry {
    private allowed: ReadonlySet<number>;
    private readonly forums = new Map<number, ForumRecord & { seen_at: number }>();
    private readonly discussions = new Map<number, DiscussionRecord & { seen_at: number }>();
    private readonly assignments = new Map<number, AssignmentRecord & { seen_at: number }>();
    private readonly participants = new Map<number, { ids: Set<number>; seen_at: number }>();

    constructor(
        allowedCourseIds: number[],
        private readonly ttlMs = 30 * 60_000,
        private readonly now: () => number = Date.now,
    ) {
        this.allowed = new Set(allowedCourseIds);
    }

    get allowedCourseIds(): number[] {
        return [...this.allowed];
    }

    /**
     * Actualiza el conjunto permitido tras resolver el alcance (course_scope=teaching). Es una
     * segunda barrera: el servicio ya validó el curso con CourseScope antes de consultar.
     */
    setAllowed(ids: number[]): void {
        this.allowed = new Set(ids);
    }

    assertCourseAllowed(courseId: number): void {
        if (!this.allowed.has(courseId)) {
            throw new CampusError("POLICY_DENIED", `El curso ${courseId} no está en la allowlist del perfil. No se consultó su contenido.`);
        }
    }

    putForum(rec: ForumRecord): void {
        this.assertCourseAllowed(rec.course_id);
        const prev = this.fresh(this.forums.get(rec.forum_id));
        if (prev && prev.course_id !== rec.course_id) {
            throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Relación inconsistente: el foro ${rec.forum_id} figura en dos cursos.`);
        }
        // La evidencia con tipo (forums_by_courses) no se pisa con una más pobre.
        if (prev && prev.evidence === "forums_by_courses" && rec.evidence === "course_contents") return;
        this.forums.set(rec.forum_id, { ...rec, seen_at: this.now() });
    }

    getForum(forumId: number): ForumRecord | null {
        return this.fresh(this.forums.get(forumId));
    }

    forumsOfCourse(courseId: number): ForumRecord[] {
        return [...this.forums.values()].filter((f) => f.course_id === courseId && this.fresh(f));
    }

    putDiscussion(rec: DiscussionRecord): void {
        this.assertCourseAllowed(rec.course_id);
        const forum = this.getForum(rec.forum_id);
        if (!forum || forum.course_id !== rec.course_id) {
            throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La discusión ${rec.discussion_id} no pertenece a un foro verificado del curso ${rec.course_id}.`);
        }
        const prev = this.fresh(this.discussions.get(rec.discussion_id));
        if (prev && (prev.course_id !== rec.course_id || prev.forum_id !== rec.forum_id)) {
            throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Relación inconsistente para la discusión ${rec.discussion_id}.`);
        }
        this.discussions.set(rec.discussion_id, { ...rec, seen_at: this.now() });
    }

    getDiscussion(discussionId: number): DiscussionRecord | null {
        return this.fresh(this.discussions.get(discussionId));
    }

    putAssignment(rec: AssignmentRecord): void {
        this.assertCourseAllowed(rec.course_id);
        const prev = this.fresh(this.assignments.get(rec.assignment_id));
        if (prev && prev.course_id !== rec.course_id) {
            throw new CampusError("RESOURCE_OUT_OF_SCOPE", `Relación inconsistente: la tarea ${rec.assignment_id} figura en dos cursos.`);
        }
        this.assignments.set(rec.assignment_id, { ...rec, seen_at: this.now() });
    }

    getAssignment(assignmentId: number): AssignmentRecord | null {
        return this.fresh(this.assignments.get(assignmentId));
    }

    /** Participantes vistos en list_participants de una tarea (para validar pedidos de entregas). */
    putParticipants(assignmentId: number, ids: number[]): void {
        this.participants.set(assignmentId, { ids: new Set(ids), seen_at: this.now() });
    }

    getParticipants(assignmentId: number): ReadonlySet<number> | null {
        return this.fresh(this.participants.get(assignmentId))?.ids ?? null;
    }

    /** Ante cambio de identidad o de sesión: se invalidan todas las relaciones. */
    clear(): void {
        this.forums.clear();
        this.discussions.clear();
        this.assignments.clear();
        this.participants.clear();
    }

    private fresh<T extends { seen_at: number }>(rec: T | undefined): T | null {
        if (!rec) return null;
        return this.now() - rec.seen_at > this.ttlMs ? null : rec;
    }
}
