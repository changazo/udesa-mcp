import { join } from "node:path";
import type { Renderer } from "../documents/render.js";
import type { DownloadLinks } from "../remote/download-links.js";
import { createApp } from "../app.js";
import type { FetchLike } from "../moodle/transport.js";
import type { MetadataStore } from "../session/metadata.js";
import type { SecretStore } from "../session/secret-store.js";
import type { Logger } from "../util/logger.js";
import type { WebSessionSource } from "../web/session.js";
import { NoOutOfBandConfirmer, WindowsDialogConfirmer, type Confirmer } from "./confirm.js";
import { WriteEngine } from "./engine.js";
import type { WriteIntent } from "./intent.js";
import { FORUM_INTENTS } from "./intents/forums.js";
import { syntheticMarkerIntent } from "./intents/synthetic.js";
import { W2_INTENTS } from "./intents/w2.js";
import { createAssignmentIntent } from "./intents/activities.js";
import { LAYOUT_INTENTS } from "./intents/layout.js";
import { gradeIntent } from "./intents/grading.js";
import { ATTENDANCE_INTENTS } from "./intents/attendance.js";
import { QUIZ_INTENTS } from "./intents/quiz.js";
import { GROUP_INTENTS } from "./intents/groups.js";
import { questionImportIntent } from "./intents/questions.js";
import { quizAddQuestionsIntent } from "./intents/quiz-slots.js";
import { createContentIntent } from "./intents/content.js";
import { editDatesIntent } from "./intents/edit-dates.js";
import { assignOverrideIntent } from "./intents/assign-override.js";
import { deleteContentIntent } from "./intents/delete-content.js";
import { createSectionIntent } from "./intents/create-section.js";
import { questionStatusIntent } from "./intents/question-status.js";
import { postAttachmentsIntent } from "./intents/post-attachments.js";
import { forumGradeIntent } from "./intents/forum-grade.js";
import { quizGradeIntent } from "./intents/quiz-grade.js";
import { quizAddRandomIntent, quizSlotMaxmarkIntent } from "./intents/quiz-structure-edit.js";
import { GROUPING_INTENTS } from "./intents/groupings.js";
import { editActivityTextIntent } from "./intents/edit-text.js";
import { SMALL_EDIT_INTENTS } from "./intents/small-edits.js";
import { choiceOptionsIntent } from "./intents/choice-options.js";
import { activityFilesIntent } from "./intents/activity-files.js";
import { bookChapterIntent } from "./intents/book-chapters.js";
import { glossaryEntryIntent } from "./intents/glossary-entries.js";
import { wikiPageIntent } from "./intents/wiki-pages.js";
import { dataEntryIntent } from "./intents/data-entries.js";
import { dataFieldIntent } from "./intents/data-fields.js";
import { lessonPageIntent } from "./intents/lesson-pages.js";
import { activitySettingsIntent } from "./intents/activity-settings.js";
import { duplicateActivityIntent } from "./intents/duplicate.js";
import { calendarEventDeleteIntent } from "./intents/calendar-delete.js";
import { REMOVE_EXISTING_INTENTS } from "./intents/remove-existing.js";
import { moveSectionIntent } from "./intents/section-order.js";
import { EDIT_EXISTING_INTENTS } from "./intents/edit-existing.js";
import { quizLayoutIntent } from "./intents/quiz-layout.js";
import { lessonQuestionIntent } from "./intents/lesson-questions.js";
import { FORUM_MODERATION_INTENTS } from "./intents/forum-moderation.js";
import { gradingDefinitionIntent } from "./intents/grading-definition.js";
import { gradeAdvancedIntent } from "./intents/grade-advanced.js";
import { GRADEBOOK_INTENTS } from "./intents/gradebook.js";
import { questionnaireQuestionIntent } from "./intents/questionnaire-questions.js";
import { overrideEditIntent } from "./intents/override-edit.js";
import { glossaryCategoryIntent } from "./intents/glossary-categories.js";
import { choicegroupGroupsIntent } from "./intents/choicegroup-groups.js";
import { h5pContentIntent } from "./intents/h5p.js";
import { labLtiExerciseIntent, labLtiToolIntent } from "./intents/lab-lti.js";
import { STUDENT_WORK_INTENTS } from "./intents/student-work.js";
import { sendMessageIntent } from "./intents/messages.js";
import { PlanSigner, signingAccount } from "./plan.js";
import type { Risk, WriteProfile } from "./policy.js";
import { createWriteServer } from "./server.js";
import { FileWriteStore, type WriteStore } from "./store.js";
import { WriteTransport } from "./transport.js";
import { WebWriter } from "./web.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_INSTRUCTIONS, registerReadTools } from "../mcp/server.js";
import { registerWriteTools, WRITE_INSTRUCTIONS, WRITE_PRODUCT_VERSION } from "./server.js";

export const FULL_PRODUCT_NAME = "udesa-campus-mcp-completo";
const FULL_INSTRUCTIONS = `MCP COMPLETO del Campus Virtual (perfil docente-completo): lecturas y escrituras en un solo conector.

LECTURAS
${READ_INSTRUCTIONS}

ESCRITURAS (tools campus_plan_*, campus_execute_plan, campus_undo_action…)
${WRITE_INSTRUCTIONS}`;

/**
 * Intenciones registradas. W1: foros. La de prueba de W0 sólo existe contra el Moodle sintético
 * (.test). Que una intención exista no habilita nada: hace falta la capacidad en write_policy.
 */
const ALL_INTENTS: WriteIntent<any>[] = [...FORUM_INTENTS, ...W2_INTENTS, ...LAYOUT_INTENTS, gradeIntent, ...ATTENDANCE_INTENTS, ...QUIZ_INTENTS, ...GROUP_INTENTS, questionImportIntent, quizAddQuestionsIntent, createContentIntent, editDatesIntent, assignOverrideIntent, deleteContentIntent, createSectionIntent, questionStatusIntent, postAttachmentsIntent, forumGradeIntent, quizGradeIntent, quizAddRandomIntent, quizSlotMaxmarkIntent, ...GROUPING_INTENTS, editActivityTextIntent, ...SMALL_EDIT_INTENTS, choiceOptionsIntent, activityFilesIntent, bookChapterIntent, glossaryEntryIntent, wikiPageIntent, dataEntryIntent, dataFieldIntent, lessonPageIntent, activitySettingsIntent, duplicateActivityIntent, calendarEventDeleteIntent, ...REMOVE_EXISTING_INTENTS, moveSectionIntent, ...EDIT_EXISTING_INTENTS, quizLayoutIntent, lessonQuestionIntent, ...FORUM_MODERATION_INTENTS, gradingDefinitionIntent, gradeAdvancedIntent, ...GRADEBOOK_INTENTS, questionnaireQuestionIntent, overrideEditIntent, glossaryCategoryIntent, choicegroupGroupsIntent, h5pContentIntent, labLtiToolIntent, labLtiExerciseIntent, ...STUDENT_WORK_INTENTS, sendMessageIntent, createAssignmentIntent, syntheticMarkerIntent];

/** En remoto no hay archivos locales: la importación de preguntas sólo existe en el servidor local. */
const LOCAL_FILE_INTENTS = new Set(["question_import"]);

export function availableIntents(profile: WriteProfile, opts: { remote?: boolean } = {}): Map<string, WriteIntent<any>> {
    return new Map(ALL_INTENTS.filter((i) => (!i.synthetic_only || profile.synthetic_site) && !(opts.remote && LOCAL_FILE_INTENTS.has(i.name))).map((i) => [i.name, i]));
}

export function writeStateLocation(stateDir: string, writeProfileId: string) {
    return join(stateDir, "profiles", writeProfileId);
}

export interface WriteAppDeps {
    profile: WriteProfile;
    /** Carpeta de descargas de campus_get_original_file (servidor local; ADR-112). */
    downloadDir?: string | null;
    renderer?: Renderer | null;
    downloadLinks?: DownloadLinks | null;
    secrets: SecretStore;
    /** Metadata del perfil de LECTURA (identidad verificada compartida). */
    metadata: MetadataStore;
    logger: Logger;
    /** Directorio del estado de escritura (planes, auditoría, interruptor). */
    location: string;
    fetch?: FetchLike;
    now?: () => Date;
    webSource?: WebSessionSource;
    webRenewHint?: string;
    /** User-Agent de las peticiones web (ADR-121). */
    webUserAgent?: string;
    loginHint?: string;
    /** Almacén de escritura (por defecto, archivos en `location`; en remoto, KV). */
    store?: WriteStore;
    /** Modo remoto (W5): aprobación por página web, techo de riesgo y sin archivos locales. */
    remote?: { approvalUrl: (planId: string) => string; maxRisk: Risk };
    /** Canal fuera de banda del servidor MCP (por defecto, diálogo de Windows si el perfil lo habilita). */
    confirmer?: Confirmer;
}

/** Raíz de composición del modo escritura: núcleo de lectura (mismo token) + núcleo de escritura. */
export function createWriteApp(deps: WriteAppDeps) {
    const read = createApp({
        profile: deps.profile.read_profile,
        secrets: deps.secrets,
        metadata: deps.metadata,
        logger: deps.logger,
        fetch: deps.fetch,
        now: deps.now,
        webSource: deps.webSource,
        webRenewHint: deps.webRenewHint,
        webUserAgent: deps.webUserAgent,
        loginHint: deps.loginHint,
        downloadDir: deps.downloadDir ?? null,
        renderer: deps.renderer ?? null,
        downloadLinks: deps.downloadLinks ?? null,
    });
    const transport = new WriteTransport({
        siteUrl: deps.profile.read_profile.site_url,
        tokenSource: read.session,
        logger: deps.logger,
        timeoutMs: deps.profile.read_profile.limits.http_timeout_seconds * 1000,
        fetch: deps.fetch,
    });
    const store: WriteStore = deps.store ?? new FileWriteStore(deps.location);
    const signer = new PlanSigner(deps.secrets, signingAccount(deps.profile.profile_id));
    const intents = availableIntents(deps.profile, { remote: !!deps.remote });
    const web = new WebWriter(read.web, deps.logger);
    const engine = new WriteEngine({ profile: deps.profile, store, signer, transport, web, read, intents, logger: deps.logger, now: deps.now, remote: deps.remote });
    const c = deps.profile.policy.confirmation;
    const confirmer = deps.confirmer ?? (c.dialog ? new WindowsDialogConfirmer(c.dialog_timeout_seconds * 1000) : new NoOutOfBandConfirmer("El diálogo está deshabilitado en el perfil: aprobá desde la terminal."));
    const writeDeps = { engine, confirmer, intents, logger: deps.logger, mode: deps.remote ? ("remoto" as const) : ("local" as const) };
    const server = () => createWriteServer(writeDeps);
    /** Perfil docente-completo (ADR-062): UN conector con las tools de lectura y las de escritura. */
    const fullServer = () => {
        const s = new McpServer({ name: FULL_PRODUCT_NAME, version: WRITE_PRODUCT_VERSION }, { instructions: FULL_INSTRUCTIONS });
        registerReadTools(s, read.serverDeps);
        return registerWriteTools(s, writeDeps);
    };
    return { read, transport, web, store, signer, intents, engine, confirmer, server, fullServer };
}

export type WriteApp = ReturnType<typeof createWriteApp>;
