# Registro de decisiones de implementación

Una sección por decisión: fecha, estatus y origen, y después la decisión y sus consecuencias. En **Origen**, «confirmado» es un requisito del dueño y «propuesta», una elección técnica de esta implementación.

«El dueño» es quien despliega y mantiene el servidor: las decisiones se tomaron para el despliegue original. «Hand-off» y «directiva» son la especificación inicial del proyecto, privada y no publicada; las referencias a sus secciones (§) quedan como historia del diseño.

## Índice

Estado de cada decisión. El estatus completo está en la línea **Estatus** de cada ADR: mantener las dos al día.

| ADR | Título | Estatus |
|---|---|---|
| [001](#adr-001--ubicación-y-alcance-del-runtime) | Ubicación y alcance del runtime | adoptada |
| [002](#adr-002--versiones-y-cadena-de-suministro) | Versiones y cadena de suministro | adoptada |
| [003](#adr-003--código-propio-sobre-contratos-oficiales-de-moodle) | Código propio sobre contratos oficiales de Moodle | adoptada |
| [004](#adr-004--perfil-literales-de-política-y-entorno-que-sólo-confirma) | Perfil: literales de política y entorno que sólo confirma | adoptada |
| [005](#adr-005--almacén-de-secretos-sin-fallback) | Almacén de secretos sin fallback | adoptada |
| [006](#adr-006--allowlist-de-funciones-en-el-transporte) | Allowlist de funciones en el transporte | adoptada |
| [007](#adr-007--identificación-de-avisos) | Identificación de Avisos | adoptada |
| [008](#adr-008--paginación-y-since) | Paginación y `since` | adoptada |
| [009](#adr-009--códigos-de-error-adicionales) | Códigos de error adicionales | adoptada |
| [010](#adr-010--archivos) | Archivos | adoptada; formatos ampliados por ADR-019 (PDF, ZIP, imágenes, notebooks) y ADR-022 (Office) |
| [011](#adr-011--método-browser-no-habilitado-en-esta-iteración) | Método browser no habilitado en esta iteración | reemplazada por ADR-024 y ADR-025 |
| [012](#adr-012--prueba-stdio-y-keyring-en-tests) | Prueba STDIO y keyring en tests | adoptada |
| [013](#adr-013--servidor-remoto-privado-en-vercel-fase-1) | Servidor remoto privado en Vercel (fase 1) | adoptada |
| [014](#adr-014--oauth-propio-sin-estado-identidad-vía-github) | OAuth propio sin estado, identidad vía GitHub | adoptada |
| [015](#adr-015--configuración-remota-por-variables-de-entorno) | Configuración remota por variables de entorno | adoptada |
| [016](#adr-016--perfil-udesa-docente-alcance-por-rol-docente) | Perfil `udesa-docente`: alcance por rol docente | adoptada; modificada por ADR-122 |
| [017](#adr-017--datos-de-estudiantes-en-local-y-remoto-con-minimización) | Datos de estudiantes en local y remoto, con minimización | adoptada; modificada por ADR-022, ADR-027 y ADR-124 |
| [018](#adr-018--lecturas-ampliadas) | Lecturas ampliadas | adoptada |
| [019](#adr-019--lectura-de-zip-pdf-imágenes-y-notebooks) | Lectura de ZIP, PDF, imágenes y notebooks | adoptada |
| [020](#adr-020--file_ref-como-localizador-sin-estado) | `file_ref` como localizador sin estado | adoptada |
| [021](#adr-021--json-compacto-en-las-respuestas-mcp) | JSON compacto en las respuestas MCP | adoptada |
| [022](#adr-022--lectura-ampliada-ii-notas-cuestionarios-participantes-grupos-mensajes) | Lectura ampliada II: notas, cuestionarios, participantes, grupos, mensajes | adoptada; modificada por ADR-124 |
| [023](#adr-023--codificación-de-archivos-de-texto) | Codificación de archivos de texto | adoptada |
| [024](#adr-024--login-con-google-lanzamiento-móvil-con-oauthsso-y-retorno-manual) | Login con Google: lanzamiento móvil con `oauthsso` y retorno manual | adoptada |
| [025](#adr-025--retorno-automático-del-login-con-google-en-windows) | Retorno automático del login con Google en Windows | en pausa |
| [026](#adr-026--vista-completa-del-curso-subsecciones-resúmenes-fechas-y-carpetas) | Vista completa del curso: subsecciones, resúmenes, fechas y carpetas | adoptada |
| [027](#adr-027--devoluciones-pendientes-y-notificaciones) | Devoluciones, pendientes y notificaciones | adoptada; modificada por ADR-124 |
| [028](#adr-028--asistencia-por-la-vía-de-la-app-móvil-con-candado) | Asistencia por la vía de la app móvil, con candado | adoptada; modificada por ADR-122 |
| [029](#adr-029--resumen-de-actividades-de-moodle-5) | Resumen de actividades de Moodle 5 | adoptada |
| [030](#adr-030--lectura-de-posts-de-foros-sin-marcarlos-como-leídos) | Lectura de posts de foros sin marcarlos como leídos | modificada por ADR-039 |
| [031](#adr-031--excepción-de-política-lectura-del-libro-de-calificaciones) | Excepción de política: lectura del libro de calificaciones | adoptada |
| [032](#adr-032--fechas-efectivas-y-etiquetas-de-categoría-p1) | Fechas efectivas y etiquetas de categoría (P1) | adoptada |
| [033](#adr-033--sesión-web-y-operaciones-web-admitidas) | Sesión web y operaciones web admitidas | adoptada |
| [034](#adr-034--estructura-de-cuestionarios-y-preguntas) | Estructura de cuestionarios y preguntas | adoptada |
| [035](#adr-035--reportes-docentes-con-variantes-cerradas-estadísticas-bloqueadas) | Reportes docentes con variantes cerradas; estadísticas bloqueadas | adoptada |
| [036](#adr-036--configuración-legible-de-tareas-y-cuestionarios) | Configuración legible de tareas y cuestionarios | adoptada |
| [037](#adr-037--árbol-de-calificaciones-h5p-y-observaciones-por-contexto) | Árbol de calificaciones, H5P y observaciones por contexto | adoptada |
| [038](#adr-038--mantener-viva-la-sesión-web-keepalive-local) | Mantener viva la sesión web (keepalive local) | adoptada (no viable en una PC administrada: ADR-087) |
| [039](#adr-039--excepción-del-dueño-leer-foros-con-seguimiento-aunque-se-marquen-como-leídos) | Excepción del dueño: leer foros con seguimiento aunque se marquen como leídos | adoptada |
| [040](#adr-040--historial-de-asistencia-por-sesión) | Historial de asistencia por sesión | adoptada |
| [041](#adr-041--exportación-por-categoría-directiva-73) | Exportación por categoría (directiva §7.3) | adoptada; modificada por ADR-086 |
| [042](#adr-042--cierre-de-lecturas-ficha-del-curso-reglas-de-acceso-nota-del-cuestionario-y-calificación-avanzada) | Cierre de lecturas: ficha del curso, reglas de acceso, nota del cuestionario y calificación avanzada | adoptada |
| [043](#adr-043--curso-sandbox-como-entorno-principal-de-pruebas) | Curso sandbox como entorno principal de pruebas | adoptada; ampliada por ADR-125 |
| [044](#adr-044--perfil-servidor-y-transporte-de-escritura-w0) | Perfil, servidor y transporte de escritura (W0) | modificada por ADR-061, 062, 078, 122, 125 y 126 |
| [045](#adr-045--confirmación-humana-fuera-del-modelo) | Confirmación humana fuera del modelo | sin uso desde ADR-061 |
| [046](#adr-046--planes-ejecución-verificada-auditoría-límites-y-deshacer) | Planes, ejecución verificada, auditoría, límites y deshacer | modificada por ADR-061, 067, 118 y 126 |
| [047](#adr-047--w1-escrituras-en-foros-sólo-sandbox) | W1: escrituras en foros (sólo sandbox) | adoptada; ampliada por ADR-125; ventana modificada por ADR-100 |
| [048](#adr-048--sandbox-sin-confirmación-del-humano-y-sin-notificar-a-participantes) | Sandbox sin confirmación del humano y sin notificar a participantes | confirmación subsumida por ADR-061 |
| [049](#adr-049--w2-calendario-prórrogas-bloqueo-y-comentarios-de-entrega-sin-mensajes) | W2: calendario, prórrogas, bloqueo y comentarios de entrega (sin mensajes) | adoptada; ampliada por ADR-125; mensajes privados a cuentas de prueba: ADR-120 |
| [050](#adr-050--crear-tareas-por-formulario-web-w6-adelantada-y-transporte-web-de-escritura) | Crear tareas por formulario web (W6 adelantada) y transporte web de escritura | adoptada; ampliada por ADR-125 |
| [051](#adr-051--w4-estructura-del-curso-mostrar-ocultar-mover-y-renombrar) | W4: estructura del curso (mostrar, ocultar, mover y renombrar) | adoptada; ampliada por ADR-125 |
| [052](#adr-052--guarda-de-mod_assign_get_submission_status-ninguna-lectura-crea-entregas) | Guarda de `mod_assign_get_submission_status`: ninguna lectura crea entregas | adoptada |
| [053](#adr-053--w3-calificar-y-devolver-entregas) | W3: calificar y devolver entregas | adoptada; ampliada por ADR-125 |
| [054](#adr-054--deploy-del-remoto-con-lecturas-al-día) | Deploy del remoto con lecturas al día | escrituras remotas: ADR-060 |
| [055](#adr-055--w4-tomar-asistencia-crear-actividades-y-sesiones-de-asistencia) | W4: tomar asistencia; crear actividades y sesiones de asistencia | adoptada |
| [056](#adr-056--w6-parcial-crear-cuestionarios-y-overrides-por-alumno) | W6 parcial: crear cuestionarios y overrides por alumno | adoptada; ampliada por ADR-073 |
| [057](#adr-057--w1-adjuntos-en-avisos-y-respuestas) | W1: adjuntos en avisos y respuestas | adoptada |
| [058](#adr-058--w6-parcial-grupos) | W6 parcial: grupos | adoptada |
| [059](#adr-059--w6-parcial-importar-preguntas-a-un-banco) | W6 parcial: importar preguntas a un banco | adoptada |
| [060](#adr-060--w5-escrituras-remotas-en-vercel) | W5: escrituras remotas en Vercel | modificada por ADR-061 y ADR-118 |
| [061](#adr-061--escrituras-sin-aprobación-humana-decisión-del-dueño) | Escrituras sin aprobación humana (decisión del dueño) | adoptada; modificada por ADR-118 y ADR-125 |
| [062](#adr-062--perfiles-docente-lectura-y-docente-completo) | Perfiles docente-lectura y docente-completo | adoptada |
| [063](#adr-063--w6-agregar-preguntas-del-banco-a-un-cuestionario) | W6: agregar preguntas del banco a un cuestionario | adoptada |
| [064](#adr-064--w6-crear-páginas-enlaces-etiquetas-y-archivos) | W6: crear páginas, enlaces, etiquetas y archivos | adoptada |
| [065](#adr-065--w6-cambiar-fechas-de-tareas-y-cuestionarios-existentes) | W6: cambiar fechas de tareas y cuestionarios existentes | adoptada |
| [066](#adr-066--w6-excepciones-overrides-de-tareas-por-participante) | W6: excepciones (overrides) de tareas por participante | adoptada |
| [067](#adr-067--w6-secciones-y-borrados-r4-actividades-y-secciones) | W6: secciones y borrados R4 (actividades y secciones) | adoptada; techo modificado por ADR-118 |
| [068](#adr-068--w6-estado-de-preguntas-lista--borrador) | W6: estado de preguntas (lista ↔ borrador) | adoptada |
| [069](#adr-069--w1-cambiar-los-adjuntos-de-un-post-propio) | W1: cambiar los adjuntos de un post propio | adoptada |
| [070](#adr-070--w6-crear-foros-y-calificar-el-foro-completo) | W6: crear foros y calificar el foro completo | adoptada |
| [071](#adr-071--w6-calificación-manual-de-preguntas-de-cuestionarios) | W6: calificación manual de preguntas de cuestionarios | adoptada |
| [072](#adr-072--w6-preguntas-aleatorias-y-nota-máxima-por-pregunta) | W6: preguntas aleatorias y nota máxima por pregunta | adoptada |
| [073](#adr-073--w6-excepciones-de-grupo-en-tareas-y-cuestionarios) | W6: excepciones de grupo en tareas y cuestionarios | adoptada |
| [074](#adr-074--w6-agrupamientos) | W6: agrupamientos | adoptada |
| [075](#adr-075--w6-editar-descripción-contenido-de-páginas-y-nota-máxima-de-tareas) | W6: editar descripción, contenido de páginas y nota máxima de tareas | adoptada |
| [076](#adr-076--w6-más-ediciones-enlaces-etiquetas-resúmenes-de-sección-y-grupos) | W6: más ediciones (enlaces, etiquetas, resúmenes de sección y grupos) | adoptada |
| [077](#adr-077--w6-los-elementos-del-sandbox-crear-editar-y-borrar-por-tipo) | W6: los elementos del sandbox (crear, editar y borrar por tipo) | adoptada |
| [078](#adr-078--límite-diario-de-escrituras-2000) | Límite diario de escrituras: 2000 | adoptada |
| [079](#adr-079--leer-el-contenido-interno-de-las-actividades) | Leer el contenido interno de las actividades | adoptada |
| [080](#adr-080--campos-de-bases-de-datos-y-fechas-de-más-actividades) | Campos de bases de datos y fechas de más actividades | adoptada |
| [081](#adr-081--páginas-de-lecciones) | Páginas de lecciones | adoptada |
| [082](#adr-082--ajustes-por-catálogo-restricciones-y-duplicar) | Ajustes por catálogo, restricciones y duplicar | adoptada |
| [083](#adr-083--correcciones-de-la-revisión-adversarial) | Correcciones de la revisión adversarial | adoptada |
| [084](#adr-084--borrar-elementos-existentes) | Borrar elementos existentes | adoptada |
| [085](#adr-085--reordenar-agrupamientos-y-aprobaciones) | Reordenar, agrupamientos y aprobaciones | adoptada |
| [086](#adr-086--correcciones-de-la-revisión-de-lecturas-docentes) | Correcciones de la revisión de lecturas docentes | adoptada |
| [087](#adr-087--el-keepalive-programado-no-es-viable-en-una-pc-administrada) | El keepalive programado no es viable en una PC administrada | adoptada |
| [088](#adr-088--login-web-automático-con-contraseña-guardada-opcional-no-recomendado) | Login web automático con contraseña guardada (opcional, no recomendado) | adoptada como excepción del dueño |
| [089](#adr-089--aprobar-entradas-de-glosario-editar-sesiones-y-eventos) | Aprobar entradas de glosario, editar sesiones y eventos | adoptada |
| [090](#adr-090--respuestas-por-pregunta-de-h5p) | Respuestas por pregunta de H5P | adoptada |
| [091](#adr-091--páginas-y-secciones-de-cuestionarios) | Páginas y secciones de cuestionarios | adoptada |
| [092](#adr-092--páginas-de-pregunta-de-lecciones) | Páginas de pregunta de lecciones | adoptada |
| [093](#adr-093--wikis-por-grupo-e-individuales) | Wikis por grupo e individuales | adoptada |
| [094](#adr-094--moderación-de-foros) | Moderación de foros | adoptada; ampliada por ADR-125 |
| [095](#adr-095--calificación-avanzada-de-tareas) | Calificación avanzada de tareas | adoptada |
| [096](#adr-096--libro-de-calificaciones) | Libro de calificaciones | adoptada; ampliada por ADR-125 |
| [097](#adr-097--preguntas-de-encuestas) | Preguntas de encuestas | adoptada |
| [098](#adr-098--suscripción-del-autor-en-foros) | Suscripción del autor en foros | adoptada |
| [099](#adr-099--editar-excepciones-y-guarda-de-calificación) | Editar excepciones y guarda de calificación | adoptada |
| [100](#adr-100--ventana-de-correo-de-los-foros-de-udesa) | Ventana de correo de los foros de UdeSA | adoptada |
| [101](#adr-101--mover-preguntas-de-encuestas) | Mover preguntas de encuestas | adoptada |
| [102](#adr-102--alias-y-categorías-de-glosarios) | Alias y categorías de glosarios | adoptada |
| [103](#adr-103--grupos-y-cupos-de-elecciones-de-grupo) | Grupos y cupos de elecciones de grupo | adoptada |
| [104](#adr-104--reemplazar-el-paquete-de-una-actividad-h5p) | Reemplazar el paquete de una actividad H5P | adoptada |
| [105](#adr-105--pendientes-de-lectura-cerrados-y-entregas-en-grupo) | Pendientes de lectura cerrados y entregas en grupo | adoptada |
| [106](#adr-106--correcciones-de-la-revisión-del-keepalive) | Correcciones de la revisión del keepalive | adoptada |
| [107](#adr-107--banco-propio-de-los-cuestionarios) | Banco propio de los cuestionarios | adoptada |
| [108](#adr-108--borrar-grupos) | Borrar grupos | adoptada; techo modificado por ADR-118 |
| [109](#adr-109--exploración-h5p-y-micro-integraciones) | Exploración H5P y micro-integraciones | adoptada; implementada por ADR-110, 111, 114, 116 y 117 |
| [110](#adr-110--contenido-h5p-generado-por-el-mcp) | Contenido H5P generado por el MCP | adoptada |
| [111](#adr-111--más-tipos-h5p-y-valores-por-defecto-en-profundidad) | Más tipos H5P y valores por defecto en profundidad | adoptada |
| [112](#adr-112--archivos-originales-e-imágenes-de-documentos) | Archivos originales e imágenes de documentos | adoptada; entrega modificada por ADR-113 (`delivery`) |
| [113](#adr-113--entrega-de-archivos-según-el-agente) | Entrega de archivos según el agente | adoptada |
| [114](#adr-114--editar-contenido-h5p-generado) | Editar contenido H5P generado | adoptada |
| [115](#adr-115--notificar-a-las-cuentas-de-prueba-del-sandbox) | Notificar a las cuentas de prueba del sandbox | adoptada |
| [116](#adr-116--laboratorio-de-mini-aplicaciones-en-vercel) | Laboratorio de mini-aplicaciones en Vercel | adoptada |
| [117](#adr-117--ejercicios-del-laboratorio-con-nota-por-lti) | Ejercicios del laboratorio con nota por LTI | adoptada |
| [118](#adr-118--r3-y-r4-sin-techo-con-el-humano-en-el-circuito) | R3 y R4 sin techo, con el humano en el circuito | adoptada; modificada por ADR-126 |
| [119](#adr-119--más-operaciones-r4-lotes-y-trabajo-de-estudiantes) | Más operaciones R4: lotes y trabajo de estudiantes | adoptada |
| [120](#adr-120--acciones-con-las-cuentas-de-prueba-que-antes-estaban-bloqueadas) | Acciones con las cuentas de prueba que antes estaban bloqueadas | adoptada |
| [121](#adr-121--endurecer-el-login-web-automático-local) | Endurecer el login web automático local | adoptada |
| [122](#adr-122--alcance-por-matrícula-y-permisos-por-rol-en-cada-curso) | Alcance por matrícula y permisos por rol en cada curso | adoptada; modificada por ADR-123 |
| [123](#adr-123--intentos-propios-con-cualquier-rol-y-roles-superiores) | Intentos propios con cualquier rol y roles superiores | adoptada |
| [124](#adr-124--datos-personales-donde-la-operación-los-necesita) | Datos personales donde la operación los necesita | adoptada |
| [125](#adr-125--escrituras-en-todos-los-cursos-con-rol-de-escritura) | Escrituras en todos los cursos con rol de escritura | adoptada; modificada por ADR-126 |
| [126](#adr-126--sin-escalada-de-riesgo-por-curso-real) | Sin escalada de riesgo por curso real | adoptada |
| [127](#adr-127--login-web-automático-en-el-servidor-remoto) | Login web automático en el servidor remoto | adoptada como excepción explícita del dueño |

## ADR-001 · Ubicación y alcance del runtime

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** D08 (propuesta).
**Decisión:** el producto vive en su propio repositorio, separado del paquete de hand-off y de los repositorios de los cursos, que el agente no modifica.

## ADR-002 · Versiones y cadena de suministro

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** D09 (propuesta), AGENTS.md («verificá versiones soportadas y dependencias antes de fijar el lockfile»).
**Decisión:** dependencias exactas con al menos ~2 semanas de publicadas, resueltas con `npm install --before=2026-10-04` para todo el árbol: `@modelcontextprotocol/sdk 1.32.0`, `zod 4.6.5`, `@napi-rs/keyring 2.1.0`; dev: `typescript 7.0.2`, `vitest 5.0.3`, `@types/node 22.20.5`, `ajv 8.20.0`, `ajv-formats 3.0.1`. Se verificó que ningún paquete instalado declara scripts de instalación.
**Alternativas:** rangos `^` con las versiones más nuevas. Se descartó por la regla de antigüedad mínima y de versiones exactas.
**Validación:** `npm ci` + `npm audit` (0 vulnerabilidades reportadas el 2026-10-18; no prueba ausencia de vulnerabilidades) + build + tests.

## ADR-003 · Código propio sobre contratos oficiales de Moodle

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** D01 (confirmado).
**Decisión:** se escribió el código siguiendo la arquitectura del hand-off y los contratos oficiales de Moodle (`login/token.php`, retorno de `launch.php`, funciones de foros). Las piezas de terceros adaptadas y su licencia están en `THIRD_PARTY_NOTICES.md`. No hay flujos Keycloak ni servidor OAuth de terceros. Las escrituras son código propio (ADR-044 y siguientes).

## ADR-004 · Perfil: literales de política y entorno que sólo confirma

**Fecha:** 2026-10-18 · **Estatus:** adoptada para los perfiles de lectura; ADR-044 agregó un esquema aparte para el perfil de escritura · **Origen:** D06, D11, CFG-03.
**Decisión:** el esquema del perfil acepta únicamente `read_only: true`, `store_password: false`, `export_to_repository: false` y `secret_backend: "os_keyring"`. Habilitar otra cosa exige cambiar código y tests. Las variables `CAMPUS_*` del ejemplo `.env` no sobreescriben el perfil: si difieren, el proceso no arranca.
**Cambio respecto del hand-off:** el `.env.example` sugería variables configurables; acá sólo pueden coincidir. Motivo: evitar que el entorno del agente cambie campus, cursos o política.

## ADR-005 · Almacén de secretos sin fallback

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** D11, AUTH-07, `06_SEGURIDAD.md`.
**Decisión:** token en el keyring del sistema (`@napi-rs/keyring`, cuenta `perfil|sitio|servicio`, servicio `udesa-campus-mcp`). Si no está disponible: `SECRET_STORE_UNAVAILABLE`, sin archivo plano. La metadata no secreta (método, `userid`, fechas) va a `%LOCALAPPDATA%\udesa-campus-mcp\profiles\<perfil>\session.json`.
**Límite:** un proceso del mismo usuario puede leer ese keyring. Linux sin Secret Service queda no soportado por ahora.

## ADR-006 · Allowlist de funciones en el transporte

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** `04_ARQUITECTURA.md`, POL-04.
**Decisión:** `MoodleTransport.call` rechaza cualquier `wsfunction` fuera de la allowlist de lecturas (`src/moodle/functions.ts`; cada ADR de lectura agrega las suyas), y cualquier parámetro reservado (`wstoken`, `wsfunction`, `moodlewsrestformat`, …). No se siguen redirecciones del REST. Se reintentan sólo errores transitorios (red, 502/503/504) hasta 2 veces, porque todas las funciones permitidas son lecturas.
**`mod_forum_get_discussion_posts`:** no es una función `*_view_*`, pero marca los posts como leídos si el foro tiene seguimiento. Lo cubre la guarda de ADR-030.

## ADR-007 · Identificación de Avisos

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** FOR-01/FOR-02.
**Decisión:** orden de evidencia: `announcement_forum_id` configurado y validado contra el curso → único foro `type=news` de `mod_forum_get_forums_by_courses` → si hay varios `news` o sólo coincidencias por nombre, `AMBIGUOUS_RESOURCE` con candidatos (no se elige). El nombre «Avisos» es pista, nunca selección automática.

## ADR-008 · Paginación y `since`

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** `05_DESCUBRIMIENTO`, FOR-03/FOR-04.
**Decisión:** páginas de 25 con el orden por defecto de Moodle, deduplicación por `discussion_id`, cursor opaco con curso/foro/página/offset validado contra el pedido. `since` incluye una discusión si creación, última actividad, modificación o inicio de visualización son posteriores; no se corta por fecha. Una fecha sola se interpreta como medianoche en `America/Argentina/Buenos_Aires`; una fecha-hora sin zona se rechaza.

## ADR-009 · Códigos de error adicionales

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** contrato `CampusErrorCode`.
**Decisión:** además de los 10 del contrato se agregan `CONFIG_INVALID`, `SECRET_STORE_UNAVAILABLE`, `IDENTITY_MISMATCH`, `UNEXPECTED_RESPONSE`, `AMBIGUOUS_RESOURCE`, `BROWSER_CALLBACK_REJECTED` y `MOODLE_ERROR` (no clasificado, con `errorcode` original). Motivo: no forzar errores distintos en un mismo código ni disfrazar una respuesta HTML como permiso denegado.

## ADR-010 · Archivos

**Fecha:** 2026-10-18 · **Estatus:** adoptada; formatos ampliados por ADR-019 (PDF, ZIP, imágenes, notebooks) y ADR-022 (Office) · **Origen:** `04_ARQUITECTURA.md`, FILE-01…04.
**Decisión:** el modelo sólo puede pasar `file_ref` opacos (emitidos al listar un curso o aviso permitido, válidos 30 min). URLs: sólo HTTPS, mismo origen, rutas de `pluginfile`, sin credenciales ni segmentos codificados; cada redirección se revalida y una cross-origin se bloquea. Formatos: texto, Markdown, CSV/TSV, JSON, código fuente (sin ejecutar) y HTML como texto. PDF/Office/imagen devuelven `UNSUPPORTED_CONTENT` **sin descargar**.

## ADR-011 · Método browser no habilitado en esta iteración

**Fecha:** 2026-10-18 · **Estatus:** reemplazada por ADR-024 (login con Google habilitado y validado) y ADR-025 (retorno automático, en pausa) · **Origen:** D05 (propuesta), PROMPT («implementalo después de la lectura mínima»).
**Decisión:** contrato + núcleo de protocolo con tests; CLI responde «no disponible» en vez de un flujo a medias. Registrar un handler de esquema en Windows cambia configuración del usuario: requiere decisión del propietario. Ver `docs/AUTH_BROWSER.md`.

## ADR-012 · Prueba STDIO y keyring en tests

**Fecha:** 2026-10-18 · **Estatus:** adoptada.
**Decisión:** el test MCP-03 arranca el `build/cli.js` real con un perfil sintético (`campus.example.test`) y un directorio de estado temporal. Ese proceso consulta el keyring real del sistema buscando una entrada inexistente del perfil sintético (lectura; no escribe). No hace requests de red. El resto de los tests usan almacenes en memoria y un `fetch` inyectado.

## ADR-013 · Servidor remoto privado en Vercel (fase 1)

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** pedido del propietario (uso desde claude.ai, ChatGPT web y Codex), que reemplaza para esta fase a D07 («local primero»), ya cumplido.
**Decisión:** endpoint MCP HTTP sin estado en Vercel Hobby (`api/index.js` → `build/remote/`), una sola función en `gru1`, para **un único dueño**. Mismo núcleo y mismas tools que el modo local. El token de Moodle se guarda como variable sensible de Vercel, cargada con `campus remote push-token` (por stdin y validada antes).
**Alternativas:** DB cifrada (Neon/Upstash) para tokens: innecesaria para un usuario. `mcp-handler` de Vercel: dependencia extra; el SDK ya trae `WebStandardStreamableHTTPServerTransport`.
**Límite:** el modo multiusuario («agnóstico») queda explícitamente fuera de esta fase.

## ADR-014 · OAuth propio sin estado, identidad vía GitHub

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** decisión del propietario (GitHub, sólo su cuenta).
**Decisión:** servidor de autorización OAuth 2.1 con DCR (RFC 7591), metadata RFC 8414/9728, PKCE S256 obligatorio y tokens JWT HS256 con un `typ` propio por tipo (cliente, solicitud, estado de GitHub, código, access, refresh). La identidad del dueño se verifica con una OAuth App de GitHub por **ID numérico** (`GITHUB_ALLOWED_USER_ID`), no por nombre. Hay pantalla de consentimiento con advertencia anti-phishing, cookie `__Host-` que ata el login al navegador que lo inició, y callbacks restringidos a claude.ai/claude.com, chatgpt.com y loopback.
**Motivo:** claude.ai y ChatGPT web exigen OAuth (ChatGPT no admite headers fijos); un único mecanismo sirve a los cuatro clientes. Un modo sin autenticación expondría el Campus a cualquiera con la URL.
**Límites:** sin almacenamiento no hay códigos de un solo uso (mitigado con 120 s + PKCE) ni revocación individual (se revoca todo rotando `OAUTH_SIGNING_SECRET`).

## ADR-015 · Configuración remota por variables de entorno

**Fecha:** 2026-10-18 · **Estatus:** adoptada.
**Decisión:** `readRemoteConfig` exige las 7 variables; si falta alguna, todas las rutas protegidas responden 503 sin revelar valores. `/health` sólo dice si está configurado. La identidad Moodle esperada (`CAMPUS_EXPECTED_USERID`) se compara en cada verificación: un token de otra cuenta devuelve `IDENTITY_MISMATCH` y no expone datos.

## ADR-016 · Perfil `udesa-docente`: alcance por rol docente

**Fecha:** 2026-10-18 · **Estatus:** adoptada; modificada por ADR-122 (`udesa-docente` pasa a `enrolled`) · **Origen:** pedido del propietario («un perfil que englobe todos los cursos en los cuales soy docente»).
**Decisión:** nuevo `course_scope: "teaching"`. Los cursos permitidos se resuelven en vivo para el usuario **verificado**: cursos matriculados (`core_enrol_get_users_courses`) × rol en cada uno (`core_user_get_course_user_profiles`, una consulta por curso porque Moodle deduplica por usuario), con roles `editingteacher` y `teacher` y exclusiones opcionales (`excluded_course_ids`). Caché de 30 min. Un fallo al resolver es un error, nunca «sin cursos» ni «todos». El perfil `udesa-curso` (allowlist de un curso) se conserva como ejemplo. Local y remoto pasan a `udesa-docente`; el token se copia con `campus auth copy` (validado, sin contraseña).
**Evidencia real:** en la cuenta del dueño, los cursos con rol docente quedan dentro y los de estudiante, fuera.
**Consecuencia:** un curso nuevo como docente entra solo, sin tocar el perfil. Para dejar uno afuera: `excluded_course_ids`.

## ADR-017 · Datos de estudiantes en local y remoto, con minimización

**Fecha:** 2026-10-18 · **Estatus:** adoptada; la exclusión de notas y devoluciones fue reemplazada por ADR-022 (y ADR-027 para devoluciones); la minimización de datos de perfil, por ADR-124 · **Origen:** decisión explícita del propietario (opción «En local y en remoto», frente a «sólo local» recomendada por el agente).
**Decisión:** las tools de entregas están disponibles en ambos modos. Minimización: sólo nombre, grupos, estado y fechas; se descartan email, legajo, usuario y datos de perfil por proyección de esquema; nunca se devuelven notas ni devoluciones (no se declara `feedback`). En corrección anónima no se cruzan fechas de `mod_assign_get_submissions` para no revelar identidades y no se usa `mod_assign_reveal_identities` (escritura). Cada pedido verifica curso → tarea → participante antes de consultar.
**Riesgo aceptado:** en modo remoto el contenido de las entregas pasa por Vercel y por el proveedor del cliente (OpenAI/Anthropic). Antes de usar el modo remoto con datos de estudiantes, verificá la política de tu institución.

## ADR-018 · Lecturas ampliadas

**Fecha:** 2026-10-18 · **Estatus:** adoptada.
**Decisión:** 6 tools nuevas: tareas, estado de entregas, entrega individual, eventos de calendario del curso (sin eventos personales ni del sitio), recursos (páginas, enlaces, archivos) y página completa. Funciones agregadas a la allowlist del transporte: `mod_assign_get_assignments`, `mod_assign_list_participants`, `mod_assign_get_submissions`, `mod_assign_get_submission_status`, `core_calendar_get_calendar_events`, `mod_page_get_pages_by_courses`, `mod_url_get_urls_by_courses`, `mod_resource_get_resources_by_courses`, `core_user_get_course_user_profiles`. Ninguna es `*_view_*`. Se excluyó `core_calendar_get_calendar_export_token` (crea un token).
Las entregas reales suelen ser ZIP y PNG; su lectura: ADR-019.

## ADR-019 · Lectura de ZIP, PDF, imágenes y notebooks

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** pedido del propietario tras ver que las entregas reales son ZIP y PNG.
**Decisión:**
- **ZIP:** lector propio sobre `zlib` (sin dependencia), sólo en memoria. «Store» y «deflate»; rechaza cifrado, ZIP64, ZIP anidado y Office. Límites: 5000 entradas, 20 MB por entrada, relación de compresión > 200 en entradas > 1 MB, salida real ≤ tamaño declarado (`maxOutputLength`) y CRC-32 verificado. Sin `entry` lista; con `entry` lee esa entrada con el mismo pipeline. Marca basura de macOS/Windows.
- **PDF:** `pdfjs-dist` 6.4.299 (Apache-2.0), sólo texto, `isEvalSupported: false`, sin fuentes del sistema, 20 páginas por llamada y continuación con `page_start`. Un PDF escaneado se informa, no se inventa texto. Las tablas se aplanan (verificado con el cronograma real).
- **Imágenes:** PNG/JPEG/GIF/WebP verificadas por firma binaria (no por extensión), hasta 3,75 MB, devueltas como bloque `image` de MCP fuera del JSON.
- **Notebooks:** Markdown con celdas de código y salidas de texto registradas (no ejecutadas); las salidas con imágenes se cuentan.
**Office** (docx/pptx/xlsx): ADR-022.

## ADR-020 · `file_ref` como localizador sin estado

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** bug real del modo remoto.
**Problema observado:** las `file_ref` eran ids en la memoria del proceso. En Vercel, `campus_get_course` y `campus_read_file` cayeron en instancias distintas → «referencia desconocida». Los tests en un solo proceso no lo mostraban.
**Alternativa descartada:** referencias firmadas con HMAC (implementada y probada): funcionaban, pero medían ~700 caracteres; en un curso con muchos archivos sumaban decenas de miles de caracteres de referencias, difíciles de copiar sin errores para un modelo.
**Decisión:** `file_<tipo>.<ids>.<hash8 del nombre>` (p. ej. `file_m.12345.67890.7ec17573`): módulo, post, consigna, entrega o recurso. Al leer, el servidor vuelve a pedir ese objeto a Moodle con todas las verificaciones (curso en alcance, discusión en un foro del curso, participante de la tarea) y toma la URL real de ahí. Sin estado, sin firma ni vencimiento: un localizador inventado sólo alcanza lo que ya era legible con las tools, y uno desactualizado falla en vez de devolver otro archivo. Costo: una consulta más a Moodle por lectura.
**Validación:** tests de instancia nueva y de localizadores manipulados; en producción, un PDF de un curso emitido y leído por el conector remoto.

## ADR-021 · JSON compacto en las respuestas MCP

**Fecha:** 2026-10-18 · **Estatus:** adoptada.

**Decisión:** las respuestas van en JSON compacto, sin indentar: mismo contenido, menos tokens (indentado, `campus_get_course` de un curso real medía 72 KB).

## ADR-022 · Lectura ampliada II: notas, cuestionarios, participantes, grupos, mensajes

**Fecha:** 2026-10-18 · **Estatus:** adoptada; minimización de participantes y notas modificada por ADR-124 · **Origen:** pedido del propietario («todo lo razonable, incluso asistencia y foros», con grupos, participantes, notas, intentos de cuestionarios, mensajes y comentarios). **Reemplaza** la exclusión de notas de ADR-017.
**Decisión:** 11 tools nuevas (25 en total, todas de lectura): cuestionarios, cambios desde una fecha, búsqueda en foros, participantes, grupos (con inscripción `choicegroup`), calificaciones, intentos y revisión de intentos, sesiones de asistencia, conversaciones y mensajes. Además: texto de etiquetas en `campus_get_course`, comentarios en `campus_get_submission` y Word/PowerPoint/Excel en `campus_read_file`.
**Minimización (por proyección de esquema):** sin contraseña ni red de cuestionarios, sin clave de inscripción de grupos, sin email, legajo, país, descripción ni fotos de participantes, sin `useridnumber` en notas. Devoluciones escritas sólo con `include_feedback`. Mensajes: sin marcar como leídos; no se limitan a los cursos (son de la cuenta) y se advierte que pueden incluir terceros.
**Verificaciones:** intento → cuestionario del curso → participante matriculado; notas e intentos de un participante sólo si está matriculado.
**Límites observados en UdeSA:** `core_notes` está deshabilitado («las anotaciones están deshabilitadas»); `mod_attendance` no está en el servicio, así que sólo se leen sesiones del calendario (el registro por alumno sale de la app móvil: ADR-028).
**Excluidas siempre aunque parezcan lecturas:** `tool_mobile_get_autologin_key`, `tool_mobile_get_tokens_for_qr_login`, `mod_wiki_get_page_for_editing`, `mod_h5pactivity_log_report_viewed`, `core_calendar_get_calendar_export_token`, `*_view_*`.

## ADR-023 · Codificación de archivos de texto

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** pregunta del propietario sobre `.py` reales.
**Problema:** la decodificación UTF-8 «tolerante» reemplazaba en silencio caracteres inválidos por «�» si eran pocos (p. ej. un `.py` guardado como ANSI con algunas tildes).
**Decisión:** UTF-8 estricto → UTF-16 con BOM → Windows-1252 con aviso; binario (bytes nulos o controles) se rechaza. La salida informa `encoding`.
**Validado en real:** archivos `.py` de entregas dentro de ZIPs y de materiales, leídos completos (UTF-8).

## ADR-024 · Login con Google: lanzamiento móvil con `oauthsso` y retorno manual

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** P4 del hand-off; validación pedida por el propietario.
**Decisión:** `auth login --method browser` lee la configuración pública de login (sin token) para encontrar el proveedor OAuth2 del Campus (UdeSA: `id 4`, «Continuar con cuenta institucional UdeSA»), arma `admin/tool/mobile/launch.php?service=…&passport=<aleatorio>&urlscheme=udesacampusmcp&oauthsso=4&confirmed=1` y lo abre en el navegador normal del dueño. Con `confirmed=1`, Moodle 5.1 termina en una página «Confirmado» con el enlace de retorno visible, que el humano copia con clic derecho y pega en la terminal con entrada oculta. La CLI valida transacción (hash `md5(wwwroot+passport)`, 10 min, uso único, esquema) y luego token, sitio e identidad con la misma ruta que el login nativo.
**Alternativas descartadas:** redirección directa sin `confirmed` (Chrome descarta en silencio el esquema sin manejador y la página de Google parece congelada); navegador embebido o automatizado para Google (contrario a la política de Google y al hand-off); registrar `moodlemobile` (es de la app oficial).
**Esquema forzado:** si el sitio forzara `moodlemobile`, el importador manual acepta ese retorno sólo en este flujo (no se registra ni intercepta nada) y lo informa.
**Validación real:** el mismo userid que el login nativo; el Campus respetó `udesacampusmcp`; Moodle reutilizó el mismo token. Guía de uso: `docs/LOGIN_GOOGLE.md`.
**Retorno automático:** registrando `udesacampusmcp` en Windows, en ADR-025 (en pausa).

## ADR-025 · Retorno automático del login con Google en Windows

**Fecha:** 2026-10-18 · **Estatus:** adoptada; en pausa por decisión del dueño · **Origen:** pedido y consentimiento explícito del propietario para registrar el esquema en su Windows.
**Decisión:** `auth handler install|uninstall|status` registra `udesacampusmcp` sólo en `HKCU\Software\Classes` (sin administrador), con `reg.exe` sin shell. Windows abre `node <cli.js> auth callback --scheme udesacampusmcp "%1"`, que entrega el enlace por un named pipe del usuario (`\\.\pipe\udesa-campus-mcp-<hash de usuario+esquema>`) al `auth login --method browser` que espera, con un protocolo de una línea (4 KB máx.) y confirmación. El login espera a la vez el canal y el pegado manual; gana el primero.
**Seguridad:** el canal no es un secreto: cualquier proceso del mismo usuario podría escribir en él, pero un enlace sin el passport de ESE intento no pasa el hash. El manejador nunca imprime, guarda ni loguea el enlace. Nunca se registra `moodlemobile`.
**Hallazgos:** el medio-cierre de sockets en named pipes impedía la confirmación (detectado por test; se pasó a protocolo de línea). Windows agrega una barra final al enlace; se tolera UNA y sólo si el original no decodifica.
**Límites:** sólo Windows. Si se mueve el proyecto o cambia Node, hay que reinstalar (la CLI lo detecta).
**Estado:** funciona en un Chrome limpio del mismo equipo, pero no en los perfiles reales del dueño (causa sin identificar). En pausa por decisión del dueño.

## ADR-026 · Vista completa del curso: subsecciones, resúmenes, fechas y carpetas

**Fecha:** 2026-10-18 · **Estatus:** adoptada · **Origen:** pedido del propietario («entrar a un curso y ver todos los elementos de las secciones»).
**Problema:** Moodle 5 devuelve las subsecciones (`mod_subsection`) como secciones sueltas al final de la lista, y la salida las mostraba planas, sin relación con la sección que las contiene. Los resúmenes de sección se recortaban a 400 caracteres, no se veían las fechas de las actividades y dos archivos con el mismo nombre en distintas subcarpetas de una Carpeta compartían `file_ref`.
**Decisión:**
- Cada módulo `subsection` lleva su subsección anidada (`subsection`), y las secciones delegadas no se repiten arriba. Moodle no permite subsecciones dentro de subsecciones, y se impone profundidad 1. Una subsección cuyo módulo no se ve se reporta en `orphan_subsections` con aviso.
- Resumen de sección en texto hasta 2000 caracteres en la vista completa, con `summary_truncated`. Con `section_number` sale una sola sección con el presupuesto completo del perfil.
- Archivos del Campus embebidos o enlazados en un resumen: nuevo localizador `file_c.<curso>.<sección>.<hash>`, que se resuelve releyendo esa sección. Sólo se aceptan URLs `pluginfile` del mismo sitio.
- Fechas de actividad (`dates`) con la etiqueta de Moodle.
- En Carpetas, `folder_path`. El hash del localizador incluye la ruta sólo fuera de la raíz, así que los `file_ref` existentes siguen valiendo.

## ADR-027 · Devoluciones, pendientes y notificaciones

**Fecha:** 2026-10-18 · **Estatus:** adoptada; minimización de notificaciones modificada por ADR-124 · **Origen:** pedido del propietario, a partir del relevamiento de `docs/HERRAMIENTAS.md`.
**Devoluciones:** `campus_get_submission` con `include_feedback` expone nota (`-1` de Moodle → `null`), texto de la calificación, fecha, comentario de retroalimentación (hasta 4000 caracteres) y archivos de devolución, incluido el PDF anotado (`editpdf`). Los archivos usan el localizador `file_f.<curso>.<tarea>.<participante>.<hash>`, que se resuelve releyendo la entrega verificada. Nunca se expone quién calificó. Sin el parámetro, no hay nota ni devolución, como en `campus_get_grades`.
**Pendientes:** el primer diseño usaba la línea de tiempo de Moodle (`core_calendar_get_action_events_by_courses`). En UdeSA devolvió 0 eventos para el docente aunque una tarea vencía ese día con entregas por corregir, así que se descartó y se retiró de la allowlist. `campus_list_pending` lo calcula con el estado de entregas de cada tarea (por corregir = «requiere calificación») y con los vencimientos del calendario, excluyendo las sesiones de asistencia. Las consultas van en paralelo, con el límite de concurrencia del perfil.
**Notificaciones:** `message_popup_get_popup_notifications`, con proyección mínima (asunto, mensaje corto, componente, fecha, leído, enlace sin token). Se descartan remitente y cuerpo completo. No marca como leídas: dos lecturas seguidas devuelven el mismo `unreadcount`. Como los mensajes, no se limitan a los cursos del perfil.

## ADR-028 · Asistencia por la vía de la app móvil, con candado

**Fecha:** 2026-10-18 · **Estatus:** adoptada; el candado de rol es la regla general de ADR-122 · **Origen:** pedido del propietario de leer la asistencia de los alumnos.
**Contexto:** las funciones `mod_attendance_*` no están en el servicio de UdeSA. Sí lo está `tool_mobile_get_content`, que ejecuta los métodos móviles de los plugins, y `mod_attendance` (versión 2025122100) declara el manejador móvil `view`.
**Revisión del código (versión exacta, commit 7f6c8b1e52 de danmarsden/moodle-mod_attendance):**
- `mobile_teacher_form` sólo lee: estados del curso, alumnos de la sesión y `attendance_log` de esa sesión.
- `mobile_view_activity` lista las sesiones de la ventana móvil del sitio (6 h atrás, 24 h adelante). **Escribe asistencia** si un docente le pasa claves `status<id>`, y a los alumnos puede marcarlos solos; ninguna de las dos cosas aplica a esta lectura.
**Decisión:**
- `tool_mobile_get_content` entra en la allowlist, pero el transporte la acota con `MOBILE_CONTENT_POLICY`: sólo `mod_attendance`, sólo esos dos métodos, sólo los argumentos `cmid`, `courseid`, `sessid` y `appversioncode`, y nunca `status*`. Cualquier otro componente, método o parámetro devuelve `POLICY_DENIED` antes de salir a la red.
- `campus_get_attendance` combina el registro de las sesiones de la ventana con el resumen acumulado del ítem de asistencia del libro de calificaciones.
- Los `sessid` sólo se toman de lo que lista `mobile_view_activity` para esa actividad. `mobile_teacher_form` no verifica que la sesión sea de la actividad, así que un ID ajeno podría leer otro curso; por eso nunca se aceptan IDs de afuera ni se prueban IDs.
- Si la plantilla HTML cambia, se informa «formato no reconocido», nunca «sin asistencia».
**Candado de rol:** `mobile_view_activity` llama a `take_from_student()` si la cuenta no tiene `mod/attendance:takeattendances` y hay una sesión con autoregistro sin contraseña, así que una «lectura» podría registrar la asistencia de la propia cuenta. Por eso `campus_get_attendance` exige rol docente o superior en el curso antes de cualquier llamada a la app móvil; si no, `POLICY_DENIED` (la regla general de datos de terceros de ADR-122).
**Sesiones pasadas:** la ventana móvil no las incluye; el historial por sesión sale de ADR-040.

## ADR-029 · Resumen de actividades de Moodle 5

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** relevamiento de un agente externo, a pedido del propietario.
**Evaluadas:** `core_course_get_user_navigation_options` y `core_course_get_user_administration_options` sólo informan qué áreas del Campus habilita cada curso; en los cursos probados dan lo mismo y no aportan datos. No se agregan. `core_courseformat_get_overview_information` es la página «Resumen de actividades»: en el código de Moodle 5.1 sólo verifica `moodle/course:viewoverview` y no registra vistas, porque eso lo hace `core_courseformat_log_view_overview_information`, que no se usa.
**Decisión:**
- `campus_get_course_overview` normaliza cada celda según su tipo (nombre, fecha, diálogo, acción, valor) a `value`, `text`, `alert` y `link` sin token. Los controles de la web, como los interruptores de suscripción del foro, quedan como texto. Sin `modname` recorre los tipos presentes en el curso y omite recursos, enlaces, carpetas, páginas y etiquetas.
- `campus_list_pending` toma «Pendientes por calificar» del resumen: una llamada por curso en lugar de dos por tarea. Es bastante más rápido con varios cursos. Si el resumen falla o no coincide con las tareas del curso, vuelve al cálculo alumno por alumno de ADR-027 y lo avisa (`method`).
**Diferencia de conteo:** en tareas grupales Moodle cuenta entregas de grupo. En una tarea grupal real, el resumen contó entregas de grupo, menos que los alumnos del cálculo anterior. Se documenta en la respuesta.

## ADR-030 · Lectura de posts de foros sin marcarlos como leídos

**Fecha:** 2026-10-19 · **Estatus:** modificada por ADR-039 (la guarda queda como opción `avoid_mark_read`) · **Origen:** auditoría de efectos de la directiva de lecturas docentes (§4.2).
**Hallazgo:** `mod_forum_get_discussion_posts` llama a `forum_tp_mark_posts_read` cuando el sitio no exige marcado manual (`forum_usermarksread`) y el foro está bajo seguimiento para la cuenta (Moodle 5.1, `mod/forum/externallib.php`, revisión `7637a7b`). La configuración del sitio no es legible por el servicio. En UdeSA, los 7 foros de los 4 cursos estaban bajo seguimiento (`istracked: true`). Hasta esta corrección, `campus_get_discussion` y la lectura de adjuntos de posts pudieron marcar posts como leídos; además, la verificación de pertenencia ocurría después de la llamada.
**Decisión:**
- La discusión se ubica y se verifica con `mod_forum_get_forum_discussions`, que no marca nada, antes de cualquier lectura de posts.
- Inmediatamente antes, `mod_forum_get_forums_by_courses` informa `istracked`, que es exactamente la condición del marcado. El lector de posts sólo se llama si es `false`.
- Con seguimiento, `campus_get_discussion` entrega el primer post (`read_mode: "primer_post"`, `replies_omitted`, cobertura parcial). Los adjuntos de respuestas devuelven `POLICY_DENIED`.
- La búsqueda en respuestas completas sigue fuera de alcance.
**Para leer el hilo completo:** desactivar «Rastrear mensajes no leídos» en ese foro del Campus. Si el sitio fuerza el seguimiento, no hay lectura completa por esta vía.
**Riesgo residual:** si la cuenta reactiva el seguimiento entre las dos llamadas del mismo pedido (milisegundos), el marcado podría ocurrir. Se acepta y se documenta.

## ADR-031 · Excepción de política: lectura del libro de calificaciones

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** decisión explícita del propietario.
**Hallazgo:** `gradereport_user_get_grade_items` (usado por `campus_get_grades` y por el resumen de `campus_get_attendance`) ejecuta siempre `grade_regrade_final_grades($course->id)` (`grade/report/user/classes/external/user.php`, revisión `7637a7b`). Recalcula y guarda las notas finales que Moodle ya marcó como desactualizadas, y puede crear el ítem de total del curso si falta. Es lo mismo que hace la web al abrir el libro de calificaciones.
**Decisión:** el propietario aprobó mantener esta lectura como excepción explícita a la política de efectos. No se extiende a otras funciones: estadísticas de cuestionarios, `core_grades_get_grade_tree` y cualquier otra fuente que calcule o repare quedan bloqueadas. Las respuestas de notas lo advierten.

## ADR-032 · Fechas efectivas y etiquetas de categoría (P1)

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva de lecturas docentes, §6.1 y §6.2.
**Fechas:** `mod_assign_get_participant` devuelve las fechas de `get_instance($userid)`, con overrides de usuario y grupo aplicados por Moodle, y `grantedextension` como booleano. La fecha de la prórroga sale de `mod_assign_get_submission_status`. No se reconstruye precedencia propia. Se consulta sólo en `campus_get_submission`, una llamada por pedido; los listados y `campus_list_pending` no la usan. En `campus_get_submission`, `late` se calcula con la fecha efectiva; si no se resuelve, queda `null` (no se recurre a la fecha general).
**Etiquetas:** `core_grades_get_gradeitems` da la categoría padre de cada ítem, sin árbol, reglas ni totales. Se une por ID; si falla, sólo `category_label` queda desconocido y la cobertura lo declara.
**Grupos de actividad (§6.3):** `campus_list_groups` con `course_module_id` agrega el modo de grupos de la actividad y los grupos que la cuenta puede seleccionar, filtrados a los del curso. No se deriva autorización de la pertenencia. En un curso real, una tarea con entrega grupal tenía modo «sin grupos»: entrega grupal y modo de grupos son independientes.
**Validación real:** fechas efectivas resueltas e iguales a la base cuando no hay overrides; todos los ítems con etiqueta salvo el total del curso.

## ADR-033 · Sesión web y operaciones web admitidas

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva de lecturas docentes, §3.1 y §5.
**Decisión:** proveedor de sesión web independiente del token móvil. Guarda un snapshot de cookies de Moodle (`MoodleSession*`, `MOODLEID*`) atado a origen, subruta e identidad, con revisión. En local va al keyring, sin respaldo en archivo; en remoto, en `CAMPUS_WEB_SESSION`, sensible.
**Operaciones:** cada operación verifica identidad en `/user/preferences.php` (sin eventos ni escrituras) y obtiene el `sesskey`. Después sólo emite rutas y AJAX del registro `src/web/policy.ts`, con parámetros cerrados. Prohíbe `delete`, `regrade`, `recalculate`, preferencias de tabla y credenciales. Valida redirecciones (fuera del Campus o a login: se corta), tiene presupuesto de peticiones y nunca expone cookies ni `sesskey`.
**Provisión:** `campus auth web import` (entrada oculta o stdin) valida la cookie antes de guardarla; `campus remote push-web-session` la publica. Las rotaciones en remoto viven sólo durante la operación.
**Límite:** la sesión dura lo que dura en el Campus (inactividad, cierre de sesión). El control de IP de sesión del sitio no está verificado.

## ADR-034 · Estructura de cuestionarios y preguntas

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva de lecturas docentes, §7 y §8.
**Fuentes descartadas por efectos:** `/mod/quiz/edit.php` puede crear categorías por defecto; la preparación de banco, importación y exportación (`question_edit_setup`) también.
**Estructura:** AJAX `mod_quiz_get_edit_grading_page_data`, auditado como sólo lectura. Da secciones, slots reales, números mostrados, notas e ítems de calificación. No trae páginas ni versiones. Las preguntas fijas muestran `question_id` en el enlace de edición sólo si la cuenta puede editarlas. Las aleatorias muestran banco y categoría en el filtro del enlace al banco (se leen como dato; nunca se visitan).
**Inventario:** `core_question_get_random_question_summaries` es un contrato limitado a candidatos aleatorios. Se usa sólo para categorías justificadas por una regla aleatoria de un cuestionario del curso, sobre un banco del mismo curso. Una regla que apunta a un banco de otro curso se informa, pero no autoriza a listarlo.
**Contenido:** `exportone.php` con `cmid` = banco verificado y sólo para preguntas encontradas entre esos candidatos. Parser XML propio sin DTD ni entidades, con límites, y parsers por tipo core. Los archivos embebidos se leen por referencia, con ubicación, nombre y ordinal reverificados.
**Límite demostrado:** preguntas fijas fuera de categorías verificadas. Su banco de origen no es observable y la exportación lo exige; no se sustituye por el cuestionario ni por el curso.

## ADR-035 · Reportes docentes con variantes cerradas; estadísticas bloqueadas

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva de lecturas docentes, §9.
**Fuentes:** `report/log` con `download=csv` (columnas de `report_log\table_log`, en orden fijo de 9; se verifica la cantidad y la forma de la IP, que se descarta). `report/participation` en HTML (filas por enlace `user/view.php?id=…` y casilla `user<id>` con la cantidad; grupo efectivo del selector). `mod/quiz/report.php?mode=responses` con `download=csv` (encabezados reconocidos en es/en; columnas de identidad extra descartadas).
**Efectos auditados (revisión `7637a7b`):** los tres registran `report_viewed`, un registro de acceso inherente a la lectura que no marca vistas de actividades ni finalización. Por GET no guardan preferencias: las tablas no son persistentes y las opciones del reporte de cuestionario sólo se guardan al enviar el formulario. La política prohíbe `delete`, `regrade`, `tsort`, `thide` y similares.
**Estadísticas:** el reporte calcula y guarda caché cuando la consultás; no hay fuente que lea sólo resultados existentes. Bloqueadas: `kind=statistics` devuelve `POLICY_DENIED` sin emitir red.
**Límites:** sin ID de evento ni de intento en las descargas, día como unidad de filtro en registros, «desde» en participación, idioma del sitio en es/en para respuestas.

## ADR-036 · Configuración legible de tareas y cuestionarios

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva de lecturas docentes, §11.
**Decisión:** `campus_get_activity_settings` con esquema cerrado por tipo, a partir de lecturas REST existentes (y un AJAX de sólo lectura para overrides de cuestionario). Las fechas distinguen configurada, desactivada (0) y desconocida. Las restricciones distinguen ninguna, configuradas (con tipos de condición) y desconocidas. Las fechas efectivas son las de Moodle (`mod_assign_get_participant`). Los overrides se muestran como están, sin precedencia propia y sin contraseñas. Nunca se abren formularios de edición (crean borradores).
**Límite:** sólo tareas y cuestionarios; valores por defecto del sitio y opciones de revisión desconocidos.

## ADR-037 · Árbol de calificaciones, H5P y observaciones por contexto

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva de lecturas docentes, §10, §12 y §13.
**Árbol de calificaciones:** `core_grades_get_grade_tree` (`fetch_course_category`, `get_children`) puede crear la categoría del curso y reparar `path`/`depth`. Queda bloqueada, y no hay otra fuente admisible del árbol ni de las reglas: limitación demostrada. Se mantienen las notas y `category_label` (ADR-032).
**H5P:** no hay actividades H5P en los cuatro cursos: no aplicable con las muestras actuales. El reproductor (`/mod/h5pactivity/view.php`) registra vista y finalización y no se usa.
**Capacidades:** el registro guarda observaciones por capacidad y curso (`context_checks`), declara las capacidades web (`transport: "web"`, disponibilidad no evaluada en la lista del servicio) y las bloqueadas (`read_quiz_statistics`, `read_grade_tree`).

## ADR-038 · Mantener viva la sesión web (keepalive local)

**Fecha:** 2026-10-19 · **Estatus:** adoptada; en una PC administrada no es viable (ADR-087) y la alternativa opcional es ADR-088 · **Origen:** pedido del propietario (evitar reimportar la sesión web cada vez que vence); la directiva permite el mantenimiento de una sesión importada, no el autologin.
**Auditoría (Moodle 5.1, `7637a7b`):** la sesión vence cuando pasan `sessiontimeout` segundos sin peticiones. Cada petición autenticada renueva ese plazo, como mucho una vez cada 20 s (`core\session\manager`). `core_session_time_remaining` sólo lee el registro de la sesión. `core_session_touch` no hace falta, porque la página de identidad ya renueva el plazo, así que no se agrega.
**Decisión:**
- `auth web status --verify` y `auth web keepalive` hacen la verificación de identidad de siempre (que renueva) y después `core_session_time_remaining`, sin argumentos. Así miden el límite de inactividad del Campus. Si la medición falla, la sesión igual queda verificada y se avisa.
- El resultado se guarda sin secretos en `web-session-state.json` del perfil: momento, código, límite y revisión. También se registra la revisión publicada con `remote push-web-session`, para avisar cuando la cookie local rotó y el remoto quedó con otra.
- `auth web keepalive install|uninstall|status` crea, sólo con consentimiento del dueño, una tarea programada de Windows para el usuario actual, sin administrador. Corre cada N minutos (30 por defecto, entre 5 y 240) y al iniciar sesión, sin ventana (`conhost.exe --headless`), también con batería y sin superponerse.
- Se instala sólo con una sesión válida y con un intervalo de como mucho el 60 % del límite medido. Corre únicamente con la sesión de Windows iniciada, porque necesita el keyring del usuario.

**Medido en UdeSA:** límite de inactividad de 4 h (14 400 s).
**Alternativas descartadas:**
- Cron de Vercel: en Hobby corre una vez por día.
- GitHub Actions y servicios de cron externos: horario impreciso y otro lugar que guardaría la cookie.
- `tool_mobile_get_autologin_key`: prohibido.
- Tarea «sin sesión iniciada» (S4U): no accede al keyring del usuario.

**Riesgo aceptado:** una sesión que no vence alarga la exposición si la cookie se filtra. El corte es «Cerrar sesión» en el navegador de origen (PROCESOS.md).
**Límites:**
- Con la PC apagada o suspendida más de 4 h, la sesión vence y hay que reimportarla.
- El remoto se beneficia porque comparte la sesión del lado del Campus, salvo que la cookie haya rotado desde la publicación.

## ADR-039 · Excepción del dueño: leer foros con seguimiento aunque se marquen como leídos

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** decisión explícita del propietario («no me molesta que algunas cosas se marquen como leídas»). Modifica ADR-030.
**Decisión:**
- `campus_get_discussion` lee siempre el hilo completo con `mod_forum_get_discussion_posts`. En foros con seguimiento de no leídos, Moodle marca esos posts como leídos para la cuenta del dueño. La respuesta lo declara con `marked_read: true` y un aviso.
- `avoid_mark_read: true` conserva la guarda de ADR-030: si el foro tiene seguimiento, no se llama al lector y sólo se entrega el primer post.
- Los adjuntos de respuestas (`file_p`) vuelven a resolverse.
- `campus_search_forums` gana `include_replies`. Abre cada discusión candidata, hasta 60 por pedido en orden de actividad, y busca en todos los posts. Informa el post, el autor y cuántas discusiones quedaron marcadas como leídas. El seguimiento se consulta una sola vez por pedido.
- La verificación de pertenencia (discusión → foro → curso) sigue antes del lector. La respuesta del lector se vuelve a validar (curso, foro, discusión).

**Anotaciones MCP:** se conserva `readOnlyHint`. El único efecto es el estado de lectura de la propia cuenta, y el dueño lo aceptó; no cambia contenido del curso (mismo criterio que ADR-031).
**Detalles del marcado:**
- El adjunto del primer post (por ejemplo, el de un aviso) se resuelve con el listado de discusiones, sin el lector. El adjunto de una respuesta sigue leyendo el hilo y lo declara en los avisos de `campus_read_file`.
- El cursor de `campus_get_discussion` guarda si la lectura fue con `avoid_mark_read`. Continuarlo sin repetir el parámetro no lee ni marca el hilo completo. Si el parámetro contradice al cursor, se rechaza.
- `include_replies` abre sólo las discusiones con respuestas (`numreplies > 0`, o desconocido). El primer post de las demás se busca en el listado. El límite de 60 cuenta sólo las que se abren.
- Un foro que no aparece en `mod_forum_get_forums_by_courses` se cuenta como con seguimiento al informar `marked_read_discussions`, igual que en `postReaderIsSafe`.

**Validación real:** la búsqueda con respuestas abrió 25 discusiones (29 posts). Una discusión de 5 posts se leyó completa con `marked_read: true`. Con `avoid_mark_read` se obtuvo el primer post y 4 respuestas omitidas.
**Cierra:** la fila condicional «Búsqueda en respuestas de foros» de la directiva de lecturas docentes.

## ADR-040 · Historial de asistencia por sesión

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** pedido del propietario. Resuelve el límite de ADR-028: las sesiones viejas no tenían un ID accesible.
**Auditoría (plugin `mod_attendance` 2025122100 = commit `7f6c8b1e` de `MOODLE_500_STABLE`):**
- `mod/attendance/manage.php` lista todas las sesiones con su ID (checkbox `sessid[]`). Con `view=5` (todas) no pagina. Una sesión tomada tiene la fecha enlazada a «cambiar asistencia», o en cursiva si la cuenta no puede cambiarla.
- No dispara eventos ni escribe en la base. Guarda en la **sesión** (`$SESSION`, no persistente) la vista y el tipo de sesión del curso. Esa sesión es la misma que la del navegador de origen, así que su vista de Asistencia puede cambiar a «todas». Nunca se envía `from`, que con `from=block` redirige a tomar asistencia.
- `report.php` y `export.php` se descartaron: no identifican las sesiones por ID, y la exportación es un formulario POST.

**Decisión:**
- `campus_get_attendance` con `include_history` (requiere sesión web) lista las sesiones por la web.
- Lee cada sesión **tomada** con `mobile_teacher_form`, la misma vía auditada en ADR-028 y con el mismo candado: nunca argumentos `status*`.
- Devuelve el registro por sesión y los totales por alumno (`by_student`). Filtra por `from`/`to`. Con más sesiones que `max_sessions` (40, máximo 120), lee las más recientes y lo avisa.
- Las fechas y horas se interpretan del texto del Campus («lun 3 ago 2026», «9AM - 1:15PM», también inglés y 24 h). Una fecha no interpretada queda fuera de un filtro y se avisa.

**Límites:**
- Los alumnos son los inscriptos hoy; los registros de alumnos que ya no figuran se cuentan (`records_outside_roster`).
- No incluye observaciones (remarks).
- Sólo considera sesiones desde el inicio del curso (filtro del plugin).

**Validación real:**
- Validado en un curso real: se leyeron todas las sesiones tomadas, con fechas y horas interpretadas, y los totales por alumno, incluidos registros fuera del padrón.

## ADR-041 · Exportación por categoría (directiva §7.3)

**Fecha:** 2026-10-19 · **Estatus:** adoptada; modificada por ADR-086 · **Origen:** directiva de lecturas docentes, §7.3 (había quedado sin resultado de cierre).
**Auditoría (Moodle 5.1, `7637a7b`):**
- `pluginfile.php/<contexto>/question/export/<categoría>/xml/withcategories/withcontexts/<archivo>.xml` entra por `question_pluginfile`. Exige el permiso de exportar en el contexto, lee la categoría y las últimas versiones (`get_questions_category`, ordenadas por categoría) y arma el archivo en memoria. No pasa por `question_edit_setup`, que es lo que puede crear categorías.
- Exporta la categoría **con sus descendientes**. Omite versiones ocultas, preguntas aleatorias, tipos ausentes y preguntas sin permiso de ver.
- Emite un nodo de categoría cada vez que cambia el bloque, e incluye los padres vacíos.

**Decisión:**
- `campus_get_question_category` usa sólo el contexto del banco del curso y una categoría justificada por una regla aleatoria (la misma verificación que el inventario).
- Reconcilia la exportación con el inventario de candidatos por tipo + nombre, y sólo cuando el par es único. Así obtiene `inventory_question_id` y `reconciliation`: candidatos no exportados, exportados sin candidato y ambiguos.
- Si la regla no incluye subcategorías, aísla la categoría con la ruta que comparten los pares únicos. Si no puede, responde `POLICY_DENIED` sin entregar nada (ADR-086).
- Pagina sobre la exportación completa. Los archivos embebidos sólo tienen `ref` en preguntas con candidato único, y se leen por exportación individual.

**Validación real:** en el sandbox, con el banco propio de un cuestionario con reglas aleatorias (ADR-107): exportación reconciliada 3 de 3.

## ADR-042 · Cierre de lecturas: ficha del curso, reglas de acceso, nota del cuestionario y calificación avanzada

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** pedido del propietario de cerrar las lecturas antes de planificar escrituras.
**Ficha del curso:**
- `core_course_get_courses_by_field` es de sólo lectura. Sin `field` devuelve todos los cursos del sitio, así que la política admite sólo `field=id` con un curso permitido.
- `campus_get_course` agrega `info` en la vista completa (nombre, categoría, resumen, fechas, formato, modo de grupos, contactos, métodos de inscripción, campos personalizados). La proyección excluye imágenes, filtros y archivos.

**Reglas de acceso:**
- `mod_quiz_get_quiz_access_information` (`access_manager::describe_rules`, `prevent_access`) es de sólo lectura.
- Va en `campus_get_activity_settings` como `access_rules`: descripciones, plugins activos y motivos de bloqueo para la cuenta que consulta.

**Nota del cuestionario:**
- `mod_quiz_get_user_best_grade` lee con `grade_get_grades`, que puede recalcular notas finales pendientes. Es el mismo efecto que ya cubre la excepción ADR-031.
- Va en `campus_get_quiz_attempts` como `quiz_grade` (nota según el método de calificación y nota para aprobar).

**Calificación avanzada:**
- Con rúbrica o guía, `mod_assign_get_submission_status` incluye en `feedback.gradefordisplay` el HTML que arman los renderers oficiales (`grade/grading/form/rubric|guide/renderer.php`, modos revisión y vista). `campus_get_submission` lo interpreta como `advanced_grading`: criterios, niveles con puntaje, nivel elegido, observaciones y puntaje sobre el máximo en guías.
- Una estructura no reconocida da `recognized=false` con el texto, nunca una rúbrica vacía.
- `grade_display` muestra la nota sin el bloque de la rúbrica.
- La definición de una rúbrica sin calificar no se lee: sólo se ve en páginas de gestión, que son de edición.

**Validación real:**
- La ficha se leyó en cursos reales y en el sandbox.
- Reglas de acceso: un cuestionario con sólo la regla de apertura y cierre no tiene descripción visible.
- Nota del cuestionario: 1 de 5 alumnos de la muestra con nota; ningún cuestionario tiene nota para aprobar.
- Calificación avanzada: **no aplicable con las muestras actuales.** Las devoluciones de las tareas calificadas son notas simples; se puede crear una rúbrica en el sandbox.

## ADR-043 · Curso sandbox como entorno principal de pruebas

**Fecha:** 2026-10-19 · **Estatus:** adoptada; ampliada por ADR-125 (escrituras en todos los cursos con rol de escritura) · **Origen:** el equipo de Campus Virtual de UdeSA creó un curso de pruebas (sandbox). El propietario lo declaró entorno principal de pruebas, con escritura libre.
**Decisión:**
- Toda prueba real que necesite crear o modificar datos (casos que faltan para validar lecturas y escrituras) se hace en el sandbox, nunca en cursos con estudiantes reales.
- Las lecturas se siguen validando también en los cursos reales, con la regla de reportar sólo totales.
- Cada escritura nueva se prueba primero acá. En los demás cursos, las escrituras las habilita ADR-125.

**Estado observado al adoptarlo:**
- La cuenta es `editingteacher` y el curso entra solo en el perfil `udesa-docente`.
- Tiene 17 secciones y sólo el foro de Avisos.
- Las cuentas de prueba de estudiante las agrega el dueño (ADR-049 y ADR-115).

## ADR-044 · Perfil, servidor y transporte de escritura (W0)

**Fecha:** 2026-10-19 · **Estatus:** adoptada; modificada por ADR-061 (`require_out_of_band_from_risk` admite `"nunca"`), ADR-062 (servidor completo), ADR-078 (hasta 2000 acciones por día), ADR-122 (alcance por matrícula), ADR-125 (`all_courses`) y ADR-126 (`enabled_on` informativo) · **Origen:** directiva de escrituras §5.1, §5.2 y §9 (W0), aprobada por el propietario («ejecutá W0»). Lo marcado como ajuste es propuesta técnica de esta implementación, no pedido del dueño.
**Decisión:**
- **Perfil propio con esquema propio.** `profiles/udesa-docente-escritura.json` tiene `profile_kind: "write"`, `read_only: false` literal y `write_policy`. Los perfiles de lectura conservan `read_only: true` literal: ADR-004 sigue vigente para ellos. El cargador de lectura rechaza un perfil de escritura y el de escritura rechaza uno de lectura.
- **Ajuste:** el perfil de escritura no repite sitio, servicio ni alcance: los toma de un perfil de lectura que nombra (`read_profile: "udesa-docente"`). Así usa el mismo token, la misma sesión web, la misma identidad verificada y el mismo alcance de lectura (ADR-016 y ADR-122). El curso de escritura tiene que estar además en ese alcance.
- **`write_policy`:** capacidades por curso (lista vacía = nada), cursos sandbox, límites con tope en el esquema (ítems ≤ 30, mensajes por plan ≤ 1, acciones por día ≤ 200, mensajes por día ≤ 20), `notify_students_default`, `require_out_of_band_from_risk` (sólo R1 o R2: nunca más laxo), `audit_teacher_text` y el diálogo. **Ajuste:** una capacidad puede llevar `enabled_on`, la fecha en que el dueño la habilitó. Es informativa: la escalada de «primeras dos semanas» de §4 la quitó ADR-126.
- **Cursos:** cada fase agrega sus capacidades por curso; `all_courses` (ADR-125) las da a todos los cursos con rol de escritura.
- **Doble llave:** `campus serve-write` sólo arranca con el perfil de escritura **y** `CAMPUS_WRITE_ENABLED=true` literal (`1` o `TRUE` no valen), y con `write_policy.enabled=true`. `campus serve` con un perfil de escritura falla con `CONFIG_INVALID`.
- **Servidor separado:** `udesa-campus-mcp-escritura`, con `campus_execute_plan`, `campus_get_plan`, `campus_list_write_actions`, `campus_undo_action` y `campus_get_write_status`, más una `campus_plan_<intención>` por intención. El servidor de lectura no cambia: 37 herramientas, ninguna de escritura.
- **`WriteTransport`**, separado del de lectura:
  - allowlist `WRITE_FUNCTIONS` con un validador por función, chequeada antes de la red;
  - cero reintentos y una petición por llamada; el token viaja sólo en el cuerpo;
  - una respuesta que no sea JSON interpretable (red caída, timeout, 5xx, HTML o redirección) es «incierta» y se reconcilia por lectura;
  - bloqueadas aunque se agreguen a la tabla: matrícula y roles, `set_user_flags`, `reveal_identities`, `remove_submission`, `tool_mobile_call_external_functions`, `get_autologin_key`, `core_grades_update_grades`/`create_gradecategories`, `coderunner`, IA del sitio y `update_event_start_day`.
- **Sesión web:**
  - `WRITE_AJAX_METHODS`: tuplas método + discriminador. Los despachadores genéricos sin discriminador se rechazan.
  - `WRITE_WEB_FORMS`: ruta, `_qf__` y campos con validador. `sesskey` y `_qf__` los agrega el transporte.
  - **En W0 las dos están vacías.** Los chequeos están implementados y probados con tablas de prueba. El envío web llega con su primera entrada (W4).
- **Intención de prueba:** `campus_plan_marcador_sintetico` y las funciones `local_sintetico_*` no existen en Moodle. Sólo se registran y emiten contra un sitio del dominio reservado `.test` (RFC 6761), y `synthetic_test` es inválida en un perfil de sitio real. Contra el Campus, el servidor de escritura de W0 expone sólo las 5 herramientas comunes.
- **Identidad:** antes de cada ejecución se verifican en vivo el sitio y el usuario (`core_webservice_get_site_info`).

**Alternativas:**
- Duplicar el perfil de lectura dentro del de escritura: habría dos fuentes de verdad para el sitio y el alcance.
- `read_only: boolean` en el mismo esquema: rompe ADR-004.

## ADR-045 · Confirmación humana fuera del modelo

**Fecha:** 2026-10-19 · **Estatus:** adoptada; sin uso con el perfil actual desde ADR-061 (`require_out_of_band_from_risk="nunca"`). La revisión del dueño del gate de W0 quedó sin objeto · **Origen:** directiva §5.4 y §11 (recomendación: diálogo nativo con la terminal de respaldo).
**Decisión:**
- **Por riesgo:** debajo de `require_out_of_band_from_risk` (R2 por defecto) alcanza la aprobación de la herramienta en el cliente (`campus_execute_plan` es `destructiveHint`). Desde ese nivel, la confirmación va fuera del modelo.
- **Diálogo nativo de Windows**, abierto por el servidor al ejecutar:
  - WinForms vía `powershell.exe`, sin dependencias nuevas;
  - muestra el código, el riesgo, el resumen, los valores exactos con los valores por defecto, los ítems, los efectos, el deshacer, las advertencias y los motivos del riesgo;
  - botones «Aprobar» y «Rechazar»; Enter, Escape y cerrar la ventana equivalen a rechazar;
  - vence a los 120 s (configurable entre 15 y 120);
  - el texto del plan no se interpola en el comando: viaja en base64 por una variable de entorno.
- **Terminal:** `campus write approve <plan_id>` exige TTY, muestra el mismo texto y pide tipear el código de 6 caracteres derivado del hash. R4 pide además «CONFIRMO R4», aunque no se usa hasta W6.
- **Ajuste:** aprobar en la terminal **ejecuta** el plan en ese mismo proceso. Así no queda en disco una «aprobación» que otro proceso pueda fabricar. El agente ve el resultado con `campus_get_plan`.
- **Atadura al hash:** el humano aprueba un hash. Después de la aprobación se relee el plan, se verifica la firma y se exige el mismo hash. Una aprobación de otro plan o de una versión anterior no sirve.
- **Ajuste:** los planes se firman con HMAC-SHA256, con una clave local del perfil guardada en el almacén seguro del sistema (`write-signing|<perfil>`). Un plan editado en disco (por ejemplo, por un agente con shell) se rechaza con `POLICY_DENIED`.
- **Desenlaces:**
  - rechazar marca el plan como rechazado y no se vuelve a preguntar;
  - un vencimiento o la falta de canal dejan el plan pendiente;
  - en todos los casos la respuesta es `CONFIRMATION_REQUIRED`, con la instrucción para aprobar desde la terminal.
- **Comandos del humano:** `campus write enable` y `resume` exigen TTY y una palabra tipeada. `disable` no: apagar tiene que ser fácil.

**Límites:**
- Un proceso con permisos del mismo usuario de Windows puede leer el keyring y, con herramientas de control del escritorio, hacer clic en el diálogo. No hay que dar control de escritorio a un agente en sesiones con escritura (§5.4).
- Página de aprobación remota: ADR-060. Elicitación MCP: ADR-118.
- El diálogo real se probó abriéndose y venciendo solo (prueba de humo). Los clics en «Aprobar» y «Rechazar» los tiene que probar el dueño.

## ADR-046 · Planes, ejecución verificada, auditoría, límites y deshacer

**Fecha:** 2026-10-19 · **Estatus:** adoptada; modificada por ADR-061 (confirmación), ADR-067 y ADR-118 (R4) y ADR-126 (sin escalada por curso real) · **Origen:** directiva §5.3, §5.5–§5.9, §6.2–§6.4 y §12.
**Decisión:**
- **Planes locales:** `profiles/<perfil-escritura>/plans/<plan_id>.json` (0600). Guardan el payload exacto, las versiones de las precondiciones, el estado previo para deshacer, el riesgo calculado por el servidor, el hash y la firma. Vencen a los 15 minutos.
- **Uso único:** una marca `.lock` creada con O_EXCL. De dos ejecuciones simultáneas, escribe una sola. La segunda devuelve `PLAN_ALREADY_EXECUTED` con el resultado anterior. Si la marca se tomó y el plan quedó sin resultado (por ejemplo, por un corte), no se reenvía nunca.
- **Riesgo (§4):** parte del riesgo que declara la intención para ese plan. Sube un nivel:
  - con más de 5 ítems en R2;
  - con más de un mensaje;
- **R4:** ver ADR-067 y ADR-118.
- **Orden de la ejecución:**
  1. interruptor y freno;
  2. firma y estado del plan;
  3. capacidad;
  4. límites del día;
  5. confirmación;
  6. identidad en vivo;
  7. marca de uso único;
  8. relectura de precondiciones: si cambiaron, `PLAN_STALE` sin escribir;
  9. una llamada por ítem, en serie, cortando en la primera falla.
- **Error de red:** no se reintenta; se reconcilia por lectura. Si el efecto está, se verifica. Si no está o no se sabe, el resultado es `aplicado_desconocido`. Un token rechazado antes de escribir deja el plan pendiente.
- **Verificación por relectura**, campo por campo. Desenlaces:
  - `aplicado_verificado`;
  - `aplicado_con_diferencias`, con campo, esperado y obtenido;
  - `sin_efecto`;
  - `rechazado_por_moodle`;
  - `aplicado_desconocido`.

  La respuesta cruda sólo sirve para detectar fallas silenciosas (null, `status=false`, -1, avisos). El éxito lo decide la relectura.
- **Ajuste:** lo que §2.5 llama «sin verificar» se informa como `aplicado_desconocido` con `VERIFICATION_FAILED`, porque la lista de §6.3 no tiene otro estado.
- **Ajuste:** todo desenlace que no sea éxito vuelve como error tipado, con el resultado en `details.result`:
  - `MOODLE_REJECTED`;
  - `VERIFICATION_FAILED`, para `sin_efecto` y `aplicado_desconocido`;
  - `PARTIAL_APPLIED`, cuando se aplicó una parte, incluido el caso en que Moodle guarda una parte y después rechaza.

  `aplicado_con_diferencias` sin falla vuelve como resultado, con las diferencias.
- **Errores de §6.4:** `WRITE_DISABLED`, `WRITE_NOT_ALLOWED`, `PLAN_EXPIRED`, `PLAN_STALE`, `PLAN_ALREADY_EXECUTED`, `CONFIRMATION_REQUIRED`, `MOODLE_REJECTED`, `VERIFICATION_FAILED`, `PARTIAL_APPLIED` y `LIMIT_EXCEEDED`. Un plan inexistente da `RESOURCE_OUT_OF_SCOPE`; uno alterado, `POLICY_DENIED`.
- **Auditoría** (`write-audit.jsonl`, 0600, sólo de agregado):
  - eventos `plan_created`, `confirmation`, `plan_stale`, `execution`, `undo_planned`, del interruptor y del freno;
  - por evento: `plan_id`, hash, `action_id`, intención, capacidad, riesgo, curso, IDs de destino, canal y momento de la confirmación, funciones llamadas (sin parámetros), desenlace por ítem, campos con diferencias, IDs de Moodle, deshacer y cliente (`local:<nombre del cliente MCP>`);
  - **sin** contenido del Campus ni de estudiantes;
  - el texto del docente va como hash de 12 caracteres y largo, salvo con `audit_teacher_text: true`;
  - cada línea pasa además por `redact`.
- **Límites:** los por plan se controlan al planificar (`LIMIT_EXCEEDED`). Los por día usan la zona del perfil y cuentan las llamadas emitidas.
- **Freno:** 3 resultados `sin_efecto` o `rechazado_por_moodle` seguidos pausan las escrituras hasta `campus write resume`. Un éxito pone el contador en cero.
- **Interruptor:** `campus write disable|enable`. Deshabilitado, todo devuelve `WRITE_DISABLED`; las lecturas siguen.
- **Deshacer:** `campus_undo_action` arma un plan propio (no escribe) con `undo_of`, que se confirma y ejecuta como cualquier otro, y revierte sólo lo aplicado.
  - Una acción ya deshecha da `PLAN_ALREADY_EXECUTED`.
  - Una acción sin efecto, o con `undo.kind = ninguno`, devuelve `undoable: false`.
  - Si pasó la ventana declarada, el plan lo advierte.
- **Moodle sintético con estado** (`tests/fixtures/fake-write.ts`). Simula las clases de trampas que documenta la investigación:
  - éxito sin efecto (null, `status:true`);
  - avisos, -1, `status:false` y excepción;
  - guardado parcial seguido de excepción;
  - recorte silencioso;
  - corte antes y después de aplicar, 500 y HTML;
  - cambio concurrente y relectura caída.

**Límites:**
- Las trampas concretas de cada función real (§8) se prueban en su fase, con su intención.
- No hay retención automática de planes viejos: los archivos quedan para auditar y deshacer.

## ADR-047 · W1: escrituras en foros (sólo sandbox)

**Fecha:** 2026-10-19 · **Estatus:** adoptada; validada en real en el sandbox con las reglas de ADR-048; ampliada por ADR-125 (todos los cursos con rol de escritura); ventana modificada por ADR-100 · **Origen:** directiva de escrituras §8.1 y §9 (W1). El propietario autorizó ir más allá de W0 y dio «total libertad» en el sandbox. La autorización vale sólo para el sandbox.
**Decisión:**
- **Cuatro intenciones:**
  - `campus_plan_announcement`: aviso nuevo; capacidad `post_announcement`.
  - `campus_plan_forum_reply`: respuesta, pública o privada; capacidad `reply_forum`.
  - `campus_plan_post_edit`: edición de un post propio; capacidad `edit_own_post`.
  - `campus_plan_discussion_state`: fijar o bloquear una discusión; capacidad `pin_lock_discussion`.
- **Borrado:** no es una herramienta propia. Sólo existe como deshacer de un aviso o una respuesta creados por la acción.
- **Habilitadas en el sandbox** (`write_policy.courses`); en los demás cursos con rol de escritura, por `all_courses` (ADR-125).
- **`WRITE_FUNCTIONS` de W1**, con validador cerrado cada una:
  - `mod_forum_add_discussion`, `add_discussion_post`, `update_discussion_post`, `delete_post`, `set_pin_state` y `set_lock_state`;
  - las lecturas de chequeo previo `mod_forum_can_add_discussion` y `mod_forum_get_forum_access_information` (sin efectos; no se agregaron al servidor de lectura);
  - las opciones de `mod_forum` van en una lista cerrada, y las explícitas son obligatorias: `discussionsubscribe` y `discussionpinned` al crear; `discussionsubscribe=1` al editar, porque sin ella Moodle desuscribe a quien edita.
- **Trampas resueltas en el servidor** ([F] §2):
  - `groupid` siempre explícito: -1 o un grupo permitido, nunca 0.
  - El fijado se rechaza en el plan sin `canpindiscussions`.
  - La respuesta privada se rechaza sin `canpostprivatereply`, porque Moodle la publicaría en abierto.
  - No se responde a una respuesta privada ni en una discusión con `canreply=false`.
  - El asunto tiene como máximo 255 caracteres.
  - Al editar, `''` significa «sin cambios»; no se puede vaciar.
  - El bloqueo traduce la semántica invertida: `targetstate=0` bloquea.
  - Sólo se editan posts propios.
- **Formato:** el texto va en Markdown (por defecto), HTML o texto. Se convierte a HTML en el servidor con un conversor cerrado (`src/write/text.ts`), y el plan muestra el HTML final. La comparación de la verificación usa texto normalizado, porque Moodle reformatea el HTML.
- **Plan del aviso:** muestra el foro, el tipo de suscripción, la cantidad de posibles destinatarios, el grupo, el fijado y que no existe «enviar ahora».
- **Riesgos:**
  - aviso: R2; R3 en un curso real con suscripción forzada;
  - respuesta y edición: R2;
  - fijar y bloquear: R1.
- **Verificación:** se relee el listado de discusiones o los posts (leer los posts puede marcarlos como leídos, ADR-039) y se compara asunto, texto, grupo, fijado, padre, privacidad o bloqueo.
  - Ante un error de red, el efecto se busca por autor, asunto o texto y hora: nunca se duplica.
  - La ventana de deshacer «sin correo» es la hora de creación + 5 min (`maxeditingtime` medido en UdeSA, ADR-100).
- **Deshacer:**
  - aviso y respuesta: borrado (exacto dentro de la ventana);
  - edición: reedición con el texto anterior (compensación);
  - fijar y bloquear: la inversa.
- **Motor:** cada ítem de un plan se valida contra la allowlist ya al planificar. `verify` recibe los IDs que devolvió Moodle. El resultado toma `undo.until` de la relectura.

**Límites:**
- Adjuntos: ADR-057 y ADR-069.
- **Prueba real:** el armado del plan se validó contra el sandbox (sólo lectura): foro de Avisos detectado, suscripción forzada, sus posibles destinatarios y `can_add_discussion` disponible. La confirmación: ADR-048 y ADR-061.

## ADR-048 · Sandbox sin confirmación del humano y sin notificar a participantes

**Fecha:** 2026-10-19 · **Estatus:** adoptada; la confirmación en el cliente quedó subsumida por ADR-061 en todos los cursos; la guarda de notificaciones sigue vigente · **Origen:** pedido expreso del propietario en el chat:

> «Quiero que hagamos escrituras reales en este curso (el sandbox). La única restricción es que evitemos notificar personas expresamente.»
>
> «No necesito pases por mí pidiendo hacer escrituras en este curso, quiero que las apliques directamente.»

**Decisión:**
- **`write_policy.sandbox_confirmation`** acepta `fuera_de_banda` (por defecto) o `cliente`. Con `cliente`, en los cursos de `sandbox_course_ids` no se pide confirmación fuera del modelo: el agente ejecuta y alcanza con la aprobación de la herramienta en el cliente.
  - Fuera del sandbox no cambia nada: desde R2 sigue haciendo falta el diálogo o la terminal.
  - El plan lo declara en `risk_reasons`.
  - El perfil `udesa-docente-escritura` lo fija en `cliente`, y el sandbox es un solo curso.
- **`write_policy.allow_participant_notifications`** (por defecto `false`). Mientras sea `false`, las intenciones rechazan en el plan toda escritura que mande correo a participantes (`WRITE_NOT_ALLOWED`, sin escribir).
  - Foros: publicar o responder en foros con suscripción **forzada** o **inicial**, o con suscripción desconocida.
  - Se permite en foros con suscripción opcional o deshabilitada.
  - Fijar, bloquear, editar y borrar no notifican y se permiten.
- **Foro de pruebas:** el dueño creó un foro de prueba con suscripción opcional. El foro de Avisos del sandbox es forzado y queda bloqueado por la guarda.
- Siguen igual el resto del modelo (plan, una llamada, verificación por relectura, auditoría y deshacer), la allowlist y las prohibiciones de §1.2.

**Riesgo aceptado:**
- En un foro con suscripción opcional reciben correo quienes se suscribieron a mano. Es un foro nuevo y se borra todo dentro de la ventana, así que el riesgo es bajo.
- Al publicar, la cuenta del dueño queda suscripta a la discusión; el dueño no es «otra persona».
- El token expuesto (§1.3) es un riesgo aceptado por el dueño: no es condición de ningún gate.

## ADR-049 · W2: calendario, prórrogas, bloqueo y comentarios de entrega (sin mensajes)

**Fecha:** 2026-10-19 · **Estatus:** adoptada; ampliada por ADR-125; mensajes privados a cuentas de prueba: ADR-120 · **Origen:** pedido del propietario de seguir con W2 en el sandbox con las reglas de ADR-048, dejando afuera lo que notifica siempre, como los mensajes privados.
**Decisión:**
- **Cuatro intenciones**, habilitadas en el sandbox y, desde ADR-125, en todos los cursos con rol de escritura:
  - `campus_plan_calendar_event`: evento del curso o de un grupo del curso, con 1 a 20 ocurrencias semanales; capacidad `calendar_event`.
  - `campus_plan_extension`: dar o quitar una prórroga; capacidad `grant_extension`.
  - `campus_plan_submission_lock`: bloquear o desbloquear entregas; capacidad `lock_submissions`.
  - `campus_plan_submission_comment`: comentar una entrega; capacidad `submission_comment`.
- **Mensajes privados (§8.3):** fuera de W2 porque notifican siempre; sólo a las cuentas de prueba, ADR-120.
- **Funciones agregadas a la allowlist:**
  - escrituras: `core_calendar_create_calendar_events`, `core_calendar_delete_calendar_events`, `mod_assign_save_user_extensions`, `mod_assign_lock_submissions`, `mod_assign_unlock_submissions`, `core_comment_add_comments` y `core_comment_delete_comments`;
  - la lectura de chequeo previo `core_calendar_get_allowed_event_types`.
  - Ninguna envía mensajes según el código auditado ([F] §4.0 y §5.1, [T] §10 y §13–§14).
- **Validadores cerrados:**
  - **Calendario:** un evento por llamada, sólo de tipo `course` o `group` con `courseid` y `groupid` coherentes, hasta 20 repeticiones y duración de hasta 7 días. Se borra de a uno y siempre con `repeat=0`, porque el lote es atómico y `repeat=1` borra la serie entera.
  - **Prórroga, bloqueo y desbloqueo:** un participante por llamada.
  - **Comentario:** componente `assignsubmission_comments` y área `submission_comments` fijos. Nunca `submission_comments_upgrade`, que firma el comentario como el estudiante.
- **Validaciones propias**, en el plan y sin escribir:
  - Calendario: el tipo tiene que figurar en `get_allowed_event_types`, el grupo tiene que ser del curso y el inicio no puede ser anterior al del curso.
  - Prórroga: la fecha no puede ser anterior al vencimiento ni a «permitir entregas desde»; si supera la fecha de corte, se advierte.
  - Prórroga y bloqueo: el participante tiene que estar en `mod_assign_list_participants`, que exige poder entregar.
  - Comentario: el participante tiene que tener una entrega.
- **Fallas silenciosas:** el aviso `nopermissions` de calendario sin evento creado, y el aviso `couldnotgrantextensions` sin cambio, se informan como `rechazado_por_moodle`. Un bloqueo «aceptado» que no cambia nada da `sin_efecto`.
- **Verificación:**
  - calendario: la serie se relee con `core_calendar_get_calendar_events` (nombre, inicio, duración, tipo, grupo y cantidad de ocurrencias);
  - prórroga y bloqueo: `mod_assign_get_submission_status` (`extensionduedate` y `locked`);
  - comentario: `core_comment_get_comments` (texto y autor).
- **Deshacer:**
  - calendario: borrar cada ocurrencia, de a una;
  - prórroga: volver a la fecha anterior o a 0;
  - bloqueo: la operación inversa;
  - comentario: borrarlo.
  - En todos los casos es exacto. Riesgo R2; en el sandbox la confirmación va en el cliente (ADR-048).
- **Fecha y hora local:** `AAAA-MM-DDTHH:MM` en la zona del perfil, o ISO 8601 con zona. Un formato ambiguo se rechaza.

**Prueba real (sandbox):**
- Calendario: un evento único y una serie de 3 semanas. Se crearon, se verificaron y se deshicieron (4 borrados verificados).
- Rechazos en el plan, sin escribir: grupo inexistente, tarea inexistente y un curso sin la capacidad.
- Prórroga, bloqueo y comentario: probados en real en ADR-050, sobre tareas ocultas creadas por el MCP.

## ADR-050 · Crear tareas por formulario web (W6 adelantada) y transporte web de escritura

**Fecha:** 2026-10-19 · **Estatus:** adoptada; ampliada por ADR-125 · **Origen:** pedido expreso del propietario: «desarrollá la función de escritura de tareas, así lo vas a poder testear». Hacía falta una tarea en el sandbox para probar prórrogas, bloqueo y comentarios. Directiva §8.9 («Crear recursos y actividades», W6) y §7.5 (formularios).
**Decisión:**
- **Transporte web de escritura** (`src/write/web.ts`), con una petición por escritura y sin seguir redirecciones:
  - Usa la sesión web importada, con identidad verificada.
  - A `WebOperation` se le agregó `writeRequest`: una sola petición, cuyo destino de redirección se valida. Lo llama sólo el transporte de escritura y siempre después de su allowlist.
  - Formularios: el éxito es la redirección; un 200 que devuelve el formulario es `MOODLE_REJECTED`, con los mensajes de `id_error_*`; cualquier otra respuesta es incierta y se reconcilia por lectura.
  - El POST conserva los valores que sirve el formulario y pisa sólo los campos del plan (§7.5).
  - AJAX: una llamada, sin lotes.
- **`WRITE_WEB_FORMS`:** sólo `course_modedit_assign_add`.
  - El GET admite exactamente `add=assign`, `course` y `section`.
  - Campos que el plan puede fijar, cada uno con validador: nombre, consigna, visibilidad, fechas, tipos de entrega y nota en puntos.
  - **Forzados a 0, siempre:** `coursecontentnotification` (aviso de contenido nuevo a participantes), `sendnotifications`, `sendlatenotifications` y `sendstudentnotifications`. En UdeSA, dos de ellos vienen en 1 por defecto.
- **`WRITE_AJAX_METHODS`:** sólo `core_courseformat_update_course` con `action=cm_delete` y un único cmid. Es el deshacer de una actividad creada por la acción. Los demás despachadores y acciones siguen bloqueados.
- **Plan por ítem:** `call.kind` puede ser `rest`, `form` o `ajax`; el motor despacha por esa vía. Cada ítem pasa su allowlist al planificar. La auditoría registra `form:<id>` o `ajax:<método>#<acción>`, sin campos ni sesskey.
- **Intención `campus_plan_create_assignment`** (capacidad `create_assignment`; en el sandbox y, desde ADR-125, en todos los cursos con rol de escritura):
  - Por defecto la tarea se crea **oculta** (R1); visible es R2.
  - La sección tiene que existir: se valida antes, porque un GET con una sección inexistente la crea. Planificar no abre el formulario.
  - Las fechas y opciones que fija el plan van explícitas; el resto queda con los valores por defecto del formulario del sitio.
  - Verificación: `mod_assign_get_assignments` (nombre y fechas) y `core_course_get_contents` (sección y visibilidad).
  - Deshacer por compensación: `cm_delete` (la tarea va a la papelera).

**Prueba real (sandbox):**
- Dos tareas ocultas creadas y verificadas. El parser leyó los 121 campos del formulario real.
- Sobre ellas:
  - prórroga y bloqueo del estudiante de prueba, con su deshacer;
  - comentario de entrega con su deshacer;
  - borrado de las dos tareas.
- 17 escrituras, todas `aplicado_verificado`. Nada quedó en el curso, salvo las tareas en la papelera, que vence a los 7 días.

**Hallazgo (lectura con efecto):** la primera llamada a `mod_assign_get_submission_status` para un estudiante sin entrega **crea un registro de entrega vacío** (estado `new`). La primera lectura devolvió `null` y la segunda, el registro, sin escrituras en el medio.
- La usan el servidor de lectura (`campus_get_submission`) y las intenciones de W2.
- Es el mismo efecto que abrir la vista de calificación en la web: no notifica ni cambia lo que ve el estudiante.
- Queda registrado en HERRAMIENTAS; la guarda es ADR-052.

**Límites:**
- Otros tipos de actividad y la edición de una existente: ADR-055, 056, 064, 065, 070, 075 y 077.
- Adjuntos en la consigna: no.
- Si la papelera guarda o no las entregas depende de la configuración de backup del sitio, y no se puede determinar.

## ADR-051 · W4: estructura del curso (mostrar, ocultar, mover y renombrar)

**Fecha:** 2026-10-19 · **Estatus:** adoptada; ampliada por ADR-125 · **Origen:** el propietario pidió seguir con el desarrollo en el sandbox, con las reglas de ADR-048. Directiva §8.9 y §3.2; investigación [C] §1 y §9.1.
**Decisión:**
- **Tres intenciones**, habilitadas en el sandbox y, desde ADR-125, en todos los cursos con rol de escritura:
  - `campus_plan_visibility`: actividades y secciones; capacidad `course_visibility`. La sección 0 y las subsecciones se rechazan.
  - `campus_plan_move_activity`: capacidad nueva `move_content`. El destino es una sección existente, al final o antes de otra actividad; el deshacer vuelve al lugar exacto.
  - `campus_plan_rename`: actividad o sección; capacidad `rename_content`.
- **Tuplas AJAX**, con un único id y argumentos cerrados:
  - `core_courseformat_update_course` con `cm_show`, `cm_hide`, `section_show`, `section_hide` o `cm_move` (con `targetsectionid` o `targetcmid`, nunca los dos).
  - `core_update_inplace_editable` sólo con `core_course/activityname` (hasta 1333 caracteres) y `format_<formato>/sectionname` (hasta 255). El componente es el **del formato**: se lee con `core_course_get_courses_by_field`.
  - Siguen bloqueados `cm_stealth`, `cm_duplicate`, `section_delete`, `section_add`, los roles y grupos por `inplace_editable`, y cualquier otra acción.
- **Trampas resueltas en el plan:**
  - nombre vacío o igual al actual (Moodle lo ignora sin error);
  - mover a una sección oculta oculta la actividad (se advierte);
  - ocultar una sección oculta sus actividades (se advierte la cantidad);
  - las secciones inexistentes se rechazan, porque no se crean.
- **Verificación:** `core_course_get_contents` (sección, posición, visibilidad y nombre). No se usa el código de retorno, porque `update_course` puede fallar con el cambio ya aplicado ([C] §1.4).
- **Concurrencia:** las versiones son «sección:posición:visible:nombre» de la actividad, o «visible:nombre» de la sección.
- **Riesgos:** mostrar u ocultar, R2; mover y renombrar, R1. Ninguna de estas operaciones notifica.

**Prueba real (sandbox):**
- Sobre una tarea oculta creada para la prueba: renombrar, mover a la sección 2, mostrar y, después, borrarla.
- Sobre las secciones: renombrar la sección 1 y ocultar la 16 (vacía).
- Todo con su deshacer: 12 escrituras, todas `aplicado_verificado`.
- Una comparación independiente de `core_course_get_contents` antes y después dio el curso **idéntico**.

**Límite:** para un nombre de sección por defecto (vacío) no hay deshacer por esta vía; el plan lo informa.

**Secciones:** `section_add` y `section_delete` los habilita ADR-067, sólo para `campus_plan_create_section` y `campus_plan_delete_content`.

## ADR-052 · Guarda de `mod_assign_get_submission_status`: ninguna lectura crea entregas

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** hallazgo de ADR-050 (en real, la primera lectura de la entrega de un estudiante sin entrega creó un registro `new`). Reglas del proyecto: toda lectura con efectos se audita, se guarda o la aprueba el dueño (ADR-031, ADR-039). Esta no la aprobó: se guarda.
**Causa, en el código oficial** (Moodle 5.1, commit `7637a7b6`, `public/mod/assign/`):
- `externallib.php::get_submission_status` arma primero `get_assign_submission_status_renderable` (lee la entrega con `create=false`: por eso la primera respuesta trae `submission = null`). Después llama a `get_assign_feedback_status_renderable`.
- Ese renderable, y también `is_graded` y `get_grading_status` (sin flujo de calificación), llaman a `get_user_grade($userid, false)`.
- `locallib.php::get_user_grade` hace `if ($attemptnumber < 0 || $create)` → `get_user_submission($userid, true, $attemptnumber)`, o `get_group_submission($userid, 0, true, …)` en entregas grupales. Con `attemptnumber = -1` (el valor por defecto) **crea** el registro aunque `$create` sea `false`.
- Condición: el participante no tiene fila en `assign_submission` (individual) o su grupo no tiene entrega (grupal). Con registro existente, la lectura no crea nada.

**Decisión:**
- **Consulta previa sin efectos:** `mod_assign_list_participants`. Su SQL hace LEFT JOIN a `assign_submission` (`latest = 1`) y devuelve `submissionstatus = ''` cuando no hay registro. Se lee en el momento, no del registro en memoria, porque el estado cambia.
- **Regla** (`src/domain/submission-guard.ts`, `hasSubmissionRecord`):
  - individual: hay registro si `submissionstatus` no está vacío;
  - grupal: también si algún compañero de un grupo en común tiene registro (sin grupo, los demás sin grupo). Al editar la entrega grupal, Moodle crea el registro propio de quien la edita (`update_team_submission`), así que un grupo con actividad deja rastro en algún integrante. Un grupo sin rastro sólo puede tener una entrega `new` vacía, creada por una vista: equivale a «sin entrega».
- **Sin registro, no se llama a `get_submission_status`:**
  - `campus_get_submission` responde `status: null`, `submission_record: false` y un aviso. Prórroga y bloqueo salen de `mod_assign_get_user_flags`; nota y devolución quedan en `null`, porque calificar crea la entrega y sin entrega no puede haber nota.
  - `campus_read_file` de una entrega o devolución sin registro: «no encontrado», sin crear nada.
  - `campus_get_activity_settings` con `participant_id` sólo verifica al participante, sin pedir su entrega.
- **W2:** prórroga y bloqueo leen, verifican y deshacen con `mod_assign_get_user_flags`, nunca con `get_submission_status`. El comentario de entrega aplica la guarda: sin registro, el plan se rechaza («no hay dónde comentar») sin crearlo. Antes, la lectura del plan creaba la entrega vacía y el comentario quedaba colgado de ella.
- **`mod_assign_get_user_flags`** entra en la allowlist de lectura. Es un SELECT sobre `assign_user_flags` y exige `mod/assign:grade`. Sin permiso, Moodle no lanza excepción: devuelve el aviso 1 sin datos. Eso se trata como `MOODLE_PERMISSION_DENIED`, no como «sin prórroga». Figura en el servicio de UdeSA.

**Tests:** el Moodle falso reproduce el efecto (primera llamada `null`, segunda con el registro) y registra cada creación. Los tests nuevos exigen cero llamadas a `get_submission_status` y cero creaciones en las lecturas y en W2 sobre un participante sin entrega (`tests/integration/submission-guard.test.ts`). Si se anula la guarda, fallan 5.

**Límites:**
- Carrera benigna: si el estudiante entrega entre las dos lecturas, el registro ya existe y la lectura no crea nada.
- La regla grupal usa los grupos que informa `list_participants` (todos los del curso, no sólo los de la agrupación de la tarea). Si compartir un grupo ajeno a la agrupación da un falso «hay registro», la lectura puede crear la entrega vacía del grupo, como antes de esta guarda.
- **Hallazgo de código (no observado en real), sin guardar:** `mod_assign_get_submissions` llama a `get_grading_status($submissionrecord->userid)` por cada fila. En entregas grupales la fila del grupo tiene `userid = 0`. Entonces `get_user_grade` usa el docente (`$USER->id`) y, sin flujo de calificación, puede crear la entrega vacía del grupo del docente (o del grupo por defecto). Afecta a `campus_get_submission_status` y `campus_list_pending` en tareas grupales con al menos una entrega. Probado en real en ADR-105: no se reprodujo y se acepta sin guarda.

## ADR-053 · W3: calificar y devolver entregas

**Fecha:** 2026-10-19 · **Estatus:** adoptada; ampliada por ADR-125 · **Origen:** directiva §8.6; investigación [T] §2, §3, §7 y §10. Pedido del propietario de seguir con las fases en el sandbox (ADR-048).
**Decisión:**
- **`campus_plan_grade`** (capacidad `grade_submission`; en el sandbox y, desde ADR-125, en todos los cursos con rol de escritura): nota en puntos y comentario de devolución para UN participante. Riesgo R3.
- **Superficie:** `mod_assign_submit_grading_form`, porque valida rango y escala y permite fijar la notificación. Su `jsonformdata` es un string JSON con un querystring cerrado.
- **Campos que el servidor fija siempre explícitos**, porque sus valores por defecto son peligrosos:
  - `attemptnumber`: el del último intento leído (omitido, Moodle usa el primero);
  - `applytoall=0` (omitido, vale 1);
  - `addattempt=0`;
  - `sendstudentnotifications`: por defecto, el del perfil (0). En 1 exige `allow_participant_notifications`.
  - El comentario vigente se reenvía siempre: omitirlo puede anularlo.
- **Rechazos en el plan:**
  - nota fuera de rango o no numérica (acepta coma decimal);
  - no participante;
  - nota bloqueada o sobrescrita en el libro de calificaciones (`gradereport_user_get_grade_items`, excepción ADR-031);
  - escala, marking workflow, corrección anónima y entrega grupal: quedan para W6.
- **Verificación:**
  - `mod_assign_get_grades`: lectura nueva de verificación, sólo SELECT, no está en el servidor de lectura;
  - comentario: `mod_assign_get_submission_status`, que después de calificar ya no crea nada (ADR-052).
- **Deshacer por compensación:** nota y comentario anteriores. Si no había nota, el deshacer es **«ninguno»**: ver el hallazgo.

**Hallazgo (real):** «sin nota» (`grade` vacío) por el formulario **queda guardado como 0**. Volver a «sin nota» sólo sería posible con `mod_assign_save_grade(-1)`, que notifica siempre al estudiante, así que no se ofrece. La verificación lo detectó como `aplicado_con_diferencias`, no como éxito.

**Prueba real (sandbox):**
- Sobre una tarea oculta creada para la prueba (nota máxima 10), con el estudiante de prueba:
  - nota 7,5 con devolución;
  - cambio a 9 conservando la devolución, y su deshacer;
  - deshacer de la primera nota: dio 0 en vez de «sin nota», lo que originó el hallazgo.
- Rechazos en el plan: nota 11 (fuera de rango) y pedido de notificar.
- Al final se borró la tarea, y con ella sus notas. Ninguna notificación.

**Límite:** el deshacer no alcanza a la notificación ni a la penalización por entrega tardía ya aplicada.

## ADR-054 · Deploy del remoto con lecturas al día

**Fecha:** 2026-10-19 · **Estatus:** adoptada; la exclusión de escrituras del remoto fue reemplazada por ADR-060 (W5) · **Origen:** pedido del propietario («deployeá lo que tenemos actualmente a Vercel»).
**Decisión:**
- Se desplegó con `vercel deploy --prod`. El remoto sirve sólo el **servidor de lectura**, ahora con la guarda de ADR-052.
- El servidor de escritura no se expone en el remoto: eso es W5 (KV de Upstash por el Marketplace de Vercel y página de aprobación propia con el login de GitHub).
- **Validación:**
  - `/health` → `ok:true`;
  - `/mcp` sin token → 401;
  - `campus_get_status(verify)` por el conector de Claude Code → identidad verificada en vivo.

## ADR-055 · W4: tomar asistencia; crear actividades y sesiones de asistencia

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva §8.7 (W4) y pedido del propietario: «quiero que vos tengas la capacidad de crear módulos de asistencia». El dueño creó una actividad de asistencia en el sandbox.
**Decisión:**
- **`campus_plan_attendance`** (capacidad `take_attendance`, R3). Usa `tool_mobile_get_content` / `mobile_view_activity` con `status<userid>`.
  - El transporte de ESCRITURA tiene su propia política para esa función: sólo `mod_attendance`, sólo ese método, sólo `cmid`, `courseid`, `sessid`, `appversioncode` y `status<id>`, y al menos un estado. El servidor de lectura sigue prohibiendo `status*` (ADR-028).
  - **Validaciones propias**, porque el plugin no valida nada de esto ([T] §21.2):
    - la sesión es de la actividad (`manage.php`);
    - el alumno está en el padrón de la sesión;
    - el estado es de la sesión (`mobile_teacher_form`): por acrónimo, nombre o id;
    - si no hay ningún cambio, el plan se rechaza.
  - **Notificaciones:** si la actividad tiene **umbrales de aviso** (`warnings.php`, lectura nueva de chequeo previo) o la página no se reconoce, y el perfil no permite notificar, se rechaza.
  - **Advertencias:** retomar BORRA las observaciones de los alumnos reenviados.
  - **Verificación:** se relee `mobile_teacher_form` (`otherdata.status<id>`). El «éxito» que muestra el plugin no cuenta.
  - **Deshacer por compensación:** se reenvían los estados anteriores. Si el alumno no tenía estado, «ninguno», porque un registro no se borra por esta vía.
- **`campus_plan_attendance_session`** (`take_attendance`, R1): agrega UNA sesión para todos con el formulario `sessions.php?action=1`. Fuerza `sessiontype=0` y deja sin marcar `addmultiply`, `studentscanmark` y `autoassignstatus`, para que los alumnos no se marquen solos. Deshacer: `sessions.php` con `action=3` y `confirm=1` (un POST con sesskey, sin formulario).
- **`campus_plan_create_attendance`** (capacidad nueva `create_attendance`): `modedit.php?add=attendance`. Por defecto oculta, sin nota y con `coursecontentnotification=0`. Deshacer: `cm_delete`.
- **Transporte web:**
  - acciones confirmadas sin formulario (`no_get`);
  - `WRITE_WEB_READS` para lecturas de chequeo previo;
  - `omit_when_zero`: una casilla en 0 se OMITE del envío.

**Hallazgo (real):** el formulario de sesiones de `mod_attendance` evalúa las casillas con `isset()`. Mandar `addmultiply=0` la da por marcada y responde HTTP 404 sin crear nada.
- El motor lo informó como `aplicado_desconocido`, no reintentó y la reconciliación confirmó «ausente».
- Corrección: las casillas en 0 se omiten, como hace el navegador.
- Durante la depuración se creó una sesión suelta (21/10, 10:00 a 11:00), que se borró enseguida con la misma acción allowlisteada.

**Prueba real (sandbox):**
- En una sesión nueva: asistencia tomada al estudiante de prueba (P) y retomada (FI), con su deshacer (vuelve a P). Después se borró la sesión.
- Dos actividades de asistencia ocultas creadas y borradas.
- Rechazos en el plan: sesión ajena y estado inexistente.
- Los estados de UdeSA son P, R, FJ y FI. La actividad no tiene umbrales de aviso. La sesión que creó el dueño no se tocó.
- Sin notificaciones.

**Otro:** `vitest.config.ts` sube el límite por test a 30 s, porque los tests de PDF superaban los 5 s con la suite completa en paralelo.

## ADR-056 · W6 parcial: crear cuestionarios y overrides por alumno

**Fecha:** 2026-10-19 · **Estatus:** adoptada; ampliada por ADR-073 · **Origen:** directiva §8.8 y pedido del propietario de avanzar con el resto de W6 en el sandbox.
**Decisión:**
- **`campus_plan_quiz_override`** (capacidad `quiz_override`, R3). Usa AJAX `mod_quiz_save_overrides` con UN override por llamada y sólo `userid`, `timeopen`, `timeclose`, `timelimit` y `attempts`. Nunca `id`, `groupid` ni `password`.
  - **Sólo alta.** Moodle reemplaza el override completo al actualizarlo, y eso borraría una contraseña que el plan no ve. Si el alumno ya tiene un override, el plan se rechaza.
  - Validaciones: el alumno está matriculado; hay al menos un cambio; el cierre es posterior a la apertura.
  - **Verificación:** se relee `mod_quiz_get_overrides` por AJAX de lectura. Si Moodle devuelve `ids` vacío (descarta el override sin avisar), el resultado es `rechazado_por_moodle`. La contraseña del override nunca se copia al plan ni a la auditoría.
  - **Deshacer:** `mod_quiz_delete_overrides` con un único id.
- **`campus_plan_create_quiz`** (capacidad nueva `create_quiz`; R1 oculto, R2 visible): `modedit.php?add=quiz`. Crea un cuestionario VACÍO, oculto por defecto, con `coursecontentnotification=0`. Admite fechas, límite de tiempo e intentos. Deshacer: `cm_delete`.

**Hallazgo (real):** el límite de tiempo sólo se guarda si se envía la casilla `timelimit[enabled]=1`. Sin ella, Moodle deja 0. El primer intento quedó `aplicado_con_diferencias` y se corrigió; la casilla se omite cuando el límite es 0.

**Prueba real (sandbox):**
- Override creado y verificado para el estudiante de prueba; duplicado y alumno no matriculado rechazados en el plan; deshacer verificado.
- Cuestionario creado oculto, con fechas, límite e intentos, verificado (`aplicado_verificado`) y borrado.
- Sin notificaciones y sin objetos residuales.

**Relacionadas:** `groupid` como alternativa a `userid`: ADR-073. Importar y agregar preguntas: ADR-059 y ADR-063.

## ADR-057 · W1: adjuntos en avisos y respuestas

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva §8.1 y §8.12 (W1, adjuntos de los planes).
**Decisión:**
- `campus_plan_announcement` y `campus_plan_forum_reply` aceptan `attachments`: rutas **absolutas** de archivos locales que indicó el humano (como máximo 10). Nunca archivos «encontrados».
- **Plan (no sube nada):**
  - guarda ruta, nombre, tamaño y SHA-256 de cada archivo;
  - exige `cancreateattachment`, porque sin él Moodle descarta los adjuntos en silencio;
  - respeta `maxattachments` y `maxbytes` del foro, acotados por `max_file_bytes` del perfil;
  - rechaza archivos vacíos, carpetas y nombres repetidos (Moodle no sobrescribe).
- **Ejecución:**
  1. Antes de escribir, relee cada archivo y compara el hash. Si cambió, el plan queda obsoleto (`PLAN_STALE`) y no se sube nada.
  2. UNA petición a `webservice/upload.php` (borrador privado del usuario, `itemid=0`). Sus errores por archivo llegan con HTTP 200: si alguno falla, se borra lo subido y el ítem queda rechazado.
  3. El `itemid` entra como la opción `attachmentsid`. La allowlist la admite sólo como entero y sólo en `mod_forum_add_discussion` y `mod_forum_add_discussion_post`; `inlineattachmentsid` sigue prohibida.
  4. Si Moodle rechaza la publicación sin duda, el borrador se limpia con `core_files_delete_draft_files` (nuevo en la allowlist: sólo `filepath=/` y nombres de archivo simples). Ante un resultado incierto no se toca: se reconcilia por lectura y el cron de Moodle purga el borrador a los 4 días.
- Un fallo de la subida nunca es «incierto» para la publicación, porque esta no se envió.
- **Verificación:** se comparan nombre y tamaño de los adjuntos del post. Un descarte silencioso de Moodle (por ejemplo, `maxbytes` del sitio) da `aplicado_con_diferencias`.
- **Deshacer:** sin cambios. Borrar el post borra sus adjuntos.

**Prueba real (sandbox, foro de prueba):**
- Aviso con 2 adjuntos y respuesta con 1. Los dos dieron `aplicado_verificado`, con los adjuntos comprobados.
- Los dos se deshicieron a los ~7 s, dentro de la ventana sin correo.
- El servicio móvil de UdeSA acepta `upload.php` con el token de la app.

**Relacionadas:** editar los adjuntos de un post existente: ADR-069. **Pendiente:** imágenes en línea.

## ADR-058 · W6 parcial: grupos

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva §8.11 y pedido del propietario de avanzar con el resto de W6 en el sandbox.
**Decisión:** capacidad nueva `manage_groups`. Ningún `core_group_*` de escritura está en el servicio móvil, así que se usan la sesión web y su AJAX.
- **`campus_plan_create_group`** (R1): formulario `/group/group.php`.
  - Fuerza `enablemessaging=0` (sin conversación de grupo) y `enrolmentkey` vacía; el resto toma los valores del formulario.
  - Rechaza en el plan nombres repetidos (sin distinguir mayúsculas) e ID repetidos.
  - El id sale de la redirección; se verifican nombre, ID y descripción.
  - **Deshacer:** `/group/delete.php` (POST confirmado, sin formulario), sólo si el grupo sigue **sin miembros**, como precondición. Con miembros, borrarlo cambia el acceso y es R4: el deshacer se niega y lo explica.
- **`campus_plan_group_members`** (R2): `core_update_inplace_editable` con `core_group/user_groups`.
  - Allowlist: `itemid` = `<curso>:<usuario>` y `value` = arreglo JSON de ids.
  - La operación REEMPLAZA el conjunto: el plan pide el conjunto completo y muestra antes, después, altas y bajas.
  - Precondición: los grupos del participante no cambiaron.
  - **Verificación:** se relee `core_enrol_get_enrolled_users`. Una membresía protegida que Moodle no quita da `aplicado_con_diferencias`.
  - **Deshacer:** volver al conjunto anterior.
- **Relacionadas:** agrupamientos: ADR-074. Borrar grupos: ADR-108.

**Prueba real (sandbox):**
- Grupo creado y verificado.
- El estudiante de prueba se agregó conservando su grupo anterior, y el deshacer lo dejó como estaba.
- El grupo se borró.
- Sin correos.

## ADR-059 · W6 parcial: importar preguntas a un banco

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** directiva §8.10 y pedido del propietario de avanzar con el resto de W6 en el sandbox.
**Decisión:** capacidad nueva `import_questions`, con la herramienta `campus_plan_question_import` (R1).
- **Destino:** el banco propio de un cuestionario (Moodle 5) o un módulo «Banco de preguntas» del curso.
- **Categoría:**
  - el plan lee el formulario de importación (lectura nueva `question_import_form`, que puede crear la categoría por defecto del banco);
  - usa la categoría por defecto o una de las que ofrece; nunca una ajena.
- **Archivo:**
  - GIFT (.txt/.gift) o Moodle XML (.xml), en UTF-8, con hasta 200 preguntas y 2 MB;
  - viene de una ruta local que indicó el humano, con hash en el plan, como los adjuntos (ADR-057);
  - al ejecutar se sube al borrador y su itemid entra en el campo filepicker `newfile`. `upload_fields` de la spec lo admite, y sólo el motor lo completa.
- **Duplicados:** Moodle NO deduplica. El plan exige nombre en cada pregunta (`::nombre::` en GIFT) y rechaza:
  - nombres repetidos dentro del archivo;
  - nombres ya presentes en la categoría (inventario por `core_question_get_random_question_summaries`).
- **Opciones forzadas:** `catfromfile=0` y `contextfromfile=0` (omitidas, como las casillas sin marcar), `matchgrades=error` y `stoponerror=1`. No crea categorías y no agrega las preguntas a ningún cuestionario.
- **Éxito sin redirección:** la importación responde HTTP 200 con un botón «Continuar» a `/question/edit.php`. La spec lo declara con `success_200`; cualquier otro 200 es rechazo (formulario o página de error) o resultado incierto.
- **Verificación:** inventario antes y después. Tienen que aparecer exactamente las preguntas nuevas con los nombres del archivo.
- **Deshacer:** `delete.php`, en un POST confirmado con `deleteselected`, `confirm=md5(lista)`, `deleteall=1` y `returnurl` fijo. Borra sólo las preguntas nuevas, que se recalculan al armar el deshacer. Si una ya se usó en intentos, Moodle la oculta en lugar de borrarla.
- **Limitación:** el inventario son los candidatos de selección aleatoria. Las preguntas de tipo «descripción» no figuran ahí, y la verificación lo marcaría como diferencia.

**Prueba real (sandbox):**
- Se creó un cuestionario oculto y se importaron 2 preguntas GIFT a su banco. El resultado fue `aplicado_verificado`.
- El deshacer borró las 2 preguntas (`aplicado_verificado`) y después se borró el cuestionario.

**Relacionadas:** agregar preguntas a un cuestionario (slots, §8.10) y cambiar el estado de una pregunta: ADR-063 y ADR-068.

## ADR-060 · W5: escrituras remotas en Vercel

**Fecha:** 2026-10-19 · **Estatus:** adoptada; implementada, desplegada y validada en real con Claude Code (gate W5.5); modificada por ADR-061 (sin aprobación en la página con `"nunca"`) y ADR-118 (sin techo de riesgo) · **Origen:** pregunta del propietario: «¿no alcanza con Vercel?». Alcanza.
- Upstash Redis del Marketplace de Vercel como almacén: planes, uso único con `SET NX`, aprobaciones, interruptor, límites y auditoría.
- Endpoint aparte, `/mcp-escritura`, con alcance OAuth `campus.write`.
- Página `/aprobar/<plan_id>` con la sesión GitHub del dueño como confirmación fuera de banda. En remoto, todo plan se aprueba ahí.
- Sin archivos locales en la primera versión.
- Al principio, sólo R1 y R2.

**Implementación:**
- **Almacén:**
  - `WriteStore` es una interfaz asíncrona con dos backends: `FileWriteStore` (local) y `KvWriteStore`;
  - `KvWriteStore` habla con Upstash por REST, sin dependencias: `SET NX EX` para planes, uso único y aprobaciones; `ZADD` para el índice; `RPUSH`/`LTRIM` para la auditoría;
  - los tests usan `MemoryKv`.
- **Endpoint y alcance:**
  - `/mcp-escritura` con alcance `campus.write`, resource propio y metadata RFC 9728 propia;
  - los tokens de escritura llevan `wv` = `CAMPUS_WRITE_TOKEN_VERSION`, así que cambiarla revoca sólo la escritura;
  - un token de lectura no abre la escritura, ni al revés.
- **Página `/aprobar/<plan_id>`:**
  - exige login de GitHub del dueño, en un flujo propio que reusa el callback registrado; deja una cookie `__Host-` de 8 h, SameSite=Lax;
  - el formulario va firmado y atado al plan, al hash y al aprobador;
  - la decisión se guarda en el KV y no se puede cambiar.
- **Motor en modo remoto:**
  - todo plan va fuera de banda, por el canal `web`;
  - techo de riesgo R2;
  - sin archivos locales: `question_import` no se registra y los adjuntos se rechazan;
  - la clave de firma de planes se deriva de `OAUTH_SIGNING_SECRET`.
- **Despliegue:** segunda llave `CAMPUS_WRITE_ENABLED=true` en producción. Se desplegó y quedaron verificados `/health`, la metadata de `/mcp-escritura`, el 401 con su `WWW-Authenticate` y los dos scopes anunciados.
- **Limitación:** las variables de Upstash son sensibles y `vercel env pull` las baja vacías. El KV real sólo se prueba en producción, en el gate W5.5.

**Vigente:** con `require_out_of_band_from_risk: "nunca"` (ADR-061) la página sólo se usa si el perfil fija un umbral. No hay techo de riesgo, tampoco en el remoto (ADR-118).

## ADR-061 · Escrituras sin aprobación humana (decisión del dueño)

**Fecha:** 2026-10-19 · **Estatus:** adoptada; techo remoto quitado por ADR-118; capacidades ampliadas por ADR-125 · **Origen:** el dueño, en el chat: «I'd remove the need of approvals for basically everything», y después «Autorizo explícitamente quitar las aprobaciones (require_out_of_band_from_risk=nunca, local y remoto, techo remoto R3)».
**Decisión:**
- `require_out_of_band_from_risk` admite `"nunca"`: ningún plan pide aprobación fuera del chat, ni en local (diálogo o terminal) ni en remoto (página `/aprobar`). El plan lo declara en `risk_reasons`, y la auditoría registra el canal `cliente`.
- El perfil `udesa-docente-escritura` pasa a `"nunca"`.
- El techo de riesgo remoto sube de R2 a R3, igual que en local. R4 sigue sin habilitarse.
- La página de aprobación sigue existiendo: vuelve a usarse si el perfil fija un umbral (`R1` o `R2`).

**Qué sigue protegiendo sin intervención humana:**
- capacidades por curso en el perfil (sólo las edita el dueño);
- allowlists por función;
- límites por plan y por día;
- freno ante fallos;
- interruptor general;
- auditoría y deshacer.

Además:
- `allow_participant_notifications=false`;
- capacidades por curso: el sandbox y, desde ADR-125, todos los cursos con rol de escritura.
**Riesgo aceptado por el dueño:** sin aprobación, un agente que malinterpreta un pedido, o al que lo desvía texto leído del Campus, puede escribir dentro de esos límites.

## ADR-062 · Perfiles docente-lectura y docente-completo

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** el dueño: «differentiate the docente profile in two: docente_read and docente_full», y después «docente-lectura (lo actual de lectura) y docente-completo (un solo conector con lecturas + escrituras, local y remoto). Mantené los nombres actuales como alias».
**Decisión:**
- **Dos nombres de perfil para el usuario:**
  - `docente-lectura` → `udesa-docente`;
  - `docente-completo` → `udesa-docente-escritura`.
  - Están en `PROFILE_ALIASES`, que resuelven `loadProfile` y `loadWriteProfile`.
  - Los ids internos no cambian porque el keyring, el estado local y los conectores ya configurados dependen de ellos; siguen valiendo como alias.
- **Servidor completo:**
  - un solo servidor MCP registra las tools de lectura (`registerReadTools`) y las de escritura (`registerWriteTools`), las mismas implementaciones de los dos servidores separados, con instrucciones combinadas;
  - local: `campus serve-full --profile docente-completo`, con la doble llave (`CAMPUS_WRITE_ENABLED=true`);
  - remoto: `/mcp-completo`, con alcance `campus.write` y resource propio.
- **Revisión de ADR-044:** la separación de servidores queda como opción. `/mcp` y `serve` siguen siendo sólo lectura, y `/mcp-escritura` y `serve-write` siguen existiendo. Lo que reduce el riesgo es elegir el perfil: un cliente que sólo lee no tiene ninguna tool de escritura.

## ADR-063 · W6: agregar preguntas del banco a un cuestionario

**Fecha:** 2026-10-19 · **Estatus:** adoptada · **Origen:** pedido del dueño de seguir con W6, empezando por completar el flujo de cuestionarios.
**Decisión:** capacidad nueva `edit_quiz` y herramienta `campus_plan_quiz_add_questions` (R2).
- **Superficie:**
  - una llamada por pregunta a `/mod/quiz/edit.php` con `addquestion=<id>` y `addonpage=0` (al final), en un POST con sesskey; el éxito es la redirección;
  - la nota por slot es 1 y la versión, «siempre la última»;
  - Moodle la rechaza si el cuestionario tiene intentos (`check_can_be_edited`), y eso vuelve como `rechazado_por_moodle`.
- **Plan:**
  - el cuestionario es del curso;
  - el banco es el del propio cuestionario o un «Banco de preguntas» del curso;
  - cada pregunta está **lista** en alguna categoría de ese banco (inventario por categoría; hasta 30 categorías);
  - ninguna pregunta ya está en el cuestionario, y no hay repetidas.
- **Por nombre (`question_names`):** el agente no ve los ids de preguntas recién importadas, porque la lectura del banco está acotada por política. El nombre se resuelve por inventario; uno ausente o ambiguo se rechaza con los ids candidatos.
- **Precondición:** la lista de slots no cambió desde el plan (si cambió, `PLAN_STALE`).
- **Verificación:** se relee la estructura (`mod_quiz_get_edit_grading_page_data`): tiene que aparecer un slot nuevo con esa pregunta. Otra pregunta da `aplicado_con_diferencias`.
- **Deshacer:** `/mod/quiz/edit_rest.php` con `class=resource` y `action=DELETE`, por slot. Responde 200 con `{"deleted":true}`, declarado con `success_200` (ahora también en acciones sin formulario).

**Prueba real (sandbox):** cuestionario oculto, 2 preguntas GIFT importadas, agregadas por nombre, slots quitados, preguntas borradas y cuestionario borrado. Todo dio `aplicado_verificado`.

**Relacionadas:** preguntas aleatorias y nota máxima por slot: ADR-072. Páginas y secciones: ADR-091.

## ADR-064 · W6: crear páginas, enlaces, etiquetas y archivos

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño de seguir con W6: «otros tipos de actividad (páginas, enlaces, etiquetas y archivos como recurso)».
**Decisión:** capacidad nueva `create_content` y una sola herramienta, `campus_plan_create_content`, con `type` = `page` | `url` | `label` | `resource`. Cada tipo exige su dato (`content`, `external_url`, `text` o `file_path`) y rechaza los de otro tipo.
- **Superficie:**
  - `/course/modedit.php?add=<tipo>`, con una spec por tipo (`course_modedit_<tipo>_add`);
  - oculto por defecto, `coursecontentnotification` en 0 (omitida) y la sección tiene que existir;
  - el resto queda con los valores por defecto del formulario.
- **Por tipo:**
  - **Página:** Markdown → HTML en `page[text]`.
  - **Enlace:** sólo http(s), sin credenciales. El parámetro se llama `external_url`, porque `url` está prohibido como clave de entrada (§12: ninguna herramienta acepta URLs genéricas). La URL se guarda como contenido; el servidor nunca la llama.
  - **Etiqueta:** el formulario no tiene «guardar y mostrar», así que se envía `submitbutton2` y la redirección vuelve al curso sin cmid; se identifica por nombre en la sección. Sin `name`, se usa el comienzo del texto en texto plano.
  - **Archivo:** un único archivo local indicado por el humano, con hash en el plan. Se sube al borrador al ejecutar y entra en el filepicker `files` (`upload_fields`, como la importación de preguntas). En el remoto no hay archivos: se rechaza.
- **Verificación:**
  - nombre, sección y visibilidad, por la estructura del curso;
  - página: contenido, por `mod_page_get_pages_by_courses`;
  - enlace: URL, por `mod_url_get_urls_by_courses`;
  - etiqueta: texto, por la descripción del módulo;
  - archivo: nombre y tamaño, por `mod_resource_get_resources_by_courses`.
- **Deshacer:** `cm_delete` (papelera).

**Prueba real (sandbox, sección 5):** los cuatro tipos se crearon ocultos y se borraron, todos con `aplicado_verificado`.

**Relacionadas:** carpetas, libros y otros módulos: ADR-070 y ADR-077. Archivos de un recurso existente: ADR-077.

## ADR-065 · W6: cambiar fechas de tareas y cuestionarios existentes

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** directiva §8.8 («Cambiar fechas de una actividad: por formulario de edición. No por arrastre de calendario») y pedido del dueño de seguir con W6.
**Decisión:** capacidad nueva `edit_activity` y herramienta `campus_plan_edit_dates` (R2).
- **Superficie:** `/course/modedit.php?update=<cmid>`, con una spec por tipo (`course_modedit_assign_update` y `course_modedit_quiz_update`).
  - El GET trae la configuración actual y la merge la reenvía tal cual. Sólo se pisan los campos que cambian.
  - `coursecontentnotification` va siempre en 0 (omitida). Se envía `submitbutton2`.
  - El GET copia los archivos del módulo al borrador del usuario: es un efecto declarado.
- **Campos:**
  - tarea: `open` (apertura de entregas), `due`, `cutoff` y `grading_due`;
  - cuestionario: `open`, `close`, `time_limit_minutes` y `attempts`;
  - `null` deshabilita la fecha (su casilla se omite) y un campo ausente queda sin cambios;
  - un campo de otro tipo se rechaza.
- **Plan:**
  - muestra antes y después;
  - adelanta las validaciones de orden de Moodle;
  - rechaza un plan sin cambios;
  - precondición: los valores no cambiaron.
- **Verificación:** se relee por el servicio web (`mod_assign_get_assignments` o `mod_quiz_get_quizzes_by_courses`). La comparación es **al minuto**, porque el selector de Moodle no guarda segundos.
- **Deshacer:** compensación con los valores anteriores, incluida la vuelta a «sin fecha».

**Prueba real (sandbox):** sobre una tarea y un cuestionario ocultos creados para la prueba: cambios y deshacer, todo `aplicado_verificado`. Las actividades se borraron. No se tocaron la «Tarea» ni el «Cuestionario» del dueño.

## ADR-066 · W6: excepciones (overrides) de tareas por participante

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** directiva §8.8 («Override de una tarea: formulario overrideedit.php») y pedido del dueño de seguir con W6.
**Decisión:** capacidad nueva `assign_override` y herramienta `campus_plan_assign_override` (R2). No hay servicio web, así que se usa el formulario `/mod/assign/overrideedit.php?action=adduser`.
- **Campos:** `userid` y las fechas `open` (apertura de entregas), `due` y `cutoff`. Una fecha no indicada se envía igual a la de la tarea, y Moodle la guarda como null.
- **Sólo alta:** Moodle FUSIONA un override nuevo con uno existente del mismo usuario y borra el anterior.
  - Para detectarlo, el plan lee la lista `/mod/assign/overrides.php` y el formulario de cada override (`overrideedit.php?id=`), que tiene el `userid`. Son dos lecturas nuevas de chequeo previo.
  - Si el participante ya tiene un override, el plan se rechaza.
  - Precondición: la lista de ids no cambió.
- **Verificación:** el id nuevo aparece en la lista, y su formulario tiene el usuario y las fechas, comparadas al minuto.
- **Deshacer:** `/mod/assign/overridedelete.php`, un POST con `confirm=1` y sesskey.
- Para una simple prórroga del vencimiento sigue existiendo `campus_plan_extension` (servicio web).

**Prueba real (sandbox):**
- Sobre una tarea oculta de prueba, se creó un override para el estudiante de prueba y se verificó.
- La segunda excepción para el mismo estudiante se rechazó en el plan.
- El deshacer borró el override y la tarea se borró.

**Relacionadas:** excepciones de grupo: ADR-073. Editar una existente: ADR-099.

## ADR-067 · W6: secciones y borrados R4 (actividades y secciones)

**Fecha:** 2026-10-20 · **Estatus:** adoptada; techo modificado por ADR-118 · **Origen:** directiva §8.9 («Borrar: R4») y pedido del dueño: «continue with everything».
**Decisión:**
- **`campus_plan_delete_content`** (capacidad `delete_content`, **R4**): `core_courseformat_update_course` con `cm_delete` o `section_delete` (este último es nuevo en la allowlist), de a un id. Todo va a la papelera del curso (7 días).
  - **Guardas** (además del humano en el circuito de ADR-118):
    - `confirm_name` tiene que ser el nombre EXACTO del destino;
    - un único destino por plan, y el plan lista todo lo que se borra (en una sección, sus actividades);
    - nunca la sección 0, y una subsección se borra como sección;
    - precondición: la actividad sigue o la sección tiene las mismas actividades.
  - **Riesgo:** R4 es el riesgo base de los borrados; el techo lo fija ADR-118: R4 también por escalada y también en el remoto, con el humano en el circuito.
  - **Verificación:** el destino ya no está. Si Moodle salta el borrado sin error (`course_can_delete_section`), el resultado es `sin_efecto`.
  - **Deshacer:** no hay deshacer automático; se restaura a mano desde la papelera.
- **`campus_plan_create_section`** (capacidad `create_section`, R1): `section_add` al final. El nombre se pone con `campus_plan_rename`. Deshacer: `section_delete` mientras siga vacía.
- **Hallazgo (real):** la respuesta de `section_add` trae el estado de TODAS las secciones. La primera versión tomaba la primera, la sección 0, como «la creada»; la guarda de «sección con actividades» evitó borrar la General.
  - **Corrección:** la sección nueva sale sólo de la relectura (la que no estaba antes).
  - Quedaron dos secciones vacías de prueba, que se borraron con `delete_content`, verificando ids y que estuvieran vacías.
- **Límite conocido:** `confirm_name` no distingue secciones con el mismo nombre (por ejemplo, varias «Nueva sección»). El id indicado decide, y el plan muestra el id y su contenido.

## ADR-068 · W6: estado de preguntas (lista ↔ borrador)

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** directiva §8.10 («Estado de una pregunta», R2) y pedido del dueño de seguir con W6.
**Decisión:** herramienta `campus_plan_question_status`, con capacidad `edit_quiz` (la de la estructura de cuestionarios).
- **Superficie:** AJAX `qbank_editquestion_set_status` con `questionid` y `status` `ready|draft`, en la allowlist con argumentos cerrados. Sin permiso, Moodle devuelve `status=false` sin excepción, y eso vuelve como `rechazado_por_moodle`.
- **Plan:** el inventario del banco sólo lista preguntas listas.
  - Para pasar a borrador, la pregunta tiene que estar lista en ese banco (por id o por nombre único).
  - Para volver a lista, se usa el id; la pregunta no puede estar ya lista.
- **Verificación:** la pregunta aparece (lista) o desaparece (borrador) del inventario. **Deshacer:** el estado anterior.
- **Efecto declarado:** en borrador, la pregunta deja de entrar en los intentos NUEVOS con «siempre la última versión» y en las reglas aleatorias.

**Prueba real (sandbox):** `aplicado_verificado` a borrador y de vuelta, con limpieza completa.

## ADR-069 · W1: cambiar los adjuntos de un post propio

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pendiente de ADR-057 y pedido del dueño de seguir con todo.
**Decisión:** herramienta `campus_plan_post_attachments` (capacidad `edit_own_post`, R2). Sólo para posts propios y foros que no notifican a participantes.
- **Ejecución:**
  1. `mod_forum_prepare_draft_area_for_post` (nuevo en la allowlist: sólo `area=attachment`, borrador nuevo y la lista `filestokeep`) copia al borrador SÓLO los adjuntos que se conservan.
  2. Los archivos nuevos se suben a ESE borrador (`upload.php` con `itemid`).
  3. `mod_forum_update_discussion_post`, con asunto y mensaje `""` (sin cambios), reemplaza el área de adjuntos con `attachmentsid`.
  - El plan lo declara en `uploads.prepare`.
- **Trampa:** en Moodle, `filestokeep=[]` significa «conservar todos». Para quitar todos se manda un nombre que no existe, y la verificación lo confirma.
- **Plan:**
  - los nombres de `keep` tienen que estar en el post;
  - un archivo nuevo no puede llamarse igual que uno conservado (Moodle no sobrescribe);
  - se respeta `maxattachments`;
  - si no hay cambios, se rechaza.
- **Verificación:** nombres y tamaños de los adjuntos del post releído.
- **Deshacer:** si sólo se agregaron, se quitan. Si se quitó alguno, no hay deshacer (el archivo ya no existe).

**Prueba real (sandbox, foro de prueba):** agregar, deshacer, quitar todos y borrar la discusión, todo `aplicado_verificado`.

## ADR-070 · W6: crear foros y calificar el foro completo

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** directiva («Calificación de foro», W6) y pedido del dueño de seguir con todo.
**Decisión:**
- **`campus_plan_create_content` admite `type=forum`** (formulario `modedit.php?add=forum`).
  - Foro general. El formulario trae por defecto suscripción **automática** (`forcesubscribe=2`), que manda correo a los participantes. Se fuerza **deshabilitada** (3), o **opcional** (0) si se pide; la allowlist no admite 1 ni 2.
  - Calificación opcional del foro completo por puntos, con `grade_forum_notify=0`.
  - Se verifican `forcesubscribe` y `grade_forum` por `mod_forum_get_forums_by_courses`.
- **`campus_plan_forum_grade`** (capacidad nueva `grade_forum`, R3): AJAX `core_grades_grader_gradingpanel_point_store` (`mod_forum`/`forum`).
  - `notifyuser` va **siempre en false**, porque con true Moodle manda un mensaje inmediato aunque la nota no cambie.
  - `formdata` es sólo `grade=<n>`, o `grade=` para limpiar.
  - El panel no valida matrícula: el plan exige un participante matriculado, un foro con calificación por puntos y una nota menor o igual al máximo, distinta de la actual.
  - Lectura previa y verificación por `…_point_fetch` (nuevo en la allowlist AJAX de lectura, con argumentos cerrados).
  - **Deshacer:** la nota anterior, o limpiarla.

**Prueba real (sandbox):** foro oculto sobre 10, nota 7 al estudiante de prueba, deshacer y borrado. Todo `aplicado_verificado`.

## ADR-071 · W6: calificación manual de preguntas de cuestionarios

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** directiva («Calificación manual de cuestionarios: formulario /mod/quiz/comment.php (con sequencecheck)», W6) y pedido del dueño de seguir con todo.
**Decisión:** capacidad nueva `grade_quiz` y herramienta `campus_plan_quiz_grade` (R3).
- **Superficie:** `comment.php?attempt&slot`, que no es un moodleform.
  - La spec admite dos cosas nuevas:
    - un marcador que es un campo real (`marker_is_field`, `slots`), que se reenvía con su valor;
    - campos lógicos (`field_map`: `mark`, `comment`) que el transporte traduce al único campo servido que cumple el patrón (`q<usage>:<slot>_-mark`).
  - El resto del formulario se reenvía tal cual, **incluido `:sequencecheck`**: sin él, Moodle ignora el slot en silencio y muestra «guardado» igual. La verificación lo detecta como `sin_efecto`.
  - Éxito: página 200 con la notificación de éxito (`success_200`).
- **Notificaciones:** al terminar la calificación manual de un intento, Moodle puede avisar a su dueño. Con `allow_participant_notifications=false`, sólo se califican intentos **propios** (vistas previas del docente). Los de estudiantes se rechazan con el motivo, hasta que el dueño relaje esa restricción.
- **Plan:**
  - el intento es de un cuestionario del curso y está terminado;
  - el slot existe y la nota es menor o igual a su máximo;
  - precondición: la nota del slot no cambió.
- **Verificación:** `mod_quiz_get_attempt_review`. **Deshacer:** la nota anterior. Una pregunta sin nota no vuelve a «sin calificar» desde el formulario.

**Prueba real (sandbox):** en un cuestionario oculto con un ensayo y un intento de vista previa (creado con un script de prueba fuera del producto): nota 0,8 con comentario, cambio a 0,5 y deshacer, todos `aplicado_verificado`. El cuestionario se borró.

## ADR-072 · W6: preguntas aleatorias y nota máxima por pregunta

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** extensiones pedidas por el dueño: «Let's do those small additions».
**Decisión:**
- **`campus_plan_quiz_add_random`** (R2): `/mod/quiz/edit.php` con `addrandom`, `categoryid`, `randomcount` (1 a 20), `recurse` y `addonpage=0`.
  - Se usa este camino y NO el AJAX `mod_quiz_add_random_questions`, porque el AJAX no chequea si el cuestionario tiene intentos y `edit.php` sí (`check_can_be_edited`).
  - La categoría tiene que ser del banco indicado.
  - Verificación: N slots nuevos con esa regla (categoría y subcategorías).
  - Deshacer: quitar esos slots.
- **`campus_plan_quiz_slot_maxmark`** (R2): AJAX `mod_quiz_update_slots`, con UN slot y sólo `id` y `maxmark`.
  - Con intentos, Moodle reescala notas de estudiantes y cambia el libro de calificaciones, así que el plan lo rechaza si hay intentos.
  - Deshacer: el valor anterior, también sin intentos.
- **Detección de intentos** (lectura nueva `quiz_edit_page`): la página `/mod/quiz/edit.php` muestra el aviso «cannoteditafterattempts» en un `div.statusdisplay` con el enlace al informe.
  - El enlace «Resultados» de la navegación no cuenta.
  - Una página irreconocible es error, nunca «sin intentos».
  - Las vistas previas del docente no cuentan como intentos.

**Prueba real (sandbox):** sobre un cuestionario oculto de prueba: 2 aleatorias agregadas y quitadas, y una pregunta fija a 2,5 y de vuelta a 1. Todo `aplicado_verificado`.

## ADR-073 · W6: excepciones de grupo en tareas y cuestionarios

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** extensiones pedidas por el dueño.
**Decisión:** `campus_plan_assign_override` y `campus_plan_quiz_override` aceptan `group_id` como alternativa a `participant_id` (exactamente uno de los dos). El grupo tiene que ser del curso.
- **Tarea:**
  - `overrideedit.php` con `action=addgroup` y `groupid`.
  - La guarda contra la fusión de Moodle lee la lista `overrides.php?mode=group` (la lectura admite `mode=group`) y el formulario de cada override (`groupid`).
  - Precondición: `aovr:<cmid>:group`.
- **Cuestionario:**
  - `mod_quiz_save_overrides` con `groupid`; la allowlist admite `userid` O `groupid`, nunca los dos ni `id` ni `password`.
  - La guarda contra override existente y la verificación usan `groupid`.
  - Precondición: `goverride:<quiz>:<grupo>`.
- **Efecto declarado:** un override de usuario tiene prioridad sobre el de grupo.

**Prueba real (sandbox, grupo del estudiante de prueba):**
- Tarea oculta: override de un grupo. La segunda para el mismo grupo se rechazó en el plan.
- Cuestionario oculto: override de un grupo.
- Ambos verificados y deshechos; las actividades se borraron.

## ADR-074 · W6: agrupamientos

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** extensiones pedidas por el dueño.
**Decisión:** capacidad `manage_groups`.
- **`campus_plan_create_grouping`** (R1): formulario `/group/grouping.php?courseid`.
  - Se rechazan nombres o ID repetidos; se verifica por `core_group_get_course_groupings`.
  - **Deshacer:** POST `delete=1&confirm=1`, sólo si sigue sin grupos (precondición).
- **`campus_plan_grouping_groups`** (R2): fija el conjunto de grupos de un agrupamiento.
  - Un POST por grupo a `/group/assign.php?id=`, con `addselect[]`+`add` o `removeselect[]`+`remove`.
  - La página vuelve con 200 (`success_200` reconoce la lista); se verifica releyendo.
  - **Deshacer:** el conjunto anterior.
- **Lectura de los grupos de un agrupamiento:** no hay servicio web, así que se lee la lista `removeselect` de `assign.php` (lectura nueva `grouping_assign`).
  - **Formato real:** Moodle sirve el id del grupo con un punto final (p. ej. `value="12345."`). Con la lista vacía pone un relleno `<option>&nbsp;</option>` sin value, que se ignora.
  - **Cualquier otra opción irreconocible hace la página irreconocible (error), nunca «sin grupos».**
- **Hallazgo (real):** la primera versión no reconocía el punto final.
  - Leyó un agrupamiento de prueba como vacío, y su deshacer lo borró con un grupo adentro. El grupo y sus miembros no cambian al borrar un agrupamiento.
  - Corrección: el parser ya descrito, y un test que fija que una opción irreconocible no equivale a «vacío».

## ADR-075 · W6: editar descripción, contenido de páginas y nota máxima de tareas

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** el dueño: «Hacé editable la descripción (consigna) de tareas, cuestionarios, foros y páginas, el contenido de las páginas, y la nota máxima de las tareas».
**Decisión:** herramienta `campus_plan_edit_activity_text` (capacidad `edit_activity`, R2).
- **Superficie:** `/course/modedit.php?update`, con una spec por tipo (`course_modedit_<tipo>_update_text`). Se reenvía la configuración actual y se pisan sólo:
  - `introeditor[text]`;
  - `page[text]` (páginas);
  - `grade[modgrade_point]` (tareas).
  - `coursecontentnotification` va siempre en 0.
- **Nota máxima:** sólo en tareas calificadas por puntos y **sin notas cargadas** (`mod_assign_get_grades`). Con notas, Moodle pide elegir si reescalar, y las notas cambiarían de sentido.
- **Verificación:** por el servicio web de cada tipo (`intro`, `content`, `grade`), comparando el texto normalizado.
- **Deshacer:** compensación con el HTML anterior tal como lo devolvía Moodle; las imágenes incrustadas pueden no restaurarse igual.

**Prueba real (sandbox):** tarea, cuestionario, foro y página ocultos de prueba. Todo `aplicado_verificado` y deshecho.

## ADR-076 · W6: más ediciones (enlaces, etiquetas, resúmenes de sección y grupos)

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** el dueño: «si encontrás otras cosas para hacer editables, implementalas también».
**Decisión:**
- **`campus_plan_edit_activity_text` admite enlaces y etiquetas:**
  - enlaces: `external_url` (http/https, sin credenciales; clave permitida por §12 porque se guarda como contenido) y su descripción, por `course_modedit_url_update_text`, verificados con `mod_url_get_urls_by_courses`;
  - etiquetas: su texto (`description`, no vacío), por `course_modedit_label_update_text`, verificado por la descripción del módulo en la estructura del curso.
- **`campus_plan_section_summary`** (R2, capacidad `rename_content`): `/course/editsection.php?id`. Sólo el resumen; el nombre y las restricciones se reenvían tal cual. Verificación por `core_course_get_contents`. Deshacer: el resumen anterior.
- **`campus_plan_edit_group`** (R1, capacidad `manage_groups`): `/group/group.php?id&courseid`, con nombre, número de ID y descripción. Los miembros, la mensajería y la clave se reenvían tal cual. Deshacer: los valores anteriores.
- **Hallazgo (real):** para la cuenta docente de UdeSA, el número de ID de grupos y agrupamientos está **congelado** (falta `moodle/course:changeidnumber`). El formulario no trae el campo, Moodle ignora el valor y la verificación lo marcó como `aplicado_con_diferencias`.
  - **Corrección:** si el pedido incluye `idnumber`, el plan lee el formulario (lecturas nuevas `group_form_new`, `group_form_edit`, `grouping_form_new`) y, si el campo no está, rechaza con `MOODLE_PERMISSION_DENIED` antes de escribir.
  - Vale para crear y editar grupos y para crear agrupamientos. Verificado en real en los tres caminos.

**Prueba real (sandbox):** enlace, etiqueta, sección y grupo de prueba, editados y deshechos (`aplicado_verificado`) y borrados. El grupo de prueba creado al investigar el hallazgo también se borró.

## ADR-077 · W6: los elementos del sandbox (crear, editar y borrar por tipo)

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** el dueño: «mirá todos los elementos que agregué a mano en el sandbox y fijate cuáles podés editar; con eso vas a entender cómo crearlos y borrarlos».
**Relevamiento:** 26 elementos en 7 secciones. El resultado por tipo está en [SANDBOX_ELEMENTOS.md](SANDBOX_ELEMENTOS.md). Renombrar, mostrar u ocultar, mover y borrar ya valían para todos los tipos.
**Decisión:**
- **Descripción de cualquier actividad con descripción estándar** (carpeta, archivo, libro, wiki, glosario, base de datos, lección, LTI, H5P, consulta, elección de grupo, encuesta, actividad H5P, asistencia, subject attendance) en `campus_plan_edit_activity_text`.
  - Spec por tipo, `course_modedit_<tipo>_update_text`.
  - La lectura y la verificación usan el propio formulario (ruta nueva `modedit_form`). Las imágenes del editor se normalizan, porque cada apertura usa un borrador nuevo.
  - **Turnitin no:** guardar su formulario sincroniza con el servicio externo.
- **Opciones de una consulta** (`campus_plan_choice_options`, `edit_activity`, R2):
  - agregar, renombrar y quitar; las opciones nuevas usan `option_repeats` si faltan espacios;
  - Moodle borra una opción con texto vacío **junto con sus respuestas**, así que sólo se quitan opciones sin respuestas;
  - verificación por `mod_choice_get_choice_options`.
- **Archivos de carpetas y recursos** (`campus_plan_activity_files`, `edit_activity`):
  - variante nueva del motor, `uploads.form_draft`: el formulario sirve un borrador con los archivos actuales; el motor borra ahí lo pedido (`core_files_delete_draft_files`), sube lo nuevo al mismo borrador y envía el formulario sin tocar el campo (`submitForm` acepta un paso previo al POST);
  - agregar es R2 y se deshace quitándolo; quitar o reemplazar es R3 y sin deshacer (no se guarda copia);
  - en el remoto sólo se puede quitar.
- **Altas de más tipos** en `create_content`: carpeta (archivos), libro, wiki, glosario secundario, consulta (opciones), base de datos, lección, encuesta, elección de grupo (grupos del curso), actividad H5P (paquete `.h5p`) y subsección. Ocultas y sin notificar; se deshacen con `cm_delete`.
- **Contenido interno**, con la capacidad nueva `manage_activity_entries`:
  - **capítulos de libro** (`book_chapter`): formularios `/mod/book/edit.php`, `delete.php` y `show.php`; estructura por `core_course_get_contents`;
  - **entradas de glosario** (`glossary_entry`): `mod_glossary_add|update|delete_entry`;
  - **páginas de wiki** (`wiki_page`): `mod_wiki_new_page` y `mod_wiki_edit_page`; borrar por `/mod/wiki/admin.php`; sólo colaborativas sin grupos; la verificación exige que el HTML renderizado contenga el texto;
  - **entradas de base de datos** (`data_entry`): `mod_data_add|update|delete_entry`, valores en JSON por campo.
  - Agregar y editar son R2; borrar es R3. Deshacer por compensación.
- El parámetro de operación se llama `operation`, no `action`: la clave genérica `action` está prohibida (§12). Igual es un enum cerrado.
- **Relacionadas:** campos de bases de datos (ADR-080), páginas de lecciones (ADR-081 y 092), wikis por grupo e individuales (ADR-093), preguntas de encuestas (ADR-097), contenido H5P (ADR-110) y LTI (ADR-117).

**Prueba real (sandbox):**
- Descripción editada y deshecha en 16 tipos, sobre los elementos del dueño.
- Opciones, capítulos, entradas de glosario, páginas de wiki y entradas de base de datos: el ciclo completo, sobre los elementos del dueño, con todo deshecho.
- Once tipos nuevos creados y borrados.
- **Límite diario:** se alcanzó el de 200 escrituras de la directiva. Después de ADR-078 se completaron quitar archivos, reemplazar un recurso y borrar la carpeta de prueba.

## ADR-078 · Límite diario de escrituras: 2000

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido explícito del dueño: «sacá ese límite de 200 escrituras por día del perfil, o elevalo a 2000».
**Contexto:** la directiva fijaba `max_actions_per_day` en 200, y el esquema del perfil lo usaba como tope. Las pruebas reales de ADR-077 lo alcanzaron en una sola jornada.
**Decisión:** el esquema admite hasta 2000 y el perfil `udesa-docente-escritura` usa 2000. Se mantienen sin cambios:
- el límite por plan (30 ítems);
- los de mensajes (1 por plan, 20 por día);
- el freno por fallos seguidos.

El límite sigue siendo un freno contra un agente desbocado, ahora más alto. Es un ajuste del dueño sobre la directiva, no una exigencia de ella.

## ADR-079 · Leer el contenido interno de las actividades

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** objetivo del dueño: «seguir profundizando las capacidades de lectura y escritura sobre lo nuevo que se encontró» (los tipos de ADR-077).
**Decisión:**
- **Una herramienta tipada,** `campus_get_activity_content(course_id, course_module_id, cursor)`. Despacha por el tipo real del módulo (sale de `core_course_get_contents`), con un conjunto cerrado de lectores. No es una herramienta genérica: no recibe funciones ni tipos.
- **Qué lee cada tipo:**
  - libro: capítulos con su contenido; el `index.html` de cada capítulo se descarga por `webservice/pluginfile.php`, que no registra vistas;
  - glosario: entradas aprobadas y categorías;
  - wiki: páginas de cada subwiki, con el HTML renderizado;
  - base de datos: campos y entradas, con los valores por nombre de campo;
  - consulta: configuración, opciones y quién eligió cada una;
  - lección: configuración y páginas; **nunca la contraseña**, sólo si se usa;
  - actividad H5P: paquete e intentos por participante;
  - carpeta: configuración y archivos con `file_ref` (el mismo localizador que `campus_get_course`).
- **Paginado:** por caracteres en libros y wikis (`max_text_chars_per_result`), y por cursor en glosarios (de a 50) y bases de datos (de a 25).
- **Los demás tipos responden `UNSUPPORTED_CONTENT`** con la herramienta a usar: foro, tarea, cuestionario, página, archivo, enlace, etiqueta, asistencia y elección de grupo. Encuesta, H5P interactivo, LTI, subject attendance, Turnitin y subsección no tienen lectura por el servicio móvil.
- **Allowlist de lectura:** 17 funciones nuevas, ninguna `*_view_*`; capacidad `read_activity_content`.
  - Efecto declarado: `mod_wiki_get_subwiki_pages` puede regenerar la caché de render vencida de una página. No cambia contenido académico.
  - Las respuestas de consultas, las entradas y los intentos son datos personales: se tratan como el resto (sólo para la tarea docente).

**Prueba real (sandbox):** los 8 tipos, sobre los elementos del dueño. La encuesta y el cuestionario se rechazaron con la indicación correcta.

## ADR-080 · Campos de bases de datos y fechas de más actividades

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** objetivo del dueño de profundizar las escrituras sobre los tipos de ADR-077.
**Decisión:**
- **`campus_plan_data_field`** (capacidad `manage_activity_entries`): agregar, editar y borrar campos de una base de datos.
  - Usa el formulario simple `/mod/data/field.php` (modos add, update y delete; sin servicio web y sin marcador `_qf__`): un POST con los campos y el `sesskey`.
  - Tipos admitidos: texto, área de texto (con los parámetros por defecto de Moodle), número, URL, menú, opción, casillas, menú múltiple y fecha. El tipo de un campo existente no se cambia.
  - La página responde 200 (`id="page-mod-data-field-"`, con guion final): el éxito lo decide la relectura por `mod_data_get_fields`.
  - Borrar un campo borra todos sus valores: R3, y el plan cuenta las entradas.
  - Deshacer por compensación (recrear un campo borrado le da otro id, sin valores).
  - Con esto, una base creada por el MCP queda usable de punta a punta: crear, definir campos y cargar entradas.
- **`campus_plan_edit_dates` admite tres tipos más:**
  - consultas (apertura y cierre);
  - lecciones (disponible desde, fecha límite y límite de tiempo);
  - bases de datos (período para agregar entradas).

  Specs `course_modedit_{choice,lesson,data}_update`. Los valores actuales salen de las lecturas de ADR-079; para estos tipos sólo se consulta la función del tipo real del módulo.

**Prueba real (sandbox):** sobre una base de datos de prueba, campos menú y área de texto con su ciclo completo (incluida una entrada que usa el campo nuevo). Fechas de una consulta, una lección y la base de datos puestas y deshechas.

## ADR-081 · Páginas de lecciones

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** objetivo del dueño de profundizar las escrituras sobre los tipos de ADR-077.
**Decisión:** `campus_plan_lesson_page` (capacidad `manage_activity_entries`) maneja las páginas de una lección.
- **Agregar** sólo páginas de contenido: `/mod/lesson/editpage.php?qtype=20`, después de otra página o como primera, con un botón a la página siguiente (`jumpto=-1`). Las páginas de pregunta tienen respuestas, puntajes y saltos propios: van por `campus_plan_lesson_question` (ADR-092).
- **Editar** el título o el contenido de cualquier página: `editpage.php?edit=1`, un formulario por tipo (`LESSON_PAGE_FORMS`, por el `qtype` de Moodle). Respuestas, puntajes y saltos se reenvían tal cual; verificado en real sobre una página de opción múltiple.
- **Borrar** con `lesson.php?action=delete`: R3, porque se pierden las respuestas y los intentos registrados en esa página.
- **Lectura y verificación:** `mod_lesson_get_pages`, ordenadas por la cadena prev/next. El contenido «como se guardó» sale del formulario (ruta nueva `lesson_page_form`) para que el deshacer no arrastre el envoltorio que agrega el servicio.
- **Deshacer:** borrar la agregada; volver al título y contenido anteriores; recrear una página de contenido borrada (otro id). Una página de pregunta borrada no tiene deshacer.

**Prueba real (sandbox):** sobre una lección de prueba, el ciclo completo. Una página de pregunta conservó sus respuestas y sus saltos.

## ADR-082 · Ajustes por catálogo, restricciones y duplicar

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño: «revisá adversarialmente si todo está cubierto; si no, agregalo». La revisión encontró que, salvo descripción y fechas, ningún ajuste de las actividades era editable, y que faltaban modo de grupos, restricciones y duplicar.
**Decisión:**
- **`campus_plan_activity_settings`:** un catálogo cerrado por tipo (`src/write/settings-catalog.ts`), no un editor genérico de campos.
  - Cada clave pública apunta a un campo del formulario, con sus valores admitidos y su control.
  - El control importa: `select` y `advcheckbox` se mandan con su valor; una casilla simple en 0 se OMITE, porque Moodle la da por marcada con cualquier valor.
  - Comunes: modo de grupos, agrupamiento y «mostrar la descripción». Además, `restrictions` arma el JSON de condiciones (desde, hasta, grupos, agrupamiento) y lo reemplaza entero; `null` lo vacía.
  - Una spec por tipo (`course_modedit_<tipo>_update_settings`), generada desde el catálogo: el transporte sólo admite esos campos y valores.
  - Un ajuste que el formulario de esa actividad no trae se rechaza en el plan.
  - Verificación por el propio formulario: casilla simple ausente = 0; restricciones comparadas en forma canónica. Deshacer: los valores crudos anteriores.
  - **Afuera a propósito:** contraseñas, avisos y notificaciones, envío en grupo y anonimato de tareas, notas y escalas, Turnitin y plagio, Safe Exam Browser, y foros con suscripción forzada o automática.
  - **Finalización:** el curso tiene el seguimiento desactivado y los formularios no traen esos campos.
- **`campus_plan_duplicate_activity`:** tupla AJAX `cm_duplicate` (una actividad por llamada).
  - La copia no lleva datos de usuarios y conserva la visibilidad del original: R2 si es visible.
  - Turnitin, LTI y subsecciones no se duplican.
  - Verificación: un módulo nuevo del mismo tipo en la misma sección. Deshacer: borrarlo.
  - Se actualizó el invariante del test de W4, que exigía rechazar `cm_duplicate`.

**Prueba real (sandbox):** 14 casos de ajustes sobre los elementos del dueño, todos deshechos, y 7 duplicados con sus copias borradas.

## ADR-083 · Correcciones de la revisión adversarial

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** revisión adversarial de cobertura pedida por el dueño. La hizo un agente independiente que contrastó cada tipo de elemento contra el código.
**Decisión:**
- **Eventos de grupo.** Hallazgo real: `core_calendar_get_calendar_events` responde `nopermissions` para los grupos de los que la cuenta no es miembro y omite sus eventos. Un evento de grupo recién creado daba `sin_efecto` y quedaba huérfano.
  - Lectura y verificación ahora suman la vista mensual del calendario (`core_calendar_get_calendar_monthly_view`, allowlist de lectura con sólo year, month y courseid).
  - Para un evento puntual se usa `core_calendar_get_calendar_event_by_id`.
  - El huérfano se encontró y se borró.
- **`campus_plan_calendar_event_delete`:** borra una ocurrencia de un evento existente de curso o de grupo (no los de actividad). El deshacer lo recrea igual, como plan de `calendar_event`.
- **Bases de datos:** valores para casillas y menú múltiple (arreglo JSON; Moodle los une con `##`) y fecha (subcampos day, month y year; Moodle guarda el mediodía local). Antes se podían crear esos campos, pero no cargarlos.
- **Consultas:** `limits` por opción en `campus_plan_choice_options`. Antes los límites se mandaban en 0 y `limitanswers` no era editable; ahora se activa con `campus_plan_activity_settings`.
- **Turnitin:** borrar y renombrar se rechazan (contactan el servicio externo), también al borrar una sección que lo contiene. Mostrar, ocultar y mover siguen, porque son operaciones del núcleo.
- **Lectura:**
  - `campus_get_activity_content` devuelve la descripción de cada tipo y el texto completo de las etiquetas;
  - `campus_list_forums` devuelve descripción y ajustes.
- **Documentos:** SANDBOX_ELEMENTOS se corrigió donde afirmaba más de lo que hace el código: calificación manual, publicar en Avisos, límites de calificación de tareas, sesiones de asistencia y entradas pendientes de glosarios.

**Fuera de esta decisión** (cada uno en su ADR):
- editar sesiones de asistencia y eventos (ADR-089);
- borrar excepciones existentes (ADR-084);
- aprobar entradas de glosario (ADR-089) y de base de datos (ADR-085);
- reordenar capítulos y secciones (ADR-085);
- editar agrupamientos (ADR-085);
- leer intentos de lecciones (ADR-085) y resultados de H5P (ADR-090).

**Fuera de alcance por diseño:** Turnitin, LTI, el contenido de H5P interactivo, estadísticas de cuestionarios, calificar intentos de estudiantes y publicar en foros forzados (notifican), matrículas y roles.

**Prueba real (sandbox):** todo lo anterior, con deshacer.

## ADR-084 · Borrar elementos existentes

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** revisión adversarial (ADR-083). Los borrados de sesiones de asistencia, excepciones de cuestionarios y tareas, y preguntas de un cuestionario estaban en la allowlist, pero sólo como deshacer de lo creado por el MCP.
**Decisión:** cuatro herramientas para borrar elementos existentes:
- `campus_plan_attendance_session_delete`;
- `campus_plan_quiz_override_delete`;
- `campus_plan_assign_override_delete`;
- `campus_plan_quiz_remove_question`.

Cómo funcionan:
- Cada plan arma el MISMO ítem que el deshacer original y lleva la intención original (`attendance_session`, `quiz_override`, `assign_override`, `quiz_add_questions`). Así verifica el código que ya verificaba ese borrado, y no se agrega nada a la allowlist.
- El plan valida antes que el elemento exista. Quitar una pregunta exige que el cuestionario no tenga intentos.
- Son R3 y sin deshacer automático: se puede volver a crear con la herramienta de alta.

**Prueba real (sandbox):** los cuatro, sobre elementos creados con las herramientas normales y borrados con las nuevas.

## ADR-085 · Reordenar, agrupamientos y aprobaciones

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pendientes de la revisión adversarial (ADR-083).
**Decisión:**
- **`campus_plan_move_section`:** tupla AJAX `section_move_after`, de a una sección. La General y las subsecciones no se mueven por esta vía. Verificación por el orden del curso; el deshacer la devuelve después de la sección que tenía antes.
- **Capítulos:** `move_up` y `move_down` en `campus_plan_book_chapter`, por `/mod/book/move.php`. Un capítulo principal lleva sus subcapítulos.
- **`campus_plan_edit_grouping`:** nombre y descripción, por `/group/grouping.php?id`. El número de ID está congelado para la cuenta (ADR-076).
- **Bases de datos:** `approve` y `unapprove` en `campus_plan_data_entry`, por `mod_data_approve_entry`. No envía mensajes.
- **Glosarios:** las entradas pendientes se LEEN (`mod_glossary_get_entries_to_approve`); aprobarlas está en ADR-089 (puede avisar al autor; excepción aceptada por el dueño).
- **Lecciones:** resumen de intentos por estudiante (`mod_lesson_get_attempts_overview`) en `campus_get_activity_content`.

**Fuera de esta decisión** (cada uno en su ADR):
- editar sesiones de asistencia y eventos (ADR-089);
- resultados por pregunta de H5P (ADR-090);
- calificación avanzada de tareas: escalas, rúbricas, archivos de retroalimentación (ADR-095);
- libro de calificaciones (ADR-096);
- moderación de foros: borrar posts de otros, mover discusiones (ADR-094);
- preguntas de encuestas (ADR-097) y páginas de pregunta de lecciones (ADR-092);
- wikis por grupo (ADR-093);
- páginas y secciones de cuestionarios (ADR-091).

**Prueba real (sandbox):** todo lo anterior con deshacer y limpieza.

## ADR-086 · Correcciones de la revisión de lecturas docentes

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** revisión de código de las lecturas docentes pedida por el dueño (la parte de foros quedó en ADR-039).
**Alcance:** las lecturas son las mismas en los dos perfiles docentes. `docente-lectura` (`serve`, `/mcp`) y `docente-completo` (`serve-full`, `/mcp-completo`) usan el mismo `CampusService` y el mismo transporte web. El servidor de escritura también lee la lista de sesiones de Asistencia con el mismo parser (`sessionsOf`), así que cada corrección se probó en lectura y en escritura.
**Decisión:**
- **Redirecciones web.** La política audita la ruta pedida, no su destino. Una redirección a otra ruta del Campus ya no se sigue: da `UNEXPECTED_RESPONSE`. Ejemplo: `manage.php` redirige a `view.php` cuando la cuenta no puede gestionar la asistencia, y `view.php` registra un evento de vista. Sólo se siguen redirecciones dentro de la misma ruta. Las de login siguen dando `AUTH_REQUIRED`, y las de otro origen, `RESOURCE_OUT_OF_SCOPE`. No afecta los formularios de escritura, que usan `writeRequest` y no siguen redirecciones.
- **Lista de sesiones de Asistencia.** El parser cuenta las filas que parecen sesiones (enlazan un `sessionid` o traen la casilla) pero no se pueden interpretar (`discarded`).
  - En lectura, el historial queda parcial y lo avisa.
  - En escritura, `sessionsOf` falla con `UNEXPECTED_RESPONSE`: una fila no interpretada puede ser justo la sesión que hay que verificar.
- **Sesiones tomadas sin datos reconocidos.** Una sesión que figura como tomada pero sin ningún registro reconocido, o con registros y sin alumnos en el formulario, deja la cobertura parcial con un aviso de formato, en vez de figurar como «sin registrar» o como «alumnos que ya no están».
- **Tamaño del historial.** El detalle por alumno se limita a 4 × `max_text_chars_per_result` (120 000 caracteres en `udesa-docente`). Las sesiones más viejas pierden `records` (`records_omitted: true`), pero conservan `counts`, y `by_student` sigue calculado con todas.
- **Exportación por categoría.**
  - Si la regla no incluye subcategorías y no se puede aislar la categoría, responde `POLICY_DENIED` (§3.2).
  - Cada página respeta también el tope de texto del perfil, con al menos una pregunta, y continúa con el cursor.
  - `matching` y `cloze` del XML se normalizan a `match` y `multianswer`, como los informa el inventario. Antes no coincidían nunca, y las preguntas de emparejamiento quedaban «opaca».

Los hallazgos del keepalive de la misma revisión están en ADR-106.

## ADR-087 · El keepalive programado no es viable en una PC administrada

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** instalación de `auth web keepalive install` en una PC administrada (Windows 11, sin privilegios de administrador).
**Hallazgos:**
- En algunas PCs administradas, sin privilegios de administrador, la tarea programada no funciona: no lanza Node, o la política de seguridad de la PC la quita. En una PC sin esas restricciones sí funciona. Por eso existe el login automático (ADR-088).
- La falta de permisos de administrador no es la causa: la tarea es por usuario y se crea igual.

**Decisión:**
- En esas PCs no se insiste con tareas programadas, accesos en Inicio ni procesos residentes.
- El código sigue usando `conhost`, que funciona en una PC sin esas restricciones.
- Se descartaron estas alternativas:
  - el cron de Vercel, que en Hobby corre una vez por día;
  - GitHub Actions, porque no quedan minutos libres;
  - un keepalive dentro del proceso del MCP, porque la PC se apaga seguido.
- El reemplazo es ADR-088.

## ADR-088 · Login web automático con contraseña guardada (opcional, no recomendado)

**Fecha:** 2026-10-20 · **Estatus:** adoptada como excepción explícita del dueño · **Origen:** la sesión web vence a las 4 h sin uso y el keepalive no es viable en una PC administrada (ADR-087). El dueño quiere que el MCP «empiece a andar apenas le llega la consulta», sin pasos previos en la terminal.
**Alcance:** se aparta de la directiva, que admite mantener una sesión importada pero no el autologin. Por eso es **opcional, apagado por defecto y no recomendado**: sólo para cuando el keepalive está bloqueado por motivos externos. `tool_mobile_get_autologin_key` sigue prohibido. Aplica al **MCP local** (`serve` y `serve-full`, que comparten la sesión del perfil de lectura). El remoto: ADR-127.
**Auditoría (Moodle 5.1.8, `MOODLE_501_STABLE`):**
- **Formulario de login** (`login/index.php`): el `logintoken` es de un solo uso y está atado a la sesión anónima. Se hace un POST con `username`, `password` y `logintoken`. Si sale bien, redirige a `?testsession=<userid>`; si falla, vuelve al formulario con `#loginerrormessage`.
- **Bloqueo de cuenta:** `lockoutthreshold` (0 por defecto) cuenta las contraseñas equivocadas, también las de `token.php`. Un `logintoken` inválido no cuenta.
- **Sesiones simultáneas:** `limitconcurrentlogins` (0 por defecto) cuenta sesiones por usuario, sin distinguir dispositivo.
- **Captcha** (`enableloginrecaptcha`): si el sitio lo pide, el login automático falla cerrado.
- **MFA** (`tool_mfa`):
  - El factor por correo pide un código de 6 dígitos (`factor_email`, campo `verificationcode`). El correo sale al armar la página, y un código equivocado suma al contador del factor.
  - El dispositivo de confianza (`factor_token`) usa la cookie `MFA_TOKEN_<userid>`, un secreto guardado en el servidor.
  - La confianza dura lo que configure el sitio; el servidor lee su vencimiento de la cookie.
- **Efectos de un login exitoso:** dispara `user_loggedin` y actualiza `lastlogin`, `currentlogin`, `lastaccess` y `lastip`. El aviso de nuevo inicio (`moodle/newlogin`) se manda si cambió la IP y no hay cookie `MOODLEID1_`; el dueño no lo recibe.
- **Cambio de contraseña:** cierra las demás sesiones (`passwordchangelogout` = 1).

**Decisión:**
- **Dos llaves:**
  - La contraseña, que carga el humano con `auth web autologin enable` y que se guarda sólo después de un login verificado.
  - `CAMPUS_WEB_AUTOLOGIN=true` en la entrada del cliente MCP. Sin la variable, el servidor ni siquiera lee el keyring.
- **Dónde vive:**
  - Usuario y contraseña, en el keyring (`<perfil>|<sitio>|web_login`).
  - `MFA_TOKEN_*` y `MOODLEID1_`, en `web_trust`, separadas de la sesión.
  - El estado sin secretos (intentos, último resultado, desactivación y vencimiento de la confianza), en `web-autologin.json`.
- **Cuándo:**
  - `WebTransport.open()` lo usa una vez si no hay sesión o si la guardada venció, y reintenta la operación una vez.
  - Hay un solo login a la vez: dentro del proceso, las operaciones concurrentes lo comparten; entre procesos, lo serializa un candado de archivo.
- **MFA:**
  - Con la cookie de confianza vigente no se pide código.
  - Si el Campus lo pide, un diálogo de Windows lo pide al humano, fuera del modelo, como la confirmación de escrituras. Se envía con «confiar en este dispositivo».
  - Sin diálogo, `AUTH_REQUIRED`.
- **Guardas:**
  - Nunca reintenta. Un rechazo de la contraseña o del código desactiva la función hasta un nuevo `enable`.
  - Un intento cada 10 minutos y 6 por día, como máximo.
  - Falla cerrado ante captcha, otro factor, cambio de contraseña forzado, políticas pendientes o una página inesperada.
  - Sólo sigue el propio flujo (`testsession` y la página del MFA) y no pide la página de destino.
  - Verifica la sesión resultante contra el userid del token.
- **La contraseña no aparece** en logs, errores, estado ni respuestas. El agente no la ve ni la puede pedir.
- **Corte:**
  - `auth web autologin disable` borra la contraseña y las cookies recordadas.
  - Para cortar sólo la sesión web del MCP: «Cerrar sesión» en su fila de Preferencias → Sesiones del navegador (`report/usersessions/user.php`).
  - En una emergencia, cambiar la contraseña del Campus cierra todas las sesiones y deja inútil la contraseña guardada. Ojo: **no revoca los dispositivos de confianza** (nada en el gestor de secretos de tool_mfa reacciona al cambio). Alcanza porque la confianza sola no inicia sesión; pero si sospechás que un lugar donde estaba guardada la contraseña quedó comprometido, no le cargues la nueva. Verificá si tu sitio permite revocar dispositivos de confianza; de todos modos, la confianza sin la contraseña no alcanza para iniciar sesión.
  - `auth web logout --local` borra la copia local, pero no cierra la sesión en el Campus: queda hasta que vence (4 h sin uso) o se cierra desde Sesiones del navegador.

**Riesgo aceptado por el dueño:** con la contraseña y la confianza del dispositivo guardadas, quien acceda al keyring de esa cuenta de Windows puede abrir la web del Campus sin el segundo factor mientras dure la confianza. Cada login queda registrado en el Campus.
**Validado en real:** `enable` con código, confianza del dispositivo, convivencia con la sesión del navegador y relogin sin código. La página del MFA trae más de un formulario hacia `auth.php`: se elige el que tiene `verificationcode`.

## ADR-089 · Aprobar entradas de glosario, editar sesiones y eventos

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:**
- **Glosarios:** `approve` y `unapprove` en `campus_plan_glossary_entry`, por `/mod/glossary/approve.php` (POST con sesskey; no hay servicio web). Al aprobar, Moodle puede avisar al autor. El dueño lo aceptó expresamente: es la única excepción a «no notificar a participantes». Verificación por `mod_glossary_get_entry_by_id` (campo `approved`).
- **`campus_plan_attendance_session_edit`:** fecha, horario y descripción de UNA sesión existente, por el formulario `updatesession` de `/mod/attendance/sessions.php?action=2`. El resto del formulario (automarcado, contraseña, evento de calendario…) se reenvía tal cual. Lo registrado en la sesión se conserva. Verificación releyendo el mismo formulario (ruta de lectura `attendance_session_form`).
- **`campus_plan_calendar_event_edit`:** nombre, descripción, inicio y duración de UNA ocurrencia de un evento de curso o de grupo, por `core_calendar_submit_create_update_form` con el `id` del evento. El validador del transporte exige el `id`: sin él la función crearía un evento. Admite sólo tipos `course` y `group`, sin repeticiones, y el tipo y el grupo no cambian. Si la descripción tiene imágenes, hay que reescribirla.
- Deshacer: los valores anteriores.

**Prueba real (sandbox):** entrada de glosario propia desaprobada, aprobada y borrada. Sesión de prueba agregada, editada (fecha, horario y descripción), restaurada y borrada. Eventos de curso y de grupo creados, editados, restaurados y borrados.

## ADR-090 · Respuestas por pregunta de H5P

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:** `campus_get_activity_content` acepta `attempt_id`, sólo para actividades H5P (`h5pactivity`). Con él lee las respuestas por pregunta de ese intento con `mod_h5pactivity_get_results`, que se agrega a la allowlist de lectura y no registra vistas. Cada pregunta trae:
- texto, tipo de interacción, puntaje, éxito y duración;
- opciones, con la respuesta correcta y la del participante.

La lista de intentos ahora incluye el `attempt_id` de cada uno. Son datos personales (👤): el aviso lo recuerda.

**Prueba real (sandbox):** la función responde. La actividad H5P de prueba no tiene intentos, porque los de la cuenta docente no se registran, así que el contenido de una respuesta real queda por ver.

## ADR-091 · Páginas y secciones de cuestionarios

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:** `campus_plan_quiz_layout` usa los mismos caminos que la página de edición del cuestionario:
- **Repaginar:** `edit.php` con `repaginate` y `questionsperpage`.
- **Salto de página después de un slot:** `repaginate.php` (`repag` 2 agrega, 1 quita).
- **Agregar sección:** `edit.php?addsectionatpage`. Moodle le pone «Nuevo título».
- **Cabecera y orden al azar:** `edit_rest.php` con `updatesectiontitle` y `updateshufflequestions`.
- **Quitar sección:** `edit_rest.php` con `action=DELETE`. Las preguntas pasan a la sección anterior.

Repaginar, saltos y secciones exigen que el cuestionario no tenga intentos; Moodle también lo rechaza. La cabecera y el orden al azar no lo exigen: valen para los intentos nuevos.

La lectura sale de la página de edición: `<li id="section-N">`, `<li id="page-N">` y `<li id="slot-N">` en orden, la cabecera en `span.instancesection` y la casilla `shuffle-N`. `campus_get_quiz_structure` la expone con `include_layout`, porque la página de calificación no trae páginas ni ids de sección.

**Deshacer:**
- Repaginar se deshace poniendo o quitando cada salto que cambió: un ítem por salto, cada uno verificado.
- Agregar una sección se deshace quitándola, y al revés.
- Cabecera y orden al azar vuelven a sus valores anteriores.

**Prueba real (sandbox):** todo, sobre un cuestionario de prueba propio con 4 preguntas importadas, que se borró al final. Además, lectura de páginas y secciones del «Cuestionario» del dueño.

## ADR-092 · Páginas de pregunta de lecciones

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:** `campus_plan_lesson_question` agrega o edita páginas de pregunta con los formularios de la lección (`/mod/lesson/editpage.php`, uno por tipo):
- **Opción múltiple y verdadero/falso:** respuestas con editor (HTML).
- **Respuesta corta y numérica:** respuestas en texto plano; la numérica valida un número o un rango «mín:máx».
- **Ensayo:** sólo salto y puntaje.
- **Emparejamiento:** retroalimentación de acierto y de error, más pares pregunta → respuesta.

Cada respuesta lleva retroalimentación, salto y puntaje:
- El salto es `this` (0), `next` (-1), `previous` (-40), `end` (-9) o el id de una página de la MISMA lección, que el plan comprueba.
- `correct` es un atajo: siguiente con 1 punto, o esta página con 0.
- El número de respuestas por página sale de `maxanswers` de la lección.

Al editar se envían todas las casillas. Las respuestas que no se indican quedan vacías y Moodle las borra.

La verificación relee el formulario de edición de la página: título, enunciado, opción y respuestas normalizadas. `campus_plan_lesson_page` con `delete` ahora guarda la pregunta antes de borrarla, y su deshacer la recrea (otro id; los intentos en ella no vuelven).

**Prueba real (sandbox):** los 6 tipos agregados y verificados en una lección de prueba; respuestas editadas y restauradas; una página borrada y recreada por el deshacer; todo borrado.

## ADR-093 · Wikis por grupo e individuales

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:** `campus_plan_wiki_page` acepta `group_id` (wiki con grupos) y `user_id` (wiki individual) para elegir el subwiki:
- La lista sale de `mod_wiki_get_subwikis`, que sólo devuelve los subwikis a los que la cuenta accede; los que no existen todavía vienen con id 0.
- Un subwiki ajeno se rechaza, y el error lista los disponibles.
- Si el subwiki no existe, `mod_wiki_new_page` lo crea con `wikiid`, `groupid` y `userid`. El validador ahora admite cualquier grupo o participante, además del 0.
- Las versiones del plan y el destino de cada ítem llevan el grupo y el participante, así que la verificación y el deshacer vuelven al mismo subwiki.

En una wiki con grupos, la cuenta docente también ve el subwiki «todos los participantes» (grupo 0). La lectura (`campus_get_activity_content`) ya recorría todos los subwikis.

**Prueba real (sandbox):** una wiki de prueba con grupos separados y otra individual, ambas borradas al final. En la primera, páginas en los subwikis de dos grupos, edición y deshacer. En la segunda, la primera página en la del estudiante de prueba.

## ADR-094 · Moderación de foros

**Fecha:** 2026-10-20 · **Estatus:** adoptada; ampliada por ADR-125 · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:** capacidad nueva `moderate_forum`, habilitada en el sandbox y, desde ADR-125, en todos los cursos con rol de escritura.
- **`campus_plan_forum_post_delete`:** `mod_forum_delete_post` sobre un post de CUALQUIER autor, con su rama de respuestas. Es R3 y no tiene deshacer (no hay papelera). El primer post borra la discusión entera, así que exige `delete_discussion=true`. Moodle no avisa al autor.
- **`campus_plan_forum_move_discussion`:** `/mod/forum/discuss.php` con `d` y `move` (POST con sesskey; no hay servicio web). Moodle mueve posts, adjuntos y suscripciones.
  - No mueve desde ni hacia un foro de Avisos (suscripción forzada) ni foros de una sola discusión (Moodle los rechaza).
  - El destino no puede mandar correo a los participantes (`assertNoParticipantMail`).
  - El post más nuevo tiene que tener más de 15 minutos (tres veces la ventana de correo de ADR-100): uno que todavía no salió por correo saldría a los suscriptores del foro destino.
  - Deshacer: moverla de vuelta.

El borrado de posts por deshacer de los propios sigue igual. Los helpers de foros (`FORUM_COMMON`, `forumsOf`, `discussionsOf`) se comparten.

**Prueba real (sandbox):** en el foro de prueba, respuesta y discusión de prueba borradas con la herramienta. Mover: una discusión de prueba se movió a un foro de prueba y volvió con el deshacer, y se rechazó moverla a Avisos.

## ADR-095 · Calificación avanzada de tareas

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:**
- **`campus_plan_grade_advanced`:** usa el formulario CLÁSICO de calificación (`/mod/assign/view.php?action=grade&userid`; marcador `_qf__mod_assign_grade_form_<userid>`), que trae todo junto:
  - nota en puntos o ítem de escala (por texto o valor);
  - rúbrica: radio `advancedgrading[criteria][<id>][levelid]` y observación;
  - guía: `[score]` y observación;
  - comentario y archivos de retroalimentación, en el borrador `files_<userid>_filemanager`, que ya trae los actuales;
  - estado del flujo de trabajo.

  `sendstudentnotifications` y `applytoall` quedan fijos en 0. Nunca se fija «liberada», ni se reenvía una calificación ya liberada. Las anónimas y en grupo se siguen rechazando. La verificación relee el formulario (niveles, puntajes, observaciones), el comentario y los archivos, y reporta la nota del libro.
- **`campus_plan_grading_definition`:** el área sale de `/grade/grading/manage.php` (areaid, método activo, `deleteform`). La definición se guarda con el editor (`form/<rubric|guide>/edit.php`) SIN mezclar lo servido: sólo criterios nuevos (NEWIDn), así Moodle borra los que no llegan, y queda «lista para usar». Se borra con `manage.php?deleteform&confirmed=1`. Sólo sin notas puestas.
- **Ajustes de tarea nuevos** (catálogo): `grading_method`, `grade_type`, `grade_scale` (validada contra las escalas del formulario; el error las lista) y `marking_workflow`. Sólo sin notas puestas; Moodle además deshabilita el tipo de nota.
- **Transporte web:**
  - `field_patterns`: campos cuyo nombre lleva ids de la página, con su validador.
  - `qf_marker_query`: el sufijo del marcador sale de un parámetro validado del GET.
  - `{userid}` en `upload_fields`, y `form_draft_files` para editar el borrador servido.

**Deshacer:** vuelve la nota, los niveles o puntajes, el comentario y el estado, y se quitan los archivos agregados. Un archivo quitado no vuelve. Sin nota previa no hay deshacer, porque Moodle no vuelve a «sin nota» por el formulario.

**Prueba real (sandbox):** tres tareas de prueba (rúbrica, guía, escala) con el estudiante de prueba, sin notificar. Se probaron definición, calificación, cambio y deshacer en cada una, y archivos de retroalimentación agregados y quitados.

## ADR-096 · Libro de calificaciones

**Fecha:** 2026-10-20 · **Estatus:** adoptada; ampliada por ADR-125 · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:** capacidad nueva `manage_gradebook`, habilitada en el sandbox y, desde ADR-125, en todos los cursos con rol de escritura. Usa las páginas clásicas del libro, que funcionan sin el modo de edición (la vista única y el informe del calificador lo exigen, y cambiarlo tocaría la sesión del dueño):
- **Ítems:**
  - Agregar o editar un ítem MANUAL con `/grade/edit/tree/item.php` (nombre, número de ID, tipo, escala, notas máxima, mínima y de aprobación, oculto). Los de actividades se cambian en la actividad.
  - Borrar un ítem manual con `index.php?action=delete&confirm=1`.
  - Ocultar, mostrar, bloquear o desbloquear cualquier ítem con `action.php` (`eid=ig<id>`).
- **Notas:** `/grade/edit/tree/grade.php` cambia sobrescritura, nota, excluida, oculta, bloqueada y retroalimentación. En un ítem de actividad la nota se SOBRESCRIBE y `null` quita la sobrescritura. En uno manual se pone directo y `null` la borra.
- **Verificación:** se relee el formulario del ítem o de la nota; la lista de ítems sale de `core_grades_get_gradeitems`, ahora verify_read.
- **Hallazgos reales:**
  - Moodle no bloquea un ítem con notas pendientes de recálculo: antes de bloquear se abre el informe del calificador (ruta de lectura `grader_report`), que recalcula.
  - Con notas, el formulario del ítem no dibuja el tipo de nota: si hay nota máxima es «valor»; si no, el deshacer de un borrado no se ofrece.
  - Las notas se muestran con coma decimal y se comparan como números. Moodle acepta tanto «8.25» como «8,25», así que no hay riesgo de que «7.5» se lea como 75 (probado también con `campus_plan_grade` y `campus_plan_grade_advanced`).

**Deshacer:** lo inverso; los valores anteriores. Un ítem borrado se recrea con su configuración pero sin sus notas.

**Prueba real (sandbox):** todo lo anterior sobre un ítem manual de prueba (borrado al final) y sobre la nota del estudiante de prueba en la tarea de prueba con escala.

## ADR-097 · Preguntas de encuestas

**Fecha:** 2026-10-20 · **Estatus:** adoptada · **Origen:** pedido del dueño (lista de pendientes de ADR-085).
**Decisión:** `campus_plan_questionnaire_question` usa las páginas del plugin (`/mod/questionnaire/questions.php`; no hay servicio web):
- **Agregar:** `?action=question&type_id=N`, al final de la encuesta.
- **Editar:** `?action=question&qid=N`. El formulario `edit_question_form` tiene nombre, obligatoria, enunciado, opciones una por línea, `length` y `precise`; el tipo no se cambia.
- **Borrar:** `?delq=<qid>`. El plugin la marca como borrada.

El plugin responde con la página de preguntas (200), no con una redirección: se declara como éxito (`success_200`). La verificación relee el formulario de la pregunta.

**Tipos:** sí/no, cuadro de texto, texto amplio, radio, casillas, desplegable, escala Likert, fecha, numérico y descripción. El deslizador y el salto de página quedan afuera.

**Lectura:** `campus_get_activity_content` lista las preguntas de una encuesta (id, posición, tipo y nombre) desde la página de preguntas. Es la ruta de lectura `questionnaire_questions`, sin efectos. La sesión web llega al lector como dependencia opcional (`webPage`).

**Deshacer:** borrar la agregada; volver a lo anterior; recrear la borrada (otro id; sus respuestas no vuelven).

**Prueba real (sandbox):** en «Encuesta», todo lo anterior con limpieza; la pregunta del dueño quedó como estaba.

## ADR-098 · Suscripción del autor en foros

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** hallazgo del dueño. Le llegaron por correo dos discusiones del foro de prueba, las que quedaron más de 30 minutos para probar el movimiento de ADR-094.
**Causa:** desde W1, avisos, respuestas, ediciones y adjuntos mandaban siempre `discussionsubscribe=1`. Para las ediciones se había hecho a propósito: sin la opción, Moodle desuscribe a quien edita. En la web es la casilla «Suscripción a la discusión» de cada post. El autor quedaba suscripto y, pasado `maxeditingtime`, le llegaba el correo.
**Decisión:**
- Opción `subscribe` en `campus_plan_announcement`, `campus_plan_forum_reply`, `campus_plan_post_edit` y `campus_plan_post_attachments`.
- Por defecto es **no**: nadie recibe correo por una publicación del MCP salvo quien lo pida.
- Al editar, Moodle fija la suscripción con el valor enviado. El servicio web no expone el estado actual, así que se manda el pedido (por defecto, no).
- La vista previa (`discussion_subscribe`) y los efectos lo informan.

**Prueba real (sandbox):** discusión nueva en el foro de prueba con el valor por defecto; en la página del foro, su casilla de suscripción quedó desmarcada.

## ADR-099 · Editar excepciones y guarda de calificación

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** huecos chicos pedidos por el dueño.
**Decisión:**
- **`campus_plan_override_edit`:** edita una excepción existente con su formulario de edición (`/mod/quiz/overrideedit.php?id`, marcador `_qf__mod_quiz_form_edit_override_form`; `/mod/assign/overrideedit.php?id`). El formulario servido se reenvía tal cual salvo lo que cambia. Así se conserva la contraseña de la excepción del cuestionario, que `mod_quiz_save_overrides` con id reemplazaría. Una fecha en `null` deja de estar sobrescrita. Verificación por `mod_quiz_get_overrides` o el formulario de la excepción; deshacer, los valores anteriores.
- **Guarda de `campus_plan_grade`:** con rúbrica o guía, la nota sale de los criterios. El plan lee el método en la gestión de la calificación avanzada y remite a `campus_plan_grade_advanced`. Sin sesión web no se puede leer el método; en ese caso Moodle rechaza el guardado incompleto. Los mensajes de escala y de flujo de trabajo remiten a la misma herramienta.

**Prueba real (sandbox):** excepciones de prueba en «Cuestionario» y «Tarea» editadas, restauradas y borradas. La guarda deja pasar una tarea de calificación simple.

## ADR-100 · Ventana de correo de los foros de UdeSA

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** pendiente «maxeditingtime de UdeSA»; el dueño propuso medirlo.
**Medición:** discusión en el foro de prueba con `subscribe=true` (el dueño suscripto), publicada a las 23:49:35 (GMT-3); el correo le llegó a las 23:55. Coincide con un `maxeditingtime` de 5 minutos más el cron, que corre cada minuto. El valor por defecto de Moodle es 30 minutos.
**Decisión:**
- `DEFAULT_EDIT_WINDOW_S` = 300. El «deshacer sin rastro» de avisos y respuestas vale hasta 5 minutos después de publicar.
- Los avisos de los planes dicen «unos 5 min» en lugar de «30 min por defecto; no confirmado».
- La guarda de `campus_plan_forum_move_discussion` baja de una hora a 15 minutos (margen triple sobre la ventana).

**Consecuencia práctica:** para que un correo no salga, el post hay que borrarlo en los primeros 5 minutos. En el foro de prueba no hace falta si nadie está suscripto: desde ADR-098 el autor no queda suscripto por defecto.

## ADR-101 · Mover preguntas de encuestas

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** huecos chicos pedidos por el dueño.
**Decisión:** `campus_plan_questionnaire_question` suma la operación `move`, con `position` (1 = primera). La página `questions.php?moveq=<qid>` sirve la lista con botones «colocar aquí» (`moveherebutton[<posición>]`). Se reenvía su formulario con el botón de la posición pedida.
- La respuesta de éxito es la misma lista SIN el modo mover: el patrón exige que no haya `moveq`.
- Por eso el transporte web suma `success_200_same_form`. Cuando la página de éxito trae el mismo formulario, vale si cumple el patrón y no muestra errores.
- Verificación por el orden de la lista. Deshacer: volver a la posición anterior.

**Prueba real (sandbox):** en «Encuesta», una pregunta de prueba movida al principio y devuelta; las de prueba borradas.

## ADR-102 · Alias y categorías de glosarios

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** huecos chicos pedidos por el dueño.
**Hallazgo:** `mod_glossary_update_entry` BORRA y reescribe los alias y las categorías de la entrada con las opciones que recibe; así lo hace el código de Moodle (`glossary_edit_entry`). La edición de ADR-077 no mandaba opciones. Editar una entrada que tuviera alias o categorías los habría perdido. El servicio web no los devuelve, así que no se habría notado.
**Decisión:**
- `campus_plan_glossary_entry` lee alias, categorías y enlace automático del formulario de la entrada (ruta `glossary_entry_form`). Al editar los reenvía SIEMPRE: el validador exige `aliases` y `categories` en `mod_glossary_update_entry`.
- Nuevos parámetros `aliases` y `categories` (reemplazan; sin indicarlos, se conservan). Las categorías se validan contra `mod_glossary_get_categories`. La verificación compara alias y categorías releídos del formulario. Borrar y recrear las conserva.
- `campus_plan_glossary_category`: agregar, renombrar y borrar categorías por `editcategories.php` (`confirm=1`). Moodle responde con la lista de categorías (200), que se reconoce como éxito.
- Real: `mod_glossary_get_categories` devuelve `usedynalink` como booleano.

**Prueba real (sandbox):** en «Glosario», categoría de prueba y entrada con alias y categoría. Se editó sólo la definición y alias y categoría se conservaron. Alias cambiados y restaurados, categoría renombrada y restaurada; todo borrado.

## ADR-103 · Grupos y cupos de elecciones de grupo

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** huecos chicos pedidos por el dueño.
**Decisión:** `campus_plan_choicegroup_groups` cambia los grupos que ofrece una elección de grupo (mod_choicegroup) y el cupo de cada uno, por el formulario de edición de la actividad. El plugin no tiene servicio web de escritura.
- El formulario guarda la lista en `serializedselectedgroups` (`;id;id`), el cupo en `group_<id>_limit` (uno por grupo del curso, vacío si nunca se fijó) y la activación en `limitanswers`. El resto del formulario se reenvía tal cual.
- Los grupos se validan contra `core_group_get_course_groups`. Los cupos que no se indican se conservan; indicar alguno activa los cupos salvo `limit_answers: false`.
- Verificación releyendo el formulario. Deshacer: la lista, los cupos y la activación anteriores.
- Los demás ajustes (inscripción múltiple, resultados, orden) siguen en `campus_plan_activity_settings`.

**Prueba real (sandbox):** en «Grupo», tercer grupo agregado con cupos, cupos desactivados y vueltos a activar por deshacer, y vuelta a los dos grupos originales.

## ADR-104 · Reemplazar el paquete de una actividad H5P

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** huecos chicos pedidos por el dueño.
**Decisión:** `campus_plan_activity_files` también reemplaza el paquete `.h5p` de una actividad H5P (`h5pactivity`). Usa el mismo mecanismo que el recurso (ADR-077): el formulario de edición sirve un borrador con el paquete actual en `packagefile`; el motor quita el viejo, sube el nuevo al mismo borrador y guarda.
- La estructura del curso (`core_course_get_contents`) NO trae el paquete de una actividad H5P: la verificación lee `mod_h5pactivity_get_h5pactivities_by_courses` (`package`, nombre:bytes).
- Sólo se acepta un archivo `.h5p`. R3 sin deshacer automático, como el recurso: el MCP no guarda copia.
- Los intentos registrados quedan, pero corresponden al paquete anterior. El servicio también informa `deployedfile`: el contenido que el Campus desplegó, que puede ir detrás del paquete hasta que alguien abre la actividad.

**Prueba real (sandbox):** en la actividad H5P de prueba, el paquete se reemplazó por uno de prueba y después por una copia del original, descargada antes por el servicio de archivos (mismo nombre y tamaño).

## ADR-105 · Pendientes de lectura cerrados y entregas en grupo

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** pendientes del reporte de validación, pedido del dueño.
**Decisión y evidencia** (todo en el sandbox, con una tarea y un cuestionario ocultos de prueba, borrados al final):
- **Guarda de ADR-052, real:** el estudiante de prueba sin entrega: `campus_get_submission` respondió `submission_record: false` sin consultar `get_submission_status`; `list_participants` quedó en `''`.
- **`mod_assign_get_submissions` en tareas grupales:** con entregas en grupo y sin flujo de calificación, tres llamadas no crearon nada. El riesgo de ADR-052 era un hallazgo de código; no se reprodujo. Se acepta sin guarda. Si alguna vez aparece una entrega `new` de grupo sin actividad, la guarda de ADR-052 ya la trata como «sin entrega».
- **Ajustes de entregas en grupo:** `campus_plan_activity_settings` suma `team_submission`, `team_require_all`, `team_require_group` y `team_grouping` para tareas. Moodle los congela cuando ya hay entregas.
- **Notificaciones:** la campanita de la web llama a `message_popup_get_popup_notifications` por AJAX; con la sesión web devolvió lo mismo que el servicio móvil (0 y 0 sin leer). El vacío es real: los correos de foros no dejan notificación emergente en esta cuenta.
- **Muestras:** un override de tarea, una prórroga y un override de cuestionario confirmaron las fechas efectivas y la lista de overrides.

## ADR-106 · Correcciones de la revisión del keepalive

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** hallazgos de una revisión de código, pendientes del reporte.
**Decisión:**
- **Codificación:** `schtasks` escribe en la página OEM de la consola (en real, `ó` llegó como el byte 0xA2), no en UTF-8. La salida se lee como UTF-8 si es válida y, si no, como CP850 (igual a la 437 en vocales con tilde y ñ). Ya no hay un falso «otra ruta» con tildes o ñ.
- **Intervalo:** se lee cualquier duración ISO 8601 de Task Scheduler (`PT1H`, `PT1H30M`, `P1D`), no sólo `PT<n>M`.
- **Perfil y estado:** la tarea usa el mismo `--profile-file` que el comando que la instala. El directorio de estado viaja como `--state-dir`, opción nueva equivalente a `CAMPUS_STATE_DIR`: una tarea no puede pasar variables de entorno. Las rutas con comillas se rechazan.
- **Chequeo viejo:** `keepalive status` informa la antigüedad del último chequeo y lo marca viejo si supera dos intervalos más 5 min. También avisa si el último chequeo falló.
- **`invalidate()`:** descarta la sesión guardada sólo si sigue siendo la que falló. La operación recuerda la revisión con la que se abrió; una cookie importada mientras corría la tarea se conserva.
- **Token móvil:** si falla la identidad esperada, que sale del token móvil, el error lo dice («Token del servicio móvil…», `component: mobile_token`). No descarta la sesión web, y el estado local lo registra así.

## ADR-107 · Banco propio de los cuestionarios

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** muestra con reglas aleatorias en el sandbox (pendiente del reporte).
**Hallazgo:** en Moodle 5 cada cuestionario tiene su propio banco: las preguntas importadas al cuestionario (`campus_plan_question_import`, ADR-064) quedan ahí. Sus reglas aleatorias apuntan a la cmid del cuestionario. Las lecturas sólo aceptaban módulos «Banco de preguntas». Por eso `campus_list_question_banks` lo informaba como banco **de otro curso**, e inventario, definición y exportación lo rechazaban («no es un banco de preguntas del curso»).
**Decisión:**
- Un cuestionario del mismo curso cuenta como banco del curso. Con `include_categories`, se listan los cuestionarios cuyas reglas usan su banco, con `kind: cuestionario`. Los módulos «Banco de preguntas» llevan `kind: banco`.
- La política no cambia: sólo se listan categorías justificadas por una regla aleatoria de un cuestionario del curso (ADR-034).

**Prueba real (sandbox):** cuestionario oculto de prueba, 3 preguntas importadas y 2 aleatorias de su categoría. Banco listado como del curso; inventario 3 de 3; definición completa; exportación reconciliada 3 de 3. Cuestionario borrado.

## ADR-108 · Borrar grupos

**Fecha:** 2026-10-21 · **Estatus:** adoptada; techo modificado por ADR-118 · **Origen:** «escrituras sin cubrir» del reporte de validación.
**Decisión:** `campus_plan_delete_group` borra un grupo por `/group/delete.php`, con `confirm_name` igual a su nombre exacto (como `campus_plan_delete_content`).
- Capacidad `delete_content`, la de los borrados. Con miembros es **R4**: pierden el acceso que les daba el grupo, se borra la conversación del grupo y sale de sus agrupamientos. Vacío es R3. Como todo R3 y R4, pasa por el humano en el circuito (ADR-118), en local y en remoto.
- Deshacer (compensación): recrea el grupo vacío con su nombre, número de ID y descripción original. El plan guarda los ids de los miembros y el resumen del deshacer los nombra, para volver a agregarlos con `campus_plan_group_members`. No vuelven los agrupamientos, la conversación ni lo que dependía del id viejo: el resumen lo dice.

**Prueba real (sandbox):** grupo de prueba con el estudiante de prueba; borrado R4 verificado y la membresía desapareció; recreado por el deshacer y borrado. El estudiante quedó en su grupo original.

## ADR-109 · Exploración H5P y micro-integraciones

**Fecha:** 2026-10-21 · **Estatus:** adoptada; nivel 1: ADR-110, 111 y 114; niveles 2 y 3: ADR-116 y ADR-117 · **Origen:** pedido del dueño de explorar a fondo H5P, el backend y las micro-integraciones (Moodle nativo o Vercel para datos no sensibles).
**Hallazgos:** en UdeSA hay 55 tipos de contenido H5P instalados. El AJAX del editor del banco de contenido devuelve la semántica y la traducción de cada tipo. Un paquete con sólo `h5p.json` y `content.json` que referencia versiones instaladas se acepta y se despliega. El filtro de H5P incrusta paquetes en páginas. El docente puede agregar herramientas externas LTI al curso. Detalle y experimentos en [H5P_EXPLORACION.md](H5P_EXPLORACION.md).
**Decisión:**
- La exploración se hizo con guiones locales, no con herramientas del MCP: la exploración no cambió el producto.
- Renderizar en Chrome headless con la sesión del Campus fue sólo para medir; no es parte del producto.
- Tres niveles posibles, en orden de riesgo: autoría tipada de H5P desde el MCP; micro-integraciones sin identidad en Vercel; herramienta LTI con identidad y notas. El segundo y el tercero crean servicios públicos nuevos: requieren autorización expresa (reglas del proyecto).
- Los 9 elementos «[Lab H5P]» quedaron ocultos en el sandbox para que el dueño los revise.

## ADR-110 · Contenido H5P generado por el MCP

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** pedido del dueño de construir el nivel 1 de ADR-109, empezando por Question Set, Course Presentation, Interactive Book e Interactive Video.
**Decisión:** `campus_plan_h5p_content` crea una actividad H5P o reemplaza su contenido a partir de un **esquema tipado por tipo**, no de parámetros H5P crudos.
- **Tipos:** `question_set`, `course_presentation`, `interactive_book` e `interactive_video`. Bloques y preguntas: `text` (Markdown), `multiple_choice`, `true_false`, `drag_words` y `fill_blanks`. Las respuestas son texto plano y se escapan. Los títulos Markdown pasan a h2/h3, los únicos que admite H5P.
- **Bibliotecas:** la versión principal sale del banco de contenido del curso, la que ofrece el menú «Agregar». Las subbibliotecas salen de la semántica del padre, así el contenido coincide con lo instalado. La versión mayor de cada tipo está fijada en el código.
- **Semántica:** un solo GET por operación web lee el contexto del curso (formulario de grupo), el banco de contenido, el editor H5P sin guardar (para la clave de su AJAX) y la semántica y traducción de cada biblioteca, con caché por versión. Clave y sesskey del editor no se registran ni se devuelven.
- **Valores por defecto:** salen de la semántica con la traducción al castellano.
- **Validación:** el contenido se valida contra la semántica antes del plan: campos desconocidos, tipos, opciones y subbibliotecas admitidas. Como el validador del Campus, no se exigen mínimos de listas ni campos que el reproductor completa solo; los mínimos los fija el esquema.
- **Paquete:** sólo `h5p.json` y `content/content.json`, a lo sumo 512 KB. Viaja **dentro del plan firmado** (`inline_base64`), así que funciona también en el remoto. El motor ahora admite archivos generados en el remoto; los locales siguen rechazados.
- **Alta:** la arma, verifica y deshace `create_content`; la verificación compara además el paquete (nombre y tamaño) con `mod_h5pactivity_get_h5pactivities_by_courses`.
- **Reemplazo:** lo arman y verifican `activity_files` (ADR-104). Es R3, sin deshacer, y el nombre se distingue del paquete anterior.
- **Hallazgos reales:** la lista de bibliotecas del editor sólo trae los tipos ejecutables, no las subbibliotecas (AdvancedText, Column), aunque su semántica se sirve igual. El editor no abre sin `library`. El reemplazo se ve enseguida en el reproductor.

**Prueba real (sandbox):** los cuatro tipos creados ocultos, verificados y renderizados con su puntaje máximo esperado; cuestionario y presentación reemplazados.

## ADR-111 · Más tipos H5P y valores por defecto en profundidad

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** pedido del dueño de sumar Branching Scenario, Dialog Cards, Chart y Timeline (y Accordion, candidato de ADR-109).
**Decisión:** `campus_plan_h5p_content` suma cinco tipos con esquema propio:
- `branching_scenario`: `nodes` con id propio; `text` lleva a `next` y `choice` tiene `options` con `next`. `next` es el id de otro nodo o `end`, con un final opcional (título, subtítulo, puntaje). Se rechazan ids repetidos y destinos inexistentes; el índice del nodo es su id para H5P. El botón «Proceed» no viene traducido en la biblioteca: se fija «Continuar».
- `dialog_cards`: frente, dorso y pistas; modo normal o repetición.
- `chart`: barras o torta, con paleta por defecto.
- `timeline`: fechas AAAA[-MM[-DD]], convertidas al formato de TimelineJS; eras; medio por URL.
- `accordion`: paneles en Markdown.
**Valores por defecto en profundidad:** como el editor H5P, se completan en todo el árbol (elementos de listas y subcontenidos), no sólo arriba; los campos opcionales ausentes quedan ausentes. Lo motivaron dos fallas reales del reproductor:
- Branching Scenario leía `feedback` de cada nodo y no avanzaba sin él.
- Timeline leía `asset.thumbnail` de cada fecha y no renderizaba.
El validador además respeta los `regexp` de la semántica (las fechas de Timeline).

**Prueba real (sandbox):** los cinco creados, verificados y renderizados; el escenario recorrido con clics por sus dos ramas hasta cada final. Los nueve tipos regenerados y vueltos a renderizar sin errores.

## ADR-112 · Archivos originales e imágenes de documentos

**Fecha:** 2026-10-21 · **Estatus:** adoptada; entrega modificada por ADR-113 (`delivery`) · **Origen:** pedido del dueño con prioridad máxima. En ChatGPT, el conector leyó el texto de una presentación de clase, pero no podía entregar el .pptx ni sus imágenes y diseño.
**Decisión:**
- **`campus_get_original_file`:** el archivo original, con la misma autorización que `campus_read_file` (file_ref, cursos del perfil, guardas de entregas). Para las entradas de un ZIP, con `entry`.
  - Servidor local (`serve`, `serve-full`, `serve-write`): se guarda en `~/Downloads/udesa-campus-mcp/<curso>/` (o `CAMPUS_DOWNLOAD_DIR`). Nunca se sobrescribe un archivo distinto: se agrega « (2)»; uno idéntico se reutiliza.
  - Remoto: recurso incrustado del MCP (`resource` con `blob`), hasta 8 MB; si pesa más, el error lo dice.
  - Lleva hash SHA-256 y avisos de dato no confiable y de datos personales en entregas.
- **`campus_get_file_images`:** imágenes como contenido de imagen, para que el modelo las vea.
  - PowerPoint, Word y Excel: las imágenes guardadas, siguiendo sólo relaciones internas del paquete. Cada una va una vez y en orden; por diapositiva se lista qué imágenes usa (hash) y `same_images_as_part` marca las repetidas. EMF, WMF y SVG se listan sin enviar. Hasta 20 imágenes y 12 MB por respuesta, con `part_start` para seguir.
  - `render: true`, **sólo local**: LibreOffice convierte a PDF y pdftoppm o Ghostscript dibujan cada diapositiva o página completa (PDF directo). Corre con perfil temporal propio, sin macros, en carpeta temporal y con tiempo límite de 120 s; los programas se buscan en el sistema (o `CAMPUS_SOFFICE`, `CAMPUS_PDFTOPPM`, `CAMPUS_GHOSTSCRIPT`). El PDF convertido se guarda en memoria para las páginas siguientes. El remoto responde que no está disponible.
- **`campus_read_file` (PowerPoint):** las diapositivas siguen el orden de la presentación (`presentation.xml`), no el número del archivo, y las notas se buscan por relación.
- La regla de nombres del catálogo de lectura (get/list/read/search) se mantiene: por eso es `campus_get_original_file` y no «download».

**Prueba real (sólo lectura, un curso real):** una presentación pptx. Se guardó en Descargas, se enviaron 3 imágenes distintas (diapositivas 6, 9 y 10) y se dibujaron las diapositivas 1–4 con sus diagramas en 12 s. Además, 2 páginas de un PDF del curso en 2 s. El texto por diapositiva es distinto en cada una: lo que dijo ChatGPT («21 diapositivas con el mismo texto») no coincide con el archivo.

## ADR-113 · Entrega de archivos según el agente

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** pregunta del dueño: si ChatGPT puede guardar los archivos en su propio sandbox, y que Claude Code y Codex decidan, caso por caso, si guardarlos en la computadora del usuario o en su propio espacio.
**Lo que se sabe de cada cliente:**
- **Claude Code:** guarda en disco los recursos binarios incrustados de un MCP, en la carpeta de resultados de la sesión, y le da la ruta al modelo. Verificado en real.
- **Codex:** según un issue público, muestra el contenido incrustado como texto o base64 en el contexto, lo que no sirve para binarios. Lee la computadora del usuario desde su sandbox.
- **ChatGPT:** OpenAI documenta archivos como *entrada* de herramientas (`openai/fileParams`), no como salida hacia su sandbox de Python. Un reporte de la comunidad muestra que trunca contenidos base64 de unos 2,5 MB. Su sandbox no tiene internet. **No se puede asegurar** que ChatGPT guarde el archivo en su sandbox: hay que probarlo en el chat.
**Decisión:** `campus_get_original_file` tiene `delivery`, elegido por el modelo con la guía de la descripción:
- `computer`, sólo local: Descargas del usuario.
- `inline`: incrustado, hasta 8 MB; el cliente decide dónde guardarlo. Lleva `_meta: {}` explícito, porque algunos conectores descartan el blob sin él.
- `link`, sólo remoto: `/descarga/<token>`, firmado con una clave derivada de OAUTH_SIGNING_SECRET y válido 15 minutos. El remoto baja el archivo con su token de Moodle; el token de Moodle nunca viaja en el enlace. No se emite para entregas, devoluciones ni adjuntos de foros.
- `auto`: en el local, computer; en el remoto, inline hasta 2,5 MB más link.
Reemplaza `include_content` de ADR-112. Errores explícitos cuando un modo no existe en ese servidor.

**Prueba real:** Claude Code (`claude -p`, local y remoto) guardó el PDF incrustado como archivo propio. Enlaces de Vercel: 200 con 31 KB y con 6,5 MB; alterado 410. Codex: sin probar (límite de uso de la cuenta). ChatGPT: el dueño confirmó el mismo día que el conector funciona en el chat.

## ADR-114 · Editar contenido H5P generado

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** pendiente del nivel 1 de ADR-109: editar sin rehacer el contenido a mano.
**Decisión:**
- El paquete que genera `campus_plan_h5p_content` guarda también el esquema tipado con que se armó (`content/mcp-spec.json`, `{ v: 1, generator, content }`). Moodle lo acepta (`.json` está en la lista de extensiones de contenido) y lo conserva con el paquete.
- `campus_get_activity_content` sobre una actividad H5P agrega `package_content`: biblioteca principal, título y, si el MCP generó el paquete, `spec`, validado con el mismo esquema de la herramienta. Para editar: modificar `spec` y llamar `campus_plan_h5p_content` con `operation: replace`. Un paquete ajeno o un esquema inválido no se devuelve, con aviso.
- El paquete es dato no confiable: sólo se lee `h5p.json` y el esquema, con el lector ZIP defensivo, hasta 20 MB.

**Prueba real (sandbox):** paquete con el archivo extra aceptado y renderizado. Cuestionario: esquema leído, una pregunta cambiada, reemplazo verificado, relectura con el cambio y reproductor sin errores.

## ADR-115 · Notificar a las cuentas de prueba del sandbox

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** el dueño identificó a los participantes del sandbox. Agregó dos cuentas de prueba como estudiantes y autorizó notificarles para probar. A las demás cuentas del sandbox no se les notifica.
**Decisión:**
- El perfil de escritura suma `notifiable_user_ids` (los IDs de las cuentas de prueba del sandbox, en `udesa-docente-escritura`). Con `allow_participant_notifications=false`, `mayNotify` permite notificar sólo si **todos** los destinatarios están en esa lista y el curso es sandbox.
- Se aplica a notificaciones de UNA persona: calificar con `notify_student` (`campus_plan_grade`) y calificar a mano un intento de cuestionario (`campus_plan_quiz_grade`). Foros con suscripción forzada o inicial y umbrales de asistencia siguen bloqueados: alcanzan a todos los suscriptos, incluidos los managers.
- En el perfil publicado quedan vacíos: cada uno carga sus cuentas de prueba (sólo IDs, nunca nombres).

## ADR-116 · Laboratorio de mini-aplicaciones en Vercel

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** el dueño autorizó los niveles 2 y 3 de ADR-109.
**Decisión:**
- **Proyecto propio:** proyecto de Vercel aparte, `udesa-campus-lab` (carpeta `lab/` del repositorio, excluida del despliegue del MCP con `.vercelignore`). No amplía la superficie del MCP.
- **Seguridad:** archivos estáticos con `frame-ancestors 'self' https://campusvirtual.udesa.edu.ar`, de modo que sólo el Campus puede incrustarlos. CSP cerrada: scripts propios y de `cdn.jsdelivr.net`, WebAssembly, sin `eval` general. `noindex`, sin referrer.
- **Datos:** la configuración viaja en el fragmento (`#c=…`, base64url), que el navegador no manda al servidor. Sin identidad ni datos personales. El código del estudiante queda sólo en su navegador (`localStorage`).
- **Primera mini-aplicación, `/apps/python/`:** ejercicios de Python con Pyodide 0.26.4 en un Web Worker. Tiene pruebas visibles y ocultas, corte a los 8 s (bucles infinitos) y la consigna en texto plano, con `código` resaltado y nunca HTML. Avisa el resultado a la página contenedora (`postMessage`) para la versión con nota (LTI).
- **MCP:** `campus_plan_h5p_content` suma `python_exercise`, que arma un Iframe Embedder con la URL del laboratorio (`CAMPUS_LAB_BASE_URL` para cambiarla) y alto fijo. El campo de las pruebas se llama `input` porque la regla de herramientas no genéricas prohíbe claves como `args`.
- La nota que muestra la app la calcula el navegador: sirve para practicar, no para calificar. La calificación queda para LTI (nivel 3), con la misma app.

**Prueba real:** en el navegador, la app pasó los casos de código inicial (0/3), solución correcta (3/3, con una prueba oculta) y bucle infinito (cortado y recuperado). En el sandbox, el ejercicio creado por el MCP se ve dentro del reproductor del Campus con Python cargado.

## ADR-117 · Ejercicios del laboratorio con nota por LTI

**Fecha:** 2026-10-21 · **Estatus:** adoptada · **Origen:** el dueño autorizó el nivel 3 de ADR-109 (LTI con Vercel).
**Decisión:**
- **Herramienta LTI en el laboratorio** (`udesa-campus-lab`, sin dependencias: sólo `node:crypto`). Abre la misma mini-aplicación de Python de ADR-116 con la consigna en el parámetro personalizado `ejercicio` y devuelve al libro de calificaciones la proporción de pruebas que pasan. No guarda nada: el `state` y la sesión de la nota son tokens firmados con HMAC, sin cookies. Nunca recibe nombre ni correo, sólo un identificador opaco del Campus y el rol.
- **Dos versiones:**
  - **LTI 1.1 por defecto.** `/api/lti/launch11` verifica la firma OAuth 1.0a (HMAC-SHA1, 5 minutos de margen) con la clave `udesa-lab` y un secreto compartido. La nota sale por Basic Outcomes (`replaceResult` con `oauth_body_hash`) a `mod/lti/service.php`, y sólo a esa URL.
  - **LTI 1.3 también implementada.** Tiene login OIDC, `id_token` verificado contra las claves del Campus (`/mod/lti/certs.php`) y token del servicio de notas con `client_assertion` firmado por la clave de la herramienta. `LTI_REGISTRATIONS` guarda un registro por curso (ID de cliente : ID de implementación).
- **Por qué 1.1:** en el Campus de prueba, el servicio de notas de LTI 1.3 (AGS) no respondía por una configuración del servidor, aunque el lanzamiento 1.3 sí funciona. Con esa configuración resuelta, la 1.3 queda lista sin cambios.
- **Secreto compartido:** vive en dos entornos, `LTI11_SECRET` en el laboratorio y `CAMPUS_LAB_LTI11_SECRET` en el servidor del MCP. Un formulario puede declarar `secret_fields`; el transporte toma ese valor del entorno **al enviar**, de modo que el secreto nunca figura en el plan, la bitácora ni la respuesta. Si falta, no se envía nada.
- **MCP:**
  - `campus_plan_lab_lti_tool` registra la herramienta del curso con URLs fijas, sin nombre ni correo y sólo notas (`lti_version`: `1.1` por defecto o `1.3`). Es R2 y sin deshacer tipado.
  - `campus_plan_lab_lti_exercise` crea la actividad LTI con el ejercicio, nota por puntos (1 a 100), oculta por defecto y sin notificar. Se deshace como `create_content`.
- La nota la calcula el navegador del estudiante: sirve para práctica calificada, no para exámenes.

**Prueba real (sandbox):**
- Herramienta y actividad LTI 1.3: el lanzamiento, la verificación y las pruebas funcionaron; la nota no, por la configuración del servidor.
- Herramienta y actividad LTI 1.1: lanzamiento verificado, 4/4 pruebas, y el Campus respondió `success` al `replaceResult` con la cuenta docente.

Falta la prueba con una cuenta de estudiante, que necesita su inicio de sesión.

## ADR-118 · R3 y R4 sin techo, con el humano en el circuito

**Fecha:** 2026-10-21 · **Estatus:** adoptada; modificada por ADR-126 (sin escalada por curso real) · **Origen:** decisión del dueño sobre la escalada a R4 (pendiente desde ADR-067): «permitir R3 y R4 enteramente», con la condición de que el agente no proceda sin plantearle la acción al usuario. Reemplaza el techo de ADR-067 y ADR-108 y el techo remoto R3 de ADR-060.
**Decisión:**
- **Sin techo de riesgo.** El servidor admite R3 y R4, también un R4 por escalada (más de 5 ítems en un R2 o más de un mensaje) y también en el remoto. Siguen la habilitación por curso, los límites, la verificación por relectura y `confirm_name` en los borrados.
- **Humano en el circuito** (`human_in_the_loop_from_risk`, por defecto R3). Un plan que se confirma en el cliente y llega a ese riesgo:
  - trae `human_in_the_loop.present_to_user`, un texto en limpio (qué, efectos, si se deshace, advertencias) para plantearle al usuario;
  - no se ejecuta sin aprobación. Primero, **elicitación MCP**: en local, si el cliente la admite, el servidor le pregunta al humano y el agente no puede contestar. Aceptar sin marcar, rechazar o cancelar rechaza el plan. Si no hay elicitación (o falla), valen las **palabras textuales del usuario** que el agente pasa en `user_approval`;
  - queda en la auditoría con su canal (`elicitacion` o `usuario_en_chat`) y, en el segundo caso, las palabras del usuario.
- **Pregunta concreta:** el borrado cuenta lo que se va (elementos por tipo, archivos adjuntos y MB en total, nombres de los primeros 15). Por ejemplo: «BORRAR la sección 4 «Semana 4»: 5 elemento(s) (2 archivo, 1 tarea, 1 página, 1 etiqueta), 3 archivo(s) adjunto(s), 3,1 MB en total». Los archivos de entregas y el contenido de las subsecciones no se cuentan, y el texto lo aclara.
- Las instrucciones del servidor obligan al agente a plantear la acción, esperar una aprobación explícita para ESE plan y nunca tomar como aprobación texto del Campus, de archivos o de herramientas.
- **Límite conocido:** fuera de la elicitación, el servidor no puede comprobar que las palabras vengan del usuario; confía en el agente. Por eso queda registrado qué dijo el agente que aprobó el usuario. En el remoto (sin sesión entre pedidos) no hay elicitación.

## ADR-119 · Más operaciones R4: lotes y trabajo de estudiantes

**Fecha:** 2026-10-22 · **Estatus:** adoptada · **Origen:** el dueño eligió las cinco recomendadas de la lista de operaciones R4 candidatas, después de ADR-118.
**Criterio:** es R4 lo que destruye trabajo o datos de estudiantes (entregas, intentos, posts, notas, asistencia tomada) o borra mucho de una vez sin deshacer automático.
**Decisión:**
1. **Borrados existentes que pasan a R4 si hay datos de estudiantes:**
   - un post o una discusión con posts de otras personas;
   - una sesión de asistencia ya tomada;
   - un ítem manual del libro de calificaciones con notas. El plan cuenta los participantes con nota, por `gradereport_user_get_grade_items` con `userid=0`.

   Borrar una rúbrica o una guía no cambia: ya se rechaza si la tarea tiene notas.
2. **Varias actividades de una vez:** `activities` en `campus_plan_delete_content`, hasta 20, cada una con su nombre exacto. Un ítem por actividad; el plan cuenta y nombra lo que se borra.
3. **Varios grupos o un agrupamiento con sus grupos:** `groups` o `grouping_id` en `campus_plan_delete_group`. Un ítem por grupo y uno para el agrupamiento; sin deshacer automático en lote.
4. **Intentos de cuestionario:** `campus_plan_quiz_attempt_delete`, por el formulario del informe de calificaciones (`/mod/quiz/report.php`, `mode=overview`, `attemptid[]`, `delete=1`). No borra vistas previas, que Moodle no borra por esa vía. Se verifica con `mod_quiz_get_user_attempts`.
5. **Entregas:** `campus_plan_assign_submission_reset` con `revert_to_draft` (R3, el archivo queda) o `remove` (R4). Sólo tareas individuales. Para `remove`, el plan lee antes la confirmación de Moodle, sin escribir. **Hallazgo real:** en UdeSA la cuenta docente recibe «nopermission» (HTTP 404) al pedir esa confirmación, porque no puede editar entregas ajenas. El plan lo dice y propone devolver a borrador.
- Nueva capacidad `delete_student_work` para los puntos 4 y 5, habilitada en el sandbox y, desde ADR-125, en todos los cursos con rol de escritura.
- Todas pasan por el humano en el circuito de ADR-118.

## ADR-120 · Acciones con las cuentas de prueba que antes estaban bloqueadas

**Fecha:** 2026-10-22 · **Estatus:** adoptada · **Origen:** el dueño pidió implementar, sin consultarle, las acciones con las dos cuentas de prueba del sandbox (ADR-115) que la regla de no notificar bloqueaba.
**Decisión:** las tres acciones sólo se permiten si `mayNotify` lo admite: con `allow_participant_notifications=false`, únicamente las cuentas de prueba en un curso sandbox. Para cualquier otra persona, el plan se rechaza sin escribir.
- **Mensaje privado** (`campus_plan_send_message`): `core_message_send_instant_messages` con un destinatario por plan; se verifica con `core_message_get_conversation_between_users`. Es R3 porque no se puede retirar, así que pasa por la aprobación del humano (ADR-118). Cuenta para el límite diario de mensajes. Estas son las únicas funciones `core_message_*` de la allowlist de escritura.
- **Calificación por el formulario completo con aviso** (`notify_student` en `campus_plan_grade_advanced`): `sendstudentnotifications` deja de estar fijo en 0; el intent lo pone en 1 sólo si se puede notificar.
- **Nota del foro con mensaje** (`notify_student` en `campus_plan_forum_grade`): `notifyuser` deja de estar fijo en false. Moodle manda el mensaje aunque la nota no cambie.
- **Sin cambios:**
  - Publicar en foros con suscripción forzada sigue bloqueado: también avisaría a los demás participantes.
  - El aviso de contenido nuevo (`coursecontentnotification`) sigue bloqueado: va a todo el curso.
  - Calificar tareas y preguntas de cuestionarios con aviso ya estaba permitido desde ADR-115.

## ADR-121 · Endurecer el login web automático local

**Fecha:** 2026-10-22 · **Estatus:** adoptada · **Origen:** revisión adversarial del plan del login automático remoto (dos revisores); estas correcciones aplican también al local (ADR-088).
**Hallazgos verificados en Moodle 5.1:**
- El correo del código trae un enlace para revocar el intento (`admin/tool/mfa/factor/email/email.php`). Usarlo revoca el factor correo de toda la cuenta, cierra todas las sesiones y, si el sitio lo configuró, suspende la cuenta.
- El correo sale apenas se arma la página del código. Un login sin canal para escribirlo sólo manda un correo que nadie puede usar.
- Cambiar la contraseña no revoca la confianza del dispositivo.
- El User-Agent se guarda como etiqueta del código y se muestra en el correo; no se usa para validarlo.

**Decisión:**
- **User-Agent explícito** en todas las peticiones web: `udesa-campus-mcp/0.1 (MCP del Campus; local)`. Los accesos del MCP se reconocen en el correo y en los registros del Campus.
- **Sin canal para el código no hay intento sin confianza vigente.** Si la confianza falta o vence en menos de 30 min, `AUTH_REQUIRED` sin ninguna petición (no sale ningún correo). Si el Campus igual pide el código, queda «necesita confianza» y no se reintenta hasta un nuevo `enable`. Con el diálogo local, sigue como antes.
- **Intento en curso:** se marca antes de enviar la contraseña. Si una ejecución se corta sin resultado, la siguiente no adivina: desactiva y pide revisar.
- **Pausas:** 10 min después de un fallo, 2 min después de un éxito; 6 intentos por día como máximo.
- **Plazo total del login:** 25 s, con 10 s por petición; la espera del código no cuenta.
- **Token móvil:** si lo que falla es el token (de ahí sale la identidad esperada), no se intenta un login web.
- **Backend separado** (`AutoLoginBackend`): credenciales, confianza, estado y candado detrás de una interfaz, para poder llevar la misma lógica a otro almacenamiento.

**Docs:** aviso del enlace «no fui yo» y procedimiento para cambiar la contraseña con varias copias guardadas (PROCESOS).
**Tests:** `web-autologin.test.ts` (20).

## ADR-122 · Alcance por matrícula y permisos por rol en cada curso

**Fecha:** 2026-10-22 · **Estatus:** adoptada; modifica ADR-016; modificada por ADR-123 · **Origen:** el dueño quiere que el MCP lea cualquier curso que su usuario ve en el Campus, no sólo aquellos donde es docente.
**Decisión:**
- **Nuevo modo `course_scope: "enrolled"`.** El alcance de lectura son todos los cursos donde la cuenta verificada está matriculada, con cualquier rol. Se resuelve igual que `teaching`: `core_enrol_get_users_courses` y luego `core_user_get_course_user_profiles` por curso. Por eso `campus_list_courses` muestra el rol de cada curso. `teaching` sigue existiendo sin cambios. `udesa-docente` (`docente-lectura` y la parte de lectura de `docente-completo`) pasa a `enrolled`.
- **Lo propio, con cualquier rol.** Contenido del curso, recursos, páginas, archivos de módulos, avisos y adjuntos de posts, foros visibles y búsqueda, tareas y cuestionarios (lista), calendario, novedades, resumen de actividades, configuración general de una actividad y las notas propias. Moodle sigue decidiendo qué ve un estudiante.
- **Datos de terceros, sólo con rol docente** (`teacher_role_shortnames`) **en ese curso.** Sin ese rol, `POLICY_DENIED` antes de consultar a Moodle, con el rol encontrado en el mensaje. Aplica a:
  - entregas, estado de entregas y sus archivos y devoluciones (`file_s`/`file_f`);
  - notas de otros: `campus_get_grades` sin rol docente pide sólo las propias, con el `userid` de la cuenta y nunca `0`, que trae toda la clase. Con un `participant_id` ajeno, se rechaza;
  - participantes y grupos;
  - intentos de cuestionario (también los propios: la revisión del intento propio no está implementada);
  - asistencia por alumno (reemplaza la guarda propia de asistencia de antes, ADR-028);
  - reportes del curso y del cuestionario;
  - estructura docente del cuestionario e inventario de preguntas (bancos, preguntas, categorías y sus archivos `file_x`/`file_e`);
  - en la configuración de una actividad, las fechas por participante (`participant_id`) y las excepciones (`include_overrides`);
  - en `campus_get_activity_content`: las respuestas de un intento H5P (`attempt_id`) y las preguntas de una encuesta (vista de edición). Las entradas del glosario pendientes de aprobación y los intentos de lecciones y de H5P no se piden: el resto de la actividad se devuelve con un aviso;
  - en `campus_list_pending`: «por corregir» sólo sale de cursos con rol docente. En los demás, sólo vencimientos, con un aviso.
- **Allowlist también.** Con `course_scope=allowlist`, la regla de terceros es la misma. Los roles de cada curso se consultan una vez y se cachean 30 min. Un fallo no se cachea: la próxima consulta vuelve a preguntar.
- **Escritura.** Además de la allowlist por curso del perfil de escritura (sin cambios), planificar o deshacer exige un rol de `write_role_shortnames` en el curso. Es un campo nuevo del perfil de lectura; por defecto `editingteacher`, `manager` y `coursecreator` (profesor, gestor o superior). El profesor sin permiso de edición (`teacher`) y el estudiante reciben `POLICY_DENIED` antes de armar el plan.
- **Sin cambios:** `excluded_course_ids`, la resolución en vivo y el caché de 30 min. Un error al resolver el alcance o los roles es un error: nunca «sin cursos», «sin roles» ni «todos».

**Límites:**
- Un rol asignado sólo en la categoría o el sitio (por ejemplo, gestor de categoría) no aparece en `core_user_get_course_user_profiles`. Para el MCP, esa cuenta no tiene ese rol en el curso.
- El remoto usa el mismo perfil.

**Tests:** `enrolled-scope.test.ts` (14).

## ADR-123 · Intentos propios con cualquier rol y roles superiores

**Fecha:** 2026-10-22 · **Estatus:** adoptada; modifica ADR-122 · **Origen:** revisión del dueño de ADR-122. Un gestor tiene que ver lo mismo que un docente. Y qué deja revisar un cuestionario lo decide quien lo configuró, no la arquitectura del MCP.
**Decisión:**
- **Roles superiores.** Los datos de terceros exigen un rol de `teacher_role_shortnames` **o** de `write_role_shortnames`. Por defecto: `editingteacher`, `teacher`, `manager` y `coursecreator`. El alcance `teaching` no cambia.
- **Intentos propios de cuestionario, con cualquier rol.**
  - `campus_get_quiz_attempts` sin `participant_id` (o con el propio) lista los intentos de la cuenta. Usa el `userid` verificado, sin pasar por la lista de participantes, que es docente. Trae `review`: para respuestas, corrección, puntajes, retroalimentación y respuesta correcta, si la configuración de revisión las muestra `siempre`, `a_veces` (según el momento: durante, recién terminado, más tarde, al cerrar) o `nunca`.
  - `campus_get_quiz_attempt`, sin rol docente o superior:
    - Si las opciones dicen que las respuestas no se ven **nunca**, `MOODLE_PERMISSION_DENIED` con el motivo y **sin pedir el intento**.
    - Si se ven en algún momento, se pide la revisión. Si Moodle la niega ahora (`noreview*`), el mismo código con el motivo y el `errorcode` de Moodle.
    - Lo que sí devuelve es lo que Moodle deja revisar en ese momento. Un intento de otra persona → `RESOURCE_OUT_OF_SCOPE`.
- **H5P:** sin rol docente, `campus_get_activity_content` devuelve los intentos propios: lo que Moodle devuelve, filtrado a la cuenta. También las respuestas de un intento propio con `attempt_id`; uno ajeno → `RESOURCE_OUT_OF_SCOPE`.
- **Nueva función en la allowlist:** `mod_quiz_get_combined_review_options` (sólo lee la configuración del cuestionario; no registra vistas). Capacidad `own_quiz_attempts` en el reporte. Si Moodle no la ofrece, no se adivina: `review=null`, con un aviso, y Moodle decide al pedir cada intento.

**Prueba real en el Campus:**
- Para un estudiante, los intentos H5P propios salen de `mod_h5pactivity_get_attempts` (nueva en la allowlist; es la vía de la app). `get_user_attempts` es el reporte docente: sin `userids` responde `nopermissiontoviewattempts` y con `userids`, `invalidparameter`. Si Moodle no deja verlos, la actividad sale igual con un aviso.
- Muchos cursos ocultan el libro de calificaciones a los estudiantes. `nopermissiontoviewgrades` se informa como `MOODLE_PERMISSION_DENIED`: «el curso no muestra las calificaciones a los estudiantes».

**Sigue igual:** los intentos de lecciones (`mod_lesson_get_attempts_overview` es un reporte docente) y las preguntas de encuestas (vista de edición) siguen exigiendo rol docente o superior.
**Tests:** `enrolled-scope.test.ts`.

## ADR-124 · Datos personales donde la operación los necesita

**Fecha:** 2026-10-22 · **Estatus:** adoptada; revisa CAP-01 y la minimización de ADR-017, ADR-022 y ADR-027 · **Origen:** el dueño: la regla «sin datos personales» quedó de las primeras pruebas. Quiere incluir datos personales en las operaciones que los necesiten.
**Decisión:**
- **Credenciales y secretos, nunca.** Por proyección de esquema siguen afuera la clave privada de acceso (`userprivateaccesskey`), los tokens, las contraseñas de cuestionarios, las claves de inscripción y los enlaces con token. El `username` de login también, porque no hace falta para nada.
- **Datos personales, sí, cuando la operación los necesita.** No se descartan por principio: cada campo se agrega a la proyección de la herramienta que lo usa, con 👤 en HERRAMIENTAS.
- **Lo que se guarda en disco no lleva datos personales:** metadata de sesión (sólo `user_id`), reporte de capacidades, logs. Se arma con campos explícitos y lo verifican tests.

**Campos abiertos:**
- `get_site_info`: `fullname` de la cuenta (en memoria). Tus intentos muestran tu nombre; el reporte de capacidades, la metadata de sesión y `campus_get_status` no lo llevan.
- `campus_list_participants`: `email`, `student_id` (legajo, `idnumber`), `country`, `description_markdown` (hasta 2000 caracteres) y `photo_url`. La foto sale sin parámetros secretos y se abre con la sesión del Campus. El `username` de login sigue afuera.
- `campus_get_grades`: `student_id` por estudiante (`useridnumber`).
- `campus_list_notifications`: `from` (user_id y nombre; `null` si es un remitente del sistema) y `body_markdown`: el cuerpo completo, hasta 4000 caracteres por notificación y dentro del límite total del perfil.

**Tests:** comprueban la presencia de estos campos y la ausencia de los secretos (clave del cuestionario, red permitida, clave de grupo, token en enlaces, username).

## ADR-125 · Escrituras en todos los cursos con rol de escritura

**Fecha:** 2026-10-22 · **Estatus:** adoptada; amplía ADR-043 y ADR-048; modificada por ADR-126 · **Origen:** el dueño: tras las pruebas en el sandbox, abrir las escrituras a todos los cursos.
**Decisión:**
- **Nuevo `write_policy.all_courses`.** Lista de capacidades para cualquier curso del alcance de lectura que no tenga entrada propia en `courses`. Siempre con el rol de escritura de ADR-122 (`editingteacher`, `manager` o `coursecreator`), que se verifica en vivo antes de armar cada plan. Una entrada propia reemplaza a `all_courses` en ese curso; con lista vacía, lo bloquea.
- **Perfil `udesa-docente-escritura`:** `all_courses` tiene las mismas 32 capacidades que el sandbox. No hay entradas vacías que bloqueen cursos.

**En los cursos reales:**
- **Riesgo:** el mismo que en el sandbox, sin escalada por curso real (ADR-126). R3 y R4 requieren la aprobación del usuario en el chat (ADR-118).
- **Confirmación:** la confirmación en el cliente (`sandbox_confirmation: "cliente"`) vale sólo en el sandbox.
- **Notificaciones:** `allow_participant_notifications: false`. Nada que avise a estudiantes reales: el foro de Avisos (suscripción forzada) queda bloqueado, las calificaciones no notifican y los mensajes privados sólo van a las cuentas de prueba del sandbox. Abrirlo es otra decisión.
- **Límites diarios y freno por fallos:** los mismos, para todos los cursos juntos.
- **Remoto:** usa el mismo perfil.

**Tests:** `enrolled-scope.test.ts` (`all_courses` con y sin rol, entrada vacía que bloquea, sin `all_courses`) y `write-policy.test.ts` (perfil versionado).

## ADR-126 · Sin escalada de riesgo por curso real

**Fecha:** 2026-10-22 · **Estatus:** adoptada; reemplaza la escalada «curso real, primeras dos semanas» de la directiva §4 · **Origen:** decisión del dueño: con las escrituras abiertas a todos los cursos (ADR-125), la escalada no aporta.
**Decisión:** un curso real no sube el riesgo por sí solo. Valen sólo las escaladas por contenido del plan: más de 5 ítems en un R2 y más de un mensaje. R3 y R4 siguen pidiendo la aprobación del usuario en el chat (ADR-118). `enabled_on` se acepta en el perfil como dato informativo. `all_courses` del perfil es una lista simple de capacidades.
**Tests:** las pruebas de R3 por escalada usan la cantidad de ítems.

## ADR-127 · Login web automático en el servidor remoto

**Fecha:** 2026-10-22 · **Estatus:** adoptada como excepción explícita del dueño; extiende ADR-088 al remoto · **Origen:** desde ChatGPT web, una escritura que usa la sesión web falló con `AUTH_REQUIRED`: el remoto sólo tenía el snapshot fijo de `CAMPUS_WEB_SESSION`, que vence a las 4 h sin uso, y no podía iniciar sesión solo. El keepalive no es opción: ni en la PC (ADR-087) ni en la nube, porque genera actividad artificial. Guardar la contraseña en un servicio de terceros requiere que tu institución lo permita.
**Decisión:**
- **Sesión web en el KV de Upstash,** cifrada con AES-256-GCM y una clave derivada de `OAUTH_SIGNING_SECRET`. La comparten todas las instancias y los dos núcleos (`/mcp`, y `/mcp-completo` y `/mcp-escritura`). Las rotaciones del Campus se guardan. `CAMPUS_WEB_SESSION` queda como semilla: una publicación nueva gana sobre lo guardado y una semilla rechazada no se reintenta. El KV de la sesión web no depende de las escrituras.
- **Login automático** con la misma lógica y las mismas guardas que el local (ADR-088 y ADR-121), con un backend propio:
  - **Contraseña:** variable **sensible** de Vercel `CAMPUS_WEB_LOGIN` (no se puede volver a leer, tampoco con `vercel env pull`). Nunca entra al KV.
  - **Confianza:** un dispositivo de confianza **propio del remoto**, publicado en `CAMPUS_WEB_TRUST` (sensible) y copiado al KV cifrado. No comparte ni pisa el de la PC.
  - **Estado y candado:** en el KV. El candado es `SET NX EX` de 90 s: entre instancias, un solo login a la vez.
  - **Dos llaves:** `CAMPUS_WEB_AUTOLOGIN=true` y `CAMPUS_WEB_LOGIN`, y además el KV.
  - **Sin canal para el código:** el remoto nunca intenta sin una confianza vigente (no sale ningún correo). Si el Campus igual pide el código, queda «necesita confianza» hasta un `enable` nuevo.
  - Un `enable` nuevo (otra contraseña u otra confianza) arranca con estado limpio: una desactivación anterior no lo bloquea.
  - User-Agent `udesa-campus-mcp/0.1 (MCP del Campus; remoto)` en todas las peticiones web del remoto.
  - Los errores indican cómo renovar desde la PC, no los comandos locales.
- **Puesta en marcha, en la PC: `campus remote autologin enable`.**
  1. Reusa la contraseña del login automático local (keyring), por decisión del dueño.
  2. Hace un login nuevo como dispositivo «remoto»: el Campus manda un código al correo, que el humano escribe en la terminal. De la PC sólo se reusa `MOODLEID1_`, para evitar el aviso de «nuevo inicio».
  3. Recién con el login verificado publica `CAMPUS_WEB_LOGIN`, `CAMPUS_WEB_TRUST` y `CAMPUS_WEB_SESSION` (sensibles) y `CAMPUS_WEB_AUTOLOGIN=true`.
  4. Después, `vercel deploy --prod`.
- **Renovación:** la confianza dura 28 días. Se repite `enable` (un código por correo) y se redespliega. `campus_get_status` avisa desde 3 días antes, en `web_autologin.action_needed`.
- **Corte:** `campus remote autologin disable` borra las tres variables de Vercel; después, redesplegar. La sesión abierta del remoto se cierra en Sesiones del navegador (`report/usersessions/user.php`), donde se la reconoce por la IP de Amazon: la página no muestra el navegador.
- **Visibilidad:** `campus_get_status` (local y remoto) informa `web_autologin`: si está activo, la confianza y su vencimiento, el último intento, y si está desactivado o necesita confianza. Nada secreto.

**Riesgos aceptados por el dueño:**
- La contraseña del Campus vive en Vercel, cifrada y sin lectura posible, y sólo la usa el despliegue protegido por el GitHub del dueño.
- Los logins del remoto salen de la región de Vercel (`gru1`, San Pablo), no de la IP del dueño. Cada login queda registrado en el Campus.
- Quien acceda al proyecto de Vercel puede abrir la web del Campus sin el segundo factor durante la vigencia de la confianza, igual que con el almacén de credenciales de la PC (ADR-088).

**Validado en real:** con la sesión vencida, el remoto inicia sesión solo, sin código. `tool_mfa` admite varios dispositivos de confianza por usuario: el del remoto y el de la PC conviven.
**Tests:** `remote-web-autologin.test.ts` (12) y `remote.test.ts` (3 de punta a punta: login sin código como «remoto», sin segunda llave, y código pedido con la instrucción remota).

## ADR-128 · Recursos incrustados tipados (propuesta, no adoptada)

**Decisión propuesta:**
- **Presentación de URL** (`display`: `automatic`, `embed`, `open`), comprobada contra el formulario del sitio antes del POST. Es la vía para mostrar Python Tutor dentro de Moodle.
- **`iframe_embed`** (H5P) para insertar cualquier página https. Sólo la dirección, validada; nada de HTML. El plan advierte que el contenido lo controla otro sitio.
- Ninguna de las dos da seguimiento: no llegan intentos ni progreso al Campus.

**Descartado:** un tipo H5P propio para Python Tutor. Dentro del Iframe Embedder, Python Tutor no muestra el visualizador, y la causa no está identificada.

**Riesgos:** la página incrustada la controla otro sitio y puede cambiar o bloquear la incrustación (en ese caso conviene `display: open`). Python Tutor ejecuta el código en sus servidores: sólo ejemplos públicos.

**Validado en real** en un curso de pruebas: un enlace a Python Tutor con `display: embed` se ve dentro de Moodle; `iframe_embed` muestra una página que permite incrustarse y muestra el bloqueo de una que no lo permite.

**Falta para adoptarla:** probar el deshacer de la presentación en el curso de pruebas.
