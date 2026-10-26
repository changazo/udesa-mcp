import { z } from "zod";
import { CampusError } from "../../errors.js";
import type { IntentContext, ItemVerification, Presence, WriteIntent } from "../intent.js";
import type { Plan, PlanDraft, PlanItem } from "../plan.js";

/**
 * Intención de PRUEBA de W0 (directiva §9, W0): cambia «marcadores» que sólo existen en el Moodle
 * sintético de los tests (`local_sintetico_*`, sitio `.test`). Sirve para ejercitar el circuito
 * completo — plan, riesgo, confirmación, ejecución, reconciliación, verificación, lotes y
 * deshacer — sin ninguna escritura real. No se registra contra el Campus.
 */

const MarkerSchema = z.object({ id: z.number().int().positive(), name: z.string(), value: z.string(), timemodified: z.number().int().nonnegative() });
const MarkersSchema = z.array(MarkerSchema);
type Marker = z.infer<typeof MarkerSchema>;

async function readMarkers(courseId: number, ctx: IntentContext): Promise<Map<number, Marker>> {
    const data = await ctx.transport.call("local_sintetico_get_markers", { courseid: courseId });
    const parsed = MarkersSchema.safeParse(data);
    if (!parsed.success) throw new CampusError("UNEXPECTED_RESPONSE", "La lectura de marcadores no tiene la forma esperada.");
    return new Map(parsed.data.map((m) => [m.id, m]));
}

const inputShape = {
    course_id: z.number().int().positive().describe("ID del curso (sintético)."),
    changes: z
        .array(
            z.strictObject({
                marker_id: z.number().int().positive(),
                value: z.string().min(1).max(100),
            }),
        )
        .min(1)
        .max(30)
        .describe("Marcadores a cambiar y su valor nuevo."),
    visible_to_students: z.boolean().optional().describe("Por defecto true (R2). false = no visible (R1)."),
};

type Input = z.infer<z.ZodObject<typeof inputShape>>;

async function buildPlan(input: Input, ctx: IntentContext, undoOf: string | null): Promise<PlanDraft> {
    const markers = await readMarkers(input.course_id, ctx);
    const seen = new Set<number>();
    const items: PlanItem[] = [];
    const preview: { marker_id: number; name: string; from: string; to: string }[] = [];
    const versions: Record<string, number> = {};
    const prior: Record<string, string> = {};
    for (const [i, c] of input.changes.entries()) {
        if (seen.has(c.marker_id)) throw new CampusError("POLICY_DENIED", `El marcador ${c.marker_id} aparece dos veces en el pedido.`);
        seen.add(c.marker_id);
        const m = markers.get(c.marker_id);
        if (!m) throw new CampusError("RESOURCE_OUT_OF_SCOPE", `El marcador ${c.marker_id} no pertenece al curso ${input.course_id}.`);
        if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(c.value)) throw new CampusError("POLICY_DENIED", "El valor tiene caracteres de control.");
        versions[`marker:${m.id}`] = m.timemodified;
        prior[String(m.id)] = m.value;
        preview.push({ marker_id: m.id, name: m.name, from: m.value, to: c.value });
        items.push({
            item_id: `i${i + 1}`,
            description: `Marcador ${m.id}: «${m.value}» → «${c.value}»`,
            call: { fn: "local_sintetico_set_marker", params: { courseid: input.course_id, markerid: m.id, value: c.value } },
            target: { course_id: input.course_id, marker_id: m.id },
            expected: { value: c.value },
        });
    }
    const visible = input.visible_to_students ?? true;
    return {
        intent: "marcador_sintetico",
        capability: "synthetic_test",
        course_id: input.course_id,
        base_risk: visible ? "R2" : "R1",
        summary: `${undoOf ? "Deshacer: " : ""}cambiar ${items.length} marcador(es) del curso sintético ${input.course_id}${visible ? ", visible para estudiantes (ficticio)" : ""}.`,
        payload_preview: { changes: preview, visible_to_students: visible },
        side_effects: visible ? ["Visible para los estudiantes del curso sintético. Sin notificaciones."] : ["Sin efectos visibles ni notificaciones."],
        preconditions: { description: "timemodified de cada marcador (si cambió, PLAN_STALE).", versions },
        undo: { kind: "exacto", how: "Restaurar los valores anteriores guardados en el plan.", until: null },
        warnings: ["Intención de prueba: sólo existe en el Moodle sintético (.test)."],
        items,
        prior_state: { values: prior },
        // El nombre y el valor actual del marcador vienen del «Campus»: son datos, no instrucciones.
        untrusted_fields: ["payload_preview.changes[].name", "payload_preview.changes[].from"],
        teacher_text: Object.fromEntries(input.changes.map((c, i) => [`changes[${i}].value`, c.value])),
        undo_of: undoOf,
    };
}

export const syntheticMarkerIntent: WriteIntent<typeof inputShape> = {
    name: "marcador_sintetico",
    title: "Plan de prueba: marcadores sintéticos",
    description: "SÓLO PRUEBAS (Moodle sintético). Arma el plan para cambiar marcadores del curso sintético. No escribe: devuelve el plan para campus_execute_plan.",
    inputShape,
    capability: "synthetic_test",
    synthetic_only: true,

    plan: (input, ctx) => buildPlan(input, ctx, null),

    async readVersions(plan, ctx) {
        const markers = await readMarkers(plan.course_id, ctx);
        const out: Record<string, number | null> = {};
        for (const key of Object.keys(plan.preconditions.versions)) {
            const id = Number(key.split(":")[1]);
            out[key] = markers.get(id)?.timemodified ?? null;
        }
        return out;
    },

    interpret(_item, data) {
        // Igual que varias funciones reales: null no es éxito ni fracaso; decide la relectura.
        if (data === null || data === undefined) return { ok: true };
        if (typeof data === "object" && !Array.isArray(data)) {
            const d = data as { status?: unknown; warnings?: unknown; markerid?: unknown };
            if (d.status === false) return { ok: false, reason: "Moodle devolvió status=false." };
            if (d.markerid === -1) return { ok: false, reason: "Moodle devolvió markerid=-1." };
            if (Array.isArray(d.warnings) && d.warnings.length) {
                const codes = d.warnings.map((w) => (w && typeof w === "object" && "warningcode" in w ? String((w as { warningcode: unknown }).warningcode) : "aviso")).join(", ");
                return { ok: false, reason: `Moodle devolvió avisos: ${codes}.` };
            }
            return { ok: true };
        }
        return { ok: false, reason: "Respuesta inesperada." };
    },

    async reconcile(item, plan, ctx): Promise<Presence> {
        const m = (await readMarkers(plan.course_id, ctx)).get(Number(item.target.marker_id));
        if (!m) return "desconocido";
        const prior = (plan.prior_state.values as Record<string, string>)[String(m.id)];
        if (m.value === item.expected.value) return "presente";
        if (m.value === prior) return "ausente";
        return "desconocido";
    },

    async verify(item, plan, ctx): Promise<ItemVerification> {
        const m = (await readMarkers(plan.course_id, ctx)).get(Number(item.target.marker_id));
        if (!m) return { outcome: "difiere", checked: ["marcador"], differences: [{ field: "marcador", expected: "existe", observed: "no existe" }] };
        const prior = (plan.prior_state.values as Record<string, string>)[String(m.id)];
        if (m.value === item.expected.value) return { outcome: "coincide", checked: ["value"], differences: [], moodle_ids: { marker_id: m.id } };
        if (m.value === prior) return { outcome: "sin_efecto", checked: ["value"], differences: [{ field: "value", expected: item.expected.value, observed: m.value }] };
        return { outcome: "difiere", checked: ["value"], differences: [{ field: "value", expected: item.expected.value, observed: m.value }], moodle_ids: { marker_id: m.id } };
    },

    async undo(plan, result, ctx) {
        const prior = plan.prior_state.values as Record<string, string>;
        const applied = result.items.filter((r) => r.outcome === "verificado" || r.outcome === "con_diferencias" || r.outcome === "desconocido");
        if (!applied.length) return { kind: "ninguno", reason: "La acción no aplicó cambios." };
        const changes = applied.map((r) => {
            const item = plan.items.find((i) => i.item_id === r.item_id)!;
            const id = Number(item.target.marker_id);
            return { marker_id: id, value: prior[String(id)]! };
        });
        const visible = (plan.payload_preview as { visible_to_students?: boolean }).visible_to_students;
        return { kind: "plan", draft: await buildPlan({ course_id: plan.course_id, changes, visible_to_students: visible }, ctx, result.action_id) };
    },
};
