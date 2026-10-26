// Claves públicas de la herramienta (el Campus las usa para verificar los pedidos de nota).
import { cfg, toolKey } from "../_lib/lti.mjs";

export function GET() {
    const { jwk } = toolKey(cfg().privateKeyPem);
    return Response.json({ keys: [jwk] }, { headers: { "cache-control": "public, max-age=300" } });
}
