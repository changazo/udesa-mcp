import { CampusError } from "../../errors.js";
import type { IntentContext } from "../intent.js";
import { parseFormFields } from "../web.js";

/**
 * Lectura del formulario de edición de una actividad (`/course/modedit.php?update=<cmid>`, ruta
 * `modedit_form`; ADR-077): los valores actuales tal como los reenviaría el navegador. Sirve para los
 * tipos sin función de lectura con descripción (carpetas, libros, wikis, consultas…).
 */
export async function readModForm(ctx: IntentContext, cmid: number, modname: string): Promise<[string, string][]> {
    const fields = parseFormFields(await ctx.web.readPage("modedit_form", { update: String(cmid) }), `_qf__mod_${modname}_mod_form`);
    if (!fields) throw new CampusError("UNEXPECTED_RESPONSE", `No se reconoció el formulario de edición de la actividad ${cmid} (${modname}).`);
    return fields;
}

export const fieldOf = (fields: [string, string][], name: string) => fields.find(([n]) => n === name)?.[1];

/**
 * Valores que ofrece el selector `<select name="…">` de un formulario (las opciones, no el valor actual).
 * Sin ese selector devuelve []: quien llama tiene que fallar cerrado. Sólo mira el control con ese nombre
 * exacto (`display` no coincide con `displayopt[…]`).
 */
export function offeredOptions(html: string, field: string): string[] {
    const select = new RegExp(`<select\\b[^>]*\\bname="${field}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? "";
    return [...select.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map((o) => o[1]!);
}

/**
 * Las imágenes de un editor llegan apuntando a un borrador NUEVO en cada apertura del formulario: se
 * normalizan para que dos lecturas iguales comparen igual.
 */
export const stableHtml = (html: string) => html.replace(/https?:\/\/[^"'\s]*\/draftfile\.php\/\d+\/user\/draft\/\d+\//g, "@@PLUGINFILE@@/");
