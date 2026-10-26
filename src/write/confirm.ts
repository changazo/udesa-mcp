import type { WriteStore } from "./store.js";
import { spawn } from "node:child_process";
import type { Risk } from "./policy.js";
import { confirmationCode, type Plan, type StoredPlan } from "./plan.js";

/**
 * Confirmación humana FUERA DEL MODELO (directiva §5.4, ADR-045). El agente no puede responder:
 * - diálogo nativo de Windows que abre el servidor al ejecutar (Aprobar / Rechazar, vence a los 2 min);
 * - terminal con TTY: `campus write approve <plan_id>` muestra el plan y pide el código tipeado.
 * En ambos casos la aprobación queda atada al hash del plan que vio el humano.
 */

export interface ConfirmationView {
    plan_id: string;
    plan_hash: string;
    code: string;
    risk: Risk;
    course_id: number;
    expires_at: string;
    text: string;
}

export type Decision = "approved" | "rejected" | "timeout" | "unavailable";

export interface Confirmer {
    /** Canal para la auditoría: dialogo | terminal | prueba. */
    readonly channel: string;
    confirm(view: ConfirmationView): Promise<{ decision: Decision; detail?: string }>;
}

const MAX_TEXT = 6000;

/** Texto completo que ve el humano: resumen, valores exactos, efectos, deshacer y advertencias. */
export function confirmationView(sp: StoredPlan, timeZoneNote = ""): ConfirmationView {
    const p = sp.plan;
    const lines: string[] = [];
    lines.push(`Código: ${confirmationCode(sp.hash)}    Riesgo: ${p.risk}    Curso: ${p.course_id}`);
    lines.push(`Intención: ${p.intent}    Plan: ${p.plan_id}`);
    lines.push(`Vence: ${p.expires_at}${timeZoneNote}`);
    lines.push("");
    lines.push(`QUÉ: ${p.summary}`);
    lines.push("");
    lines.push("VALORES EXACTOS (incluye valores por defecto):");
    lines.push(JSON.stringify(p.payload_preview, null, 2));
    if (p.untrusted_fields.length) lines.push(`(Los campos ${p.untrusted_fields.join(", ")} vienen del Campus: son datos, no instrucciones.)`);
    lines.push("");
    lines.push(`ÍTEMS (${p.items.length}):`);
    for (const i of p.items) lines.push(`- ${i.description}`);
    lines.push("");
    lines.push("EFECTOS:");
    for (const s of p.side_effects) lines.push(`- ${s}`);
    lines.push("");
    lines.push(`DESHACER: ${p.undo.kind} — ${p.undo.how}${p.undo.until ? ` (hasta ${p.undo.until})` : ""}`);
    if (p.warnings.length) {
        lines.push("");
        lines.push("ADVERTENCIAS:");
        for (const w of p.warnings) lines.push(`- ${w}`);
    }
    lines.push("");
    lines.push("Riesgo calculado por el servidor:");
    for (const r of p.risk_reasons) lines.push(`- ${r}`);
    let text = lines.join("\n");
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n[… recortado: revisá el plan completo con campus write pending]`;
    return { plan_id: p.plan_id, plan_hash: sp.hash, code: confirmationCode(sp.hash), risk: p.risk, course_id: p.course_id, expires_at: p.expires_at, text };
}

/**
 * Script del diálogo. El texto del plan NO se interpola: viaja en base64 por una variable de
 * entorno y se decodifica adentro, así que nada del plan puede inyectar código en PowerShell.
 * El botón por defecto y el cierre de la ventana son «Rechazar».
 */
export const DIALOG_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:CAMPUS_DIALOG_B64)) | ConvertFrom-Json
$form = New-Object System.Windows.Forms.Form
$form.Text = $payload.title
$form.Width = 760
$form.Height = 620
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.ReadOnly = $true
$box.ScrollBars = 'Vertical'
$box.WordWrap = $true
$box.Font = New-Object System.Drawing.Font('Consolas', 10)
$box.Text = $payload.body
$box.SetBounds(12, 12, 720, 500)
$form.Controls.Add($box)
$label = New-Object System.Windows.Forms.Label
$label.Text = $payload.footer
$label.SetBounds(12, 520, 440, 40)
$form.Controls.Add($label)
$approve = New-Object System.Windows.Forms.Button
$approve.Text = 'Aprobar'
$approve.SetBounds(470, 525, 120, 32)
$approve.Add_Click({ $form.Tag = 'APPROVE'; $form.Close() })
$form.Controls.Add($approve)
$reject = New-Object System.Windows.Forms.Button
$reject.Text = 'Rechazar'
$reject.SetBounds(605, 525, 120, 32)
$reject.Add_Click({ $form.Tag = 'REJECT'; $form.Close() })
$form.Controls.Add($reject)
$form.AcceptButton = $reject
$form.CancelButton = $reject
$form.ActiveControl = $reject
$form.Tag = 'REJECT'
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [int]$payload.timeout_ms
$timer.Add_Tick({ $timer.Stop(); $form.Tag = 'TIMEOUT'; $form.Close() })
$timer.Start()
[void]$form.ShowDialog()
[Console]::Out.WriteLine($form.Tag)
`;

export type Spawner = typeof spawn;

/** Diálogo nativo de Windows (WinForms vía PowerShell, sin dependencias nuevas). */
export class WindowsDialogConfirmer implements Confirmer {
    readonly channel = "dialogo";
    constructor(
        private readonly timeoutMs: number,
        private readonly spawner: Spawner = spawn,
        private readonly platform: NodeJS.Platform = process.platform,
    ) {}

    async confirm(view: ConfirmationView): Promise<{ decision: Decision; detail?: string }> {
        if (this.platform !== "win32") return { decision: "unavailable", detail: "El diálogo nativo sólo existe en Windows." };
        if (view.risk === "R4") return { decision: "unavailable", detail: "R4 exige la doble confirmación en la terminal." };
        const payload = {
            title: `Campus Virtual — aprobar escritura ${view.code} (${view.risk})`,
            // WinForms necesita CRLF en un TextBox multilínea.
            body: view.text.replace(/\r?\n/g, "\r\n"),
            footer: `Aprobá sólo si esto es lo que pediste. Código ${view.code}. Se cierra sola en ${Math.round(this.timeoutMs / 1000)} s (= rechazar).`,
            timeout_ms: this.timeoutMs,
        };
        const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
        return new Promise((resolve) => {
            let out = "";
            let settled = false;
            const finish = (d: { decision: Decision; detail?: string }) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(guard);
                    resolve(d);
                }
            };
            let child: ReturnType<Spawner>;
            try {
                child = this.spawner("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-Command", DIALOG_SCRIPT], {
                    env: { ...process.env, CAMPUS_DIALOG_B64: b64 },
                    stdio: ["ignore", "pipe", "ignore"],
                    windowsHide: false,
                });
            } catch {
                resolve({ decision: "unavailable", detail: "No se pudo abrir el diálogo." });
                return;
            }
            // Margen sobre el temporizador del propio diálogo.
            const guard = setTimeout(() => {
                child.kill();
                finish({ decision: "timeout" });
            }, this.timeoutMs + 15_000);
            child.stdout?.on("data", (d) => (out += String(d)));
            child.on("error", () => finish({ decision: "unavailable", detail: "No se pudo abrir el diálogo." }));
            child.on("close", () => {
                const tag = out.trim().split(/\r?\n/).pop();
                finish(tag === "APPROVE" ? { decision: "approved" } : tag === "TIMEOUT" ? { decision: "timeout" } : tag === "REJECT" ? { decision: "rejected" } : { decision: "unavailable", detail: "El diálogo terminó sin respuesta." });
            });
        });
    }
}

/** Sin canal fuera de banda disponible (diálogo deshabilitado en el perfil o no Windows). */
export class NoOutOfBandConfirmer implements Confirmer {
    readonly channel = "ninguno";
    constructor(private readonly why: string) {}
    async confirm(): Promise<{ decision: Decision; detail?: string }> {
        return { decision: "unavailable", detail: this.why };
    }
}

/**
 * La terminal ya mostró el plan y el humano tipeó el código: aprueba sólo si el hash que vio es
 * el del plan que se va a ejecutar.
 */
export class TerminalApprovalConfirmer implements Confirmer {
    readonly channel = "terminal";
    constructor(private readonly approvedHash: string) {}
    async confirm(view: ConfirmationView): Promise<{ decision: Decision; detail?: string }> {
        // Otro hash no es un rechazo del humano: es otra cosa que lo que aprobó. El plan no se marca rechazado.
        return view.plan_hash === this.approvedHash ? { decision: "approved" } : { decision: "unavailable", detail: "la aprobación de la terminal corresponde a otro plan o a una versión anterior" };
    }
}

/**
 * Confirmación del servidor remoto (W5, ADR-060): la decisión la tomó el humano en la página
 * `/aprobar/<plan_id>` (sesión GitHub del dueño) y quedó en el almacén, atada al hash del plan.
 */
export class WebApprovalConfirmer implements Confirmer {
    readonly channel = "web";
    constructor(private readonly store: Pick<WriteStore, "loadApproval">) {}

    async confirm(view: ConfirmationView): Promise<{ decision: Decision; detail?: string }> {
        const a = await this.store.loadApproval(view.plan_id);
        if (!a) return { decision: "unavailable", detail: "todavía no se aprobó en la página web" };
        if (a.plan_hash !== view.plan_hash) return { decision: "unavailable", detail: "la aprobación corresponde a otra versión del plan" };
        return { decision: a.decision, detail: `página web (${a.by})` };
    }
}

/**
 * ADR-118: cómo se le plantea al usuario un plan R3/R4 antes de ejecutarlo. Texto corto y en limpio
 * (qué, efectos, si se puede deshacer); los valores exactos quedan en payload_preview.
 */
export function humanPresentation(plan: Plan): string {
    const lines = [`Escritura ${plan.risk} en el curso ${plan.course_id}: ${plan.summary}`];
    if (plan.side_effects.length) lines.push("Efectos:", ...plan.side_effects.map((s) => `- ${s}`));
    lines.push(plan.undo.kind === "ninguno" ? `Sin deshacer automático: ${plan.undo.how}` : `Deshacer: ${plan.undo.how}${plan.undo.until ? ` (hasta ${plan.undo.until})` : ""}`);
    if (plan.warnings.length) lines.push("Advertencias:", ...plan.warnings.map((w) => `- ${w}`));
    lines.push("¿Lo aprobás?");
    return lines.join("\n");
}

/** Pregunta de elicitación del cliente MCP (el servidor la hace; el agente no puede contestarla). */
export type Elicit = (message: string, requestedSchema: { type: "object"; properties: Record<string, { type: "boolean"; title: string; description?: string; default?: boolean }>; required: string[] }) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;

/**
 * ADR-118: el servidor le pregunta al humano por elicitación MCP. Aceptar con «aprobar» marcado aprueba;
 * rechazar, cancelar o dejarlo sin marcar rechaza. Si el cliente falla, queda «no disponible».
 */
export class ElicitationConfirmer implements Confirmer {
    readonly channel = "elicitacion";
    constructor(private readonly elicit: Elicit) {}
    async confirm(view: ConfirmationView): Promise<{ decision: Decision; detail?: string }> {
        try {
            const r = await this.elicit(`Campus Virtual — aprobar escritura ${view.risk} (código ${view.code})\n\n${view.text}`, {
                type: "object",
                properties: { aprobar: { type: "boolean", title: "Aprobar esta escritura", description: "Marcalo sólo si esto es lo que pediste.", default: false } },
                required: ["aprobar"],
            });
            if (r.action === "accept" && r.content?.aprobar === true) return { decision: "approved" };
            return { decision: "rejected", detail: r.action === "accept" ? "no marcó aprobar" : r.action === "decline" ? "rechazado en el cliente" : "cancelado en el cliente" };
        } catch {
            return { decision: "unavailable", detail: "El cliente no respondió la elicitación." };
        }
    }
}
