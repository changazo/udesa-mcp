import { describe, expect, it } from "vitest";
import { CampusError } from "../../src/errors.js";
import { resultError } from "../../src/write/engine.js";
import { COURSE, INJECTION } from "../fixtures/fake-moodle.js";
import { D_OTHER, D_STUDENT, D_WELCOME, F_NEWS, F_QA, GROUP_A, P_PRIVATE, P_STUDENT, P_STUDENT_REPLY, P_WELCOME } from "../fixtures/fake-forum.js";
import { connectWrite, makeWriteHarness, parseTool, type WriteHarness } from "../fixtures/write-harness.js";

const W1 = ["post_announcement", "reply_forum", "edit_own_post", "pin_lock_discussion"];
const harness = (policy: Record<string, unknown> = {}) => makeWriteHarness({ policy: { courses: { [String(COURSE)]: W1 }, allow_participant_notifications: true, ...policy } });
const plan = (h: WriteHarness, intent: string, input: Record<string, unknown>) => h.app.engine.plan(intent, { course_id: COURSE, ...input }, "test");
const exec = (h: WriteHarness, id: string) => h.app.engine.execute(id, h.confirmer, "test");
const calls = (h: WriteHarness, fn: string) => h.fake.callsOf(fn);
const writes = (h: WriteHarness) => h.fake.calls.filter((c) => /^mod_forum_(add|update|delete|set)_/.test(c.fn)).length;

async function errOf(p: Promise<unknown>): Promise<CampusError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof CampusError) return e;
        throw e;
    }
    throw new Error("se esperaba un error");
}

describe("W1 · aviso (§8.1)", () => {
    it("plan con valores por defecto visibles: HTML convertido, todos (-1), sin fijar, suscripción forzada y destinatarios", async () => {
        const h = await harness();
        const p = await plan(h, "announcement", { subject: "Entrega del TP2", message: "Hola:\n\nLa entrega es el **viernes**.\n\n- Subir PDF\n- Con nombre" });
        expect(writes(h)).toBe(0);
        expect(p.risk).toBe("R2");
        expect(p.confirmation.channel).toBe("fuera_de_banda");
        const pv = p.payload_preview as Record<string, unknown>;
        expect(pv.message_html).toBe("<p>Hola:</p>\n<p>La entrega es el <strong>viernes</strong>.</p>\n<ul><li>Subir PDF</li><li>Con nombre</li></ul>");
        expect(pv.group).toBe("todos (groupid -1)");
        expect(pv.pinned).toBe(false);
        expect(pv.possible_recipients).toBe(9);
        expect((pv.forum as { subscription: string }).subscription).toBe("forzada");
        expect(p.warnings.join(" ")).toMatch(/suscripción forzada: los 9 participantes/);
        expect(p.items[0]!.function).toBe("mod_forum_add_discussion");
    });

    it("ejecución verificada con groupid -1 y opciones explícitas; deshacer borra la discusión dentro de la ventana", async () => {
        const h = await harness();
        const p = await plan(h, "announcement", { subject: "Aviso de prueba", message: "Texto" });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const call = calls(h, "mod_forum_add_discussion")[0]!.params;
        expect(call.groupid).toBe("-1");
        // ADR-098: por defecto, quien publica NO queda suscripto (no le llegan los correos).
        expect(call).toMatchObject({ "options[0][name]": "discussionsubscribe", "options[0][value]": "0", "options[1][name]": "discussionpinned", "options[1][value]": "0" });
        const discussionId = r.moodle_ids.discussion_id![0]!;
        expect(r.moodle_ids.post_id).toHaveLength(1);
        expect(r.undo.until).toMatch(/^\d{4}-/);
        expect(h.forums.discussions.has(discussionId)).toBe(true);

        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error("debería poder deshacerse");
        expect(u.plan.items[0]!.function).toBe("mod_forum_delete_post");
        expect(u.plan.warnings.join(" ")).toMatch(/Ventana de deshacer hasta/);
        const r2 = await exec(h, u.plan.plan_id);
        expect(r2.status).toBe("aplicado_verificado");
        expect(h.forums.discussions.has(discussionId)).toBe(false);
    });

    it("suscripción del autor (ADR-098): por defecto no queda suscripto; con subscribe=true sí; la respuesta igual", async () => {
        const h = await harness();
        const off = await exec(h, (await plan(h, "announcement", { subject: "a", message: "b", forum_id: F_QA })).plan_id);
        expect(h.forums.subscribed.get(off.moodle_ids.discussion_id![0]!)).toBe(false);
        const on = await exec(h, (await plan(h, "announcement", { subject: "c", message: "d", forum_id: F_QA, subscribe: true })).plan_id);
        expect(h.forums.subscribed.get(on.moodle_ids.discussion_id![0]!)).toBe(true);
        const p = await plan(h, "forum_reply", { discussion_id: D_STUDENT, message: "Hola" });
        expect(p.payload_preview).toMatchObject({ discussion_subscribe: false });
        expect(p.side_effects.join(" ")).toMatch(/No quedás suscripto/);
    });

    it("asunto de 256 caracteres: rechazado en el plan, sin escribir", async () => {
        const h = await harness();
        const e = await errOf(plan(h, "announcement", { subject: "x".repeat(256), message: "Texto" }));
        expect(e.code).toBe("POLICY_DENIED");
        expect(writes(h)).toBe(0);
    });

    it("grupos: foro sin grupos rechaza un grupo; con grupos sólo uno permitido; 0 nunca se envía", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "announcement", { subject: "a", message: "b", group_id: GROUP_A }))).code).toBe("WRITE_NOT_ALLOWED");
        const ok = await plan(h, "announcement", { subject: "a", message: "b", forum_id: F_QA, group_id: GROUP_A });
        expect(ok.items[0]!.expected.groupid).toBe(GROUP_A);
        expect((await errOf(plan(h, "announcement", { subject: "a", message: "b", forum_id: F_QA, group_id: 99 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        const zero = await plan(h, "announcement", { subject: "a", message: "b", forum_id: F_QA, group_id: 0 });
        expect(zero.items[0]!.expected.groupid).toBe(-1);
    });

    it("fijar sin la capacidad se rechaza en el plan (Moodle lo ignoraría en silencio); si igual lo ignora, la verificación lo detecta", async () => {
        const h = await harness();
        h.forums.canPin = false;
        expect((await errOf(plan(h, "announcement", { subject: "a", message: "b", pin: true }))).code).toBe("MOODLE_PERMISSION_DENIED");
        h.forums.canPin = true;
        h.forums.pinIgnored = true;
        const p = await plan(h, "announcement", { subject: "fijado", message: "b", pin: true });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_con_diferencias");
        expect(r.differences).toEqual([{ item_id: "i1", field: "pinned", expected: true, observed: false }]);
    });

    it("sin permiso de publicar (chequeo previo, sin escribir) y foro de otro curso", async () => {
        const h = await harness();
        h.forums.canAdd = false;
        expect((await errOf(plan(h, "announcement", { subject: "a", message: "b" }))).code).toBe("MOODLE_PERMISSION_DENIED");
        h.forums.canAdd = true;
        expect((await errOf(plan(h, "announcement", { subject: "a", message: "b", forum_id: 3999 }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(writes(h)).toBe(0);
    });

    it("fallas: avisos de Moodle → rechazado; respuesta «exitosa» sin discusión creada → sin_efecto", async () => {
        const h = await harness();
        h.forums.next("warnings");
        const a = await exec(h, (await plan(h, "announcement", { subject: "a1", message: "b" })).plan_id);
        expect(resultError(a)?.code).toBe("MOODLE_REJECTED");
        h.forums.next("noop");
        const b = await exec(h, (await plan(h, "announcement", { subject: "a2", message: "b" })).plan_id);
        expect(b.status).toBe("sin_efecto");
    });

    it("corte de red después de publicar: se encuentra por asunto y autor, sin duplicar", async () => {
        const h = await harness();
        h.forums.next("network_after");
        const r = await exec(h, (await plan(h, "announcement", { subject: "Único", message: "b" })).plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(calls(h, "mod_forum_add_discussion")).toHaveLength(1);
        expect([...h.forums.discussions.values()].filter((d) => d.name === "Único")).toHaveLength(1);
        expect(r.moodle_ids.discussion_id).toHaveLength(1);
    });

    it("curso real con suscripción forzada: R3 (con la capacidad habilitada hace más de dos semanas)", async () => {
        const h = await harness({ sandbox_course_ids: [], courses: { [String(COURSE)]: [{ capability: "post_announcement", enabled_on: "2020-01-01" }] } });
        expect((await plan(h, "announcement", { subject: "a", message: "b" })).risk).toBe("R3");
    });

    it("curso real con suscripción forzada: una respuesta también es R3, porque le llega a todos (ADR-130)", async () => {
        const h = await harness({ sandbox_course_ids: [], courses: { [String(COURSE)]: ["reply_forum"] } });
        const p = await plan(h, "forum_reply", { discussion_id: D_WELCOME, message: "Gracias" });
        expect(p.risk).toBe("R3");
        expect(p.warnings[0]).toContain("suscripción forzada");
    });
});

describe("W1 · respuesta (§8.1)", () => {
    it("responde al primer post por defecto, verifica padre y texto, y se deshace borrando la respuesta", async () => {
        const h = await harness();
        const p = await plan(h, "forum_reply", { discussion_id: D_WELCOME, message: "Gracias a todos" });
        expect(p.items[0]!.target.parent_id).toBe(P_WELCOME);
        expect((p.payload_preview as { subject: string }).subject).toBe("Re: Bienvenida");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        const postId = r.moodle_ids.post_id![0]!;
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error("debería poder deshacerse");
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(h.forums.posts.has(postId)).toBe(false);
        expect(h.forums.posts.has(P_WELCOME)).toBe(true);
    });

    it("privada sin capacidad: rechazada en el plan (Moodle la publicaría en abierto); si igual sale pública, se detecta", async () => {
        const h = await harness();
        h.forums.canPrivate = false;
        expect((await errOf(plan(h, "forum_reply", { discussion_id: D_WELCOME, reply_to_post_id: P_STUDENT_REPLY, message: "x", private: true }))).code).toBe("MOODLE_PERMISSION_DENIED");
        h.forums.canPrivate = true;
        h.forums.privateDowngraded = true;
        const r = await exec(h, (await plan(h, "forum_reply", { discussion_id: D_WELCOME, reply_to_post_id: P_STUDENT_REPLY, message: "sólo para vos", private: true })).plan_id);
        expect(r.status).toBe("aplicado_con_diferencias");
        expect(r.differences.map((d) => d.field)).toEqual(["private"]);
    });

    it("no responde a una respuesta privada, ni en una discusión bloqueada, ni en otro curso", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "forum_reply", { discussion_id: D_WELCOME, reply_to_post_id: P_PRIVATE, message: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
        h.forums.discussions.get(D_WELCOME)!.timelocked = 1;
        expect((await errOf(plan(h, "forum_reply", { discussion_id: D_WELCOME, message: "x" }))).code).toBe("MOODLE_PERMISSION_DENIED");
        expect((await errOf(plan(h, "forum_reply", { discussion_id: D_OTHER, message: "x" }))).code).toBe("RESOURCE_OUT_OF_SCOPE");
        expect(writes(h)).toBe(0);
    });

    it("inyección: un post de estudiante con órdenes no produce escrituras; el plan lo marca como dato", async () => {
        const h = await harness();
        const p = await plan(h, "forum_reply", { discussion_id: D_STUDENT, message: "Respondo sólo lo que pedí" });
        expect(writes(h)).toBe(0);
        expect(p.untrusted_fields).toContain("payload_preview.reply_to.author");
        expect(p.items).toHaveLength(1);
        expect(p.items[0]!.function).toBe("mod_forum_add_discussion_post");
        expect(JSON.stringify(p.items)).not.toContain(INJECTION);
        expect(p.items[0]!.target.parent_id).toBe(P_STUDENT);
    });
});

describe("W1 · edición de un post propio (§8.1)", () => {
    it("manda discussionsubscribe explícito (subscribe=true lo mantiene) y '' en lo que no cambia; deshacer restaura", async () => {
        const h = await harness();
        h.forums.subscribed.set(D_WELCOME, true);
        const p = await plan(h, "post_edit", { discussion_id: D_WELCOME, post_id: P_WELCOME, message: "Bienvenidos, **corregido**.", subscribe: true });
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(calls(h, "mod_forum_update_discussion_post")[0]!.params).toMatchObject({ subject: "", "options[0][name]": "discussionsubscribe", "options[0][value]": "1" });
        expect(h.forums.subscribed.get(D_WELCOME)).toBe(true);
        expect(h.forums.posts.get(P_WELCOME)!.message).toContain("<strong>corregido</strong>");
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error("debería poder deshacerse");
        expect(u.undo_kind).toBe("compensación");
        expect((await exec(h, u.plan.plan_id)).status).toBe("aplicado_verificado");
        expect(h.forums.posts.get(P_WELCOME)!.message).toBe("<p>Bienvenidos al curso.</p>");
    });

    it("sólo posts propios; un cambio ajeno entre plan y ejecución da PLAN_STALE", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "post_edit", { discussion_id: D_WELCOME, post_id: P_STUDENT_REPLY, message: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
        const p = await plan(h, "post_edit", { discussion_id: D_WELCOME, post_id: P_WELCOME, subject: "Bienvenida (editada)" });
        h.forums.touchPost(P_WELCOME, "<p>Otro lo cambió</p>");
        expect((await errOf(exec(h, p.plan_id))).code).toBe("PLAN_STALE");
        expect(calls(h, "mod_forum_update_discussion_post")).toHaveLength(0);
    });

    it("Moodle «acepta» pero no cambia nada: sin_efecto", async () => {
        const h = await harness();
        h.forums.next("noop");
        const r = await exec(h, (await plan(h, "post_edit", { discussion_id: D_WELCOME, post_id: P_WELCOME, message: "nuevo" })).plan_id);
        expect(r.status).toBe("sin_efecto");
    });
});

describe("W1 · fijar y bloquear (§8.1)", () => {
    it("bloquear usa targetstate=0 (semántica invertida), es R1 con aprobación del cliente y se deshace con la inversa", async () => {
        const h = await harness();
        const p = await plan(h, "discussion_state", { discussion_id: D_WELCOME, locked: true, pinned: true });
        expect(p.risk).toBe("R1");
        expect(p.confirmation.channel).toBe("cliente");
        const r = await exec(h, p.plan_id);
        expect(r.status).toBe("aplicado_verificado");
        expect(h.confirmer.views).toHaveLength(0);
        expect(calls(h, "mod_forum_set_lock_state")[0]!.params).toMatchObject({ forumid: String(F_NEWS), targetstate: "0" });
        expect(calls(h, "mod_forum_set_pin_state")[0]!.params.targetstate).toBe("1");
        const d = h.forums.discussions.get(D_WELCOME)!;
        expect([d.pinned, d.timelocked > 0]).toEqual([true, true]);
        const u = await h.app.engine.planUndo(r.action_id, "test");
        if (!u.undoable) throw new Error("debería poder deshacerse");
        await exec(h, u.plan.plan_id);
        expect(calls(h, "mod_forum_set_lock_state")[1]!.params.targetstate).toBe("1");
        expect([d.pinned, d.timelocked > 0]).toEqual([false, false]);
    });

    it("si ya está en ese estado no hay nada que escribir", async () => {
        const h = await harness();
        expect((await errOf(plan(h, "discussion_state", { discussion_id: D_WELCOME, locked: false }))).code).toBe("WRITE_NOT_ALLOWED");
    });
});

describe("W1 · servidor MCP", () => {
    it("expone las 4 intenciones de foros; borrar posts sólo como deshacer (las de borrado son delete_content, ADR-067, y la de eventos, ADR-083)", async () => {
        const client = await connectWrite(await harness());
        const names = (await client.listTools()).tools.map((t) => t.name);
        for (const t of ["campus_plan_announcement", "campus_plan_forum_reply", "campus_plan_post_edit", "campus_plan_discussion_state"]) expect(names).toContain(t);
        // Borrar eventos de calendario existentes se agregó en ADR-083 (no toca posts).
        expect(names.filter((n) => /delete|borrar/.test(n)).sort()).toEqual(["campus_plan_assign_override_delete", "campus_plan_attendance_session_delete", "campus_plan_calendar_event_delete", "campus_plan_delete_content", "campus_plan_delete_group", "campus_plan_forum_post_delete", "campus_plan_quiz_attempt_delete", "campus_plan_quiz_override_delete"]);
        const r = await client.callTool({ name: "campus_plan_announcement", arguments: { course_id: COURSE, subject: "y".repeat(256), message: "x" } });
        expect(r.isError).toBe(true);
    });

    it("sin la capacidad en el curso: WRITE_NOT_ALLOWED", async () => {
        const client = await connectWrite(await makeWriteHarness());
        const r = parseTool((await client.callTool({ name: "campus_plan_announcement", arguments: { course_id: COURSE, subject: "a", message: "b" } })) as { content: unknown });
        expect(r.error.code).toBe("WRITE_NOT_ALLOWED");
    });
});

describe("ADR-048 · sin notificar a participantes y confirmación en el cliente en el sandbox", () => {
    it("por defecto se rechaza publicar o responder en foros con suscripción forzada, inicial o desconocida; el opcional se permite", async () => {
        const h = await makeWriteHarness({ policy: { courses: { [String(COURSE)]: W1 } } });
        expect((await errOf(plan(h, "announcement", { subject: "a", message: "b" }))).code).toBe("WRITE_NOT_ALLOWED");
        expect((await errOf(plan(h, "forum_reply", { discussion_id: D_WELCOME, message: "x" }))).code).toBe("WRITE_NOT_ALLOWED");
        for (const kind of [2, null]) {
            h.forums.forums.find((f) => f.id === F_QA)!.forcesubscribe = kind as number;
            expect((await errOf(plan(h, "announcement", { subject: "a", message: "b", forum_id: F_QA, group_id: GROUP_A }))).code).toBe("WRITE_NOT_ALLOWED");
        }
        h.forums.forums.find((f) => f.id === F_QA)!.forcesubscribe = 0;
        expect((await plan(h, "announcement", { subject: "a", message: "b", forum_id: F_QA, group_id: GROUP_A })).items).toHaveLength(1);
        // Fijar y bloquear no notifica: se permite también en el foro forzado.
        expect((await plan(h, "discussion_state", { discussion_id: D_WELCOME, pinned: true })).items).toHaveLength(1);
        expect(writes(h)).toBe(0);
    });

    it("sandbox_confirmation=cliente: un R2 del sandbox se ejecuta sin canal fuera de banda; fuera del sandbox no aplica", async () => {
        const h = await harness({ sandbox_confirmation: "cliente" });
        const p = await plan(h, "announcement", { subject: "sin diálogo", message: "b", forum_id: F_QA, group_id: GROUP_A });
        expect(p.risk).toBe("R2");
        expect(p.confirmation.channel).toBe("cliente");
        expect(p.risk_reasons.join(" ")).toMatch(/ADR-048/);
        expect((await exec(h, p.plan_id)).status).toBe("aplicado_verificado");
        expect(h.confirmer.views).toHaveLength(0);

        const real = await harness({ sandbox_confirmation: "cliente", sandbox_course_ids: [], courses: { [String(COURSE)]: W1.map((c) => ({ capability: c, enabled_on: "2020-01-01" })) } });
        const q = await plan(real, "forum_reply", { discussion_id: D_WELCOME, message: "x" });
        expect(q.confirmation.channel).toBe("fuera_de_banda");
    });
});
