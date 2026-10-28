# Contrato `python-trace/1`

**Estado:** aprobado por el responsable del proyecto el 28 de octubre de 2026 (versión 1).
Cambiarlo exige una versión nueva (`python-trace/2`); no se reescriben trazas ya publicadas.

## Archivo

Un objeto JSON generado por `generar_traza.py` a partir de un programa de la cátedra.

| Campo | Contenido |
|---|---|
| `schema_version` | Siempre `python-trace/1`. |
| `trace_id` | SHA-256 de versión de esquema, versión de Python y `source_hash`. |
| `python_version` | Versión del intérprete que produjo la traza (p. ej. `3.13.5`). |
| `source_hash` | SHA-256 del código fuente en UTF-8. |
| `source` | Código fuente completo. El visualizador lo muestra sin permitir edición. |
| `metadata.title` | Título visible. |
| `metadata.semantics` | Texto que explica qué significa cada estado. |
| `metadata.outcome` | `finished`, `exception` o `truncated`. Sólo `finished` es una ejecución completa. |
| `metadata.error` | `null` o `{type, message}` del error no capturado. |
| `metadata.truncated` | `true` si se alcanzó `max_events`. |
| `metadata.max_events` | Límite de eventos (200). |
| `events[]` | Eventos en orden. |

## Evento

| Campo | Contenido |
|---|---|
| `step` | Índice desde 0. |
| `event` | `call`, `line`, `return` o `exception`. |
| `line` | Línea del evento. En `line`, es la próxima a ejecutar. |
| `stack[]` | Marcos vivos, del más externo al más interno. El último es el activo. |
| `stack[].frame_id` | Identificador estable dentro de la traza (`f1`, `f2`…). |
| `stack[].function` | Nombre de la función o `global`. |
| `stack[].locals[]` | `{name, type, value, history}`. `value` es el texto congelado en el paso. `history` lista los valores distintos consecutivos hasta ese paso. |
| `stdout` | Salida acumulada hasta el paso (máximo 2000 caracteres). |
| `return_value` | Texto del valor retornado, sólo en `return` de funciones. |
| `exception` | Nombre del tipo de excepción, sólo en `exception`. |

## Reglas de semántica

- El evento `line` marca la línea que va a ejecutarse; las variables reflejan el estado anterior a ella.
- No se registra el evento de entrada al módulo (línea 0).
- Los textos son snapshots: una mutación posterior no altera pasos anteriores.
- Un programa que falla o supera el límite no se presenta como finalizado.

## Límites conocidos de la versión 1

- El campo `invocation` de la propuesta original **no** existe en esta versión: el generador ejecuta el archivo completo, incluida la llamada. Con `--llamada` el generador agrega `resultado = <llamada>` al final, y esa línea queda en `source`. Por eso no cambia el formato.

## Publicación

Cada traza va en `trazas/<nombre>.json` y se abre con `?traza=<nombre>`; sin parámetro se abre `sumar_pares`. El nombre usa sólo minúsculas, dígitos, `-` y `_`: pasa intacto por el `encodeURI` del Iframe Embedder de H5P y no puede salir de la carpeta. El generador rechaza otra salida.
- Se ejecuta código de autoría sin sandbox de seguridad. Por eso el generador no debe usarse con código de estudiantes ni exponerse como servicio.
- No hay JSON Schema formal todavía; la validación actual está en `test_generar_traza.py`.
