import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../../src/config/profile.js";
import { TOOL_NAMES } from "../../src/mcp/server.js";
import { WRITE_COMMON_TOOLS } from "../../src/write/server.js";
import { COURSE, syntheticProfileJson } from "../fixtures/fake-moodle.js";
import { connectWrite, makeWriteHarness, parseTool, writeProfileJson } from "../fixtures/write-harness.js";

/** Claves de entrada que delatarían una herramienta genérica. */
const FORUM_TOOLS = ["campus_plan_announcement", "campus_plan_forum_reply", "campus_plan_post_edit", "campus_plan_discussion_state", "campus_plan_calendar_event", "campus_plan_extension", "campus_plan_submission_lock", "campus_plan_submission_comment", "campus_plan_create_assignment", "campus_plan_visibility", "campus_plan_move_activity", "campus_plan_rename", "campus_plan_grade", "campus_plan_attendance", "campus_plan_attendance_session", "campus_plan_create_attendance", "campus_plan_quiz_override", "campus_plan_create_quiz", "campus_plan_create_group", "campus_plan_group_members", "campus_plan_question_import", "campus_plan_quiz_add_questions", "campus_plan_create_content", "campus_plan_edit_dates", "campus_plan_assign_override", "campus_plan_delete_content", "campus_plan_create_section", "campus_plan_question_status", "campus_plan_post_attachments", "campus_plan_forum_grade", "campus_plan_quiz_grade", "campus_plan_quiz_add_random", "campus_plan_quiz_slot_maxmark", "campus_plan_create_grouping", "campus_plan_grouping_groups", "campus_plan_edit_activity_text", "campus_plan_section_summary", "campus_plan_edit_group", "campus_plan_choice_options", "campus_plan_activity_files", "campus_plan_book_chapter", "campus_plan_glossary_entry", "campus_plan_wiki_page", "campus_plan_data_entry", "campus_plan_data_field", "campus_plan_lesson_page", "campus_plan_activity_settings", "campus_plan_duplicate_activity", "campus_plan_calendar_event_delete", "campus_plan_attendance_session_delete", "campus_plan_quiz_override_delete", "campus_plan_assign_override_delete", "campus_plan_quiz_remove_question", "campus_plan_move_section", "campus_plan_edit_grouping", "campus_plan_attendance_session_edit", "campus_plan_calendar_event_edit", "campus_plan_quiz_layout", "campus_plan_lesson_question", "campus_plan_forum_post_delete", "campus_plan_forum_move_discussion", "campus_plan_grade_advanced", "campus_plan_grading_definition", "campus_plan_grade_item", "campus_plan_gradebook_grade", "campus_plan_questionnaire_question", "campus_plan_override_edit", "campus_plan_glossary_category", "campus_plan_choicegroup_groups", "campus_plan_delete_group", "campus_plan_h5p_content", "campus_plan_lab_lti_tool", "campus_plan_lab_lti_exercise", "campus_plan_quiz_attempt_delete", "campus_plan_assign_submission_reset", "campus_plan_send_message"];
const GENERIC_KEYS = /"(wsfunction|function|functionname|methodname|method|action|component|itemtype|url|uri|path|formclass|form|params|args)"\s*:/i;

describe("servidor completo (docente-completo, ADR-062)", () => {
    it("UN conector con las tools de lectura y las de escritura, sin nombres repetidos", async () => {
        const h = await makeWriteHarness();
        const server = h.app.fullServer();
        const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "cliente-completo", version: "0.0.0" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.sort()).toEqual([...TOOL_NAMES, ...WRITE_COMMON_TOOLS, ...FORUM_TOOLS, "campus_plan_marcador_sintetico"].sort());
        expect(client.getInstructions()).toContain("LECTURAS");
        expect(client.getInstructions()).toContain("ESCRITURAS");
        // Una lectura funciona por el mismo conector.
        const r = await client.callTool({ name: "campus_get_status", arguments: {} });
        expect(r.isError ?? false).toBe(false);
    });
});

describe("servidor MCP de escritura", () => {
    it("expone las herramientas comunes (§6.1), las intenciones de foros (W1) y, contra el Moodle sintético, la de prueba", async () => {
        const client = await connectWrite(await makeWriteHarness());
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([...WRITE_COMMON_TOOLS, ...FORUM_TOOLS, "campus_plan_marcador_sintetico"].sort());
        const exec = tools.find((t) => t.name === "campus_execute_plan")!;
        expect(exec.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
        for (const t of tools.filter((t) => t.name !== "campus_execute_plan")) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    });

    it("genéricos (§12): ninguna herramienta acepta nombres de funciones, métodos, acciones, componentes ni URLs", async () => {
        const client = await connectWrite(await makeWriteHarness());
        const { tools } = await client.listTools();
        for (const t of tools) expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(GENERIC_KEYS);
        // execute sólo recibe un plan_id con forma cerrada.
        const r = await client.callTool({ name: "campus_execute_plan", arguments: { plan_id: "core_enrol_unenrol_user_enrolment" } });
        expect(r.isError).toBe(true);
    });

    it("circuito completo por MCP: plan (no escribe) → execute → resultado verificado; un argumento extra no cambia nada", async () => {
        const h = await makeWriteHarness();
        const client = await connectWrite(h);
        const plan = parseTool((await client.callTool({ name: "campus_plan_marcador_sintetico", arguments: { course_id: COURSE, changes: [{ marker_id: 1, value: "desde MCP" }] } })) as { content: unknown });
        expect(plan.plan_id).toMatch(/^pl_/);
        expect(plan.next_step).toMatch(/fuera del chat/);
        expect(h.fake.callsOf("local_sintetico_set_marker")).toHaveLength(0);
        const r = await client.callTool({ name: "campus_execute_plan", arguments: { plan_id: plan.plan_id, wsfunction: "mod_forum_add_discussion", value: "otro" } });
        expect(r.isError).toBeFalsy();
        const body = parseTool(r as { content: unknown });
        expect(body.status).toBe("aplicado_verificado");
        expect(h.fake.callsOf("local_sintetico_set_marker").map((c) => c.params.value)).toEqual(["desde MCP"]);
        expect(h.fake.calls.some((c) => c.fn === "mod_forum_add_discussion")).toBe(false);
        const actions = parseTool((await client.callTool({ name: "campus_list_write_actions", arguments: {} })) as { content: unknown });
        expect(actions.actions[0].client).toBe("local:cliente-prueba");
    });

    it("un resultado sin efecto vuelve como error tipado con el resultado adentro, nunca como «ok»", async () => {
        const h = await makeWriteHarness();
        const client = await connectWrite(h);
        h.markers.next("noop_null");
        const plan = parseTool((await client.callTool({ name: "campus_plan_marcador_sintetico", arguments: { course_id: COURSE, changes: [{ marker_id: 1, value: "x" }] } })) as { content: unknown });
        const r = await client.callTool({ name: "campus_execute_plan", arguments: { plan_id: plan.plan_id } });
        expect(r.isError).toBe(true);
        const body = parseTool(r as { content: unknown });
        expect(body.error.code).toBe("VERIFICATION_FAILED");
        expect(body.error.details.result.status).toBe("sin_efecto");
    });

    it("estado: capacidades por curso, límites, freno y canal de confirmación", async () => {
        const client = await connectWrite(await makeWriteHarness());
        const s = parseTool((await client.callTool({ name: "campus_get_write_status", arguments: {} })) as { content: unknown });
        expect(s.enabled).toBe(true);
        expect(s.courses).toEqual([{ course_id: COURSE, sandbox: true, capabilities: [{ capability: "synthetic_test", enabled_on: null, intent_tools: ["campus_plan_marcador_sintetico"] }] }]);
        expect(s.brake.threshold).toBe(3);
        expect(s.confirmation.out_of_band_from_risk).toBe("R2");
    });

    it("separación (§12): el servidor de lectura no tiene ninguna herramienta de escritura", () => {
        const read = new Set<string>(TOOL_NAMES);
        for (const t of WRITE_COMMON_TOOLS) expect(read.has(t)).toBe(false);
        expect([...read].some((t) => t.startsWith("campus_plan_") || t.includes("execute") || t.includes("undo"))).toBe(false);
    });
});

const built = join(packageRoot(), "build", "cli.js");

describe.skipIf(!existsSync(built))("doble llave por STDIO (requiere npm run build)", () => {
    const setup = () => {
        const dir = mkdtempSync(join(tmpdir(), "campus-write-stdio-"));
        writeFileSync(join(dir, "sintetico.json"), JSON.stringify(syntheticProfileJson()));
        const writeFile = join(dir, "sintetico-escritura.json");
        writeFileSync(writeFile, JSON.stringify(writeProfileJson()));
        return { dir, writeFile };
    };
    const baseEnv = () => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CAMPUS_")) env[k] = v;
        return env;
    };

    it("sin CAMPUS_WRITE_ENABLED=true el servidor de escritura no arranca", () => {
        const { dir, writeFile } = setup();
        for (const extra of [{}, { CAMPUS_WRITE_ENABLED: "1" }]) {
            const r = spawnSync(process.execPath, [built, "serve-write", "--profile-file", writeFile], { env: { ...baseEnv(), CAMPUS_STATE_DIR: dir, ...extra }, encoding: "utf8", timeout: 20_000 });
            expect(r.status).toBe(1);
            expect(r.stderr).toContain("WRITE_DISABLED");
            expect(r.stdout).toBe("");
        }
    }, 30_000);

    it("el servidor de lectura no arranca con el perfil de escritura (ni con la variable)", () => {
        const { dir, writeFile } = setup();
        const r = spawnSync(process.execPath, [built, "serve", "--profile-file", writeFile], { env: { ...baseEnv(), CAMPUS_STATE_DIR: dir, CAMPUS_WRITE_ENABLED: "true" }, encoding: "utf8", timeout: 20_000 });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("CONFIG_INVALID");
    }, 30_000);

    it("con las dos llaves: handshake y tools/list por STDIO, sin red", async () => {
        const { dir, writeFile } = setup();
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [built, "serve-write", "--profile-file", writeFile],
            env: { ...baseEnv(), CAMPUS_STATE_DIR: dir, CAMPUS_WRITE_ENABLED: "true" },
            stderr: "pipe",
        });
        const stderr: string[] = [];
        transport.stderr?.on("data", (d) => stderr.push(String(d)));
        const client = new Client({ name: "stdio-escritura", version: "0.0.0" });
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([...WRITE_COMMON_TOOLS, ...FORUM_TOOLS, "campus_plan_marcador_sintetico"].sort());
        const s = parseTool((await client.callTool({ name: "campus_get_write_status", arguments: {} })) as { content: unknown });
        expect(s.profile_id).toBe("sintetico-escritura");
        await client.close();
        expect(stderr.join("")).toContain("write_server_started");
    }, 30_000);
});
