import type { LogEvent } from "./reports.js";

/**
 * Historial de entregas a partir del registro estándar (ADR-135). Interpretación pura: recibe las
 * filas ya parseadas del CSV de report/log y decide qué se puede afirmar. Sin red ni Moodle.
 *
 * El CSV no trae el identificador del evento: se clasifica por el par EXACTO componente + evento,
 * en español e inglés. Una etiqueta desconocida nunca es un envío. La descripción (que Moodle
 * escribe siempre en inglés, con IDs) sólo se usa como evidencia de atribución, nunca se devuelve.
 */

export type HistoryKind =
    | "envio"
    | "carga_archivo"
    | "guardado_texto"
    | "creacion_contenido"
    | "actualizacion_contenido"
    | "creacion_registro"
    | "actualizacion_registro"
    | "cambio_estado"
    | "nuevo_intento"
    | "eliminacion"
    | "declaracion_aceptada"
    | "prorroga"
    | "bloqueo"
    | "desbloqueo"
    | "calificacion"
    | "excepcion_fechas"
    | "configuracion_actividad"
    | "comentario"
    | "vista"
    | "desconocido";

/** De dónde sale cada etiqueta: vista en un export real, tomada de la fuente de Moodle 4.5 o sin confirmar. */
export type LabelEvidence = "export_real" | "fuente_moodle" | "sin_confirmar";

interface Labels {
    es: string[];
    en: string[];
}
interface ComponentLabels extends Labels {
    events: Partial<Record<HistoryKind, Labels>>;
}

/** Guardados de contenido: nunca son «envío». */
export const CONTENT_SAVE_KINDS: readonly HistoryKind[] = ["carga_archivo", "guardado_texto", "creacion_contenido", "actualizacion_contenido"];
/** Cambios sobre la entrega del participante (cuentan como «último cambio conocido»). */
const CHANGE_KINDS: readonly HistoryKind[] = ["envio", ...CONTENT_SAVE_KINDS, "creacion_registro", "actualizacion_registro", "cambio_estado", "nuevo_intento", "eliminacion"];
/** Eventos que podrían ser un envío o tocar la entrega: si no se pueden atribuir, son candidatos ambiguos. */
const CANDIDATE_KINDS: readonly HistoryKind[] = [...CHANGE_KINDS, "declaracion_aceptada", "desconocido"];
/** Eventos que pueden cambiar el vencimiento efectivo después del envío. */
const DUE_CHANGE_KINDS: readonly HistoryKind[] = ["prorroga", "excepcion_fechas", "configuracion_actividad"];

const SAVED = { es: ["Entrega creada", "Se ha creado una entrega"], en: ["Submission created"] };
const UPDATED = { es: ["Entrega actualizada", "Se ha actualizado una entrega"], en: ["Submission updated"] };

/**
 * Tabla de coincidencias exactas (tras normalizar espacios y un punto final). Inglés: cadenas de
 * mod/assign y sus subplugins en MOODLE_405_STABLE (lang/en). Español: sólo las marcadas en
 * CONFIRMED_ES se vieron en un export real del Campus; el resto queda «sin_confirmar» hasta tener
 * una muestra anonimizada (un error deja el evento como desconocido, nunca como envío).
 */
const TABLE: Record<"assign" | "file" | "onlinetext" | "comments" | "system", ComponentLabels> = {
    assign: {
        es: ["Tarea"],
        en: ["Assignment"],
        events: {
            envio: { es: ["Se ha enviado una entrega"], en: ["A submission has been submitted"] },
            creacion_registro: SAVED,
            actualizacion_registro: UPDATED,
            cambio_estado: { es: ["El estado de la entrega ha sido actualizado", "Se ha actualizado el estado de la entrega"], en: ["The status of the submission has been updated"] },
            nuevo_intento: { es: ["El usuario ha duplicado su entrega"], en: ["The user duplicated their submission"] },
            eliminacion: { es: ["Entrega eliminada", "Se ha eliminado la entrega"], en: ["Submission removed"] },
            declaracion_aceptada: { es: ["El usuario ha aceptado la declaración de la entrega"], en: ["The user has accepted the statement of the submission"] },
            prorroga: { es: ["Se ha concedido una prórroga", "Prórroga concedida"], en: ["An extension has been granted"] },
            bloqueo: { es: ["Las entregas han sido bloqueadas para un usuario"], en: ["The submissions have been locked for a user"] },
            desbloqueo: { es: ["Las entregas han sido desbloqueadas para un usuario"], en: ["The submissions have been unlocked for a user"] },
            calificacion: { es: ["La entrega ha sido calificada"], en: ["The submission has been graded"] },
            excepcion_fechas: {
                es: ["Anulación de tarea creada", "Anulación de tarea actualizada", "Anulación de tarea eliminada"],
                en: ["Assignment override created", "Assignment override updated", "Assignment override deleted"],
            },
            vista: {
                es: ["Se ha visualizado el estado de la entrega", "Formulario de calificaciones visto", "Módulo del curso visto"],
                en: ["The status of the submission has been viewed", "Grading form viewed", "Submission form viewed", "Course module viewed"],
            },
        },
    },
    file: {
        es: ["Envíos de archivos", "Envío de archivos"],
        en: ["File submissions"],
        events: { carga_archivo: { es: ["Se ha subido un archivo"], en: ["A file has been uploaded"] }, creacion_contenido: SAVED, actualizacion_contenido: UPDATED },
    },
    onlinetext: {
        es: ["Texto en línea", "Envíos de texto en línea"],
        en: ["Online text submissions"],
        events: { guardado_texto: { es: ["Se ha subido un texto en línea"], en: ["An online text has been uploaded"] }, creacion_contenido: SAVED, actualizacion_contenido: UPDATED },
    },
    comments: {
        es: ["Comentarios del alumno"],
        en: ["Submission comments"],
        events: { comentario: { es: ["Comentario creado", "Comentario eliminado"], en: ["Comment created", "Comment deleted"] } },
    },
    system: {
        es: ["Sistema"],
        en: ["System"],
        events: { configuracion_actividad: { es: ["Módulo del curso actualizado"], en: ["Course module updated"] } },
    },
};

/** Etiquetas españolas vistas en un export real del Campus (sandbox, 2026-11-16). Componente|evento. */
const CONFIRMED_ES = new Set([
    "Tarea|Se ha visualizado el estado de la entrega",
    "Tarea|Formulario de calificaciones visto",
    "Tarea|Módulo del curso visto",
    "Tarea|Anulación de tarea creada",
    "Tarea|Anulación de tarea actualizada",
    "Tarea|Anulación de tarea eliminada",
    "Sistema|Módulo del curso actualizado",
    "Comentarios del alumno|Comentario creado",
    "Comentarios del alumno|Comentario eliminado",
]);
/** Cadenas inglesas tomadas de la fuente de Moodle 4.5 (mod/assign y subplugins file/onlinetext). */
const SOURCE_EN_COMPONENTS = new Set(["Assignment", "File submissions", "Online text submissions"]);
const CORE_EN_UNCONFIRMED = new Set(["Course module viewed", "Course module updated"]);

/** Normalización mínima: NFC, espacios colapsados (Moodle emite dobles espacios) y un punto final. */
export function normLabel(s: string | null): string {
    return (s ?? "").normalize("NFC").trim().replace(/\s+/g, " ").replace(/\.$/, "");
}

export interface LabelMatch {
    kind: HistoryKind;
    language: "es" | "en";
    evidence: LabelEvidence;
    /** Componente de tarea (mod_assign o sus subplugins), a diferencia de «Sistema». */
    assign_component: boolean;
}

export function classifyLabel(component: string | null, eventName: string | null): LabelMatch | null {
    const c = normLabel(component);
    const e = normLabel(eventName);
    for (const [group, def] of Object.entries(TABLE) as [keyof typeof TABLE, ComponentLabels][]) {
        for (const language of ["es", "en"] as const) {
            if (!def[language].includes(c)) continue;
            for (const [kind, labels] of Object.entries(def.events) as [HistoryKind, Labels][]) {
                if (!labels[language].includes(e)) continue;
                const evidence: LabelEvidence =
                    language === "es"
                        ? CONFIRMED_ES.has(`${c}|${e}`) ? "export_real" : "sin_confirmar"
                        : SOURCE_EN_COMPONENTS.has(c) && !CORE_EN_UNCONFIRMED.has(e) ? "fuente_moodle" : "sin_confirmar";
                return { kind, language, evidence, assign_component: group !== "system" };
            }
        }
    }
    return null;
}

/** ¿El componente es de la tarea (aunque el evento no esté en la tabla)? */
function isAssignComponent(component: string | null): { assign: boolean; language: "es" | "en" | null } {
    const c = normLabel(component);
    for (const g of ["assign", "file", "onlinetext"] as const) {
        if (TABLE[g].es.includes(c)) return { assign: true, language: "es" };
        if (TABLE[g].en.includes(c)) return { assign: true, language: "en" };
    }
    return { assign: false, language: TABLE.system.es.includes(c) ? "es" : TABLE.system.en.includes(c) ? "en" : null };
}

// ---------- Descripciones (inglés fijo de Moodle, con IDs) ----------

interface DescriptionIds {
    actor: number | null;
    related: number | null;
    cmids: number[];
    module_created: boolean;
}

/** Sólo IDs con forma fija; nunca nombres. La descripción no se devuelve. */
export function descriptionIds(description: string | null): DescriptionIds {
    const d = description ?? "";
    const actor = /^The user with id '(\d+)'/.exec(d);
    const related = /\bfor the user with id '(\d+)'/.exec(d);
    const cmids = [...d.matchAll(/course module id '(\d+)'/g)].map((m) => Number(m[1]));
    return { actor: actor ? Number(actor[1]) : null, related: related ? Number(related[1]) : null, cmids, module_created: /^The user with id '\d+' created the '[a-z0-9_]+' activity with course module id '\d+'\.?$/.test(d) };
}

// ---------- Hora del export ----------

export type DateOrder = "dmy" | "mdy";

interface LocalParts {
    y: number;
    mo: number;
    d: number;
    h: number;
    mi: number;
    s: number | null;
}

const TIME_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** «28/10/26, 00:57:32» (como exporta el Campus en español). Sin segundos → precisión de minuto. */
export function parseLogTime(text: string, order: DateOrder): LocalParts | null {
    const m = TIME_RE.exec(text.trim());
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const [d, mo] = order === "dmy" ? [a, b] : [b, a];
    const h = Number(m[4]);
    const mi = Number(m[5]);
    const s = m[6] === undefined ? null : Number(m[6]);
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || (s !== null && s > 59)) return null;
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
    return { y, mo, d, h, mi, s };
}

const naiveSeconds = (p: LocalParts) => Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s ?? 0) / 1000;

/** Offset (segundos) de la zona en un instante. */
export function offsetSeconds(unix: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(unix * 1000));
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) : 0;
}

/** Hora local → Unix en la zona. null si la hora no existe o es ambigua (cambio de horario). */
export function zonedToUnix(naive: number, timeZone: string): number | null {
    const sols = new Set<number>();
    for (const probe of [naive - 86400, naive, naive + 86400]) {
        const off = offsetSeconds(probe, timeZone);
        const u = naive - off;
        if (offsetSeconds(u, timeZone) === off) sols.add(u);
    }
    return sols.size === 1 ? [...sols][0]! : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoLocal = (p: LocalParts) => `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}${p.s === null ? "" : `:${pad(p.s)}`}`;
const isoWithOffset = (unix: number, off: number, withSeconds: boolean) => {
    const d = new Date((unix + off) * 1000).toISOString();
    const sign = off < 0 ? "-" : "+";
    const a = Math.abs(off);
    return `${withSeconds ? d.slice(0, 19) : d.slice(0, 16)}${sign}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}`;
};

// ---------- Armado del historial ----------

export interface HistoryEvent {
    kind: HistoryKind;
    /** Posición en la descarga indicada; sólo trazabilidad, no es un ID estable. */
    row: number;
    download: "participante" | "actividad";
    time_text: string;
    /** Hora local tal como la escribió el export (sin zona), si la fecha se interpreta sin ambigüedad. */
    local: string | null;
    /** Instante con offset y en UTC: sólo con zona verificada. */
    iso: string | null;
    utc: string | null;
    precision: "segundo" | "minuto" | "desconocida";
    attribution: {
        basis: "filtro_nativo_y_descripcion" | "filtro_nativo" | "descripcion_usuario_afectado";
        operator: "participante" | "otro_usuario";
        operator_user_id: number | null;
    };
    label: { component: string | null; event_name: string | null; language: "es" | "en" | null; evidence: LabelEvidence | null };
}

interface Internal {
    ev: HistoryEvent;
    naive: number | null;
    lo: number | null;
    hi: number | null;
}

export interface HistoryInput {
    participantId: number;
    cmid: number;
    timeZone: string;
    /** Descarga con el filtro nativo de usuario (actor = participante) y la actividad. */
    own: LogEvent[];
    /** Descarga de toda la actividad (cambios), para acciones delegadas y candidatos ambiguos. null = no disponible. */
    module: LogEvent[] | null;
    moduleUnavailable: string | null;
    /** Última modificación de la entrega según Moodle (Unix): ancla para verificar la zona del export. */
    anchorUnix: number | null;
    due: { state: "ok"; unix: number } | { state: "sin_vencimiento" } | { state: "desconocido"; reason: string };
    /** Apertura de entregas del participante (Unix), si existe. */
    openingUnix: number | null;
}

export type Timing = "on_time" | "late" | "unknown" | "no_due_date";

export function buildHistory(input: HistoryInput) {
    const { participantId: P, cmid, timeZone: tz } = input;
    const all = [...input.own, ...(input.module ?? [])];

    // Idioma del export: alcanza con una etiqueta reconocida. Español fija día/mes/año.
    const languages = new Set<string>();
    for (const e of all) {
        const m = classifyLabel(e.component, e.event_name);
        const c = isAssignComponent(e.component);
        if (m) languages.add(m.language);
        else if (c.language) languages.add(c.language);
    }
    const orders: DateOrder[] = languages.has("es") && !languages.has("en") ? ["dmy"] : ["dmy", "mdy"];

    // Zona verificable: con la zona del perfil, el ÚLTIMO cambio de la entrega en el registro coincide
    // (±2 s, o dentro del minuto si no hay segundos) con la última modificación que informa Moodle.
    // Ser «el último» no depende del desplazamiento, así que otra zona no puede coincidir por azar.
    const anchor = input.anchorUnix;
    // Ancla sólo contra eventos del participante: propios o con su ID como usuario afectado.
    const anchorEvents = [...input.own, ...(input.module ?? []).filter((e) => descriptionIds(e.description).related === P)];
    const anchorMatches = (order: DateOrder) => {
        if (anchor === null) return false;
        const expected = offsetSeconds(anchor, tz);
        const parsed = anchorEvents
            .filter((e) => {
                const m = classifyLabel(e.component, e.event_name);
                return m !== null && CHANGE_KINDS.includes(m.kind);
            })
            .map((e) => parseLogTime(e.time_text, order))
            .filter((p): p is LocalParts => p !== null);
        if (!parsed.length) return false;
        const latest = Math.max(...parsed.map(naiveSeconds));
        return parsed
            .filter((p) => naiveSeconds(p) === latest)
            .some((p) => {
                const d = naiveSeconds(p) - expected - anchor;
                return p.s === null ? d >= -61 && d <= 2 : Math.abs(d) <= 2;
            });
    };
    const verifiedOrders = orders.filter(anchorMatches);
    const sameUnderBoth = all.every((e) => {
        const a = parseLogTime(e.time_text, "dmy");
        const b = parseLogTime(e.time_text, "mdy");
        return (a === null && b === null) || (a !== null && b !== null && naiveSeconds(a) === naiveSeconds(b));
    });
    let order: DateOrder | null = null;
    let zoneVerified = false;
    if (verifiedOrders.length === 1 || (verifiedOrders.length === 2 && sameUnderBoth)) {
        order = verifiedOrders[0]!;
        zoneVerified = true;
    } else if (orders.length === 1 || sameUnderBoth) order = orders[0]!;
    const zoneReason = zoneVerified
        ? null
        : anchor === null
          ? "No hay última modificación de la entrega para verificar la zona horaria del export."
          : verifiedOrders.length === 2
            ? "El formato de fecha del export es ambiguo (día/mes o mes/día)."
            : "El último cambio del registro no coincide, con la zona del perfil, con la última modificación de la entrega: la zona del export no está verificada.";

    const toInternal = (e: LogEvent, download: HistoryEvent["download"], kind: HistoryKind, attribution: HistoryEvent["attribution"]): Internal => {
        const m = classifyLabel(e.component, e.event_name);
        const lang = m?.language ?? isAssignComponent(e.component).language;
        const p = order ? parseLogTime(e.time_text, order) : null;
        const naive = p ? naiveSeconds(p) : null;
        const base = p && zoneVerified ? zonedToUnix(naive!, tz) : null;
        const lo = base;
        const hi = base === null ? null : base + (p!.s === null ? 59 : 0);
        const off = base !== null ? offsetSeconds(base, tz) : 0;
        return {
            naive,
            lo,
            hi,
            ev: {
                kind,
                row: e.row,
                download,
                time_text: e.time_text,
                local: p ? isoLocal(p) : null,
                iso: base !== null ? isoWithOffset(base, off, p!.s !== null) : null,
                utc: base !== null ? new Date(base * 1000).toISOString().slice(0, p!.s === null ? 16 : 19) + "Z" : null,
                precision: !p ? "desconocida" : p.s === null ? "minuto" : "segundo",
                attribution,
                label: { component: e.component, event_name: e.event_name, language: lang, evidence: m?.evidence ?? null },
            },
        };
    };

    const timeline: Internal[] = [];
    const ambiguous: Internal[] = [];
    let anomalies = 0;
    let othersIgnored = 0;
    let delegated = 0;
    let moduleCreated = false;
    const dueChanges: Internal[] = [];

    const cmOk = (ids: DescriptionIds) => ids.cmids.every((c) => c === cmid);
    for (const e of input.own) {
        const m = classifyLabel(e.component, e.event_name);
        const ids = descriptionIds(e.description);
        const kind = m?.kind ?? "desconocido";
        // Filtro nativo = actor; la descripción, si trae IDs, tiene que coincidir.
        const consistent = (ids.actor === null || ids.actor === P) && (ids.related === null || ids.related === P) && cmOk(ids);
        if (!consistent) {
            anomalies++;
            ambiguous.push(toInternal(e, "participante", kind, { basis: "filtro_nativo", operator: "participante", operator_user_id: null }));
            continue;
        }
        if (kind === "vista") continue;
        timeline.push(toInternal(e, "participante", kind, { basis: ids.actor === P ? "filtro_nativo_y_descripcion" : "filtro_nativo", operator: "participante", operator_user_id: null }));
    }
    for (const e of input.module ?? []) {
        const m = classifyLabel(e.component, e.event_name);
        const ids = descriptionIds(e.description);
        if (ids.module_created && cmOk(ids)) moduleCreated = true;
        const kind = m?.kind ?? "desconocido";
        if (!cmOk(ids)) continue;
        if (ids.actor === P) continue; // propia: ya está en la descarga filtrada
        if (m && DUE_CHANGE_KINDS.includes(kind)) dueChanges.push(toInternal(e, "actividad", kind, { basis: "descripcion_usuario_afectado", operator: "otro_usuario", operator_user_id: ids.actor }));
        const relevant = m ? CANDIDATE_KINDS.includes(kind) && m.assign_component : isAssignComponent(e.component).assign;
        if (!relevant) continue;
        if (ids.actor !== null && ids.related === P) {
            delegated++;
            timeline.push(toInternal(e, "actividad", kind, { basis: "descripcion_usuario_afectado", operator: "otro_usuario", operator_user_id: ids.actor }));
        } else if (ids.actor !== null && ids.related === null && e.affected_user === null) {
            othersIgnored++; // acción propia de otra persona sobre su entrega
        } else if (ids.related !== null && ids.related !== P) {
            othersIgnored++;
        } else {
            // Otro usuario actuando sobre alguien no identificable por ID: no se atribuye por nombre.
            ambiguous.push(toInternal(e, "actividad", kind, { basis: "descripcion_usuario_afectado", operator: "otro_usuario", operator_user_id: ids.actor }));
        }
    }

    // Orden cronológico por hora normalizada. En el mismo segundo decide la posición en la descarga,
    // según su sentido observado (el Campus exporta del más reciente al más antiguo; si no se puede
    // determinar, se asume ese).
    const direction = (events: LogEvent[]): 1 | -1 => {
        const times = order ? events.map((e) => parseLogTime(e.time_text, order)).filter((p): p is LocalParts => p !== null).map(naiveSeconds) : [];
        const asc = times.length > 1 && times.every((t, i) => i === 0 || t >= times[i - 1]!) && times[0]! < times[times.length - 1]!;
        return asc ? 1 : -1;
    };
    const dir = { participante: direction(input.own), actividad: direction(input.module ?? []) };
    const key = (x: Internal) => x.naive ?? Number.MAX_SAFE_INTEGER;
    timeline.sort((a, b) => key(a) - key(b) || (a.ev.download === b.ev.download ? dir[a.ev.download] * (a.ev.row - b.ev.row) : 0));
    const firstOf = (kinds: readonly HistoryKind[]) => timeline.find((x) => kinds.includes(x.ev.kind) && x.naive !== null) ?? null;
    const first = firstOf(["envio"]);
    const firstSave = firstOf(CONTENT_SAVE_KINDS);
    const changes = timeline.filter((x) => CHANGE_KINDS.includes(x.ev.kind) && x.naive !== null);
    const last = changes.length ? changes[changes.length - 1]! : null;
    const unparsed = timeline.filter((x) => x.naive === null).length + ambiguous.filter((x) => x.naive === null).length;

    // Cobertura previa: el registro conserva la creación de la actividad o algo anterior a la apertura.
    const allInternal = [...timeline, ...ambiguous];
    // La retención se prueba con cualquier evento conservado de la actividad, sea de quien sea.
    let earliest: number | null = null;
    if (zoneVerified && order) {
        for (const e of all) {
            const p = parseLogTime(e.time_text, order);
            const u = p ? zonedToUnix(naiveSeconds(p), tz) : null;
            if (u !== null && (earliest === null || u < earliest)) earliest = u;
        }
    }
    const priorCovered = input.module !== null && (moduleCreated || (input.openingUnix !== null && earliest !== null && earliest <= input.openingUnix));

    // ---------- Decisión ----------
    let timing: Timing = "unknown";
    let reason: string;
    let diff: { min_seconds: number; max_seconds: number } | null = null;
    const due = input.due;
    if (due.state === "sin_vencimiento") {
        timing = "no_due_date";
        reason = "Moodle confirma que la tarea no tiene vencimiento para este participante.";
    } else if (due.state === "desconocido") reason = due.reason;
    else if (!zoneVerified) reason = zoneReason!;
    else if (!first) reason = "No se observó un evento explícito de envío atribuible: no se afirma un primer envío ni una tardanza.";
    else if (first.lo === null || first.hi === null) reason = "La hora del primer envío observado no se pudo resolver sin ambigüedad.";
    else {
        diff = { min_seconds: first.lo - due.unix, max_seconds: first.hi - due.unix };
        if (first.hi <= due.unix) {
            timing = "on_time";
            reason = "Envío explícito atribuible a la hora límite o antes.";
        } else if (first.lo <= due.unix) reason = "La precisión del registro (sin segundos) no alcanza: el intervalo compatible cruza el vencimiento.";
        else {
            // Candidatos que podrían ser un envío anterior: no atribuibles, o propios con etiqueta desconocida.
            const ambiguousBefore =
                ambiguous.filter((x) => x.lo === null || x.lo <= first.hi!).length + timeline.filter((x) => x.ev.kind === "desconocido" && (x.lo === null || x.lo <= first.hi!)).length;
            const blockers = [
                !priorCovered ? (input.module === null ? `no se pudo leer el registro completo de la actividad (${input.moduleUnavailable ?? "sin detalle"})` : "no hay evidencia de que el registro conserve el período previo (ni la creación de la actividad ni eventos anteriores a la apertura)") : null,
                ambiguousBefore ? `${ambiguousBefore} evento(s) candidato(s) no atribuible(s) o desconocido(s) antes del envío observado` : null,
                unparsed ? `${unparsed} evento(s) con hora no interpretable` : null,
            ].filter(Boolean);
            if (blockers.length) reason = `El primer envío observado es posterior al vencimiento, pero no se puede descartar uno anterior: ${blockers.join("; ")}.`;
            else {
                timing = "late";
                reason = "El primer envío comprobado es posterior al vencimiento y el período previo está cubierto por el registro recuperado.";
            }
        }
    }

    const dueChangedAfter = input.module === null ? null : first?.lo == null ? null : dueChanges.some((x) => x.lo === null || x.lo >= first.lo!);
    const evidenceUsed = new Set(allInternal.map((x) => x.ev.label.evidence).filter((x): x is LabelEvidence => x !== null));

    return {
        timeline: timeline.map((x) => x.ev),
        first_submission_observed: first?.ev ?? null,
        first_content_save_observed: firstSave?.ev ?? null,
        last_change_observed: last?.ev ?? null,
        counts: {
            submissions_observed: timeline.filter((x) => x.ev.kind === "envio").length,
            content_saves_observed: timeline.filter((x) => CONTENT_SAVE_KINDS.includes(x.ev.kind)).length,
            delegated_events: delegated,
            non_attributable_candidates: ambiguous.length,
            inconsistent_own_events: anomalies,
            unknown_labels: allInternal.filter((x) => x.ev.kind === "desconocido").length,
            other_participants_events_ignored: othersIgnored,
        },
        time_zone: {
            zone: tz,
            verified: zoneVerified,
            method: zoneVerified ? "ancla: última modificación de la entrega (Moodle) contra el registro" : null,
            date_order: order === "dmy" ? "día/mes/año" : order === "mdy" ? "mes/día/año" : null,
            reason: zoneReason,
        },
        timing: { result: timing, reason: reason!, observed_difference: diff },
        prior_interval_covered: priorCovered,
        due_may_have_changed_after_submission: dueChangedAfter,
        unconfirmed_labels_used: evidenceUsed.has("sin_confirmar"),
        earliest_event_unix: earliest,
    };
}
