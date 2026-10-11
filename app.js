const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
/* llamar() y el acceso con Google están más abajo */

// ---------- Acceso con Google y comunicación con el servidor ----------
const CFG = window.OPUS_CONFIG || {};
let TOKEN = '';
try { TOKEN = sessionStorage.getItem('opus_token') || ''; } catch (e) { /* sin almacenamiento */ }

function tokenVigente(t) {
  try {
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.exp * 1000 > Date.now() + 60000;
  } catch (e) { return false; }
}

function guardarToken(t) {
  TOKEN = t;
  try { if (t) sessionStorage.setItem('opus_token', t); else sessionStorage.removeItem('opus_token'); } catch (e) { /* sin almacenamiento */ }
}

function esperarGoogle() {
  return new Promise((ok, no) => {
    const t0 = Date.now();
    (function revisar() {
      if (window.google && google.accounts && google.accounts.id) return ok();
      if (Date.now() - t0 > 12000) return no(new Error('No se pudo cargar el acceso con Google. Revisá tu conexión.'));
      setTimeout(revisar, 100);
    })();
  });
}

let esperandoLogin = null;

function pedirLogin() {
  if (esperandoLogin) return esperandoLogin.promesa;
  let resolver;
  const promesa = new Promise(r => { resolver = r; });
  esperandoLogin = { promesa, resolver };
  mostrarLogin();
  return promesa;
}

function alRecibirCredencial(resp) {
  guardarToken(resp.credential);
  document.getElementById('login').classList.add('hide');
  mostrarLoader();
  if (esperandoLogin) { esperandoLogin.resolver(); esperandoLogin = null; }
}

async function mostrarLogin() {
  ocultarLoader();
  document.getElementById('login').classList.remove('hide');
  const msg = document.getElementById('loginmsg');
  msg.textContent = '';
  try {
    await esperarGoogle();
    google.accounts.id.initialize({ client_id: CFG.clientId, callback: alRecibirCredencial, auto_select: true, use_fedcm_for_prompt: true });
    google.accounts.id.renderButton(document.getElementById('gbtn'),
      { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill', locale: 'es' });
    google.accounts.id.prompt();
  } catch (e) { msg.textContent = e.message; }
}

function salir() {
  guardarToken('');
  try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) { /* nada */ }
  location.reload();
}

async function enviar(fn, args) {
  let resp;
  try {
    resp = await fetch(CFG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: TOKEN, fn: fn, args: args }),
    });
  } catch (e) { throw new Error('No se pudo conectar con el servidor. Revisá tu conexión.'); }
  let j;
  try { j = await resp.json(); } catch (e) { throw new Error('El servidor respondió algo inesperado. Probá de nuevo en un momento.'); }
  if (j.code === 'AUTH') { const err = new Error(j.error); err.auth = true; throw err; }
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function llamar(fn, ...args) {
  try {
    if (!tokenVigente(TOKEN)) await pedirLogin();
    try { return await enviar(fn, args); }
    catch (e) {
      if (!e.auth) throw e;
      guardarToken('');
      await pedirLogin();
      return await enviar(fn, args);
    }
  } finally { ocultarLoader(); }
}

const S = { schemas: [], byId: {}, data: {}, rev: [], avisos: [], id: null, q: '', form: null, vista: 'maestros' };

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hide');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hide'), 3200);
}

// ---------- formato ----------
const fmtNum = n => Number(n).toLocaleString('es-AR', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
function fmtMoney(n, mon) {   // espacio fijo (nbsp) para que el símbolo no quede solo en la línea
  if (mon === 'USD') return 'US$ ' + fmtNum(n);
  if (mon === 'UVA') return fmtNum(n) + ' UVA';
  return '$ ' + fmtNum(n);
}
const fechaCorta = iso => { const p = String(iso).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; };

function celda(m, c, v, f) {
  if (c.k === m.estado) return '<span class="chip ' + (v === 'Activo' ? 'on' : '') + '">' + esc(v) + '</span>';
  if (v === '' || v == null) return '<span class="mut">—</span>';
  if (c.sensible) {
    const s = String(v);
    return s.length > 4 ? '<span class="mono mut">•••• ' + esc(s.slice(-4)) + '</span>' : esc(s);
  }
  switch (c.t) {
    case 'pct': return '<span class="mono">' + fmtNum(v) + '%</span>';
    case 'int': return '<span class="mono">' + esc(v) + '</span>';
    case 'num': return '<span class="mono">' + esc(fmtMoney(v, f.Moneda)) + '</span>';
    case 'diaofecha': return typeof v === 'number'
      ? '<span class="mono">día ' + v + '</span>' : '<span class="mono">' + esc(fechaCorta(v)) + '</span>';
    default: return esc(v);
  }
}

// ---------- vista ----------
function renderTabs() {
  const activa = S.vista === 'reglas' ? 'importar' : S.vista;
  $('tabs').innerHTML = [['maestros', 'DDMM'], ['importar', 'Importar'], ['movs', 'Movimientos']].map(t =>
    '<button class="tab ' + (activa === t[0] ? 'on' : '') + '" data-v="' + t[0] + '">' + t[1] + '</button>').join('');
  $('tabs').querySelectorAll('.tab').forEach(b => b.onclick = () => irVista(b.dataset.v));
}

function irVista(v) {
  S.vista = v; S.q = ''; store.set('vista', v);
  if (v === 'maestros' && S.id === 'reglas') S.id = S.schemas.filter(s => s.id !== 'reglas')[0].id;
  if (v === 'reglas') S.id = 'reglas';
  cerrar(); renderTabs(); render();
}

function render() {
  if (S.vista === 'importar') renderImportar();
  else if (S.vista === 'movs') renderMovs();
  else renderPage();
}

function renderPage() {
  const m = S.byId[S.id], d = S.data[S.id];
  const enReglas = S.vista === 'reglas';
  const pills = (enReglas ? [] : S.schemas.filter(s => s.id !== 'reglas')).map(s =>
    '<button class="pill ' + (s.id === S.id ? 'on' : '') + '" data-id="' + s.id + '">' + esc(s.titulo) +
    '<small>' + ((S.data[s.id] || {}).filas || []).length + '</small></button>').join('');

  const q = S.q.trim().toLowerCase();
  const filas = (d.filas || []).filter(f => !q || Object.keys(f.v).some(k => String(f.v[k]).toLowerCase().indexOf(q) >= 0));

  let cuerpo;
  if (d.error) {
    cuerpo = '<div class="aviso">' + esc(d.error) + '</div>';
  } else if (!filas.length) {
    cuerpo = '<div class="card vacio">' + (q ? 'Sin resultados para esa búsqueda' : 'Todavía no hay datos. Usá “Agregar”.') + '</div>';
  } else {
    const head = m.cols.map(c => '<th class="' + (c.t === 'num' || c.t === 'pct' || c.t === 'int' ? 'r' : '') + '">' + esc(c.label || c.k) + '</th>').join('');
    const rows = filas.map(f => '<tr data-n="' + f.n + '">' + m.cols.map(c =>
      '<td class="' + (c.t === 'num' || c.t === 'pct' || c.t === 'int' ? 'r' : '') + '">' + celda(m, c, f.v[c.k], f.v) + '</td>').join('') + '</tr>').join('');
    cuerpo = '<div class="card tablewrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  const encabezado = enReglas
    ? '<div><button class="mini" id="volver">← Volver a Importar</button><h1 style="margin-top:14px">Reglas de Importacion</h1></div>'
    : '<div><h1>DDMM</h1></div>';

  $('page').innerHTML =
    encabezado + avisosHtml() + revisionesHtml() +
    (enReglas ? '' : '<div class="pills">' + pills + '</div>') +
    '<div class="toolbar"><div class="search"><span class="lupa"></span><input id="q" placeholder="Buscar…" value="' + esc(S.q) + '"></div>' +
    '<button class="btn primary" id="nuevo">+ Agregar</button>' +
    '<span class="count">' + filas.length + ' de ' + (d.filas || []).length + ' en ' + esc(m.titulo) + '</span></div>' + cuerpo;

  $('page').querySelectorAll('.pill').forEach(b => b.onclick = () => { S.id = b.dataset.id; S.q = ''; store.set('maestro', S.id); renderPage(); });
  if ($('volver')) $('volver').onclick = () => irVista('importar');
  const qi = $('q');
  qi.oninput = () => { S.q = qi.value; const pos = qi.selectionStart; renderPage(); const n = $('q'); n.focus(); n.setSelectionRange(pos, pos); };
  $('nuevo').onclick = () => abrir(null);
  $('page').querySelectorAll('tbody tr').forEach(tr => tr.onclick = () => abrir(Number(tr.dataset.n)));
  $('page').querySelectorAll('[data-fix]').forEach(b => b.onclick = () => corregir(Number(b.dataset.fix)));
  $('page').querySelectorAll('[data-ir]').forEach(b => b.onclick = () => irA(Number(b.dataset.ir)));
}

function avisosHtml() {
  return S.avisos.map(a => '<div class="aviso">' + esc(a) + '</div>').join('');
}

function revisionesHtml() {
  if (!S.rev.length) return '';
  const items = S.rev.map((r, i) => {
    const m = S.byId[r.maestro];
    const donde = esc(m ? m.titulo : r.hoja) + (r.fila ? ' · fila ' + r.fila : '') + (r.nombre ? ' · <b>' + esc(r.nombre) + '</b>' : '');
    return '<li><div class="t"><span class="mut">' + donde + '</span><br>' + esc(r.msg) + '</div>' +
      (r.fix ? '<button class="mini fix" data-fix="' + i + '">Corregir a “' + esc(r.fix) + '”</button>' : '') +
      (r.fila ? '<button class="mini" data-ir="' + i + '">Abrir</button>' : '') + '</li>';
  }).join('');
  return '<details class="card rev" ' + (S.rev.length <= 4 ? 'open' : '') + '><summary><span class="n">' + S.rev.length +
    '</span> cosas para revisar en tus datos</summary><ul>' + items + '</ul></details>';
}

function irA(i) {
  const r = S.rev[i];
  S.vista = r.maestro === 'reglas' ? 'reglas' : 'maestros';
  S.id = r.maestro; S.q = ''; renderTabs(); renderPage(); abrir(r.fila);
}

async function corregir(i) {
  const r = S.rev[i];
  try {
    aplicar(await llamar('aplicarCorreccion', r.hoja, r.fila, r.col, r.de, r.fix));
    toast('Corregido');
  } catch (e) { toast(e.message || 'No se pudo corregir'); }
}

function aplicar(res) { S.data = res.data; S.rev = res.revisiones; S.avisos = []; render(); }

// ---------- formulario ----------
function claves(id, filtro) {
  const m = S.byId[id];
  return ((S.data[id] || {}).filas || [])
    .filter(f => !filtro || f.v['Fijo/Variable'] === filtro)
    .map(f => ({ v: String(f.v[m.clave]), act: !m.estado || f.v[m.estado] !== 'Inactivo', mon: f.v.Moneda }));
}

function opcionesRef(c, vals) {
  const ids = c.ref || (c.refSegun && c.refSegun[vals[c.refSegun.col]]) || [];
  let ops = [];
  ids.forEach(id => { ops = ops.concat(claves(id, c.filtro)); });
  (c.especiales || []).forEach(v => ops.push({ v: v, act: true }));
  if (c.filtraMoneda && vals.Moneda) {
    const mon = vals.Moneda === 'UVA' ? 'ARS' : vals.Moneda;
    ops = ops.filter(o => !o.mon || o.mon === mon);
  }
  ops = ops.filter(o => o.act || o.v === vals[c.k]);
  return Array.from(new Set(ops.map(o => o.v)));
}

function abrir(n) {
  const m = S.byId[S.id];
  const fila = n ? S.data[S.id].filas.filter(f => f.n === n)[0] : null;
  if (n && !fila) return;
  const vals = {};
  m.cols.forEach(c => {
    vals[c.k] = fila ? fila.v[c.k] : (c.def !== undefined ? c.def : '');
  });
  S.form = { n: n, orig: fila ? String(fila.v[m.clave]) : null, vals: vals, confirmaBorrar: false };
  renderForm();
}

function renderForm() {
  const m = S.byId[S.id], F = S.form, nuevo = !F.n;
  const campos = m.cols.map(c => {
    const etiqueta = esc(c.label || c.k) + (c.req ? ' <b>*</b>' : '');
    let input;
    if (c.derivada) {
      input = '<input class="in" readonly value="' + esc(F.vals[c.k]) + '">';
    } else if (c.t === 'enum') {
      input = '<select class="in" data-k="' + esc(c.k) + '">' + (c.req ? '' : '<option value=""></option>') +
        c.opts.map(o => '<option ' + (o === F.vals[c.k] ? 'selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    } else if (c.t === 'ref') {
      input = '<select class="in" data-k="' + esc(c.k) + '" data-ref="1"></select>';
    } else {
      const modo = c.t === 'text' || c.t === 'diaofecha' ? 'text' : 'decimal';
      input = '<input class="in" data-k="' + esc(c.k) + '" inputmode="' + modo + '" autocomplete="off" value="' +
        esc(c.t === 'diaofecha' && /^\d{4}-/.test(F.vals[c.k]) ? fechaCorta(F.vals[c.k]) : F.vals[c.k]) + '">';
    }
    return '<label class="f">' + etiqueta + input + (c.ayuda ? '<div class="ayuda">' + esc(c.ayuda) + '</div>' : '') + '</label>';
  }).join('');

  const acciones =
    (!nuevo && m.estado ? '<button class="btn" id="estado">' + (F.vals[m.estado] === 'Activo' ? 'Desactivar' : 'Activar') + '</button>' : '') +
    (!nuevo ? '<button class="btn danger" id="borrar">' + (F.confirmaBorrar ? 'Tocá de nuevo para eliminar' : 'Eliminar') + '</button>' : '');

  $('modal').innerHTML =
    '<div class="overlay" id="ov"><div class="panel"><header><h2>' + (nuevo ? 'Agregar · ' : 'Editar · ') + esc(m.titulo) +
    '</h2><button class="x" id="cerrar" aria-label="Cerrar">×</button></header>' +
    '<div class="body" id="body"><div id="err"></div>' + campos + '</div>' +
    '<footer><button class="btn primary" id="guardar">Guardar</button>' + acciones + '</footer></div></div>';
  $('modal').classList.remove('hide');
  refrescarRefs();

  $('ov').onclick = e => { if (e.target.id === 'ov') cerrar(); };
  $('cerrar').onclick = cerrar;
  $('body').querySelectorAll('[data-k]').forEach(el => {
    el.onchange = el.oninput = () => {
      F.vals[el.dataset.k] = el.value;
      if (el.tagName === 'SELECT' && !el.dataset.ref) refrescarRefs();
    };
  });
  $('guardar').onclick = guardar;
  if ($('estado')) $('estado').onclick = cambiarEstado;
  if ($('borrar')) $('borrar').onclick = borrar;
}

function refrescarRefs() {
  const m = S.byId[S.id], F = S.form;
  m.cols.filter(c => c.t === 'ref').forEach(c => {
    const el = $('body').querySelector('[data-k="' + c.k.replace(/"/g, '') + '"]');
    if (!el) return;
    const ops = opcionesRef(c, F.vals);
    let actual = F.vals[c.k];
    if (actual && ops.indexOf(actual) < 0 && !F.n) actual = '';
    el.innerHTML = (c.req && actual ? '' : '<option value=""></option>') +
      ops.map(o => '<option ' + (o === actual ? 'selected' : '') + '>' + esc(o) + '</option>').join('') +
      (actual && ops.indexOf(actual) < 0 ? '<option selected>' + esc(actual) + '</option>' : '');
    F.vals[c.k] = el.value;
  });
}

function cerrar() { $('modal').classList.add('hide'); $('modal').innerHTML = ''; S.form = null; }

function mostrarError(msg) {
  const e = $('err');
  if (e) { e.innerHTML = '<div class="errbox">' + esc(msg) + '</div>'; $('body').scrollTop = 0; }
}

async function guardar() {
  const F = S.form, m = S.byId[S.id];
  $('guardar').disabled = true;
  try {
    aplicar(await llamar('guardarFila', m.hoja, F.n, F.orig, F.vals));
    cerrar(); toast('Guardado');
  } catch (e) { mostrarError(e.message || 'No se pudo guardar'); $('guardar').disabled = false; }
}

async function cambiarEstado() {
  const F = S.form, m = S.byId[S.id];
  try {
    aplicar(await llamar('cambiarEstado', m.hoja, F.n, F.orig, F.vals[m.estado] === 'Activo' ? 'Inactivo' : 'Activo'));
    cerrar(); toast('Actualizado');
  } catch (e) { mostrarError(e.message || 'No se pudo cambiar el estado'); }
}

async function borrar() {
  const F = S.form, m = S.byId[S.id];
  if (!F.confirmaBorrar) { F.confirmaBorrar = true; $('borrar').textContent = 'Tocá de nuevo para eliminar'; return; }
  try {
    aplicar(await llamar('eliminarFila', m.hoja, F.n, F.orig));
    cerrar(); toast('Eliminado');
  } catch (e) { F.confirmaBorrar = false; $('borrar').textContent = 'Eliminar'; mostrarError(e.message || 'No se pudo eliminar'); }
}

// ---------- Importar resumen ----------
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const I = {};
function resetImp() {
  Object.assign(I, { a: null, texto: '', dec: {}, filtro: 'todos', q: '', tarjeta: '', historico: true,
    importarIgual: false, resultado: null, cargando: '', error: '', archivo: null, pideClave: false });
}
resetImp();

function cargarPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = PDFJS + 'pdf.min.js';
    s.onload = async () => {
      try {
        const t = await (await fetch(PDFJS + 'pdf.worker.min.js')).text();
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([t], { type: 'text/javascript' }));
      } catch (e) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; }
      ok();
    };
    s.onerror = () => no(new Error('No se pudo cargar el lector de PDF. ¿Tenés internet?'));
    document.head.appendChild(s);
  });
}

/** Devuelve el texto del PDF, una línea por cada renglón visual, en el orden en que está dibujado. */
async function extraerTexto(buffer, clave) {
  const doc = await pdfjsLib.getDocument({ data: buffer, password: clave || undefined, isEvalSupported: false }).promise;
  const lineas = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    let fila = [], y = null, finPrevio = null;
    const cortar = () => {
      const t = fila.join('').replace(/\s+/g, ' ').trim();
      if (t) lineas.push(t);
      fila = []; finPrevio = null;
    };
    tc.items.forEach(it => {
      if (!it.str) return;
      const x = it.transform[4], yy = it.transform[5], tam = Math.abs(it.transform[0]) || 10;
      if (!it.str.trim()) { if (fila.length) fila.push(' '); finPrevio = x + it.width; return; }
      if (y !== null && Math.abs(yy - y) > 2.5) cortar();
      y = yy;
      // Las letras con tilde llegan como elementos separados y pegados: solo se agrega espacio si hay un hueco real.
      if (fila.length && finPrevio !== null && !/\s$/.test(fila[fila.length - 1]) && !/^\s/.test(it.str) && (x - finPrevio) > tam * 0.15) fila.push(' ');
      fila.push(it.str);
      finPrevio = x + it.width;
    });
    cortar();
  }
  return lineas.join('\n');
}

const textoSugerido = desc => String(desc).split(/\s+C\.\d{2}\/\d{2}|\d{5,}/)[0].trim().slice(0, 28).trim();
const esSinCat = f => f.clase !== 'pago' && !f.dup && !I.dec[f.i].omitir && !I.dec[f.i].sub && !I.dec[f.i].asig;

function prepararDecisiones() {
  I.dec = {};
  I.a.filas.forEach(f => {
    I.dec[f.i] = { omitir: f.dup, sub: f.sug ? f.sug.subcategoria : '', asig: f.sug ? f.sug.asignarA : '', rec: false, txt: textoSugerido(f.desc) };
  });
  I.tarjeta = I.a.tarjetas.length ? I.a.tarjetas[0].numero : '';
}

async function leerArchivo(file, clave) {
  I.error = ''; I.a = null; I.resultado = null; I.pideClave = false; I.archivo = file;
  I.cargando = 'Leyendo el PDF…'; renderImportar();
  try {
    await cargarPdfJs();
    I.texto = await extraerTexto(await file.arrayBuffer(), clave);
    I.cargando = 'Analizando el resumen…'; renderImportar();
    I.a = await llamar('analizarResumen', I.texto);
    prepararDecisiones();
  } catch (e) {
    if (e && e.name === 'PasswordException') { I.pideClave = true; I.error = e.code === 2 ? 'La clave no es correcta.' : 'Este PDF tiene clave. Ingresala para abrirlo (no se guarda).'; }
    else I.error = (e && e.message) || String(e);
  }
  I.cargando = ''; renderImportar();
}

function renderImportar() {
  let cuerpo;
  if (I.cargando) cuerpo = '<div class="aviso mut" style="font-weight:400">' + esc(I.cargando) + '</div>';
  else if (I.resultado) cuerpo = htmlResultado();
  else if (I.a) cuerpo = htmlRevision();
  else cuerpo = htmlInicio();
  $('page').innerHTML =
    '<div><h1>Importar resumen</h1></div>' +
    (I.error ? '<div class="aviso">' + esc(I.error) + '</div>' : '') + cuerpo;
  enlazarImportar();
}

function htmlInicio() {
  const nReglas = ((S.data.reglas || {}).filas || []).length;
  return '<label class="drop" id="drop"><input type="file" id="pdf" accept="application/pdf,.pdf">' +
    '<b>Elegí el PDF del resumen</b><span class="mut" style="font-weight:400">o arrastralo hasta acá</span></label>' +
    (I.pideClave ? '<div class="card opts"><input class="in" id="clave" type="password" placeholder="Clave del PDF" style="max-width:240px;margin:0">' +
      '<button class="btn primary" id="abrirclave">Abrir</button></div>' : '') +
    '<div class="mut" style="font-weight:400;font-size:13px">Las reglas que clasifican los renglones solos están en ' +
    '<a href="#" id="verreglas" style="color:var(--text)">Ver reglas (' + nReglas + ')</a>.</div>';
}

function htmlResultado() {
  const r = I.resultado;
  return '<div class="card" style="padding:24px"><h2 style="margin:0 0 12px;font-size:20px;letter-spacing:-.02em">Listo, resumen importado</h2>' +
    '<div class="kpis">' +
    [['Importados', r.importados], ['Omitidos', r.omitidos], ['Ya estaban', r.duplicados], ['Reglas nuevas', r.reglasNuevas]].map(k =>
      '<div class="card kpi"><span class="l">' + k[0] + '</span><span class="v">' + k[1] + '</span></div>').join('') + '</div>' +
    '<p class="mut" style="font-weight:400;margin:16px 0 0">Quedaron guardados en la pestaña <b style="color:var(--text)">Movimientos</b> de tu planilla' +
    (r.historico ? ', marcados como histórico (no cambian saldos).' : '.') + '</p>' +
    '<div style="display:flex;gap:8px;margin-top:20px"><button class="btn primary" id="otro">Importar otro resumen</button>' +
    '<button class="btn" id="verreglas">Ver reglas</button></div></div>';
}

function htmlRevision() {
  const a = I.a, r = a.resumen, ok = r.controles.ok;
  const kpis = [
    ['Cierre', fechaCorta(r.cierre), 'Vence ' + fechaCorta(r.vencimiento), ''],
    ['Saldo del resumen', '$ ' + fmtNum(r.saldoActual.ars), 'US$ ' + fmtNum(r.saldoActual.usd), ''],
    ['Pago mínimo', '$ ' + fmtNum(r.pagoMinimo), a.filas.length + ' renglones leídos', ''],
    ['Controles', ok ? 'Cierran ✓' : 'No cierran ✗', ok ? 'Consumos y saldo coinciden con el resumen' : 'Revisá antes de importar', ok ? 'ok' : 'bad'],
  ].map(k => '<div class="card kpi"><span class="l">' + k[0] + '</span><span class="v ' + k[3] + '">' + esc(k[1]) + '</span><span class="s">' + esc(k[2]) + '</span></div>').join('');

  const tarjetas = a.tarjetas.length
    ? (a.tarjetas.length > 1 ? '<label>Tarjeta <select class="in" id="tarjeta" style="width:auto;margin:0 0 0 8px">' +
      a.tarjetas.map(t => '<option value="' + esc(t.numero) + '" ' + (t.numero === I.tarjeta ? 'selected' : '') + '>' + esc(t.ARS || t.USD) + '</option>').join('') + '</select></label>'
      : '<span class="mut" style="font-weight:400">Tarjeta: <b style="color:var(--text)">' + esc(a.tarjetas[0].ARS || a.tarjetas[0].USD) + '</b></span>')
    : '<span class="bad">No hay una tarjeta cargada en DDMM.</span>';

  return '<div class="kpis">' + kpis + '</div>' + htmlOmitidas() +
    '<div class="card opts">' + tarjetas +
    '<label><input type="checkbox" id="hist" ' + (I.historico ? 'checked' : '') + '> Importar como histórico (no cambia saldos)</label>' +
    (ok ? '' : '<label class="bad"><input type="checkbox" id="igual" ' + (I.importarIgual ? 'checked' : '') + '> Importar igual, aunque no cierre</label>') + '</div>' +
    '<div class="toolbar"><button class="pill ' + (I.filtro === 'todos' ? 'on' : '') + '" data-f="todos">Todos <small>' + a.filas.length + '</small></button>' +
    '<button class="pill ' + (I.filtro === 'sin' ? 'on' : '') + '" data-f="sin" id="chip-sin">Sin categorizar</button>' +
    '<button class="pill ' + (I.filtro === 'dup' ? 'on' : '') + '" data-f="dup">Ya importados <small>' + a.filas.filter(f => f.dup).length + '</small></button>' +
    '<div class="search" style="margin-left:8px"><span class="lupa"></span><input id="iq" placeholder="Buscar…" value="' + esc(I.q) + '"></div></div>' +
    '<div class="card tablewrap" id="imptabla"></div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary" id="impconf">Importar</button>' +
    '<button class="btn" id="otro">Cancelar</button><a href="#" id="verreglas" class="mut" style="margin-left:auto;color:var(--muted)">Ver reglas</a></div>';
}

function htmlOmitidas() {
  const o = (I.a && I.a.omitidas) || [];
  if (!o.length) return '';
  return '<div class="mut" style="font-weight:400;font-size:13px">Omitidos por regla (' + o.length + '): ' +
    o.map(x => esc(x.texto) + ' · ' + esc(fmtMoney(x.monto, x.moneda))).join(' · ') + '</div>';
}

function agrupadasGastos() {
  const g = {}, orden = [];
  S.data.gastos.filas.forEach(f => {
    if (!g[f.v.Categoria]) { g[f.v.Categoria] = []; orden.push(f.v.Categoria); }
    g[f.v.Categoria].push(f.v.Subcategoria);
  });
  return orden.map(c => [c, g[c]]);
}

const op = (v, actual, txt) => '<option value="' + esc(v) + '" ' + (v === actual ? 'selected' : '') + '>' + esc(txt === undefined ? v : txt) + '</option>';

function selSub(f, actual) {
  const grupos = f.clase === 'credito'
    ? [['Tipos de ingreso', S.data.ingresos.filas.map(x => x.v['Tipo de Ingreso'])]] : agrupadasGastos();
  return '<select class="in" data-k="sub">' + op('', actual, '(sin categorizar)') +
    grupos.map(g => '<optgroup label="' + esc(g[0]) + '">' + g[1].map(s => op(s, actual)).join('') + '</optgroup>').join('') + '</select>';
}

function selAsig(actual) {
  const act = id => S.data[id].filas.filter(f => f.v.Estado !== 'Inactivo');
  const fijos = act('fijos').filter(f => f.v.Movimiento === 'Gasto').map(f => f.v.Nombre);
  const deudas = act('deudas').map(f => f.v.Nombre);
  return '<select class="in" data-k="asig">' + op('', actual, '—') +
    '<optgroup label="Fijos">' + fijos.map(s => op(s, actual)).join('') + '</optgroup>' +
    '<optgroup label="Deudas">' + deudas.map(s => op(s, actual)).join('') + '</optgroup></select>';
}

function filaImp(f) {
  const d = I.dec[f.i];
  const monto = (f.moneda === 'USD' ? 'US$ ' : '$ ') + fmtNum(f.monto);
  const comun = '<td class="mono mut">' + esc(fechaCorta(f.fecha).slice(0, 5)) + '</td><td>' + esc(f.desc) +
    (f.cuota ? ' <span class="tag">cuota ' + esc(f.cuota) + '</span>' : '') + (f.dup ? ' <span class="tag">ya importado</span>' : '') +
    '</td><td class="r mono">' + esc(monto) + '</td>';
  const omitir = '<td><label class="rec"><input type="checkbox" data-k="omitir" ' + (d.omitir ? 'checked' : '') + (f.dup ? ' disabled' : '') + '> Omitir</label></td>';
  if (f.clase === 'pago') {
    return '<tr class="pago ' + (f.dup ? 'dup' : '') + '" data-i="' + f.i + '">' + comun +
      '<td colspan="3"><span class="tag">pago del resumen</span> <span class="mut" style="font-weight:400">se registra como transferencia desde la cuenta de pago</span></td>' + omitir + '</tr>';
  }
  return '<tr class="' + (f.dup ? 'dup ' : '') + (esSinCat(f) ? 'sin' : '') + '" data-i="' + f.i + '">' + comun +
    '<td>' + selSub(f, d.sub) + '</td><td>' + selAsig(d.asig) + '</td>' +
    '<td><label class="rec"><input type="checkbox" data-k="rec" ' + (d.rec ? 'checked' : '') + '> Recordar</label>' +
    '<input class="in ' + (d.rec ? '' : 'hide') + '" data-k="txt" value="' + esc(d.txt) + '" style="margin-top:6px"></td>' + omitir + '</tr>';
}

function renderTablaImp() {
  const q = I.q.trim().toLowerCase();
  const filas = I.a.filas.filter(f =>
    (I.filtro === 'todos' || (I.filtro === 'sin' && esSinCat(f)) || (I.filtro === 'dup' && f.dup)) &&
    (!q || (f.desc + ' ' + f.fecha).toLowerCase().indexOf(q) >= 0));
  $('imptabla').innerHTML = filas.length
    ? '<table class="imp"><thead><tr><th>Fecha</th><th>Descripción</th><th class="r">Monto</th><th>Categoría</th><th>Asignar a</th><th>Recordar</th><th></th></tr></thead><tbody>' +
      filas.map(filaImp).join('') + '</tbody></table>'
    : '<div class="vacio">Nada para mostrar con este filtro</div>';
}

function actualizarContadores() {
  const a = I.a;
  const nSin = a.filas.filter(esSinCat).length;
  const aImportar = a.filas.filter(f => !I.dec[f.i].omitir && !f.dup).length;
  const chip = $('chip-sin'); if (chip) chip.innerHTML = 'Sin categorizar <small>' + nSin + '</small>';
  const b = $('impconf');
  if (b && !b.dataset.busy) {
    b.textContent = 'Importar ' + aImportar + (aImportar === 1 ? ' renglón' : ' renglones');
    b.disabled = !aImportar || !I.tarjeta || (!a.resumen.controles.ok && !I.importarIgual);
  }
}

async function confirmarImp() {
  const decisiones = I.a.filas.map(f => {
    const d = I.dec[f.i];
    return { i: f.i, accion: d.omitir ? 'omitir' : 'importar', subcategoria: d.sub, asignarA: d.asig, recordar: d.rec ? d.txt : '' };
  });
  const b = $('impconf'); b.dataset.busy = '1'; b.disabled = true; b.textContent = 'Importando…';
  I.error = '';
  try {
    const res = await llamar('confirmarImportacion', I.texto, I.tarjeta, decisiones, { historico: I.historico, importarIgual: I.importarIgual });
    S.data = res.data; S.rev = res.revisiones; M.movs = null;
    I.resultado = { importados: res.importados, omitidos: res.omitidos, duplicados: res.duplicados, reglasNuevas: res.reglasNuevas, historico: I.historico };
  } catch (e) { I.error = (e && e.message) || 'No se pudo importar'; }
  renderImportar();
  if (I.error) window.scrollTo(0, 0);
}

function enlazarImportar() {
  const pg = $('page');
  const f = $('pdf');
  if (f) {
    f.onchange = () => { if (f.files[0]) leerArchivo(f.files[0]); };
    const z = $('drop');
    ['dragenter', 'dragover'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove('over'); }));
    z.addEventListener('drop', e => { if (e.dataTransfer.files[0]) leerArchivo(e.dataTransfer.files[0]); });
  }
  if ($('abrirclave')) $('abrirclave').onclick = () => leerArchivo(I.archivo, $('clave').value);
  if ($('verreglas')) $('verreglas').onclick = e => { e.preventDefault(); irVista('reglas'); };
  if ($('otro')) $('otro').onclick = () => { resetImp(); renderImportar(); };
  if (!I.a || I.resultado) return;

  renderTablaImp(); actualizarContadores();
  pg.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { I.filtro = b.dataset.f; renderImportar(); });
  const iq = $('iq');
  iq.oninput = () => { I.q = iq.value; renderTablaImp(); };
  if ($('tarjeta')) $('tarjeta').onchange = e => { I.tarjeta = e.target.value; actualizarContadores(); };
  $('hist').onchange = e => { I.historico = e.target.checked; };
  if ($('igual')) $('igual').onchange = e => { I.importarIgual = e.target.checked; actualizarContadores(); };
  $('impconf').onclick = confirmarImp;
  const manejar = e => {
    const tr = e.target.closest('tr'), k = e.target.dataset.k;
    if (!tr || !k) return;
    const d = I.dec[tr.dataset.i], fila = I.a.filas[Number(tr.dataset.i)];
    if (k === 'sub') d.sub = e.target.value;
    if (k === 'asig') d.asig = e.target.value;
    if (k === 'omitir') d.omitir = e.target.checked;
    if (k === 'txt') d.txt = e.target.value;
    if (k === 'rec') { d.rec = e.target.checked; tr.querySelector('[data-k="txt"]').classList.toggle('hide', !d.rec); }
    tr.classList.toggle('sin', esSinCat(fila));
    actualizarContadores();
  };
  $('imptabla').addEventListener('change', manejar);
  $('imptabla').addEventListener('input', manejar);
}

// ---------- Movimientos ----------
const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const COLORES_CAT = ['#F2EFEB', '#C62F2B', '#E5574F', '#8C2A25', '#8A847E', '#5E5955', '#3A3634'];
const M = { movs: null, periodo: '', q: '', cuentas: [], tipo: '', cat: '', campo: 'fecha', desc: true, limite: 120, edit: null };

const nombreMes = ym => MESES_CORTO[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
const mesesDe = lista => Array.from(new Set(lista.map(m => m.fecha.slice(0, 7)))).sort().reverse();
const sumaMov = lista => lista.reduce((s, m) => s + m.monto, 0);

async function cargarMovs() {
  mostrarLoader();
  try {
    M.movs = (await llamar('listarMovimientos')).movimientos;
    const meses = mesesDe(M.movs);
    if (M.periodo !== 'todo' && M.periodo !== 'anio' && meses.indexOf(M.periodo) < 0) M.periodo = meses[0] || 'todo';
  } catch (e) { toast((e && e.message) || 'No se pudieron cargar los movimientos'); M.movs = []; }
  ocultarLoader();
  if (S.vista === 'movs') renderMovs();
}

function mapasGastos() {
  const cat = {}, nat = {};
  S.data.gastos.filas.forEach(f => { cat[f.v.Subcategoria] = f.v.Categoria; nat[f.v.Subcategoria] = f.v.Naturaleza; });
  return { cat, nat };
}

function enPeriodo(m, anio) {
  if (M.periodo === 'todo') return true;
  if (M.periodo === 'anio') return m.fecha.slice(0, 4) === anio;
  return m.fecha.slice(0, 7) === M.periodo;
}

function renderMovs() {
  if (M.movs === null) { cargarMovs(); return; }
  if (!M.movs.length) {
    $('page').innerHTML = '<div><h1>Movimientos</h1></div><div class="card vacio">Todavía no hay movimientos. Importá un resumen desde <b style="color:var(--text)">Importar</b>.' +
      '<div style="margin-top:16px"><button class="btn primary" id="irimp">Ir a Importar</button></div></div>';
    $('irimp').onclick = () => irVista('importar');
    return;
  }
  const meses = mesesDe(M.movs), anio = meses[0].slice(0, 4);
  const { cat: catDe, nat: natDe } = mapasGastos();
  const categoriaDe = m => m.tipo === 'Gasto' ? (catDe[m.subcategoria] || 'Otros') : '';

  const base = M.movs.filter(m => enPeriodo(m, anio));
  const gastos = base.filter(m => m.tipo === 'Gasto');
  const gARS = gastos.filter(m => m.moneda === 'ARS'), gUSD = gastos.filter(m => m.moneda === 'USD');
  const totARS = sumaMov(gARS);
  const presc = sumaMov(gARS.filter(m => natDe[m.subcategoria] === 'Prescindible'));
  const deuda = sumaMov(gARS.filter(m => natDe[m.subcategoria] === 'Deuda'));

  // categorías para el gráfico: las 6 mayores y el resto junto
  const porCat = {};
  gARS.forEach(m => { const c = categoriaDe(m); porCat[c] = (porCat[c] || 0) + m.monto; });
  let cats = Object.keys(porCat).map(n => ({ n, total: porCat[n] })).sort((a, b) => b.total - a.total);
  const otras = new Set();
  if (cats.length > 7) {
    const resto = cats.slice(6);
    resto.forEach(c => otras.add(c.n));
    cats = cats.slice(0, 6).concat([{ n: 'Otras', total: resto.reduce((s, c) => s + c.total, 0) }]);
  }
  cats.forEach((c, i) => { c.color = COLORES_CAT[Math.min(i, COLORES_CAT.length - 1)]; });
  const colorDeCat = n => { const c = cats.find(x => x.n === n) || cats.find(x => x.n === 'Otras'); return c ? c.color : COLORES_CAT[6]; };
  const grupoCat = m => { const c = categoriaDe(m); return otras.has(c) ? 'Otras' : c; };
  if (M.cat && !cats.some(c => c.n === M.cat)) M.cat = '';

  let acum = 0;
  const donut = totARS ? 'conic-gradient(' + cats.map(c => { const a = acum; acum += c.total / totARS * 100; return c.color + ' ' + a + '% ' + acum + '%'; }).join(',') + ')' : 'var(--surface-2)';
  const sel = cats.find(c => c.n === M.cat);

  // filtros de la tabla
  const q = M.q.trim().toLowerCase();
  const filas = base.filter(m =>
    (!M.cuentas.length || M.cuentas.indexOf(m.cuenta) >= 0) && (!M.tipo || m.tipo === M.tipo) &&
    (!M.cat || (m.tipo === 'Gasto' && grupoCat(m) === M.cat)) &&
    (!q || (m.desc + ' ' + m.subcategoria + ' ' + m.cuenta + ' ' + m.asignado).toLowerCase().indexOf(q) >= 0));
  const sentido = d => (M.desc ? -1 : 1) * d;
  filas.sort((a, b) => M.campo === 'monto' ? sentido(a.monto - b.monto) : sentido(a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));

  const cuentasBase = Array.from(new Set(base.map(m => m.cuenta))).sort();
  const tiposBase = Array.from(new Set(base.map(m => m.tipo)));
  const neto = mon => filas.filter(m => m.moneda === mon).reduce((s, m) => s + (m.tipo === 'Ingreso' ? m.monto : m.tipo === 'Gasto' ? -m.monto : 0), 0);
  const netoARS = neto('ARS'), netoUSD = neto('USD');

  const periodos = meses.slice(0, 4).map(ym => [ym, nombreMes(ym)]).concat([['anio', 'Año ' + anio], ['todo', 'Todo']]);
  const kpi = (l, v, s, color) => '<div class="card kpi"><span class="l">' + l + '</span><span class="v" ' + (color ? 'style="color:' + color + '"' : '') + '>' + esc(v) + '</span><span class="s">' + esc(s) + '</span></div>';
  const chip = (activo, dato, txt) => '<button class="pill ' + (activo ? 'on' : '') + '" ' + dato + '>' + esc(txt) + '</button>';

  const leyenda = cats.length ? cats.map(c => '<div class="leg ' + (c.n === M.cat ? 'on' : '') + '" data-cat="' + esc(c.n) + '"><span class="sw" style="background:' + c.color + '"></span><span class="n">' + esc(c.n) +
    '</span><span class="mono">' + esc(fmtMoney(c.total, 'ARS')) + '</span><span class="mono mut pc">' + Math.round(c.total / totARS * 100) + '%</span></div>').join('')
    : '<div class="mut" style="font-weight:400">Sin gastos en pesos en este período</div>';

  const filasHtml = filas.slice(0, M.limite).map(m => {
    const esGasto = m.tipo === 'Gasto', esIng = m.tipo === 'Ingreso';
    const catTxt = esGasto ? esc(m.subcategoria) : (m.asignado ? '→ ' + esc(m.asignado) : (m.subcategoria ? esc(m.subcategoria) : '—'));
    return '<tr data-id="' + esc(m.id) + '"><td class="mono mut">' + esc(fechaCorta(m.fecha).slice(0, 5)) + '</td><td class="desc">' + esc(m.desc) +
      (m.cuota ? ' <span class="tag">cuota ' + esc(m.cuota) + '</span>' : '') + '</td><td><span class="dot" style="background:' + (esGasto ? colorDeCat(grupoCat(m)) : 'var(--border-strong)') + '"></span>' + catTxt +
      '</td><td class="mut cuentacol">' + esc(m.cuenta) + '</td><td class="mut tipocol">' + esc(m.tipo) + '</td><td class="r mono ' + (esGasto ? 'neg' : '') + '">' +
      (esGasto ? '− ' : esIng ? '+ ' : '') + esc(fmtMoney(m.monto, m.moneda)) + '</td></tr>';
  }).join('');

  const flecha = campo => M.campo === campo ? (M.desc ? ' ▼' : ' ▲') : '';
  const tabla = filas.length
    ? '<table class="movt"><thead><tr><th class="ord" data-ord="fecha">Fecha' + flecha('fecha') + '</th><th>Descripción</th><th>Categoría</th><th class="cuentacol">Cuenta</th><th class="tipocol">Tipo</th><th class="r ord neg" data-ord="monto">Monto' + flecha('monto') + '</th></tr></thead><tbody>' + filasHtml + '</tbody></table>' +
      (filas.length > M.limite ? '<div style="padding:14px;text-align:center"><button class="btn" id="mas">Mostrar más (' + (filas.length - M.limite) + ')</button></div>' : '') +
      '<div class="neto"><span class="mut">Neto filtrado</span><span class="mono">' + (netoARS < 0 ? '− ' : '+ ') + esc(fmtMoney(Math.abs(netoARS), 'ARS')) + (netoUSD ? '  ·  ' + (netoUSD < 0 ? '− ' : '+ ') + esc(fmtMoney(Math.abs(netoUSD), 'USD')) : '') + '</span></div>'
    : '<div class="vacio">Sin movimientos para estos filtros<div style="margin-top:14px"><button class="btn" id="limpiar">Limpiar filtros</button></div></div>';

  $('page').innerHTML =
    '<div class="titulo-fila"><h1>Movimientos</h1><div class="seg">' + periodos.map(p => '<button class="' + (M.periodo === p[0] ? 'on' : '') + '" data-per="' + p[0] + '">' + esc(p[1]) + '</button>').join('') + '</div></div>' +
    '<div class="kpis">' + kpi('Gastos', fmtMoney(totARS, 'ARS'), gARS.length + ' movimientos en pesos', 'var(--danger)') + kpi('Gastos en dólares', fmtMoney(sumaMov(gUSD), 'USD'), gUSD.length + ' movimientos') +
      kpi('Prescindible', (totARS ? Math.round(presc / totARS * 100) : 0) + '%', fmtMoney(presc, 'ARS') + ' del gasto en pesos') + kpi('Costo de deuda', fmtMoney(deuda, 'ARS'), 'intereses, comisiones y cuotas') + '</div>' +
    '<div class="card donutbox"><div class="donut" style="background:' + donut + '"><div class="hole"><span class="mut" style="font-size:12px;font-weight:400">' + esc(sel ? sel.n : 'Gastos') +
      '</span><span class="mono" style="font-size:16px;font-weight:600">' + esc(fmtMoney(sel ? sel.total : totARS, 'ARS')) + '</span></div></div><div class="legend">' + leyenda + '</div></div>' +
    '<div class="toolbar"><div class="search"><span class="lupa"></span><input id="mq" placeholder="Buscar…" value="' + esc(M.q) + '"></div>' +
      cuentasBase.map(c => chip(M.cuentas.indexOf(c) >= 0, 'data-cta="' + esc(c) + '"', c)).join('') +
      tiposBase.map(t => chip(M.tipo === t, 'data-tipo="' + esc(t) + '"', t)).join('') +
      (M.cat ? '<button class="pill rojo" id="quitacat">' + esc(M.cat) + ' ×</button>' : '') +
      '<span class="count">' + filas.length + ' de ' + base.length + ' movimientos</span></div>' +
    '<div class="card tablewrap">' + tabla + '</div>';

  const pg = $('page');
  pg.querySelectorAll('[data-per]').forEach(b => b.onclick = () => { M.periodo = b.dataset.per; M.cat = ''; M.limite = 120; renderMovs(); });
  pg.querySelectorAll('.leg').forEach(l => l.onclick = () => { M.cat = M.cat === l.dataset.cat ? '' : l.dataset.cat; M.limite = 120; renderMovs(); });
  pg.querySelectorAll('[data-cta]').forEach(b => b.onclick = () => { const c = b.dataset.cta, i = M.cuentas.indexOf(c); if (i >= 0) M.cuentas.splice(i, 1); else M.cuentas.push(c); renderMovs(); });
  pg.querySelectorAll('[data-tipo]').forEach(b => b.onclick = () => { M.tipo = M.tipo === b.dataset.tipo ? '' : b.dataset.tipo; renderMovs(); });
  pg.querySelectorAll('[data-ord]').forEach(h => h.onclick = () => { if (M.campo === h.dataset.ord) M.desc = !M.desc; else { M.campo = h.dataset.ord; M.desc = true; } renderMovs(); });
  if ($('quitacat')) $('quitacat').onclick = () => { M.cat = ''; renderMovs(); };
  if ($('mas')) $('mas').onclick = () => { M.limite += 200; renderMovs(); };
  if ($('limpiar')) $('limpiar').onclick = () => { M.q = ''; M.cuentas = []; M.tipo = ''; M.cat = ''; renderMovs(); };
  pg.querySelectorAll('tbody tr').forEach(tr => tr.onclick = () => abrirMov(tr.dataset.id));
  const mq = $('mq');
  mq.oninput = () => { M.q = mq.value; const p = mq.selectionStart; renderMovs(); const n = $('mq'); n.focus(); n.setSelectionRange(p, p); };
}

// ----- editar un movimiento -----
function abrirMov(id) {
  const m = M.movs.find(x => x.id === id);
  if (!m) return;
  M.edit = { id, m, sub: m.subcategoria === 'Sin categorizar' ? '' : m.subcategoria, asig: m.asignado, rec: false, par: true, txt: textoSugerido(m.desc), borrar: false };
  renderEditMov();
}

function renderEditMov() {
  const E = M.edit, m = E.m;
  const editable = ['Gasto', 'Adelanto', 'Pago Deuda'].indexOf(m.tipo) >= 0;
  const dato = (l, v) => '<div class="dato"><span class="mut">' + l + '</span><span>' + esc(v) + '</span></div>';
  const campos = editable
    ? '<label class="f">Categoría' + selSub({ clase: 'consumo' }, E.sub) + '<div class="ayuda">Si asignás a una deuda o a un fijo, la categoría puede quedar vacía.</div></label>' +
      '<label class="f">Asignar a' + selAsig(E.asig) + '<div class="ayuda">Una deuda hace que deje de contarse como gasto.</div></label>' +
      '<label class="f recl"><input type="checkbox" data-k="rec" ' + (E.rec ? 'checked' : '') + '> Recordar para próximos resúmenes</label>' +
      '<div id="recbox" class="' + (E.rec ? '' : 'hide') + '"><input class="in" data-k="txt" value="' + esc(E.txt) + '">' +
      '<label class="f recl"><input type="checkbox" data-k="par" ' + (E.par ? 'checked' : '') + '> Aplicar también a los “Sin categorizar” que contengan ese texto</label></div>'
    : '<div class="mut" style="margin-top:16px;font-weight:400">Los movimientos de tipo ' + esc(m.tipo) + ' no se recategorizan.</div>';
  $('modal').innerHTML = '<div class="overlay" id="ov"><div class="panel"><header><h2>Movimiento</h2><button class="x" id="cerrar" aria-label="Cerrar">×</button></header>' +
    '<div class="body" id="body"><div id="err"></div><div class="datos">' + dato('Fecha', fechaCorta(m.fecha)) + dato('Descripción', m.desc) + dato('Monto', fmtMoney(m.monto, m.moneda)) +
    dato('Cuenta', m.cuenta) + dato('Tipo', m.tipo) + (m.cuota ? dato('Cuota', m.cuota) : '') + dato('Origen', m.origen + (m.afecta === 'No' ? ' · histórico' : '')) + '</div>' + campos + '</div>' +
    '<footer>' + (editable ? '<button class="btn primary" id="guardarmov">Guardar</button>' : '') + '<button class="btn danger" id="borrarmov">' + (E.borrar ? 'Tocá de nuevo para eliminar' : 'Eliminar') + '</button></footer></div></div>';
  $('modal').classList.remove('hide');
  $('ov').onclick = e => { if (e.target.id === 'ov') cerrar(); };
  $('cerrar').onclick = cerrar;
  const manejar = e => {
    const k = e.target.dataset.k;
    if (!k) return;
    if (k === 'sub') E.sub = e.target.value;
    if (k === 'asig') E.asig = e.target.value;
    if (k === 'txt') E.txt = e.target.value;
    if (k === 'par') E.par = e.target.checked;
    if (k === 'rec') { E.rec = e.target.checked; $('recbox').classList.toggle('hide', !E.rec); }
  };
  $('body').addEventListener('change', manejar);
  $('body').addEventListener('input', manejar);
  if ($('guardarmov')) $('guardarmov').onclick = guardarMov;
  $('borrarmov').onclick = borrarMov;
}

async function guardarMov() {
  const E = M.edit;
  const b = $('guardarmov'); b.disabled = true;
  try {
    const res = await llamar('actualizarMovimiento', E.id, { subcategoria: E.sub, asignarA: E.asig, recordar: E.rec ? E.txt : '', aplicarParecidos: E.rec && E.par });
    M.movs = res.movimientos; S.data = res.data; S.rev = res.revisiones;
    cerrar(); renderMovs();
    toast(res.actualizados > 1 ? res.actualizados + ' movimientos actualizados' : 'Guardado' + (res.reglasNuevas ? ' · regla nueva' : ''));
  } catch (e) { mostrarError((e && e.message) || 'No se pudo guardar'); b.disabled = false; }
}

async function borrarMov() {
  const E = M.edit;
  if (!E.borrar) { E.borrar = true; $('borrarmov').textContent = 'Tocá de nuevo para eliminar'; return; }
  try {
    M.movs = (await llamar('eliminarMovimiento', E.id)).movimientos;
    cerrar(); renderMovs(); toast('Eliminado');
  } catch (e) { E.borrar = false; $('borrarmov').textContent = 'Eliminar'; mostrarError((e && e.message) || 'No se pudo eliminar'); }
}

// ---------- inicio ----------
llamar('iniciar').then(r => {
  S.schemas = r.schemas; S.data = r.data; S.rev = r.revisiones; S.avisos = r.avisos;
  S.schemas.forEach(s => { S.byId[s.id] = s; });
  const guardado = store.get('maestro');
  S.id = S.byId[guardado] && guardado !== 'reglas' ? guardado : S.schemas[0].id;
  S.vista = ['importar', 'movs'].indexOf(store.get('vista')) >= 0 ? store.get('vista') : 'maestros';
  renderTabs(); render();
  ocultarLoader();
}).catch(e => {
  $('page').innerHTML = '<div class="aviso">No se pudo cargar: ' + esc(e.message || e) + '</div>';
  ocultarLoader();
});

function ocultarLoader() {
  const l = $('loader');
  if (!l) return;
  l.style.opacity = '0';
  clearTimeout(ocultarLoader.h);
  ocultarLoader.h = setTimeout(() => l.classList.add('hide'), 220);
}

function mostrarLoader() {
  const l = $('loader');
  if (!l) return;
  clearTimeout(ocultarLoader.h);
  l.classList.remove('hide');
  l.style.opacity = '1';
}

document.getElementById('salir').onclick = salir;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* sin instalación: no pasa nada */ });
