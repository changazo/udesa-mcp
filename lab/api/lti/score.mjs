// Paso 3: el ejercicio informa cuántas pruebas pasó; se envía la nota al Campus por AGS.
// La cuenta la hace el navegador del estudiante: sirve para práctica calificada, no para exámenes.
import { cfg, forClient, postScore, unseal } from "../_lib/lti.mjs";
import { cfg11, postOutcome11 } from "../_lib/lti11.mjs";

export async function POST(req) {
    const base = cfg();
    let body;
    try {
        body = await req.json();
    } catch {
        return Response.json({ ok: false, error: "Pedido inválido." }, { status: 400 });
    }
    const s = unseal(base.stateSecret, body?.session);
    const c = s && s.v !== 11 ? forClient(base, s.cid) : null;
    if (!s || (s.v !== 11 && !c)) return Response.json({ ok: false, error: "La sesión venció: volvé a abrir la actividad." }, { status: 401 });
    const total = Number(body.total);
    const passed = Number(body.passed);
    if (!Number.isInteger(total) || total < 1 || total > 50 || !Number.isInteger(passed) || passed < 0 || passed > total) return Response.json({ ok: false, error: "Resultado inválido." }, { status: 400 });
    try {
        if (s.v === 11) await postOutcome11(cfg11(), { serviceUrl: s.svc, sourcedid: s.sid, score: passed / total });
        else await postScore(c, { lineitem: s.li, userId: s.sub, scoreGiven: passed, scoreMaximum: total });
        return Response.json({ ok: true, passed, total, instructor: !!s.inst });
    } catch (e) {
        return Response.json({ ok: false, error: String(e.message).slice(0, 300) }, { status: 502 });
    }
}
