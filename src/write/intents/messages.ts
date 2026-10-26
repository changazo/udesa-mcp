import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CampusError } from "../../errors.js";
import { EnrolledUsersSchema } from "../../moodle/schemas.js";
import type { IntentContext, Interpretation, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";
import { mayNotify } from "../policy.js";
import { comparable, toHtml } from "../text.js";

/**
 * ADR-120 · Mensaje privado a UN participante del curso (`core_message_send_instant_messages`). Un
 * mensaje privado siempre notifica: sólo a quien el perfil permite notificar (las cuentas de prueba del
 * sandbox, ADR-115, mientras allow_participant_notifications sea false). Un mensaje por plan (R3: no se
 * retira para el destinatario, y pasa por el humano en el circuito, ADR-118). Verificación: el mensaje
 * aparece en la conversación entre los dos (`core_message_get_conversation_between_users`).
 */

const ConversationSchema = z.object({
    messages: z.array(z.object({ id: z.number().int(), useridfrom: z.number().int(), text: z.string().nullable().optional(), timecreated: z.number().int() })).default([]),
});
const SendSchema = z.array(z.object({ msgid: z.number().int(), clientmsgid: z.string().nullable().optional(), errormessage: z.string().nullable().optional() }));

async function conversation(ctx: IntentContext, me: number, other: number) {
    try {
        return ConversationSchema.parse(
            await ctx.transport.call("core_message_get_conversation_between_users", { userid: me, otheruserid: other, includecontactrequests: 0, includeprivacyinfo: 0, memberlimit: 0, memberoffset: 0, messagelimit: 20, messageoffset: 0, newestmessagesfirst: 1 }),
        ).messages;
    } catch (e) {
        // Sin conversación previa Moodle responde con una excepción: no hay mensajes.
        if (e instanceof CampusError && e.code === "MOODLE_REJECTED") return [];
        throw e;
    }
}

function interpret(_item: PlanItem, data: unknown): Interpretation {
    const r = SendSchema.safeParse(data);
    if (!r.success || !r.data.length) return { ok: false, reason: "Respuesta inesperada al enviar el mensaje." };
    const m = r.data[0]!;
    return m.msgid > 0 ? { ok: true, moodle_ids: { message_id: m.msgid } } : { ok: false, reason: m.errormessage || "Moodle no envió el mensaje." };
}

async function verify(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<ItemVerification> {
    const t = item.target;
    const since = Math.floor(Date.parse(plan.created_at) / 1000) - 120;
    const want = String(item.expected.text);
    const m = (await conversation(ctx, Number(t.from_user_id), Number(t.user_id))).find((x) => x.useridfrom === Number(t.from_user_id) && x.timecreated >= since && comparable(x.text) === want);
    return m ? { outcome: "coincide", checked: ["mensaje"], differences: [], moodle_ids: { message_id: m.id } } : { outcome: "sin_efecto", checked: ["mensaje"], differences: [{ field: "mensaje", expected: "enviado", observed: "no aparece en la conversación" }] };
}

async function reconcile(item: PlanItem, plan: Plan, ctx: IntentContext): Promise<Presence> {
    return (await verify(item, plan, ctx)).outcome === "coincide" ? "presente" : "ausente";
}

const shape = {
    course_id: z.number().int().positive().describe("Curso donde está matriculado el destinatario (define si se le puede escribir)."),
    participant_id: z.number().int().positive(),
    text: z.string().trim().min(1).max(4_000).describe("Texto del mensaje (Markdown)."),
};

export const sendMessageIntent: WriteIntent<typeof shape> = {
    name: "send_message",
    title: "Plan: mensaje privado a un participante",
    description:
        "Arma el plan para mandar UN mensaje privado del Campus a UN participante del curso. Siempre le llega una notificación (y puede llegarle por correo): con el perfil actual sólo a las cuentas de prueba del sandbox. No se puede retirar para el destinatario. No escribe.",
    inputShape: shape,
    capability: "send_message",
    synthetic_only: false,
    readVersions: async () => ({}),
    interpret,
    verify,
    reconcile,
    async plan(input, ctx): Promise<PlanDraft> {
        if (!mayNotify(ctx.profile.policy, input.course_id, [input.participant_id])) throw new CampusError("WRITE_NOT_ALLOWED", "Un mensaje privado notifica siempre y el perfil no permite notificar a este participante (sólo a las cuentas de prueba del sandbox, ADR-115).");
        const me = (await ctx.read.session.verified()).info.userid;
        if (input.participant_id === me) throw new CampusError("WRITE_NOT_ALLOWED", "No se manda un mensaje a la propia cuenta.");
        const user = (await ctx.read.session.transport.call("core_enrol_get_enrolled_users", { courseid: input.course_id }, EnrolledUsersSchema)).find((u) => u.id === input.participant_id);
        if (!user) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El participante ${input.participant_id} no está matriculado en el curso ${input.course_id}.`);
        const html = toHtml(input.text, "markdown");
        const clientmsgid = randomBytes(8).toString("hex");
        return {
            intent: "send_message",
            capability: "send_message",
            course_id: input.course_id,
            base_risk: "R3",
            summary: `Mandar un mensaje privado a «${user.fullname ?? user.id}» (${user.id}).`,
            payload_preview: { to: { id: user.id, name: user.fullname ?? null }, text: input.text },
            side_effects: ["Le llega una notificación en el Campus (y, según sus preferencias, por correo o en la app).", "No se puede retirar: borrarlo después sólo lo borra de tu lado."],
            preconditions: { description: "Sin precondición.", versions: {} },
            undo: { kind: "ninguno", how: "Un mensaje enviado no se retira para el destinatario.", until: null },
            warnings: ["Notifica al destinatario (cuenta de prueba del sandbox, ADR-115)."],
            items: [
                {
                    item_id: "i1",
                    description: `Mensaje privado a ${user.id}`,
                    call: { fn: "core_message_send_instant_messages", params: { messages: [{ touserid: user.id, text: html, textformat: 1, clientmsgid }] } },
                    target: { course_id: input.course_id, user_id: user.id, from_user_id: me },
                    expected: { text: comparable(html) },
                    counts_as_message: true,
                },
            ],
            prior_state: {},
            untrusted_fields: ["payload_preview.to.name"],
            teacher_text: { text: input.text },
            undo_of: null,
        };
    },
    async undo() {
        return { kind: "ninguno", reason: "Un mensaje enviado no se retira para el destinatario." };
    },
};
