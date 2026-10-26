import { spawn } from "node:child_process";
import type { MfaCodePrompt } from "./login.js";

/**
 * Diálogo nativo de Windows que pide el código de verificación que el Campus mandó por correo
 * (login web automático, ADR-088). Fuera del modelo: el agente no lo ve ni lo puede responder.
 * Mismo mecanismo que la confirmación de escrituras (WinForms vía PowerShell). Sin Windows o si
 * el diálogo no abre, devuelve null y el login termina en AUTH_REQUIRED con la instrucción de la CLI.
 */

const DIALOG = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:CAMPUS_DIALOG_B64)) | ConvertFrom-Json
$form = New-Object System.Windows.Forms.Form
$form.Text = $p.title
$form.Width = 460
$form.Height = 220
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Text = $p.body
$label.SetBounds(12, 12, 420, 60)
$form.Controls.Add($label)
$box = New-Object System.Windows.Forms.TextBox
$box.MaxLength = 6
$box.Font = New-Object System.Drawing.Font('Consolas', 16)
$box.SetBounds(12, 78, 160, 36)
$form.Controls.Add($box)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Enviar'
$ok.SetBounds(200, 120, 110, 32)
$ok.Add_Click({ $form.Tag = 'CODE:' + $box.Text; $form.Close() })
$form.Controls.Add($ok)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancelar'
$cancel.SetBounds(320, 120, 110, 32)
$cancel.Add_Click({ $form.Tag = 'CANCEL'; $form.Close() })
$form.Controls.Add($cancel)
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.ActiveControl = $box
$form.Tag = 'CANCEL'
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [int]$p.timeout_ms
$timer.Add_Tick({ $timer.Stop(); $form.Tag = 'TIMEOUT'; $form.Close() })
$timer.Start()
[void]$form.ShowDialog()
[Console]::Out.WriteLine($form.Tag)
`;

export type Spawner = typeof spawn;

/** Interpreta la última línea del diálogo: sólo «CODE:<6 dígitos>» es un código. */
export function parseDialogOutput(out: string): string | null {
    const tag = out.trim().split(/\r?\n/).pop() ?? "";
    const m = /^CODE:\s*(\d{6})\s*$/.exec(tag);
    return m ? m[1]! : null;
}

export function windowsCodePrompt(opts: { timeoutMs?: number; spawner?: Spawner; platform?: NodeJS.Platform } = {}): MfaCodePrompt {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const spawner = opts.spawner ?? spawn;
    const platform = opts.platform ?? process.platform;
    return () => {
        if (platform !== "win32") return Promise.resolve(null);
        const payload = {
            title: "Campus Virtual — código de verificación",
            body: "El Campus te mandó un código de 6 dígitos al correo para iniciar sesión (el MCP queda como dispositivo de confianza). Escribilo acá; no lo pegues en el chat.",
            timeout_ms: timeoutMs,
        };
        const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
        return new Promise((resolve) => {
            let out = "";
            let settled = false;
            const finish = (v: string | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(guard);
                resolve(v);
            };
            let child: ReturnType<Spawner>;
            try {
                child = spawner("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-Command", DIALOG], {
                    env: { ...process.env, CAMPUS_DIALOG_B64: b64 },
                    stdio: ["ignore", "pipe", "ignore"],
                    windowsHide: false,
                });
            } catch {
                resolve(null);
                return;
            }
            const guard = setTimeout(() => {
                child.kill();
                finish(null);
            }, timeoutMs + 15_000);
            child.stdout?.on("data", (d) => (out += String(d)));
            child.on("error", () => finish(null));
            child.on("close", () => finish(parseDialogOutput(out)));
        });
    };
}
