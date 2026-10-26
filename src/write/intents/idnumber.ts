import { CampusError } from "../../errors.js";
import type { IntentContext } from "../intent.js";
import { parseFormFields } from "../web.js";

/**
 * El número de ID de grupos y agrupamientos sólo se puede fijar con moodle/course:changeidnumber; sin
 * esa capacidad el Campus lo CONGELA (sin input) y Moodle ignora el valor en silencio (hallazgo real,
 * ADR-076). Se averigua leyendo el formulario y, si no es editable, el plan se rechaza.
 */
export async function assertIdnumberEditable(ctx: IntentContext, route: "group_form_new" | "group_form_edit" | "grouping_form_new", query: Record<string, string>, qf: string, what: string) {
    const fields = parseFormFields(await ctx.web.readPage(route, query), qf);
    if (!fields) throw new CampusError("UNEXPECTED_RESPONSE", `No se reconoció el formulario de ${what}.`);
    if (!fields.some(([n]) => n === "idnumber")) {
        throw new CampusError("MOODLE_PERMISSION_DENIED", `Tu cuenta no puede fijar el número de ID de ${what} (el Campus lo bloquea: hace falta moodle/course:changeidnumber). Quitá idnumber del pedido.`);
    }
}
