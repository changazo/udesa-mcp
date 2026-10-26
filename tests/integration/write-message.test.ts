import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { COURSE, STUDENT_A, STUDENT_B, USER_ID } from "../fixtures/fake-moodle.js";
import { makeWriteHarness } from "../fixtures/write-harness.js";

/** ADR-120: mensaje privado sólo a quien el perfil permite notificar. Datos inventados. */
async function harness(notifiable: number[] = [STUDENT_A]) {
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["send_message"] }, notifiable_user_ids: notifiable } });
    const sent: { from: number; to: number; text: string; time: number }[] = [];
    h.fake.overrides.set("core_enrol_get_enrolled_users", () => [
        { id: STUDENT_A, fullname: "Estudiante A" },
        { id: STUDENT_B, fullname: "Estudiante B" },
    ]);
    h.fake.overrides.set("core_message_send_instant_messages", (p) => {
        sent.push({ from: USER_ID, to: Number(p["messages[0][touserid]"]), text: String(p["messages[0][text]"]), time: Math.floor(Date.now() / 1000) });
        return [{ msgid: 900 + sent.length, clientmsgid: p["messages[0][clientmsgid]"], errormessage: "" }];
    });
    h.fake.overrides.set("core_message_get_conversation_between_users", (p) => ({
        id: 1,
        messages: sent.filter((m) => m.to === Number(p.otheruserid)).map((m, i) => ({ id: 901 + i, useridfrom: m.from, text: m.text, timecreated: m.time })),
    }));
    return { h, sent };
}
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("mensaje privado (ADR-120)", () => {
    it("a una cuenta de prueba: R3, cuenta como mensaje, verificado en la conversación; sin deshacer", async () => {
        const { h, sent } = await harness();
        const p = await h.app.engine.plan("send_message", { course_id: COURSE, participant_id: STUDENT_A, text: "Hola, **prueba**." }, "test");
        expect(p.risk).toBe("R3");
        expect(p.summary).toBe(`Mandar un mensaje privado a «Estudiante A» (${STUDENT_A}).`);
        const r = await h.app.engine.execute(p.plan_id, h.confirmer, "test");
        expect(r.status).toBe("aplicado_verificado");
        expect(sent).toHaveLength(1);
        expect(sent[0]!.text).toContain("<strong>prueba</strong>");
        expect((await h.app.engine.planUndo(r.action_id, "test")).undoable).toBe(false);
    });

    it("a cualquier otra persona, rechazado en el plan sin enviar nada", async () => {
        const { h, sent } = await harness();
        expect((await errOf(h.app.engine.plan("send_message", { course_id: COURSE, participant_id: STUDENT_B, text: "x" }, "test"))).message).toMatch(/notifica siempre/);
        const none = await harness([]);
        expect((await errOf(none.h.app.engine.plan("send_message", { course_id: COURSE, participant_id: STUDENT_A, text: "x" }, "test"))).code).toBe("WRITE_NOT_ALLOWED");
        expect(sent).toHaveLength(0);
    });
});
