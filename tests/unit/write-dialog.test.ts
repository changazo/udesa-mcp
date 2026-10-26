import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DIALOG_SCRIPT, WindowsDialogConfirmer, type ConfirmationView, type Spawner } from "../../src/write/confirm.js";

const view = (over: Partial<ConfirmationView> = {}): ConfirmationView => ({
    plan_id: "pl_aaaaaaaaaaaaaaaa",
    plan_hash: "f".repeat(64),
    code: "FFFFFF",
    risk: "R2",
    course_id: 4242,
    expires_at: "2026-10-19T12:15:00.000Z",
    text: "QUÉ: algo\n'; Remove-Item C:\\ -Recurse; $(calc) `whoami`",
    ...over,
});

/** Proceso falso: captura argumentos y entorno, y responde lo que diga el diálogo. */
function fakeSpawner(answer: string | null, captured: { args?: string[]; env?: NodeJS.ProcessEnv }[]): Spawner {
    return ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        captured.push({ args: [cmd, ...args], env: opts.env });
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void };
        child.stdout = new PassThrough();
        child.kill = () => child.emit("close", null);
        setTimeout(() => {
            if (answer !== null) child.stdout.write(`${answer}\r\n`);
            child.emit("close", 0);
        }, 5);
        return child;
    }) as unknown as Spawner;
}

describe("diálogo nativo de confirmación (§5.4)", () => {
    it.each([
        ["APPROVE", "approved"],
        ["REJECT", "rejected"],
        ["TIMEOUT", "timeout"],
        ["", "unavailable"],
    ] as const)("respuesta %s → %s", async (answer, decision) => {
        const d = new WindowsDialogConfirmer(120_000, fakeSpawner(answer, []), "win32");
        expect((await d.confirm(view())).decision).toBe(decision);
    });

    it("el texto del plan viaja en base64 por el entorno: nunca se interpola en el comando de PowerShell", async () => {
        const captured: { args?: string[]; env?: NodeJS.ProcessEnv }[] = [];
        await new WindowsDialogConfirmer(30_000, fakeSpawner("REJECT", captured), "win32").confirm(view());
        const c = captured[0]!;
        expect(c.args!.join(" ")).not.toContain("Remove-Item");
        expect(c.args![c.args!.length - 1]).toBe(DIALOG_SCRIPT);
        const payload = JSON.parse(Buffer.from(c.env!.CAMPUS_DIALOG_B64!, "base64").toString("utf8"));
        expect(payload.body).toContain("Remove-Item");
        expect(payload.body).toContain("\r\n");
        expect(payload.timeout_ms).toBe(30_000);
        expect(payload.title).toContain("FFFFFF");
    });

    it("el script rechaza por defecto (Enter, Escape y cerrar la ventana = Rechazar) y vence solo", () => {
        expect(DIALOG_SCRIPT).toContain("$form.AcceptButton = $reject");
        expect(DIALOG_SCRIPT).toContain("$form.CancelButton = $reject");
        expect(DIALOG_SCRIPT).toContain("$form.Tag = 'REJECT'");
        expect(DIALOG_SCRIPT).toContain("'TIMEOUT'");
        expect(DIALOG_SCRIPT).toContain("FromBase64String($env:CAMPUS_DIALOG_B64)");
    });

    it("fuera de Windows o con R4 no hay diálogo (queda la terminal)", async () => {
        expect((await new WindowsDialogConfirmer(1000, fakeSpawner("APPROVE", []), "linux").confirm(view())).decision).toBe("unavailable");
        expect((await new WindowsDialogConfirmer(1000, fakeSpawner("APPROVE", []), "win32").confirm(view({ risk: "R4" }))).decision).toBe("unavailable");
    });
});
