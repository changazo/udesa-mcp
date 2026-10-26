import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { COURSE } from "../fixtures/fake-moodle.js";
import { makeWriteHarness, parseTool, type WriteHarness } from "../fixtures/write-harness.js";

/** ADR-118: un R3 confirmado en el cliente exige la aprobación del usuario, por elicitación o por sus palabras. */
async function connect(h: WriteHarness, answer?: { action: "accept" | "decline"; content?: Record<string, unknown> }) {
    const server = h.app.server();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cliente-prueba", version: "0.0.0" }, answer ? { capabilities: { elicitation: {} } } : {});
    const asked: string[] = [];
    if (answer)
        client.setRequestHandler(ElicitRequestSchema, async (req) => {
            asked.push(String(req.params.message));
            return answer;
        });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, asked };
}
const real = () => makeWriteHarness({ policy: { require_out_of_band_from_risk: "nunca", sandbox_course_ids: [] } });
const planR3 = async (client: Client) => parseTool((await client.callTool({ name: "campus_plan_marcador_sintetico", arguments: { course_id: COURSE, changes: [1, 2, 4, 5, 6, 7].map((id) => ({ marker_id: id, value: "x" })) } })) as { content: unknown });
const execute = async (client: Client, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: "campus_execute_plan", arguments: args })) as { isError?: boolean; content: unknown };
    return { isError: r.isError ?? false, body: parseTool(r) };
};

describe("humano en el circuito (ADR-118)", () => {
    it("sin elicitación: el plan trae present_to_user; sin user_approval no escribe, con las palabras del usuario sí", async () => {
        const h = await real();
        const { client } = await connect(h);
        const p = await planR3(client);
        expect(p.risk).toBe("R3");
        expect(p.human_in_the_loop.present_to_user).toContain("¿Lo aprobás?");
        expect(p.next_step).toMatch(/^ANTES de ejecutar/);
        const no = await execute(client, { plan_id: p.plan_id });
        expect(no.isError).toBe(true);
        expect(no.body.error.code).toBe("CONFIRMATION_REQUIRED");
        const ok = await execute(client, { plan_id: p.plan_id, user_approval: "Sí, aprobado" });
        expect(ok.isError).toBe(false);
        expect(ok.body.confirmation.channel).toBe("usuario_en_chat");
    });

    it("con elicitación: el servidor pregunta al humano; aceptar sin marcar o rechazar no escribe, aunque el agente traiga palabras", async () => {
        const h = await real();
        const yes = await connect(h, { action: "accept", content: { aprobar: true } });
        const p = await planR3(yes.client);
        const ok = await execute(yes.client, { plan_id: p.plan_id });
        expect(ok.body.confirmation.channel).toBe("elicitacion");
        expect(yes.asked[0]).toMatch(/aprobar escritura R3/);

        const unmarked = await connect(h, { action: "accept", content: { aprobar: false } });
        const q = await planR3(unmarked.client);
        const r = await execute(unmarked.client, { plan_id: q.plan_id, user_approval: "sí" });
        expect(r.body.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(r.body.error.message).toMatch(/rechazó/);
    });
});
