import { z } from "zod";
import { CampusError } from "../errors.js";
import { toHtml, type CodeBlocks } from "../write/text.js";
import { type ContentFactory, type SubContent, machineOf } from "./semantics.js";

/**
 * Tipos de contenido H5P que el MCP sabe armar (ADR-110). Cada uno tiene un esquema propio: nada de
 * parámetros H5P crudos. El texto con formato es Markdown y se convierte a HTML; las respuestas y
 * opciones son texto plano (se escapan). Las versiones de las subbibliotecas salen de la semántica
 * del padre en el Campus, así el contenido coincide con lo instalado.
 */

const md = (max: number) => z.string().trim().min(1).max(max);
const plain = (max: number) => z.string().trim().min(1).max(max);
const marked = (max: number) =>
    plain(max).refine((s) => /\*[^*\n]+\*/.test(s), { message: "Marcá al menos una palabra entre asteriscos, como *esta*." });

const MultipleChoice = z.strictObject({
    kind: z.literal("multiple_choice"),
    question: md(4000).describe("Enunciado (Markdown)."),
    answers: z
        .array(z.strictObject({ text: plain(1000), correct: z.boolean(), feedback: plain(1000).optional().describe("Devolución al elegirla.") }))
        .min(2)
        .max(12)
        .refine((a) => a.some((x) => x.correct), { message: "Al menos una opción correcta." }),
    randomize: z.boolean().optional().describe("Mezclar las opciones (por defecto sí)."),
});
const TrueFalse = z.strictObject({
    kind: z.literal("true_false"),
    question: md(4000),
    correct: z.boolean(),
    feedback_correct: plain(1000).optional(),
    feedback_wrong: plain(1000).optional(),
});
const DragWords = z.strictObject({
    kind: z.literal("drag_words"),
    task: md(2000).describe("Consigna (Markdown)."),
    text: marked(8000).describe("Texto con las palabras para arrastrar entre asteriscos: «El *precio* sube.»."),
    distractors: z.array(plain(100)).max(20).optional().describe("Palabras de más, que no van en ningún lugar."),
});
const FillBlanks = z.strictObject({
    kind: z.literal("fill_blanks"),
    task: md(2000).optional(),
    lines: z.array(marked(2000)).min(1).max(31).describe("Oraciones con la respuesta entre asteriscos; varias respuestas válidas con barra: *gato/felino*."),
    case_sensitive: z.boolean().optional(),
});
export const QuestionSpec = z.discriminatedUnion("kind", [MultipleChoice, TrueFalse, DragWords, FillBlanks]);
const TextBlock = z.strictObject({ kind: z.literal("text"), markdown: md(20000) });
export const BlockSpec = z.discriminatedUnion("kind", [TextBlock, MultipleChoice, TrueFalse, DragWords, FillBlanks]);
type Question = z.infer<typeof QuestionSpec>;
type Block = z.infer<typeof BlockSpec>;

const QuestionSetSpec = z.strictObject({
    type: z.literal("question_set"),
    intro: z.strictObject({ title: plain(255).optional(), text: md(4000).optional() }).optional().describe("Pantalla de inicio (si se indica)."),
    questions: z.array(QuestionSpec).min(1).max(50),
    pass_percentage: z.number().int().min(0).max(100).optional(),
    randomize: z.boolean().optional().describe("Orden aleatorio de las preguntas."),
    pool_size: z.number().int().min(1).max(50).optional().describe("Mostrar sólo N preguntas al azar."),
    show_solutions: z.boolean().optional().describe("Botón para ver las soluciones al final (por defecto sí)."),
    allow_retry: z.boolean().optional().describe("Botón para reintentar al final (por defecto sí)."),
});
const CoursePresentationSpec = z.strictObject({
    type: z.literal("course_presentation"),
    slides: z
        .array(z.strictObject({ title: plain(100).optional().describe("Título en el índice de diapositivas."), blocks: z.array(BlockSpec).min(1).max(3).describe("Hasta 3 bloques, apilados de arriba abajo.") }))
        .min(1)
        .max(60),
});
const InteractiveBookSpec = z.strictObject({
    type: z.literal("interactive_book"),
    cover: md(4000).optional().describe("Portada con esta descripción (si se indica)."),
    chapters: z.array(z.strictObject({ title: plain(255), blocks: z.array(BlockSpec).min(1).max(30) })).min(1).max(40),
});
const InteractiveVideoSpec = z.strictObject({
    type: z.literal("interactive_video"),
    video_url: z.string().trim().url().max(1000).describe("YouTube (youtube.com/watch?v=… o youtu.be/…) o un archivo https .mp4/.webm."),
    start_description: plain(255).optional(),
    interactions: z
        .array(
            z.strictObject({
                at_seconds: z.number().int().min(0).max(86_400),
                until_seconds: z.number().int().min(1).max(86_400).optional().describe("Hasta cuándo se ve (por defecto, 10 s después)."),
                question: QuestionSpec,
                display: z.enum(["poster", "button"]).optional().describe("poster: la pregunta tapa el video (por defecto); button: aparece un botón."),
                pause: z.boolean().optional().describe("Pausar el video (por defecto sí)."),
            }),
        )
        .max(60),
    bookmarks: z.array(z.strictObject({ at_seconds: z.number().int().min(0).max(86_400), label: plain(100) })).max(60).optional(),
    summary: z
        .array(z.strictObject({ correct: plain(500), wrong: z.array(plain(500)).min(1).max(5) }))
        .min(1)
        .max(10)
        .optional()
        .describe("Resumen final: en cada grupo, elegir la afirmación correcta."),
});

const nodeId = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/, "id: minúsculas, números, guiones (hasta 40)");
const target = z.union([nodeId, z.literal("end")]);
const EndSpec = z.strictObject({ title: plain(255), subtitle: plain(1000).optional(), score: z.number().int().min(0).max(1000).optional() }).describe("Final, cuando next es «end».");
const BranchingScenarioSpec = z.strictObject({
    type: z.literal("branching_scenario"),
    title: plain(255),
    start: z.strictObject({ title: plain(255), subtitle: plain(1000).optional() }).optional().describe("Pantalla de inicio."),
    default_end: z.strictObject({ title: plain(255), subtitle: plain(1000).optional() }).optional().describe("Pantalla final por defecto."),
    nodes: z
        .array(
            z.discriminatedUnion("kind", [
                z.strictObject({ kind: z.literal("text"), id: nodeId, markdown: md(20000), next: target, end: EndSpec.optional() }),
                z.strictObject({ kind: z.literal("choice"), id: nodeId, question: md(2000), options: z.array(z.strictObject({ text: plain(500), next: target, end: EndSpec.optional() })).min(2).max(10) }),
            ]),
        )
        .min(1)
        .max(100)
        .describe("El primero es el inicio. text: lectura con next; choice: decisión con options. next es el id de otro nodo o «end» (con su end opcional)."),
});
const DialogCardsSpec = z.strictObject({
    type: z.literal("dialog_cards"),
    title: plain(255).optional(),
    description: md(2000).optional(),
    mode: z.enum(["normal", "repetition"]).optional().describe("repetition: repaso espaciado (las que se fallan vuelven)."),
    randomize: z.boolean().optional(),
    cards: z.array(z.strictObject({ front: plain(1000), back: plain(2000), tip_front: plain(500).optional(), tip_back: plain(500).optional() })).min(1).max(100),
});
const ChartSpec = z.strictObject({
    type: z.literal("chart"),
    chart_type: z.enum(["bar", "pie"]),
    title: plain(255).describe("Título o descripción del gráfico (también es el texto accesible)."),
    items: z.array(z.strictObject({ label: plain(100), value: z.number().positive().max(1e12), color: z.string().regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/).optional() })).min(1).max(30),
});
const date = z.string().trim().regex(/^-?\d{1,6}(-(0?[1-9]|1[0-2])(-(0?[1-9]|[12]\d|3[01]))?)?$/, "Fecha AAAA, AAAA-MM o AAAA-MM-DD");
const TimelineSpec = z.strictObject({
    type: z.literal("timeline"),
    title: plain(255),
    description: md(4000).optional(),
    events: z.array(z.strictObject({ date, end_date: date.optional(), title: plain(255), text: md(4000).optional(), tag: plain(50).optional(), media_url: z.string().trim().url().max(1000).optional().describe("Imagen o video (YouTube, Vimeo…) por URL https.") })).min(1).max(200),
    eras: z.array(z.strictObject({ start: date, end: date, title: plain(255) })).max(30).optional(),
});
const AccordionSpec = z.strictObject({
    type: z.literal("accordion"),
    panels: z.array(z.strictObject({ title: plain(255), markdown: md(20000) })).min(1).max(50),
    heading: z.enum(["h2", "h3", "h4"]).optional(),
});

export const PythonExerciseSpec = z.strictObject({
    type: z.literal("python_exercise"),
    title: plain(200),
    statement: plain(8000).describe("Consigna en texto plano; `entre comillas invertidas` se muestra como código."),
    function_name: z.string().regex(/^[A-Za-z_]\w{0,60}$/, "Nombre de función de Python"),
    starter_code: z.string().max(20000).optional().describe("Código inicial del editor."),
    tests: z
        .array(z.strictObject({ input: z.string().max(2000).describe("Argumentos de la llamada como en Python: «2, 3» o «[1, 2]»."), expected: z.string().min(1).max(2000).describe("Resultado esperado como literal de Python: «6», «'hola'», «[1, 2]»."), hidden: z.boolean().optional().describe("Oculta argumentos y resultado (sólo dice si pasó).") }))
        .min(1)
        .max(50),
    height_px: z.number().int().min(300).max(2000).optional().describe("Alto del marco (por defecto 650)."),
});

/** Largo máximo de la dirección de un recurso incrustado. */
const EMBED_MAX_URL = 5600;
const embedHeight = z.number().int().min(350).max(1600);

/**
 * Recurso incrustado genérico (H5P.IFrameEmbed): cualquier página https, para insertar en el curso contenido de
 * otro sitio (simuladores, visualizaciones, documentos). El sitio controla lo que se ve; el plan lo advierte.
 */
const IframeEmbedSpec = z.strictObject({
    type: z.literal("iframe_embed"),
    source_url: z.string().trim().min(1).max(EMBED_MAX_URL).describe("Dirección https de la página a incrustar (cualquier sitio, sin usuario ni contraseña)."),
    height_px: embedHeight.optional().describe("Alto del marco (por defecto 760)."),
    min_width_px: z.number().int().min(250).max(800).optional().describe("Ancho mínimo (por defecto 300)."),
    resize_supported: z.boolean().optional().describe("Sólo si la página informa su altura a H5P (por defecto no)."),
});

export const H5pContentSpec = z.discriminatedUnion("type", [QuestionSetSpec, CoursePresentationSpec, InteractiveBookSpec, InteractiveVideoSpec, BranchingScenarioSpec, DialogCardsSpec, ChartSpec, TimelineSpec, AccordionSpec, PythonExerciseSpec, IframeEmbedSpec]);
export type H5pContent = z.infer<typeof H5pContentSpec>;

/** Biblioteca principal y versión mayor admitida por tipo (los parámetros dependen de la versión mayor). */
export const MAIN_LIBRARY: Record<H5pContent["type"], { machine: string; major: number; label: string }> = {
    question_set: { machine: "H5P.QuestionSet", major: 1, label: "Question Set" },
    course_presentation: { machine: "H5P.CoursePresentation", major: 1, label: "Course Presentation" },
    interactive_book: { machine: "H5P.InteractiveBook", major: 1, label: "Interactive Book" },
    interactive_video: { machine: "H5P.InteractiveVideo", major: 1, label: "Interactive Video" },
    branching_scenario: { machine: "H5P.BranchingScenario", major: 1, label: "Branching Scenario" },
    dialog_cards: { machine: "H5P.Dialogcards", major: 1, label: "Dialog Cards" },
    chart: { machine: "H5P.Chart", major: 1, label: "Chart" },
    timeline: { machine: "H5P.Timeline", major: 1, label: "Timeline" },
    accordion: { machine: "H5P.Accordion", major: 1, label: "Accordion" },
    python_exercise: { machine: "H5P.IFrameEmbed", major: 1, label: "Ejercicio de Python (Iframe Embedder)" },
    iframe_embed: { machine: "H5P.IFrameEmbed", major: 1, label: "Recurso incrustado (Iframe Embedder)" },
};

/**
 * Dirección de un recurso incrustado: cualquier página https, sin usuario ni contraseña. Devuelve el texto que se
 * guarda en `source`. El Iframe Embedder de H5P lo lee como HTML (DOMParser) y le aplica `encodeURI` al cargarlo:
 * por eso se guarda sin codificar (`decodeURI`) y se exige que `encodeURI` lo devuelva idéntico. Una dirección con
 * escapes que ese paso alteraría (como `%26` o `%23`), o con `<`, `>` o comillas, se rechaza en vez de romperse.
 */
export function embedSource(raw: string): string {
    if (raw.length > EMBED_MAX_URL) throw new CampusError("WRITE_NOT_ALLOWED", `La dirección del recurso supera ${EMBED_MAX_URL} caracteres.`);
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new CampusError("WRITE_NOT_ALLOWED", "La dirección del recurso no es válida.");
    }
    if (u.protocol !== "https:") throw new CampusError("WRITE_NOT_ALLOWED", "El recurso incrustado tiene que ser https.");
    if (u.username || u.password) throw new CampusError("WRITE_NOT_ALLOWED", "La dirección del recurso no puede llevar usuario ni contraseña.");
    let source: string;
    try {
        source = decodeURI(u.href);
    } catch {
        throw new CampusError("WRITE_NOT_ALLOWED", "La dirección del recurso tiene escapes inválidos.");
    }
    // Los caracteres de control (como %0D o %00) los alteraría el DOMParser: se rechazan.
    if (/[<>"\u0000-\u001f\u007f]/.test(source) || encodeURI(source) !== u.href) throw new CampusError("WRITE_NOT_ALLOWED", "El Iframe Embedder de H5P alteraría esta dirección al cargarla (escapes de caracteres reservados como %26, %23, %3A o %2F, caracteres de control, o < > \"). Usá otra forma de la dirección, o un enlace de Moodle con display: embed.");
    return source;
}

/** Advertencias propias del contenido, para el plan. */
export function contentWarnings(spec: H5pContent): string[] {
    if (spec.type !== "iframe_embed") return [];
    return [
        `Incrusta una página de ${new URL(spec.source_url).origin}: ese sitio controla lo que se ve, puede ejecutar scripts dentro del marco y cambiar o dejar de estar disponible. Puede bloquear la incrustación (X-Frame-Options o frame-ancestors).`,
        "La página incrustada no recibe la identidad del estudiante ni devuelve intentos o progreso al Campus.",
    ];
}


/**
 * Laboratorio de mini-aplicaciones (ADR-116): proyecto de Vercel aparte, sólo incrustable desde el Campus.
 * La configuración viaja en el fragmento de la URL (no llega al servidor) y no lleva datos personales.
 */
export const LAB_BASE_URL = (process.env.CAMPUS_LAB_BASE_URL || "https://udesa-campus-lab.vercel.app").replace(/\/+$/, "");
/** Clave de consumidor LTI 1.1 del laboratorio (el secreto compartido va sólo en el entorno: CAMPUS_LAB_LTI11_SECRET). */
export const LAB_LTI11_KEY = process.env.CAMPUS_LAB_LTI11_KEY || "udesa-lab";

/** Configuración del ejercicio en base64url (fragmento de la mini-app o parámetro personalizado LTI). */
export function pythonExerciseConfig(spec: { title: string; statement: string; function_name: string; starter_code?: string | undefined; tests: { input: string; expected: string; hidden?: boolean | undefined }[] }): string {
    const cfg = { v: 1, title: spec.title, statement: spec.statement, function_name: spec.function_name, starter_code: spec.starter_code ?? `def ${spec.function_name}():\n    pass\n`, tests: spec.tests.map((t) => ({ args: t.input, expected: t.expected, ...(t.hidden ? { hidden: true } : {}) })) };
    return Buffer.from(JSON.stringify(cfg), "utf8").toString("base64url");
}

export function pythonExerciseUrl(spec: { title: string; statement: string; function_name: string; starter_code?: string | undefined; tests: { input: string; expected: string; hidden?: boolean | undefined }[] }): string {
    return `${LAB_BASE_URL}/apps/python/#c=${pythonExerciseConfig(spec)}`;
}

const PALETTE = ["#0b5cad", "#2a9d8f", "#e76f51", "#8e44ad", "#f4a261", "#264653", "#c0392b", "#16a085"];
/** «1810-05-25» → «1810,05,25» (formato de Timeline). */
const tlDate = (d: string) => d.replace(/-(?=\d)/g, (m, i: number) => (i === 0 ? m : ","));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// El Markdown del MCP baja los títulos dos niveles (para foros); H5P sólo admite h2 y h3: # → h2, ## y más → h3.
/**
 * Markdown → HTML para un campo de H5P. Por defecto los bloques cercados se degradan a `<code>` (campo sin
 * `<pre>` verificado en la semántica). Pasan `pre` estos campos, que lo admiten en la instalación examinada:
 * MultiChoice.question, TrueFalse.question, AdvancedText.text, DragText.taskDescription y Blanks.text. Otros
 * también lo admiten (pregunta del escenario ramificado, portada del libro, texto de la línea de tiempo) y
 * por ahora usan el modo en línea.
 */
const html = (markdown: string, codeBlocks: CodeBlocks = "inline") => toHtml(markdown, "markdown", codeBlocks).replace(/<(\/?)h([3-6])>/g, (_m, close: string, level: string) => `<${close}h${Math.min(3, Number(level) - 1)}>`);
const MACHINE: Record<Block["kind"], string> = { text: "H5P.AdvancedText", multiple_choice: "H5P.MultiChoice", true_false: "H5P.TrueFalse", drag_words: "H5P.DragText", fill_blanks: "H5P.Blanks" };
const TITLES: Record<Block["kind"], string> = { text: "Texto", multiple_choice: "Opción múltiple", true_false: "Verdadero o falso", drag_words: "Arrastrar palabras", fill_blanks: "Completar" };

function shortTitle(b: Block): string {
    const src = b.kind === "text" ? b.markdown : b.kind === "drag_words" || b.kind === "fill_blanks" ? (b.task ?? TITLES[b.kind]) : b.question;
    const t = src.replace(/[#*_`>\[\]()]/g, "").replace(/\s+/g, " ").trim();
    return t.length > 60 ? `${t.slice(0, 57)}…` : t || TITLES[b.kind];
}

/** Subcontenido de un bloque, con la versión que admite el campo del padre. */
function block(f: ContentFactory, b: Block, parent: string, path: string[]): SubContent {
    const lib = f.option(parent, path, MACHINE[b.kind]);
    const title = shortTitle(b);
    switch (b.kind) {
        case "text":
            return f.lib(lib, { text: html(b.markdown, "pre") }, title);
        case "multiple_choice":
            return f.lib(
                lib,
                {
                    question: html(b.question, "pre"),
                    answers: b.answers.map((a) => ({ text: `<div>${esc(a.text)}</div>`, correct: a.correct, tipsAndFeedback: { tip: "", chosenFeedback: a.feedback ? `<div>${esc(a.feedback)}</div>` : "", notChosenFeedback: "" } })),
                    behaviour: { randomAnswers: b.randomize ?? true },
                },
                title,
            );
        case "true_false":
            return f.lib(lib, { question: html(b.question, "pre"), correct: b.correct ? "true" : "false", behaviour: { ...(b.feedback_correct ? { feedbackOnCorrect: b.feedback_correct } : {}), ...(b.feedback_wrong ? { feedbackOnWrong: b.feedback_wrong } : {}) } }, title);
        case "drag_words":
            return f.lib(lib, { taskDescription: html(b.task, "pre"), textField: b.text, ...(b.distractors?.length ? { distractors: b.distractors.map((d) => `*${d}*`).join(" ") } : {}) }, title);
        case "fill_blanks":
            return f.lib(lib, { text: html(b.task ?? "Completá los espacios.", "pre"), questions: b.lines.map((l) => `<p>${esc(l)}</p>`), behaviour: { caseSensitive: b.case_sensitive ?? false } }, title);
    }
}

function videoFile(url: string): { path: string; mime: string; copyright: { license: string } } {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new CampusError("WRITE_NOT_ALLOWED", "El video tiene que ser https.");
    if (u.username || u.password) throw new CampusError("WRITE_NOT_ALLOWED", "La URL del video no puede llevar usuario ni contraseña.");
    const yt = (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/watch" && /^[\w-]{6,20}$/.test(u.searchParams.get("v") ?? "")) || (u.hostname === "youtu.be" && /^\/[\w-]{6,20}$/.test(u.pathname));
    if (yt) return { path: u.href, mime: "video/YouTube", copyright: { license: "U" } };
    if (/\.mp4$/i.test(u.pathname)) return { path: u.href, mime: "video/mp4", copyright: { license: "U" } };
    if (/\.webm$/i.test(u.pathname)) return { path: u.href, mime: "video/webm", copyright: { license: "U" } };
    throw new CampusError("WRITE_NOT_ALLOWED", "Video no admitido: YouTube (youtube.com/watch?v=… o youtu.be/…) o un archivo https .mp4 o .webm.");
}

/** Parámetros (content.json) del contenido, para la biblioteca principal `main`. */
export function buildContentParams(spec: H5pContent, main: string, f: ContentFactory): Record<string, unknown> {
    switch (spec.type) {
        case "question_set":
            return f.params(main, {
                introPage: { showIntroPage: !!spec.intro, ...(spec.intro?.title ? { title: spec.intro.title } : {}), ...(spec.intro?.text ? { introduction: html(spec.intro.text) } : {}) },
                questions: spec.questions.map((q) => block(f, q, main, ["questions"])),
                ...(spec.pass_percentage !== undefined ? { passPercentage: spec.pass_percentage } : {}),
                randomQuestions: spec.randomize ?? false,
                ...(spec.pool_size !== undefined ? { poolSize: Math.min(spec.pool_size, spec.questions.length) } : {}),
                endGame: { showSolutionButton: spec.show_solutions ?? true, showRetryButton: spec.allow_retry ?? true },
            });
        case "course_presentation":
            return f.params(main, {
                presentation: {
                    slides: spec.slides.map((s) => {
                        // Bloques apilados: márgenes de 4 % y alturas iguales.
                        const n = s.blocks.length;
                        const h = (92 - 4 * (n - 1)) / n;
                        return {
                            elements: s.blocks.map((b, i) => ({ x: 4, y: 4 + i * (h + 4), width: 92, height: h, action: block(f, b, main, ["presentation", "slides", "elements", "action"]) })),
                            ...(s.title ? { keywords: [{ main: s.title }] } : {}),
                        };
                    }),
                },
            });
        case "interactive_book": {
            const column = f.option(main, ["chapters", "chapter"], "H5P.Column");
            return f.params(main, {
                showCoverPage: !!spec.cover,
                ...(spec.cover ? { bookCover: { coverDescription: html(spec.cover) } } : {}),
                chapters: spec.chapters.map((c) => f.lib(column, { content: c.blocks.map((b) => ({ content: block(f, b, column, ["content", "content"]), useSeparator: "auto" })) }, c.title)),
            });
        }
        case "interactive_video": {
            const action = ["interactiveVideo", "assets", "interactions", "action"];
            const interactions = spec.interactions.map((it) => {
                const until = it.until_seconds ?? it.at_seconds + 10;
                if (until <= it.at_seconds) throw new CampusError("WRITE_NOT_ALLOWED", `Interacción en ${it.at_seconds} s: until_seconds tiene que ser mayor.`);
                const poster = (it.display ?? "poster") === "poster";
                const sub = block(f, it.question, main, action);
                return {
                    duration: { from: it.at_seconds, to: until },
                    pause: it.pause ?? true,
                    displayType: poster ? "poster" : "button",
                    buttonOnMobile: false,
                    label: "",
                    x: poster ? 25 : 80,
                    y: poster ? 15 : 10,
                    width: poster ? 50 : 10,
                    height: poster ? 60 : 10,
                    libraryTitle: machineOf(sub.library).replace(/^H5P\./, ""),
                    action: sub,
                };
            });
            const summaryLib = spec.summary ? f.option(main, ["interactiveVideo", "summary", "task"], "H5P.Summary") : null;
            return f.params(main, {
                interactiveVideo: {
                    video: { files: [videoFile(spec.video_url)], startScreenOptions: { hideStartTitle: false, ...(spec.start_description ? { shortStartDescription: spec.start_description } : {}) } },
                    assets: { interactions, bookmarks: (spec.bookmarks ?? []).map((b) => ({ time: b.at_seconds, label: b.label })), endscreens: [] },
                    ...(summaryLib ? { summary: { task: f.lib(summaryLib, { summaries: spec.summary!.map((s) => ({ summary: [s.correct, ...s.wrong].map((x) => `<p>${esc(x)}</p>`), tip: "" })) }, "Resumen"), displayAt: 3 } } : {}),
                },
            });
        }
        case "branching_scenario": {
            const index = new Map(spec.nodes.map((n, i) => [n.id, i] as const));
            if (index.size !== spec.nodes.length) throw new CampusError("WRITE_NOT_ALLOWED", "Hay ids de nodo repetidos.");
            const resolve = (from: string, next: string) => {
                if (next === "end") return -1;
                const i = index.get(next);
                if (i === undefined) throw new CampusError("WRITE_NOT_ALLOWED", `El nodo «${from}» apunta a «${next}», que no existe.`);
                return i;
            };
            const feedback = (e?: { title: string; subtitle?: string; score?: number }) => (e ? { title: `<p>${esc(e.title)}</p>`, ...(e.subtitle ? { subtitle: `<p>${esc(e.subtitle)}</p>` } : {}), endScreenScore: e.score ?? 0 } : {});
            const contentPath = ["branchingScenario", "content", "type"];
            // El índice de cada nodo es su id para H5P (nextContentId).
            const content = spec.nodes.map((n) => {
                if (n.kind === "text") {
                    const lib = f.option(main, contentPath, "H5P.AdvancedText");
                    // «Proceed» no viene traducido en la biblioteca.
                    return { type: f.lib(lib, { text: html(n.markdown) }, n.id), showContentTitle: false, proceedButtonText: "Continuar", nextContentId: resolve(n.id, n.next), ...(n.next === "end" ? { feedback: feedback(n.end) } : {}) };
                }
                const lib = f.option(main, contentPath, "H5P.BranchingQuestion");
                return {
                    type: f.lib(lib, { branchingQuestion: { question: html(n.question), alternatives: n.options.map((o) => ({ text: o.text, nextContentId: resolve(n.id, o.next), ...(o.next === "end" ? { feedback: feedback(o.end) } : {}) })) } }, n.id),
                    showContentTitle: false,
                    // La decisión sigue a sus opciones; la semántica igual pide un destino propio.
                    nextContentId: resolve(n.id, n.options[0]!.next),
                };
            });
            const end = spec.default_end ?? { title: "Fin" };
            return f.params(main, {
                branchingScenario: {
                    title: spec.title,
                    startScreen: { startScreenTitle: `<p>${esc(spec.start?.title ?? spec.title)}</p>`, ...(spec.start?.subtitle ? { startScreenSubtitle: `<p>${esc(spec.start.subtitle)}</p>` } : {}) },
                    endScreens: [{ endScreenTitle: `<p>${esc(end.title)}</p>`, ...(end.subtitle ? { endScreenSubtitle: `<p>${esc(end.subtitle)}</p>` } : {}), contentId: -1, endScreenScore: 0 }],
                    content,
                },
            });
        }
        case "dialog_cards":
            return f.params(main, {
                ...(spec.title ? { title: `<p>${esc(spec.title)}</p>` } : {}),
                ...(spec.description ? { description: html(spec.description) } : {}),
                mode: spec.mode ?? "normal",
                dialogs: spec.cards.map((c) => ({ text: `<p>${esc(c.front)}</p>`, answer: `<p>${esc(c.back)}</p>`, tips: { ...(c.tip_front ? { front: c.tip_front } : {}), ...(c.tip_back ? { back: c.tip_back } : {}) } })),
                behaviour: { randomCards: spec.randomize ?? false },
            });
        case "chart":
            return f.params(main, {
                graphMode: spec.chart_type === "bar" ? "barChart" : "pieChart",
                figureDefinition: spec.title,
                listOfTypes: spec.items.map((it, i) => ({ text: it.label, value: it.value, color: it.color ?? PALETTE[i % PALETTE.length]!, fontColor: "#fff" })),
            });
        case "timeline":
            return f.params(main, {
                timeline: {
                    headline: spec.title,
                    ...(spec.description ? { text: html(spec.description) } : {}),
                    date: spec.events.map((e) => ({ startDate: tlDate(e.date), ...(e.end_date ? { endDate: tlDate(e.end_date) } : {}), headline: e.title, ...(e.text ? { text: html(e.text) } : {}), ...(e.tag ? { tag: e.tag } : {}), asset: e.media_url ? { media: e.media_url } : {} })), // el reproductor lee asset.thumbnail siempre
                    ...(spec.eras?.length ? { era: spec.eras.map((e) => ({ startDate: tlDate(e.start), endDate: tlDate(e.end), headline: e.title })) } : {}),
                },
            });
        case "python_exercise":
            return f.params(main, { width: "100%", minWidth: "300px", height: `${spec.height_px ?? 650}px`, source: pythonExerciseUrl(spec), resizeSupported: false }); // alto fijo: la mini-app no trae el script de redimensionado de H5P
        case "accordion": {
            const lib = f.option(main, ["panels", "content"], "H5P.AdvancedText");
            return f.params(main, { panels: spec.panels.map((p) => ({ title: p.title, content: f.lib(lib, { text: html(p.markdown, "pre") }, p.title) })), hTag: spec.heading ?? "h2" });
        }
        case "iframe_embed":
            return f.params(main, { width: "100%", minWidth: `${spec.min_width_px ?? 300}px`, height: `${spec.height_px ?? 760}px`, source: embedSource(spec.source_url), resizeSupported: spec.resize_supported ?? false });
    }
}

/** Resumen corto del contenido para el plan (cantidades, sin el texto completo). */
export function describeContent(spec: H5pContent): Record<string, unknown> {
    const kinds = (bs: readonly Block[]) => bs.reduce<Record<string, number>>((acc, b) => ({ ...acc, [b.kind]: (acc[b.kind] ?? 0) + 1 }), {});
    switch (spec.type) {
        case "question_set":
            return { questions: spec.questions.length, kinds: kinds(spec.questions), intro: !!spec.intro, randomize: spec.randomize ?? false, pool_size: spec.pool_size ?? null };
        case "course_presentation":
            return { slides: spec.slides.length, kinds: kinds(spec.slides.flatMap((s) => s.blocks)) };
        case "interactive_book":
            return { chapters: spec.chapters.map((c) => ({ title: c.title, blocks: c.blocks.length })), cover: !!spec.cover, kinds: kinds(spec.chapters.flatMap((c) => c.blocks)) };
        case "interactive_video":
            return { video_url: spec.video_url, interactions: spec.interactions.map((i) => ({ at_seconds: i.at_seconds, kind: i.question.kind })), bookmarks: spec.bookmarks?.length ?? 0, summary: spec.summary?.length ?? 0 };
        case "branching_scenario":
            return { nodes: spec.nodes.map((n) => ({ id: n.id, kind: n.kind, next: n.kind === "text" ? [n.next] : n.options.map((o) => o.next) })) };
        case "dialog_cards":
            return { cards: spec.cards.length, mode: spec.mode ?? "normal" };
        case "chart":
            return { chart_type: spec.chart_type, items: spec.items.map((i) => `${i.label}: ${i.value}`) };
        case "timeline":
            return { events: spec.events.length, eras: spec.eras?.length ?? 0, first: spec.events[0]!.date };
        case "accordion":
            return { panels: spec.panels.map((p) => p.title) };
        case "python_exercise":
            return { app: `${LAB_BASE_URL}/apps/python/`, function_name: spec.function_name, tests: spec.tests.length, hidden_tests: spec.tests.filter((t) => t.hidden).length };
        case "iframe_embed": {
            const u = new URL(spec.source_url);
            return { source: spec.source_url, origin: u.origin, height_px: spec.height_px ?? 760 };
        }
    }
}

/** Texto del docente (para la auditoría): todo lo redactado, en un solo bloque. */
export function teacherTextOf(spec: H5pContent): string {
    return JSON.stringify(spec).slice(0, 100_000);
}
