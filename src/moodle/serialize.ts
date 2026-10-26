/**
 * Serializa parámetros anidados al formato de formulario que espera el REST de Moodle:
 * { courseids: [5] } → courseids[0]=5; { options: [{ name: "x", value: 1 }] } → options[0][name]=x…
 */
export type ParamValue = string | number | boolean | ParamValue[] | { [k: string]: ParamValue };

export function flattenParams(params: Record<string, ParamValue>): [string, string][] {
    const out: [string, string][] = [];
    const walk = (key: string, value: ParamValue) => {
        if (Array.isArray(value)) {
            value.forEach((v, i) => walk(`${key}[${i}]`, v));
        } else if (value !== null && typeof value === "object") {
            for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
        } else if (typeof value === "boolean") {
            out.push([key, value ? "1" : "0"]);
        } else if (typeof value === "number") {
            if (!Number.isFinite(value)) throw new Error(`Parámetro numérico inválido en ${key}`);
            out.push([key, String(value)]);
        } else {
            out.push([key, value]);
        }
    };
    for (const [k, v] of Object.entries(params)) walk(k, v);
    return out;
}

/** Nombre raíz de un parámetro serializado: "options[0][name]" → "options". */
export const rootName = (key: string) => key.split("[")[0] ?? key;
