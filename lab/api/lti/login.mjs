// Paso 1 del lanzamiento LTI 1.3 (inicio OIDC iniciado por el Campus): redirige al Campus con state y nonce firmados.
import { randomBytes } from "node:crypto";
import { cfg, forClient, formOrQuery, html, seal } from "../_lib/lti.mjs";

async function handle(req) {
    const p = await formOrQuery(req);
    const c = forClient(cfg(), p.get("client_id"));
    if (!c || p.get("iss") !== c.iss) return html("<p>Esta herramienta no está registrada para ese curso del Campus.</p>", 400);
    const nonce = randomBytes(16).toString("base64url");
    // Sin cookies (la herramienta se abre dentro de un iframe del Campus): el state firmado lleva el nonce y vence en 10 min.
    const state = seal(c.stateSecret, { n: nonce, cid: c.clientId }, 600);
    const u = new URL(c.authUrl);
    for (const [k, v] of Object.entries({ scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none", client_id: c.clientId, redirect_uri: `${c.base}/api/lti/launch`, login_hint: p.get("login_hint") ?? "", state, nonce })) u.searchParams.set(k, v);
    if (p.get("lti_message_hint")) u.searchParams.set("lti_message_hint", p.get("lti_message_hint"));
    return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
