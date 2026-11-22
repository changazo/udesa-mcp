import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { checkWriteForm } from "../../src/write/functions.js";
import { parseLocalDateTime } from "../../src/write/local-time.js";
import { COURSE, NOW_UNIX } from "../fixtures/fake-moodle.js";
import { D_STUDENT, D_WELCOME, F_NEWS, F_QA, P_WELCOME } from "../fixtures/fake-forum.js";
import { makeWriteHarness, type WriteHarness } from "../fixtures/write-harness.js";

/**
 * ADR-143: período de visualización y «enviar sin demora» en foros. Todo contra el Moodle sintético:
 * reloj fijo (NOW_UNIX = 2026-09-21 11:13 en Buenos Aires) y zona del perfil America/Argentina/Buenos_Aires.
 */

const W1 = ["post_announcement", "reply_forum", "edit_own_post", "pin_lock_discussion"];
const TZ = "America/Argentina/Buenos_Aires";
const harness = (policy: Record<string, unknown> = {}) => makeWriteHarness({ policy: { courses: { [String(COURSE)]: W1 }, allow_participant_notifications: true, ...policy } });
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string, words?: string) => h.app.engine.execute(id, h.confirmer, "test", words ? { userWords: words } : {});
const restAdds = (h: WriteHarness) => h.fake.callsOf("mod_forum_add_discussion").length;
const formPosts = (h: WriteHarness) => h.forums.formPosts.length;
const unix = (local: string) => parseLocalDateTime(local, TZ, "t").unix;

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

function files(...specs: [string, string][]) {
    const dir = mkdtempSync(join(tmpdir(), "campus-period-"));
    return specs.map(([name, content]) => {
        const p = join(dir, name);
        writeFileSync(p, content);
        return p;
    });
}

describe("fechas locales (ADR-143)", () => {
    it("formato exacto, calendario real, rango del selector y zona del perfil (no la del proceso)", () => {
        const d = parseLocalDateTime("2026-09-25T10:00", TZ, "x");
        expect(d.utc).toBe("2026-09-25T13:00:00.000Z");
        expect(d.parts).toEqual({ day: 25, month: 9, year: 2026, hour: 10, minute: 0 });
        for (const bad of ["2026-02-30T10:00", "2026-13-01T10:00", "2026-09-25T24:00", "2026-09-25T10:60", "2026-09-25 10:00", "2026-09-25T10:00Z", "2026-09-25T10:00-03:00", "25/09/2026 10:00", "1999-12-31T23:59", "2051-01-01T00:00"]) {
            expect(() => parseLocalDateTime(bad, TZ, "x"), bad).toThrow(CampusError);
        }
        expect(parseLocalDateTime("2028-02-29T00:00", TZ, "x").parts.day).toBe(29);
    });
});

describe("aviso con período y «enviar sin demora» (ADR-143)", () => {
    it("sin los campos nuevos (o con null/false): el mismo camino REST de siempre, sin formulario", async () => {
        const h = await harness();
        const p = await plan(h, "announcement", { forum_id: F_QA, subject: "Normal", message: "Texto", display_start: null, display_end: null, notify_without_edit_delay: false });
        expect(p.items[0]!.function).toBe("mod_forum_add_discussion");
        expect((p.payload_preview as Record<string, unknown>).transport).toMatch(/servicio web/);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(restAdds(h)).toBe(1);
        expect(formPosts(h)).toBe(0);
    });

    it("sólo inicio futuro: un único formulario crea la discusión ya programada; la relectura verifica el instante", async () => {
        const h = await harness();
        const p = await plan(h, "announcement", { forum_id: F_QA, subject: "Programado", message: "Sale el viernes", display_start: "2026-09-25T10:00" });
        expect(p.items[0]!.function).toBe("forum_post_create_advanced");
        const pv = p.payload_preview as { display_start: { local: string; utc: string }; display_end: string; notify_without_edit_delay: boolean };
        expect(pv.display_start).toMatchObject({ local: "2026-09-25T10:00", utc: "2026-09-25T13:00:00.000Z" });
        expect(pv.display_end).toBe("sin fin");
        expect(pv.notify_without_edit_delay).toBe(false);
        expect(p.warnings.join(" ")).toMatch(/no ven la discusión hasta el 2026-09-25T10:00/);
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(restAdds(h)).toBe(0);
        expect(formPosts(h)).toBe(1);
        const body = h.forums.formPosts[0]!;
        expect(body.get("timestart[enabled]")).toBe("1");
        expect(body.has("timeend[enabled]")).toBe(false); // casilla desmarcada: se omite, como el navegador
        expect(body.has("mailnow")).toBe(false);
        expect(body.get("groupid")).toBe("0"); // foro sin grupos: todos
        const d = h.forums.discussions.get(r.moodle_ids.discussion_id![0]!)!;
        expect(d.timestart).toBe(unix("2026-09-25T10:00"));
        expect(d.timeend).toBe(0);
    });

    it("sólo fin, ambos y validación del par antes de escribir", async () => {
        const h = await harness();
        const onlyEnd = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Hasta", message: "x", display_end: "2026-10-01T18:30" })).plan_id);
        expect(onlyEnd.status).toBe("aplicado_verificado");
        expect(h.forums.discussions.get(onlyEnd.moodle_ids.discussion_id![0]!)).toMatchObject({ timestart: 0, timeend: unix("2026-10-01T18:30") });
        const both = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Ventana", message: "x", display_start: "2026-09-22T08:00", display_end: "2026-09-29T08:00" })).plan_id);
        expect(h.forums.discussions.get(both.moodle_ids.discussion_id![0]!)).toMatchObject({ timestart: unix("2026-09-22T08:00"), timeend: unix("2026-09-29T08:00") });
        const before = formPosts(h);
        expect((await errOf(plan(h, "announcement", { forum_id: F_QA, subject: "Mal", message: "x", display_start: "2026-09-29T08:00", display_end: "2026-09-29T08:00" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "announcement", { forum_id: F_QA, subject: "Mal", message: "x", display_start: "2026-02-31T08:00" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect(formPosts(h)).toBe(before);
    });

    it("sin timed posts en el sitio (o sin viewhiddentimedposts): rechazo sin POST; nunca se publica visible en su lugar", async () => {
        const h = await harness();
        h.forums.timedPosts = false;
        const p = await plan(h, "announcement", { forum_id: F_QA, subject: "Sin período", message: "x", display_start: "2026-09-25T10:00" });
        const r = await exec(h, p.plan_id);
        expect(r.status).not.toBe("aplicado_verificado");
        expect(formPosts(h)).toBe(0);
        expect(restAdds(h)).toBe(0);
        expect([...h.forums.discussions.values()].some((d) => d.name === "Sin período")).toBe(false);
    });

    it("«enviar sin demora»: mailnow nativo sólo con true; R3 aun en el sandbox; deshacer no promete evitar el correo", async () => {
        const h = await harness();
        const p = await plan(h, "announcement", { forum_id: F_QA, subject: "Urgente", message: "Se suspende la clase", notify_without_edit_delay: true });
        expect(p.risk).toBe("R3");
        expect(p.undo.kind).toBe("compensación");
        expect(p.undo.how).toMatch(/NO evita el correo/);
        expect((p.payload_preview as Record<string, string>).send_now).toMatch(/No es entrega garantizada/);
        const r = await exec(h, p.plan_id, "Sí, publicalo");
        expect(r.status).toBe("aplicado_verificado");
        expect(h.forums.formPosts[0]!.get("mailnow")).toBe("1");
        const id = r.moodle_ids.discussion_id![0]!;
        expect(h.forums.posts.get(h.forums.discussions.get(id)!.firstpost)!.mailnow).toBe(1);
        expect(r.undo.until).toBeNull(); // con mailnow no hay ventana sin correo
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error("debería poder borrarse");
        expect(u.plan.summary).toMatch(/borrar NO evita el correo/);
    });

    it("«enviar sin demora» sin la casilla ofrecida (sin manageactivities): rechazo, nunca un aviso normal", async () => {
        const h = await harness();
        h.forums.canMailnow = false;
        const p = await plan(h, "announcement", { forum_id: F_QA, subject: "Sin mailnow", message: "x", notify_without_edit_delay: true });
        const r = await exec(h, p.plan_id, "sí");
        expect(r.status).not.toBe("aplicado_verificado");
        expect(formPosts(h)).toBe(0);
        expect(restAdds(h)).toBe(0);
    });

    it("inicio futuro + «enviar sin demora»: rechazado en el plan hasta validarlo en real", async () => {
        const h = await harness();
        const e = await errOf(plan(h, "announcement", { forum_id: F_QA, subject: "Combo", message: "x", display_start: "2026-09-25T10:00", notify_without_edit_delay: true }));
        expect(e.code).toBe("WRITE_NOT_ALLOWED");
        expect(e.message).toMatch(/validarlo en real/);
    });

    it("la guarda de no notificar sigue valiendo: sin allow_participant_notifications, un foro forzado se rechaza aunque sea programado o sin demora", async () => {
        const h = await harness({ allow_participant_notifications: false });
        for (const extra of [{ display_start: "2026-09-25T10:00" }, { notify_without_edit_delay: true }]) {
            expect((await errOf(plan(h, "announcement", { forum_id: F_NEWS, subject: "Forzado", message: "x", ...extra }))).code).toBe("WRITE_NOT_ALLOWED");
        }
    });

    it("grupos, fijado, suscripción y adjuntos se conservan por el formulario", async () => {
        const h = await harness();
        const [a] = files(["guia.pdf", "contenido"]);
        const p = await plan(h, "announcement", { forum_id: F_QA, subject: "Grupo A", message: "Sólo grupo A", group_id: 12, pin: true, subscribe: true, display_end: "2026-10-30T12:00", attachments: [a!] });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const body = h.forums.formPosts[0]!;
        expect(body.get("groupinfo")).toBe("12");
        expect(body.get("pinned")).toBe("1");
        expect(body.get("discussionsubscribe")).toBe("1");
        const d = h.forums.discussions.get(r.moodle_ids.discussion_id![0]!)!;
        expect(d).toMatchObject({ groupid: 12, pinned: true });
        expect(h.forums.posts.get(d.firstpost)!.attachments).toEqual([{ filename: "guia.pdf", filesize: 9 }]);
        expect(h.forums.subscribed.get(d.id)).toBe(true);
        // Por defecto (subscribe ausente) la casilla que Moodle sirve marcada se desmarca.
        const off = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Sin suscripción", message: "x", group_id: -1, display_end: "2026-10-30T12:00" })).plan_id);
        expect(h.forums.formPosts[1]!.has("discussionsubscribe")).toBe(false);
        expect(h.forums.formPosts[1]!.get("groupinfo")).toBe("-1");
        expect(h.forums.subscribed.get(off.moodle_ids.discussion_id![0]!)).toBe(false);
    });

    it("validación del formulario (200 con errores): rechazo sin publicar; corte después del POST: se reconcilia sin repetir", async () => {
        const h = await harness();
        h.forums.formError = "Error de validación";
        const bad = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Rechazado", message: "x", display_end: "2026-10-30T12:00" })).plan_id);
        expect(bad.status).toBe("rechazado_por_moodle");
        h.forums.formError = null;
        h.forums.formNetworkAfter = true;
        const cut = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Cortado", message: "Único", display_end: "2026-10-30T12:00" })).plan_id);
        expect(cut.status).toBe("aplicado_verificado");
        expect([...h.forums.discussions.values()].filter((d) => d.name === "Cortado")).toHaveLength(1);
        expect(h.forums.formPosts.filter((b) => b.get("subject") === "Cortado")).toHaveLength(1);
    });

    it("dos discusiones idénticas en la ventana: la verificación no adivina cuál es (desconocido, sin reintentar)", async () => {
        const h = await harness();
        const first = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Gemela", message: "Igual", display_end: "2026-10-30T12:00" })).plan_id);
        expect(first.status).toBe("aplicado_verificado");
        const second = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Gemela", message: "Igual", display_end: "2026-10-30T12:00" })).plan_id);
        expect(second.status).not.toBe("aplicado_verificado");
        expect(h.forums.formPosts.filter((b) => b.get("subject") === "Gemela")).toHaveLength(2);
    });

    it("seguridad: el plan no admite campos, rutas ni sesskey ajenos", () => {
        expect(() => checkWriteForm("forum_post_create_advanced", { subject: "a", "message[text]": "b", "message[format]": "1", discussionsubscribe: "0", pinned: "0", mailnow: "0", "timestart[enabled]": "0", "timeend[enabled]": "0", sesskey: "x" })).toThrow(/sesskey/);
        expect(() => checkWriteForm("forum_post_create_advanced", { subject: "a", "message[text]": "b", "message[format]": "1", discussionsubscribe: "0", pinned: "0", mailnow: "0", "timestart[enabled]": "0", "timeend[enabled]": "0", forum: "1" })).toThrow(/allowlist/);
        expect(() => checkWriteForm("forum_post_edit_display_period", { "timestart[enabled]": "1", "timeend[enabled]": "0", mailnow: "1" })).toThrow(/allowlist/);
        expect(() => checkWriteForm("forum_post_create_advanced", { subject: "a", "message[text]": "b", "message[format]": "1", discussionsubscribe: "0", pinned: "0", mailnow: "0", "timestart[enabled]": "1", "timestart[year]": "1990", "timeend[enabled]": "0" })).toThrow(/inválido/);
    });
});

describe("respuesta con «enviar sin demora» (ADR-143)", () => {
    it("pública: formulario nativo con mailnow; privada: casilla nativa verificada al releer, nunca pública", async () => {
        const h = await harness();
        const pub = await plan(h, "forum_reply", { discussion_id: D_STUDENT, message: "Respuesta rápida", notify_without_edit_delay: true });
        expect(pub.items[0]!.function).toBe("forum_post_reply_advanced");
        expect(pub.risk).toBe("R3");
        const r = await exec(h, pub.plan_id, "sí");
        expect(r.status).toBe("aplicado_verificado");
        expect(h.forums.formPosts[0]!.get("mailnow")).toBe("1");
        expect(h.forums.posts.get(r.moodle_ids.post_id![0]!)!.privatereplyto).toBe(0);
        const priv = await exec(h, (await plan(h, "forum_reply", { discussion_id: D_STUDENT, message: "Privada rápida", private: true, notify_without_edit_delay: true })).plan_id, "sí");
        expect(priv.status).toBe("aplicado_verificado");
        expect(h.forums.posts.get(priv.moodle_ids.post_id![0]!)!.privatereplyto).toBeGreaterThan(0);
    });

    it("sin la casilla privada ofrecida: rechazo (no se publica en abierto); sin notificación rápida, REST de siempre", async () => {
        const h = await harness();
        const p = await plan(h, "forum_reply", { discussion_id: D_STUDENT, message: "Privada", private: true, notify_without_edit_delay: true });
        h.forums.canPrivate = false; // el formulario deja de ofrecerla entre el plan y la ejecución
        const r = await exec(h, p.plan_id, "sí");
        expect(r.status).not.toBe("aplicado_verificado");
        expect(h.forums.formPosts).toHaveLength(0);
        h.forums.canPrivate = true;
        const normal = await plan(h, "forum_reply", { discussion_id: D_STUDENT, message: "Normal" });
        expect(normal.items[0]!.function).toBe("mod_forum_add_discussion_post");
    });
});

describe("período de una discusión existente (ADR-143)", () => {
    async function scheduled(h: WriteHarness) {
        const r = await exec(h, (await plan(h, "announcement", { forum_id: F_QA, subject: "Para editar", message: "Contenido", pin: true, display_start: "2026-09-25T10:00", display_end: "2026-10-05T10:00", attachments: files(["a.txt", "uno"]) })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        return r.moodle_ids.discussion_id![0]!;
    }

    it("editar sólo el inicio preserva el fin; null quita un extremo; el resto del post no cambia", async () => {
        const h = await harness();
        const id = await scheduled(h);
        const p = await plan(h, "forum_display_period", { discussion_id: id, display_start: "2026-09-23T09:00" });
        expect(p.risk).toBe("R2");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const d = h.forums.discussions.get(id)!;
        expect(d).toMatchObject({ timestart: unix("2026-09-23T09:00"), timeend: unix("2026-10-05T10:00"), pinned: true });
        const body = h.forums.formPosts.at(-1)!;
        expect(body.has("mailnow")).toBe(false); // editar nunca reenvía
        const post = h.forums.posts.get(d.firstpost)!;
        expect(post.attachments).toEqual([{ filename: "a.txt", filesize: 3 }]);
        expect(post.message).toBe("<p>Contenido</p>");
        const r2 = await exec(h, (await plan(h, "forum_display_period", { discussion_id: id, display_end: null })).plan_id);
        expect(r2.status).toBe("aplicado_verificado");
        expect(h.forums.discussions.get(id)).toMatchObject({ timestart: unix("2026-09-23T09:00"), timeend: 0 });
        expect(h.forums.formPosts.at(-1)!.has("timeend[enabled]")).toBe(false);
    });

    it("sin cambios, par inválido resultante o discusión ajena: rechazo antes de escribir", async () => {
        const h = await harness();
        const id = await scheduled(h);
        const before = formPosts(h);
        expect((await errOf(plan(h, "forum_display_period", { discussion_id: id }))).message).toMatch(/Sin cambios/);
        expect((await errOf(plan(h, "forum_display_period", { discussion_id: id, display_start: "2026-09-25T10:00" }))).message).toMatch(/Sin cambios/);
        expect((await errOf(plan(h, "forum_display_period", { discussion_id: id, display_start: "2026-10-06T10:00" }))).message).toMatch(/fin tiene que ser posterior/);
        expect((await errOf(plan(h, "forum_display_period", { discussion_id: D_STUDENT, display_end: "2026-10-06T10:00" }))).message).toMatch(/publicaste vos/);
        expect((await errOf(plan(h, "forum_display_period", { discussion_id: 999_999, display_end: "2026-10-06T10:00" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(formPosts(h)).toBe(before);
    });

    it("deshacer restaura el período anterior; si alguien lo cambió después, no lo pisa", async () => {
        const h = await harness();
        const id = await scheduled(h);
        const r = await exec(h, (await plan(h, "forum_display_period", { discussion_id: id, display_start: null })).plan_id);
        expect(h.forums.discussions.get(id)!.timestart).toBe(0);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error("debería poder deshacerse");
        expect(u.plan.summary).toMatch(/Deshacer: restaurar/);
        const r2 = await exec(h, u.plan.plan_id);
        expect(r2.status).toBe("aplicado_verificado");
        expect(h.forums.discussions.get(id)).toMatchObject({ timestart: unix("2026-09-25T10:00"), timeend: unix("2026-10-05T10:00") });
        // Otro cambio por fuera después de la acción: el deshacer no se ofrece.
        const r3 = await exec(h, (await plan(h, "forum_display_period", { discussion_id: id, display_end: "2026-10-10T10:00" })).plan_id);
        h.forums.discussions.get(id)!.timeend = unix("2026-10-20T10:00");
        const u3 = await h.app.engine.planUndo(r3.action_id, "test");
        expect(u3.undoable).toBe(false);
    });

    it("cambio concurrente entre el plan y la ejecución: el plan queda obsoleto y no escribe", async () => {
        const h = await harness();
        const id = await scheduled(h);
        const p = await plan(h, "forum_display_period", { discussion_id: id, display_end: "2026-10-10T10:00" });
        h.forums.discussions.get(id)!.timeend = unix("2026-10-12T10:00");
        const before = formPosts(h);
        const e = await errOf(exec(h, p.plan_id));
        expect(e.code).toBe("PLAN_STALE");
        expect(formPosts(h)).toBe(before);
    });

    it("sin timed posts: rechazo sin POST", async () => {
        const h = await harness();
        const id = await scheduled(h);
        h.forums.timedPosts = false;
        const before = formPosts(h);
        const r = await exec(h, (await plan(h, "forum_display_period", { discussion_id: id, display_end: "2026-10-10T10:00" })).plan_id);
        expect(r.status).not.toBe("aplicado_verificado");
        expect(formPosts(h)).toBe(before);
    });

    it("la discusión histórica de bienvenida (sin período) acepta programarse; el reloj del plan es el del motor", async () => {
        const h = await harness();
        const p = await plan(h, "forum_display_period", { discussion_id: D_WELCOME, display_end: "2026-12-01T00:00" });
        expect((p.payload_preview as { before: { display_start: string } }).before.display_start).toBe("sin inicio");
        expect((p.payload_preview as { visible_now: { before: boolean; after: boolean } }).visible_now).toEqual({ before: true, after: true });
        expect(NOW_UNIX).toBeLessThan(unix("2026-12-01T00:00"));
        void P_WELCOME;
    });
});
