import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../../src/config/profile.js";
import { TOOL_NAMES } from "../../src/mcp/server.js";
import { makeHarness, type Harness } from "../fixtures/harness.js";
import { COURSE, OTHER_COURSE, syntheticProfileJson, VALID_TOKEN } from "../fixtures/fake-moodle.js";

async function connect(h: Harness) {
    const server = h.app.server();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return client;
}

const parse = (r: { content: unknown }) => JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

describe("servidor MCP", () => {
    it("MCP-01/POL-05: tools/list expone sólo el catálogo de lectura", async () => {
        const client = await connect(await makeHarness());
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
        for (const t of tools) {
            expect(t.annotations?.readOnlyHint).toBe(true);
            expect(t.annotations?.destructiveHint).toBe(false);
            expect(JSON.stringify(t.inputSchema)).not.toMatch(/wsfunction|wstoken|confirm|password|url"/);
        }
        // Toda tool es una lectura por nombre: get/list/read/search. Nada de post/send/add/delete/save/submit/set.
        for (const t of tools) expect(t.name, t.name).toMatch(/^campus_(get|list|read|search)_[a-z_]+$/);
        expect(tools.some((t) => /_(post|send|add|delete|save|submit|set|create|update)(_|$)/.test(t.name.replace(/^campus_get_course_updates$/, "")))).toBe(false);
    });

    it("consulta de avisos con source, coverage y warnings; sin token en la salida", async () => {
        const client = await connect(await makeHarness());
        const r = await client.callTool({ name: "campus_list_announcements", arguments: { course_id: COURSE, limit: 3 } });
        expect(r.isError).toBeFalsy();
        const body = parse(r as { content: unknown });
        expect(body.data.announcements).toHaveLength(3);
        expect(body.source).toMatchObject({ system: "moodle", course_id: COURSE });
        expect(body.coverage.has_more).toBe(true);
        expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
    });

    it("MCP-02: sin sesión devuelve error estructurado con instrucción humana, no un prompt de contraseña", async () => {
        const client = await connect(await makeHarness({ loggedIn: false }));
        const r = await client.callTool({ name: "campus_list_announcements", arguments: { course_id: COURSE } });
        expect(r.isError).toBe(true);
        const body = parse(r as { content: unknown });
        expect(body.error.code).toBe("AUTH_REQUIRED");
        expect(body.error.human_action).toContain("cli.js auth login --profile");
        expect(JSON.stringify(body)).not.toMatch(/"data"/);
    });

    it("POL-01 vía MCP: curso fuera de la allowlist", async () => {
        const client = await connect(await makeHarness());
        const r = await client.callTool({ name: "campus_get_course", arguments: { course_id: OTHER_COURSE } });
        expect(r.isError).toBe(true);
        expect(parse(r as { content: unknown }).error.code).toBe("POLICY_DENIED");
    });

    it("estado y capacidades no exponen secretos", async () => {
        const h = await makeHarness();
        const client = await connect(h);
        const status = parse((await client.callTool({ name: "campus_get_status", arguments: { verify: true } })) as { content: unknown });
        expect(status.status.authenticated).toBe(true);
        const caps = parse((await client.callTool({ name: "campus_get_capabilities", arguments: { refresh: true } })) as { content: unknown });
        expect(caps.report_kind).toBe("runtime_observation");
        const all = JSON.stringify([status, caps]);
        expect(all).not.toContain(VALID_TOKEN);
        expect(all).not.toContain("PRIVADA-NO-DEBE-SALIR");
        expect(all).not.toContain("\"username\"");
    });

    it("CAP-04: si no se puede refrescar, devuelve el último reporte avisando su antigüedad", async () => {
        const h = await makeHarness();
        const client = await connect(h);
        await client.callTool({ name: "campus_get_capabilities", arguments: { refresh: true } });
        h.fake.overrides.set("core_webservice_get_site_info", () => ({ exception: "moodle_exception", errorcode: "sitemaintenance", message: "Maintenance" }));
        const r = parse((await client.callTool({ name: "campus_get_capabilities", arguments: { refresh: true } })) as { content: unknown });
        expect(r.warnings.join(" ")).toMatch(/No se pudo refrescar \(SERVICE_UNAVAILABLE\)/);
    });

    it("rechaza argumentos fuera de esquema (p. ej. una URL en lugar de file_ref larga)", async () => {
        const client = await connect(await makeHarness());
        const r = await client.callTool({ name: "campus_read_file", arguments: { file_ref: `https://campus.example.test/${"x".repeat(100)}` } });
        expect(r.isError).toBe(true);
    });
});

const built = join(packageRoot(), "build", "cli.js");

describe.skipIf(!existsSync(built))("STDIO real (requiere npm run build)", () => {
    it("MCP-03: handshake y tools/list por STDIO; stdout sólo protocolo; no toca la red", async () => {
        const dir = mkdtempSync(join(tmpdir(), "campus-mcp-"));
        const profileFile = join(dir, "sintetico.json");
        writeFileSync(profileFile, JSON.stringify(syntheticProfileJson()));
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [built, "serve", "--profile-file", profileFile],
            env: { ...process.env, CAMPUS_STATE_DIR: dir } as Record<string, string>,
            stderr: "pipe",
        });
        const stderr: string[] = [];
        transport.stderr?.on("data", (d) => stderr.push(String(d)));
        const client = new Client({ name: "stdio-test", version: "0.0.0" });
        await client.connect(transport); // cualquier byte no-JSON en stdout rompería el handshake
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(TOOL_NAMES.length);
        const r = await client.callTool({ name: "campus_get_status", arguments: {} });
        const body = parse(r as { content: unknown });
        expect(body.profile.site_url).toBe("https://campus.example.test");
        await client.close();
        expect(stderr.join("")).toContain("server_started");
    }, 30_000);
});
