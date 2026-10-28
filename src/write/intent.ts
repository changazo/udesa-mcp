import type { z } from "zod";
import type { Difference, ExecutionResult, Plan, PlanDraft, PlanItem } from "./plan.js";
import type { WriteCapability, WriteProfile } from "./policy.js";
import type { WriteTransport } from "./transport.js";
import type { WebWriter } from "./web.js";
import type { App } from "../app.js";

/**
 * Una intención docente («publicar un aviso»), no una función de Moodle (directiva §2.1). Cada
 * intención resuelve, valida, arma el plan, sabe releer sus precondiciones, interpretar la
 * respuesta cruda, reconciliar ante un error de red, verificar por relectura y armar su deshacer.
 */
export interface IntentContext {
    profile: WriteProfile;
    /** Núcleo de LECTURA (mismo token y sesión web): para resolver IDs, permisos y relecturas reales. */
    read: App;
    /** Transporte de escritura (y lecturas de verificación sintéticas). */
    transport: WriteTransport;
    /** Escrituras por sesión web (formularios y AJAX allowlisteados). */
    web: WebWriter;
    now: Date;
}

/** Lo que dice la respuesta cruda. Una respuesta «exitosa» no es éxito: decide la relectura. */
export type Interpretation = { ok: true; moodle_ids?: Record<string, number> } | { ok: false; reason: string };

export type Presence = "presente" | "ausente" | "desconocido";

export interface ItemVerification {
    /** coincide = lo esperado; difiere = cambió pero no como se pidió; sin_efecto = quedó como antes. */
    outcome: "coincide" | "difiere" | "sin_efecto";
    checked: string[];
    differences: Difference[];
    moodle_ids?: Record<string, number>;
    /** Hasta cuándo vale el deshacer «sin rastro» observado en la relectura (p. ej. creado + maxeditingtime). */
    undo_until?: string;
    /** Dato para el humano o el agente que surge de la relectura (p. ej. el ID de cliente LTI, ADR-117). */
    note?: string;
}

export type UndoDraft = { kind: "plan"; draft: PlanDraft } | { kind: "ninguno"; reason: string };

export interface WriteIntent<S extends z.ZodRawShape = z.ZodRawShape> {
    /** Nombre corto; la herramienta es `campus_plan_<name>`. */
    name: string;
    title: string;
    description: string;
    inputShape: S;
    capability: WriteCapability;
    /**
     * Campos de archivo que entrega el cliente (ChatGPT, `openai/fileParams`). El motor los baja antes de
     * `plan` y los pasa ya descritos en `input.chat_files[campo]`.
     */
    fileParams?: readonly string[];
    /** Sólo se registra contra el Moodle sintético (sitio .test). */
    synthetic_only: boolean;
    /** Lee y valida; NUNCA escribe. Lanza errores tipados (AMBIGUOUS_RESOURCE, RESOURCE_OUT_OF_SCOPE…). */
    plan(input: z.infer<z.ZodObject<S>>, ctx: IntentContext): Promise<PlanDraft>;
    /** Relee las versiones de las precondiciones (concurrencia optimista: PLAN_STALE si cambian). */
    readVersions(plan: Plan, ctx: IntentContext): Promise<Record<string, string | number | null>>;
    /** Detecta fallas silenciosas en la respuesta cruda (null, false, -1, warnings). */
    interpret(item: PlanItem, data: unknown): Interpretation;
    /** Tras un error de red: ¿el efecto está? Por lectura, sin reenviar. */
    reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence>;
    /** Relectura y comparación campo por campo. `known` = IDs que devolvió Moodle al escribir (p. ej. la discusión creada). */
    verify(item: PlanItem, plan: Plan, ctx: IntentContext, known: Record<string, number>): Promise<ItemVerification>;
    /** El deshacer como plan propio, a partir de la acción ejecutada. */
    undo(plan: Plan, result: ExecutionResult, ctx: IntentContext): Promise<UndoDraft>;
}
