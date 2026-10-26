import { z } from "zod";

/**
 * Validación runtime de respuestas Moodle. `z.object` descarta claves no declaradas: la
 * proyección de campos seguros ocurre acá (CAP-01). Por eso SiteInfo NO declara credenciales ni
 * identificadores de login (`userprivateaccesskey`, `username`). El nombre de la cuenta (`fullname`)
 * sí: vive sólo en memoria y lo que se guarda o reporta (metadata de sesión, reporte de capacidades,
 * estado) se arma con campos explícitos que no lo incluyen (ADR-124).
 *
 * Los campos opcionales reflejan diferencias entre versiones de Moodle; se contrastan contra la
 * versión real en la prueba autenticada.
 */
const optNum = z.number().nullable().optional();
const optStr = z.string().nullable().optional();
/** Moodle a veces serializa booleanos como 0/1 o "0"/"1". */
const looseBool = z
    .union([z.boolean(), z.number(), z.string()])
    .nullable()
    .optional()
    .transform((v) => (v === undefined || v === null ? null : v === true || v === 1 || v === "1" || v === "true"));

export const SiteInfoSchema = z.object({
    sitename: optStr,
    siteurl: z.string(),
    userid: z.number().int().positive(),
    /** Nombre de la cuenta verificada: para mostrarlo en lo propio (p. ej. tus intentos). Nunca se persiste. */
    fullname: optStr,
    release: optStr,
    version: z.union([z.string(), z.number()]).nullable().optional().transform((v) => (v == null ? null : String(v))),
    lang: optStr,
    functions: z.array(z.object({ name: z.string(), version: z.union([z.string(), z.number()]).nullable().optional() })).optional(),
    downloadfiles: optNum,
    uploadfiles: optNum,
});
export type SiteInfo = z.infer<typeof SiteInfoSchema>;

export const UserCoursesSchema = z.array(
    z.object({
        id: z.number().int().positive(),
        shortname: optStr,
        fullname: optStr,
        visible: optNum,
        startdate: optNum,
        enddate: optNum,
    }),
);

const ModuleContentSchema = z.object({
    type: z.string(),
    filename: optStr,
    filepath: optStr,
    filesize: optNum,
    fileurl: optStr,
    timemodified: optNum,
    mimetype: optStr,
});

export const CourseContentsSchema = z.array(
    z.object({
        id: z.number().int(),
        name: optStr,
        section: optNum,
        visible: optNum,
        uservisible: looseBool,
        summary: optStr,
        /** Moodle 5: una sección delegada (subsección) trae component=mod_subsection e itemid=instancia del módulo. */
        component: optStr,
        itemid: optNum,
        modules: z
            .array(
                z.object({
                    id: z.number().int().positive(),
                    name: optStr,
                    instance: optNum,
                    modname: z.string(),
                    /** Contexto del módulo (para bancos de preguntas: contexto del banco). */
                    contextid: optNum,
                    /** Modo de grupos de la actividad (0 sin grupos, 1 separados, 2 visibles). */
                    groupmode: optNum,
                    /** Restricciones de acceso configuradas (JSON de Moodle); null = sin restricciones. */
                    availability: z.string().nullable().optional(),
                    url: optStr,
                    visible: optNum,
                    uservisible: looseBool,
                    visibleoncoursepage: optNum,
                    availabilityinfo: optStr,
                    /** Texto de etiquetas y descripciones mostradas en la página del curso. */
                    description: optStr,
                    /** Fechas de la actividad tal como las muestra la página del curso (apertura, cierre, vencimiento). */
                    dates: z.array(z.object({ label: optStr, timestamp: optNum })).optional(),
                    contents: z.array(ModuleContentSchema).optional(),
                }),
            )
            .default([]),
    }),
);
export type CourseContents = z.infer<typeof CourseContentsSchema>;

export const ForumsSchema = z.array(
    z.object({
        id: z.number().int().positive(),
        course: z.number().int().positive(),
        type: optStr,
        name: optStr,
        cmid: optNum,
        numdiscussions: optNum,
        /** Seguimiento de no leídos para la cuenta: condiciona el marcado automático al leer posts. */
        istracked: looseBool,
        trackingtype: optNum,
        // Descripción y ajustes (ADR-083).
        intro: optStr,
        introformat: optNum,
        forcesubscribe: optNum,
        maxattachments: optNum,
        duedate: optNum,
        cutoffdate: optNum,
        grade_forum: optNum,
        lockdiscussionafter: optNum,
    }),
);
export type Forum = z.infer<typeof ForumsSchema>[number];

const AttachmentSchema = z.object({
    filename: optStr,
    filepath: optStr,
    filesize: optNum,
    mimetype: optStr,
    url: optStr,
    fileurl: optStr,
    timemodified: optNum,
});
export type Attachment = z.infer<typeof AttachmentSchema>;

const WarningsSchema = z
    .array(z.object({ item: optStr, itemid: optNum, warningcode: optStr, message: optStr }))
    .optional();

export const DiscussionsSchema = z.object({
    discussions: z.array(
        z.object({
            /** id del primer post (no de la discusión). */
            id: z.number().int().positive(),
            /** id de la discusión. */
            discussion: z.number().int().positive(),
            name: optStr,
            subject: optStr,
            message: optStr,
            messageformat: optNum,
            userfullname: optStr,
            created: optNum,
            modified: optNum,
            timemodified: optNum,
            timestart: optNum,
            timeend: optNum,
            groupid: optNum,
            pinned: looseBool,
            numreplies: optNum,
            attachment: z.union([z.boolean(), z.number(), z.string()]).nullable().optional(),
            attachments: z.array(AttachmentSchema).optional(),
        }),
    ),
    warnings: WarningsSchema,
});
export type Discussion = z.infer<typeof DiscussionsSchema>["discussions"][number];

export const DiscussionPostsSchema = z.object({
    posts: z.array(
        z.object({
            id: z.number().int().positive(),
            subject: optStr,
            message: optStr,
            messageformat: optNum,
            author: z.object({ id: optNum, fullname: optStr }).nullable().optional(),
            discussionid: optNum,
            parentid: optNum,
            hasparent: looseBool,
            timecreated: optNum,
            timemodified: optNum,
            isdeleted: looseBool,
            isprivatereply: looseBool,
            attachments: z.array(AttachmentSchema).optional(),
        }),
    ),
    forumid: optNum,
    courseid: optNum,
    warnings: WarningsSchema,
});
export type DiscussionPosts = z.infer<typeof DiscussionPostsSchema>;

/** Error estándar del REST de Moodle (puede venir con HTTP 200). */
export const MoodleExceptionSchema = z.object({
    exception: z.string(),
    errorcode: optStr,
    message: optStr,
});


/** Sólo id de usuario, curso y roles. Moodle devuelve mucho más (email, etc.): se descarta. */
export const CourseUserProfilesSchema = z.array(
    z.object({
        id: z.number().int().positive(),
        enrolledcourses: z.array(z.object({ id: z.number().int().positive() })).optional(),
        roles: z.array(z.object({ roleid: z.number().int(), shortname: z.string(), name: optStr })).optional(),
    }),
);

// ---------- Tareas ----------

const WarningList = z.array(z.object({ item: optStr, itemid: optNum, warningcode: optStr, message: optStr })).optional();

const FileItemSchema = z.object({
    filename: optStr,
    filepath: optStr,
    filesize: optNum,
    fileurl: optStr,
    mimetype: optStr,
    timemodified: optNum,
});

export const AssignmentsSchema = z.object({
    courses: z.array(
        z.object({
            id: z.number().int().positive(),
            assignments: z
                .array(
                    z.object({
                        id: z.number().int().positive(),
                        cmid: z.number().int().positive(),
                        course: z.number().int().positive(),
                        name: optStr,
                        nosubmissions: optNum,
                        submissiondrafts: optNum,
                        duedate: optNum,
                        allowsubmissionsfromdate: optNum,
                        cutoffdate: optNum,
                        gradingduedate: optNum,
                        timemodified: optNum,
                        teamsubmission: optNum,
                        requireallteammemberssubmit: optNum,
                        blindmarking: optNum,
                        revealidentities: optNum,
                        maxattempts: optNum,
                        markingworkflow: optNum,
                        timelimit: optNum,
                        preventsubmissionnotingroup: optNum,
                        attemptreopenmethod: optStr,
                        teamsubmissiongroupingid: optNum,
                        grade: optNum,
                        intro: optStr,
                        introformat: optNum,
                        introattachments: z.array(FileItemSchema).optional(),
                        configs: z.array(z.object({ plugin: z.string(), subtype: optStr, name: z.string(), value: z.string().nullable().optional() })).optional(),
                    }),
                )
                .default([]),
        }),
    ),
    warnings: WarningList,
});
export type Assignment = z.infer<typeof AssignmentsSchema>["courses"][number]["assignments"][number];

/** Participantes de una tarea. Se descartan email, username, idnumber y demás datos de perfil. */
export const AssignParticipantsSchema = z.array(
    z.object({
        id: z.number().int().positive(),
        fullname: optStr,
        groups: z.array(z.object({ id: z.number().int(), name: optStr })).optional(),
        submitted: looseBool,
        requiregrading: looseBool,
        grantedextension: looseBool,
        submissionstatus: optStr,
        blindmarking: looseBool,
    }),
);
export type AssignParticipant = z.infer<typeof AssignParticipantsSchema>[number];

/** Banderas por usuario de una tarea (prórroga y bloqueo). Lectura SQL pura: no crea registros (ADR-051). */
export const AssignUserFlagsSchema = z.object({
    assignments: z
        .array(
            z.object({
                assignmentid: z.number().int(),
                userflags: z.array(z.object({ userid: z.number().int(), locked: optNum, extensionduedate: optNum })).default([]),
            }),
        )
        .default([]),
    warnings: WarningList,
});

const SubmissionPluginSchema = z.object({
    type: z.string(),
    name: optStr,
    fileareas: z.array(z.object({ area: optStr, files: z.array(FileItemSchema).optional() })).optional(),
    editorfields: z.array(z.object({ name: optStr, text: optStr, format: optNum })).optional(),
});

const SubmissionSchema = z.object({
    id: optNum,
    userid: optNum,
    groupid: optNum,
    attemptnumber: optNum,
    timecreated: optNum,
    timemodified: optNum,
    status: optStr,
    plugins: z.array(SubmissionPluginSchema).optional(),
});
export type Submission = z.infer<typeof SubmissionSchema>;

export const AssignSubmissionsSchema = z.object({
    assignments: z.array(z.object({ assignmentid: z.number().int().positive(), submissions: z.array(SubmissionSchema).default([]) })),
    warnings: WarningList,
});

/**
 * Estado de UNA entrega. `feedback` (nota y devolución del docente) se proyecta, pero el servicio
 * sólo lo expone con include_feedback. Del registro de nota se descarta quién calificó (`grader`).
 */
export const SubmissionStatusSchema = z.object({
    feedback: z
        .object({
            grade: z.object({ grade: optStr, timemodified: optNum, attemptnumber: optNum }).nullable().optional(),
            gradefordisplay: optStr,
            gradeddate: optNum,
            plugins: z.array(SubmissionPluginSchema).optional(),
        })
        .nullable()
        .optional(),
    lastattempt: z
        .object({
            submission: SubmissionSchema.nullable().optional(),
            teamsubmission: SubmissionSchema.nullable().optional(),
            submissiongroup: optNum,
            locked: looseBool,
            graded: looseBool,
            gradingstatus: optStr,
            extensionduedate: optNum,
            timelimit: optNum,
        })
        .nullable()
        .optional(),
    warnings: WarningList,
});

export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

// ---------- Calendario y recursos ----------

export const CalendarEventsSchema = z.object({
    events: z.array(
        z.object({
            id: z.number().int().positive(),
            name: optStr,
            description: optStr,
            format: optNum,
            courseid: optNum,
            groupid: optNum,
            modulename: optStr,
            instance: optNum,
            eventtype: optStr,
            timestart: optNum,
            timeduration: optNum,
            visible: optNum,
        }),
    ),
    warnings: WarningList,
});

export const PagesSchema = z.object({
    pages: z.array(
        z.object({
            id: z.number().int().positive(),
            coursemodule: z.number().int().positive(),
            course: z.number().int().positive(),
            name: optStr,
            intro: optStr,
            content: optStr,
            contentformat: optNum,
            timemodified: optNum,
            visible: looseBool,
        }),
    ),
});

export const UrlsSchema = z.object({
    urls: z.array(
        z.object({
            id: z.number().int().positive(),
            coursemodule: z.number().int().positive(),
            course: z.number().int().positive(),
            name: optStr,
            intro: optStr,
            externalurl: optStr,
            timemodified: optNum,
        }),
    ),
});

export const ResourcesSchema = z.object({
    resources: z.array(
        z.object({
            id: z.number().int().positive(),
            coursemodule: z.number().int().positive(),
            course: z.number().int().positive(),
            name: optStr,
            intro: optStr,
            contentfiles: z.array(FileItemSchema).optional(),
            timemodified: optNum,
        }),
    ),
});

// ---------- Lectura ampliada II ----------

const W = z.array(z.object({ item: optStr, itemid: optNum, warningcode: optStr, message: optStr })).optional();

export const UpdatesSinceSchema = z.object({
    instances: z.array(
        z.object({
            contextlevel: z.string(),
            id: z.number().int(),
            updates: z.array(z.object({ name: z.string(), timeupdated: optNum, itemids: z.array(z.number()).optional() })).default([]),
        }),
    ),
    warnings: W,
});

/** Cuestionarios. Se descartan `password` y `subnet` (acceso al cuestionario). */
export const QuizzesSchema = z.object({
    quizzes: z.array(
        z.object({
            id: z.number().int().positive(),
            coursemodule: z.number().int().positive(),
            course: z.number().int().positive(),
            name: optStr,
            intro: optStr,
            introformat: optNum,
            visible: looseBool,
            timeopen: optNum,
            timeclose: optNum,
            timelimit: optNum,
            overduehandling: optStr,
            graceperiod: optNum,
            attempts: optNum,
            grademethod: optNum,
            grade: optNum,
            sumgrades: optNum,
            questionsperpage: optNum,
            navmethod: optStr,
            hasquestions: optNum,
            timemodified: optNum,
            browsersecurity: optStr,
            preferredbehaviour: optStr,
            attemptonlast: optNum,
            decimalpoints: optNum,
            shuffleanswers: optNum,
            delay1: optNum,
            delay2: optNum,
            groupmode: optNum,
            groupingid: optNum,
        }),
    ),
    warnings: W,
});

/** Grupos. Se descarta `enrolmentkey`. */
export const GroupsSchema = z.array(
    z.object({ id: z.number().int().positive(), courseid: z.number().int().positive(), name: optStr, description: optStr, descriptionformat: optNum, idnumber: optStr, visibility: optNum }),
);

export const GroupingsSchema = z.array(z.object({ id: z.number().int().positive(), courseid: z.number().int().positive(), name: optStr, idnumber: optStr, description: optStr }));

/** Participantes. Con email, legajo, país, descripción y foto (ADR-124); sin username ni otros datos del perfil. */
export const EnrolledUsersSchema = z.array(
    z.object({
        id: z.number().int().positive(),
        fullname: optStr,
        email: optStr,
        idnumber: optStr,
        country: optStr,
        description: optStr,
        descriptionformat: optNum,
        profileimageurl: optStr,
        lastaccess: optNum,
        lastcourseaccess: optNum,
        roles: z.array(z.object({ roleid: optNum, shortname: z.string() })).optional(),
        groups: z.array(z.object({ id: z.number().int(), name: optStr })).optional(),
    }),
);

export const ChoicegroupOptionsSchema = z.object({
    options: z.array(z.object({ id: z.number().int(), groupid: optNum, name: optStr, maxanswers: optNum, countanswers: optNum, disabled: looseBool })),
    warnings: W,
});

/** Libro de calificaciones. Con `useridnumber` (legajo, ADR-124); se descarta `courseidnumber`. */
export const GradeItemsSchema = z.object({
    usergrades: z.array(
        z.object({
            userid: z.number().int().positive(),
            userfullname: optStr,
            useridnumber: optStr,
            gradeitems: z.array(
                z.object({
                    id: z.number().int(),
                    itemname: optStr,
                    itemtype: optStr,
                    itemmodule: optStr,
                    iteminstance: optNum,
                    cmid: optNum,
                    categoryid: optNum,
                    graderaw: optNum,
                    gradeformatted: optStr,
                    grademin: optNum,
                    grademax: optNum,
                    percentageformatted: optStr,
                    weightformatted: optStr,
                    gradedatesubmitted: optNum,
                    gradedategraded: optNum,
                    gradeishidden: looseBool,
                    gradehiddenbydate: looseBool,
                    gradeislocked: looseBool,
                    gradeisoverridden: looseBool,
                    locked: looseBool,
                    feedback: optStr,
                    feedbackformat: optNum,
                }),
            ),
        }),
    ),
    warnings: W,
});

const AttemptSchema = z.object({
    id: z.number().int().positive(),
    quiz: z.number().int().positive(),
    userid: z.number().int().positive(),
    attempt: optNum,
    state: optStr,
    preview: optNum,
    timestart: optNum,
    timefinish: optNum,
    timemodified: optNum,
    sumgrades: optNum,
});

export const QuizAttemptsSchema = z.object({ attempts: z.array(AttemptSchema), warnings: W });

const ReviewOptionSchema = z.array(z.object({ name: z.string(), value: z.number() })).default([]);
/** mod_quiz_get_combined_review_options: «some» = en algún momento; «all» = en todos los momentos. */
export const CombinedReviewOptionsSchema = z.object({ someoptions: ReviewOptionSchema, alloptions: ReviewOptionSchema, warnings: W });

export const AttemptReviewSchema = z.object({
    grade: z.union([z.number(), z.string()]).nullable().optional(),
    attempt: AttemptSchema,
    questions: z.array(
        z.object({
            slot: z.number().int(),
            type: optStr,
            page: optNum,
            questionnumber: optStr,
            number: optNum,
            html: optStr,
            state: optStr,
            status: optStr,
            mark: z.union([z.string(), z.number()]).nullable().optional(),
            maxmark: optNum,
            flagged: looseBool,
        }),
    ),
    warnings: W,
});

const MessageSchema = z.object({ id: z.number().int(), useridfrom: optNum, text: optStr, timecreated: optNum });
const MemberSchema = z.object({ id: z.number().int(), fullname: optStr, isdeleted: looseBool });

export const ConversationsSchema = z.object({
    conversations: z.array(
        z.object({
            id: z.number().int().positive(),
            name: optStr,
            type: optNum,
            membercount: optNum,
            isread: looseBool,
            unreadcount: optNum,
            isfavourite: looseBool,
            members: z.array(MemberSchema).default([]),
            messages: z.array(MessageSchema).default([]),
        }),
    ),
});

export const ConversationMessagesSchema = z.object({
    id: z.number().int().positive(),
    members: z.array(MemberSchema).default([]),
    messages: z.array(MessageSchema).default([]),
});

export const CommentsSchema = z.object({
    comments: z.array(z.object({ id: z.number().int(), content: optStr, format: optNum, timecreated: optNum, fullname: optStr, userid: optNum })),
    count: optNum,
    warnings: W,
});

// ---------- Notificaciones ----------

/** Notificaciones del usuario. Con remitente y cuerpo completo (ADR-124); se descarta el ícono. */
export const PopupNotificationsSchema = z.object({
    notifications: z
        .array(
            z.object({
                id: z.number().int(),
                useridfrom: optNum,
                userfromfullname: optStr,
                subject: optStr,
                smallmessage: optStr,
                fullmessage: optStr,
                fullmessageformat: optNum,
                fullmessagehtml: optStr,
                contexturl: optStr,
                contexturlname: optStr,
                timecreated: optNum,
                timeread: optNum,
                read: looseBool,
                component: optStr,
                eventtype: optStr,
            }),
        )
        .default([]),
    unreadcount: optNum,
});

// ---------- Contenido de la app móvil (sólo mod_attendance, ver MOBILE_CONTENT_POLICY) ----------

export const MobileContentSchema = z.object({
    templates: z.array(z.object({ id: optStr, html: z.string().default("") })).default([]),
    otherdata: z.union([z.array(z.object({ name: z.string(), value: z.unknown() })), z.record(z.string(), z.unknown()), z.string()]).optional(),
});

// ---------- Resumen de actividades (Moodle 5) ----------

/** core_courseformat_get_overview_information: celdas con JSON propio de cada tipo de contenido. */
export const CourseOverviewSchema = z.object({
    courseid: optNum,
    hasintegration: looseBool,
    headers: z.array(z.object({ name: optStr, key: z.string() })).default([]),
    activities: z
        .array(
            z.object({
                name: optStr,
                modname: optStr,
                cmid: z.number().int(),
                url: optStr,
                haserror: looseBool,
                items: z
                    .array(
                        z.object({
                            key: z.string(),
                            name: optStr,
                            exportertype: optStr,
                            alertlabel: optStr,
                            alertcount: z.union([z.number(), z.string()]).nullable().optional(),
                            contentjson: optStr,
                        }),
                    )
                    .default([]),
            }),
        )
        .default([]),
});
export type CourseOverview = z.infer<typeof CourseOverviewSchema>;

// ---------- Fechas efectivas de un participante en una tarea ----------

/** mod_assign_get_participant: fechas con overrides de usuario/grupo aplicados (no incluye la prórroga). Sin datos personales. */
export const AssignParticipantSchema = z.object({
    id: z.number().int(),
    grantedextension: looseBool,
    blindmarking: looseBool,
    allowsubmissionsfromdate: optNum,
    duedate: optNum,
    cutoffdate: optNum,
    groupid: optNum,
    submissionstatus: optStr,
});

/** core_grades_get_gradeitems: nombre e etiqueta de categoría por ítem (no es un árbol ni trae totales). */
export const GradeItemLabelsSchema = z.object({
    gradeItems: z
        .array(z.object({ id: z.union([z.number(), z.string()]).transform((v) => Number(v)), itemname: optStr, category: optStr }))
        .default([]),
});

// ---------- Grupos de una actividad ----------

export const ActivityGroupModeSchema = z.object({ groupmode: z.number().int() });
export const ActivityAllowedGroupsSchema = z.object({
    groups: z.array(z.object({ id: z.number().int(), name: optStr })).default([]),
    canaccessallgroups: looseBool,
});

/** mod_quiz_get_overrides (AJAX). Se descarta `password` por proyección. */
export const QuizOverridesSchema = z.object({
    overrides: z
        .array(z.object({ id: z.number().int(), quiz: z.number().int(), userid: optNum, groupid: optNum, timeopen: optNum, timeclose: optNum, timelimit: optNum, attempts: optNum }))
        .default([]),
});

// ---------- Cierre de lecturas (2026-10-19) ----------

/** core_course_get_courses_by_field (field=id). Sin archivos de imagen ni filtros; contactos sólo id y nombre. */
export const CourseInfoSchema = z.object({
    courses: z
        .array(
            z.object({
                id: z.number().int(),
                fullname: optStr,
                shortname: optStr,
                categoryid: optNum,
                categoryname: optStr,
                summary: optStr,
                summaryformat: optNum,
                startdate: optNum,
                enddate: optNum,
                format: optStr,
                visible: optNum,
                showgrades: optNum,
                groupmode: optNum,
                groupmodeforce: optNum,
                enablecompletion: optNum,
                lang: optStr,
                showactivitydates: looseBool,
                contacts: z.array(z.object({ id: z.number().int(), fullname: optStr })).default([]),
                enrollmentmethods: z.array(z.string()).default([]),
                customfields: z.array(z.object({ name: optStr, shortname: optStr, type: optStr, value: z.union([z.string(), z.number()]).nullable().optional() })).default([]),
            }),
        )
        .default([]),
});

/** mod_quiz_get_quiz_access_information: reglas de acceso descritas por Moodle, para la cuenta que consulta. */
export const QuizAccessInfoSchema = z.object({
    canattempt: looseBool,
    canmanage: looseBool,
    canpreview: looseBool,
    canviewreports: looseBool,
    accessrules: z.array(z.string()).default([]),
    activerulenames: z.array(z.string()).default([]),
    preventaccessreasons: z.array(z.string()).default([]),
});

/** mod_quiz_get_user_best_grade. */
export const QuizBestGradeSchema = z.object({
    hasgrade: looseBool,
    grade: optNum,
    gradetopass: optNum,
});
