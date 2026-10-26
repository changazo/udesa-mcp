import { describe, expect, it } from "vitest";
import { assertCustomScheme, callbackChannel, handlerCommand, installArgs, registryKey, sendCallback, waitForCallback } from "../../src/auth/scheme-handler.js";
import { CampusError } from "../../src/errors.js";

const SCHEME = "udesacampustest";

describe("retorno automático: canal local", () => {
    it("el login recibe el enlace que entrega el manejador, una sola vez", async () => {
        const ctrl = new AbortController();
        const waiting = waitForCallback(SCHEME, ctrl.signal);
        await new Promise((r) => setTimeout(r, 50));
        await sendCallback(SCHEME, `${SCHEME}://token=QUJD`);
        expect(await waiting).toBe(`${SCHEME}://token=QUJD`);
        // ya no hay nadie escuchando: un segundo envío falla
        await expect(sendCallback(SCHEME, `${SCHEME}://token=OTRO`, 500)).rejects.toBeInstanceOf(CampusError);
    });

    it("sin login esperando, el manejador falla sin perder nada", async () => {
        await expect(sendCallback(SCHEME, `${SCHEME}://token=X`, 500)).rejects.toMatchObject({ code: "BROWSER_CALLBACK_REJECTED" });
    });

    it("dos logins a la vez: el segundo no puede escuchar", async () => {
        const a = new AbortController();
        const first = waitForCallback(SCHEME, a.signal);
        first.catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
        await expect(waitForCallback(SCHEME, new AbortController().signal)).rejects.toMatchObject({ code: "BROWSER_CALLBACK_REJECTED" });
        a.abort();
        await expect(first).rejects.toBeInstanceOf(CampusError);
    });

    it("mensajes demasiado largos se rechazan", async () => {
        await expect(sendCallback(SCHEME, "x".repeat(5000))).rejects.toBeInstanceOf(CampusError);
    });

    it("el canal es propio del usuario y del esquema", () => {
        expect(callbackChannel(SCHEME)).not.toBe(callbackChannel("otroesquema"));
        if (process.platform === "win32") {
            expect(callbackChannel(SCHEME).startsWith(String.raw`\\.\pipe\udesa-campus-mcp-`)).toBe(true);
            expect(callbackChannel(SCHEME)).toMatch(/udesa-campus-mcp-[0-9a-f]{16}$/);
        }
    });
});

describe("retorno automático: registro en Windows (sin ejecutar reg.exe)", () => {
    it("sólo HKCU, con el comando de callback y el enlace como %1", () => {
        const args = installArgs("udesacampusmcp", "C:/Program Files/nodejs/node.exe", "C:/proyecto/build/cli.js");
        expect(registryKey("udesacampusmcp")).toBe(String.raw`HKCU\Software\Classes\udesacampusmcp`);
        expect(args.every((a) => a[1]!.startsWith(String.raw`HKCU\Software\Classes\udesacampusmcp`))).toBe(true);
        expect(args[1]).toEqual(["add", String.raw`HKCU\Software\Classes\udesacampusmcp`, "/v", "URL Protocol", "/d", "", "/f"]);
        expect(args[2]![4]).toBe(handlerCommand("C:/Program Files/nodejs/node.exe", "C:/proyecto/build/cli.js", "udesacampusmcp"));
        expect(args[2]![4]).toBe('"C:/Program Files/nodejs/node.exe" "C:/proyecto/build/cli.js" auth callback --scheme udesacampusmcp "%1"');
    });

    it("nunca registra el esquema de la app oficial ni esquemas inválidos", () => {
        expect(() => assertCustomScheme("moodlemobile")).toThrow(CampusError);
        expect(() => assertCustomScheme("x;calc")).toThrow(CampusError);
        expect(() => assertCustomScheme("udesacampusmcp")).not.toThrow();
    });
});
