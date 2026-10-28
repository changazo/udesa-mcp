import { createHash } from "node:crypto";
import { CampusError, toPublicError } from "../errors.js";
import type { App } from "../app.js";
import type { Logger } from "../util/logger.js";
import { formatLocal, parseSince } from "../util/time.js";
import { confirmationView, humanPresentation, type Confirmer } from "./confirm.js";
import type { IntentContext, Presence, WriteIntent } from "./intent.js";
import {
    actionIdOf,
    confirmationCode,
    newPlanId,
    PLAN_TTL_MS,
    planHash,
    planIdOfAction,
    publicPlan,
    type ExecutionResult,
    type ExecutionStatus,
    type ItemOutcome,
    type ItemResult,
    type Plan,
    type PlanDraft,
    type PlanSigner,
    type PlanState,
    type StoredPlan,
} from "./plan.js";
import { computeRisk, grantFor, riskRank, type Risk, type WriteCapability, type WriteProfile } from "./policy.js";
import type { WriteStore, WriteSwitchState } from "./store.js";
import { WriteUncertainError, type WriteTransport } from "./transport.js";
import { cliCommand } from "../util/cli-command.js";
import { flattenParams } from "../moodle/serialize.js";
import { checkWriteAjax, checkWriteForm, checkWriteFormQuery, checkWriteRest } from "./functions.js";
import type { WebWriter } from "./web.js";
import type { PlanItem } from "./plan.js";
import { loadPlanFiles, MAX_PLAN_FILES, type PlanFile } from "./files.js";
import { CHAT_FILE_TTL_S, describeChatFile, downloadChatFile, REMOTE_MAX_CHAT_FILE_BYTES, REMOTE_MAX_CHAT_PLAN_BYTES, type ChatFileDeps, type ChatFileRef } from "./chat-files.js";

/** Tope propio para archivos del cliente (el mismo que los locales de contenido). */
const MAX_CHAT_FILE_BYTES = 50 * 1024 * 1024;

/** Freno ante fallos (§5.8). */
export const BRAKE_THRESHOLD = 3;
/**
 * ADR-118: se admiten todos los riesgos, también un R4 por escalada. La responsabilidad pasa al humano:
 * desde human_in_the_loop_from_risk el plan no se ejecuta sin la aprobación del usuario.
 */
export const MAX_ENABLED_RISK: Risk = "R4";

/** Aprobación del usuario para un plan R3/R4 (ADR-118): la pide el servidor o la trae el agente. */
export interface HumanApproval {
    /** Elicitación del cliente MCP: el servidor le pregunta al humano y el agente no puede responder. */
    elicit?: Confirmer;
    /** Palabras textuales del usuario aprobando, cuando el cliente no admite elicitación. */
    userWords?: string;
}

export interface WriteEngineDeps {
    profile: WriteProfile;
    store: WriteStore;
    signer: PlanSigner;
    transport: WriteTransport;
    web: WebWriter;
    read: App;
    intents: ReadonlyMap<string, WriteIntent<any>>;
    logger: Logger;
    now?: () => Date;
    /**
     * Modo remoto (W5, ADR-060): toda confirmación es fuera de banda por la página web de aprobación,
     * el riesgo tiene un techo propio y no hay archivos locales.
     */
    remote?: { approvalUrl: (planId: string) => string; maxRisk: Risk };
    /** Descarga de archivos del cliente (tests: fetch y DNS simulados). */
    chatFiles?: ChatFileDeps;
}

type WorkingItem = Omit<ItemResult, "outcome"> & { outcome: ItemOutcome | "pendiente_verificar" };

const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * Núcleo de escritura, común al servidor MCP y a la CLI. Toda escritura pasa por:
 * plan (lectura, firmado) → confirmación según riesgo → uso único → precondiciones (PLAN_STALE)
 * → una llamada por ítem sin reintentos (reconciliación por lectura ante error de red)
 * → verificación por relectura → auditoría → deshacer como plan propio.
 */
export class WriteEngine {
    constructor(private readonly deps: WriteEngineDeps) {}

    private now() {
        return (this.deps.now ?? (() => new Date()))();
    }

    private get policy() {
        return this.deps.profile.policy;
    }

    private get tz() {
        return this.deps.profile.read_profile.timezone;
    }

    private ctx(): IntentContext {
        return { profile: this.deps.profile, read: this.deps.read, transport: this.deps.transport, web: this.deps.web, now: this.now() };
    }

    private cli(sub: string) {
        return `${cliCommand()} write ${sub} --profile ${this.deps.profile.profile_id}`;
    }

    // ---------- interruptor, freno y límites ----------

    private dayKey(d: Date) {
        return formatLocal(d, this.tz).slice(0, 10);
    }

    /** Estado con el contador diario renovado si cambió el día. */
    private async switchState(): Promise<WriteSwitchState> {
        const s = await this.deps.store.readState();
        const today = this.dayKey(this.now());
        if (s.day !== today) return { ...s, day: today, actions_today: 0, messages_today: 0 };
        return s;
    }

    async assertEnabled(): Promise<void> {
        if (!this.policy.enabled) throw new CampusError("WRITE_DISABLED", `El perfil ${this.deps.profile.profile_id} tiene las escrituras deshabilitadas (write_policy.enabled=false).`);
        const s = (await this.switchState());
        if (s.disabled) {
            throw new CampusError("WRITE_DISABLED", "Las escrituras están deshabilitadas por el interruptor general. Las lecturas siguen funcionando.", { humanAction: `Para reactivarlas, desde tu terminal: ${this.cli("enable")}` });
        }
        if (s.paused) {
            throw new CampusError("WRITE_DISABLED", `Escrituras pausadas por el freno: ${s.paused_reason ?? "fallos seguidos"}.`, {
                humanAction: `Revisá el registro (${this.cli("log")}) y reactivá desde tu terminal: ${this.cli("resume")}`,
                details: { brake: true, consecutive_failures: s.consecutive_failures },
            });
        }
    }

    async setSwitch(disabled: boolean, via: string): Promise<WriteSwitchState> {
        const s = { ...(await this.switchState()), disabled, changed_at: this.now().toISOString() };
        await this.deps.store.writeState(s);
        await this.audit({ event: disabled ? "switch_disabled" : "switch_enabled", via });
        return s;
    }

    async resume(via: string): Promise<WriteSwitchState> {
        const s = { ...(await this.switchState()), paused: false, paused_at: null, paused_reason: null, consecutive_failures: 0 };
        await this.deps.store.writeState(s);
        await this.audit({ event: "brake_resumed", via });
        return s;
    }

    private async audit(event: Record<string, unknown>) {
        await this.deps.store.audit({ ts: this.now().toISOString(), profile_id: this.deps.profile.profile_id, ...event });
    }

    // ---------- planes ----------

    private intentOf(name: string) {
        const intent = this.deps.intents.get(name);
        if (!intent) throw new CampusError("WRITE_NOT_ALLOWED", `La intención ${name} no está disponible en este servidor.`);
        return intent;
    }

    private assertGrant(courseId: number, capability: WriteCapability) {
        if (!grantFor(this.policy, courseId, capability)) {
            throw new CampusError("WRITE_NOT_ALLOWED", `La capacidad ${capability} no está habilitada para el curso ${courseId} en el perfil ${this.deps.profile.profile_id}.`, {
                humanAction: "Sólo el dueño habilita capacidades por curso, editando write_policy.courses del perfil de escritura.",
            });
        }
    }

    /** Arma y guarda el plan de una intención. Es una LECTURA: no escribe en Moodle. */
    async plan(intentName: string, input: Record<string, unknown> & { course_id: number }, client: string) {
        await this.assertEnabled();
        const intent = this.intentOf(intentName);
        // Identidad verificada, alcance de lectura, rol de escritura en el curso (ADR-122) y capacidad ANTES de leer nada del curso.
        await this.deps.read.session.verified();
        await this.deps.read.scope.assertWriter(input.course_id);
        this.assertGrant(input.course_id, intent.capability);
        if (this.deps.remote && ([input.attachments, input.file_paths, input.add_file_paths].some((v) => Array.isArray(v) && v.length) || input.file_path !== undefined)) {
            throw new CampusError(
                "WRITE_NOT_ALLOWED",
                `En el servidor remoto no hay archivos locales.${intent.fileParams?.length ? ` Pasá los archivos en ${intent.fileParams.join(" o ")} (ChatGPT los entrega así);` : ""} las rutas locales sólo funcionan en el servidor local (udesa-campus-escritura).`,
            );
        }
        if (intent.fileParams?.length) input = { ...input, chat_files: await this.receiveChatFiles(intent.fileParams, input) };
        const draft = await intent.plan(input, this.ctx());
        return this.storeDraft(draft, client);
    }

    /**
     * Archivos que entregó el cliente en los campos de archivo (ChatGPT, `openai/fileParams`): se bajan y
     * validan ahora, y los bytes quedan en el almacén con vencimiento corto. El plan sólo lleva su descripción.
     */
    private async receiveChatFiles(fields: readonly string[], input: Record<string, unknown>): Promise<Record<string, PlanFile[]>> {
        const max = Math.min(MAX_CHAT_FILE_BYTES, this.deps.profile.read_profile.limits.max_file_bytes, this.deps.remote ? REMOTE_MAX_CHAT_FILE_BYTES : Infinity);
        const out: Record<string, PlanFile[]> = {};
        let total = 0;
        for (const field of fields) {
            const refs = input[field] as ChatFileRef[] | undefined;
            if (!refs?.length) continue;
            if (refs.length > MAX_PLAN_FILES) throw new CampusError("WRITE_NOT_ALLOWED", `Como máximo ${MAX_PLAN_FILES} archivos por plan.`);
            const files: PlanFile[] = [];
            for (const ref of refs) {
                const { filename, data, host } = await downloadChatFile(ref, max, this.deps.chatFiles);
                total += data.length;
                if (this.deps.remote && total > REMOTE_MAX_CHAT_PLAN_BYTES) throw new CampusError("WRITE_NOT_ALLOWED", `Los archivos del plan suman más de ${REMOTE_MAX_CHAT_PLAN_BYTES / 1024 / 1024} MB: en el remoto, repartilos en varios planes.`);
                if (files.some((f) => f.filename.toLowerCase() === filename.toLowerCase())) throw new CampusError("WRITE_NOT_ALLOWED", `Dos archivos se llaman ${filename}: Moodle no sobrescribe y descartaría uno.`);
                const file = describeChatFile(filename, data, ref, host);
                await this.deps.store.putBlob(file.sha256, data, CHAT_FILE_TTL_S);
                files.push(file);
            }
            out[field] = files;
        }
        return out;
    }

    private async storeDraft(draft: PlanDraft, client: string) {
        if (!draft.items.length) throw new CampusError("WRITE_NOT_ALLOWED", "El plan no tiene ítems.");
        // Cada llamada del plan pasa ya la allowlist y su validador: un plan nunca guarda algo que el transporte rechazaría.
        for (const item of draft.items) checkItem(item, this.deps.profile.read_profile.site_url);
        // Archivos generados por el servidor (ADR-110) viajan en el plan: sí funcionan en el remoto.
        if (this.deps.remote && draft.items.some((i) => i.uploads && i.uploads.files.some((f) => f.inline_base64 === undefined && !f.blob))) throw new CampusError("WRITE_NOT_ALLOWED", "En el servidor remoto no hay archivos locales.");
        this.assertGrant(draft.course_id, draft.capability);
        const lim = this.policy.limits;
        if (draft.items.length > lim.max_items_per_plan) {
            throw new CampusError("LIMIT_EXCEEDED", `El plan tiene ${draft.items.length} ítems; el límite por plan es ${lim.max_items_per_plan}.`);
        }
        const messages = draft.items.filter((i) => i.counts_as_message).length;
        if (messages > lim.max_messages_per_plan) throw new CampusError("LIMIT_EXCEEDED", `El plan tiene ${messages} mensajes; el límite por plan es ${lim.max_messages_per_plan}.`);
        const now = this.now();
        const { risk, reasons } = computeRisk({ base: draft.base_risk, capability: draft.capability, items: draft.items.length, courseId: draft.course_id, policy: this.policy, now });
        const threshold = this.policy.require_out_of_band_from_risk;
        const byRisk = threshold !== "nunca" && riskRank(risk) >= riskRank(threshold);
        if (threshold === "nunca") reasons.push("Sin aprobación humana fuera del chat por decisión del dueño (ADR-061, require_out_of_band_from_risk=nunca).");
        const sandboxClient = this.policy.sandbox_confirmation === "cliente" && this.policy.sandbox_course_ids.includes(draft.course_id);
        if (sandboxClient && byRisk) {
            reasons.push("Curso sandbox con confirmación en el cliente por decisión del dueño (ADR-048): sin confirmación fuera del modelo.");
        }
        const remote = this.deps.remote;
        if (remote && riskRank(risk) > riskRank(remote.maxRisk)) {
            throw new CampusError("WRITE_NOT_ALLOWED", `El plan resultó ${risk}: el servidor remoto admite hasta ${remote.maxRisk}. Hacelo desde el servidor local. ${reasons.join(" ")}`);
        }
        const outOfBand = !sandboxClient && byRisk;
        const planId = newPlanId();
        const dialog = this.policy.confirmation.dialog && process.platform === "win32";
        const plan: Plan = {
            ...draft,
            plan_id: planId,
            profile_id: this.deps.profile.profile_id,
            created_at: now.toISOString(),
            expires_at: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
            risk,
            risk_reasons: reasons,
            confirmation: remote && outOfBand
                ? { channel: "fuera_de_banda", how: [`página de aprobación: ${remote.approvalUrl(planId)}`] }
                : outOfBand
                ? { channel: "fuera_de_banda", how: dialog ? ["diálogo de Windows al ejecutar", "terminal: campus write approve"] : ["terminal: campus write approve"] }
                : { channel: "cliente", how: ["aprobación de la herramienta en el cliente"] },
        };
        const hash = planHash(plan);
        const sp: StoredPlan = { v: 1, plan, hash, mac: await this.deps.signer.sign(plan.plan_id, hash), state: { status: "pendiente", updated_at: now.toISOString() } };
        await this.deps.store.createPlan(sp);
        await this.audit({
            event: "plan_created",
            plan_id: plan.plan_id,
            plan_hash: hash,
            intent: plan.intent,
            capability: plan.capability,
            risk,
            course_id: plan.course_id,
            targets: plan.items.map((i) => i.target),
            items: plan.items.length,
            teacher_text: this.teacherText(plan),
            undo_of: plan.undo_of,
            client,
        });
        return this.view(sp);
    }

    /** Texto del docente en la auditoría: hash y largo, salvo que el dueño elija guardarlo (§5.7). */
    private teacherText(plan: Plan) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(plan.teacher_text)) out[k] = this.policy.audit_teacher_text ? v : { sha256_12: sha12(v), length: v.length };
        return out;
    }

    /** ADR-118: el plan se confirma en el cliente y su riesgo exige la aprobación del usuario. */
    private needsHuman(plan: Plan): boolean {
        const t = this.policy.human_in_the_loop_from_risk;
        return plan.confirmation.channel === "cliente" && t !== "nunca" && riskRank(plan.risk) >= riskRank(t);
    }

    private view(sp: StoredPlan) {
        const expired = sp.state.status === "pendiente" && this.now().getTime() > Date.parse(sp.plan.expires_at);
        const pub = publicPlan(sp);
        const human = this.needsHuman(sp.plan);
        return {
            ...pub,
            expired,
            ...(human ? { human_in_the_loop: { required: true, present_to_user: humanPresentation(sp.plan) } } : {}),
            next_step:
                sp.state.status !== "pendiente" || expired
                    ? null
                    : human
                      ? `ANTES de ejecutar: planteale al usuario la acción (human_in_the_loop.present_to_user, con los valores que importen de payload_preview) y esperá su respuesta. Sólo si aprueba explícitamente: campus_execute_plan con este plan_id y user_approval = sus palabras textuales. Si el cliente admite elicitación, el servidor se lo pregunta directamente.`
                    : sp.plan.confirmation.channel === "fuera_de_banda"
                      ? this.deps.remote
                        ? `El humano lo aprueba en ${this.deps.remote.approvalUrl(sp.plan.plan_id)} (código ${pub.confirmation_code}); después, campus_execute_plan con este plan_id.`
                        : `campus_execute_plan con este plan_id: el humano lo aprueba fuera del chat (diálogo o terminal: campus write approve ${sp.plan.plan_id}). Código ${pub.confirmation_code}.`
                      : "campus_execute_plan con este plan_id (el cliente pide la aprobación de la herramienta).",
        };
    }

    private async loadVerified(planId: string): Promise<StoredPlan> {
        const sp = await this.deps.store.loadPlan(planId);
        if (!sp) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `No existe el plan ${planId} en este perfil.`);
        const intact = sp.plan?.plan_id === planId && sp.plan.profile_id === this.deps.profile.profile_id && planHash(sp.plan) === sp.hash && (await this.deps.signer.verify(planId, sp.hash, sp.mac));
        if (!intact) throw new CampusError("POLICY_DENIED", "El plan fue alterado fuera del servidor (hash o firma no coinciden): no se ejecuta. Volvé a planificar.");
        return sp;
    }

    async getPlan(planId: string) {
        return this.view(await this.loadVerified(planId));
    }

    /** Planes que esperan confirmación (no vencidos, no ejecutados). */
    async pending() {
        const out = [];
        for (const sp of await this.deps.store.listPlans()) {
            if (sp.state.status !== "pendiente" || this.now().getTime() > Date.parse(sp.plan.expires_at)) continue;
            try {
                out.push(await this.getPlan(sp.plan.plan_id));
            } catch {
                /* plan alterado: no se lista como pendiente */
            }
        }
        return out;
    }

    /** Vista para aprobar desde la terminal: el texto completo y el hash que queda atado a la aprobación. */
    async approvalView(planId: string) {
        await this.assertEnabled();
        const sp = await this.loadVerified(planId);
        await this.assertExecutable(sp);
        return confirmationView(sp);
    }

    /**
     * Decisión del humano en la página web de aprobación (W5). Queda atada al hash que vio; la
     * ejecución la consume. Una decisión ya tomada no se cambia.
     */
    async recordWebDecision(planId: string, planHash: string, decision: "approved" | "rejected", by: string) {
        await this.assertEnabled();
        const sp = await this.loadVerified(planId);
        await this.assertExecutable(sp);
        if (sp.hash !== planHash) throw new CampusError("CONFIRMATION_REQUIRED", "El plan cambió desde que se mostró: recargá la página.");
        const saved = await this.deps.store.saveApproval(planId, { plan_hash: planHash, decision, by, at: this.now().toISOString() });
        if (!saved) throw new CampusError("PLAN_ALREADY_EXECUTED", "Este plan ya tiene una decisión registrada.");
        await this.audit({ event: "web_decision", plan_id: planId, plan_hash: planHash, decision, by });
        return { plan_id: planId, decision };
    }

    /** Estado del plan que impide ejecutarlo, como error tipado. */
    private async assertExecutable(sp: StoredPlan) {
        const st = sp.state;
        if (st.status === "ejecutado") {
            throw new CampusError("PLAN_ALREADY_EXECUTED", "El plan ya se ejecutó: no se vuelve a escribir. Este es el resultado de entonces.", { details: { previous_result: st.result ?? null } });
        }
        if (st.status === "rechazado") throw new CampusError("CONFIRMATION_REQUIRED", "El humano rechazó este plan. Si corresponde, armá uno nuevo.", { details: { rejected: true } });
        if (st.status === "obsoleto") throw new CampusError("PLAN_STALE", "El plan quedó obsoleto (cambió el estado en el Campus). Volvé a planificar.");
        if (st.status === "en_ejecucion" || (await this.deps.store.isClaimed(sp.plan.plan_id))) {
            throw new CampusError("PLAN_ALREADY_EXECUTED", "El plan ya está en ejecución o su ejecución se interrumpió: no se reenvía. Revisá el estado con campus_get_plan y el Campus.", { details: { state: "en_ejecucion_o_interrumpido" } });
        }
        if (this.now().getTime() > Date.parse(sp.plan.expires_at)) throw new CampusError("PLAN_EXPIRED", `El plan venció a las ${sp.plan.expires_at} (15 minutos). Volvé a planificar.`);
    }

    private async assertDailyLimits(plan: Plan) {
        const s = (await this.switchState());
        const lim = this.policy.limits;
        if (s.actions_today + plan.items.length > lim.max_actions_per_day) {
            throw new CampusError("LIMIT_EXCEEDED", `Límite diario: ${s.actions_today} acciones hoy y el plan suma ${plan.items.length} (máximo ${lim.max_actions_per_day}).`);
        }
        const msgs = plan.items.filter((i) => i.counts_as_message).length;
        if (msgs && s.messages_today + msgs > lim.max_messages_per_day) {
            throw new CampusError("LIMIT_EXCEEDED", `Límite diario de mensajes: ${s.messages_today} hoy (máximo ${lim.max_messages_per_day}).`);
        }
    }

    // ---------- ejecución ----------

    /**
     * Ejecuta un plan armado por el servidor. `confirmer` es el canal fuera de banda (diálogo o
     * terminal) cuando el riesgo lo exige; con riesgo menor alcanza la aprobación del cliente.
     */
    /**
     * ADR-118: aprobación del usuario para un plan R3/R4 confirmado en el cliente. Primero la elicitación
     * (si el cliente la admite); si no está disponible, las palabras del usuario que trae el agente.
     * Sin ninguna de las dos no se escribe nada.
     */
    private async humanInTheLoop(sp: StoredPlan, approval: HumanApproval, client: string): Promise<{ channel: string; at: string }> {
        const planId = sp.plan.plan_id;
        if (approval.elicit) {
            const { decision, detail } = await approval.elicit.confirm(confirmationView(sp));
            await this.audit({ event: "confirmation", plan_id: planId, plan_hash: sp.hash, channel: approval.elicit.channel, decision, detail: detail ?? null, client });
            if (decision === "rejected") {
                await this.setState(planId, { status: "rechazado", updated_at: this.now().toISOString(), note: detail ?? "Rechazado por el usuario." });
                throw new CampusError("CONFIRMATION_REQUIRED", `El usuario rechazó el plan${detail ? ` (${detail})` : ""}. No se escribió nada.`, { details: { decision } });
            }
            if (decision === "approved") return { channel: approval.elicit.channel, at: this.now().toISOString() };
        }
        const words = approval.userWords?.trim();
        if (words) {
            await this.audit({ event: "confirmation", plan_id: planId, plan_hash: sp.hash, channel: "usuario_en_chat", decision: "approved", detail: words.slice(0, 500), client });
            return { channel: "usuario_en_chat", at: this.now().toISOString() };
        }
        throw new CampusError(
            "CONFIRMATION_REQUIRED",
            `Plan ${sp.plan.risk}: antes de ejecutarlo hay que plantearle la acción al usuario y esperar su aprobación explícita. Si aprueba, volvé a llamar a campus_execute_plan con user_approval = sus palabras textuales. No se escribió nada.`,
            { details: { risk: sp.plan.risk, present_to_user: humanPresentation(sp.plan) } },
        );
    }

    async execute(planId: string, confirmer: Confirmer, client: string, approval: HumanApproval = {}): Promise<ExecutionResult> {
        await this.assertEnabled();
        let sp = await this.loadVerified(planId);
        await this.assertExecutable(sp);
        const intent = this.intentOf(sp.plan.intent);
        this.assertGrant(sp.plan.course_id, sp.plan.capability);
        await this.assertDailyLimits(sp.plan);

        let confirmation: { channel: string; at: string };
        // La terminal siempre confirma (el humano ya vio el plan y tipeó el código), cualquiera sea el riesgo.
        if (sp.plan.confirmation.channel === "fuera_de_banda" || confirmer.channel === "terminal") {
            const view = confirmationView(sp);
            const { decision, detail } = await confirmer.confirm(view);
            await this.audit({ event: "confirmation", plan_id: planId, plan_hash: sp.hash, channel: confirmer.channel, decision, detail: detail ?? null, client });
            if (decision === "rejected") {
                await this.setState(planId, { status: "rechazado", updated_at: this.now().toISOString(), note: detail ?? "Rechazado por el humano." });
                throw new CampusError("CONFIRMATION_REQUIRED", `El humano rechazó el plan${detail ? ` (${detail})` : ""}. No se escribió nada.`, { details: { decision } });
            }
            if (decision !== "approved") {
                throw new CampusError("CONFIRMATION_REQUIRED", `El plan ${sp.plan.risk} necesita confirmación humana fuera del chat y no la obtuvo (${decision === "timeout" ? "venció el diálogo" : (detail ?? "sin canal disponible")}). No se escribió nada.`, {
                    humanAction: this.deps.remote
                        ? `Abrí ${this.deps.remote.approvalUrl(planId)}, revisá el plan (código ${confirmationCode(sp.hash)}) y aprobalo; después volvé a ejecutarlo.`
                        : `Aprobalo desde tu terminal (muestra el plan y pide el código ${confirmationCode(sp.hash)}): ${this.cli(`approve ${planId}`)}`,
                    details: { decision, confirmation_code: confirmationCode(sp.hash) },
                });
            }
            // Atadura al hash: se ejecuta exactamente lo que vio el humano.
            sp = await this.loadVerified(planId);
            if (sp.hash !== view.plan_hash) throw new CampusError("CONFIRMATION_REQUIRED", "El plan cambió después de la aprobación: la aprobación no sirve. No se escribió nada.");
            await this.assertExecutable(sp);
            confirmation = { channel: confirmer.channel, at: this.now().toISOString() };
        } else if (this.needsHuman(sp.plan)) {
            confirmation = await this.humanInTheLoop(sp, approval, client);
        } else {
            confirmation = { channel: "cliente", at: this.now().toISOString() };
        }

        const plan = sp.plan;
        // Identidad en vivo (sitio y usuario) justo antes de escribir.
        await this.deps.read.session.verify();
        if (!(await this.deps.store.claim(planId, this.now().toISOString()))) {
            throw new CampusError("PLAN_ALREADY_EXECUTED", "Otra ejecución tomó este plan: no se vuelve a escribir.", { details: { state: "en_ejecucion_o_interrumpido" } });
        }
        await this.setState(planId, { status: "en_ejecucion", updated_at: this.now().toISOString() });

        // Precondiciones (concurrencia optimista).
        let current: Record<string, string | number | null>;
        try {
            current = await intent.readVersions(plan, this.ctx());
        } catch (e) {
            // No se escribió nada: el plan vuelve a quedar disponible.
            await this.setState(planId, { status: "pendiente", updated_at: this.now().toISOString() });
            await this.deps.store.release(planId);
            throw e;
        }
        const changed = Object.entries(plan.preconditions.versions)
            .filter(([k, v]) => current[k] !== v)
            .map(([k, v]) => ({ key: k, planned: v, current: current[k] ?? null }));
        if (changed.length) {
            await this.setState(planId, { status: "obsoleto", updated_at: this.now().toISOString(), note: `Cambió: ${changed.map((c) => c.key).join(", ")}` });
            await this.audit({ event: "plan_stale", plan_id: planId, plan_hash: sp.hash, changed: changed.map((c) => c.key), client });
            throw new CampusError("PLAN_STALE", "El estado en el Campus cambió entre el plan y la ejecución: no se escribió nada. Volvé a planificar.", { details: { changed } });
        }

        // Archivos del plan: tienen que ser los mismos que vio el humano (por hash), antes de escribir nada.
        try {
            // Los archivos entregados por el cliente se traen del almacén (sólo en memoria; el plan guardado no cambia).
            for (const item of plan.items) {
                for (const f of item.uploads?.files ?? []) {
                    if (!f.blob) continue;
                    const data = await this.deps.store.getBlob(f.sha256);
                    if (data) f.inline_base64 = data.toString("base64");
                }
            }
            for (const item of plan.items) if (item.uploads) loadPlanFiles(item.uploads.files);
        } catch (e) {
            if (e instanceof CampusError && e.code === "PLAN_STALE") {
                await this.setState(planId, { status: "obsoleto", updated_at: this.now().toISOString(), note: e.message });
                await this.audit({ event: "plan_stale", plan_id: planId, plan_hash: sp.hash, changed: ["archivos"], client });
            }
            throw e;
        }

        // Una llamada por ítem, en serie, sin reintentos.
        const items: WorkingItem[] = [];
        const functions: string[] = [];
        let stop = false;
        let authError: CampusError | null = null;
        let messages = 0;
        for (const item of plan.items) {
            const base: WorkingItem = { item_id: item.item_id, outcome: "no_ejecutado", moodle_ids: {}, error: null, verification: { checked: [], differences: [], note: null } };
            if (stop) {
                items.push(base);
                continue;
            }
            functions.push(callLabel(item));
            if (item.counts_as_message) messages++;
            try {
                const data = await this.dispatch(item);
                const interp = intent.interpret(item, data);
                if (interp.ok) items.push({ ...base, outcome: "pendiente_verificar", moodle_ids: interp.moodle_ids ?? {} });
                else {
                    items.push({ ...base, outcome: "rechazado", error: { code: "MOODLE_REJECTED", message: interp.reason, moodle_errorcode: null } });
                    stop = true;
                }
            } catch (e) {
                stop = true;
                if (e instanceof WriteUncertainError) {
                    let presence: Presence = "desconocido";
                    try {
                        presence = await intent.reconcile(item, plan, this.ctx());
                    } catch {
                        /* sin relectura posible: queda desconocido */
                    }
                    const note = `Error de red (${e.message}). Reconciliación por lectura: ${presence}. No se reenvió.`;
                    items.push(
                        presence === "presente"
                            ? { ...base, outcome: "pendiente_verificar", verification: { ...base.verification, note } }
                            : { ...base, outcome: "desconocido", error: { code: "NETWORK_ERROR", message: e.message, moodle_errorcode: null }, verification: { ...base.verification, note } },
                    );
                    continue;
                }
                const pe = toPublicError(e);
                if (pe.code === "AUTH_REQUIRED" && e instanceof CampusError) authError = e;
                items.push({ ...base, outcome: "rechazado", error: { code: pe.code, message: pe.message, moodle_errorcode: pe.moodle_errorcode } });
            }
        }

        // Token rechazado antes de aplicar nada: el plan sigue disponible tras renovar la sesión.
        if (authError && items.every((i) => i.outcome === "no_ejecutado" || i.error?.code === "AUTH_REQUIRED")) {
            await this.setState(planId, { status: "pendiente", updated_at: this.now().toISOString(), note: "Token rechazado antes de escribir." });
            await this.deps.store.release(planId);
            throw authError;
        }

        // Verificación por relectura.
        const warnings: string[] = [];
        const undoUntil: string[] = [];
        for (const r of items) {
            if (r.outcome !== "pendiente_verificar" && r.outcome !== "rechazado") continue;
            const item = plan.items.find((i) => i.item_id === r.item_id)!;
            try {
                const v = await intent.verify(item, plan, this.ctx(), r.moodle_ids);
                if (v.undo_until) undoUntil.push(v.undo_until);
                r.verification = { checked: v.checked, differences: v.differences, note: v.note ?? r.verification.note };
                r.moodle_ids = { ...r.moodle_ids, ...(v.moodle_ids ?? {}) };
                if (r.outcome === "pendiente_verificar") r.outcome = v.outcome === "coincide" ? "verificado" : v.outcome === "difiere" ? "con_diferencias" : "sin_efecto";
                else if (v.outcome !== "sin_efecto") {
                    // Moodle rechazó pero algo cambió (p. ej. guardó una parte antes de fallar).
                    r.outcome = "con_diferencias";
                    warnings.push(`Ítem ${r.item_id}: Moodle rechazó la operación pero la relectura muestra cambios aplicados.`);
                }
            } catch (e) {
                if (r.outcome === "pendiente_verificar") {
                    r.outcome = "desconocido";
                    r.verification.note = `No se pudo releer para verificar (${toPublicError(e).code}).`;
                }
            }
        }
        const finalItems = items as ItemResult[];
        const { status, partial } = overallStatus(finalItems);
        if (partial) warnings.push(`Se aplicó una parte del plan: ${finalItems.filter(applied).length} de ${finalItems.length} ítems.`);
        const actionId = actionIdOf(planId);
        const differences = finalItems.flatMap((r) => r.verification.differences.map((d) => ({ ...d, item_id: r.item_id })));
        const moodleIds: Record<string, number[]> = {};
        for (const r of finalItems) for (const [k, v] of Object.entries(r.moodle_ids)) (moodleIds[k] ??= []).push(v);
        const anyApplied = finalItems.some((r) => applied(r) || r.outcome === "desconocido");
        const result: ExecutionResult = {
            action_id: actionId,
            plan_id: planId,
            status,
            partial,
            executed_at: this.now().toISOString(),
            confirmation,
            items: finalItems,
            moodle_ids: moodleIds,
            verification: { checked: [...new Set(finalItems.flatMap((r) => r.verification.checked))], matched: status === "aplicado_verificado" },
            differences,
            undo: { ...plan.undo, until: undoUntil.sort()[0] ?? plan.undo.until, action: anyApplied && plan.undo.kind !== "ninguno" ? `campus_undo_action con action_id=${actionId} (arma un plan de deshacer).` : "Nada que deshacer." },
            warnings,
            audit_ref: `write-audit.jsonl#${actionId}`,
        };
        await this.setState(planId, { status: "ejecutado", updated_at: result.executed_at, result });
        if (plan.undo_of && anyApplied) {
            const origPlanId = planIdOfAction(plan.undo_of);
            const orig = await this.deps.store.loadPlan(origPlanId);
            if (orig) await this.deps.store.savePlanState(origPlanId, { ...orig.state, undone_by: actionId });
        }
        await this.recordOutcome(status, functions.length, messages);
        await this.audit({
            event: "execution",
            action_id: actionId,
            plan_id: planId,
            plan_hash: sp.hash,
            intent: plan.intent,
            capability: plan.capability,
            risk: plan.risk,
            course_id: plan.course_id,
            targets: plan.items.map((i) => i.target),
            confirmation,
            functions,
            status,
            partial,
            items: finalItems.map((r) => ({ item_id: r.item_id, outcome: r.outcome, moodle_ids: r.moodle_ids, error_code: r.error?.code ?? null })),
            verification: result.verification,
            differences: differences.map((d) => ({ item_id: d.item_id, field: d.field })),
            undo: { kind: plan.undo.kind, until: plan.undo.until, state: anyApplied ? "disponible" : "no_aplica" },
            undo_of: plan.undo_of,
            client,
        });
        return result;
    }

    /** Una llamada por ítem, por la vía que declara el plan. */
    private async dispatch(item: PlanItem): Promise<unknown> {
        const c = item.call;
        if (c.kind === "form") {
            const p = c.params as { query: Record<string, string>; fields: Record<string, string> };
            if (!item.uploads?.field) return this.deps.web.submitForm(c.fn, p.query, p.fields);
            const u = item.uploads;
            if (u.form_draft) {
                // Archivos de una actividad (ADR-077): se editan en el borrador que sirve el formulario.
                const field = u.field!;
                const add = loadPlanFiles(u.files);
                const remove = u.form_draft.remove;
                return this.deps.web.submitForm(c.fn, p.query, p.fields, async (served) => {
                    const ids = served.filter(([n]) => n === field).map(([, v]) => Number(v));
                    if (ids.length !== 1 || !Number.isInteger(ids[0]) || ids[0]! <= 0) throw new CampusError("UNEXPECTED_RESPONSE", "El formulario no trae el borrador de archivos.");
                    if (remove.length) await this.deps.transport.deleteDraft(ids[0]!, remove);
                    if (add.length) await this.deps.transport.uploadDraft(add, ids[0]!);
                });
            }
            // Archivo del formulario (ADR-059): al borrador por el token y su itemid en el campo del filepicker.
            const files = loadPlanFiles(item.uploads.files);
            const itemid = await this.deps.transport.uploadDraft(files);
            try {
                return await this.deps.web.submitForm(c.fn, p.query, { ...p.fields, [item.uploads.field]: String(itemid) });
            } catch (e) {
                if (!(e instanceof WriteUncertainError)) await this.deps.transport.deleteDraft(itemid, files.map((f) => f.filename)).catch(() => undefined);
                throw e;
            }
        }
        if (c.kind === "ajax") return this.deps.web.ajax(c.fn, c.params as Record<string, unknown>);
        if (!item.uploads?.option) return this.deps.transport.call(c.fn, c.params);
        // Adjuntos (ADR-057): subir al borrador, pasar su itemid y, si la llamada falla sin duda, limpiarlo.
        // Editar (ADR-069): primero el borrador del post con SÓLO los que se conservan, y los nuevos al mismo.
        const files = loadPlanFiles(item.uploads.files);
        let itemid: number;
        const prep = item.uploads.prepare;
        if (prep) {
            const keep = prep.keep.length ? prep.keep : [prep.none]; // [] = «todos» en Moodle: un nombre inexistente quita todos
            const res = (await this.deps.transport.call("mod_forum_prepare_draft_area_for_post", { postid: prep.postid, area: "attachment", draftitemid: 0, filestokeep: keep.map((filename) => ({ filename, filepath: "/" })) })) as { draftitemid?: unknown };
            itemid = Number(res?.draftitemid);
            if (!Number.isInteger(itemid) || itemid <= 0) throw new CampusError("UNEXPECTED_RESPONSE", "Moodle no devolvió el borrador del post.");
            if (files.length) await this.deps.transport.uploadDraft(files, itemid);
        } else itemid = await this.deps.transport.uploadDraft(files);
        const options = [...((c.params.options as { name: string; value: string }[] | undefined) ?? []), { name: item.uploads.option, value: String(itemid) }];
        try {
            return await this.deps.transport.call(c.fn, { ...c.params, options });
        } catch (e) {
            if (!(e instanceof WriteUncertainError)) await this.deps.transport.deleteDraft(itemid, files.map((f) => f.filename)).catch(() => undefined);
            throw e;
        }
    }

    private async setState(planId: string, state: PlanState) {
        const prev = (await this.deps.store.loadPlan(planId))?.state;
        await this.deps.store.savePlanState(planId, { ...state, ...(prev?.undone_by ? { undone_by: prev.undone_by } : {}) });
    }

    /** Contadores del día y freno ante fallos seguidos. */
    private async recordOutcome(status: ExecutionStatus, calls: number, messages: number) {
        const s = (await this.switchState());
        s.actions_today += calls;
        s.messages_today += messages;
        if (status === "sin_efecto" || status === "rechazado_por_moodle") s.consecutive_failures++;
        else if (status === "aplicado_verificado" || status === "aplicado_con_diferencias") s.consecutive_failures = 0;
        if (!s.paused && s.consecutive_failures >= BRAKE_THRESHOLD) {
            s.paused = true;
            s.paused_at = this.now().toISOString();
            s.paused_reason = `${s.consecutive_failures} resultados seguidos sin efecto o rechazados por Moodle`;
            await this.audit({ event: "brake_engaged", consecutive_failures: s.consecutive_failures });
        }
        await this.deps.store.writeState(s);
    }

    // ---------- deshacer ----------

    /** Arma el plan de deshacer de una acción (no escribe). Después hay que ejecutarlo. */
    async planUndo(actionId: string, client: string) {
        await this.assertEnabled();
        const planId = planIdOfAction(actionId);
        const sp = await this.loadVerified(planId);
        const result = sp.state.result;
        if (sp.state.status !== "ejecutado" || !result) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `La acción ${actionId} no existe o no se ejecutó.`);
        if (sp.state.undone_by) {
            throw new CampusError("PLAN_ALREADY_EXECUTED", `La acción ya se deshizo (${sp.state.undone_by}).`, { details: { undone_by: sp.state.undone_by } });
        }
        if (sp.plan.undo.kind === "ninguno") return { undoable: false as const, action_id: actionId, reason: sp.plan.undo.how };
        if (!result.items.some((r) => applied(r) || r.outcome === "desconocido")) return { undoable: false as const, action_id: actionId, reason: "La acción no aplicó cambios en el Campus." };
        const intent = this.intentOf(sp.plan.intent);
        await this.deps.read.scope.assertWriter(sp.plan.course_id);
        this.assertGrant(sp.plan.course_id, sp.plan.capability);
        const d = await intent.undo(sp.plan, result, this.ctx());
        if (d.kind === "ninguno") return { undoable: false as const, action_id: actionId, reason: d.reason };
        const until = result.undo.until ?? sp.plan.undo.until;
        if (until && this.now().getTime() > Date.parse(until)) {
            d.draft.warnings.unshift(`Pasó la ventana de deshacer (${until}): ${sp.plan.undo.how}`);
        } else if (until) {
            d.draft.warnings.unshift(`Ventana de deshacer hasta ${until}: ejecutalo antes.`);
        }
        const plan = await this.storeDraft(d.draft, client);
        await this.audit({ event: "undo_planned", action_id: actionId, undo_plan_id: plan.plan_id, client });
        return { undoable: true as const, action_id: actionId, undo_kind: sp.plan.undo.kind, plan };
    }

    // ---------- consultas ----------

    async status() {
        const s = (await this.switchState());
        const lim = this.policy.limits;
        const intents = [...this.deps.intents.values()];
        return {
            profile_id: this.deps.profile.profile_id,
            read_profile: this.deps.profile.read_profile.profile_id,
            site_url: this.deps.profile.read_profile.site_url,
            enabled: this.policy.enabled && !s.disabled && !s.paused,
            write_policy_enabled: this.policy.enabled,
            switch: { disabled: s.disabled, changed_at: s.changed_at },
            brake: { paused: s.paused, paused_at: s.paused_at, reason: s.paused_reason, consecutive_failures: s.consecutive_failures, threshold: BRAKE_THRESHOLD },
            limits: lim,
            today: { day: s.day, actions: s.actions_today, messages: s.messages_today, remaining_actions: Math.max(0, lim.max_actions_per_day - s.actions_today), remaining_messages: Math.max(0, lim.max_messages_per_day - s.messages_today) },
            confirmation: {
                out_of_band_from_risk: this.policy.require_out_of_band_from_risk,
                sandbox_confirmation: this.policy.sandbox_confirmation,
                dialog: this.policy.confirmation.dialog && process.platform === "win32",
                dialog_timeout_seconds: this.policy.confirmation.dialog_timeout_seconds,
                terminal: `campus write approve <plan_id> --profile ${this.deps.profile.profile_id}`,
            },
            max_enabled_risk: MAX_ENABLED_RISK,
            notify_students_default: this.policy.notify_students_default,
            allow_participant_notifications: this.policy.allow_participant_notifications,
            courses: [...this.policy.courses].map(([course_id, grants]) => ({
                course_id,
                sandbox: this.policy.sandbox_course_ids.includes(course_id),
                capabilities: grants.map((g) => ({ capability: g.capability, enabled_on: g.enabled_on, intent_tools: intents.filter((i) => i.capability === g.capability).map((i) => `campus_plan_${i.name}`) })),
            })),
            // ADR-125: cualquier otro curso del alcance donde la cuenta tenga rol de profesor, gestor o superior.
            all_courses: {
                applies_to: "cursos sin entrada propia en courses, donde tu rol es de profesor, gestor o superior",
                write_roles: this.deps.profile.read_profile.write_role_shortnames,
                capabilities: this.policy.all_courses.map((g) => ({ capability: g.capability, enabled_on: g.enabled_on })),
            },
            intents: intents.map((i) => ({ tool: `campus_plan_${i.name}`, capability: i.capability })),
        };
    }

    /** Acciones ejecutadas según la auditoría (sin contenido). */
    async listActions(since?: string) {
        let from = 0;
        if (since) {
            const unix = parseSince(since, this.tz);
            if (unix === null) throw new CampusError("CONFIG_INVALID", "since debe ser AAAA-MM-DD o ISO 8601 con zona.");
            from = unix * 1000;
        }
        const events = (await this.deps.store.readAudit()).filter((e) => e.event === "execution" && typeof e.ts === "string" && Date.parse(e.ts) >= from);
        return {
            actions: events.map((e) => ({ ts: e.ts, action_id: e.action_id, plan_id: e.plan_id, intent: e.intent, risk: e.risk, course_id: e.course_id, status: e.status, partial: e.partial, confirmation: e.confirmation, functions: e.functions, items: e.items, undo: e.undo, undo_of: e.undo_of, client: e.client })),
            source: { system: "local", file: "write-audit.jsonl", retrieved_at: this.now().toISOString() },
            coverage: { complete: true, since: since ?? null },
            warnings: [] as string[],
        };
    }
}

/** Cada llamada del plan pasa ya su allowlist: un plan nunca guarda algo que el transporte rechazaría. */
function checkItem(item: PlanItem, siteUrl: string) {
    const c = item.call;
    if (c.kind === "form") {
        const p = c.params as { query?: Record<string, string>; fields?: Record<string, string> };
        if (!p.query || !p.fields) throw new CampusError("POLICY_DENIED", `${c.fn}: formulario sin query o campos.`);
        const spec = checkWriteForm(c.fn, p.fields);
        checkWriteFormQuery(spec, p.query);
        if (item.uploads) {
            const f = item.uploads.field;
            const u = item.uploads;
            const sizeOk = u.form_draft ? u.files.length + u.form_draft.remove.length >= 1 && u.files.length <= 20 && u.form_draft.remove.length <= 50 && u.form_draft.remove.every((n) => n.length > 0 && n.length <= 255 && !/[\\/\u0000-\u001f]/.test(n)) : u.files.length >= 1 && u.files.length <= 20;
            // Editar archivos (borrador del formulario) sólo en los formularios *_update_files; altas, con borrador nuevo.
            const uploadFields = (spec.upload_fields ?? []).map((x) => x.replace("{userid}", p.query?.userid ?? "\u0000"));
            if (u.option || u.prepare || !f || !uploadFields.includes(f) || f in p.fields || !sizeOk || !!u.form_draft !== (spec.id.endsWith("_update_files") || !!spec.form_draft_files)) throw new CampusError("POLICY_DENIED", `${c.fn}: archivo no admitido en este formulario.`);
        }
        return;
    }
    if (c.kind === "ajax") {
        checkWriteAjax(c.fn, c.params as Record<string, unknown>);
        return;
    }
    const spec = checkWriteRest(c.fn, flattenParams(c.params), siteUrl);
    if (spec.kind !== "write") throw new CampusError("POLICY_DENIED", `${c.fn} no es una escritura.`);
    if (item.uploads) {
        const u = item.uploads;
        const opts = (c.params.options as { name: string }[] | undefined) ?? [];
        const fns = u.prepare ? ["mod_forum_update_discussion_post"] : ["mod_forum_add_discussion", "mod_forum_add_discussion_post"];
        if (u.option !== "attachmentsid" || u.field !== undefined || !fns.includes(c.fn) || opts.some((o) => o.name === u.option) || (!u.files.length && !u.prepare) || (u.prepare && u.prepare.postid !== Number(c.params.postid))) {
            throw new CampusError("POLICY_DENIED", `${c.fn}: adjuntos no admitidos en esta llamada.`);
        }
    }
}

/** Nombre de la llamada para la auditoría (sin parámetros). */
export function callLabel(item: PlanItem): string {
    const c = item.call;
    if (c.kind === "form") return `form:${c.fn}`;
    if (c.kind === "ajax") return `ajax:${c.fn}#${String((c.params as { action?: unknown }).action ?? "")}`;
    return c.fn;
}

const applied = (r: ItemResult) => r.outcome === "verificado" || r.outcome === "con_diferencias";

/** Estado global de la ejecución a partir de los ítems (§6.3). */
export function overallStatus(items: ItemResult[]): { status: ExecutionStatus; partial: boolean } {
    // Un ítem con error cuenta como falla aunque la relectura muestre cambios (Moodle guardó una parte y rechazó).
    const failed = items.filter((r) => !applied(r) || r.error !== null);
    if (!failed.length) return { status: items.some((r) => r.outcome === "con_diferencias") ? "aplicado_con_diferencias" : "aplicado_verificado", partial: false };
    const status: ExecutionStatus = failed.some((r) => r.outcome === "desconocido")
        ? "aplicado_desconocido"
        : failed.some((r) => r.outcome === "rechazado" || r.error !== null)
          ? "rechazado_por_moodle"
          : failed.some((r) => r.outcome === "sin_efecto")
            ? "sin_efecto"
            : "aplicado_desconocido";
    return { status, partial: items.some(applied) };
}

/**
 * Un resultado que no es éxito verificado se devuelve como error tipado (con el resultado en
 * details), para que nunca se lea como «ok»: §1.2.8 y §12 (fallas silenciosas).
 */
export function resultError(r: ExecutionResult): CampusError | null {
    if (!r.partial && (r.status === "aplicado_verificado" || r.status === "aplicado_con_diferencias")) return null;
    const undo = r.items.some((i) => applied(i) || i.outcome === "desconocido") && r.undo.kind !== "ninguno" ? ` Para revertir lo aplicado: campus_undo_action(${r.action_id}).` : "";
    const details = { result: r };
    if (r.partial) {
        return new CampusError("PARTIAL_APPLIED", `Se aplicó una parte del plan (${r.items.filter(applied).length} de ${r.items.length} ítems) y después falló (${r.status}). No se reintentó.${undo}`, { details });
    }
    if (r.status === "rechazado_por_moodle") {
        const first = r.items.find((i) => i.error);
        return new CampusError("MOODLE_REJECTED", `Moodle rechazó la operación: ${first?.error?.message ?? "sin detalle"}`, { details, moodleErrorcode: first?.error?.moodle_errorcode ?? undefined });
    }
    if (r.status === "sin_efecto") return new CampusError("VERIFICATION_FAILED", "Moodle respondió, pero la relectura muestra que no cambió nada (sin_efecto). No es un éxito.", { details });
    return new CampusError("VERIFICATION_FAILED", `No se pudo confirmar el efecto (aplicado_desconocido). NO reintentes: revisá en el Campus o con campus_get_plan.${undo}`, { details });
}
