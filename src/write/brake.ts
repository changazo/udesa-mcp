import type { ExecutionStatus } from "./plan.js";
import type { WriteSwitchState } from "./store.js";

/**
 * Freno ante fallos (ADR-134; antes §5.8). Máquina de estados pura: el estado efectivo se deriva SOLO acá,
 * a partir del estado guardado y la hora. Las transiciones las aplica el almacén de forma atómica
 * (`WriteStore.updateState`), así que dos instancias del remoto no pueden pisarse.
 * - `closed`: normal.
 * - `open`: pausa automática hasta `paused_until` (cooldown). No se planifica ni se ejecuta.
 * - `half_open`: el plazo venció. La PRIMERA ejecución toma el turno de prueba (lease con vencimiento);
 *   si queda `aplicado_verificado` cierra el freno, cualquier otro resultado abre otro cooldown.
 * - `manual`: pausa sin fecha fiable (estado viejo sin `paused_at`): sólo la recuperación administrativa.
 * El interruptor manual (`disabled`) es otra barrera, de prioridad superior, que nunca vence.
 */

export interface BrakeConfig {
    failure_threshold: number;
    failure_window_seconds: number;
    cooldown_seconds: number;
}
export const DEFAULT_BRAKE: BrakeConfig = { failure_threshold: 3, failure_window_seconds: 900, cooldown_seconds: 7200 };
/** Cuánto dura el turno de prueba si la ejecución se interrumpe sin informar su resultado. */
export const PROBE_LEASE_SECONDS = 900;

export type BrakeState = "closed" | "open" | "half_open" | "manual";
export type FailureScope = "target" | "systemic";

export interface FailureRecord {
    at: string;
    /** Huella sin contenido: intención, curso, objetivo, etapa, código y hash de archivos. */
    fingerprint: string;
    scope: FailureScope;
}

export interface FailureInfo {
    fingerprint: string;
    scope: FailureScope;
    /** Etapa donde falló (p. ej. `upload_draft`, `form_submit`, `ws_call`, `verify`). */
    stage: string | null;
    code: string | null;
    http_status: number | null;
}

export interface BrakeView {
    state: BrakeState;
    paused_at: string | null;
    paused_until: string | null;
    retry_after_seconds: number | null;
    probe_in_progress: boolean;
    /** Fallos distintos (por huella) dentro de la ventana: lo que cuenta para el umbral. */
    failures_in_window: number;
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** Fin del cooldown: `paused_until`, o (estado viejo) `paused_at` + cooldown si la fecha es válida. */
function untilOf(s: WriteSwitchState, cfg: BrakeConfig): number | null {
    const u = ms(s.paused_until);
    if (Number.isFinite(u)) return u;
    const a = ms(s.paused_at);
    return Number.isFinite(a) ? a + cfg.cooldown_seconds * 1000 : null;
}

export function distinctFailures(s: WriteSwitchState, now: Date, cfg: BrakeConfig): number {
    const from = now.getTime() - cfg.failure_window_seconds * 1000;
    return new Set(s.failures.filter((f) => ms(f.at) >= from).map((f) => f.fingerprint)).size;
}

export function brakeView(s: WriteSwitchState, now: Date, cfg: BrakeConfig): BrakeView {
    const base = { paused_at: s.paused_at, probe_in_progress: false, failures_in_window: distinctFailures(s, now, cfg) };
    if (!s.paused) return { ...base, state: "closed", paused_until: null, retry_after_seconds: null };
    const until = untilOf(s, cfg);
    if (until === null) return { ...base, state: "manual", paused_until: null, retry_after_seconds: null };
    const left = Math.ceil((until - now.getTime()) / 1000);
    const pausedUntil = new Date(until).toISOString();
    if (left > 0) return { ...base, state: "open", paused_until: pausedUntil, retry_after_seconds: left };
    const probe = s.probe && s.probe.cycle === s.brake_cycle && ms(s.probe.until) > now.getTime();
    return { ...base, state: "half_open", paused_until: pausedUntil, retry_after_seconds: 0, probe_in_progress: !!probe };
}

/** Abre un cooldown nuevo (otro ciclo: una prueba de un ciclo anterior ya no puede cerrarlo). */
export function engage(s: WriteSwitchState, now: Date, cfg: BrakeConfig, reason: string): WriteSwitchState {
    return {
        ...s,
        paused: true,
        paused_at: now.toISOString(),
        paused_until: new Date(now.getTime() + cfg.cooldown_seconds * 1000).toISOString(),
        paused_reason: reason,
        brake_cycle: s.brake_cycle + 1,
        probe: null,
    };
}

/** Toma el turno de prueba si el estado es half_open y nadie lo tiene. null = no se pudo. */
export function acquireProbe(s: WriteSwitchState, now: Date, cfg: BrakeConfig, id: string): WriteSwitchState | null {
    const v = brakeView(s, now, cfg);
    if (v.state !== "half_open" || v.probe_in_progress) return null;
    return { ...s, paused_until: v.paused_until, probe: { id, cycle: s.brake_cycle, until: new Date(now.getTime() + PROBE_LEASE_SECONDS * 1000).toISOString() } };
}

/** Suelta el turno sin veredicto (no se llegó a escribir: plan obsoleto, error previo, etc.). */
export function releaseProbe(s: WriteSwitchState, id: string): WriteSwitchState {
    return s.probe?.id === id ? { ...s, probe: null } : s;
}

export type BrakeTransition = "brake_engaged" | "brake_recovered" | "brake_reengaged" | null;

/**
 * Resultado de una ejecución que emitió escrituras. `probeId` = la ejecución era la prueba half_open.
 * - Prueba: sólo `aplicado_verificado` cierra el freno. Un resultado incierto, parcial o con diferencias no
 *   es salud comprobada: abre otro cooldown (conservador) y no se reintenta nada.
 * - Normal: un éxito vacía el historial; `sin_efecto` y `rechazado_por_moodle` suman un fallo. Las
 *   repeticiones de la misma huella (mismo objetivo, misma etapa, mismo archivo) cuentan una sola vez.
 */
export function recordResult(s: WriteSwitchState, now: Date, cfg: BrakeConfig, status: ExecutionStatus, failure: FailureInfo | null, probeId: string | null): { state: WriteSwitchState; transition: BrakeTransition } {
    const at = now.toISOString();
    const failed = status === "sin_efecto" || status === "rechazado_por_moodle";
    let next: WriteSwitchState = { ...s };
    if (failure && (failed || status === "aplicado_desconocido")) next.last_failure = { at, scope: failure.scope, stage: failure.stage, code: failure.code, http_status: failure.http_status };
    if (probeId) {
        // Una prueba de otro ciclo (lease vencido y freno reabierto) no toca el freno.
        if (s.probe?.id !== probeId || s.probe.cycle !== s.brake_cycle) return { state: next, transition: null };
        if (status === "aplicado_verificado") {
            next = { ...next, paused: false, paused_at: null, paused_until: null, paused_reason: null, probe: null, failures: [], consecutive_failures: 0, last_recovery: { at, via: "automatic_probe" } };
            return { state: next, transition: "brake_recovered" };
        }
        return { state: engage(next, now, cfg, `la escritura de prueba tras el cooldown terminó ${status}`), transition: "brake_reengaged" };
    }
    if (status === "aplicado_verificado" || status === "aplicado_con_diferencias") {
        next.failures = [];
        next.consecutive_failures = 0;
        return { state: next, transition: null };
    }
    if (!failed || !failure) return { state: next, transition: null };
    const from = now.getTime() - cfg.failure_window_seconds * 1000;
    next.failures = [...s.failures.filter((f) => ms(f.at) >= from), { at, fingerprint: failure.fingerprint, scope: failure.scope }].slice(-50);
    const distinct = distinctFailures(next, now, cfg);
    next.consecutive_failures = distinct;
    if (!s.paused && distinct >= cfg.failure_threshold) {
        return { state: engage(next, now, cfg, `${distinct} fallos distintos en ${Math.round(cfg.failure_window_seconds / 60)} minutos (sin efecto o rechazados por Moodle)`), transition: "brake_engaged" };
    }
    return { state: next, transition: null };
}

/** Recuperación administrativa: SÓLO el freno (no `disabled`, ni los contadores del día). */
export function resumeBrake(s: WriteSwitchState, now: Date, via: string): WriteSwitchState {
    return { ...s, paused: false, paused_at: null, paused_until: null, paused_reason: null, probe: null, failures: [], consecutive_failures: 0, last_recovery: { at: now.toISOString(), via } };
}
