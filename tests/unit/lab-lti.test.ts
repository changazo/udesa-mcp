import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error módulo JS del laboratorio (sin tipos)
import { postScore, seal, signJwt, toolKey, unseal, verifyIdToken } from "../../lab/api/_lib/lti.mjs";

/** ADR-117: núcleo LTI 1.3 de la herramienta del laboratorio, con un «Campus» falso. */
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformJwk = { ...platform.publicKey.export({ format: "jwk" }), kid: "campus-1", alg: "RS256" };
const tool = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const c = { iss: "https://campus.test", clientId: "cli-1", deploymentId: "7", authUrl: "https://campus.test/mod/lti/auth.php", tokenUrl: "https://campus.test/mod/lti/token.php", jwksUrl: "https://campus.test/mod/lti/certs.php", base: "https://lab.test", stateSecret: randomBytes(32), privateKeyPem: tool };
const C = "https://purl.imsglobal.org/spec/lti/claim/";

function idToken(over: Record<string, unknown> = {}, kid = "campus-1") {
    const now = Math.floor(Date.now() / 1000);
    return signJwt(platform.privateKey, kid, { iss: c.iss, aud: c.clientId, sub: "opaco-42", iat: now, exp: now + 60, nonce: "n1", [`${C}deployment_id`]: "7", [`${C}version`]: "1.3.0", [`${C}message_type`]: "LtiResourceLinkRequest", ...over });
}

afterEach(() => vi.unstubAllGlobals());

describe("LTI del laboratorio (ADR-117)", () => {
    it("tokens propios: firmados, alterados o vencidos se rechazan", () => {
        const t = seal(c.stateSecret, { n: "x" }, 60);
        expect(unseal(c.stateSecret, t)).toMatchObject({ n: "x" });
        expect(unseal(c.stateSecret, t.replace(/^./, "A"))).toBeNull();
        expect(unseal(randomBytes(32), t)).toBeNull();
        expect(unseal(c.stateSecret, seal(c.stateSecret, {}, -10))).toBeNull();
    });

    it("id_token: firma del Campus, emisor, audiencia, nonce, implementación y tipo", async () => {
        vi.stubGlobal("fetch", async () => Response.json({ keys: [platformJwk] }));
        expect(await verifyIdToken(c, idToken(), "n1")).toMatchObject({ sub: "opaco-42" });
        await expect(verifyIdToken(c, idToken(), "otro")).rejects.toThrow(/nonce/);
        await expect(verifyIdToken(c, idToken({ iss: "https://evil.test" }), "n1")).rejects.toThrow(/Emisor/);
        await expect(verifyIdToken(c, idToken({ aud: "otro" }), "n1")).rejects.toThrow(/Audiencia/);
        await expect(verifyIdToken(c, idToken({ [`${C}deployment_id`]: "9" }), "n1")).rejects.toThrow(/deployment/);
        await expect(verifyIdToken(c, idToken({ exp: 1 }), "n1")).rejects.toThrow(/vencido/);
        const forged = signJwt(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, "campus-1", { iss: c.iss });
        await expect(verifyIdToken(c, forged, "n1")).rejects.toThrow(/Firma/);
    });

    it("nota: pide el token con una aserción firmada por la herramienta y envía el score al lineitem", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        vi.stubGlobal("fetch", async (url: URL | string, init: RequestInit) => {
            calls.push({ url: String(url), init });
            return String(url).endsWith("/token.php") ? Response.json({ access_token: "tok" }) : new Response(null, { status: 200 });
        });
        await postScore(c, { lineitem: "https://campus.test/mod/lti/services.php/12345/lineitems/5/lineitem?type_id=3", userId: "opaco-42", scoreGiven: 3, scoreMaximum: 4 });
        expect(calls[1]!.url).toBe("https://campus.test/mod/lti/services.php/12345/lineitems/5/lineitem/scores?type_id=3");
        expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ userId: "opaco-42", scoreGiven: 3, scoreMaximum: 4, gradingProgress: "FullyGraded" });
        const form = new URLSearchParams(String(calls[0]!.init.body));
        expect(form.get("scope")).toBe("https://purl.imsglobal.org/spec/lti-ags/scope/score");
        expect(toolKey(tool).jwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
        expect(toolKey(tool).jwk.d).toBeUndefined(); // la clave pública nunca lleva la privada
    });
});
