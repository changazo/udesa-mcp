# Atribuciones de terceros

## UTN-MCP

Autor: Joaquín Peñalva y colaboradores. Repositorio: https://github.com/nialvape/utn-mcp
Revisión consultada: `4fcd6ffb3f40be27711070609a9363642ae8a6cf` (archivos verificados por hash Git contra esa revisión; no se instaló ni ejecutó).
Licencia: ISC. Texto completo en [LICENSE_UTN_MCP.txt](LICENSE_UTN_MCP.txt).

Este producto **no** es una derivación completa: el código es propio. Fragmentos o conocimiento tomados de la referencia:

| Archivo propio | Original | Adaptaciones |
|---|---|---|
| `src/moodle/transport.ts` — `readWithLimit` | `src/aula-virtual/client/moodle-api.ts` — `readWithLimit` | Reescrito con `getReader()`, cancelación al exceder y error propio |
| `src/auth/native.ts` — request a `login/token.php` | `src/aula-virtual/client/sso-login.ts` — `tryTokenPhp` | Un intento, sin redirecciones, sin fallback a formularios, mapeo de errores propio, `privatetoken` descartado |
| `src/auth/browser.ts` — formato del retorno | `src/aula-virtual/client/sso-login.ts` — `decodeLaunchToken` | Validación de hash/transacción/esquema/expiración que upstream no hacía |
| `src/moodle/schemas.ts` — campos de foros y cursos | `src/aula-virtual/client/types.ts` | Esquemas runtime (zod) con proyección de campos seguros |

No se reutilizaron herramientas de escritura, el flujo Keycloak, el servidor HTTP/OAuth ni el almacenamiento de sesiones de upstream.

## Dependencias

Versiones exactas en `package-lock.json`. Directas: `@modelcontextprotocol/sdk` (MIT), `zod` (MIT), `@napi-rs/keyring` (MIT), `jose` (MIT), `pdfjs-dist` (Apache-2.0, Mozilla; trae como opcional `@napi-rs/canvas`, MIT, que no se usa para extraer texto). Desarrollo: `typescript` (Apache-2.0), `vitest` (MIT), `@types/node` (MIT), `ajv` (MIT), `ajv-formats` (MIT). Licencias según los `package.json` instalados; no se hizo una auditoría legal.

## Semánticas H5P (tests)

`tests/fixtures/h5p/*.json` reproduce la semántica y la traducción al castellano de bibliotecas H5P (Joubel AS / H5P Group y colaboradores), con licencia MIT. Texto completo en [tests/fixtures/h5p/LICENSE](tests/fixtures/h5p/LICENSE).

## Tipografía

Las imágenes de `assets/` usan Libertinus Serif y Libertinus Sans (© The Libertinus Project Authors; archivos web de Fontsource), con licencia SIL Open Font License 1.1. Los `.woff2` y el texto de la licencia están en [assets/src/fonts/](assets/src/fonts/OFL.txt).

## Código propio

Apache-2.0: ver [LICENSE](LICENSE) y [NOTICE](NOTICE). «UdeSA», «Universidad de San Andrés» y su emblema son marcas de la Universidad de San Andrés y no están cubiertas por esta licencia.
