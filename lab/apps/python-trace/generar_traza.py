"""Genera la traza JSON de solo lectura que reproduce el visualizador python-trace.

Uso de autoría, offline, sobre código del docente:

    python generar_traza.py ejemplos/sumar_pares.py --title "Funciones: sumar pares" --out trazas/sumar_pares.json

Con --llamada, el archivo trae sólo la función y la llamada se agrega al final como
`resultado = <llamada>`. Así la misma función da una traza por cada juego de argumentos:

    python generar_traza.py funcion.py --llamada "sumar_pares([1, 2])" --out trazas/sumar_pares_corto.json

ADVERTENCIA: este script ejecuta el código que recibe. Es sólo una herramienta de
autoría para programas escritos por la cátedra. No lo uses con código de estudiantes,
no lo expongas como servicio web y no lo llames desde el servidor del MCP.
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import hashlib
import io
import json
import pathlib
import platform
import re
import sys
import types

SCHEMA_VERSION = "python-trace/1"
FILENAME = "visualizacion.py"
MAX_EVENTS = 200
MAX_SOURCE_CHARS = 4000
MAX_VALUE_CHARS = 200
MAX_STDOUT_CHARS = 2000
TRACED_EVENTS = ("call", "line", "return", "exception")
# Mismo patrón que el visor (?traza=<nombre>): pasa intacto por el encodeURI del Iframe Embedder de H5P.
TRACE_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,62}")
SEMANTICS = (
    "La línea marcada es la próxima a ejecutar: sus variables muestran el estado "
    "anterior a esa línea. En un evento de retorno se muestra el valor devuelto."
)


class TraceError(Exception):
    """El programa no cumple los límites de la herramienta de autoría."""


def frozen(value, depth=0):
    """Devuelve una representación de texto fija en el momento del evento.

    Un texto no cambia cuando el objeto se muta después, así que cada paso conserva
    la fotografía del estado que tenía entonces.
    """
    if depth > 3:
        return "…"
    try:
        if value is None or isinstance(value, (bool, int, float)):
            return repr(value)
        if isinstance(value, str):
            return repr(value)[:MAX_VALUE_CHARS]
        if isinstance(value, list):
            items = [frozen(x, depth + 1) for x in value[:15]]
            return "[" + ", ".join(items) + (", …" if len(value) > 15 else "") + "]"
        if isinstance(value, tuple):
            items = [frozen(x, depth + 1) for x in value[:15]]
            return "(" + ", ".join(items) + ")"
        if isinstance(value, dict):
            items = [
                f"{frozen(k, depth + 1)}: {frozen(v, depth + 1)}"
                for k, v in list(value.items())[:10]
            ]
            return "{" + ", ".join(items) + "}"
        if isinstance(value, types.FunctionType):
            return f"función {value.__name__}"
        return repr(value)[:MAX_VALUE_CHARS]
    except Exception:
        return "<valor no representable>"


def type_name(value):
    if isinstance(value, types.FunctionType):
        return "función"
    return type(value).__name__


class _Recorder:
    def __init__(self):
        self.events = []
        self.stdout = io.StringIO()
        self.truncated = False
        self._frames = {}  # id(frame) -> (frame, frame_id); la referencia evita reutilizar ids
        self._histories = {}  # (frame_id, nombre) -> valores distintos consecutivos

    def tracer(self, frame, event, arg):
        if frame.f_code.co_filename != FILENAME:
            return None
        if event not in TRACED_EVENTS:
            return self.tracer
        # La entrada al módulo informa línea 0; no es una línea útil para estudiantes.
        if event == "call" and frame.f_code.co_name == "<module>":
            return self.tracer
        if len(self.events) >= MAX_EVENTS:
            self.truncated = True
            sys.settrace(None)
            return None
        self.events.append(self._event(frame, event, arg))
        return self.tracer

    def _event(self, frame, event, arg):
        returned = None
        if event == "return" and frame.f_code.co_name != "<module>":
            returned = frozen(arg)
        exception = arg[0].__name__ if event == "exception" else None
        return {
            "step": len(self.events),
            "event": event,
            "line": frame.f_lineno,
            "stack": self._stack(frame),
            "stdout": self.stdout.getvalue()[-MAX_STDOUT_CHARS:],
            "return_value": returned,
            "exception": exception,
        }

    def _frame_id(self, frame):
        key = id(frame)
        if key not in self._frames:
            self._frames[key] = (frame, f"f{len(self._frames) + 1}")
        return self._frames[key][1]

    def _stack(self, frame):
        stack = []
        current = frame
        while current is not None:
            if current.f_code.co_filename == FILENAME:
                stack.append(self._frame_entry(current))
            current = current.f_back
        return stack[::-1]

    def _frame_entry(self, frame):
        is_module = frame.f_code.co_name == "<module>"
        frame_id = self._frame_id(frame)
        local_items = []
        for name, value in frame.f_locals.items():
            if name.startswith("__"):
                continue
            if is_module and isinstance(value, types.FunctionType):
                continue
            value_text = frozen(value)
            history = self._histories.setdefault((frame_id, name), [])
            if not history or history[-1] != value_text:
                history.append(value_text)
            local_items.append(
                {
                    "name": name,
                    "type": type_name(value),
                    "value": value_text,
                    "history": list(history),
                }
            )
        return {
            "frame_id": frame_id,
            "function": "global" if is_module else frame.f_code.co_name,
            "line": frame.f_lineno,
            "locals": local_items,
        }


def with_call(source, call):
    """Agrega `resultado = <call>` al final. `call` tiene que ser una sola llamada, sin sentencias."""
    try:
        tree = ast.parse(call.strip(), mode="eval")
    except SyntaxError:
        raise TraceError("La llamada no es una expresión de Python válida.") from None
    if not isinstance(tree.body, ast.Call):
        raise TraceError("La llamada tiene que ser una llamada a función, por ejemplo f(1, 2).")
    return source.rstrip("\n") + f"\n\nresultado = {call.strip()}\n"


def generate_trace(source, title="", python_version=None, call=None):
    """Ejecuta `source` bajo traza y devuelve el diccionario del contrato python-trace/1.

    Con `call`, la llamada se agrega al código antes de ejecutarlo y forma parte de `source`.
    """
    if call is not None:
        source = with_call(source, call)
    if len(source) > MAX_SOURCE_CHARS:
        raise TraceError(f"El programa supera {MAX_SOURCE_CHARS} caracteres.")
    try:
        code = compile(source, FILENAME, "exec")
    except SyntaxError as exc:
        raise TraceError(f"Error de sintaxis en la línea {exc.lineno}: {exc.msg}.") from None

    recorder = _Recorder()
    namespace = {"__name__": "__main__"}
    error = None
    with contextlib.redirect_stdout(recorder.stdout):
        sys.settrace(recorder.tracer)
        try:
            exec(code, namespace)
        except Exception as exc:  # el error se registra; no se oculta
            error = {"type": type(exc).__name__, "message": str(exc)[:MAX_VALUE_CHARS]}
        finally:
            sys.settrace(None)

    if recorder.truncated:
        outcome = "truncated"
    elif error is not None:
        outcome = "exception"
    else:
        outcome = "finished"

    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
    py_version = python_version or platform.python_version()
    trace_id = hashlib.sha256(
        f"{SCHEMA_VERSION}\n{py_version}\n{source_hash}".encode("utf-8")
    ).hexdigest()
    return {
        "schema_version": SCHEMA_VERSION,
        "trace_id": trace_id,
        "python_version": py_version,
        "source_hash": source_hash,
        "source": source,
        "metadata": {
            "title": title,
            "semantics": SEMANTICS,
            "outcome": outcome,
            "error": error,
            "truncated": recorder.truncated,
            "max_events": MAX_EVENTS,
        },
        "events": recorder.events,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=pathlib.Path, help="archivo Python de la cátedra")
    parser.add_argument("--title", default="", help="título visible en el visualizador")
    parser.add_argument("--llamada", help="llamada que se agrega al final, por ejemplo \"f([1, 2])\"")
    parser.add_argument("--out", type=pathlib.Path, required=True, help="archivo JSON de salida (trazas/<nombre>.json)")
    args = parser.parse_args(argv)

    if args.out.suffix != ".json" or not TRACE_NAME.fullmatch(args.out.stem):
        print("Error: la salida tiene que llamarse <nombre>.json, con minúsculas, dígitos, «-» y «_».", file=sys.stderr)
        return 1
    source = args.source.read_text(encoding="utf-8")
    try:
        data = generate_trace(source, title=args.title, call=args.llamada)
    except TraceError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Traza {data['metadata']['outcome']}: {len(data['events'])} eventos, "
        f"Python {data['python_version']}, sha256 {data['source_hash'][:12]}. "
        f"En el visor: ?traza={args.out.stem}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
