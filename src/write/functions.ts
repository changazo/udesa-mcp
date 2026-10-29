import { CampusError } from "../errors.js";
import { RESOURCE_DISPLAY, SETTINGS_KINDS, URL_DISPLAY, settingFields, type SettingDef } from "./settings-catalog.js";
import { RESERVED_PARAMS } from "../moodle/functions.js";
import { rootName } from "../moodle/serialize.js";
import { isSyntheticSite } from "./policy.js";
import { LAB_BASE_URL, LAB_LTI11_KEY } from "../h5p/content-types.js";

/**
 * Allowlists del transporte de ESCRITURA (directiva de escrituras §5.2, ADR-044). Son tablas
 * separadas de las de lectura: una función de lectura no se puede invocar por acá ni al revés.
 *
 * W1 agrega las funciones de foros (ADR-047). Las entradas `local_sintetico_*` son de prueba, no
 * existen en Moodle y el transporte sólo las emite contra un sitio del dominio reservado `.test`.
 * Cada fase agrega sus funciones con su validador, sus tests y su ADR. Que una función esté acá
 * no habilita nada: hace falta la capacidad en write_policy del perfil para ese curso.
 */

/** Valida los parámetros ya serializados ([clave, valor]); devuelve el motivo del rechazo o null. */
export type FlatValidator = (flat: [string, string][]) => string | null;

export interface RestWriteSpec {
    /**
     * write = escritura. verify_read = lectura de chequeo previo o de verificación que no está en la
     * allowlist del servidor de lectura (auditada como sin efectos). Las relecturas comunes usan el
     * núcleo de lectura.
     */
    kind: "write" | "verify_read";
    /** Sólo contra el Moodle sintético (sitio .test). */
    synthetic_only: boolean;
    validate: FlatValidator;
    /** Efecto declarado (se audita en HERRAMIENTAS y en el plan). */
    effects: string;
}

const int = (v: string | undefined) => v !== undefined && /^\d{1,12}$/.test(v);

/** Exige exactamente estas claves (sin repetir) y valida cada valor. */
export function exactParams(spec: Record<string, (v: string) => boolean>): FlatValidator {
    return (flat) => {
        const seen = new Set<string>();
        for (const [k, v] of flat) {
            const check = spec[k];
            if (!check) return `parámetro ${k} no admitido`;
            if (seen.has(k)) return `parámetro ${k} repetido`;
            seen.add(k);
            if (!check(v)) return `valor inválido para ${k}`;
        }
        const missing = Object.keys(spec).filter((k) => !seen.has(k));
        return missing.length ? `faltan parámetros: ${missing.join(", ")}` : null;
    };
}

/** Texto corto sin caracteres de control (salvo saltos de línea). */
export const plainText = (max: number) => (v: string) => v.length > 0 && v.length <= max && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v);
/** Una línea (asunto): sin controles ni saltos; ≤ max caracteres. */
export const oneLine = (max: number) => (v: string) => v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** Cuerpo HTML: no vacío, con tope, sin NUL. */
export const body = (max: number) => (v: string) => v.length > 0 && v.length <= max && !v.includes("\u0000");
const oneOf =
    (...values: string[]) =>
    (v: string) =>
        values.includes(v);
const groupId = (v: string) => v === "-1" || int(v);

/**
 * Parámetros fijos + lista `options[i][name|value]` con nombres allowlisteados (como espera
 * mod_forum). `required` son las opciones que el servidor SIEMPRE fija explícitas.
 */
export function withOptions(fixed: Record<string, (v: string) => boolean>, options: Record<string, (v: string) => boolean>, required: string[]): FlatValidator {
    const base = exactParams(fixed);
    return (flat) => {
        const err = base(flat.filter(([k]) => !k.startsWith("options[")));
        if (err) return err;
        const opts = new Map<string, { name?: string; value?: string }>();
        for (const [k, v] of flat) {
            if (!k.startsWith("options[")) continue;
            const m = /^options\[(\d{1,2})\]\[(name|value)\]$/.exec(k);
            if (!m) return `parámetro ${k} no admitido`;
            const o = opts.get(m[1]!) ?? {};
            const field = m[2] as "name" | "value";
            if (o[field] !== undefined) return `parámetro ${k} repetido`;
            o[field] = v;
            opts.set(m[1]!, o);
        }
        const names = new Set<string>();
        for (const o of opts.values()) {
            if (o.name === undefined || o.value === undefined) return "opción incompleta";
            const check = Object.hasOwn(options, o.name) ? options[o.name] : undefined;
            if (!check) return `opción ${o.name} no admitida`;
            if (names.has(o.name)) return `opción ${o.name} repetida`;
            names.add(o.name);
            if (!check(o.value)) return `valor inválido para la opción ${o.name}`;
        }
        const missing = required.filter((r) => !names.has(r));
        return missing.length ? `faltan opciones explícitas: ${missing.join(", ")}` : null;
    };
}

const SUBJECT = oneLine(255);
/** Opciones de entradas de glosario (ADR-102): alias uno por línea, categorías separadas por coma. */
const GLOSSARY_OPTIONS: Record<string, (v: string) => boolean> = {
    aliases: (v) => v.length <= 6_000 && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v),
    categories: (v) => /^(\d{1,12}(,\d{1,12}){0,19})?$/.test(v),
    usedynalink: (v) => v === "0" || v === "1",
    casesensitive: (v) => v === "0" || v === "1",
    fullmatch: (v) => v === "0" || v === "1",
};

/**
 * Entrada de base de datos (ADR-077): `<clave>` + `data[i][fieldid|subfield|value]`. El valor va
 * SIEMPRE codificado en JSON (como lo espera mod_data). Hasta 30 campos.
 */
function dataEntryParams(key: "databaseid" | "entryid"): FlatValidator {
    return (flat) => {
        const rows = new Map<string, Record<string, string>>();
        let seenKey = false;
        for (const [k, v] of flat) {
            if (k === key) {
                if (seenKey || !int(v)) return key + " inválido";
                seenKey = true;
                continue;
            }
            const m = /^data\[(\d{1,2})\]\[(fieldid|subfield|value)\]$/.exec(k);
            if (!m) return "parámetro " + k + " no admitido";
            const r = rows.get(m[1]!) ?? {};
            if (r[m[2]!] !== undefined) return "parámetro " + k + " repetido";
            r[m[2]!] = v;
            rows.set(m[1]!, r);
        }
        if (!seenKey) return "falta " + key;
        if (!rows.size || rows.size > 30) return "entre 1 y 30 campos";
        for (const r of rows.values()) {
            if (!int(r.fieldid) || r.value === undefined || r.value.length > 200_000) return "campo incompleto o inválido";
            if (r.subfield !== undefined && !/^(|content1|day|month|year)$/.test(r.subfield)) return "subcampo no admitido";
            try {
                JSON.parse(r.value);
            } catch {
                return "value debe ir codificado en JSON";
            }
        }
        return null;
    };
}
const MESSAGE = body(100_000);
const BOOL = oneOf("0", "1");

const range = (min: number, max: number) => (v: string) => /^\d{1,12}$/.test(v) && Number(v) >= min && Number(v) <= max;
const optionalBody = (max: number) => (v: string) => v.length <= max && !v.includes("\u0000");

/**
 * `formdata` de core_calendar_submit_create_update_form (ADR-089): sólo EDITAR (id obligatorio) un evento
 * de curso o de grupo, con estos campos y sin repetir ninguno. Nunca crear, ni eventos de usuario, de
 * categoría o de actividades, ni series enteras.
 */
function calendarUpdateForm(v: string): boolean {
    if (v.length > 30_000 || v.includes("\u0000")) return false;
    const fd = [...new URLSearchParams(v)];
    const check: Record<string, (x: string) => boolean> = {
        id: int,
        _qf__core_calendar_local_event_forms_update: oneOf("1"),
        name: SUBJECT,
        "timestart[day]": range(1, 31),
        "timestart[month]": range(1, 12),
        "timestart[year]": range(2020, 2100),
        "timestart[hour]": range(0, 23),
        "timestart[minute]": range(0, 59),
        eventtype: oneOf("course", "group"),
        courseid: int,
        groupcourseid: int,
        groupid: int,
        "description[text]": optionalBody(20_000),
        "description[format]": oneOf("1"),
        duration: oneOf("0", "2"),
        timedurationminutes: range(1, 10_080),
    };
    const seen = new Map<string, string>();
    for (const [k, x] of fd) {
        const c = check[k];
        if (!c || seen.has(k) || !c(x)) return false;
        seen.set(k, x);
    }
    const required = ["id", "_qf__core_calendar_local_event_forms_update", "name", "timestart[day]", "timestart[month]", "timestart[year]", "timestart[hour]", "timestart[minute]", "eventtype", "description[text]", "description[format]", "duration"];
    if (required.some((k) => !seen.has(k))) return false;
    const group = seen.get("eventtype") === "group";
    if (group ? !seen.has("groupcourseid") || !seen.has("groupid") || seen.has("courseid") : !seen.has("courseid") || seen.has("groupcourseid") || seen.has("groupid")) return false;
    return (seen.get("duration") === "2") === seen.has("timedurationminutes");
}

/**
 * jsonformdata de mod_assign_submit_grading_form: un STRING JSON que contiene un querystring [T §7.1].
 * Sólo los campos que fija el servidor, con los peligrosos SIEMPRE explícitos.
 */
const GRADING_FORM_FIELDS: Record<string, (v: string) => boolean> = {
    grade: (v) => v === "" || /^\d{1,6}(\.\d{1,5})?$/.test(v),
    attemptnumber: (v) => /^\d{1,4}$/.test(v),
    applytoall: oneOf("0"),
    addattempt: oneOf("0"),
    sendstudentnotifications: oneOf("0", "1"),
    "assignfeedbackcomments_editor[text]": optionalBody(20_000),
    "assignfeedbackcomments_editor[format]": oneOf("1"),
    "assignfeedbackcomments_editor[itemid]": oneOf("0"),
};
function gradingFormData(v: string): boolean {
    let qs: unknown;
    try {
        qs = JSON.parse(v);
    } catch {
        return false;
    }
    if (typeof qs !== "string") return false;
    const p = new URLSearchParams(qs);
    const keys = [...p.keys()];
    if (new Set(keys).size !== keys.length) return false;
    if (!keys.every((k) => Object.hasOwn(GRADING_FORM_FIELDS, k) && GRADING_FORM_FIELDS[k]!(p.get(k)!))) return false;
    // Valores por defecto peligrosos: siempre explícitos.
    return ["grade", "attemptnumber", "applytoall", "addattempt", "sendstudentnotifications"].every((k) => p.has(k));
}

/**
 * Tomar asistencia por la app móvil del plugin (investigación [T] §21): `mobile_view_activity` con
 * argumentos `status<userid>`. El servidor de lectura prohíbe esos argumentos (ADR-028); acá se
 * admiten SÓLO con cmid, courseid, sessid y appversioncode, y al menos un status.
 */
function attendanceTake(flat: [string, string][]): string | null {
    const get = (k: string) => flat.find(([key]) => key === k)?.[1];
    if (get("component") !== "mod_attendance" || get("method") !== "mobile_view_activity") return "sólo mod_attendance/mobile_view_activity";
    const args = new Map<string, { name?: string; value?: string }>();
    for (const [k, v] of flat) {
        if (k === "component" || k === "method") continue;
        const m = /^args\[(\d{1,3})\]\[(name|value)\]$/.exec(k);
        if (!m) return `parámetro ${k} no admitido`;
        const a = args.get(m[1]!) ?? {};
        a[m[2] as "name" | "value"] = v;
        args.set(m[1]!, a);
    }
    const names = new Set<string>();
    let statuses = 0;
    for (const a of args.values()) {
        if (!a.name || a.value === undefined || !/^\d{1,12}$/.test(a.value)) return "argumento incompleto o con valor no numérico";
        if (!/^(cmid|courseid|sessid|appversioncode|status\d{1,12})$/.test(a.name)) return `argumento ${a.name} no admitido`;
        if (names.has(a.name)) return `argumento ${a.name} repetido`;
        names.add(a.name);
        if (a.name.startsWith("status")) statuses++;
    }
    if (!["cmid", "courseid", "sessid"].every((n) => names.has(n))) return "faltan cmid, courseid o sessid";
    return statuses ? null : "no hay ningún estado para registrar";
}

export const WRITE_FUNCTIONS: Readonly<Record<string, RestWriteSpec>> = {
    // --- ADR-120 · Mensaje privado a UN participante (sólo a quien el perfil permite notificar) ---
    core_message_send_instant_messages: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ "messages[0][touserid]": int, "messages[0][text]": body(20_000), "messages[0][textformat]": (v) => v === "1", "messages[0][clientmsgid]": (v) => /^[0-9a-f]{16}$/.test(v) }),
        effects: "Manda UN mensaje privado a UN usuario: siempre le llega una notificación (y, según sus preferencias, un correo). Irreversible para el destinatario.",
    },
    core_message_get_conversation_between_users: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ userid: int, otheruserid: int, includecontactrequests: (v) => v === "0", includeprivacyinfo: (v) => v === "0", memberlimit: (v) => v === "0", memberoffset: (v) => v === "0", messagelimit: (v) => v === "20", messageoffset: (v) => v === "0", newestmessagesfirst: (v) => v === "1" }),
        effects: "Sólo lectura: los últimos 20 mensajes de la conversación privada con un usuario (verificación del envío).",
    },
    // --- W4 · Tomar asistencia (directiva §8.7) ---
    tool_mobile_get_content: {
        kind: "write",
        synthetic_only: false,
        validate: attendanceTake,
        effects: "Registra los estados de asistencia de los alumnos enviados en una sesión (attendance_log), BORRA sus observaciones, actualiza lasttaken y la nota de asistencia; evento attendance_taken. Responde «éxito» aunque no escriba nada.",
    },
    // --- W3 · Calificar y devolver (directiva §8.6; investigación [T] §7) ---
    mod_assign_submit_grading_form: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ assignmentid: int, userid: int, jsonformdata: gradingFormData }),
        effects: "Valida y guarda la nota y la devolución de UN participante (libro de calificaciones, submission_graded). Crea la entrega vacía si no existe. Con sendstudentnotifications=1, mensaje al estudiante en menos de un minuto.",
    },
    // ADR-096: lista de ítems del libro de calificaciones (id y nombre).
    core_grades_get_gradeitems: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ courseid: int }),
        effects: "Sólo lectura: ítems de calificación del curso (id, nombre y categoría).",
    },
    mod_assign_get_grades: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ "assignmentids[0]": int }),
        effects: "Sólo lectura (SELECT de assign_grades): nota, calificador e intento.",
    },
    // --- W2 · Calendario (directiva §8.2; investigación [F] §4) ---
    core_calendar_create_calendar_events: {
        kind: "write",
        synthetic_only: false,
        // Un solo evento por llamada; sólo tipos course/group con courseid y groupid coherentes; repeticiones ≤ 20.
        validate: exactParams({
            "events[0][name]": SUBJECT,
            "events[0][description]": optionalBody(20_000),
            "events[0][format]": oneOf("1"),
            "events[0][courseid]": int,
            "events[0][groupid]": int,
            "events[0][repeats]": range(0, 20),
            "events[0][eventtype]": oneOf("course", "group"),
            "events[0][timestart]": int,
            "events[0][timeduration]": range(0, 7 * 86_400),
            "events[0][visible]": oneOf("1"),
        }),
        effects: "Crea el evento (y sus repeticiones semanales). Visible para el curso o el grupo; sin notificaciones del núcleo. Sin permiso devuelve el aviso nopermissions sin crear nada.",
    },
    core_calendar_delete_calendar_events: {
        kind: "write",
        synthetic_only: false,
        // De a uno y nunca la serie entera (repeat=0): el lote es atómico y repeat=1 borra toda la serie.
        validate: exactParams({ "events[0][eventid]": int, "events[0][repeat]": oneOf("0") }),
        effects: "Borra un evento (irreversible). Sólo como deshacer de un evento creado por la acción.",
    },
    // ADR-089: editar UN evento de curso o de grupo existente (el formulario del calendario por servicio web).
    core_calendar_submit_create_update_form: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ formdata: calendarUpdateForm }),
        effects: "Edita UN evento existente de curso o de grupo (nombre, descripción, inicio, duración) con el formulario de edición del calendario. Sin id se crearía uno: el validador exige el id. Sin notificaciones.",
    },
    core_calendar_get_allowed_event_types: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ courseid: int }),
        effects: "Sólo lectura: calendar_get_allowed_event_types para el curso.",
    },
    // --- W2 · Prórrogas y bloqueo de entregas (directiva §8.5; investigación [T] §13–§14) ---
    mod_assign_save_user_extensions: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ assignmentid: int, "userids[0]": int, "dates[0]": (v) => v === "0" || int(v) }),
        effects: "Fija (o con 0 quita) la prórroga de UN participante; evento extension_granted y evento de calendario del usuario. No envía mensaje.",
    },
    mod_assign_lock_submissions: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ assignmentid: int, "userids[0]": int }),
        effects: "Bloquea la entrega de UN participante (no puede editarla). Sin mensaje.",
    },
    mod_assign_unlock_submissions: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ assignmentid: int, "userids[0]": int }),
        effects: "Desbloquea la entrega de UN participante. Sin mensaje.",
    },
    // --- W2 · Comentarios de entrega (directiva §8.4; investigación [F] §5.1) ---
    core_comment_add_comments: {
        kind: "write",
        synthetic_only: false,
        // Componente y área fijos: NUNCA submission_comments_upgrade (firma el comentario como el estudiante).
        validate: exactParams({
            "comments[0][contextlevel]": oneOf("module"),
            "comments[0][instanceid]": int,
            "comments[0][component]": oneOf("assignsubmission_comments"),
            "comments[0][content]": body(5_000),
            "comments[0][itemid]": int,
            "comments[0][area]": oneOf("submission_comments"),
        }),
        effects: "Agrega un comentario a la entrega (visible para el estudiante; FORMAT_MOODLE). Sin notificaciones del núcleo.",
    },
    core_comment_delete_comments: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ "comments[0]": int }),
        effects: "Borra un comentario (irreversible). Sólo como deshacer de un comentario propio creado por la acción.",
    },
    // --- W1 · Foros (directiva §8.1; investigación [F] §2) ---
    mod_forum_add_discussion: {
        kind: "write",
        synthetic_only: false,
        // groupid siempre explícito (-1 = todos); suscripción y fijado explícitos. attachmentsid: borrador recién subido por el motor (ADR-057).
        validate: withOptions({ forumid: int, subject: SUBJECT, message: MESSAGE, groupid: groupId }, { discussionsubscribe: BOOL, discussionpinned: BOOL, attachmentsid: int }, ["discussionsubscribe", "discussionpinned"]),
        effects: "Crea la discusión y su primer post (mailed=0). El correo lo envía el cron después de maxeditingtime. Marca leído para el autor; puede actualizar la finalización.",
    },
    mod_forum_add_discussion_post: {
        kind: "write",
        synthetic_only: false,
        validate: withOptions({ postid: int, subject: SUBJECT, message: MESSAGE, messageformat: oneOf("1") }, { discussionsubscribe: BOOL, private: oneOf("1"), attachmentsid: int }, ["discussionsubscribe"]),
        effects: "Crea una respuesta (mailed=0). Correo por cron después de maxeditingtime. Sin postprivatereply, «private» se publica en abierto sin aviso.",
    },
    // --- Archivos de los planes (directiva §8.12; [F] §6.3): sólo limpiar el borrador propio ---
    core_files_delete_draft_files: {
        kind: "write",
        synthetic_only: false,
        validate: (flat) => {
            const names = new Map<string, string>();
            let draft = false;
            for (const [k, v] of flat) {
                if (k === "draftitemid" && int(v) && !draft) {
                    draft = true;
                    continue;
                }
                const m = /^files\[(\d)\]\[(filepath|filename)\]$/.exec(k);
                if (!m || names.has(k)) return `parámetro ${k} no admitido`;
                if (m[2] === "filepath" ? v !== "/" : !/^[^\\/:*?"<>|\u0000-\u001f]{1,200}$/.test(v)) return `valor inválido para ${k}`;
                names.set(k, v);
            }
            if (!draft || !names.size) return "faltan draftitemid o files";
            for (const k of names.keys()) if (!names.has(k.replace(/filepath|filename/, (x) => (x === "filepath" ? "filename" : "filepath")))) return "archivo incompleto";
            return null;
        },
        effects: "Borra archivos del BORRADOR privado del usuario (nunca de un curso). Sólo para limpiar adjuntos subidos por un plan que no llegó a publicarse.",
    },
    mod_forum_prepare_draft_area_for_post: {
        kind: "write",
        synthetic_only: false,
        // Sólo adjuntos, borrador nuevo y una lista de archivos a conservar (en el borrador del usuario).
        validate: (flat) => {
            const fixed = new Map([["postid", int], ["area", oneOf("attachment")], ["draftitemid", oneOf("0")]] as const);
            const seen = new Set<string>();
            for (const [k, v] of flat) {
                const check = fixed.get(k as "postid");
                if (check) {
                    if (seen.has(k) || !check(v)) return `valor inválido para ${k}`;
                    seen.add(k);
                    continue;
                }
                const m = /^filestokeep\[(\d{1,2})\]\[(filename|filepath)\]$/.exec(k);
                if (!m) return `parámetro ${k} no admitido`;
                if (m[2] === "filepath" ? v !== "/" : !/^[^\\/:*?"<>|\u0000-\u001f]{1,200}$/.test(v)) return `valor inválido para ${k}`;
            }
            return seen.size === 3 ? null : "faltan postid, area o draftitemid";
        },
        effects: "Copia al BORRADOR privado del usuario los adjuntos del post que se conservan (no toca el post). Paso previo para reemplazar adjuntos.",
    },
    mod_forum_update_discussion_post: {
        kind: "write",
        synthetic_only: false,
        // '' = no cambiar (Moodle ignora vacíos). discussionsubscribe SIEMPRE explícito: Moodle fija con él la suscripción de quien edita (ADR-098).
        validate: withOptions({ postid: int, subject: (v) => v === "" || SUBJECT(v), message: (v) => v === "" || MESSAGE(v), messageformat: oneOf("1") }, { discussionsubscribe: BOOL, attachmentsid: int }, ["discussionsubscribe"]),
        effects: "Edita asunto y mensaje del post; si es el primero, renombra la discusión. Una edición posterior al correo no se reenvía.",
    },
    mod_forum_delete_post: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ postid: int }),
        effects: "Borrado físico e irreversible (sin papelera), de cualquier autor con la capacidad moderate_forum (ADR-094). El primer post borra la discusión entera. Dentro de maxeditingtime evita el correo. Moodle no avisa al autor.",
    },
    mod_forum_set_pin_state: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ discussionid: int, targetstate: BOOL }),
        effects: "Fija o desfija la discusión. Sin eventos ni correos.",
    },
    mod_forum_set_lock_state: {
        kind: "write",
        synthetic_only: false,
        // Semántica invertida de Moodle: targetstate=0 BLOQUEA, 1 desbloquea. La traduce la intención.
        validate: exactParams({ forumid: int, discussionid: int, targetstate: BOOL }),
        effects: "Bloquea o desbloquea la discusión (timelocked). Sin correos.",
    },
    mod_forum_can_add_discussion: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ forumid: int, groupid: groupId }),
        effects: "Sólo lectura: forum_user_can_post_discussion y capacidades de fijar y adjuntar.",
    },
    mod_forum_get_forum_access_information: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ forumid: int }),
        effects: "Sólo lectura: capacidades de la cuenta en el foro (canpostprivatereply, canreplypost…).",
    },
    // --- W6 · Contenido de actividades (ADR-077): glosarios, wikis, bases de datos y consultas ---
    mod_glossary_get_glossaries_by_courses: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ "courseids[0]": int }),
        effects: "Sólo lectura: glosarios del curso (id de instancia por cmid).",
    },
    mod_glossary_get_entries_by_letter: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ id: int, letter: oneOf("ALL"), from: range(0, 100_000), limit: range(1, 200) }),
        effects: "Sólo lectura: entradas aprobadas del glosario.",
    },
    mod_glossary_get_entry_by_id: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ id: int }),
        effects: "Sólo lectura: una entrada del glosario.",
    },
    mod_glossary_add_entry: {
        kind: "write",
        synthetic_only: false,
        validate: withOptions({ glossaryid: int, concept: SUBJECT, definition: body(100_000), definitionformat: oneOf("1") }, GLOSSARY_OPTIONS, []),
        effects: "Agrega UNA entrada al glosario (aprobada: la cuenta es docente), con alias y categorías opcionales. Sin mensajes.",
    },
    mod_glossary_update_entry: {
        kind: "write",
        synthetic_only: false,
        // ADR-102: Moodle borra y reescribe alias y categorías con lo recibido: siempre explícitos.
        validate: withOptions({ entryid: int, concept: SUBJECT, definition: body(100_000), definitionformat: oneOf("1") }, GLOSSARY_OPTIONS, ["aliases", "categories"]),
        effects: "Cambia concepto, definición, alias y categorías de UNA entrada del glosario (alias y categorías se reescriben con lo enviado). Sin mensajes.",
    },
    mod_glossary_delete_entry: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ entryid: int }),
        effects: "Borra UNA entrada del glosario (con sus comentarios y calificaciones). Irreversible.",
    },
    mod_wiki_get_wikis_by_courses: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ "courseids[0]": int }),
        effects: "Sólo lectura: wikis del curso.",
    },
    mod_wiki_get_subwikis: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ wikiid: int }),
        effects: "Sólo lectura: subwikis (por grupo o usuario) de una wiki.",
    },
    mod_wiki_get_subwiki_pages: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ wikiid: int, groupid: range(0, 1e12), userid: range(0, 1e12) }),
        effects: "Sólo lectura: páginas de un subwiki con su contenido.",
    },
    mod_wiki_new_page: {
        kind: "write",
        synthetic_only: false,
        // Subwiki existente, o (subwiki todavía sin crear) wikiid con groupid y userid: Moodle lo crea (ADR-093).
        validate: (flat) => {
            const bySub = exactParams({ title: SUBJECT, content: body(200_000), contentformat: oneOf("html"), subwikiid: int })(flat);
            return bySub === null ? null : exactParams({ title: SUBJECT, content: body(200_000), contentformat: oneOf("html"), wikiid: int, groupid: range(0, 1e12), userid: range(0, 1e12) })(flat) === null ? null : bySub;
        },
        effects: "Crea UNA página en el subwiki indicado (o en el subwiki de ese grupo o participante, que Moodle crea si hace falta). Sin mensajes.",
    },
    mod_wiki_edit_page: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ pageid: int, content: body(200_000) }),
        effects: "Guarda una versión nueva del contenido de UNA página (queda en el historial). Sin mensajes.",
    },
    mod_data_get_databases_by_courses: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ "courseids[0]": int }),
        effects: "Sólo lectura: bases de datos del curso.",
    },
    mod_data_get_fields: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ databaseid: int }),
        effects: "Sólo lectura: campos de una base de datos.",
    },
    mod_data_get_entry: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ entryid: int, returncontents: oneOf("1") }),
        effects: "Sólo lectura: una entrada de la base de datos con su contenido.",
    },
    mod_data_add_entry: {
        kind: "write",
        synthetic_only: false,
        validate: dataEntryParams("databaseid"),
        effects: "Agrega UNA entrada a la base de datos (sin grupo). Sin mensajes.",
    },
    mod_data_update_entry: {
        kind: "write",
        synthetic_only: false,
        validate: dataEntryParams("entryid"),
        effects: "Cambia los campos indicados de UNA entrada de la base de datos. Sin mensajes.",
    },
    mod_data_delete_entry: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ entryid: int }),
        effects: "Borra UNA entrada de la base de datos (con sus archivos, comentarios y calificaciones). Irreversible.",
    },
    mod_data_approve_entry: {
        kind: "write",
        synthetic_only: false,
        validate: exactParams({ entryid: int, approve: BOOL }),
        effects: "Aprueba o desaprueba UNA entrada de una base de datos con aprobación (se ve o deja de verse para los demás). Sin mensajes (ADR-085).",
    },
    mod_choice_get_choice_options: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ choiceid: int }),
        effects: "Sólo lectura: opciones de una consulta y cuántas respuestas tiene cada una.",
    },
    mod_choice_get_choices_by_courses: {
        kind: "verify_read",
        synthetic_only: false,
        validate: exactParams({ "courseids[0]": int }),
        effects: "Sólo lectura: consultas del curso (id de instancia por cmid).",
    },
    // --- Sólo pruebas (Moodle sintético) ---
    local_sintetico_set_marker: {
        kind: "write",
        synthetic_only: true,
        validate: exactParams({ courseid: int, markerid: int, value: plainText(100) }),
        effects: "Cambia el valor de un marcador del Moodle sintético. No existe en Moodle real.",
    },
    local_sintetico_get_markers: {
        kind: "verify_read",
        synthetic_only: true,
        validate: exactParams({ courseid: int }),
        effects: "Lee los marcadores del Moodle sintético (relectura de verificación).",
    },
};

/**
 * Bloqueadas siempre en el transporte de escritura (directiva §1.2), aunque alguien las agregara a
 * la tabla por error: matrícula y roles, puertas traseras, irreversibles de identidad o contenido
 * estudiantil, ejecución de código, IA del sitio y lotes genéricos.
 */
export const BLOCKED_WRITE_FUNCTIONS: readonly RegExp[] = [
    /^enrol_/,
    /^core_enrol_/,
    /^core_role_/,
    /^mod_assign_set_user_flags$/,
    /^mod_assign_reveal_identities$/,
    /^mod_assign_remove_submission$/,
    /^tool_mobile_call_external_functions$/,
    /^tool_mobile_get_autologin_key$/,
    /^core_grades_update_grades$/,
    /^core_grades_create_gradecategories$/,
    /^qtype_coderunner_run_in_sandbox$/,
    /^aiplacement_/,
    /^core_ai_/,
    // En un evento de actividad cambia la fecha de la actividad (§3.1): nunca como herramienta propia.
    /^core_calendar_update_event_start_day$/,
];

export function isBlockedWriteFunction(fn: string): boolean {
    return BLOCKED_WRITE_FUNCTIONS.some((re) => re.test(fn));
}

/**
 * Chequeo previo a la red de una llamada REST de escritura. Lanza POLICY_DENIED si la función no
 * está en la allowlist, está bloqueada, es sintética fuera de un sitio .test, o sus parámetros no
 * pasan el validador.
 */
export function checkWriteRest(fn: string, flat: [string, string][], siteUrl: string, table: Readonly<Record<string, RestWriteSpec>> = WRITE_FUNCTIONS): RestWriteSpec {
    if (isBlockedWriteFunction(fn)) throw new CampusError("POLICY_DENIED", `La función ${fn} está bloqueada para escritura por la directiva (§1.2).`);
    const spec = Object.hasOwn(table, fn) ? table[fn] : undefined;
    if (!spec) throw new CampusError("POLICY_DENIED", `La función ${fn} no está en la allowlist de escritura.`);
    if (spec.synthetic_only && !isSyntheticSite(siteUrl)) throw new CampusError("POLICY_DENIED", `La función de prueba ${fn} sólo se emite contra el Moodle sintético.`);
    for (const [k] of flat) {
        if (RESERVED_PARAMS.has(rootName(k))) throw new CampusError("POLICY_DENIED", `El parámetro ${rootName(k)} está reservado al transporte.`);
    }
    const violation = spec.validate(flat);
    if (violation) throw new CampusError("POLICY_DENIED", `${fn}: ${violation}.`);
    return spec;
}

// --- Sesión web (AJAX y formularios) ---

/**
 * Método AJAX de escritura. Los despachadores genéricos (core_courseformat_update_course) se
 * admiten sólo como tupla método + discriminador (p. ej. action=cm_hide), nunca con acción libre.
 */
export interface AjaxWriteSpec {
    method: string;
    discriminator?: { arg: string; value: string };
    validate: (args: Record<string, unknown>) => string | null;
    effects: string;
}

/**
 * Formulario web de escritura: ruta, marcador _qf__, parámetros del GET y campos que el plan puede
 * fijar, cada uno con validador. El transporte agrega sesskey y _qf__.
 * Con `merge_form_defaults`, el resto de los campos se toma TAL CUAL del formulario que sirve
 * Moodle (directiva §7.5: se envía sólo lo que cambia y se conserva el resto). Los valores de
 * `forced` pisan siempre lo que venga del formulario.
 */
export interface WebFormWriteSpec {
    id: string;
    path: string;
    /** Vacío para acciones confirmadas sin formulario (p. ej. borrar una sesión). */
    qf_marker: string;
    /** No abrir el formulario: un único POST con los campos (acciones de confirmación). */
    no_get?: boolean;
    fields: Record<string, (v: string) => boolean>;
    required: string[];
    effects: string;
    query?: Record<string, (v: string) => boolean>;
    forced?: Record<string, string>;
    merge_form_defaults?: boolean;
    /** Botón de envío (p. ej. «guardar y mostrar», que redirige a la actividad creada). */
    submit_button?: string;
    /**
     * Casillas que, en 0, se OMITEN del envío (como hace el navegador con una casilla sin marcar).
     * Algunos plugins las evalúan con isset(): mandar «0» las daría por marcadas (observado en
     * mod_attendance: addmultiply=0 activa el alta de varias sesiones y responde 404).
     */
    omit_when_zero?: string[];
    /** Campos filepicker que el MOTOR completa con el itemid de un borrador recién subido (ADR-059). */
    upload_fields?: string[];
    /** Página de éxito que responde 200 en lugar de redirigir (p. ej. el «Continuar» de la importación). */
    success_200?: RegExp;
    /** El marcador es un campo real del formulario (no un _qf__): se reenvía con su valor, no con «1». */
    marker_is_field?: boolean;
    /**
     * Campos lógicos del plan que el transporte traduce al nombre real del formulario, que depende de la
     * página (p. ej. «mark» → «q<usage>:<slot>_-mark»): el único campo servido que cumple el patrón.
     */
    field_map?: Record<string, RegExp>;
    /**
     * Campos cuyo nombre depende de la página (p. ej. `advancedgrading[criteria][<id>][levelid]`): se
     * admiten si cumplen el patrón, con su validador (ADR-095). Siempre después de `fields`.
     */
    field_patterns?: [RegExp, (v: string) => boolean][];
    /** El marcador _qf__ termina con el valor de este parámetro del GET (p. ej. el userid del formulario de calificación). */
    qf_marker_query?: string;
    /** Edita el borrador de archivos que sirve el formulario (como los *_update_files). */
    form_draft_files?: boolean;
    /** La página de éxito (success_200) trae el MISMO formulario: vale si cumple el patrón y no muestra errores (ADR-101). */
    success_200_same_form?: boolean;
    /**
     * Campos secretos que el transporte toma del entorno AL ENVIAR (ADR-117): nunca van en el plan, la
     * bitácora ni la respuesta. Si falta el valor, no se envía nada.
     */
    secret_fields?: Record<string, { env: string }>;
}

const dateFields = (prefix: string) => ({
    [`${prefix}[enabled]`]: oneOf("0", "1"),
    [`${prefix}[day]`]: range(1, 31),
    [`${prefix}[month]`]: range(1, 12),
    [`${prefix}[year]`]: range(2020, 2100),
    [`${prefix}[hour]`]: range(0, 23),
    [`${prefix}[minute]`]: range(0, 59),
});

const posInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
/** Argumentos de core_courseformat_update_course: exactamente estas claves y un único id. */
const updateCourseArgs =
    (extra: "none" | "targetsection" | "targetcm") =>
    (a: Record<string, unknown>): string | null => {
        const want = ["action", "courseid", "ids", ...(extra === "targetsection" ? ["targetsectionid"] : extra === "targetcm" ? ["targetcmid"] : [])].sort().join(",");
        if (Object.keys(a).sort().join(",") !== want) return "argumentos no admitidos";
        if (!posInt(a.courseid)) return "courseid inválido";
        if (!Array.isArray(a.ids) || a.ids.length !== 1 || !posInt(a.ids[0])) return "ids debe tener un único id";
        if (extra === "targetsection" && !posInt(a.targetsectionid)) return "targetsectionid inválido";
        if (extra === "targetcm" && !posInt(a.targetcmid)) return "targetcmid inválido";
        return null;
    };
const inplaceArgs = (component: (c: string) => boolean, maxLen: number) => (a: Record<string, unknown>): string | null => {
    if (Object.keys(a).sort().join(",") !== "component,itemid,itemtype,value") return "argumentos no admitidos";
    if (typeof a.component !== "string" || !component(a.component)) return "componente no admitido";
    if (typeof a.itemid !== "string" || !/^\d{1,12}$/.test(a.itemid)) return "itemid inválido";
    if (typeof a.value !== "string" || !a.value.trim() || a.value.length > maxLen || /[\u0000-\u001f\u007f]/.test(a.value)) return "nombre vacío, demasiado largo o con caracteres de control";
    return null;
};

/**
 * Tuplas AJAX de escritura. Los despachadores genéricos (update_course, inplace_editable) sólo pasan
 * con su acción o itemtype allowlisteado y argumentos cerrados (directiva §3.2; investigación [C] §1, §9.1).
 */
export const WRITE_AJAX_METHODS: readonly AjaxWriteSpec[] = [
    // --- Overrides de cuestionarios (directiva §8.8; [T] §20): un override por llamada, sólo alta ---
    {
        method: "mod_quiz_save_overrides",
        validate: (a) => {
            if (Object.keys(a).join(",") !== "data") return "argumentos no admitidos";
            const d = a.data as Record<string, unknown> | null;
            if (!d || typeof d !== "object" || Object.keys(d).sort().join(",") !== "overrides,quizid" || !posInt(d.quizid)) return "data debe tener quizid y overrides";
            const list = d.overrides;
            if (!Array.isArray(list) || list.length !== 1) return "un único override por llamada";
            const o = list[0] as Record<string, unknown>;
            const allowed = ["userid", "groupid", "timeopen", "timeclose", "timelimit", "attempts"];
            if (!o || typeof o !== "object" || !Object.keys(o).every((k) => allowed.includes(k))) return "campos del override no admitidos (nunca id ni password)";
            if (("userid" in o) === ("groupid" in o)) return "userid o groupid (uno de los dos)";
            if (!posInt(o.userid ?? o.groupid)) return "userid o groupid inválido";
            if (Object.keys(o).length < 2) return "el override no cambia nada";
            if (!Object.entries(o).every(([, v]) => typeof v === "number" && Number.isInteger(v) && v >= 0)) return "valores numéricos inválidos";
            return null;
        },
        effects: "Crea un override del cuestionario para UN usuario (fechas, tiempo, intentos); actualiza su calendario y sus intentos abiertos. Sin notificaciones.",
    },
    {
        method: "mod_quiz_delete_overrides",
        validate: (a) => {
            const d = a.data as Record<string, unknown> | null;
            if (Object.keys(a).join(",") !== "data" || !d || Object.keys(d).sort().join(",") !== "ids,quizid" || !posInt(d.quizid)) return "data debe tener quizid e ids";
            return Array.isArray(d.ids) && d.ids.length === 1 && posInt(d.ids[0]) ? null : "un único id por llamada";
        },
        effects: "Borra UN override (irreversible). Sólo como deshacer de uno creado por la acción.",
    },
    // --- W4 · Estructura del curso ---
    { method: "core_courseformat_update_course", discriminator: { arg: "action", value: "cm_show" }, validate: updateCourseArgs("none"), effects: "Muestra la actividad (visible=1): también sus eventos de calendario e ítems de calificación. Sin notificaciones." },
    { method: "core_courseformat_update_course", discriminator: { arg: "action", value: "cm_hide" }, validate: updateCourseArgs("none"), effects: "Oculta la actividad (visible=0) y sus eventos e ítems de calificación." },
    { method: "core_courseformat_update_course", discriminator: { arg: "action", value: "section_show" }, validate: updateCourseArgs("none"), effects: "Muestra la sección y restaura la visibilidad previa de sus actividades (visibleold)." },
    { method: "core_courseformat_update_course", discriminator: { arg: "action", value: "section_hide" }, validate: updateCourseArgs("none"), effects: "Oculta la sección y todas sus actividades." },
    {
        // Calificación del foro completo (ADR-070; investigación [T] §19). notifyuser=true manda un mensaje
        // inmediato aunque la nota no cambie: sólo si el perfil permite notificar a ese participante (ADR-120).
        // formdata sólo «grade=<n>» o «grade=» (limpia).
        method: "core_grades_grader_gradingpanel_point_store",
        validate: (a) => {
            if (Object.keys(a).sort().join(",") !== "component,contextid,formdata,gradeduserid,itemname,notifyuser") return "argumentos no admitidos";
            if (a.component !== "mod_forum" || a.itemname !== "forum") return "sólo la calificación del foro completo (mod_forum/forum)";
            if (!posInt(a.contextid) || !posInt(a.gradeduserid)) return "contextid o gradeduserid inválidos";
            if (typeof a.notifyuser !== "boolean") return "notifyuser tiene que ser booleano";
            return typeof a.formdata === "string" && /^grade=(\d{1,3}(\.\d{1,2})?)?$/.test(a.formdata) ? null : "formdata sólo grade=<n>";
        },
        effects: "Pone (o limpia) la nota del foro completo de UN participante y actualiza el libro de calificaciones. Con notifyuser=true, mensaje inmediato al participante.",
    },
    {
        // Nota máxima de UN slot (ADR-072). Reescala intentos: el plan exige que no haya intentos.
        method: "mod_quiz_update_slots",
        validate: (a) => {
            if (Object.keys(a).sort().join(",") !== "quizid,slots" || !posInt(a.quizid)) return "sólo quizid y slots";
            const s = a.slots;
            if (!Array.isArray(s) || s.length !== 1) return "un único slot por llamada";
            const o = s[0] as Record<string, unknown>;
            if (!o || Object.keys(o).sort().join(",") !== "id,maxmark" || !posInt(o.id)) return "sólo id y maxmark";
            return typeof o.maxmark === "number" && o.maxmark >= 0 && o.maxmark <= 100 ? null : "maxmark inválido";
        },
        effects: "Cambia la nota máxima de UN slot y recalcula la nota máxima total. Con intentos reescalaría notas: el plan lo impide.",
    },
    {
        method: "qbank_editquestion_set_status",
        validate: (a) => (Object.keys(a).sort().join(",") === "questionid,status" && posInt(a.questionid) && (a.status === "ready" || a.status === "draft") ? null : "sólo questionid y status ready|draft"),
        effects: "Cambia el estado de UNA pregunta (lista o borrador): afecta a los intentos nuevos con «siempre la última versión» y a las reglas aleatorias. Sin permiso devuelve status=false.",
    },
    {
        method: "core_courseformat_update_course",
        discriminator: { arg: "action", value: "section_add" },
        validate: (a) => (Object.keys(a).sort().join(",") === "action,courseid" && posInt(a.courseid) ? null : "section_add sólo con action y courseid (al final)"),
        effects: "Agrega una sección vacía al final del curso. No idempotente.",
    },
    {
        method: "core_courseformat_update_course",
        discriminator: { arg: "action", value: "section_move_after" },
        validate: updateCourseArgs("targetsection"),
        effects: "Mueve UNA sección (con su contenido) después de otra. Las secciones se renumeran. Sin notificaciones.",
    },
    { method: "core_courseformat_update_course", discriminator: { arg: "action", value: "section_delete" }, validate: updateCourseArgs("none"), effects: "BORRA la sección y todas sus actividades (a la papelera, 7 días). R4: sólo con la intención delete_content y su confirmación por nombre (ADR-067)." },
    {
        method: "core_courseformat_update_course",
        discriminator: { arg: "action", value: "cm_move" },
        validate: (a) => updateCourseArgs("targetsection")(a) === null ? null : updateCourseArgs("targetcm")(a),
        effects: "Mueve la actividad al final de una sección o antes de otra actividad. Entrar a una sección oculta la oculta.",
    },
    {
        method: "core_update_inplace_editable",
        discriminator: { arg: "itemtype", value: "activityname" },
        validate: inplaceArgs((c) => c === "core_course", 1333),
        effects: "Renombra la actividad; también su ítem de calificación y sus eventos de calendario. Un nombre vacío o igual no hace nada.",
    },
    {
        method: "core_update_inplace_editable",
        discriminator: { arg: "itemtype", value: "sectionname" },
        validate: inplaceArgs((c) => /^format_[a-z][a-z0-9_]{0,40}$/.test(c), 255),
        effects: "Renombra la sección (componente = formato del curso).",
    },
    {
        method: "core_update_inplace_editable",
        discriminator: { arg: "itemtype", value: "user_groups" },
        validate: (a) => {
            if (Object.keys(a).sort().join(",") !== "component,itemid,itemtype,value") return "argumentos no admitidos";
            if (a.component !== "core_group") return "componente no admitido";
            if (typeof a.itemid !== "string" || !/^\d{1,12}:\d{1,12}$/.test(a.itemid)) return "itemid debe ser <curso>:<usuario>";
            if (typeof a.value !== "string" || a.value.length > 1000) return "value inválido";
            let ids: unknown;
            try {
                ids = JSON.parse(a.value);
            } catch {
                return "value debe ser un arreglo JSON de ids";
            }
            return Array.isArray(ids) && ids.length <= 50 && ids.every((x) => posInt(x)) ? null : "value debe ser un arreglo JSON de ids de grupo";
        },
        effects: "REEMPLAZA los grupos de UN participante (agrega y quita; no quita membresías protegidas). Cambia su acceso en actividades con grupos. Sin correo.",
    },
    {
        method: "core_courseformat_update_course",
        discriminator: { arg: "action", value: "cm_duplicate" },
        validate: (a) => {
            const keys = Object.keys(a).sort().join(",");
            if (keys !== "action,courseid,ids") return "argumentos no admitidos";
            if (typeof a.courseid !== "number" || !Number.isInteger(a.courseid) || a.courseid <= 0) return "courseid inválido";
            const ids = a.ids;
            if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "number" || !Number.isInteger(ids[0]) || ids[0] <= 0) return "ids debe ser un único cmid";
            return null;
        },
        effects: "Duplica UNA actividad en la misma sección (copia de seguridad y restauración sin datos de usuarios): queda con la misma visibilidad y el nombre con «(copia)». Sin notificaciones.",
    },
    {
        method: "core_courseformat_update_course",
        discriminator: { arg: "action", value: "cm_delete" },
        validate: (a) => {
            const keys = Object.keys(a).sort().join(",");
            if (keys !== "action,courseid,ids") return "argumentos no admitidos";
            if (typeof a.courseid !== "number" || !Number.isInteger(a.courseid) || a.courseid <= 0) return "courseid inválido";
            const ids = a.ids;
            if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "number" || !Number.isInteger(ids[0]) || ids[0] <= 0) return "ids debe ser un único cmid";
            return null;
        },
        effects: "Borra la actividad (con la papelera habilitada, va a la papelera 7 días; restaurarla crea otro cmid). Borra sus eventos, ítems de calificación y entregas.",
    },
];

/**
 * W6 · Los elementos del sandbox (ADR-077): descripción de cualquier actividad con descripción estándar,
 * opciones de una consulta, archivos de carpetas y recursos, altas de más tipos y capítulos de libros.
 */
export const DESCRIPTION_KINDS = ["folder", "resource", "book", "wiki", "glossary", "data", "lesson", "lti", "hvp", "choicegroup", "choice", "questionnaire", "h5pactivity", "attendance", "subjectattendance"] as const;
const NO_NOTIFY = { forced: { coursecontentnotification: "0" }, omit_when_zero: ["coursecontentnotification"] };
const optionText = (v: string) => v.length <= 255 && !/[\u0000-\u001f\u007f]/.test(v);
const MAX_CHOICE_OPTIONS = 30;
const choiceOptionFields = (): Record<string, (v: string) => boolean> => {
    const out: Record<string, (v: string) => boolean> = { option_repeats: range(1, MAX_CHOICE_OPTIONS) };
    for (let i = 0; i < MAX_CHOICE_OPTIONS; i++) Object.assign(out, { [`option[${i}]`]: optionText, [`limit[${i}]`]: range(0, 100_000), [`optionid[${i}]`]: (v: string) => /^\d{1,12}$/.test(v) });
    return out;
};
const addQuery = (kind: string) => ({ add: oneOf(kind), course: int, section: range(0, 200) });
const INTRO = { "introeditor[text]": optionalBody(20_000), "introeditor[format]": oneOf("1") };
const CREATE_BASE = { name: SUBJECT, ...INTRO, visible: oneOf("0", "1"), coursecontentnotification: oneOf("0") };
const createSpec = (kind: string, extra: Record<string, (v: string) => boolean>, effects: string, opts: Partial<WebFormWriteSpec> = {}): WebFormWriteSpec => ({
    id: `course_modedit_${kind}_add`,
    path: "/course/modedit.php",
    qf_marker: `_qf__mod_${kind}_mod_form`,
    query: addQuery(kind),
    merge_form_defaults: true,
    submit_button: "submitbutton",
    fields: { ...CREATE_BASE, ...extra },
    required: ["name", "visible", "coursecontentnotification", ...(opts.required ?? [])],
    ...NO_NOTIFY,
    effects,
    ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== "required")),
});
/** Formulario de edición por tipo de página de lección (qtype de Moodle → nombre del formulario). */
export const LESSON_PAGE_FORMS = ["shortanswer", "truefalse", "multichoice", "matching", "numerical", "essay", "branchtable", "endofbranch", "cluster", "endofcluster"] as const;
/** Formularios de páginas de PREGUNTA de una lección y su qtype (ADR-092). */
export const LESSON_QUESTION_FORMS: readonly string[] = ["shortanswer", "truefalse", "multichoice", "matching", "numerical", "essay"];
const LESSON_QTYPE: Record<string, number> = { shortanswer: 1, truefalse: 2, multichoice: 3, matching: 5, numerical: 8, essay: 10 };
/** Línea opcional (puede quedar vacía: así se borra una respuesta). */
const optLine = (max: number) => (v: string) => v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** Salto: esta página (0), siguiente (-1), anterior (-40), fin (-9) o el id de una página (el plan comprueba que sea de la lección). */
const lessonJump = (v: string) => /^(0|-1|-40|-9|\d{1,12})$/.test(v);
const LESSON_ANSWER_FIELDS: Record<string, (v: string) => boolean> = Object.fromEntries([
    ["qoption", oneOf("0", "1")],
    ...Array.from({ length: 22 }, (_, i) => [
        [`answer_editor[${i}][text]`, optionalBody(20_000)],
        [`answer_editor[${i}][format]`, oneOf("1")],
        [`answer_editor[${i}]`, optLine(1_000)],
        [`response_editor[${i}][text]`, optionalBody(20_000)],
        [`response_editor[${i}][format]`, oneOf("1")],
        [`response_editor[${i}]`, optLine(1_000)],
        [`jumpto[${i}]`, lessonJump],
        [`score[${i}]`, (v: string) => /^-?\d{1,3}$/.test(v)],
    ]).flat(),
]);
export const DATA_FIELD_TYPES = ["text", "textarea", "number", "url", "menu", "radiobutton", "checkbox", "multimenu", "date"] as const;
const CHAPTER_FIELDS = { title: SUBJECT, subchapter: oneOf("0", "1"), "content_editor[text]": body(200_000), "content_editor[format]": oneOf("1") };

const CONTENT_FORMS: readonly WebFormWriteSpec[] = [
    // Descripción de cualquier actividad con descripción estándar (Turnitin no: guardarla sincroniza con su servicio).
    ...DESCRIPTION_KINDS.map(
        (kind): WebFormWriteSpec => ({
            id: `course_modedit_${kind}_update_text`,
            path: "/course/modedit.php",
            qf_marker: `_qf__mod_${kind}_mod_form`,
            query: { update: int },
            merge_form_defaults: true,
            submit_button: "submitbutton2",
            fields: { ...INTRO, coursecontentnotification: oneOf("0") },
            required: ["introeditor[text]", "coursecontentnotification"],
            ...NO_NOTIFY,
            effects: `Cambia la descripción de la actividad (${kind}). El resto de la configuración se reenvía tal cual. Sin notificación de cambio.`,
        }),
    ),
    {
        id: "course_modedit_choice_update_options",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_choice_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: { ...choiceOptionFields(), coursecontentnotification: oneOf("0") },
        required: ["option_repeats", "coursecontentnotification"],
        ...NO_NOTIFY,
        effects: "Cambia las opciones de una consulta: renombra, agrega y quita (una opción con texto vacío se borra con sus respuestas; el plan sólo quita opciones sin respuestas). Sin notificación.",
    },
    // Archivos de una carpeta, de un recurso o el paquete de una actividad H5P: el motor agrega y quita en el
    // borrador que sirve el formulario (ADR-077 y 104).
    ...(["folder", "resource", "h5pactivity"] as const).map(
        (kind): WebFormWriteSpec => ({
            id: `course_modedit_${kind}_update_files`,
            path: "/course/modedit.php",
            qf_marker: `_qf__mod_${kind}_mod_form`,
            query: { update: int },
            merge_form_defaults: true,
            submit_button: "submitbutton2",
            fields: { coursecontentnotification: oneOf("0") },
            required: ["coursecontentnotification"],
            ...NO_NOTIFY,
            upload_fields: [kind === "h5pactivity" ? "packagefile" : "files"],
            effects: kind === "folder" ? "Agrega o quita archivos de la carpeta (los demás quedan). Sin notificación." : kind === "resource" ? "Reemplaza el archivo del recurso. Sin notificación." : "Reemplaza el paquete .h5p de la actividad H5P (los intentos registrados quedan). Sin notificación.",
        }),
    ),
    // Altas de más tipos de actividad (oculto por defecto, sin notificar).
    createSpec("folder", { files: int }, "Crea una carpeta con los archivos subidos al borrador del usuario.", { upload_fields: ["files"] }),
    createSpec("book", {}, "Crea un libro vacío (los capítulos se agregan aparte)."),
    createSpec("wiki", { wikimode: oneOf("collaborative", "individual"), firstpagetitle: SUBJECT }, "Crea una wiki (colaborativa o individual) con el título de su primera página.", { required: ["wikimode", "firstpagetitle"] }),
    createSpec("glossary", { mainglossary: oneOf("0") }, "Crea un glosario secundario vacío.", { required: ["mainglossary"] }),
    createSpec("choice", choiceOptionFields(), "Crea una consulta con sus opciones.", { required: ["option_repeats", "option[0]"] }),
    createSpec("data", {}, "Crea una base de datos vacía (sin campos: se definen aparte)."),
    createSpec("lesson", {}, "Crea una lección vacía (sin páginas)."),
    createSpec("questionnaire", { create: oneOf("new-0") }, "Crea una encuesta vacía (sin preguntas).", { required: ["create"] }),
    createSpec("choicegroup", { serializedselectedgroups: (v) => /^(;\d{1,12}){1,50}$/.test(v) }, "Crea una elección de grupo con los grupos indicados (sin cupos).", { required: ["serializedselectedgroups"] }),
    createSpec("h5pactivity", { packagefile: int }, "Crea una actividad H5P con el paquete .h5p subido al borrador del usuario.", { upload_fields: ["packagefile"] }),
    {
        id: "course_modedit_subsection_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_subsection_mod_form",
        query: addQuery("subsection"),
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: { name: SUBJECT, visible: oneOf("0", "1"), coursecontentnotification: oneOf("0") },
        required: ["name", "visible", "coursecontentnotification"],
        ...NO_NOTIFY,
        effects: "Crea una subsección (una sección delegada dentro de la sección indicada).",
    },
    // Capítulos de libros.
    {
        id: "book_chapter_add",
        path: "/mod/book/edit.php",
        qf_marker: "_qf__book_chapter_edit_form",
        query: { cmid: int, pagenum: range(0, 1000), subchapter: oneOf("0", "1") },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: CHAPTER_FIELDS,
        required: ["title", "subchapter", "content_editor[text]"],
        effects: "Agrega un capítulo (o subcapítulo) al libro, después de la posición indicada. Sin notificaciones.",
    },
    {
        id: "book_chapter_edit",
        path: "/mod/book/edit.php",
        qf_marker: "_qf__book_chapter_edit_form",
        query: { cmid: int, id: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: CHAPTER_FIELDS,
        required: [],
        effects: "Cambia el título, el nivel o el contenido de UN capítulo. Sin notificaciones.",
    },
    // ADR-119: borrar UN intento de cuestionario desde el informe de calificaciones (POST con sesskey).
    {
        id: "quiz_attempt_delete",
        path: "/mod/quiz/report.php",
        qf_marker: "",
        no_get: true,
        fields: { id: int, mode: oneOf("overview"), "attemptid[]": int, delete: oneOf("1") },
        required: ["id", "mode", "attemptid[]", "delete"],
        effects: "Borra UN intento de un estudiante en un cuestionario (sus respuestas) y recalcula su nota. Irreversible. Sin notificaciones.",
    },
    // ADR-119: devolver a borrador o borrar la entrega de UN estudiante (POST con sesskey a view.php).
    {
        id: "assign_revert_to_draft",
        path: "/mod/assign/view.php",
        qf_marker: "",
        no_get: true,
        fields: { id: int, action: oneOf("reverttodraft"), userid: int },
        required: ["id", "action", "userid"],
        effects: "Devuelve a borrador la entrega enviada de UN estudiante (el archivo queda). Sin notificaciones.",
    },
    {
        id: "assign_remove_submission",
        path: "/mod/assign/view.php",
        qf_marker: "",
        no_get: true,
        fields: { id: int, action: oneOf("removesubmission"), userid: int },
        required: ["id", "action", "userid"],
        effects: "BORRA la entrega de UN estudiante (archivos y texto). Irreversible. Sin notificaciones.",
    },
    {
        id: "book_chapter_delete",
        path: "/mod/book/delete.php",
        qf_marker: "",
        no_get: true,
        query: { id: int, chapterid: int },
        fields: { confirm: oneOf("1") },
        required: ["confirm"],
        effects: "Borra UN capítulo (con sus subcapítulos si es un capítulo principal). Irreversible.",
    },
    {
        id: "book_chapter_toggle",
        path: "/mod/book/show.php",
        qf_marker: "",
        no_get: true,
        query: { id: int, chapterid: int },
        fields: {},
        required: [],
        effects: "Oculta o muestra UN capítulo (alterna; el plan comprueba el estado actual).",
    },
    // ADR-085: mover un capítulo un lugar arriba o abajo (lleva sus subcapítulos).
    {
        id: "book_chapter_move",
        path: "/mod/book/move.php",
        qf_marker: "",
        no_get: true,
        query: { id: int, chapterid: int, up: oneOf("0", "1") },
        fields: {},
        required: [],
        effects: "Mueve UN capítulo un lugar hacia arriba o hacia abajo (un capítulo principal lleva sus subcapítulos). Sin notificaciones.",
    },
    // ADR-102: categorías de un glosario (no hay servicio web).
    {
        id: "glossary_category_save",
        path: "/mod/glossary/editcategories.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { id: int, action: oneOf("add", "edit"), hook: int, name: SUBJECT, usedynalink: oneOf("0", "1"), confirm: oneOf("1") },
        required: ["id", "action", "name", "confirm"],
        // Moodle responde con la lista de categorías (200), sin el formulario de confirmación.
        success_200: /^(?![\s\S]*name="confirm")[\s\S]*id="page-mod-glossary-editcategories"/,
        effects: "Agrega o renombra UNA categoría del glosario. Sin notificaciones.",
    },
    {
        id: "glossary_category_delete",
        path: "/mod/glossary/editcategories.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { id: int, action: oneOf("delete"), hook: int, confirm: oneOf("1") },
        required: ["id", "action", "hook", "confirm"],
        // Moodle responde con la lista de categorías (200), sin el formulario de confirmación.
        success_200: /^(?![\s\S]*name="confirm")[\s\S]*id="page-mod-glossary-editcategories"/,
        effects: "Borra UNA categoría del glosario (las entradas quedan, sin ella).",
    },
    // ADR-089: aprobar o desaprobar UNA entrada de glosario (no hay servicio web). Moodle puede avisar al autor; el dueño lo aceptó.
    {
        id: "glossary_entry_approve",
        path: "/mod/glossary/approve.php",
        qf_marker: "",
        no_get: true,
        query: { eid: int, newstate: oneOf("0", "1"), mode: oneOf("approval") },
        fields: {},
        required: [],
        effects: "Aprueba (newstate=1) o desaprueba (0) UNA entrada de glosario. Al aprobar, Moodle puede avisar al autor de la entrada.",
    },
    // ADR-095: definir o borrar la rúbrica o la guía de una tarea. Sin mezclar el formulario servido:
    // se envían SÓLO los criterios nuevos (Moodle borra los que no llegan).
    {
        id: "grading_rubric_save",
        path: "/grade/grading/form/rubric/edit.php",
        qf_marker: "_qf__gradingform_rubric_editrubric",
        query: { areaid: int },
        submit_button: "saverubric",
        fields: { areaid: int, name: SUBJECT, "description_editor[text]": optionalBody(5_000), "description_editor[format]": oneOf("1"), ...Object.fromEntries(["sortlevelsasc", "lockzeropoints", "alwaysshowdefinition", "showdescriptionteacher", "showdescriptionstudent", "showscoreteacher", "showscorestudent", "enableremarks", "showremarksstudent"].map((o) => [`rubric[options][${o}]`, oneOf("0", "1")])) },
        field_patterns: [
            [/^rubric\[criteria\]\[NEWID\d{1,2}\]\[sortorder\]$/, range(1, 99)],
            [/^rubric\[criteria\]\[NEWID\d{1,2}\]\[description\]$/, body(2_000)],
            [/^rubric\[criteria\]\[NEWID\d{1,2}\]\[levels\]\[NEWID\d{1,2}\]\[definition\]$/, body(2_000)],
            [/^rubric\[criteria\]\[NEWID\d{1,2}\]\[levels\]\[NEWID\d{1,2}\]\[score\]$/, (v) => /^\d{1,4}(\.\d{1,5})?$/.test(v)],
        ],
        required: ["areaid", "name"],
        effects: "Crea o REEMPLAZA la rúbrica de una tarea (los criterios que no se envían se borran) y la deja lista para usar. Sin notificaciones.",
    },
    {
        id: "grading_guide_save",
        path: "/grade/grading/form/guide/edit.php",
        qf_marker: "_qf__gradingform_guide_editguide",
        query: { areaid: int },
        submit_button: "saveguide",
        fields: { areaid: int, name: SUBJECT, "description_editor[text]": optionalBody(5_000), "description_editor[format]": oneOf("1"), "guide[options][optionsset]": oneOf("1"), "guide[options][alwaysshowdefinition]": oneOf("0", "1"), "guide[options][showmarkspercriterionstudents]": oneOf("0", "1") },
        field_patterns: [
            [/^guide\[(criteria|comments)\]\[NEWID\d{1,2}\]\[sortorder\]$/, range(1, 99)],
            [/^guide\[criteria\]\[NEWID\d{1,2}\]\[shortname\]$/, SUBJECT],
            [/^guide\[criteria\]\[NEWID\d{1,2}\]\[(description|descriptionmarkers)\]$/, optionalBody(2_000)],
            [/^guide\[criteria\]\[NEWID\d{1,2}\]\[maxscore\]$/, (v) => /^\d{1,4}(\.\d{1,5})?$/.test(v)],
            [/^guide\[comments\]\[NEWID\d{1,2}\]\[description\]$/, body(2_000)],
        ],
        required: ["areaid", "name"],
        effects: "Crea o REEMPLAZA la guía de evaluación de una tarea (los criterios que no se envían se borran) y la deja lista para usar. Sin notificaciones.",
    },
    {
        id: "grading_definition_delete",
        path: "/grade/grading/manage.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { areaid: int, deleteform: int, confirmed: oneOf("1") },
        required: ["areaid", "deleteform", "confirmed"],
        effects: "Borra la rúbrica o la guía de una tarea (con las calificaciones hechas con ella). Sólo sin notas puestas.",
    },
    // ADR-095: calificar por el formulario clásico (escala, rúbrica, guía, archivos). Notificación siempre 0.
    {
        id: "assign_grade_classic",
        path: "/mod/assign/view.php",
        qf_marker: "_qf__mod_assign_grade_form_",
        qf_marker_query: "userid",
        query: { id: int, action: oneOf("grade"), userid: int, rownum: oneOf("0") },
        merge_form_defaults: true,
        submit_button: "savegrade",
        fields: {
            grade: (v) => v === "" || /^\d{1,6}(\.\d{1,5})?$/.test(v),
            "assignfeedbackcomments_editor[text]": optionalBody(20_000),
            "assignfeedbackcomments_editor[format]": oneOf("1"),
            workflowstate: oneOf("notmarked", "inmarking", "readyforreview", "inreview", "readyforrelease"),
            sendstudentnotifications: oneOf("0", "1"),
            applytoall: oneOf("0"),
        },
        field_patterns: [
            [/^advancedgrading\[criteria\]\[\d{1,12}\]\[levelid\]$/, int],
            [/^advancedgrading\[criteria\]\[\d{1,12}\]\[score\]$/, (v) => /^\d{1,4}(\.\d{1,5})?$/.test(v)],
            [/^advancedgrading\[criteria\]\[\d{1,12}\]\[remark\]$/, optionalBody(5_000)],
        ],
        forced: { applytoall: "0" },
        upload_fields: ["files_{userid}_filemanager"],
        form_draft_files: true,
        required: ["assignfeedbackcomments_editor[text]", "sendstudentnotifications"],
        effects: "Califica a UN participante (nota o escala, rúbrica o guía, comentario, archivos de retroalimentación, estado del flujo). applytoall=0 fijo; sendstudentnotifications=1 sólo si el perfil permite notificar a ese participante (ADR-115 y 120).",
    },
    // ADR-096: libro de calificaciones (páginas clásicas).
    {
        id: "grade_item_edit",
        path: "/grade/edit/tree/item.php",
        qf_marker: "_qf__edit_item_form",
        query: { courseid: int, id: range(0, 1e12) },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { itemname: SUBJECT, idnumber: optLine(100), gradetype: oneOf("0", "1", "2", "3"), scaleid: int, grademax: (v) => /^\d{1,5}([.,]\d{1,5})?$/.test(v), grademin: (v) => /^\d{1,5}([.,]\d{1,5})?$/.test(v), gradepass: (v) => /^\d{1,5}([.,]\d{1,5})?$/.test(v), hidden: oneOf("0", "1") },
        required: [],
        effects: "Agrega (id=0) o edita UN ítem de calificación manual: nombre, número de ID, tipo, escala, notas máxima, mínima y de aprobación, oculto. Sin notificaciones.",
    },
    {
        id: "grade_item_delete",
        path: "/grade/edit/tree/index.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { id: int, action: oneOf("delete"), eid: (v) => /^ig\d{1,12}$/.test(v), confirm: oneOf("1") },
        required: ["id", "action", "eid", "confirm"],
        effects: "BORRA UN ítem de calificación manual con todas sus notas. Irreversible.",
    },
    {
        id: "grade_item_action",
        path: "/grade/edit/tree/action.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { id: int, eid: (v) => /^ig\d{1,12}$/.test(v), action: oneOf("hide", "show", "lock", "unlock") },
        required: ["id", "eid", "action"],
        effects: "Oculta, muestra, bloquea o desbloquea UN ítem de calificación (con todas sus notas). Sin notificaciones.",
    },
    {
        id: "grade_grade_edit",
        path: "/grade/edit/tree/grade.php",
        qf_marker: "_qf__edit_grade_form",
        query: { courseid: int, itemid: int, userid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { overridden: oneOf("0", "1"), finalgrade: (v) => v === "" || /^\d{1,5}([.,]\d{1,5})?$/.test(v), excluded: oneOf("0", "1"), hidden: oneOf("0", "1"), locked: oneOf("0", "1"), "feedback[text]": optionalBody(10_000), "feedback[format]": oneOf("1") },
        omit_when_zero: ["overridden", "hidden"],
        required: [],
        effects: "Cambia la nota de UN participante en un ítem: sobrescritura, nota, excluida, oculta, bloqueada y retroalimentación. Sin notificaciones.",
    },
    // ADR-097: preguntas de una encuesta (mod_questionnaire).
    {
        id: "questionnaire_question_add",
        path: "/mod/questionnaire/questions.php",
        qf_marker: "_qf__mod_questionnaire_edit_question_form",
        query: { id: int, action: oneOf("question"), type_id: oneOf("1", "2", "3", "4", "5", "6", "8", "9", "10", "100") },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { name: optLine(255), required: oneOf("y", "n"), "content[text]": body(20_000), "content[format]": oneOf("1"), allchoices: optionalBody(25_000), length: range(0, 1000), precise: range(0, 1000) },
        required: ["content[text]"],
        // El plugin responde con la página de preguntas (200), no con una redirección.
        success_200: /_qf__mod_questionnaire_questions_form/,
        effects: "Agrega UNA pregunta al final de la encuesta. Sin notificaciones.",
    },
    {
        id: "questionnaire_question_edit",
        path: "/mod/questionnaire/questions.php",
        qf_marker: "_qf__mod_questionnaire_edit_question_form",
        query: { id: int, qid: int, action: oneOf("question") },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { name: optLine(255), required: oneOf("y", "n"), "content[text]": body(20_000), "content[format]": oneOf("1"), allchoices: optionalBody(25_000), length: range(0, 1000), precise: range(0, 1000) },
        required: [],
        // El plugin responde con la página de preguntas (200), no con una redirección.
        success_200: /_qf__mod_questionnaire_questions_form/,
        effects: "Cambia nombre, obligatoriedad, enunciado, opciones, length o precise de UNA pregunta de la encuesta. Sin notificaciones.",
    },
    // ADR-101: mover UNA pregunta a otra posición (botón «colocar aquí» del formulario principal).
    {
        id: "questionnaire_question_move",
        path: "/mod/questionnaire/questions.php",
        qf_marker: "_qf__mod_questionnaire_questions_form",
        query: { id: int, moveq: int },
        merge_form_defaults: true,
        fields: {},
        field_patterns: [[/^moveherebutton\[\d{1,3}\]$/, int]],
        required: [],
        // Éxito: la lista de preguntas SIN el modo «mover» (sin el campo moveq).
        success_200: /^(?![\s\S]*name="moveq")[\s\S]*_qf__mod_questionnaire_questions_form/,
        success_200_same_form: true,
        effects: "Mueve UNA pregunta de la encuesta a otra posición. Sin notificaciones.",
    },
    {
        id: "questionnaire_question_delete",
        path: "/mod/questionnaire/questions.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { id: int, delq: int },
        required: ["id", "delq"],
        // El plugin responde con la página de preguntas (200), no con una redirección.
        success_200: /_qf__mod_questionnaire_questions_form/,
        effects: "Borra UNA pregunta de la encuesta (el plugin la marca como borrada; sus respuestas quedan inaccesibles).",
    },
    // ADR-103: grupos y cupos de una elección de grupo (el resto del formulario se reenvía tal cual).
    {
        id: "course_modedit_choicegroup_update_groups",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_choicegroup_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: { serializedselectedgroups: (v) => /^(;\d{1,12}){1,100}$/.test(v), limitanswers: oneOf("0", "1") },
        field_patterns: [[/^group_\d{1,12}_limit$/, range(0, 10_000)]],
        required: ["serializedselectedgroups", "limitanswers"],
        effects: "Cambia los grupos que ofrece la elección de grupo y sus cupos. Sin notificaciones.",
    },
    // ADR-117: herramienta LTI 1.3 del laboratorio en el curso. Todo fijo salvo el nombre: URLs del
    // laboratorio, sin nombre ni correo de los participantes, sólo sincronización de notas.
    {
        id: "lab_lti_tool_add",
        path: "/mod/lti/coursetooledit.php",
        qf_marker: "_qf__mod_lti_edit_types_form",
        query: { course: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            lti_typename: SUBJECT,
            lti_description: optionalBody(1000),
            lti_toolurl: oneOf(`${LAB_BASE_URL}/api/lti/launch`),
            lti_ltiversion: oneOf("1.3.0"),
            lti_keytype: oneOf("JWK_KEYSET"),
            lti_publickeyset: oneOf(`${LAB_BASE_URL}/api/lti/jwks`),
            lti_initiatelogin: oneOf(`${LAB_BASE_URL}/api/lti/login`),
            lti_redirectionuris: oneOf(`${LAB_BASE_URL}/api/lti/launch`),
            lti_customparameters: oneOf(""),
            lti_launchcontainer: oneOf("3"),
            lti_contentitem: oneOf("0"),
            ltiservice_gradesynchronization: oneOf("1"),
            ltiservice_memberships: oneOf("0"),
            ltiservice_toolsettings: oneOf("0"),
            lti_sendname: oneOf("0"),
            lti_sendemailaddr: oneOf("0"),
            lti_acceptgrades: oneOf("1"),
            lti_forcessl: oneOf("1"),
        },
        required: ["lti_typename", "lti_toolurl", "lti_ltiversion", "lti_keytype", "lti_publickeyset", "lti_initiatelogin", "lti_redirectionuris", "lti_sendname", "lti_sendemailaddr", "ltiservice_gradesynchronization"],
        effects: "Registra en el curso la herramienta LTI 1.3 del laboratorio (sin nombre ni correo de participantes; sólo notas). Sin notificaciones.",
    },
    // ADR-117: la misma herramienta en LTI 1.1 (clave y secreto compartido). En el Campus de UdeSA la nota de
    // LTI 1.3 puede no llegar (según la configuración del servidor de mod/lti/services.php); Basic Outcomes usa mod/lti/service.php y sí.
    // El secreto sale del entorno al enviar (secret_fields), nunca del plan.
    {
        id: "lab_lti11_tool_add",
        path: "/mod/lti/coursetooledit.php",
        qf_marker: "_qf__mod_lti_edit_types_form",
        query: { course: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            lti_typename: SUBJECT,
            lti_description: optionalBody(1000),
            lti_toolurl: oneOf(`${LAB_BASE_URL}/api/lti/launch11`),
            lti_ltiversion: oneOf("LTI-1p0"),
            lti_resourcekey: oneOf(LAB_LTI11_KEY),
            lti_customparameters: oneOf(""),
            lti_launchcontainer: oneOf("3"),
            lti_contentitem: oneOf("0"),
            ltiservice_gradesynchronization: oneOf("0"),
            ltiservice_memberships: oneOf("0"),
            ltiservice_toolsettings: oneOf("0"),
            lti_sendname: oneOf("0"),
            lti_sendemailaddr: oneOf("0"),
            lti_acceptgrades: oneOf("1"),
            lti_forcessl: oneOf("1"),
        },
        secret_fields: { lti_password: { env: "CAMPUS_LAB_LTI11_SECRET" } },
        required: ["lti_typename", "lti_toolurl", "lti_ltiversion", "lti_resourcekey", "lti_sendname", "lti_sendemailaddr", "lti_acceptgrades"],
        effects: "Registra en el curso la herramienta LTI 1.1 del laboratorio con su clave y secreto (sin nombre ni correo de participantes; sólo notas). Sin notificaciones.",
    },
    // ADR-117: actividad LTI con un ejercicio del laboratorio (la consigna va en los parámetros personalizados).
    {
        id: "course_modedit_lti_add_lab",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_lti_mod_form",
        query: { add: oneOf("lti"), course: int, section: int, typeid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: {
            name: SUBJECT,
            "introeditor[text]": optionalBody(10_000),
            "introeditor[format]": oneOf("1"),
            typeid: int,
            instructorcustomparameters: (v) => /^ejercicio=[A-Za-z0-9_-]{1,60000}$/.test(v),
            instructorchoiceacceptgrades: oneOf("1"),
            "grade[modgrade_type]": oneOf("point"),
            "grade[modgrade_point]": range(1, 100),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["name", "typeid", "instructorcustomparameters", "grade[modgrade_type]", "grade[modgrade_point]", "visible", "coursecontentnotification"],
        ...NO_NOTIFY,
        effects: "Crea una actividad LTI del laboratorio (ejercicio de Python con nota en el libro de calificaciones). Oculta por defecto y sin notificar.",
    },
    // ADR-094: mover UNA discusión a otro foro del mismo curso (no hay servicio web).
    {
        id: "forum_discussion_move",
        path: "/mod/forum/discuss.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { d: int, move: int },
        required: ["d", "move"],
        effects: "Mueve UNA discusión (posts, adjuntos, suscripciones) a otro foro del mismo curso. Sin notificaciones por sí mismo.",
    },
    // Páginas de wiki: borrar (no hay servicio web).
    {
        id: "wiki_page_delete",
        path: "/mod/wiki/admin.php",
        qf_marker: "",
        no_get: true,
        query: { pageid: int, delete: int, option: oneOf("1") },
        fields: {},
        required: [],
        success_200: /id="page-mod-wiki-admin"/,
        effects: "Borra UNA página de la wiki con su historial. Irreversible.",
    },
    // Páginas de lecciones (ADR-081): /mod/lesson/editpage.php (un formulario por tipo de página) y lesson.php?action=delete.
    {
        id: "lesson_page_add",
        path: "/mod/lesson/editpage.php",
        qf_marker: "_qf__lesson_add_page_form_branchtable",
        query: { id: int, pageid: range(0, 1e12), qtype: oneOf("20"), firstpage: oneOf("0", "1") },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { title: SUBJECT, "contents_editor[text]": body(200_000), "contents_editor[format]": oneOf("1"), "answer_editor[0]": oneLine(255), "jumpto[0]": oneOf("-1") },
        required: ["title", "contents_editor[text]", "answer_editor[0]", "jumpto[0]"],
        effects: "Agrega UNA página de contenido a la lección (con un botón que lleva a la página siguiente), después de la indicada. Sin notificaciones.",
    },
    ...LESSON_PAGE_FORMS.map(
        (form): WebFormWriteSpec => ({
            id: `lesson_page_edit_${form}`,
            path: "/mod/lesson/editpage.php",
            qf_marker: `_qf__lesson_add_page_form_${form}`,
            query: { id: int, pageid: int, edit: oneOf("1") },
            merge_form_defaults: true,
            submit_button: "submitbutton",
            fields: { title: SUBJECT, "contents_editor[text]": body(200_000), "contents_editor[format]": oneOf("1"), ...(LESSON_QUESTION_FORMS.includes(form) ? LESSON_ANSWER_FIELDS : {}) },
            omit_when_zero: ["qoption"],
            required: [],
            effects: LESSON_QUESTION_FORMS.includes(form)
                ? "Cambia el título, el enunciado o las respuestas (texto, retroalimentación, salto y puntaje) de UNA página de pregunta; una respuesta vacía se borra (ADR-092)."
                : "Cambia el título o el contenido de UNA página de la lección; respuestas y saltos se reenvían tal cual.",
        }),
    ),
    // ADR-092: agregar UNA página de pregunta (un formulario por tipo).
    ...LESSON_QUESTION_FORMS.map(
        (form): WebFormWriteSpec => ({
            id: `lesson_question_add_${form}`,
            path: "/mod/lesson/editpage.php",
            qf_marker: `_qf__lesson_add_page_form_${form}`,
            query: { id: int, pageid: range(0, 1e12), qtype: oneOf(String(LESSON_QTYPE[form])), firstpage: oneOf("0", "1") },
            merge_form_defaults: true,
            submit_button: "submitbutton",
            fields: { title: SUBJECT, "contents_editor[text]": body(200_000), "contents_editor[format]": oneOf("1"), ...LESSON_ANSWER_FIELDS },
            omit_when_zero: ["qoption"],
            required: ["title", "contents_editor[text]"],
            effects: "Agrega UNA página de pregunta a la lección, con sus respuestas, retroalimentación, saltos y puntajes, después de la indicada. Sin notificaciones.",
        }),
    ),
    {
        id: "lesson_page_delete",
        path: "/mod/lesson/lesson.php",
        qf_marker: "",
        no_get: true,
        query: { id: int, action: oneOf("delete"), pageid: int },
        fields: {},
        required: [],
        effects: "Borra UNA página de la lección con sus respuestas y los intentos registrados en ella. Irreversible.",
    },
    // Ajustes por tipo de actividad (ADR-082): sólo los campos del catálogo, con sus valores admitidos.
    ...SETTINGS_KINDS.map((kind): WebFormWriteSpec => {
        const defs = settingFields(kind);
        const validator = (d: SettingDef) =>
            d.control === "select" ? oneOf(...Object.values(d.values ?? {}), ...(d.restore ?? [])) : d.control === "int" ? (v: string) => /^-?\d{1,12}$/.test(v) && Number(v) >= (d.min ?? 0) && Number(v) <= (d.max ?? 1e12) : oneOf("0", "1");
        return {
            id: `course_modedit_${kind}_update_settings`,
            path: "/course/modedit.php",
            qf_marker: `_qf__mod_${kind}_mod_form`,
            query: { update: int },
            merge_form_defaults: true,
            submit_button: "submitbutton2",
            fields: {
                ...Object.fromEntries(defs.map((d) => [d.field, validator(d)])),
                // Restricciones de acceso: JSON del árbol de condiciones (lo arma la intención; vacío = sin restricciones).
                availabilityconditionsjson: (v: string) => {
                    if (v === "") return true;
                    if (v.length > 10_000) return false;
                    try {
                        const j = JSON.parse(v) as { op?: unknown; c?: unknown };
                        return (j.op === "&" || j.op === "|") && Array.isArray(j.c);
                    } catch {
                        return false;
                    }
                },
                coursecontentnotification: oneOf("0"),
            },
            required: ["coursecontentnotification"],
            forced: { coursecontentnotification: "0" },
            omit_when_zero: ["coursecontentnotification", ...defs.filter((d) => d.control === "checkbox").map((d) => d.field)],
            effects: `Cambia ajustes de la actividad (${kind}) del catálogo de ADR-082 (y sus restricciones de acceso). El resto se reenvía tal cual. Sin notificación de cambio.`,
        };
    }),
    // Campos de bases de datos (ADR-080): formulario simple de /mod/data/field.php (sin marcador _qf__).
    ...(["add", "update", "delete"] as const).map(
        (mode): WebFormWriteSpec => ({
            id: `data_field_${mode}`,
            path: "/mod/data/field.php",
            qf_marker: "",
            no_get: true,
            fields: {
                d: int,
                mode: oneOf(mode),
                ...(mode === "add" ? {} : { fid: int }),
                ...(mode === "delete"
                    ? { confirm: oneOf("1") }
                    : {
                          type: oneOf(...DATA_FIELD_TYPES),
                          name: oneLine(64),
                          description: (v: string) => v.length <= 1000 && !v.includes("\u0000"),
                          required: oneOf("0", "1"),
                          param1: (v: string) => v.length <= 10_000 && !v.includes("\u0000"),
                          param2: range(0, 1000),
                          param3: range(0, 1000),
                          param4: oneOf("0", "1"),
                          param5: range(0, 1_000_000_000),
                      }),
            },
            required: mode === "delete" ? ["d", "mode", "fid", "confirm"] : ["d", "mode", "type", "name", ...(mode === "update" ? ["fid"] : [])],
            // El id real de la página termina en guion (page-mod-data-field-). La relectura decide el éxito.
            success_200: /id="page-mod-data-field-?"/,
            effects: mode === "add" ? "Agrega UN campo a la base de datos (las entradas existentes quedan con ese campo vacío)." : mode === "update" ? "Cambia nombre, descripción, obligatoriedad u opciones de UN campo." : "Borra UN campo y TODOS sus valores en las entradas. Irreversible.",
        }),
    ),
];

/** W6 adelantada a pedido del dueño (ADR-050 y ADR-055): crear actividades y sesiones por formulario. */
export const WRITE_WEB_FORMS: readonly WebFormWriteSpec[] = [
    {
        id: "course_modedit_attendance_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_attendance_mod_form",
        query: { add: oneOf("attendance"), course: int, section: range(0, 200) },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            name: SUBJECT,
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
            "grade[modgrade_type]": oneOf("none", "point"),
            "grade[modgrade_point]": range(1, 100),
        },
        required: ["name", "visible", "coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        effects: "Crea la actividad de asistencia (con su conjunto de estados por defecto y, con nota, su ítem de calificación). Sin notificaciones.",
    },
    {
        id: "course_modedit_quiz_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_quiz_mod_form",
        query: { add: oneOf("quiz"), course: int, section: range(0, 200) },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            name: SUBJECT,
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
            "timelimit[enabled]": oneOf("0", "1"),
            "timelimit[number]": range(0, 1440),
            "timelimit[timeunit]": oneOf("60"),
            attempts: range(0, 10),
            ...dateFields("timeopen"),
            ...dateFields("timeclose"),
        },
        required: ["name", "visible", "coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification", "timeopen[enabled]", "timeclose[enabled]", "timelimit[enabled]"],
        effects: "Crea un cuestionario VACÍO, su ítem de calificación, sus eventos de apertura y cierre y su categoría de preguntas por defecto. Sin notificaciones.",
    },
    // --- W6 · Excepciones (overrides) de tareas por participante (ADR-066) ---
    // --- W6 · Calificación manual de una pregunta (ADR-071): comment.php, que no es un moodleform ---
    {
        id: "quiz_manual_grade",
        path: "/mod/quiz/comment.php",
        qf_marker: "slots",
        marker_is_field: true,
        query: { attempt: int, slot: int },
        merge_form_defaults: true,
        submit_button: "submit",
        fields: { mark: (v) => /^\d{1,4}(\.\d{1,2})?$/.test(v), comment: optionalBody(10_000) },
        field_map: { mark: /^q\d+:\d+_-mark$/, comment: /^q\d+:\d+_-comment$/ },
        required: ["mark"],
        success_200: /notifysuccess|alert-success/,
        effects: "Pone nota (y comentario) a UNA pregunta de un intento terminado; recalcula la nota del intento. Conserva :sequencecheck (sin él Moodle ignora el slot en silencio).",
    },
    {
        id: "assign_override_add",
        path: "/mod/assign/overrideedit.php",
        qf_marker: "_qf__assign_override_form",
        query: { action: oneOf("adduser", "addgroup"), cmid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        // userid (adduser) o groupid (addgroup): la intención manda exactamente uno.
        fields: { userid: int, groupid: int, ...dateFields("allowsubmissionsfromdate"), ...dateFields("duedate"), ...dateFields("cutoffdate") },
        required: [],
        omit_when_zero: ["allowsubmissionsfromdate[enabled]", "duedate[enabled]", "cutoffdate[enabled]"],
        effects: "Crea una excepción de fechas de la tarea para UN participante (y su calendario). Si ya tuviera una, Moodle la fusionaría: el plan lo impide. Sin mensajes.",
    },
    // ADR-099: editar una excepción existente (el formulario servido se reenvía; la contraseña del cuestionario se conserva).
    {
        id: "assign_override_edit",
        path: "/mod/assign/overrideedit.php",
        qf_marker: "_qf__assign_override_form",
        query: { id: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { ...dateFields("allowsubmissionsfromdate"), ...dateFields("duedate"), ...dateFields("cutoffdate") },
        required: [],
        omit_when_zero: ["allowsubmissionsfromdate[enabled]", "duedate[enabled]", "cutoffdate[enabled]"],
        effects: "Cambia las fechas de UNA excepción existente de la tarea (y su calendario). Sin mensajes.",
    },
    {
        id: "quiz_override_edit",
        path: "/mod/quiz/overrideedit.php",
        qf_marker: "_qf__mod_quiz_form_edit_override_form",
        query: { id: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { ...dateFields("timeopen"), ...dateFields("timeclose"), "timelimit[enabled]": oneOf("0", "1"), "timelimit[number]": range(1, 1440), "timelimit[timeunit]": oneOf("60"), attempts: range(0, 20) },
        required: [],
        omit_when_zero: ["timeopen[enabled]", "timeclose[enabled]", "timelimit[enabled]"],
        effects: "Cambia fechas, tiempo o intentos de UNA excepción existente del cuestionario; conserva su contraseña. Actualiza el calendario y los intentos abiertos. Sin notificaciones.",
    },
    {
        id: "assign_override_delete",
        path: "/mod/assign/overridedelete.php",
        qf_marker: "",
        no_get: true,
        fields: { id: int, confirm: oneOf("1") },
        required: ["id", "confirm"],
        effects: "Borra UNA excepción de la tarea. Sólo como deshacer de una creada por la acción.",
    },
    // --- W6 · Editar fechas de tareas y cuestionarios (ADR-065): sólo lo que cambia, sobre la configuración actual ---
    {
        id: "course_modedit_assign_update",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_assign_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: {
            ...dateFields("allowsubmissionsfromdate"),
            ...dateFields("duedate"),
            ...dateFields("cutoffdate"),
            ...dateFields("gradingduedate"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification", "allowsubmissionsfromdate[enabled]", "duedate[enabled]", "cutoffdate[enabled]", "gradingduedate[enabled]"],
        effects: "Cambia fechas de la tarea para todos (y sus eventos de calendario). El resto de la configuración se reenvía tal cual. Sin notificación de cambio.",
    },
    {
        id: "course_modedit_quiz_update",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_quiz_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: {
            ...dateFields("timeopen"),
            ...dateFields("timeclose"),
            "timelimit[enabled]": oneOf("0", "1"),
            "timelimit[number]": range(0, 1440),
            "timelimit[timeunit]": oneOf("60"),
            attempts: range(0, 10),
            coursecontentnotification: oneOf("0"),
        },
        required: ["coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification", "timeopen[enabled]", "timeclose[enabled]", "timelimit[enabled]"],
        effects: "Cambia apertura, cierre, límite de tiempo o intentos del cuestionario para todos (y sus eventos). El resto se reenvía tal cual. Sin notificación de cambio.",
    },
    // --- ADR-080 · Fechas de consultas, lecciones y bases de datos ---
    ...(
        [
            ["choice", "_qf__mod_choice_mod_form", ["timeopen", "timeclose"], false],
            ["lesson", "_qf__mod_lesson_mod_form", ["available", "deadline"], true],
            ["data", "_qf__mod_data_mod_form", ["timeavailablefrom", "timeavailableto"], false],
        ] as const
    ).map(
        ([kind, qf, dates, limit]): WebFormWriteSpec => ({
            id: `course_modedit_${kind}_update`,
            path: "/course/modedit.php",
            qf_marker: qf,
            query: { update: int },
            merge_form_defaults: true,
            submit_button: "submitbutton2",
            fields: {
                ...dateFields(dates[0]),
                ...dateFields(dates[1]),
                ...(limit ? { "timelimit[enabled]": oneOf("0", "1"), "timelimit[number]": range(0, 1440), "timelimit[timeunit]": oneOf("60") } : {}),
                coursecontentnotification: oneOf("0"),
            },
            required: ["coursecontentnotification"],
            forced: { coursecontentnotification: "0" },
            omit_when_zero: ["coursecontentnotification", `${dates[0]}[enabled]`, `${dates[1]}[enabled]`, ...(limit ? ["timelimit[enabled]"] : [])],
            effects: `Cambia las fechas de ${kind === "choice" ? "la consulta" : kind === "lesson" ? "la lección (y su límite de tiempo)" : "la base de datos"} para todos. El resto se reenvía tal cual. Sin notificación de cambio.`,
        }),
    ),
    // --- W6 · Editar descripción, contenido de página y nota máxima de tarea (ADR-075): sólo lo pedido ---
    {
        id: "course_modedit_assign_update_text",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_assign_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: {
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            "grade[modgrade_type]": oneOf("point"),
            "grade[modgrade_point]": range(1, 100),
            coursecontentnotification: oneOf("0"),
        },
        required: ["coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Cambia la descripción o la nota máxima de la tarea (el plan exige que no haya notas). El resto se reenvía tal cual. Sin notificación de cambio.",
    },
    {
        id: "course_modedit_quiz_update_text",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_quiz_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: {
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Cambia la descripción del cuestionario. El resto se reenvía tal cual. Sin notificación de cambio.",
    },
    {
        id: "course_modedit_forum_update_text",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_forum_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: {
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Cambia la descripción del foro (la suscripción y el resto se reenvían tal cual). Sin notificación de cambio.",
    },
    {
        id: "course_modedit_page_update_text",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_page_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: {
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            "page[text]": body(200_000),
            "page[format]": oneOf("1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Cambia la descripción o el contenido de la página. El resto se reenvía tal cual. Sin notificación de cambio.",
    },
    {
        id: "course_modedit_url_update_text",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_url_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: { "introeditor[text]": optionalBody(20_000), "introeditor[format]": oneOf("1"), externalurl: (v) => /^https?:\/\/[^\s<>"]{1,1900}$/.test(v), coursecontentnotification: oneOf("0") },
        required: ["coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Cambia la dirección o la descripción del enlace. El resto se reenvía tal cual. Sin notificación de cambio.",
    },
    {
        id: "course_modedit_label_update_text",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_label_mod_form",
        query: { update: int },
        merge_form_defaults: true,
        submit_button: "submitbutton2",
        fields: { "introeditor[text]": body(50_000), "introeditor[format]": oneOf("1"), coursecontentnotification: oneOf("0") },
        required: ["introeditor[text]", "coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Cambia el texto de la etiqueta. Sin notificación de cambio.",
    },
    // --- W6 · Contenido (ADR-064): página, URL, etiqueta y archivo ---
    {
        id: "course_modedit_page_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_page_mod_form",
        query: { add: oneOf("page"), course: int, section: range(0, 200) },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            name: SUBJECT,
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            "page[text]": body(200_000),
            "page[format]": oneOf("1"),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["name", "page[text]", "visible", "coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Crea una página con el contenido indicado. Sin notificaciones.",
    },
    {
        id: "course_modedit_url_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_url_mod_form",
        query: { add: oneOf("url"), course: int, section: range(0, 200) },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            name: SUBJECT,
            externalurl: (v) => /^https?:\/\/[^\s<>"]{1,1900}$/.test(v),
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            // Presentación del enlace (0 automática, 1 incrustada, 5 en otra página). Sólo si se pidió (content.ts).
            display: oneOf(...Object.values(URL_DISPLAY)),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["name", "externalurl", "visible", "coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Crea un enlace a una URL externa http(s), con la presentación indicada si se pidió. Sin notificaciones.",
    },
    {
        id: "course_modedit_label_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_label_mod_form",
        query: { add: oneOf("label"), course: int, section: range(0, 200) },
        merge_form_defaults: true,
        // La etiqueta no tiene «guardar y mostrar»: vuelve al curso (sin cmid en la redirección).
        submit_button: "submitbutton2",
        fields: {
            name: SUBJECT,
            "introeditor[text]": body(50_000),
            "introeditor[format]": oneOf("1"),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["name", "introeditor[text]", "visible", "coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Crea una etiqueta (área de texto) en la sección. Sin notificaciones.",
    },
    {
        id: "course_modedit_forum_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_forum_mod_form",
        query: { add: oneOf("forum"), course: int, section: range(0, 200) },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            name: SUBJECT,
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            type: oneOf("general"),
            // Nunca forzada (1) ni automática (2): esas mandan correo a los participantes.
            forcesubscribe: oneOf("0", "3"),
            "grade_forum[modgrade_type]": oneOf("none", "point"),
            "grade_forum[modgrade_point]": range(1, 100),
            grade_forum_notify: oneOf("0"),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["name", "type", "forcesubscribe", "grade_forum[modgrade_type]", "grade_forum_notify", "visible", "coursecontentnotification"],
        forced: { coursecontentnotification: "0", grade_forum_notify: "0", type: "general" },
        omit_when_zero: ["coursecontentnotification"],
        effects: "Crea un foro general con suscripción deshabilitada u opcional (nunca forzada ni automática) y, opcionalmente, calificación del foro completo sin notificar. Sin notificaciones.",
    },
    {
        id: "course_modedit_resource_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_resource_mod_form",
        query: { add: oneOf("resource"), course: int, section: range(0, 200) },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            name: SUBJECT,
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            files: int,
            // Presentación (ADR-131): 0 automática, 1 incrustada, 3 ventana nueva, 4 descarga, 5 abrir, 6 emergente. Sólo si se pidió (content.ts).
            display: oneOf(...Object.values(RESOURCE_DISPLAY)),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
        },
        required: ["name", "visible", "coursecontentnotification"],
        forced: { coursecontentnotification: "0" },
        omit_when_zero: ["coursecontentnotification"],
        upload_fields: ["files"],
        effects: "Crea un recurso con UN archivo subido desde el borrador del usuario, con la presentación indicada si se pidió. Sin notificaciones.",
    },
    {
        id: "course_group_add",
        path: "/group/group.php",
        qf_marker: "_qf__group_form",
        query: { courseid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            name: oneLine(254),
            idnumber: (v) => v === "" || oneLine(100)(v),
            "description_editor[text]": optionalBody(20_000),
            "description_editor[format]": oneOf("1"),
            enablemessaging: oneOf("0"),
            enrolmentkey: oneOf(""),
        },
        required: ["name", "enablemessaging", "enrolmentkey"],
        forced: { enablemessaging: "0", enrolmentkey: "" },
        effects: "Crea un grupo vacío, sin conversación de grupo ni clave de matriculación. Sin notificaciones.",
    },
    {
        id: "course_grouping_add",
        path: "/group/grouping.php",
        qf_marker: "_qf__grouping_form",
        query: { courseid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { name: oneLine(254), idnumber: (v) => v === "" || oneLine(100)(v), "description_editor[text]": optionalBody(20_000), "description_editor[format]": oneOf("1") },
        required: ["name"],
        effects: "Crea un agrupamiento vacío. Sin notificaciones.",
    },
    {
        id: "course_grouping_update",
        path: "/group/grouping.php",
        qf_marker: "_qf__grouping_form",
        query: { id: int, courseid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { name: oneLine(254), "description_editor[text]": optionalBody(20_000), "description_editor[format]": oneOf("1") },
        required: ["name"],
        effects: "Cambia el nombre o la descripción de UN agrupamiento (sus grupos no cambian). Sin notificaciones (ADR-085).",
    },
    {
        id: "course_grouping_delete",
        path: "/group/grouping.php",
        qf_marker: "",
        no_get: true,
        fields: { id: int, delete: oneOf("1"), confirm: oneOf("1") },
        required: ["id", "delete", "confirm"],
        effects: "Borra UN agrupamiento (los grupos no se tocan). Sólo como deshacer de uno creado por la acción y todavía sin grupos.",
    },
    {
        id: "grouping_assign_add",
        path: "/group/assign.php",
        qf_marker: "",
        no_get: true,
        query: { id: int },
        fields: { "addselect[]": int, add: oneOf("1") },
        required: ["addselect[]", "add"],
        success_200: /id="removeselect"|name="removeselect\[\]"/,
        effects: "Agrega UN grupo al agrupamiento. La página vuelve a mostrarse: se verifica releyendo.",
    },
    {
        id: "grouping_assign_remove",
        path: "/group/assign.php",
        qf_marker: "",
        no_get: true,
        query: { id: int },
        fields: { "removeselect[]": int, remove: oneOf("1") },
        required: ["removeselect[]", "remove"],
        success_200: /id="removeselect"|name="removeselect\[\]"/,
        effects: "Quita UN grupo del agrupamiento (el grupo y sus miembros no cambian).",
    },
    {
        id: "course_group_update",
        path: "/group/group.php",
        qf_marker: "_qf__group_form",
        query: { id: int, courseid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { name: oneLine(254), idnumber: (v) => v === "" || oneLine(100)(v), "description_editor[text]": optionalBody(20_000), "description_editor[format]": oneOf("1") },
        required: ["name"],
        effects: "Cambia nombre, número de ID o descripción de UN grupo (miembros, mensajería y clave se reenvían tal cual). Sin notificaciones.",
    },
    {
        id: "course_section_edit",
        path: "/course/editsection.php",
        qf_marker: "_qf__editsection_form",
        query: { id: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: { "summary_editor[text]": optionalBody(20_000), "summary_editor[format]": oneOf("1") },
        required: ["summary_editor[text]"],
        effects: "Cambia el resumen de UNA sección (el nombre y las restricciones se reenvían tal cual). Sin notificaciones.",
    },
    {
        id: "course_group_delete",
        path: "/group/delete.php",
        qf_marker: "",
        no_get: true,
        fields: { courseid: int, groups: int, confirm: oneOf("1") },
        required: ["courseid", "groups", "confirm"],
        effects: "Borra UN grupo (irreversible; borra su conversación y lo quita de sus agrupamientos). Como deshacer de un grupo creado y vacío, o por campus_plan_delete_group con confirm_name (R4 con miembros, ADR-108).",
    },
    {
        id: "question_import",
        path: "/question/bank/importquestions/import.php",
        qf_marker: "_qf__qbank_importquestions_form_question_import_form",
        query: { cmid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            format: oneOf("gift", "xml"),
            category: (v) => /^\d{1,12},\d{1,12}$/.test(v),
            catfromfile: oneOf("0"),
            contextfromfile: oneOf("0"),
            matchgrades: oneOf("error"),
            stoponerror: oneOf("1"),
            newfile: int,
        },
        required: ["format", "category", "catfromfile", "contextfromfile", "matchgrades", "stoponerror"],
        forced: { catfromfile: "0", contextfromfile: "0", matchgrades: "error", stoponerror: "1" },
        omit_when_zero: ["catfromfile", "contextfromfile"],
        upload_fields: ["newfile"],
        success_200: /<form[^>]+action="[^"]*\/question\/edit\.php[^"]*"/,
        effects: "Importa las preguntas del archivo a la categoría elegida, sin crear categorías. No las agrega a ningún cuestionario. Sin notificaciones.",
    },
    {
        id: "quiz_add_question",
        path: "/mod/quiz/edit.php",
        qf_marker: "",
        no_get: true,
        query: { cmid: int },
        fields: { addquestion: int, addonpage: range(0, 1000) },
        required: ["addquestion", "addonpage"],
        effects: "Agrega UNA pregunta del banco al cuestionario (slot nuevo, nota 1). Moodle lo rechaza si hay intentos. Sin notificaciones.",
    },
    {
        id: "quiz_add_random",
        path: "/mod/quiz/edit.php",
        qf_marker: "",
        no_get: true,
        query: { cmid: int },
        fields: { addrandom: oneOf("1"), categoryid: int, randomcount: range(1, 20), recurse: oneOf("0", "1"), addonpage: range(0, 1000) },
        required: ["addrandom", "categoryid", "randomcount", "recurse", "addonpage"],
        effects: "Agrega N slots de pregunta aleatoria de una categoría (camino que chequea intentos). Sin notificaciones.",
    },
    {
        id: "quiz_remove_slot",
        path: "/mod/quiz/edit_rest.php",
        qf_marker: "",
        no_get: true,
        fields: { quizid: int, class: oneOf("resource"), action: oneOf("DELETE"), id: int },
        required: ["quizid", "class", "action", "id"],
        success_200: /"deleted"\s*:\s*true/,
        effects: "Quita UN slot del cuestionario (la pregunta sigue en el banco). Moodle lo rechaza si hay intentos. Sólo como deshacer de un agregado propio.",
    },
    // ADR-091: páginas y secciones de un cuestionario (camino de la página de edición; con intentos Moodle lo rechaza).
    {
        id: "quiz_repaginate",
        path: "/mod/quiz/edit.php",
        qf_marker: "",
        no_get: true,
        query: { cmid: int },
        fields: { repaginate: oneOf("1"), questionsperpage: range(0, 50) },
        required: ["repaginate", "questionsperpage"],
        effects: "Repagina el cuestionario con N preguntas por página (0 = todas en una), respetando las secciones. Borra las vistas previas. Sin notificaciones.",
    },
    {
        id: "quiz_page_break",
        path: "/mod/quiz/repaginate.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { quizid: int, slot: range(1, 1000), repag: oneOf("1", "2") },
        required: ["quizid", "slot", "repag"],
        effects: "Agrega (repag=2) o quita (repag=1) el salto de página después de UN slot. Sin notificaciones.",
    },
    {
        id: "quiz_section_add",
        path: "/mod/quiz/edit.php",
        qf_marker: "",
        no_get: true,
        query: { cmid: int, addsectionatpage: range(2, 1000) },
        fields: {},
        required: [],
        effects: "Agrega UNA sección (cabecera por defecto de Moodle) que empieza en esa página. Sin notificaciones.",
    },
    {
        id: "quiz_section_update",
        path: "/mod/quiz/edit_rest.php",
        qf_marker: "",
        no_get: true,
        fields: { quizid: int, class: oneOf("section"), field: oneOf("updatesectiontitle", "updateshufflequestions"), id: int, newheading: optionalBody(1_000), newshuffle: oneOf("0", "1") },
        required: ["quizid", "class", "field", "id"],
        success_200: /"instance(section|shuffle)"\s*:/,
        effects: "Cambia la cabecera de UNA sección o si baraja sus preguntas (intentos nuevos). Sin notificaciones.",
    },
    {
        id: "quiz_section_delete",
        path: "/mod/quiz/edit_rest.php",
        qf_marker: "",
        no_get: true,
        fields: { quizid: int, class: oneOf("section"), action: oneOf("DELETE"), id: int },
        required: ["quizid", "class", "action", "id"],
        success_200: /"deleted"\s*:\s*true/,
        effects: "Quita UNA sección (no la primera): sus preguntas pasan a la sección anterior; no borra preguntas. Sin notificaciones.",
    },
    {
        id: "question_delete",
        path: "/question/bank/deletequestion/delete.php",
        qf_marker: "",
        no_get: true,
        fields: {
            deleteselected: (v) => /^\d{1,12}(,\d{1,12}){0,199}$/.test(v),
            confirm: (v) => /^[0-9a-f]{32}$/.test(v),
            cmid: int,
            deleteall: oneOf("1"),
            returnurl: (v) => /^\/question\/edit\.php\?cmid=\d{1,12}$/.test(v),
        },
        required: ["deleteselected", "confirm", "cmid", "deleteall", "returnurl"],
        effects: "Borra las preguntas indicadas (todas sus versiones; las usadas en intentos quedan ocultas). Sólo como deshacer de una importación propia.",
    },
    {
        id: "attendance_session_add",
        path: "/mod/attendance/sessions.php",
        qf_marker: "_qf__mod_attendance_form_addsession",
        query: { id: int, action: oneOf("1") },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            "sessiondate[day]": range(1, 31),
            "sessiondate[month]": range(1, 12),
            "sessiondate[year]": range(2020, 2100),
            "sestime[starthour]": range(0, 23),
            "sestime[startminute]": range(0, 59),
            "sestime[endhour]": range(0, 23),
            "sestime[endminute]": range(0, 59),
            "sdescription[text]": optionalBody(5_000),
            "sdescription[format]": oneOf("1"),
            calendarevent: oneOf("0", "1"),
            sessiontype: oneOf("0"),
            addmultiply: oneOf("0"),
            studentscanmark: oneOf("0"),
            autoassignstatus: oneOf("0"),
        },
        required: ["sessiondate[day]", "sessiondate[month]", "sessiondate[year]", "sestime[starthour]", "sestime[startminute]", "sestime[endhour]", "sestime[endminute]"],
        // Una sola sesión, para todos, y sin que los alumnos se marquen solos.
        forced: { sessiontype: "0", addmultiply: "0", studentscanmark: "0", autoassignstatus: "0" },
        omit_when_zero: ["calendarevent", "addmultiply", "studentscanmark", "autoassignstatus"],
        effects: "Crea UNA sesión de asistencia para todos los alumnos (y su evento de calendario si calendarevent=1). Sin notificaciones.",
    },
    // ADR-089: editar UNA sesión existente (fecha, horario, descripción); el resto del formulario se reenvía tal cual.
    {
        id: "attendance_session_update",
        path: "/mod/attendance/sessions.php",
        qf_marker: "_qf__mod_attendance_form_updatesession",
        query: { id: int, action: oneOf("2"), sessionid: int },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            "sessiondate[day]": range(1, 31),
            "sessiondate[month]": range(1, 12),
            "sessiondate[year]": range(2020, 2100),
            "sestime[starthour]": range(0, 23),
            "sestime[startminute]": range(0, 59),
            "sestime[endhour]": range(0, 23),
            "sestime[endminute]": range(0, 59),
            "sdescription[text]": optionalBody(5_000),
            "sdescription[format]": oneOf("1"),
        },
        required: ["sessiondate[day]", "sessiondate[month]", "sessiondate[year]", "sestime[starthour]", "sestime[startminute]", "sestime[endhour]", "sestime[endminute]"],
        effects: "Cambia fecha, horario o descripción de UNA sesión de asistencia (lo registrado se conserva; si tiene evento de calendario, Moodle lo mueve). Sin notificaciones.",
    },
    {
        id: "attendance_session_delete",
        path: "/mod/attendance/sessions.php",
        qf_marker: "",
        no_get: true,
        query: {},
        fields: { id: int, action: oneOf("3"), sessionid: int, confirm: oneOf("1") },
        required: ["id", "action", "sessionid", "confirm"],
        effects: "Borra UNA sesión de asistencia y sus registros (irreversible). Sólo como deshacer de una sesión creada por la acción.",
    },
    {
        id: "course_modedit_assign_add",
        path: "/course/modedit.php",
        qf_marker: "_qf__mod_assign_mod_form",
        query: { add: oneOf("assign"), course: int, section: range(0, 200) },
        merge_form_defaults: true,
        submit_button: "submitbutton",
        fields: {
            name: SUBJECT,
            "introeditor[text]": optionalBody(20_000),
            "introeditor[format]": oneOf("1"),
            visible: oneOf("0", "1"),
            coursecontentnotification: oneOf("0"),
            sendnotifications: oneOf("0"),
            sendlatenotifications: oneOf("0"),
            sendstudentnotifications: oneOf("0"),
            assignsubmission_onlinetext_enabled: oneOf("0", "1"),
            assignsubmission_file_enabled: oneOf("0", "1"),
            "grade[modgrade_type]": oneOf("point"),
            "grade[modgrade_point]": range(1, 100),
            ...dateFields("allowsubmissionsfromdate"),
            ...dateFields("duedate"),
            ...dateFields("cutoffdate"),
            ...dateFields("gradingduedate"),
        },
        required: ["name", "visible", "coursecontentnotification", "sendnotifications", "sendlatenotifications", "sendstudentnotifications"],
        // Nunca notificar: aviso de contenido nuevo a participantes, avisos de entregas y notificación de calificaciones.
        forced: { coursecontentnotification: "0", sendnotifications: "0", sendlatenotifications: "0", sendstudentnotifications: "0" },
        effects:
            "GET: reserva un área borrador para la intro (y crearía secciones si la sección no existe: se valida antes). POST: crea la tarea, su ítem de calificación y sus eventos de calendario; reconstruye la caché del curso y recalcula notas finales. Con coursecontentnotification=0 no notifica.",
    },
    ...CONTENT_FORMS,
];

/** Genéricos bloqueados siempre por sí mismos (§1.2.1, §3.2): sólo pasan como tupla allowlisteada. */
const GENERIC_AJAX = new Set(["core_update_inplace_editable", "core_form_dynamic_form", "core_courseformat_update_course", "core_courseformat_new_module"]);

export function checkWriteAjax(method: string, args: Record<string, unknown>, table: readonly AjaxWriteSpec[] = WRITE_AJAX_METHODS): AjaxWriteSpec {
    const candidates = table.filter((s) => s.method === method);
    if (!candidates.length) {
        throw new CampusError("POLICY_DENIED", GENERIC_AJAX.has(method) ? `${method} es genérico: sólo se admite como tupla allowlisteada.` : `Método AJAX ${method} no admitido para escritura.`);
    }
    const spec = candidates.find((s) => !s.discriminator || args[s.discriminator.arg] === s.discriminator.value);
    if (!spec) throw new CampusError("POLICY_DENIED", `${method}: esa acción no está en la allowlist de escritura.`);
    if (GENERIC_AJAX.has(method) && !spec.discriminator) throw new CampusError("POLICY_DENIED", `${method} es genérico y su entrada no fija un discriminador.`);
    if ("sesskey" in args) throw new CampusError("POLICY_DENIED", "El sesskey lo agrega el transporte.");
    const violation = spec.validate(args);
    if (violation) throw new CampusError("POLICY_DENIED", `${method}: ${violation}.`);
    return spec;
}

export function checkWriteForm(id: string, fields: Record<string, string>, table: readonly WebFormWriteSpec[] = WRITE_WEB_FORMS): WebFormWriteSpec {
    const spec = table.find((s) => s.id === id);
    if (!spec) throw new CampusError("POLICY_DENIED", `Formulario ${id} no admitido para escritura.`);
    for (const [k, v] of Object.entries(fields)) {
        if (k === "sesskey" || k.startsWith("_qf__")) throw new CampusError("POLICY_DENIED", "sesskey y _qf__ los agrega el transporte.");
        const check = Object.hasOwn(spec.fields, k) ? spec.fields[k] : spec.field_patterns?.find(([re]) => re.test(k))?.[1];
        if (!check) throw new CampusError("POLICY_DENIED", `${id}: el campo ${k} no está en la allowlist del formulario.`);
        if (!check(v)) throw new CampusError("POLICY_DENIED", `${id}: valor inválido para ${k}.`);
    }
    const missing = spec.required.filter((k) => !(k in fields));
    if (missing.length) throw new CampusError("POLICY_DENIED", `${id}: faltan campos ${missing.join(", ")}.`);
    for (const [k, v] of Object.entries(spec.forced ?? {})) {
        if (k in fields && fields[k] !== v) throw new CampusError("POLICY_DENIED", `${id}: ${k} está fijado en ${v}.`);
    }
    return spec;
}

/** Parámetros del GET del formulario: exactamente los de la allowlist, con su validador. */
/** Páginas web que el transporte de escritura LEE como chequeo previo (no están en el servidor de lectura). */
export const WRITE_WEB_READS: Readonly<Record<string, { path: string; query: Record<string, (v: string) => boolean>; effects: string }>> = {
    assign_overrides: {
        path: "/mod/assign/overrides.php",
        query: { cmid: int, mode: oneOf("user", "group") },
        effects: "Sólo lectura: lista de excepciones de usuario o de grupo de una tarea.",
    },
    assign_override_form: {
        path: "/mod/assign/overrideedit.php",
        query: { id: int },
        effects: "Sólo lectura: formulario de una excepción existente (usuario y fechas).",
    },
    group_form_new: {
        path: "/group/group.php",
        query: { courseid: int },
        effects: "Sólo lectura: formulario de alta de grupo, para saber si la cuenta puede fijar el número de ID (el Campus lo congela sin moodle/course:changeidnumber). También da el contexto del curso (M.cfg) para el editor H5P (ADR-110).",
    },
    // ADR-110: banco de contenido del curso (lista de tipos H5P que ofrece) y editor H5P SIN guardar
    // (sólo para obtener la clave del AJAX del editor).
    h5p_contentbank: {
        path: "/contentbank/index.php",
        query: { contextid: int },
        effects: "Sólo lectura: banco de contenido del curso; de su menú «Agregar» salen los tipos H5P y sus versiones.",
    },
    h5p_editor: {
        path: "/contentbank/edit.php",
        query: { contextid: int, plugin: oneOf("h5p"), library: (v) => /^H5P\.[A-Za-z0-9]{1,60} \d{1,4}\.\d{1,4}$/.test(v) },
        effects: "Sólo lectura: abre el editor H5P del banco de contenido sin guardar nada; de ahí sale la clave del AJAX del editor.",
    },
    h5p_libraries: {
        path: "/h5p/ajax.php",
        query: { sesskey: (v) => /^[A-Za-z0-9]{6,32}$/.test(v), token: (v) => /^[A-Za-z0-9]{1,128}$/.test(v), action: oneOf("libraries") },
        effects: "Sólo lectura: bibliotecas H5P instaladas (AJAX del editor).",
    },
    h5p_library: {
        path: "/h5p/ajax.php",
        query: { sesskey: (v) => /^[A-Za-z0-9]{6,32}$/.test(v), token: (v) => /^[A-Za-z0-9]{1,128}$/.test(v), action: oneOf("libraries"), machineName: (v) => /^H5P\.[A-Za-z0-9]{1,60}$/.test(v), majorVersion: int, minorVersion: int },
        effects: "Sólo lectura: semántica y traducción de una biblioteca H5P instalada (AJAX del editor).",
    },
    group_form_edit: {
        path: "/group/group.php",
        query: { id: int, courseid: int },
        effects: "Sólo lectura: formulario de edición de un grupo, para saber si la cuenta puede cambiar el número de ID.",
    },
    grouping_form_new: {
        path: "/group/grouping.php",
        query: { courseid: int },
        effects: "Sólo lectura: formulario de alta de agrupamiento, para saber si la cuenta puede fijar el número de ID.",
    },
    grouping_assign: {
        path: "/group/assign.php",
        query: { id: int },
        effects: "Sólo lectura: grupos que tiene un agrupamiento (lista removeselect).",
    },
    quiz_edit_page: {
        path: "/mod/quiz/edit.php",
        query: { cmid: int },
        effects: "Lectura de la página de edición del cuestionario para saber si tiene intentos (aviso statusdisplay). Moodle registra el evento edit_page_viewed.",
    },
    question_import_form: {
        path: "/question/bank/importquestions/import.php",
        query: { cmid: int },
        effects: "Lectura del formulario de importación (categorías del banco). Moodle puede crear la categoría por defecto del banco si no existe, y reserva un borrador vacío.",
    },
    modedit_form: {
        path: "/course/modedit.php",
        query: { update: int },
        effects: "Lectura del formulario de edición de una actividad (descripción, opciones, archivos actuales). Moodle copia los archivos de la actividad a un borrador privado nuevo.",
    },
    // Alta de un enlace o un archivo: sólo para comprobar qué presentaciones ofrece el sitio antes de crearlo (ADR-131). Sección ya verificada.
    modedit_add_form: {
        path: "/course/modedit.php",
        query: { add: oneOf("url", "resource"), course: int, section: range(0, 200) },
        effects: "Lectura del formulario de alta de un enlace o un archivo (opciones de presentación). Moodle no crea la actividad; puede reservar un borrador de archivos vacío.",
    },
    lesson_page_form: {
        path: "/mod/lesson/editpage.php",
        query: { id: int, pageid: int, edit: oneOf("1") },
        effects: "Lectura del formulario de una página de lección (título y contenido tal como se guardaron). Moodle copia sus imágenes a un borrador privado nuevo.",
    },
    book_chapter_form: {
        path: "/mod/book/edit.php",
        query: { cmid: int, id: int },
        effects: "Lectura del formulario de un capítulo (título, nivel y contenido). Moodle copia sus imágenes a un borrador privado nuevo.",
    },
    // ADR-095: calificación avanzada (área, editores de rúbrica y guía, formulario clásico de calificación).
    grading_manage: {
        path: "/grade/grading/manage.php",
        query: { contextid: int, component: oneOf("mod_assign"), area: oneOf("submissions") },
        effects: "Lectura de la gestión de la calificación avanzada de una tarea (área, método activo y definición). Sin escrituras: los cambios de esa página van con sesskey.",
    },
    // ADR-097: preguntas de una encuesta (mod_questionnaire).
    questionnaire_questions: {
        path: "/mod/questionnaire/questions.php",
        query: { id: int },
        effects: "Lectura de la página de preguntas de una encuesta (ids en orden). Sin escrituras: sus botones van por POST.",
    },
    questionnaire_question_form: {
        path: "/mod/questionnaire/questions.php",
        query: { id: int, qid: int, action: oneOf("question") },
        effects: "Lectura del formulario de UNA pregunta de la encuesta (tipo, nombre, obligatoria, enunciado, opciones).",
    },
    lti_course_tools: {
        path: "/mod/lti/coursetools.php",
        query: { id: int },
        effects: "Sólo lectura: herramientas externas LTI del curso (ADR-117).",
    },
    lti_course_tool_form: {
        path: "/mod/lti/coursetooledit.php",
        query: { course: int, typeid: int },
        effects: "Sólo lectura: formulario de UNA herramienta externa del curso (ID de cliente LTI 1.3). No guarda nada.",
    },
    glossary_entry_form: {
        path: "/mod/glossary/edit.php",
        query: { cmid: int, id: int },
        effects: "Lectura del formulario de UNA entrada de glosario (alias, categorías, enlace automático). Crea borradores de archivos.",
    },
    grader_report: {
        path: "/grade/report/grader/index.php",
        query: { id: int },
        effects: "Lectura del informe del calificador; Moodle recalcula las notas pendientes del curso (lo mismo que al abrirlo en la web). Registra grader_report_viewed.",
    },
    grade_item_form: {
        path: "/grade/edit/tree/item.php",
        query: { courseid: int, id: int },
        effects: "Lectura del formulario de un ítem de calificación (nombre, tipo, notas máxima, mínima y de aprobación, oculto, bloqueado).",
    },
    grade_grade_form: {
        path: "/grade/edit/tree/grade.php",
        query: { courseid: int, itemid: int, userid: int },
        effects: "Lectura del formulario de la nota de UN participante en un ítem (sobrescritura, nota, excluida, oculta, bloqueada, retroalimentación).",
    },
    assign_remove_submission_confirm: {
        path: "/mod/assign/view.php",
        query: { id: int, action: oneOf("removesubmissionconfirm"), userid: int },
        effects: "Lectura de la confirmación de borrar una entrega (no borra): sirve para saber si Moodle lo permite.",
    },
    assign_grade_form: {
        path: "/mod/assign/view.php",
        query: { id: int, action: oneOf("grade"), userid: int, rownum: oneOf("0") },
        effects: "Lectura del formulario clásico de calificación de UN participante (nota o escala, rúbrica o guía, comentario, archivos). Crea borradores y, con rúbrica o guía, una instancia de calificación sin completar (Moodle la limpia).",
    },
    grading_rubric_form: {
        path: "/grade/grading/form/rubric/edit.php",
        query: { areaid: int },
        effects: "Lectura del editor de la rúbrica (criterios, niveles y puntajes guardados).",
    },
    grading_guide_form: {
        path: "/grade/grading/form/guide/edit.php",
        query: { areaid: int },
        effects: "Lectura del editor de la guía de evaluación (criterios y puntajes guardados).",
    },
    attendance_session_form: {
        path: "/mod/attendance/sessions.php",
        query: { id: int, action: oneOf("2"), sessionid: int },
        effects: "Lectura del formulario de edición de UNA sesión de asistencia (fecha, horario y descripción tal como se guardaron).",
    },
    attendance_warnings: {
        path: "/mod/attendance/warnings.php",
        query: { id: int },
        effects: "Sólo lectura: lista los umbrales de aviso por correo de la actividad de asistencia.",
    },
};

export function checkWriteFormQuery(spec: WebFormWriteSpec, query: Record<string, string>): void {
    const allowed = spec.query ?? {};
    for (const [k, v] of Object.entries(query)) {
        const check = Object.hasOwn(allowed, k) ? allowed[k] : undefined;
        if (!check) throw new CampusError("POLICY_DENIED", `${spec.id}: parámetro ${k} no admitido en el formulario.`);
        if (!check(v)) throw new CampusError("POLICY_DENIED", `${spec.id}: valor inválido para ${k}.`);
    }
    const missing = Object.keys(allowed).filter((k) => !(k in query));
    if (missing.length) throw new CampusError("POLICY_DENIED", `${spec.id}: faltan parámetros ${missing.join(", ")}.`);
}
