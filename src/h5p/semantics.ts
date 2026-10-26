import { randomUUID } from "node:crypto";
import { CampusError } from "../errors.js";
import { writeZip } from "./zip.js";

/**
 * Semántica de bibliotecas H5P (ADR-110). El Campus la sirve por el AJAX del editor, con la traducción
 * al castellano. Con ella se completan los valores por defecto (textos de la interfaz incluidos) y se
 * valida el contenido generado antes de armar el paquete: un campo desconocido, de otro tipo o una
 * subbiblioteca que la semántica no admite frenan el plan. Como el validador de H5P del Campus, no se
 * exigen los mínimos de las listas ni los campos que el reproductor completa solo (los paquetes así
 * se aceptaron y se desplegaron en real); los mínimos de lo que importa los fija el esquema tipado.
 */

export interface SemField {
    name: string;
    type: string;
    label?: string;
    optional?: boolean;
    default?: unknown;
    fields?: SemField[];
    field?: SemField;
    options?: unknown[];
    min?: number;
    max?: number;
    maxLength?: number;
    regexp?: { pattern: string; modifiers?: string };
}

/** Biblioteca instalada: nombre y versión (`H5P.MultiChoice 1.16`). */
export const versioned = (name: string, major: number, minor: number) => `${name} ${major}.${minor}`;
export const machineOf = (lib: string) => lib.split(" ")[0]!;
export const LIBRARY_RE = /^H5P\.[A-Za-z0-9]{1,60} \d{1,4}\.\d{1,4}$/;

/** Superpone la traducción (misma forma que la semántica): etiquetas y valores por defecto. */
export function translate(sem: SemField[], tr: unknown): SemField[] {
    const list = Array.isArray(tr) ? tr : [];
    return sem.map((f, i) => {
        const t = list[i] as Partial<SemField> | undefined;
        if (!t || typeof t !== "object") return f;
        const out: SemField = { ...f, ...(t.default !== undefined && f.type !== "library" ? { default: t.default } : {}), ...(typeof t.label === "string" ? { label: t.label } : {}) };
        if (f.fields) out.fields = translate(f.fields, t.fields);
        if (f.field) out.field = translate([f.field], [t.field])[0];
        return out;
    });
}

/** Valor por defecto de un campo (las listas arrancan vacías; bibliotecas y medios, sin valor). */
function defaultOf(f: SemField): unknown {
    switch (f.type) {
        case "group": {
            // H5P: un grupo con un solo campo guarda directamente el valor de ese campo.
            if (f.fields!.length === 1) return defaultOf(f.fields![0]!);
            const o: Record<string, unknown> = {};
            for (const c of f.fields!) {
                const v = defaultOf(c);
                if (v !== undefined) o[c.name] = v;
            }
            return o;
        }
        case "list":
            return [];
        case "library":
        case "image":
        case "video":
        case "audio":
        case "file":
            return undefined;
        default:
            return f.default;
    }
}

export function defaultsOf(sem: SemField[]): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const f of sem) {
        const v = defaultOf(f);
        if (v !== undefined) o[f.name] = v;
    }
    return o;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Mezcla profunda de objetos; las listas y los valores simples se reemplazan. */
export function merge(base: unknown, over: unknown): unknown {
    if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
    return out;
}

/** Proveedor de semántica (ya traducida) por biblioteca con versión; undefined si no se cargó. */
export type SemanticsSource = (library: string) => SemField[] | undefined;

/** Bibliotecas que faltan cargar (se completan y se vuelve a armar). */
export class MissingLibraries extends Error {
    constructor(readonly libraries: string[]) {
        super(`Faltan semánticas: ${libraries.join(", ")}`);
    }
}

export interface SubContent {
    library: string;
    params: Record<string, unknown>;
    subContentId: string;
    metadata: { contentType: string; license: string; title: string };
}

/** Arma subcontenidos con valores por defecto de su semántica; anota las bibliotecas que faltan. */
export class ContentFactory {
    readonly missing = new Set<string>();
    constructor(private readonly sem: SemanticsSource) {}

    semantics(library: string): SemField[] {
        // `X 0.0`: versión provisional mientras falta la semántica del padre (se rearma después).
        if (library.endsWith(" 0.0")) return [];
        const s = this.sem(library);
        if (!s) this.missing.add(library);
        return s ?? [];
    }

    params(library: string, params: Record<string, unknown>): Record<string, unknown> {
        return merge(defaultsOf(this.semantics(library)), params) as Record<string, unknown>;
    }

    lib(library: string, params: Record<string, unknown>, title: string): SubContent {
        return { library, params: this.params(library, params), subContentId: randomUUID(), metadata: { contentType: machineOf(library).replace(/^H5P\./, ""), license: "U", title: title.slice(0, 255) || "Contenido" } };
    }

    /** Versión de una subbiblioteca que admite un campo `library` de la semántica del padre. */
    option(parent: string, path: string[], machine: string): string {
        const sem = this.semantics(parent);
        if (!sem.length) return `${machine} 0.0`;
        let fields: SemField[] = sem;
        let f: SemField | undefined;
        for (const name of path) {
            f = fields.find((x) => x.name === name);
            if (!f) throw new CampusError("UNEXPECTED_RESPONSE", `${parent}: la semántica no tiene ${path.join(".")}.`);
            while (f.type === "list" && f.field) f = f.field;
            fields = f.fields ?? [];
        }
        const opts = (f?.options ?? []).filter((o): o is string => typeof o === "string");
        const hit = opts.filter((o) => machineOf(o) === machine).sort().pop();
        if (!hit) throw new CampusError("WRITE_NOT_ALLOWED", `${parent} no admite ${machine} en ${path.join(".")} en el Campus.`);
        return hit;
    }
}

// ---------- valores por defecto en profundidad ----------

function fillField(f: SemField, v: unknown, sem: SemanticsSource): unknown {
    if (v === undefined || v === null) return v;
    switch (f.type) {
        case "group":
            if (f.fields!.length === 1) return fillField(f.fields![0]!, v, sem);
            return isObj(v) ? fillFields(f.fields!, v, sem) : v;
        case "list":
            return Array.isArray(v) ? v.map((x) => fillField(f.field!, x, sem)) : v;
        case "library": {
            if (!isObj(v) || typeof v.library !== "string" || !isObj(v.params)) return v;
            const s = sem(v.library);
            return s ? { ...v, params: fillFields(s, v.params, sem) } : v;
        }
        default:
            return v;
    }
}

function fillFields(fields: SemField[], obj: Record<string, unknown>, sem: SemanticsSource): Record<string, unknown> {
    const out: Record<string, unknown> = { ...obj };
    for (const f of fields) {
        // Un campo opcional ausente queda ausente (crearlo vacío dejaría obligatorios sin valor).
        if (out[f.name] === undefined && !f.optional) {
            const d = defaultOf(f);
            if (d !== undefined) out[f.name] = d;
        }
        out[f.name] = fillField(f, out[f.name], sem);
        if (out[f.name] === undefined) delete out[f.name];
    }
    return out;
}

/**
 * Completa los valores por defecto en TODO el árbol (elementos de listas y subcontenidos), como el
 * editor H5P: algunos reproductores leen grupos que el contenido no trae (p. ej. `feedback` de cada
 * nodo de un Branching Scenario) y fallan si faltan.
 */
export function fillDefaults(library: string, params: Record<string, unknown>, sem: SemanticsSource): Record<string, unknown> {
    const s = sem(library);
    return s ? fillFields(s, params, sem) : params;
}

// ---------- validación ----------

function optionValues(f: SemField): unknown[] {
    return (f.options ?? []).map((o) => (isObj(o) ? o.value : o));
}

function validateField(f: SemField, v: unknown, path: string, sem: SemanticsSource, errs: string[]) {
    if (errs.length > 20) return;
    // Un campo opcional o con valor por defecto nulo puede quedar en null.
    if (v === null && (f.optional || f.default === null)) return;
    switch (f.type) {
        case "group": {
            if (f.fields!.length === 1) return validateField(f.fields![0]!, v, path, sem, errs);
            if (!isObj(v)) return void errs.push(`${path}: se esperaba un grupo.`);
            validateFields(f.fields!, v, path, sem, errs);
            return;
        }
        case "list": {
            if (!Array.isArray(v)) return void errs.push(`${path}: se esperaba una lista.`);
            if (f.max !== undefined && v.length > f.max) errs.push(`${path}: como mucho ${f.max} elemento(s).`);
            v.forEach((x, i) => validateField(f.field!, x, `${path}[${i}]`, sem, errs));
            return;
        }
        case "text":
            if (typeof v !== "string") return void errs.push(`${path}: se esperaba texto.`);
            if (f.maxLength !== undefined && v.length > f.maxLength) errs.push(`${path}: más de ${f.maxLength} caracteres.`);
            if (f.regexp?.pattern && v !== "") {
                let re: RegExp | null = null;
                try {
                    re = new RegExp(f.regexp.pattern, (f.regexp.modifiers ?? "").replace(/[^imsu]/g, ""));
                } catch {
                    re = null; // patrón que JavaScript no entiende: no se valida
                }
                if (re && !re.test(v)) errs.push(`${path}: «${v.slice(0, 40)}» no tiene el formato esperado.`);
            }
            return;
        case "number":
            if (typeof v !== "number" || !Number.isFinite(v)) return void errs.push(`${path}: se esperaba un número.`);
            if (f.min !== undefined && v < f.min) errs.push(`${path}: menor que ${f.min}.`);
            if (f.max !== undefined && v > f.max) errs.push(`${path}: mayor que ${f.max}.`);
            return;
        case "boolean":
            if (typeof v !== "boolean") errs.push(`${path}: se esperaba verdadero o falso.`);
            return;
        case "select": {
            const ok = optionValues(f);
            if (ok.length && !ok.includes(v)) errs.push(`${path}: valor ${JSON.stringify(v)} no admitido.`);
            return;
        }
        case "library": {
            if (!isObj(v) || typeof v.library !== "string" || !isObj(v.params)) return void errs.push(`${path}: se esperaba un subcontenido.`);
            if (!optionValues(f).includes(v.library)) return void errs.push(`${path}: ${v.library} no está entre las bibliotecas admitidas.`);
            const s = sem(v.library);
            if (!s) return void errs.push(`${path}: falta la semántica de ${v.library}.`);
            validateFields(s, v.params, `${path}<${machineOf(v.library)}>`, sem, errs);
            return;
        }
        default:
            // image, video, audio, file: estructuras de archivo; las arma el generador.
            return;
    }
}

function validateFields(fields: SemField[], obj: Record<string, unknown>, path: string, sem: SemanticsSource, errs: string[]) {
    for (const k of Object.keys(obj)) if (!fields.some((f) => f.name === k)) errs.push(`${path}.${k}: campo desconocido para esta versión.`);
    for (const f of fields) {
        const v = obj[f.name];
        if (v === undefined) {
            if (!f.optional && (f.type === "text" || f.type === "number") && f.default === undefined) errs.push(`${path}.${f.name}: falta.`);
            continue;
        }
        validateField(f, v, `${path}.${f.name}`, sem, errs);
    }
}

/** Valida los parámetros de una biblioteca contra su semántica (recursivo en subcontenidos). */
export function validateParams(library: string, params: Record<string, unknown>, sem: SemanticsSource): string[] {
    const s = sem(library);
    if (!s) return [`Falta la semántica de ${library}.`];
    const errs: string[] = [];
    validateFields(s, params, machineOf(library), sem, errs);
    return errs.slice(0, 20);
}

function librariesIn(x: unknown, acc = new Set<string>()): Set<string> {
    if (Array.isArray(x)) for (const y of x) librariesIn(y, acc);
    else if (isObj(x)) {
        if (typeof x.library === "string" && LIBRARY_RE.test(x.library)) acc.add(x.library);
        for (const v of Object.values(x)) librariesIn(v, acc);
    }
    return acc;
}

/**
 * Paquete .h5p SIN bibliotecas: `h5p.json` (biblioteca principal y dependencias) y
 * `content/content.json`. El Campus completa las bibliotecas instaladas al desplegarlo.
 */
/** Archivo del paquete con el esquema tipado que lo generó (ADR-114): permite editarlo sin rehacerlo. */
export const MCP_SPEC_PATH = "content/mcp-spec.json";

export function buildPackage(mainLibrary: string, params: Record<string, unknown>, title: string, spec?: unknown): { data: Buffer; libraries: string[] } {
    const libs = [mainLibrary, ...[...librariesIn(params)].filter((l) => l !== mainLibrary).sort()];
    const deps = libs.map((l) => {
        const [name, ver] = l.split(" ");
        const [major, minor] = ver!.split(".").map(Number);
        return { machineName: name, majorVersion: major, minorVersion: minor };
    });
    const h5p = { title: title.slice(0, 255), language: "es", defaultLanguage: "es", mainLibrary: machineOf(mainLibrary), embedTypes: ["iframe"], license: "U", preloadedDependencies: deps };
    const entries: [string, string][] = [["h5p.json", JSON.stringify(h5p)], ["content/content.json", JSON.stringify(params)]];
    if (spec !== undefined) entries.push([MCP_SPEC_PATH, JSON.stringify({ v: 1, generator: "udesa-campus-mcp", content: spec })]);
    return { data: writeZip(entries), libraries: libs };
}
