# Elementos del curso: qué se puede crear, editar y borrar

Para cada tipo de elemento, qué hace el MCP de escritura (perfil `docente-completo`) y con qué herramienta. Vale en cualquier curso donde tu rol es de profesor, gestor o superior (ADR-125). Cada tipo está validado en real en un curso de pruebas (sandbox), sobre un elemento de cada tipo (ADR-077).

**Valen para todos los tipos:**

| Operación | Herramienta |
|---|---|
| Renombrar | `campus_plan_rename` |
| Mostrar u ocultar | `campus_plan_visibility` |
| Mover de sección | `campus_plan_move_activity` |
| Duplicar, sin datos de usuarios (salvo Turnitin, LTI y subsecciones; ADR-082) | `campus_plan_duplicate_activity` |
| Ajustes por tipo, modo de grupos, agrupamiento y restricciones de acceso (ADR-082) | `campus_plan_activity_settings` |
| Borrar (papelera del curso, R4, `confirm_name`; una subsección se borra como sección, con `section_number`) | `campus_plan_delete_content` |

## Actividades y recursos

| Elemento | Tipo | Crear | Editar | Contenido interno |
|---|---|---|---|---|
| Foro | `forum` | Sí (`campus_plan_create_content`, ADR-070) | Descripción; ajustes (tipo, suscripción opcional o deshabilitada, adjuntos, bloqueo) | Avisos, respuestas, adjuntos, fijar y bloquear; moderación: borrar posts de cualquier autor y mover discusiones (ADR-094). **En Avisos no se publica:** su suscripción es forzada y notificaría a los participantes (`allow_participant_notifications: false`) |
| Asistencia | `attendance` | Sí (`campus_plan_create_attendance`) | Descripción; modo de grupos | Agregar, editar (fecha, horario, descripción; ADR-089) y borrar sesiones (ADR-084) y tomar asistencia |
| Asistencia por materia | `subjectattendance` | No (plugin propio de UdeSA) | Descripción | No |
| Archivo | `resource` | Sí (archivo local) | Descripción; reemplazar el archivo (`campus_plan_activity_files`, R3) | No aplica |
| Carpeta | `folder` | Sí, con archivos locales | Descripción; agregar o quitar archivos (`campus_plan_activity_files`) | No aplica |
| Página | `page` | Sí | Descripción y contenido | No aplica |
| Panopto (herramienta externa) | `lti` | No (requiere la herramienta externa configurada) | Descripción | No: el contenido vive en Panopto |
| Tarea | `assign` | Sí (`campus_plan_create_assignment`) | Descripción, nota máxima sin notas, fechas, excepciones, ajustes de entrega y retroalimentación | Calificar por puntos de a un participante; con escala, rúbrica o guía, archivos de retroalimentación y estado del flujo de trabajo (`campus_plan_grade_advanced`, ADR-095); rúbricas y guías (`campus_plan_grading_definition`); no anónimas ni en grupo, prórrogas, bloqueo y comentarios |
| Tarea de Turnitin | `turnitintooltwo` | No | **No.** Guardar su configuración la sincroniza con el servicio de Turnitin | No |
| URL | `url` | Sí | Dirección y descripción | No aplica |
| Etiqueta | `label` | Sí | Texto | No aplica |
| Base de datos | `data` | Sí (vacía; los campos se agregan con `campus_plan_data_field`) | Descripción; período para agregar entradas | Entradas: agregar, editar, borrar, aprobar y desaprobar (`campus_plan_data_entry`). Valores de todos los tipos de campo que se crean: texto, área de texto, número, URL, menú, opción, casillas, menú múltiple y fecha (ADR-083). Campos: agregar, editar y borrar (`campus_plan_data_field`, ADR-080) |
| H5P (plugin `hvp`) | `hvp` | No (requiere el editor H5P) | Descripción (el contenido H5P se reenvía intacto) | No |
| Elección de grupo | `choicegroup` | Sí, con los grupos del curso | Descripción; grupos ofrecidos y cupo por grupo (`campus_plan_choicegroup_groups`, ADR-103) | No |
| Cuestionario | `quiz` | Sí (`campus_plan_create_quiz`) | Descripción, fechas, excepciones, ajustes (método, navegación, comportamiento, opciones de revisión) | Preguntas (agregar y quitar, ADR-084), aleatorias y nota por pregunta; páginas y secciones (`campus_plan_quiz_layout`, ADR-091); editar y borrar excepciones existentes (ADR-099). Calificación manual: sólo intentos propios (vistas previas) o de las cuentas de prueba del sandbox, porque calificar a un estudiante lo notifica |
| Consulta | `choice` | Sí, con sus opciones | Descripción; opciones (`campus_plan_choice_options`); apertura y cierre | No aplica |
| Encuesta | `questionnaire` | Sí (vacía) | Descripción | Preguntas: se leen (id, tipo, nombre) y se agregan, editan, mueven y borran (`campus_plan_questionnaire_question`, ADR-097 y 101) |
| Glosario | `glossary` | Sí (secundario, vacío) | Descripción; ajustes (aprobación, duplicados, comentarios, formato) | Entradas: agregar, editar y borrar, con alias y categorías (`campus_plan_glossary_entry`); categorías del glosario (`campus_plan_glossary_category`, ADR-102). Entradas pendientes: se leen (`campus_get_activity_content`) y se aprueban o desaprueban (ADR-089; aprobar puede avisar al autor, una excepción aceptada como decisión de diseño) |
| Actividad H5P | `h5pactivity` | Sí, con un paquete `.h5p` local o **generado por el MCP** (`campus_plan_h5p_content`: cuestionario, presentación, libro, video interactivo, escenario ramificado, tarjetas, gráfico, línea de tiempo, acordeón o ejercicio de Python; ADR-110, 111 y 116) | Descripción; reemplazar el paquete (`campus_plan_activity_files`, ADR-104) o regenerar el contenido (`campus_plan_h5p_content`, `replace`) | No |
| Lección | `lesson` | Sí (vacía) | Descripción; disponible desde, fecha límite y límite de tiempo | Páginas: agregar de contenido, editar título o contenido de cualquiera, borrar (`campus_plan_lesson_page`, ADR-081). Páginas de pregunta de los 6 tipos: agregar y editar enunciado y respuestas (`campus_plan_lesson_question`, ADR-092); al borrar una, el deshacer la recrea |
| Libro | `book` | Sí (vacío) | Descripción | Capítulos: agregar, editar, ocultar o mostrar, reordenar y borrar (`campus_plan_book_chapter`) |
| Wiki | `wiki` | Sí (colaborativa o individual) | Descripción | Páginas: agregar, editar y borrar (`campus_plan_wiki_page`), también en el subwiki de cada grupo o participante (`group_id`, `user_id`; ADR-093) |

## Lectura del contenido interno

`campus_get_activity_content` (ADR-079) lee lo que hay adentro de: libro (capítulos, incluidos los ocultos), glosario, wiki, base de datos, consulta (opciones y respuestas), lección (páginas), actividad H5P (paquete, intentos y, con `attempt_id`, respuestas por pregunta de un intento; sin rol docente, sólo los intentos propios) y carpeta (archivos). La encuesta se lee por su página de preguntas (ADR-097). H5P interactivo, LTI, subject attendance y Turnitin no tienen lectura por el servicio móvil; foros, tareas, cuestionarios, páginas, archivos, asistencia y elección de grupo tienen sus propias herramientas.

## Libro de calificaciones

Ítems manuales: agregar, editar y borrar (`campus_plan_grade_item`). Cualquier ítem: ocultar, mostrar, bloquear y desbloquear. Notas de un participante: sobrescribir, quitar la sobrescritura, excluir, ocultar, bloquear y retroalimentación (`campus_plan_gradebook_grade`, ADR-096).

## Secciones

| Elemento | Crear | Editar | Borrar |
|---|---|---|---|
| Sección | `campus_plan_create_section` | Nombre (`campus_plan_rename`), resumen (`campus_plan_section_summary`) y orden (`campus_plan_move_section`) | `campus_plan_delete_content` con `section_number`, con todo su contenido |
| Subsección | `campus_plan_create_content` con `type: "subsection"` | Nombre: `campus_plan_rename` sobre la actividad de la subsección; resumen: `campus_plan_section_summary` con su número de sección | `campus_plan_delete_content` con el `section_number` de la subsección (sobre su actividad se rechaza) |

## Lo que no se cubre, y por qué

- **Turnitin:** guardar su formulario sincroniza la tarea con el servicio externo de Turnitin, fuera del Campus.
- **LTI (Panopto) y H5P interactivo (`hvp`):** el contenido vive en el sistema externo o en el editor H5P. Sólo se edita la descripción.
- **Finalización de actividades:** si el curso tiene el seguimiento de finalización desactivado (como el sandbox), los formularios no traen esos campos. Activarlo es un ajuste del curso, fuera del alcance.
