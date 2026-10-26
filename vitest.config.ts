import { defineConfig } from "vitest/config";

// La extracción de PDF (pdfjs) supera los 5 s por defecto cuando la suite corre completa en paralelo.
export default defineConfig({ test: { testTimeout: 30_000 } });
