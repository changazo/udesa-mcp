// Ejercicio de Python con pruebas. La consigna viaja en el fragmento (#c=…): no llega al servidor.
const $ = (id) => document.getElementById(id);
const TIMEOUT_MS = 8000;

// Lanzamiento LTI (ADR-117): la página del lanzamiento trae la consigna y la sesión de nota como JSON (no se ejecuta).
const lti = (() => {
    const el = document.getElementById("lti-data");
    if (!el) return null;
    try {
        return JSON.parse(el.textContent);
    } catch {
        return null;
    }
})();

function decodeConfig() {
    const m = lti ? [null, typeof lti.config === "string" ? lti.config : ""] : /[#&]c=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m || !/^[A-Za-z0-9_-]+$/.test(m[1])) return null;
    try {
        const json = new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
        const c = JSON.parse(json);
        if (typeof c.function_name !== "string" || !/^[A-Za-z_]\w{0,60}$/.test(c.function_name) || !Array.isArray(c.tests)) return null;
        return {
            title: String(c.title ?? "Ejercicio de Python").slice(0, 200),
            statement: String(c.statement ?? "").slice(0, 8000),
            function_name: c.function_name,
            starter_code: String(c.starter_code ?? "").slice(0, 20000),
            tests: c.tests.slice(0, 50).map((t) => ({ args: String(t.args ?? "").slice(0, 2000), expected: String(t.expected ?? "None").slice(0, 2000), hidden: !!t.hidden })),
        };
    } catch {
        return null;
    }
}

/** Texto plano con `código` resaltado (nunca HTML del enunciado). */
function renderStatement(el, text) {
    el.textContent = "";
    for (const [i, part] of text.split("`").entries()) {
        if (i % 2) {
            const c = document.createElement("code");
            c.textContent = part;
            el.append(c);
        } else el.append(part);
    }
}

const cfg = decodeConfig();
const store = (() => {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
})();
const key = cfg ? "py:" + (lti ? String(lti.config).slice(0, 200) : location.hash.slice(0, 200)) : null;
const banner = document.getElementById("lti-banner");
if (banner && lti) {
    banner.textContent = !lti.session
        ? "Esta actividad no tiene calificación en el Campus: el resultado no se registra."
        : lti.role === "docente"
          ? "Vista docente: al ejecutar las pruebas se registra una nota de prueba a tu nombre."
          : "Cada vez que ejecutás las pruebas, tu resultado se registra en el Campus (vale el último).";
}

if (!cfg) {
    $("title").textContent = "Ejercicio no configurado";
    $("statement").textContent = "Falta la configuración del ejercicio en el enlace.";
    $("run").textContent = "Sin ejercicio";
} else {
    document.title = cfg.title;
    $("title").textContent = cfg.title;
    renderStatement($("statement"), cfg.statement);
    let saved = null;
    try {
        saved = store?.getItem(key) ?? null;
    } catch {}
    $("code").value = saved ?? cfg.starter_code;
    $("code").addEventListener("input", () => {
        try {
            store?.setItem(key, $("code").value);
        } catch {}
    });
    $("code").addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            const t = e.target;
            const s = t.selectionStart;
            t.setRangeText("    ", s, t.selectionEnd, "end");
        }
    });
    $("reset").addEventListener("click", () => {
        $("code").value = cfg.starter_code;
        try {
            store?.removeItem(key);
        } catch {}
    });

    let worker = null;
    let pending = null;
    const startWorker = () => {
        worker = new Worker(new URL("./worker.js", import.meta.url));
        worker.onmessage = (e) => {
            if (e.data.ready) {
                $("run").disabled = false;
                $("run").textContent = "Ejecutar pruebas";
                return;
            }
            if (pending) pending(e.data);
        };
    };
    startWorker();

    const show = (res) => {
        $("results").textContent = "";
        $("error").hidden = true;
        if (res.error) {
            $("error").textContent = res.error;
            $("error").hidden = false;
        }
        const rs = res.results ?? [];
        rs.forEach((r, i) => {
            const t = cfg.tests[i];
            const div = document.createElement("div");
            div.className = "test " + (r.ok ? "ok" : "bad");
            const call = t.hidden ? `Prueba oculta ${i + 1}` : `${cfg.function_name}(${t.args})`;
            div.textContent = r.ok ? `✓ ${call}` : `✗ ${call}` + (t.hidden ? "" : `\n  esperado: ${t.expected}`) + (r.error ? `\n  error: ${r.error}` : t.hidden ? "" : `\n  obtenido: ${r.got}`);
            $("results").append(div);
        });
        const passed = rs.filter((r) => r.ok).length;
        $("score").textContent = rs.length ? `${passed} de ${cfg.tests.length} pruebas` : "";
        $("stdout").textContent = res.stdout ?? "";
        $("stdout-box").hidden = !res.stdout;
        if (lti?.session && rs.length) sendGrade(passed, cfg.tests.length);
    };

    async function sendGrade(passed, total) {
        const g = $("grade");
        if (!g) return;
        g.textContent = "Registrando el resultado en el Campus…";
        try {
            const r = await fetch("/api/lti/score", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: lti.session, passed, total }) });
            const j = await r.json();
            g.textContent = j.ok ? `Resultado registrado en el Campus: ${j.passed} de ${j.total}.` : `No se pudo registrar: ${j.error}`;
        } catch {
            g.textContent = "No se pudo registrar el resultado (sin conexión).";
        }
    }

    $("run").addEventListener("click", () => {
        $("run").disabled = true;
        $("run").textContent = "Ejecutando…";
        const timer = setTimeout(() => {
            worker.terminate();
            pending = null;
            show({ error: `Se cortó la ejecución: tardó más de ${TIMEOUT_MS / 1000} s (¿un bucle que no termina?).` });
            $("run").textContent = "Cargando Python…";
            startWorker();
        }, TIMEOUT_MS);
        pending = (res) => {
            clearTimeout(timer);
            pending = null;
            show(res);
            $("run").disabled = false;
            $("run").textContent = "Ejecutar pruebas";
        };
        worker.postMessage({ code: $("code").value, fname: cfg.function_name, tests: cfg.tests.map(({ args, expected }) => ({ args, expected })) });
    });
}
