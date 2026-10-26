// Ejecuta Python (Pyodide) fuera del hilo principal: si el código no termina, la página corta el worker.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

const HARNESS = `
import sys, io, traceback

def __campus_run(code, fname, tests):
    out = io.StringIO()
    old = sys.stdout
    sys.stdout = out
    try:
        ns = {"__name__": "__main__"}
        try:
            exec(code, ns)
        except Exception:
            return {"error": traceback.format_exc(limit=2), "stdout": out.getvalue()[-20000:]}
        f = ns.get(fname)
        if not callable(f):
            return {"error": "No encontré la función " + fname + ": revisá el nombre.", "stdout": out.getvalue()[-20000:]}
        results = []
        for t in tests:
            try:
                args = eval("(" + t["args"] + ",)", {}) if t["args"].strip() else ()
                expected = eval(t["expected"], {})
                got = f(*args)
                results.append({"ok": got == expected, "got": repr(got)[:500]})
            except Exception as e:
                results.append({"ok": False, "error": type(e).__name__ + ": " + str(e)[:300]})
        return {"results": results, "stdout": out.getvalue()[-20000:]}
    finally:
        sys.stdout = old
`;

let ready = (async () => {
    const py = await loadPyodide();
    py.runPython(HARNESS);
    return py;
})();

self.onmessage = async (e) => {
    try {
        const py = await ready;
        const run = py.globals.get("__campus_run");
        const res = run(e.data.code, e.data.fname, py.toPy(e.data.tests));
        const js = res.toJs({ dict_converter: Object.fromEntries });
        res.destroy();
        self.postMessage({ ok: true, ...js });
    } catch (err) {
        self.postMessage({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 2000) });
    }
};

ready.then(() => self.postMessage({ ready: true }), (err) => self.postMessage({ ok: false, error: "No se pudo cargar Python: " + String(err).slice(0, 300) }));
