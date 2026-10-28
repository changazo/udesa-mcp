'use strict';

// Visualizador de solo lectura. Reproduce una traza JSON ya generada por generar_traza.py.
// Nunca ejecuta Python ni acepta código del estudiante. Todo texto se escribe con textContent.

// ?traza=<nombre> elige trazas/<nombre>.json. Sólo letras minúsculas, dígitos, «-» y «_»: así la dirección
// pasa intacta por el encodeURI del Iframe Embedder de H5P y no puede salir de la carpeta.
const DEFAULT_TRACE = 'sumar_pares';
const TRACE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SCHEMA = 'python-trace/1';
const LABELS = { line: 'Antes de ejecutar', call: 'Llamada', return: 'Retorno', exception: 'Excepción' };

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function explain(event) {
  const frame = event.stack[event.stack.length - 1];
  const name = frame.function;
  if (event.event === 'call') return `Entra a ${name}(). Se crea su marco con los parámetros.`;
  if (event.event === 'return') {
    if (name === 'global') return 'Termina el programa principal.';
    return `${name}() retorna ${event.return_value}. Su marco termina al volver al llamador.`;
  }
  if (event.event === 'exception') return `Se produce ${event.exception}. La ejecución se interrumpe.`;
  if (name === 'global') return `Se ejecuta la línea ${event.line} del programa principal.`;
  return `Se ejecuta la línea ${event.line} de ${name}().`;
}

function renderCode(lines) {
  const list = $('code');
  list.replaceChildren();
  lines.forEach((text, index) => {
    const item = el('li');
    item.dataset.line = String(index + 1);
    item.append(el('span', 'num', String(index + 1)), el('span', 'text', text || ' '));
    list.append(item);
  });
}

function renderFrame(frame, active) {
  const wrapper = el('div', active ? 'frame active' : 'frame');
  const title = frame.function === 'global' ? 'Ámbito global' : `Función ${frame.function}() · variables locales`;
  wrapper.append(el('div', 'frame-title', title));
  if (frame.locals.length === 0) {
    wrapper.append(el('div', 'empty', 'Todavía no hay variables en este ámbito.'));
    return wrapper;
  }
  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  ['Variable', 'Tipo', 'Valor'].forEach((label) => headRow.append(el('th', null, label)));
  head.append(headRow);
  const body = el('tbody');
  frame.locals.forEach((item) => {
    const row = el('tr');
    const shown = item.history && item.history.length ? item.history.join(' → ') : item.value;
    row.append(el('td', null, item.name), el('td', null, item.type), el('td', null, shown));
    body.append(row);
  });
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function renderNotice(data) {
  const meta = data.metadata;
  let message = '';
  if (meta.outcome === 'truncated') {
    message = `Traza truncada: se muestran los primeros ${meta.max_events} pasos. No es la ejecución completa.`;
  } else if (meta.outcome === 'exception') {
    message = `El programa terminó con un error: ${meta.error.type}. Es parte del recorrido, no una finalización correcta.`;
  }
  const box = $('notice');
  box.textContent = message;
  box.hidden = message === '';
}

function showFatal(message) {
  const box = $('notice');
  box.textContent = message;
  box.hidden = false;
  $('count').textContent = 'Sin traza';
  $('event').textContent = '';
  $('message').textContent = '';
  ['first', 'prev', 'next', 'last'].forEach((id) => { $(id).disabled = true; });
  $('range').disabled = true;
}

function start(data) {
  const events = data.events;
  const title = data.metadata.title || 'Una función, paso a paso';
  $('title').textContent = title;
  document.title = title;
  renderNotice(data);
  renderCode(data.source.replace(/\n$/, '').split('\n'));

  const range = $('range');
  range.max = String(events.length - 1);

  let at = 0;

  function render() {
    const event = events[at];
    $('count').textContent = `Paso ${at + 1} de ${events.length}`;
    $('event').textContent = `${LABELS[event.event] || event.event} · línea ${event.line}`;
    $('message').textContent = explain(event);
    range.value = String(at);

    let current = null;
    for (const item of $('code').children) {
      if (Number(item.dataset.line) === event.line) {
        item.setAttribute('aria-current', 'step');
        current = item;
      } else {
        item.removeAttribute('aria-current');
      }
    }
    if (current) current.scrollIntoView({ block: 'nearest' });

    const frames = $('frames');
    frames.replaceChildren();
    event.stack.forEach((frame, index) => {
      frames.append(renderFrame(frame, index === event.stack.length - 1));
    });

    const returned = $('returned');
    returned.replaceChildren();
    if (event.event === 'return' && event.return_value !== null && event.stack.length > 1) {
      returned.append(el('div', 'returned', `Retorno: ${event.return_value}`));
    }

    const stdout = $('stdout');
    stdout.hidden = !event.stdout;
    stdout.textContent = event.stdout ? `Salida hasta este paso:\n${event.stdout}` : '';

    $('first').disabled = $('prev').disabled = at === 0;
    $('next').disabled = $('last').disabled = at === events.length - 1;
  }

  function goTo(n) {
    at = Math.max(0, Math.min(events.length - 1, n));
    render();
  }

  $('first').onclick = () => goTo(0);
  $('prev').onclick = () => goTo(at - 1);
  $('next').onclick = () => goTo(at + 1);
  $('last').onclick = () => goTo(events.length - 1);
  range.addEventListener('input', () => goTo(Number(range.value)));

  document.addEventListener('keydown', (key) => {
    // Con foco en un botón o en el deslizador, el navegador ya maneja las teclas.
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'BUTTON' || tag === 'INPUT') return;
    if (key.key === 'ArrowRight') { key.preventDefault(); goTo(at + 1); }
    if (key.key === 'ArrowLeft') { key.preventDefault(); goTo(at - 1); }
    if (key.key === 'Home') { key.preventDefault(); goTo(0); }
    if (key.key === 'End') { key.preventDefault(); goTo(events.length - 1); }
  });

  const meta = data.metadata;
  $('foot').textContent =
    `Traza calculada antes de abrir esta página con Python ${data.python_version} ` +
    `(sha256 ${data.source_hash.slice(0, 12)}…). No envía datos a Moodle, no puntúa ` +
    'y no registra estudiantes. ' + meta.semantics;

  render();
}

async function load() {
  const name = new URLSearchParams(location.search).get('traza') ?? DEFAULT_TRACE;
  if (!TRACE_NAME.test(name)) {
    showFatal('El nombre de la traza no es válido: usá sólo minúsculas, dígitos, «-» y «_».');
    return;
  }
  let data;
  try {
    const response = await fetch(`trazas/${name}.json`, { cache: 'no-cache' });
    if (response.status === 404) throw new Error(`no existe la traza «${name}»`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    showFatal(`No se pudo cargar la traza (${error.message}). Esto no es una traza vacía: revisá la publicación.`);
    return;
  }
  if (data.schema_version !== SCHEMA || !Array.isArray(data.events) || data.events.length === 0) {
    showFatal(`La traza no tiene el formato esperado (${SCHEMA}).`);
    return;
  }
  start(data);
}

load();
