import { CampusError } from "../errors.js";
import type { WebWriter } from "../write/web.js";
import { LIBRARY_RE, type SemField, translate, versioned } from "./semantics.js";

/**
 * Datos del editor H5P del Campus (ADR-110), todo por GET y en UNA operación web:
 * 1. el contexto del curso (M.cfg del formulario de alta de grupo, que no guarda nada);
 * 2. los tipos que ofrece el banco de contenido del curso (menú «Agregar», con su versión);
 * 3. la clave del AJAX del editor, abriendo el editor del tipo pedido SIN guardar;
 * 4. las bibliotecas instaladas y, a pedido, la semántica y la traducción de cada una.
 * La clave y el sesskey del editor se usan sólo en estas lecturas: no se registran ni se devuelven.
 */

export interface InstalledLibrary {
    name: string;
    major: number;
    minor: number;
}

/** Semánticas ya traducidas, por biblioteca con versión (no cambian sin actualizar la biblioteca). */
const CACHE = new Map<string, SemField[]>();

export interface H5pEditorSession {
    /** Biblioteca principal abierta en el editor (`H5P.QuestionSet 1.21`). */
    main: string;
    installed: InstalledLibrary[];
    /** Versión instalada más nueva de una biblioteca, o null. */
    latest(machine: string): string | null;
    semantics(library: string): SemField[] | undefined;
    load(libraries: readonly string[]): Promise<void>;
}

const unescapeJson = (s: string) => s.replace(/\\\//g, "/").replace(/&amp;/g, "&");

/** Tipos H5P que ofrece el banco de contenido (enlaces del menú «Agregar»). */
export function offeredLibraries(html: string): string[] {
    const out = new Set<string>();
    for (const m of html.matchAll(/contentbank\/edit\.php\?[^"']*?library=([^"'&]+)/g)) {
        const lib = decodeURIComponent(m[1]!.replace(/\+/g, " "));
        if (LIBRARY_RE.test(lib)) out.add(lib);
    }
    return [...out];
}

/**
 * Abre el editor del tipo `machine` (la versión que ofrece el banco de contenido del curso) y entrega
 * una sesión para cargar semánticas; `fn` corre dentro de la operación web.
 */
export async function withH5pEditor<T>(web: WebWriter, courseId: number, machine: string, fn: (ed: H5pEditorSession) => Promise<T>): Promise<T> {
    return web.readPages(async (get) => {
        const groupPage = await get("group_form_new", { courseid: String(courseId) });
        const contextId = /"contextid":(\d+)/.exec(groupPage)?.[1];
        if (!contextId) throw new CampusError("UNEXPECTED_RESPONSE", "No se pudo obtener el contexto del curso para el editor H5P.");
        const offered = offeredLibraries(await get("h5p_contentbank", { contextid: contextId }));
        const mainLibrary = offered.filter((l) => l.split(" ")[0] === machine).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
        if (!mainLibrary) throw new CampusError("WRITE_NOT_ALLOWED", `El banco de contenido del curso no ofrece ${machine} (${offered.length} tipos disponibles).`);
        const editor = await get("h5p_editor", { contextid: contextId, plugin: "h5p", library: mainLibrary });
        const ajax = /"ajaxPath":"([^"]+)"/.exec(editor)?.[1];
        const q = ajax ? new URL(unescapeJson(ajax)).searchParams : null;
        const sesskey = q?.get("sesskey");
        const token = q?.get("token");
        if (!sesskey || !token) throw new CampusError("MOODLE_PERMISSION_DENIED", "El Campus no abrió el editor H5P del banco de contenido para esta cuenta (hace falta poder crear contenido H5P en el curso).");
        const parse = (raw: string, what: string): unknown => {
            try {
                return JSON.parse(raw);
            } catch {
                throw new CampusError("UNEXPECTED_RESPONSE", `Respuesta no interpretable del editor H5P (${what}).`);
            }
        };
        const list = parse(await get("h5p_libraries", { sesskey, token, action: "libraries" }), "bibliotecas");
        if (!Array.isArray(list)) throw new CampusError("UNEXPECTED_RESPONSE", "El editor H5P no devolvió la lista de bibliotecas.");
        const installed: InstalledLibrary[] = list
            .map((l: { name?: unknown; majorVersion?: unknown; minorVersion?: unknown }) => ({ name: String(l.name ?? ""), major: Number(l.majorVersion), minor: Number(l.minorVersion) }))
            .filter((l) => LIBRARY_RE.test(versioned(l.name, l.major, l.minor)));
        const session: H5pEditorSession = {
            main: mainLibrary,
            installed,
            latest(machine) {
                const hits = installed.filter((l) => l.name === machine).sort((a, b) => b.major - a.major || b.minor - a.minor);
                return hits.length ? versioned(machine, hits[0]!.major, hits[0]!.minor) : null;
            },
            semantics: (library) => CACHE.get(library),
            async load(libraries) {
                for (const lib of libraries) {
                    if (CACHE.has(lib)) continue;
                    const [name, ver] = lib.split(" ");
                    const [major, minor] = ver!.split(".");
                    // La lista del editor sólo trae los tipos ejecutables; las subbibliotecas (AdvancedText, Column…) se piden igual.
                    const j = (parse(await get("h5p_library", { sesskey, token, action: "libraries", machineName: name!, majorVersion: major!, minorVersion: minor! }), lib) ?? {}) as { semantics?: unknown; language?: unknown };
                    const sem = typeof j.semantics === "string" ? parse(j.semantics, lib) : j.semantics;
                    if (!Array.isArray(sem)) throw new CampusError("WRITE_NOT_ALLOWED", `${lib} no está instalada en el Campus (el editor H5P no devolvió su semántica).`);
                    let tr: { semantics?: unknown } | null = null;
                    try {
                        tr = typeof j.language === "string" ? (JSON.parse(j.language) as { semantics?: unknown }) : null;
                    } catch {
                        tr = null; // sin traducción: quedan los textos por defecto de la biblioteca
                    }
                    CACHE.set(lib, translate(sem as SemField[], tr?.semantics));
                }
            },
        };
        return fn(session);
    });
}

/** Sólo para tests: vacía la caché de semánticas. */
export function clearH5pCache() {
    CACHE.clear();
}
