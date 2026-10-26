import { CampusError } from "../errors.js";

/**
 * Texto de un PDF con pdfjs-dist (Mozilla). Sólo extracción de texto: sin render, sin fuentes del
 * sistema y con `isEvalSupported: false` (evita evaluar código de fuentes; ver CVE-2024-4367).
 * Un PDF escaneado o de sólo imágenes devuelve páginas vacías: se informa, no se inventa texto.
 */
export interface PdfText {
    num_pages: number;
    pages: { page: number; text: string }[];
    /** Primera página no leída (para continuar), o null si se llegó al final. */
    next_page: number | null;
}

export async function extractPdfText(bytes: Uint8Array, opts: { pageStart: number; maxPages: number; maxChars: number }): Promise<PdfText> {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
        getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfDoc>; destroy: () => Promise<void> };
    };
    // pdfjs puede transferir el buffer: se le pasa una copia.
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 });
    let doc: PdfDoc;
    try {
        doc = await task.promise;
    } catch (e) {
        await task.destroy().catch(() => {});
        const name = e instanceof Error ? e.name : "";
        throw new CampusError("UNSUPPORTED_CONTENT", name === "PasswordException" ? "PDF protegido con contraseña: no se puede leer." : "PDF inválido o corrupto: no se pudo abrir.");
    }
    try {
        const start = Math.max(1, opts.pageStart);
        if (start > doc.numPages) throw new CampusError("POLICY_DENIED", `page_start=${start} supera las ${doc.numPages} páginas del PDF.`);
        const pages: PdfText["pages"] = [];
        let chars = 0;
        let p = start;
        for (; p <= doc.numPages && pages.length < opts.maxPages && chars < opts.maxChars; p++) {
            const page = await doc.getPage(p);
            const content = await page.getTextContent();
            let text = "";
            for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
                if (typeof item.str !== "string") continue;
                text += item.str + (item.hasEOL ? "\n" : " ");
            }
            text = text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
            pages.push({ page: p, text });
            chars += text.length;
            page.cleanup?.();
        }
        return { num_pages: doc.numPages, pages, next_page: p <= doc.numPages ? p : null };
    } finally {
        await task.destroy().catch(() => {});
    }
}

interface PdfDoc {
    numPages: number;
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup?: () => void }>;
}
