import { CampusError } from "../errors.js";
import { decodeEntities } from "../domain/html.js";
import { inspectPage, type WebOperation, type WebTransport } from "../web/transport.js";
import type { Logger } from "../util/logger.js";
import { checkWriteAjax, checkWriteForm, checkWriteFormQuery, WRITE_AJAX_METHODS, WRITE_WEB_FORMS, WRITE_WEB_READS, type AjaxWriteSpec, type WebFormWriteSpec } from "./functions.js";
import { WriteUncertainError } from "./transport.js";

/**
 * Escrituras por SESIÓN WEB (directiva §5.2, ADR-050): formularios y AJAX allowlisteados.
 * - El chequeo de la allowlist ocurre antes de cualquier petición.
 * - Una petición de escritura por llamada, sin reintentos ni redirecciones seguidas.
 * - Formularios: el éxito es una redirección (3xx); un 200 con el formulario y errores es
 *   MOODLE_REJECTED (con los mensajes); cualquier otra cosa es incierta (se reconcilia por lectura).
 * - sesskey y cookies nunca se registran ni se devuelven.
 */

/** Campos de un formulario HTML tal como los enviaría el navegador sin tocar nada. */
export function parseFormFields(html: string, qfMarker: string): [string, string][] | null {
    const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((m) => m[0]);
    const form = forms.find((f) => new RegExp(`name=["']${qfMarker}["']`).test(f));
    if (!form) return null;
    const attr = (tag: string, name: string) => {
        const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
        return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
    };
    const has = (tag: string, name: string) => new RegExp(`\\s${name}(\\s|=|>|/)`, "i").test(tag);
    const out: [string, string][] = [];
    // Recorre en orden de aparición inputs, selects y textareas.
    const re = /<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi;
    for (const m of form.matchAll(re)) {
        const el = m[0];
        const open = /^<[^>]*>/.exec(el)?.[0] ?? el;
        const name = attr(open, "name");
        if (!name || has(open, "disabled")) continue;
        if (/^<input/i.test(el)) {
            const type = (attr(open, "type") ?? "text").toLowerCase();
            if (["submit", "button", "image", "file", "reset"].includes(type)) continue;
            if ((type === "checkbox" || type === "radio") && !has(open, "checked")) continue;
            out.push([name, attr(open, "value") ?? (type === "checkbox" ? "on" : "")]);
        } else if (/^<select/i.test(el)) {
            const options = [...el.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
            const selected = options.filter((o) => /\sselected(\s|=|$)/i.test(` ${o[1]}`));
            const pick = selected.length ? selected : has(open, "multiple") ? [] : options.slice(0, 1);
            for (const o of pick) out.push([name, attr(`<option ${o[1]}>`, "value") ?? decodeEntities(o[2]!.trim())]);
        } else {
            out.push([name, decodeEntities(el.replace(/^<textarea\b[^>]*>/i, "").replace(/<\/textarea>$/i, "")).replace(/^\n/, "")]);
        }
    }
    return out;
}

/** Errores de validación de un formulario de Moodle devuelto con 200. */
export function formErrors(html: string): string[] {
    const errs = [...html.matchAll(/id=["']id_error_[^"']*["'][^>]*>([\s\S]*?)<\/(div|span)>/gi)]
        .map((m) => decodeEntities(m[1]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim())
        .filter(Boolean);
    const box = inspectPage(html).error;
    return [...new Set([...errs, ...(box ? [box] : [])])].slice(0, 10);
}

export interface FormSubmission {
    /** Destino de la redirección de éxito (ruta sin credenciales). */
    location: string;
}

export class WebWriter {
    /** Escrituras emitidas por web (sin contar GET ni la verificación de identidad). */
    writesSent = 0;

    constructor(
        private readonly web: WebTransport | null,
        private readonly logger: Logger,
        private readonly tables: { forms?: readonly WebFormWriteSpec[]; ajax?: readonly AjaxWriteSpec[] } = {},
    ) {}

    private async open(): Promise<WebOperation> {
        if (!this.web) throw new CampusError("AUTH_REQUIRED", "Esta escritura necesita la sesión web del Campus y no hay una configurada.");
        return this.web.open();
    }

    private async close(op: WebOperation) {
        try {
            await this.web?.afterOperation(op);
        } catch {
            /* persistir una rotación es opcional */
        }
    }

    /**
     * GET del formulario (con efectos declarados: área borrador) y POST con los campos del plan
     * sobre los valores que sirve Moodle. Una sola escritura.
     */
    async submitForm(formId: string, query: Record<string, string>, fields: Record<string, string>, beforePost?: (served: [string, string][]) => Promise<void>): Promise<FormSubmission> {
        const spec0 = checkWriteForm(formId, fields, this.tables.forms ?? WRITE_WEB_FORMS);
        checkWriteFormQuery(spec0, query);
        // Marcador que depende del GET (ADR-095): el valor ya pasó el validador de la query.
        const spec = spec0.qf_marker_query ? { ...spec0, qf_marker: spec0.qf_marker + query[spec0.qf_marker_query]! } : spec0;
        // Secretos del entorno (ADR-117): se resuelven antes de abrir nada; si falta uno, no se envía.
        const secrets: Record<string, string> = {};
        for (const [k, { env }] of Object.entries(spec.secret_fields ?? {})) {
            const v = process.env[env];
            if (!v) throw new CampusError("WRITE_NOT_ALLOWED", `Falta la variable de entorno ${env} para el formulario ${formId}.`);
            secrets[k] = v;
        }
        const started = Date.now();
        let outcome = "ok";
        const op = await this.open();
        try {
            if (spec.no_get) return await this.postOnly(op, spec, query, fields);
            const page = await op.writeRequest(spec.path, new URLSearchParams(query), { method: "GET" });
            if (page.status !== 200) throw new CampusError(page.status === 403 ? "MOODLE_PERMISSION_DENIED" : "UNEXPECTED_RESPONSE", `El formulario ${formId} respondió HTTP ${page.status}${page.location ? " con una redirección" : ""}.`);
            const html = new TextDecoder().decode(page.bytes);
            const info = inspectPage(html);
            if (info.login) throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció.");
            const base = spec.merge_form_defaults ? parseFormFields(html, spec.qf_marker) : [];
            if (base === null) throw new CampusError(info.error ? "MOODLE_PERMISSION_DENIED" : "UNEXPECTED_RESPONSE", info.error ? `El Campus rechazó abrir el formulario: ${info.error}` : `No se encontró el formulario ${spec.qf_marker} en la página.`);
            // Preparación sobre lo servido (p. ej. el borrador de archivos del formulario): si falla, no se envía nada.
            if (beforePost) await beforePost(base);
            let override: Record<string, string> = { ...fields, ...(spec.forced ?? {}), ...secrets };
            if (spec.field_map) {
                // Campo lógico → nombre real: exactamente UN campo servido tiene que cumplir el patrón.
                const mapped: Record<string, string> = {};
                for (const [k, v] of Object.entries(override)) {
                    const re = spec.field_map[k];
                    if (!re) {
                        mapped[k] = v;
                        continue;
                    }
                    const real = [...new Set(base.filter(([n]) => re.test(n)).map(([n]) => n))];
                    if (real.length !== 1) throw new CampusError("UNEXPECTED_RESPONSE", `El formulario ${formId} no tiene un único campo para ${k}.`);
                    mapped[real[0]!] = v;
                }
                override = mapped;
            }
            const omitted = new Set((spec.omit_when_zero ?? []).filter((k) => override[k] === "0"));
            const body = new URLSearchParams();
            for (const [k, v] of base) if (!(k in override) && k !== "sesskey" && !k.startsWith("_qf__") && k !== spec.submit_button) body.append(k, v);
            for (const [k, v] of Object.entries(override)) if (!omitted.has(k)) body.append(k, v);
            body.set("sesskey", op.sesskeyForWrite);
            if (spec.qf_marker && !spec.marker_is_field) body.set(spec.qf_marker, "1");
            if (spec.submit_button) body.set(spec.submit_button, "1");
            this.writesSent++;
            let res;
            try {
                res = await op.writeRequest(spec.path, null, { method: "POST", body: body.toString(), contentType: "application/x-www-form-urlencoded" });
            } catch (e) {
                if (e instanceof CampusError && e.code === "NETWORK_ERROR") throw new WriteUncertainError(`${formId}: falla de red al enviar el formulario. Puede haberse aplicado o no: se reconcilia por lectura.`);
                throw e;
            }
            if (res.status >= 300 && res.status < 400 && res.location) return { location: res.location };
            if (res.status === 200) {
                const out = new TextDecoder().decode(res.bytes);
                if (inspectPage(out).login) throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció al enviar el formulario.");
                if (spec.success_200 && spec.success_200.test(out) && (spec.success_200_same_form ? !formErrors(out).length : !parseFormFields(out, spec.qf_marker))) return { location: "" };
                const errors = formErrors(out);
                if (errors.length || parseFormFields(out, spec.qf_marker)) {
                    throw new CampusError("MOODLE_REJECTED", `Moodle rechazó el formulario ${formId}: ${errors.join(" · ") || "volvió el formulario sin errores visibles"}.`, { details: { form_errors: errors } });
                }
            }
            throw new WriteUncertainError(`${formId}: respuesta inesperada (HTTP ${res.status}). Puede haberse aplicado o no: se reconcilia por lectura.`);
        } catch (e) {
            outcome = e instanceof WriteUncertainError ? "UNCERTAIN" : e instanceof CampusError ? e.code : "INTERNAL";
            throw e;
        } finally {
            await this.close(op);
            this.logger.log(outcome === "ok" ? "info" : "warn", "moodle_write_form", { form: formId, outcome, duration_ms: Date.now() - started });
        }
    }

    /** Acción confirmada sin formulario: UN POST con los campos y el sesskey; éxito = redirección. */
    private async postOnly(op: WebOperation, spec: WebFormWriteSpec, query: Record<string, string>, fields: Record<string, string>): Promise<FormSubmission> {
        const body = new URLSearchParams(fields);
        body.set("sesskey", op.sesskeyForWrite);
        this.writesSent++;
        let res;
        try {
            res = await op.writeRequest(spec.path, Object.keys(query).length ? new URLSearchParams(query) : null, { method: "POST", body: body.toString(), contentType: "application/x-www-form-urlencoded" });
        } catch (e) {
            if (e instanceof CampusError && e.code === "NETWORK_ERROR") throw new WriteUncertainError(`${spec.id}: falla de red. Puede haberse aplicado o no: se reconcilia por lectura.`);
            throw e;
        }
        if (res.status >= 300 && res.status < 400 && res.location) return { location: res.location };
        if (res.status === 200) {
            const out = new TextDecoder().decode(res.bytes);
            if (spec.success_200 && spec.success_200.test(out)) return { location: "" };
            const info = inspectPage(out);
            if (info.login) throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció.");
            if (info.error) throw new CampusError("MOODLE_REJECTED", `Moodle rechazó ${spec.id}: ${info.error}`);
        }
        throw new WriteUncertainError(`${spec.id}: respuesta inesperada (HTTP ${res.status}). Puede haberse aplicado o no: se reconcilia por lectura.`);
    }

    /** Lectura de una página de chequeo previo de WRITE_WEB_READS (GET, sin efectos auditados). */
    async readPage(routeId: string, query: Record<string, string>): Promise<string> {
        return this.readPages((get) => get(routeId, query));
    }

    /** Varias lecturas de WRITE_WEB_READS en UNA operación web (una sola verificación de identidad). */
    async readPages<T>(fn: (get: (routeId: string, query: Record<string, string>) => Promise<string>) => Promise<T>): Promise<T> {
        const op = await this.open();
        try {
            return await fn(async (routeId, query) => {
                const route = Object.hasOwn(WRITE_WEB_READS, routeId) ? WRITE_WEB_READS[routeId] : undefined;
                if (!route) throw new CampusError("POLICY_DENIED", `Página ${routeId} no admitida.`);
                const keys = Object.keys(query);
                if (keys.length !== Object.keys(route.query).length || !keys.every((k) => Object.hasOwn(route.query, k) && route.query[k]!(query[k]!))) throw new CampusError("POLICY_DENIED", `${routeId}: parámetros no admitidos.`);
                const page = await op.writeRequest(route.path, new URLSearchParams(query), { method: "GET" });
                if (page.status !== 200) throw new CampusError(page.status === 403 ? "MOODLE_PERMISSION_DENIED" : "UNEXPECTED_RESPONSE", `${routeId}: HTTP ${page.status}.`);
                const html = new TextDecoder().decode(page.bytes);
                const info = inspectPage(html);
                if (info.login) throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció.");
                if (info.error) throw new CampusError("MOODLE_PERMISSION_DENIED", `${routeId}: ${info.error}`);
                return html;
            });
        } finally {
            await this.close(op);
        }
    }

    /** Una llamada AJAX de la allowlist (tupla método + acción), sin lotes. */
    async ajax(method: string, args: Record<string, unknown>): Promise<unknown> {
        checkWriteAjax(method, args, this.tables.ajax ?? WRITE_AJAX_METHODS);
        const started = Date.now();
        let outcome = "ok";
        const op = await this.open();
        try {
            const q = new URLSearchParams({ sesskey: op.sesskeyForWrite, info: method });
            this.writesSent++;
            let res;
            try {
                res = await op.writeRequest("/lib/ajax/service.php", q, { method: "POST", body: JSON.stringify([{ index: 0, methodname: method, args }]), contentType: "application/json" });
            } catch (e) {
                if (e instanceof CampusError && e.code === "NETWORK_ERROR") throw new WriteUncertainError(`${method}: falla de red. Puede haberse aplicado o no: se reconcilia por lectura.`);
                throw e;
            }
            let data: unknown;
            try {
                data = JSON.parse(new TextDecoder().decode(res.bytes));
            } catch {
                throw new WriteUncertainError(`${method}: respuesta no interpretable (HTTP ${res.status}). Puede haberse aplicado o no.`);
            }
            const first = Array.isArray(data) ? (data[0] as { error?: boolean; data?: unknown; exception?: { errorcode?: string; message?: string } } | undefined) : undefined;
            if (!first) {
                const d = data as { errorcode?: string; error?: string };
                if (d?.errorcode && /^(servicerequireslogin|requireloginerror|invalidsesskey|sessionexpired)$/.test(d.errorcode)) throw new CampusError("AUTH_REQUIRED", "La sesión web del Campus venció.", { moodleErrorcode: d.errorcode });
                throw new CampusError("MOODLE_REJECTED", `Moodle rechazó ${method}: ${(d?.error ?? "respuesta sin datos").slice(0, 200)}`, { moodleErrorcode: d?.errorcode });
            }
            if (first.error) throw new CampusError("MOODLE_REJECTED", `Moodle rechazó ${method}: ${(first.exception?.message ?? "error").slice(0, 200)}`, { moodleErrorcode: first.exception?.errorcode });
            return first.data;
        } catch (e) {
            outcome = e instanceof WriteUncertainError ? "UNCERTAIN" : e instanceof CampusError ? e.code : "INTERNAL";
            throw e;
        } finally {
            await this.close(op);
            this.logger.log(outcome === "ok" ? "info" : "warn", "moodle_write_ajax", { method, action: typeof args.action === "string" ? args.action : null, outcome, duration_ms: Date.now() - started });
        }
    }
}
