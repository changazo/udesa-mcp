import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import type { ChatFileDeps } from "../../src/write/chat-files.js";
import { COURSE } from "../fixtures/fake-moodle.js";
import { SyntheticActivities } from "../fixtures/fake-activities.js";
import { SyntheticContent } from "../fixtures/fake-content.js";
import { connectWrite, makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * Archivos que entrega ChatGPT (`openai/fileParams`) en campus_plan_create_content y campus_plan_activity_files:
 * se bajan al planificar, los bytes quedan aparte con vencimiento y se suben al ejecutar. Funciona en el remoto.
 */

const PDF_A = Buffer.from("%PDF-1.7\nprimer parcial\n%%EOF\n");
const PDF_B = Buffer.from("%PDF-1.4\nsegundo parcial\n%%EOF\n");
const URL_A = "https://files.chat.example/a?sig=SECRETO_A";
const URL_B = "https://files.chat.example/b?sig=SECRETO_B";
const fileA = { download_url: URL_A, file_id: "file_a", file_name: "parcial-1.pdf", mime_type: "application/pdf" };
const fileB = { download_url: URL_B, file_id: "file_b", file_name: "parcial-2.pdf", mime_type: "application/pdf" };

function chatFiles(): ChatFileDeps & { downloads: string[] } {
    const downloads: string[] = [];
    const bodies: Record<string, Buffer> = { [URL_A]: PDF_A, [URL_B]: PDF_B };
    return {
        downloads,
        resolve: async () => ["93.184.216.34"],
        fetchImpl: (async (input: string | URL | Request) => {
            downloads.push(String(input));
            const body = bodies[String(input)];
            return body ? new Response(body) : new Response("no", { status: 404 });
        }) as typeof fetch,
    };
}

async function harness(remote = true, fixture: "content" | "activities" = "content") {
    const cf = chatFiles();
    const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: ["create_content", "edit_activity"] } }, remote, chatFiles: cf });
    const c = fixture === "content" ? new SyntheticContent(h.fake, h.w2) : null!;
    const acts = fixture === "activities" ? new SyntheticActivities(h.fake, h.w2) : null!;
    const uploaded: File[] = [];
    const orig = h.fake.upload!;
    h.fake.upload = (form) => {
        for (const [k, v] of form.entries()) if (k.startsWith("file_")) uploaded.push(v as File);
        return orig(form);
    };
    return { h, c, acts, cf, uploaded };
}
const plan = (h: WriteHarness, input: Record<string, unknown>) => h.app.engine.plan("create_content", { course_id: COURSE, section: 1, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}
const planFile = (h: WriteHarness, id: string) => readFileSync(join(h.dir, "plans", `${id}.json`), "utf8");

describe("archivos de ChatGPT en el remoto", () => {
    it("recurso: el plan baja y describe el PDF sin guardar sus bytes; al ejecutar sube exactamente esos bytes", async () => {
        const { h, c, cf, uploaded } = await harness();
        const p = await plan(h, { type: "resource", name: "Parcial 1", files: [fileA] });
        expect(cf.downloads).toEqual([URL_A]);
        expect(p.payload_preview).toMatchObject({ file: { filename: "parcial-1.pdf", bytes: PDF_A.length, path: "(ChatGPT files.chat.example: file_a)" } });
        const stored = planFile(h, p.plan_id);
        expect(stored).not.toContain(PDF_A.toString("base64"));
        expect(stored).not.toContain("SECRETO");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(cf.downloads).toHaveLength(1); // no se vuelve a bajar
        expect(uploaded[0]!.name).toBe("parcial-1.pdf");
        expect(Buffer.from(await uploaded[0]!.arrayBuffer()).equals(PDF_A)).toBe(true);
        expect([...c.resources.values()][0]).toEqual([{ filename: "parcial-1.pdf", filesize: PDF_A.length }]);
    });

    it("carpeta con dos PDFs y luego agregarle otro con add_files; dos archivos con el mismo nombre se rechazan", async () => {
        const { h, acts } = await harness(true, "activities");
        const r = await exec(h, (await plan(h, { type: "folder", name: "Exámenes anteriores", files: [fileA] })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const m = [...acts.mods.values()].find((x) => x.name === "Exámenes anteriores")!;
        expect(m.files!.map((f) => f.filename)).toEqual(["parcial-1.pdf"]);
        const add = await h.app.engine.plan("activity_files", { course_id: COURSE, course_module_id: m.id, add_files: [fileB] }, "test");
        expect((await exec(h, add.plan_id)).status).toBe("aplicado_verificado");
        expect(m.files!.map((f) => f.filename).sort()).toEqual(["parcial-1.pdf", "parcial-2.pdf"]);
        const dup = await errOf(plan(h, { type: "folder", name: "X", files: [fileA, { ...fileB, file_name: "PARCIAL-1.pdf" }] }));
        expect(dup.message).toContain("Dos archivos se llaman");
    });

    it("si los bytes guardados vencieron, la ejecución es PLAN_STALE y no sube nada", async () => {
        const { h, uploaded } = await harness();
        const p = await plan(h, { type: "resource", name: "Parcial 1", files: [fileA] });
        for (const f of readdirSync(join(h.dir, "blobs"))) rmSync(join(h.dir, "blobs", f));
        expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
        expect(uploaded).toHaveLength(0);
    });

    it("rechazos: rutas locales en el remoto (el mensaje indica files), files y file_path juntos, recurso con dos archivos, files en otro tipo", async () => {
        const { h } = await harness();
        const local = await errOf(plan(h, { type: "resource", name: "X", file_path: "C:/x.pdf" }));
        expect(local.message).toContain("Pasá los archivos en files");
        const local2 = await harness(false);
        expect((await errOf(plan(local2.h, { type: "resource", name: "X", file_path: "C:/no-existe.pdf", files: [fileA] }))).message).toContain("no los dos");
        expect((await errOf(plan(h, { type: "resource", name: "X", files: [fileA, fileB] }))).message).toContain("exactamente un archivo");
        expect((await errOf(plan(h, { type: "page", name: "X", content: "a", files: [fileA] }))).message).toContain("no corresponde: files");
    });

    it("la herramienta declara openai/fileParams y el esquema de archivo que pide OpenAI", async () => {
        const { h } = await harness();
        const client = await connectWrite(h);
        const { tools } = await client.listTools();
        const create = tools.find((t) => t.name === "campus_plan_create_content")!;
        const files = tools.find((t) => t.name === "campus_plan_activity_files")!;
        expect(create._meta).toEqual({ "openai/fileParams": ["files"] });
        expect(files._meta).toEqual({ "openai/fileParams": ["add_files"] });
        expect(tools.find((t) => t.name === "campus_plan_announcement")?._meta).toBeUndefined();
        // Forma documentada por OpenAI: $defs y #/$defs/…, objeto cerrado (con definitions, ChatGPT mandó cadenas).
        for (const [tool, field] of [[create, "files"], [files, "add_files"]] as const) {
            const schema = tool.inputSchema as { properties: Record<string, { items?: { $ref?: string } }>; definitions?: unknown; $defs?: Record<string, { required: string[]; properties: Record<string, unknown>; additionalProperties?: boolean }> };
            expect(schema.definitions).toBeUndefined();
            expect(schema.properties[field]!.items!.$ref).toBe("#/$defs/ChatFile");
            const def = schema.$defs!.ChatFile!;
            expect(Object.keys(def.properties).sort()).toEqual(["download_url", "file_id", "file_name", "mime_type"]);
            expect(def.required.sort()).toEqual(["download_url", "file_id"]);
            expect(def.additionalProperties).toBe(false);
        }
        // Las demás herramientas no cambian, y la llamada sigue validándose con el esquema de zod.
        expect((tools.find((t) => t.name === "campus_plan_announcement")!.inputSchema as { $defs?: unknown }).$defs).toBeUndefined();
    });
});
