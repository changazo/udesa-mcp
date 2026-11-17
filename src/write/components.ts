import { z } from "zod";
import { CampusError } from "../errors.js";
import { checkLinkUrl } from "./html-ops.js";
import { escapeText } from "./html-patch.js";
import type { DisplayRequirement } from "./intents/html-edits.js";
import { inline, markdownToHtml } from "./text.js";

/**
 * ADR-138 · Componentes visuales con esquema cerrado. El agente elige un componente y sus textos (Markdown
 * acotado); el servidor arma el HTML con las clases de Bootstrap del tema del Campus. Nada de HTML libre.
 * Cada componente declara qué tiene que llegar a la vista de los estudiantes (`display`): Moodle limpia el HTML
 * al mostrarlo, y la verificación lo comprueba en la salida real (un componente que el Campus no muestra queda
 * `aplicado_con_diferencias`, nunca verificado).
 */

const md = z.string().min(1).max(5_000);
const short = z.string().min(1).max(200);
const url = z.string().min(8).max(1900);

export const ComponentSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("alert"), variant: z.enum(["info", "warning", "success", "danger"]).default("info"), title: short.optional(), body: md }).describe("Recuadro de aviso («Importante», «Fecha clave»)."),
    z.object({ type: z.literal("card"), title: short, body: md, link: z.object({ text: short, href: url }).optional() }).describe("Tarjeta con título, texto y un botón opcional."),
    z.object({ type: z.literal("button"), text: short, href: url, variant: z.enum(["primary", "secondary", "outline-primary"]).default("primary") }).describe("Botón que es un enlace."),
    z.object({ type: z.literal("details"), summary: short, body: md }).describe("Contenido desplegable: el título se ve y el cuerpo se abre al hacer clic."),
    z.object({ type: z.literal("columns"), left: md, right: md }).describe("Dos columnas (se apilan en pantallas angostas)."),
    z.object({ type: z.literal("table"), headers: z.array(short).min(1).max(10), rows: z.array(z.array(z.string().max(500)).min(1).max(10)).min(1).max(50), striped: z.boolean().default(true) }).describe("Tabla con encabezados (p. ej. horarios o cronograma)."),
    z.object({ type: z.literal("video"), youtube_url: url, title: short }).describe("Video de YouTube incrustado."),
]);
export type Component = z.infer<typeof ComponentSchema>;

const block = (s: string) => markdownToHtml(s);

function youtubeId(raw: string): string {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new CampusError("WRITE_NOT_ALLOWED", "La dirección del video no es válida.");
    }
    const host = u.hostname.replace(/^www\./, "");
    const id = host === "youtu.be" ? u.pathname.slice(1) : host === "youtube.com" || host === "m.youtube.com" ? (u.searchParams.get("v") ?? /^\/(?:embed|shorts)\/([^/]+)/.exec(u.pathname)?.[1] ?? "") : "";
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new CampusError("WRITE_NOT_ALLOWED", "Sólo videos de YouTube (youtube.com/watch?v=…, youtu.be/…).");
    return id;
}

/** HTML del componente y lo que tiene que verse. Todo texto pasa por el conversor (escapado). */
export function renderComponent(c: Component): { html: string; display: DisplayRequirement[]; label: string } {
    switch (c.type) {
        case "alert":
            return {
                html: `<div class="alert alert-${c.variant}" role="alert">${c.title ? `<p><strong>${inline(c.title)}</strong></p>` : ""}${block(c.body)}</div>`,
                display: [{ tag: "div", class: `alert-${c.variant}`, min: 1, label: `recuadro (div.alert-${c.variant})` }],
                label: "un recuadro de aviso",
            };
        case "card": {
            const link = c.link ? `<p><a class="btn btn-primary" href="${escapeText(checkLinkUrl(c.link.href))}">${inline(c.link.text)}</a></p>` : "";
            return {
                html: `<div class="card"><div class="card-body"><h4 class="card-title">${inline(c.title)}</h4>${block(c.body)}${link}</div></div>`,
                display: [{ tag: "div", class: "card", min: 1, label: "tarjeta (div.card)" }, { tag: "div", class: "card-body", min: 1, label: "cuerpo de la tarjeta (div.card-body)" }, ...(c.link ? [{ tag: "a", class: "btn", attr: "href", min: 1, label: "botón de la tarjeta (a.btn)" }] : [])],
                label: "una tarjeta",
            };
        }
        case "button":
            return { html: `<p><a class="btn btn-${c.variant}" href="${escapeText(checkLinkUrl(c.href))}">${inline(c.text)}</a></p>`, display: [{ tag: "a", class: `btn-${c.variant}`, attr: "href", min: 1, label: `botón (a.btn-${c.variant})` }], label: "un botón" };
        case "details":
            return { html: `<details><summary>${inline(c.summary)}</summary>${block(c.body)}</details>`, display: [{ tag: "details", min: 1, label: "desplegable (details)" }, { tag: "summary", min: 1, label: "título del desplegable (summary)" }], label: "un desplegable" };
        case "columns":
            return { html: `<div class="row"><div class="col-md-6">${block(c.left)}</div><div class="col-md-6">${block(c.right)}</div></div>`, display: [{ tag: "div", class: "row", min: 1, label: "fila de columnas (div.row)" }, { tag: "div", class: "col-md-6", min: 2, label: "dos columnas (div.col-md-6)" }], label: "dos columnas" };
        case "table": {
            if (c.rows.some((r) => r.length > c.headers.length)) throw new CampusError("WRITE_NOT_ALLOWED", "Hay filas con más celdas que encabezados.");
            const row = (r: string[]) => `<tr>${c.headers.map((_, i) => `<td>${inline(r[i] ?? "")}</td>`).join("")}</tr>`;
            return {
                html: `<table class="table${c.striped ? " table-striped" : ""}"><thead><tr>${c.headers.map((h) => `<th scope="col">${inline(h)}</th>`).join("")}</tr></thead><tbody>${c.rows.map(row).join("")}</tbody></table>`,
                display: [{ tag: "table", min: 1, label: "tabla" }, { tag: "th", min: c.headers.length, label: "encabezados (th)" }],
                label: "una tabla",
            };
        }
        case "video": {
            const id = youtubeId(c.youtube_url);
            return {
                html: `<p><iframe width="560" height="315" style="max-width: 100%;" src="https://www.youtube-nocookie.com/embed/${id}" title="${escapeText(c.title)}" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></p>`,
                display: [{ tag: "iframe", attr: "src", min: 1, label: "video incrustado (iframe)" }],
                label: "un video",
            };
        }
    }
}
