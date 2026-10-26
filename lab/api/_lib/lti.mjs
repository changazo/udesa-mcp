// Herramienta LTI 1.3 del laboratorio (ADR-117): lanzamiento OIDC, verificación del id_token del Campus y
// envío de la nota por el servicio de calificaciones (AGS). Sin dependencias: sólo node:crypto.
// No recibe nombre ni correo (la herramienta se registra con «Nunca»); guarda nada: todo va firmado.
import { createHmac, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, timingSafeEqual, createHash } from "node:crypto";

const env = (k, d) => {
    const v = process.env[k];
    if (v === undefined || v === "") {
        if (d !== undefined) return d;
        throw new Error(`Falta la variable ${k}`);
    }
    return v;
};

export const cfg = () => ({
    iss: env("LTI_PLATFORM_ISS", "https://campusvirtual.udesa.edu.ar"),
    // Registros de la herramienta en el Campus (uno por curso): «clientId:deploymentId,clientId:deploymentId».
    registrations: new Map(String(process.env.LTI_REGISTRATIONS ?? "").split(",").map((x) => x.trim().split(":")).filter((x) => x.length === 2 && x[0] && x[1])),
    clientId: null,
    deploymentId: null,
    authUrl: env("LTI_AUTH_URL", "https://campusvirtual.udesa.edu.ar/mod/lti/auth.php"),
    tokenUrl: env("LTI_TOKEN_URL", "https://campusvirtual.udesa.edu.ar/mod/lti/token.php"),
    jwksUrl: env("LTI_JWKS_URL", "https://campusvirtual.udesa.edu.ar/mod/lti/certs.php"),
    base: env("LAB_BASE_URL", "https://udesa-campus-lab.vercel.app"),
    stateSecret: Buffer.from(env("LTI_STATE_SECRET"), "base64url"),
    privateKeyPem: env("LTI_PRIVATE_KEY").replace(/\\n/g, "\n"),
});

/** Configuración para un registro (client_id) conocido, o null. */
export function forClient(c, clientId) {
    const dep = clientId ? c.registrations.get(String(clientId)) : undefined;
    return dep ? { ...c, clientId: String(clientId), deploymentId: dep } : null;
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

// ---------- tokens propios firmados (state, sesión de nota) ----------
export function seal(secret, payload, ttlS) {
    const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlS }));
    return `${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
}
export function unseal(secret, token) {
    const [body, sig] = String(token ?? "").split(".");
    if (!body || !sig || token.length > 8192) return null;
    const want = createHmac("sha256", secret).update(body).digest();
    const got = fromB64u(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const p = JSON.parse(fromB64u(body).toString("utf8"));
    return typeof p.exp === "number" && p.exp * 1000 >= Date.now() ? p : null;
}

// ---------- claves de la herramienta ----------
export function toolKey(pem) {
    const priv = createPrivateKey(pem);
    const jwk = createPublicKey(priv).export({ format: "jwk" });
    const kid = createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest("base64url").slice(0, 16);
    return { priv, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export function signJwt(priv, kid, claims) {
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const body = b64u(JSON.stringify(claims));
    const s = createSign("RSA-SHA256").update(`${head}.${body}`).sign(priv);
    return `${head}.${body}.${b64u(s)}`;
}

// ---------- verificación del id_token del Campus ----------
let jwksCache = { at: 0, keys: [] };
async function platformKeys(url, force) {
    if (!force && Date.now() - jwksCache.at < 10 * 60_000 && jwksCache.keys.length) return jwksCache.keys;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`No se pudieron leer las claves del Campus (HTTP ${r.status}).`);
    const j = await r.json();
    jwksCache = { at: Date.now(), keys: Array.isArray(j.keys) ? j.keys : [] };
    return jwksCache.keys;
}

export async function verifyIdToken(c, idToken, expectedNonce) {
    const parts = String(idToken ?? "").split(".");
    if (parts.length !== 3) throw new Error("id_token mal formado.");
    const head = JSON.parse(fromB64u(parts[0]).toString("utf8"));
    if (head.alg !== "RS256") throw new Error("Algoritmo de firma no admitido.");
    let jwk = (await platformKeys(c.jwksUrl, false)).find((k) => k.kid === head.kid);
    if (!jwk) jwk = (await platformKeys(c.jwksUrl, true)).find((k) => k.kid === head.kid);
    if (!jwk) throw new Error("Clave del Campus desconocida.");
    const ok = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key: jwk, format: "jwk" }), fromB64u(parts[2]));
    if (!ok) throw new Error("Firma del id_token inválida.");
    const p = JSON.parse(fromB64u(parts[1]).toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (p.iss !== c.iss) throw new Error("Emisor inesperado.");
    if (!aud.includes(c.clientId) || (aud.length > 1 && p.azp !== c.clientId)) throw new Error("Audiencia inesperada.");
    if (typeof p.exp !== "number" || p.exp < now - 30 || typeof p.iat !== "number" || p.iat > now + 60) throw new Error("id_token vencido o con fecha inválida.");
    if (p.nonce !== expectedNonce) throw new Error("nonce inválido.");
    if (p["https://purl.imsglobal.org/spec/lti/claim/deployment_id"] !== c.deploymentId) throw new Error("Implementación (deployment) desconocida.");
    if (p["https://purl.imsglobal.org/spec/lti/claim/version"] !== "1.3.0") throw new Error("Versión de LTI no admitida.");
    if (p["https://purl.imsglobal.org/spec/lti/claim/message_type"] !== "LtiResourceLinkRequest") throw new Error("Tipo de mensaje no admitido.");
    return p;
}

// ---------- nota (AGS) ----------
export async function postScore(c, { lineitem, userId, scoreGiven, scoreMaximum }) {
    const { priv, jwk } = toolKey(c.privateKeyPem);
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt(priv, jwk.kid, { iss: c.clientId, sub: c.clientId, aud: c.tokenUrl, iat: now, exp: now + 300, jti: randomBytes(16).toString("hex") });
    const tr = await fetch(c.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion, scope: "https://purl.imsglobal.org/spec/lti-ags/scope/score" }),
    });
    const tj = await tr.json().catch(() => ({}));
    if (!tr.ok || !tj.access_token) throw new Error(`El Campus no dio el permiso para enviar la nota (HTTP ${tr.status}${tj.error ? `: ${tj.error}` : ""}).`);
    const u = new URL(lineitem);
    u.pathname = `${u.pathname.replace(/\/$/, "")}/scores`;
    const sr = await fetch(u, {
        method: "POST",
        headers: { authorization: `Bearer ${tj.access_token}`, "content-type": "application/vnd.ims.lis.v1.score+json" },
        body: JSON.stringify({ userId, scoreGiven, scoreMaximum, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: new Date().toISOString() }),
    });
    if (!sr.ok) {
        let reason = "";
        try {
            reason = String(JSON.parse(await sr.text()).reason ?? "").slice(0, 160);
        } catch {
            reason = "";
        }
        throw new Error(`El Campus rechazó la nota (HTTP ${sr.status}${reason ? `: ${reason}` : ""}) en ${u.pathname}`);
    }
}

export const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export async function formOrQuery(req) {
    const u = new URL(req.url);
    const p = new URLSearchParams(u.search);
    if (req.method === "POST") for (const [k, v] of new URLSearchParams(await req.text())) p.set(k, v);
    return p;
}

/** Página del ejercicio tras un lanzamiento (1.1 o 1.3): los datos van como JSON inerte. */
export function exercisePage(data) {
    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Ejercicio de Python</title><link rel="stylesheet" href="/apps/python/style.css"></head>
<body><main>
<p id="lti-banner" class="banner"></p>
<h1 id="title">Ejercicio de Python</h1>
<div id="statement" class="statement"></div>
<label for="code" class="sr-only">Tu código</label>
<textarea id="code" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
<div class="actions"><button id="run" type="button" disabled>Cargando Python…</button><button id="reset" type="button" class="secondary">Volver al código inicial</button><span id="score" class="score" aria-live="polite"></span></div>
<section id="results" aria-live="polite"></section>
<details id="stdout-box" hidden><summary>Salida (print)</summary><pre id="stdout"></pre></details>
<p id="error" class="error" hidden></p>
<p id="grade" class="score" aria-live="polite"></p>
</main>
<script type="application/json" id="lti-data">${data.replace(/</g, "\\u003c")}</script>
<script src="/apps/python/app.js" type="module"></script>
</body></html>`;
}
