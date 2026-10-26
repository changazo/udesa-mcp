import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildCapabilityReport, ContextCheckRecorder } from "../../src/capabilities/report.js";
import { packageRoot } from "../../src/config/profile.js";
import { SiteInfoSchema } from "../../src/moodle/schemas.js";
import { syntheticProfile } from "../fixtures/fake-moodle.js";

const schema = JSON.parse(readFileSync(join(packageRoot(), "schemas", "capability-report.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validate = ajv.compile(schema);

const rawSiteInfo = {
    sitename: "Campus Sintético",
    username: "docente",
    fullname: "Docente Sintético",
    userid: 501,
    siteurl: "https://campus.example.test",
    release: "4.5+",
    version: "2024100700",
    userprivateaccesskey: "PRIVADA",
    downloadfiles: 1,
    uploadfiles: 0,
    functions: [
        { name: "core_webservice_get_site_info", version: "2024100700" },
        { name: "core_course_get_contents", version: "2024100700" },
        { name: "mod_forum_get_forums_by_courses", version: "2024100700" },
        { name: "mod_forum_get_forum_discussions", version: "2024100700" },
        { name: "mod_forum_add_discussion", version: "2024100700" },
    ],
};

describe("capacidades", () => {
    const profile = syntheticProfile();

    it("CAP-01: la proyección de get_site_info excluye credenciales e identificadores de login", () => {
        const info = SiteInfoSchema.parse(rawSiteInfo);
        const text = JSON.stringify(info);
        expect(text).not.toContain("PRIVADA");
        expect(text).not.toContain("userprivateaccesskey");
        expect(text).not.toContain("username");
        // ADR-124: el nombre sí se proyecta (en memoria), para mostrarlo en lo propio.
        expect(info.fullname).toBe("Docente Sintético");
    });

    it("CAP-01 (ADR-124): el reporte de capacidades no lleva el nombre ni credenciales de la cuenta", () => {
        const site = { info: SiteInfoSchema.parse(rawSiteInfo), verified_at: "2026-10-18T12:00:00.000Z" };
        const text = JSON.stringify(buildCapabilityReport(profile, site, new ContextCheckRecorder()));
        expect(text).not.toContain("Docente Sintético");
        expect(text).not.toContain("PRIVADA");
        expect(text).not.toContain("username");
    });

    it("el reporte sin sesión es válido contra el esquema y todo queda unknown/not_tested", () => {
        const r = buildCapabilityReport(profile, null, null);
        expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
        expect(r.report_kind).toBe("template_not_tested");
        expect(r.service_function_inventory.status).toBe("unknown");
        expect(r.capabilities.every((c) => c.service_listing === "unknown" && c.context_check.status === "not_tested")).toBe(true);
    });

    it("compuesta: listed sólo si están todas sus funciones; flags para archivos", () => {
        const site = { info: SiteInfoSchema.parse(rawSiteInfo), verified_at: "2026-10-18T12:00:00.000Z" };
        const r = buildCapabilityReport(profile, site, new ContextCheckRecorder());
        expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
        const get = (n: string) => r.capabilities.find((c) => c.name === n)!;
        expect(get("read_course").service_listing).toBe("listed");
        expect(get("read_forums").service_listing).toBe("not_listed"); // falta get_discussion_posts
        expect(get("read_files").service_listing).toBe("listed");
        expect(get("upload_files").service_listing).toBe("not_listed");
        expect(r.service_function_inventory.functions).toHaveLength(5);
        expect(JSON.stringify(r)).not.toContain("docente");
    });

    it("CAP-03: una escritura listada queda not_tested y bloqueada aunque se intente registrar", () => {
        const site = { info: SiteInfoSchema.parse(rawSiteInfo), verified_at: "2026-10-18T12:00:00.000Z" };
        const rec = new ContextCheckRecorder();
        rec.record("post_announcement", "allowed", 4242);
        rec.record("read_course", "denied", 4242, "MOODLE_PERMISSION_DENIED");
        const r = buildCapabilityReport(profile, site, rec);
        const post = r.capabilities.find((c) => c.name === "post_announcement")!;
        expect(post.service_listing).toBe("listed");
        expect(post.local_policy).toBe("blocked");
        expect(post.context_check.status).toBe("not_tested");
        // CAP-02: listada + denegada ≠ inexistente
        const course = r.capabilities.find((c) => c.name === "read_course")!;
        expect(course.service_listing).toBe("listed");
        expect(course.context_check.status).toBe("denied");
        expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
    });

    it("la plantilla del hand-off sigue validando contra el esquema copiado", () => {
        const tpl = JSON.parse(readFileSync(join(packageRoot(), "tests", "fixtures", "handoff", "capability-report.example.json"), "utf8"));
        expect(validate(tpl)).toBe(true);
    });
});

describe("observaciones por contexto (§13)", () => {
    const profile = syntheticProfile();
    it("la prueba en un curso no pisa la de otro; capacidades web y bloqueadas quedan declaradas", () => {
        const site = { info: SiteInfoSchema.parse(rawSiteInfo), verified_at: "2026-10-18T12:00:00.000Z" };
        const rec = new ContextCheckRecorder();
        rec.record("read_course", "allowed", 4242);
        rec.record("read_course", "denied", 5555, "MOODLE_PERMISSION_DENIED");
        rec.record("read_quiz_statistics", "allowed", 4242); // bloqueada: no se registra
        const r = buildCapabilityReport(profile, site, rec);
        expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
        const get = (n: string) => r.capabilities.find((c) => c.name === n)!;
        expect(get("read_course").context_checks!.map((c) => [c.course_id, c.status])).toEqual([
            [4242, "allowed"],
            [5555, "denied"],
        ]);
        expect(get("read_course").context_check.course_id).toBe(5555);
        expect(get("read_quiz_structure")).toMatchObject({ transport: "web", service_listing: "unknown" });
        expect(get("read_quiz_statistics")).toMatchObject({ local_policy: "blocked", implementation: "not_implemented" });
        expect(get("read_quiz_statistics").context_check.status).toBe("not_tested");
        expect(get("read_grade_tree").local_policy).toBe("blocked");
    });
});
