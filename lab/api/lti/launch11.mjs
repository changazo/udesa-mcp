// Lanzamiento LTI 1.1 (ADR-117): el Campus envía un formulario firmado con la clave y el secreto compartido.
// Se verifica la firma y se muestra el ejercicio con una sesión firmada para enviar la nota por Basic Outcomes.
import { cfg, esc, exercisePage, html, seal } from "../_lib/lti.mjs";
import { cfg11, verifyLaunch11 } from "../_lib/lti11.mjs";

export async function POST(req) {
    const base = cfg();
    const c = cfg11();
    const form = new URLSearchParams(await req.text());
    let p;
    try {
        // La firma cubre la URL configurada en el Campus, no la interna de la plataforma.
        p = verifyLaunch11(c, `${base.base}/api/lti/launch11`, form);
    } catch (e) {
        return html(`<p>No se pudo verificar el lanzamiento: ${esc(e.message)}</p>`, 401);
    }
    const roles = String(p.roles ?? "").split(",").map((r) => r.trim());
    const learner = roles.some((r) => /(^|\/)Learner$/.test(r));
    const instructor = roles.some((r) => /(^|\/)(Instructor|Administrator)$/.test(r));
    const exercise = typeof p.custom_ejercicio === "string" ? p.custom_ejercicio : null;
    const svc = p.lis_outcome_service_url ?? null;
    const sid = p.lis_result_sourcedid ?? null;
    // Sesión para enviar la nota: sólo el identificador opaco del resultado y el servicio (2 h).
    const session = svc === c.outcomeUrl && sid && (learner || instructor) ? seal(base.stateSecret, { v: 11, sid, svc, inst: instructor && !learner }, 7200) : null;
    const data = JSON.stringify({ config: exercise, session, role: learner ? "estudiante" : instructor ? "docente" : "otro", resource: String(p.resource_link_title ?? "").slice(0, 200) });
    return html(exercisePage(data));
}
