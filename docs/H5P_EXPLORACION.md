# H5P y micro-integraciones

Qué permite H5P en el Campus de UdeSA para crear elementos de curso más allá de lo nativo de Moodle, y qué micro-integraciones con Moodle o con Vercel sirven para datos no sensibles. Lo probado se hizo en un curso de pruebas (sandbox), con contenido inventado. Decisión asociada: [ADR-109](DECISIONES.md#adr-109--exploración-h5p-y-micro-integraciones).

## Qué ofrece el Campus de UdeSA

| Hallazgo | Evidencia |
|---|---|
| **55 tipos de contenido H5P instalados** | Menú «Agregar» del banco de contenido del curso. Entre ellos: Course Presentation 1.27, Interactive Video 1.28, Interactive Book 1.15, Branching Scenario 1.11, Question Set 1.21, Game Map 1.5, Drag and Drop 1.15, Image Hotspots 1.11, Timeline 1.1, Chart 1.2, Dialog Cards 1.9, Iframe Embedder 1.0, Virtual Tour (360) 0.5, Personality Quiz 1.0, Crossword 0.5, Essay 1.5 y Summary 1.10 |
| **El editor expone la semántica de cada tipo** | El AJAX del editor del banco de contenido (`/h5p/ajax.php?action=libraries`) devuelve la semántica (campos, tipos, valores por defecto, subbibliotecas admitidas), los recursos y la **traducción al castellano**. Es una lectura: abrir el editor no guarda nada |
| **Paquetes sin bibliotecas** | Un `.h5p` con sólo `h5p.json` y `content/content.json` que referencia versiones instaladas se acepta y se despliega. El Campus completa las bibliotecas y sus dependencias. No hace falta el permiso de instalar bibliotecas |
| **Filtro de H5P activo** | Un enlace a un `.h5p` del Campus dentro de una página se convierte en un reproductor incrustado |
| **Herramientas externas LTI por curso** | La cuenta docente puede agregar una herramienta externa al curso («Añadir nueva herramienta externa LTI»), con LTI 1.3 o 1.0/1.1, aceptar calificaciones y enviar nombre y correo (opcionales). Así se registra la herramienta del laboratorio (ADR-117) |
| Resultados | `mod_h5pactivity` registra intentos y respuestas por pregunta de los estudiantes; el MCP los lee (ADR-090; los propios, con cualquier rol, ADR-123) |

## Tipos probados en el Campus

Paquetes generados a partir de la semántica (valores por defecto en castellano más el contenido indicado), subidos como actividades H5P ocultas y renderizados en Chrome headless con la sesión del Campus: se verificó que el reproductor inicializa, los errores de JavaScript y el puntaje máximo que informa cada instancia.

| Tipo | Resultado |
|---|---|
| Question Set con opción múltiple, verdadero/falso, arrastrar palabras y completar | Renderiza; puntaje máximo 6 (1 + 1 + 2 + 2) |
| Course Presentation: 3 diapositivas, una con pregunta | Renderiza; máximo 1 |
| Branching Scenario con una decisión y dos finales | Renderiza (pantalla de inicio) |
| Interactive Book: 2 capítulos con texto y preguntas | Renderiza con índice; máximo 2 |
| Dialog Cards | Renderiza |
| Iframe Embedder con un sitio externo | Renderiza el sitio dentro de la actividad |
| Interactive Video con un video de YouTube, 2 preguntas en tiempos dados, marcadores y resumen | Carga el video; máximo 3 |
| Chart de barras | Renderiza con los datos |
| Página con el enlace a un paquete | El filtro lo convierte en reproductor |

El único error de JavaScript es del redimensionador de `embed.php` cuando se abre fuera de `view.php`; no afecta al contenido. El generador completa los valores por defecto en todo el árbol de cada tipo, como el editor (ADR-111).

## Límites

- **Sólo tipos instalados.** Bibliotecas propias o versiones nuevas exigen que Campus Virtual las instale.
- **El seguimiento es de estudiantes.** El docente no genera intentos, así que el registro de puntajes de un paquete generado no está probado con un alumno. Es el mecanismo estándar de `mod_h5pactivity`.
- **El Iframe Embedder no lleva identidad ni puntajes.** La página incrustada no sabe quién la usa y sus eventos no llegan a Moodle. Sirve para contenido sin datos personales.
- **Incrustar en una página no registra intentos.** Además, si la actividad de origen está oculta, los estudiantes no podrían abrir el paquete (no probado con un alumno).
- **Videos de YouTube:** dependen de la disponibilidad del video y de que YouTube permita incrustarlo.

## Tres niveles de integración

1. **Autoría de H5P desde el MCP** ([ADR-110](DECISIONES.md#adr-110--contenido-h5p-generado-por-el-mcp) y [ADR-111](DECISIONES.md#adr-111--más-tipos-h5p-y-valores-por-defecto-en-profundidad)). `campus_plan_h5p_content` tiene un esquema tipado por tipo de contenido: cuestionario, presentación, libro, video interactivo, escenario ramificado, tarjetas, gráfico, línea de tiempo, acordeón y ejercicio de Python. Arma el paquete en el servidor, así que funciona también en el remoto, sin archivos locales. Lo valida contra la semántica del Campus y lo sube como actividad o reemplaza una existente. Para editar, `campus_get_activity_content` devuelve el esquema guardado en el paquete (ADR-114).
2. **Micro-integraciones sin identidad (Vercel)** ([ADR-116](DECISIONES.md#adr-116--laboratorio-de-mini-aplicaciones-en-vercel)). Páginas estáticas o mini-aplicaciones (simuladores, calculadoras, visualizaciones) incrustadas con el Iframe Embedder o en una página. Sólo para datos no sensibles: no reciben quién es el estudiante. La disponible es la de ejercicios de Python del laboratorio.
3. **Integración nativa con identidad y notas (LTI)** ([ADR-117](DECISIONES.md#adr-117--ejercicios-del-laboratorio-con-nota-por-lti)). La herramienta del laboratorio se registra en el curso con `campus_plan_lab_lti_tool` y cada ejercicio de Python es una actividad LTI (`campus_plan_lab_lti_exercise`). Recibe un identificador opaco del estudiante y su rol, nunca nombre ni correo, y devuelve la nota al libro de calificaciones. En el Campus de UdeSA la nota llega por LTI 1.1: la 1.3 abre el ejercicio, pero su servicio de notas no responde por la configuración del servidor.
