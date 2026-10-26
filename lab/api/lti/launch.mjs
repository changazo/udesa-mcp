// Paso 2: el Campus envía el id_token. Se verifica y se muestra el ejercicio con una sesión firmada para la nota.
import { cfg, esc, exercisePage, forClient, html, seal, unseal, verifyIdToken } from "../_lib/lti.mjs";

const C = "https://purl.imsglobal.org/spec/lti/claim/";
const AGS = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";

export async function POST(req) {
    const base = cfg();
    const form = new URLSearchParams(await req.text());
    const st = unseal(base.stateSecret, form.get("state"));
    const c = st ? forClient(base, st.cid) : null;
    if (!st || !c) return html("<p>El lanzamiento venció o no es válido. Volvé a abrir la actividad.</p>", 400);
    let p;
    try {
        p = await verifyIdToken(c, form.get("id_token"), st.n);
    } catch (e) {
        return html(`<p>No se pudo verificar el lanzamiento: ${esc(e.message)}</p>`, 401);
    }
    const roles = (p[`${C}roles`] ?? []).map(String);
    const learner = roles.some((r) => /#Learner$|\/membership#Learner$/.test(r));
    const instructor = roles.some((r) => /#(Instructor|Administrator)$/.test(r));
    const custom = p[`${C}custom`] ?? {};
    const exercise = typeof custom.ejercicio === "string" ? custom.ejercicio : null;
    const ags = p[AGS];
    const lineitem = ags && Array.isArray(ags.scope) && ags.scope.includes("https://purl.imsglobal.org/spec/lti-ags/scope/score") ? ags.lineitem ?? null : null;
    // Sesión para enviar la nota: sólo el identificador opaco del Campus y el ítem de calificación (2 h).
    const session = lineitem && (learner || instructor) ? seal(c.stateSecret, { v: 13, sub: p.sub, li: lineitem, cid: c.clientId, inst: instructor && !learner }, 7200) : null;
    const data = JSON.stringify({ config: exercise, session, role: learner ? "estudiante" : instructor ? "docente" : "otro", resource: String(p[`${C}resource_link`]?.title ?? "").slice(0, 200) });
    return html(exercisePage(data));
}
