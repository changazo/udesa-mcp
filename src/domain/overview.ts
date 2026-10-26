import type { CourseOverview } from "../moodle/schemas.js";
import { stripSecretParams } from "../util/redact.js";
import { sourceDate, type SourceDate } from "../util/time.js";
import { decodeEntities } from "./html.js";

/**
 * Normaliza una celda del «Resumen de actividades» de Moodle 5. Cada celda trae un JSON propio
 * según su tipo (nombre, fecha, diálogo, acción, valor básico). Se conserva el valor, un texto
 * plano corto, la alerta (por ejemplo «Pendientes por calificar») y el enlace sin token. Los
 * controles de la web (interruptores, selects) quedan como texto: nada se ejecuta.
 */
export interface OverviewCell {
    key: string;
    label: string | null;
    value: string | number | boolean | null;
    text: string | null;
    date?: SourceDate | null;
    details?: { label: string | null; value: string | null }[];
    alert?: { label: string | null; count: number };
    link?: string | null;
}

const plain = (html: unknown, max = 300) => {
    if (typeof html !== "string") return null;
    const t = decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    return t ? t.slice(0, max) : null;
};

const safeLink = (u: unknown) => (typeof u === "string" && /^https?:\/\//.test(u) ? stripSecretParams(u) : null);

export function normalizeCell(item: CourseOverview["activities"][number]["items"][number], label: string | null, timeZone: string): OverviewCell {
    let j: Record<string, unknown> = {};
    try {
        const parsed = item.contentjson ? JSON.parse(item.contentjson) : {};
        if (parsed && typeof parsed === "object") j = parsed as Record<string, unknown>;
    } catch {
        // JSON inválido: la celda queda sin valor, sin inventar nada.
    }
    const type = item.exportertype ?? "";
    const cell: OverviewCell = { key: item.key, label: label ?? item.name ?? null, value: null, text: null };
    if (/activityname_exporter$/.test(type)) {
        cell.value = typeof j.activityname === "string" ? j.activityname : null;
        cell.text = typeof j.sectiontitle === "string" ? `Sección: ${j.sectiontitle}` : null;
    } else if (/humandate_exporter$/.test(type)) {
        cell.date = sourceDate(j.timestamp, timeZone);
        cell.value = cell.date?.local ?? null;
        cell.text = [j.date, j.time].filter((x) => typeof x === "string" && x).join(" ") || null;
    } else if (/overviewdialog_exporter$/.test(type)) {
        cell.value = plain(j.buttoncontent);
        cell.text = plain(j.description);
        cell.details = Array.isArray(j.items)
            ? (j.items as Record<string, unknown>[]).slice(0, 20).map((x) => ({ label: plain(x.label), value: plain(x.value) }))
            : [];
    } else if (/(overviewaction|action_link)_exporter$/.test(type)) {
        cell.value = plain(j.onlytext) ?? plain(j.content);
        cell.text = plain(j.content);
        cell.link = safeLink(j.linkurl);
    } else {
        const v = j.value;
        cell.value = typeof v === "number" || typeof v === "boolean" ? v : typeof v === "string" ? v.slice(0, 300) : null;
        if (j.datatype === "integer" && typeof v === "string" && /^-?\d+$/.test(v)) cell.value = Number(v);
        cell.text = plain(j.content);
    }
    const count = Number(item.alertcount ?? 0);
    if (Number.isFinite(count) && count > 0) cell.alert = { label: item.alertlabel ?? null, count };
    return cell;
}

/** Actividades del resumen con sus celdas normalizadas, usando el nombre de la columna como etiqueta. */
export function normalizeOverview(ov: CourseOverview, timeZone: string) {
    const labels = new Map(ov.headers.map((h) => [h.key, h.name ?? null]));
    return {
        columns: ov.headers.map((h) => ({ key: h.key, label: h.name ?? null })),
        activities: ov.activities.map((a) => ({
            course_module_id: a.cmid,
            name: a.name ?? null,
            url: safeLink(a.url),
            has_error: a.haserror ?? false,
            cells: a.items.map((it) => normalizeCell(it, labels.get(it.key) ?? null, timeZone)),
        })),
    };
}
