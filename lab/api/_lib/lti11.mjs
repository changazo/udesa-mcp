// LTI 1.1 del laboratorio (ADR-117): en el Campus de UdeSA los servicios de LTI 1.3 (AGS) no responden porque
// por la configuración del servidor, mod/lti/services.php (LTI 1.3) puede no recibir la ruta; Basic Outcomes usa mod/lti/service.php y sí funciona.
// Firma OAuth 1.0a HMAC-SHA1 (lanzamiento y envío de nota con oauth_body_hash). Sin dependencias.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function cfg11() {
    const key = process.env.LTI11_KEY || "udesa-lab";
    const secret = process.env.LTI11_SECRET || null;
    const iss = process.env.LTI_PLATFORM_ISS || "https://campusvirtual.udesa.edu.ar";
    return { key, secret, outcomeUrl: `${iss}/mod/lti/service.php` };
}

/** Firma OAuth 1.0a de un pedido (URL sin query + parámetros). */
export function oauthSignature(method, url, params, consumerSecret) {
    const u = new URL(url);
    const all = [...Object.entries(params).filter(([k]) => k !== "oauth_signature"), ...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(String(v))]);
    all.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
    const base = [method.toUpperCase(), enc(baseUrl), enc(all.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
    return createHmac("sha1", `${enc(consumerSecret)}&`).update(base).digest("base64");
}

/** Verifica el lanzamiento LTI 1.1 (POST de formulario firmado por el Campus). */
export function verifyLaunch11(c, url, form) {
    if (!c.secret) throw new Error("Falta el secreto LTI 1.1 de la herramienta.");
    const params = Object.fromEntries(form);
    if (params.oauth_consumer_key !== c.key) throw new Error("Clave de consumidor desconocida.");
    if (params.oauth_signature_method !== "HMAC-SHA1") throw new Error("Método de firma no admitido.");
    const ts = Number(params.oauth_timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) throw new Error("Lanzamiento vencido (más de 5 minutos).");
    const want = Buffer.from(oauthSignature("POST", url, params, c.secret));
    const got = Buffer.from(String(params.oauth_signature ?? ""));
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error("Firma del lanzamiento inválida.");
    if (params.lti_message_type !== "basic-lti-launch-request") throw new Error("Tipo de mensaje no admitido.");
    return params;
}

/** Envía la nota (0..1) por Basic Outcomes: XML firmado con oauth_body_hash. */
export async function postOutcome11(c, { serviceUrl, sourcedid, score }) {
    if (!c.secret) throw new Error("Falta el secreto LTI 1.1 de la herramienta.");
    if (serviceUrl !== c.outcomeUrl) throw new Error("Servicio de notas inesperado.");
    const id = randomBytes(8).toString("hex");
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><imsx_POXEnvelopeRequest xmlns="http://www.imsglobal.org/services/ltiv1p1/xsd/imsoms_v1p0"><imsx_POXHeader><imsx_POXRequestHeaderInfo><imsx_version>V1.0</imsx_version><imsx_messageIdentifier>${id}</imsx_messageIdentifier></imsx_POXRequestHeaderInfo></imsx_POXHeader><imsx_POXBody><replaceResultRequest><resultRecord><sourcedGUID><sourcedId>${esc(sourcedid)}</sourcedId></sourcedGUID><result><resultScore><language>en</language><textString>${score.toFixed(4)}</textString></resultScore></result></resultRecord></replaceResultRequest></imsx_POXBody></imsx_POXEnvelopeRequest>`;
    const oauth = {
        oauth_consumer_key: c.key,
        oauth_nonce: randomBytes(12).toString("hex"),
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: String(Math.floor(Date.now() / 1000)),
        oauth_version: "1.0",
        oauth_body_hash: createHash("sha1").update(xml).digest("base64"),
    };
    oauth.oauth_signature = oauthSignature("POST", serviceUrl, oauth, c.secret);
    const header = "OAuth " + Object.entries(oauth).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
    const r = await fetch(serviceUrl, { method: "POST", headers: { authorization: header, "content-type": "application/xml" }, body: xml });
    const text = await r.text();
    const code = /<imsx_codeMajor>(\w+)<\/imsx_codeMajor>/.exec(text)?.[1];
    if (!r.ok || code !== "success") throw new Error(`El Campus rechazó la nota (HTTP ${r.status}, ${code ?? "sin respuesta POX"}): ${(/<imsx_description>([^<]*)/.exec(text)?.[1] ?? "").slice(0, 160)}`);
}
