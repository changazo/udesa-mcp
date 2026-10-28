"""Pruebas del generador con fixtures sintéticos. Ejecutar: python -m unittest test_generar_traza"""

import pathlib
import unittest

import generar_traza

EJEMPLO = pathlib.Path(__file__).parent / "ejemplos" / "sumar_pares.py"


def locals_of(event, frame_name):
    for frame in event["stack"]:
        if frame["function"] == frame_name:
            return {item["name"]: item for item in frame["locals"]}
    return None


class SumarParesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = generar_traza.generate_trace(EJEMPLO.read_text(encoding="utf-8"), title="sumar pares")
        cls.events = cls.data["events"]

    def test_finishes_with_expected_outcome(self):
        self.assertEqual(self.data["metadata"]["outcome"], "finished")
        self.assertFalse(self.data["metadata"]["truncated"])
        self.assertIsNone(self.data["metadata"]["error"])

    def test_no_module_line_zero_event(self):
        self.assertTrue(all(event["line"] != 0 for event in self.events))

    def test_return_value_is_six(self):
        returns = [e for e in self.events if e["event"] == "return" and e["return_value"] is not None]
        self.assertEqual([e["return_value"] for e in returns], ["6"])

    def test_total_history_goes_zero_two_six(self):
        last_inside = [e for e in self.events if locals_of(e, "sumar_pares")][-1]
        total = locals_of(last_inside, "sumar_pares")["total"]
        self.assertEqual(total["history"], ["0", "2", "6"])

    def test_numero_history_visits_each_element(self):
        last_inside = [e for e in self.events if locals_of(e, "sumar_pares")][-1]
        numero = locals_of(last_inside, "sumar_pares")["numero"]
        self.assertEqual(numero["history"], ["2", "3", "4"])

    def test_global_result_assigned_at_the_end(self):
        last = self.events[-1]
        self.assertEqual(last["event"], "return")
        self.assertEqual(locals_of(last, "global")["resultado"]["value"], "6")

    def test_same_source_gives_same_ids(self):
        again = generar_traza.generate_trace(EJEMPLO.read_text(encoding="utf-8"), title="otro título")
        self.assertEqual(again["trace_id"], self.data["trace_id"])
        self.assertEqual(again["source_hash"], self.data["source_hash"])


class SnapshotTest(unittest.TestCase):
    def test_earlier_snapshot_is_not_changed_by_later_mutation(self):
        source = "a = [1]\nb = a\na.append(2)\n"
        data = generar_traza.generate_trace(source)
        history = None
        for event in data["events"]:
            for frame in event["stack"]:
                for item in frame["locals"]:
                    if item["name"] == "a":
                        history = item["history"]
        self.assertEqual(history, ["[1]", "[1, 2]"])


class ErrorAndLimitTest(unittest.TestCase):
    def test_exception_is_recorded_not_hidden(self):
        data = generar_traza.generate_trace("x = 1 / 0\n")
        self.assertEqual(data["metadata"]["outcome"], "exception")
        self.assertEqual(data["metadata"]["error"]["type"], "ZeroDivisionError")
        exceptions = [e for e in data["events"] if e["event"] == "exception"]
        self.assertEqual([e["exception"] for e in exceptions], ["ZeroDivisionError"])

    def test_truncation_is_marked_and_program_still_ends(self):
        data = generar_traza.generate_trace("total = 0\nfor i in range(1000):\n    total = total + i\n")
        self.assertEqual(data["metadata"]["outcome"], "truncated")
        self.assertTrue(data["metadata"]["truncated"])
        self.assertEqual(len(data["events"]), generar_traza.MAX_EVENTS)

    def test_stdout_is_captured_per_event(self):
        data = generar_traza.generate_trace("print('hola')\nx = 2\n")
        self.assertIn("hola", data["events"][-1]["stdout"])

    def test_syntax_error_is_reported_as_trace_error(self):
        with self.assertRaises(generar_traza.TraceError):
            generar_traza.generate_trace("def f(:\n")

    def test_source_too_long_is_rejected(self):
        with self.assertRaises(generar_traza.TraceError):
            generar_traza.generate_trace("x = 1\n" * 1000)

    def test_function_without_return_gives_none_text(self):
        data = generar_traza.generate_trace("def f():\n    pass\nf()\n")
        returns = [e for e in data["events"] if e["event"] == "return" and e["stack"][-1]["function"] == "f"]
        self.assertEqual(len(returns), 1)
        self.assertEqual(returns[0]["return_value"], "None")


FUNCION = "def sumar_pares(numeros):\n    total = 0\n    for numero in numeros:\n        if numero % 2 == 0:\n            total = total + numero\n    return total\n"


class CallTest(unittest.TestCase):
    def test_call_is_appended_and_traced(self):
        data = generar_traza.generate_trace(FUNCION, call="sumar_pares([1, 2, 8])")
        self.assertTrue(data["source"].endswith("\n\nresultado = sumar_pares([1, 2, 8])\n"))
        self.assertEqual(locals_of(data["events"][-1], "global")["resultado"]["value"], "10")

    def test_same_function_with_other_arguments_gives_other_trace(self):
        a = generar_traza.generate_trace(FUNCION, call="sumar_pares([2])")
        b = generar_traza.generate_trace(FUNCION, call="sumar_pares([4])")
        self.assertNotEqual(a["trace_id"], b["trace_id"])

    def test_call_matches_file_with_the_same_line(self):
        inline = generar_traza.generate_trace(EJEMPLO.read_text(encoding="utf-8"))
        appended = generar_traza.generate_trace(FUNCION, call="sumar_pares([2, 3, 4])")
        self.assertEqual(appended["source"], inline["source"])
        self.assertEqual(appended["events"], inline["events"])

    def test_call_must_be_a_single_function_call(self):
        for bad in ("1 + 2", "f(1); import os", "f(1)\nimport os", "x = f(1)", "def g(:"):
            with self.subTest(bad=bad), self.assertRaises(generar_traza.TraceError):
                generar_traza.generate_trace(FUNCION, call=bad)


class CommandLineTest(unittest.TestCase):
    def test_output_name_must_be_safe_for_the_viewer(self):
        for bad in ("Sumar.json", "sumar pares.json", "sumar.txt", "_x.json"):
            with self.subTest(bad=bad):
                self.assertEqual(generar_traza.main([str(EJEMPLO), "--out", bad]), 1)


if __name__ == "__main__":
    unittest.main()
