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
try { TOKEN = localStorage.getItem('opus_token') || sessionStorage.getItem('opus_token') || ''; } catch (e) { /* sin almacenamiento */ }

// Sesión propia de 30 días que entrega el servidor después de entrar con Google (el pase de Google dura solo 1 hora).
let SESION = '';
try { SESION = localStorage.getItem('opus_sesion') || ''; } catch (e) { /* sin almacenamiento */ }
function guardarSesion(v) {
  SESION = v || '';
  try { if (SESION) localStorage.setItem('opus_sesion', SESION); else localStorage.removeItem('opus_sesion'); } catch (e) { /* sin almacenamiento */ }
}

function tokenVigente(t) {
  try {
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.exp * 1000 > Date.now() + 60000;
  } catch (e) { return false; }
}

function guardarToken(t) {
  TOKEN = t;
  try { if (t) localStorage.setItem('opus_token', t); else { localStorage.removeItem('opus_token'); sessionStorage.removeItem('opus_token'); } } catch (e) { /* sin almacenamiento */ }
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
  clearTimeout(mostrarLogin.h);
  guardarToken(resp.credential);
  document.getElementById('login').classList.add('hide');
  mostrarLoader();
  if (esperandoLogin) { esperandoLogin.resolver(); esperandoLogin = null; }
}

async function mostrarLogin() {
  // Primero se intenta entrar solo (Google recuerda la cuenta); si no se puede, aparece el botón.
  mostrarLoader();
  const login = document.getElementById('login');
  const msg = document.getElementById('loginmsg');
  msg.textContent = '';
  const verBoton = () => { if (esperandoLogin) { ocultarLoader(); login.classList.remove('hide'); } };
  clearTimeout(mostrarLogin.h); mostrarLogin.h = setTimeout(verBoton, 2500);
  try {
    await esperarGoogle();
    google.accounts.id.initialize({ client_id: CFG.clientId, callback: alRecibirCredencial, auto_select: true, use_fedcm_for_prompt: true });
    google.accounts.id.renderButton(document.getElementById('gbtn'),
      { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill', locale: 'es' });
    google.accounts.id.prompt();
  } catch (e) { msg.textContent = e.message; verBoton(); }
}

function salir() {
  guardarToken('');
  guardarSesion('');
  try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) { /* nada */ }
  location.reload();
}

async function enviar(fn, args) {
  let resp;
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 45000);
  try {
    resp = await fetch(CFG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(SESION ? { sesion: SESION, fn: fn, args: args } : { token: TOKEN, fn: fn, args: args }),
      signal: corte.signal,
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'El servidor tardó demasiado en responder.' : 'No se pudo conectar con el servidor. Revisá tu conexión.');
  } finally { clearTimeout(reloj); }
  let j;
  try { j = await resp.json(); } catch (e) { throw new Error('El servidor respondió algo inesperado. Probá de nuevo en un momento.'); }
  if (j.code === 'AUTH') { const err = new Error(j.error); err.auth = true; throw err; }
  if (j.error) throw new Error(j.error);
  if (j.sesion) guardarSesion(j.sesion);   // el servidor renueva la sesión solo cuando le queda poco
  return j.result;
}

let abriendoSesion = null;
/** Cambia el pase de Google (1 hora) por la sesión propia (30 días). Si no se puede, se sigue con el pase. */
function abrirSesion() {
  if (SESION) return Promise.resolve();
  if (!abriendoSesion) {
    abriendoSesion = enviar('crearSesion', [])
      .then(r => { if (r && r.sesion) guardarSesion(r.sesion); })
      .catch(() => { /* sin sesión propia: sigue funcionando con el pase de Google */ })
      .then(() => { abriendoSesion = null; });
  }
  return abriendoSesion;
}

async function llamarCore(fn, args) {
  if (!SESION && !tokenVigente(TOKEN)) await pedirLogin();
  await abrirSesion();
  try { return await enviar(fn, args); }
  catch (e) {
    if (!e.auth) throw e;
    guardarSesion(''); guardarToken('');
    await pedirLogin();
    await abrirSesion();
    return await enviar(fn, args);
  }
}

const MODIFICADORES = ['guardarFila', 'cambiarEstado', 'eliminarFila', 'aplicarCorreccion', 'confirmarImportacion',
  'registrarMovimiento', 'actualizarMovimiento', 'editarMovimiento', 'eliminarMovimiento', 'guardarPresupuestoMes', 'borrarPresupuestoMes', 'ajustarSaldos', 'guardarInversion', 'venderInversion', 'eliminarInversion'];

async function llamar(fn, ...args) {
  try {
    const r = await llamarCore(fn, args);
    if (MODIFICADORES.indexOf(fn) >= 0) invalidarTodo();
    return r;
  } finally { ocultarLoader(); }
}

const S = { schemas: [], byId: {}, data: {}, rev: [], avisos: [], id: null, q: '', form: null, vista: 'maestros' };

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hide');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hide'), 3200);
}

// ---------- formato ----------
const fmtNum = n => Number(n).toLocaleString('es-AR', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
// Selector ARS / USD del encabezado: '' = cada monto en su moneda; 'ARS' o 'USD' = todo convertido con el tipo de cambio.
let VISTA_MON = '';
try { VISTA_MON = localStorage.getItem('vista_mon') || ''; } catch (e) { /* sin almacenamiento */ }
// Modo privado: oculta todos los montos de la pantalla (el ojo del encabezado). Se acuerda de la elección.
let OCULTAR = false;
try { OCULTAR = localStorage.getItem('ocultar_saldos') === '1'; } catch (e) { /* sin almacenamiento */ }
const OJO_ABIERTO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const OJO_CERRADO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
// Modo claro / oscuro (tema.js lo deja aplicado antes de dibujar; acá se cambia y se guarda)
const SOL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const LUNA = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const temaActual = () => (document.documentElement.getAttribute('data-tema') === 'claro' ? 'claro' : 'oscuro');
function pintarBotonTema() {
  const b = $('tema');
  if (!b) return;
  const claro = temaActual() === 'claro';
  b.innerHTML = claro ? LUNA : SOL;   // el dibujo es el modo al que se pasa
  b.title = claro ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro';
  b.setAttribute('aria-label', b.title);
}
function cambiarTema() {
  const nuevo = temaActual() === 'claro' ? 'oscuro' : 'claro';
  document.documentElement.setAttribute('data-tema', nuevo);
  try { localStorage.setItem('tema', nuevo); } catch (e) { /* sin almacenamiento */ }
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', nuevo === 'claro' ? '#FFFFFF' : '#0F0E0E');
  pintarBotonTema();
  if (typeof hayEdicionAbierta === 'function' && !hayEdicionAbierta()) render();   // los gráficos toman los colores del modo
}
function aplicarOjo() {
  const b = $('ojo');
  if (!b) return;
  b.setAttribute('aria-pressed', OCULTAR ? 'true' : 'false');
  b.title = OCULTAR ? 'Mostrar saldos' : 'Ocultar saldos';
  b.setAttribute('aria-label', b.title);
  b.innerHTML = OCULTAR ? OJO_CERRADO : OJO_ABIERTO;
  document.body.classList.toggle('privado', OCULTAR);   // también difumina los campos que muestran un monto
}
function tcActual() { try { return tcEfectivo(); } catch (e) { return 0; } }
function convertir(n, mon) {
  const tc = tcActual();
  let cargando = false;
  try { cargando = S.vista === 'cargar'; } catch (e) { /* todavía no hay pantalla */ }
  if (!VISTA_MON || !tc || cargando) return { n: n, mon: mon };   // al cargar un movimiento los montos van siempre en su moneda
  if (VISTA_MON === 'USD' && mon === 'ARS') return { n: n / tc, mon: 'USD' };
  if (VISTA_MON === 'ARS' && mon === 'USD') return { n: n * tc, mon: 'ARS' };
  return { n: n, mon: mon };
}
function fmtMoneyRaw(n, mon) {   // espacio fijo (nbsp) para que el símbolo no quede solo en la línea
  if (OCULTAR) return mon === 'USD' ? 'US$ ***' : mon === 'UVA' ? '*** UVA' : '$ ***';
  if (mon === 'USD') return 'US$ ' + fmtNum(n);
  if (mon === 'UVA') return fmtNum(n) + ' UVA';
  return '$ ' + fmtNum(n);
}
function fmtMoney(n, mon) { const c = convertir(n, mon); return fmtMoneyRaw(c.n, c.mon); }
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
  const activa = (S.vista === 'reglas' || S.vista === 'importar') ? 'resumenes' : S.vista;
  $('tabs').innerHTML = [['dashboard', 'Dashboard'], ['flujo', 'Cashflow'], ['cargar', 'Cargar'], ['movs', 'Movimientos'], ['inversiones', 'Inversiones'], ['deudas', 'Deudas'], ['resumenes', 'Resúmenes'], ['maestros', 'DDMM']].map(t =>
    '<button class="tab ' + (activa === t[0] ? 'on' : '') + '" data-v="' + t[0] + '">' + t[1] + '</button>').join('');
  $('tabs').querySelectorAll('.tab').forEach(b => b.onclick = () => irVista(b.dataset.v));
  actualizarCabecera();
  const activa_ = $('tabs').querySelector('.tab.on');
  if (activa_ && activa_.scrollIntoView) activa_.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

function irVista(v) {
  S.vista = v; S.q = ''; store.set('vista', v);
  if (v === 'resumenes') R.sel = '';
  if (v === 'cargar') reiniciarCarga(true);
  if (K.p && Date.now() - K.ts > 90000 && ['dashboard', 'flujo', 'movs', 'deudas', 'inversiones', 'resumenes', 'cargar'].indexOf(v) >= 0) refrescarSilencioso();
  if (v === 'maestros' && S.id === 'reglas') S.id = S.schemas.filter(s => s.id !== 'reglas')[0].id;
  if (v === 'reglas') S.id = 'reglas';
  cerrar(); renderTabs(); render();
}

function render() {
  if (S.vista === 'importar') renderImportar();
  else if (S.vista === 'movs') renderMovs();
  else if (S.vista === 'deudas') renderDeudas();
  else if (S.vista === 'inversiones') renderInversiones();
  else if (S.vista === 'cargar') renderCargar();
  else if (S.vista === 'resumenes') renderResumenes();
  else if (S.vista === 'dashboard') renderDashboard();
  else if (S.vista === 'flujo') renderFlujo();
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
    ? '<div><button class="mini" id="volver">← Volver a Resúmenes</button><h1 style="margin-top:14px">Reglas de Importacion</h1></div>'
    : '<div><h1>DDMM</h1></div>';

  $('page').innerHTML =
    encabezado + avisosHtml() + revisionesHtml() +
    (enReglas ? '' : '<div class="pills">' + pills + '</div>') +
    (S.id === 'fijos' && !enReglas ? resumenFijosHtml() : '') +
    (S.id === 'presupuesto' && !enReglas ? '<div class="mut small" style="max-width:640px">Los cambios valen desde este mes: los meses anteriores conservan el presupuesto que tenían.</div>' : '') +
    (S.id === 'presupuesto' && !enReglas ? presMesHtml() : '') +
    '<div class="toolbar"><div class="search"><span class="lupa"></span><input id="q" placeholder="Buscar…" value="' + esc(S.q) + '"></div>' +
    '<button class="btn primary" id="nuevo">+ Agregar</button>' +
    '<span class="count">' + filas.length + ' de ' + (d.filas || []).length + ' en ' + esc(m.titulo) + '</span></div>' + cuerpo;

  $('page').querySelectorAll('.pill').forEach(b => b.onclick = () => { S.id = b.dataset.id; S.q = ''; store.set('maestro', S.id); renderPage(); });
  if ($('volver')) $('volver').onclick = () => irVista('resumenes');
  const qi = $('q');
  qi.oninput = () => { S.q = qi.value; const pos = qi.selectionStart; renderPage(); const n = $('q'); n.focus(); n.setSelectionRange(pos, pos); };
  $('nuevo').onclick = () => abrir(null);
  $('page').querySelectorAll('tbody tr').forEach(tr => tr.onclick = () => abrir(Number(tr.dataset.n)));
  $('page').querySelectorAll('[data-fix]').forEach(b => b.onclick = () => corregir(Number(b.dataset.fix)));
  $('page').querySelectorAll('[data-ir]').forEach(b => b.onclick = () => irA(Number(b.dataset.ir)));
  enlazarTC();
  enlazarPresMes();
  const cs = document.createElement('button');
  cs.className = 'btn'; cs.style.marginTop = '24px'; cs.textContent = 'Cerrar sesión'; cs.onclick = salir;
  $('page').appendChild(cs);
  const ct = document.createElement('button');
  ct.className = 'btn'; ct.style.margin = '24px 0 0 8px'; ct.textContent = 'Cerrar sesión en todos los dispositivos';
  ct.onclick = async () => {
    if (!confirm('Esto cierra tu sesión en el celular, la compu y cualquier otro dispositivo. ¿Seguro?')) return;
    try { await llamar('cerrarSesiones'); } catch (e) { /* igual se cierra acá */ }
    salir();
  };
  $('page').appendChild(ct);
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
    '</span> ' + (S.rev.length === 1 ? 'cosa para revisar' : 'cosas para revisar') + ' en tus datos</summary><ul>' + items + '</ul></details>';
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
    importarIgual: false, reemplazar: false, resultado: null, cargando: '', error: '', archivo: null, pideClave: false, modo: 'resumen', items: null, saltados: 0 });
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
const dupEf = f => f.dup && !I.reemplazar;   // con "reemplazar" lo ya importado vuelve a entrar
const esSinCat = f => f.clase !== 'pago' && !dupEf(f) && !I.dec[f.i].omitir && !I.dec[f.i].sub && !I.dec[f.i].asig;

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
  else if (I.resultado) cuerpo = I.modo === 'ciclo' ? htmlResultadoCiclo() : htmlResultado();
  else if (I.a) cuerpo = I.modo === 'ciclo' ? htmlRevisionCiclo() : htmlRevision();
  else cuerpo = I.modo === 'ciclo' ? htmlInicioCiclo() : htmlInicio();
  $('page').innerHTML =
    '<div><button class="mini" id="volverres">← Resúmenes</button><h1 style="margin-top:14px">' + (I.modo === 'ciclo' ? 'Movimientos del mes' : 'Importar resumen') + '</h1></div>' +
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
    (r.historico ? ', marcados como histórico (no cambian saldos).' : '.') +
    (r.reemplazados ? ' Se reemplazaron ' + r.reemplazados + ' movimientos que ya estaban importados de este resumen.' : '') +
    (r.provisoriosBorrados ? ' Se quitaron ' + r.provisoriosBorrados + ' movimientos provisorios del ciclo, que ahora vienen con el resumen oficial.' : '') +
    (r.resumenNuevo ? ' La cabecera del resumen (saldos y lo arrastrado) quedó registrada en la pestaña <b style="color:var(--text)">Resumenes</b>.' : '') + '</p>' +
    '<div style="display:flex;gap:8px;margin-top:20px"><button class="btn primary" id="otro">Importar otro resumen</button>' +
    '<button class="btn" id="verreglas">Ver reglas</button></div></div>';
}

function htmlRevision() {
  const a = I.a, r = a.resumen, ok = r.controles.ok;
  const kpis = [
    ['Cierre', fechaCorta(r.cierre), 'Vence ' + fechaCorta(r.vencimiento), ''],
    ['Saldo del resumen', fmtMoney(r.saldoActual.ars, 'ARS'), fmtMoney(r.saldoActual.usd, 'USD') + ' · de lo anterior sin pagar: ' + fmtMoney(r.arrastrado.ars, 'ARS'), ''],
    ['Pago mínimo', fmtMoneyRaw(r.pagoMinimo, 'ARS'), a.filas.length + ' renglones leídos', ''],
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
    (a.filas.some(f => f.dup) ? '<label><input type="checkbox" id="reemp" ' + (I.reemplazar ? 'checked' : '') + '> Reemplazar lo que ya importé de este resumen <span class="mut" style="font-weight:400">(se rehace con las reglas actuales; se pierden los cambios manuales de esos movimientos)</span></label>' : '') +
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
  const monto = fmtMoneyRaw(f.monto, f.moneda === 'USD' ? 'USD' : 'ARS');
  const comun = '<td class="mono mut">' + esc(fechaCorta(f.fecha).slice(0, 5)) + '</td><td>' + esc(f.desc) +
    (f.cuota ? ' <span class="tag">cuota ' + esc(f.cuota) + '</span>' : '') + (dupEf(f) ? ' <span class="tag">ya importado</span>' : '') +
    '</td><td class="r mono">' + esc(monto) + '</td>';
  const omitir = '<td><label class="rec"><input type="checkbox" data-k="omitir" ' + (d.omitir ? 'checked' : '') + (dupEf(f) ? ' disabled' : '') + '> Omitir</label></td>';
  if (f.clase === 'pago') {
    return '<tr class="pago ' + (dupEf(f) ? 'dup' : '') + '" data-i="' + f.i + '">' + comun +
      '<td colspan="3"><span class="tag">pago del resumen</span> <span class="mut" style="font-weight:400">se registra como transferencia desde la cuenta de pago</span></td>' + omitir + '</tr>';
  }
  return '<tr class="' + (dupEf(f) ? 'dup ' : '') + (esSinCat(f) ? 'sin' : '') + '" data-i="' + f.i + '">' + comun +
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
  const aImportar = a.filas.filter(f => !I.dec[f.i].omitir && !dupEf(f)).length;
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
    const res = I.modo === 'ciclo'
      ? await llamar('confirmarCiclo', I.items, I.tarjeta, decisiones)
      : await llamar('confirmarImportacion', I.texto, I.tarjeta, decisiones, { historico: I.historico, importarIgual: I.importarIgual, reemplazar: I.reemplazar });
    S.data = res.data; S.rev = res.revisiones; M.movs = null;
    I.resultado = { importados: res.importados, omitidos: res.omitidos, duplicados: res.duplicados, reglasNuevas: res.reglasNuevas, resumenNuevo: res.resumenNuevo, reemplazados: res.reemplazados, historico: I.historico, quitados: res.quitados, pagosIgnorados: res.pagosIgnorados, provisoriosBorrados: res.provisoriosBorrados };
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
  const x = $('xls');
  if (x) {
    x.onchange = () => { if (x.files[0]) leerExcelCiclo(x.files[0]); };
    const zx = $('dropx');
    ['dragenter', 'dragover'].forEach(ev => zx.addEventListener(ev, e => { e.preventDefault(); zx.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => zx.addEventListener(ev, e => { e.preventDefault(); zx.classList.remove('over'); }));
    zx.addEventListener('drop', e => { if (e.dataTransfer.files[0]) leerExcelCiclo(e.dataTransfer.files[0]); });
  }
  if ($('vermes')) $('vermes').onclick = () => irVista('dashboard');
  if ($('abrirclave')) $('abrirclave').onclick = () => leerArchivo(I.archivo, $('clave').value);
  if ($('verreglas')) $('verreglas').onclick = e => { e.preventDefault(); irVista('reglas'); };
  if ($('volverres')) $('volverres').onclick = () => irVista('resumenes');
  if ($('otro')) $('otro').onclick = () => { const modo = I.modo; resetImp(); I.modo = modo; renderImportar(); };
  if (!I.a || I.resultado) return;

  renderTablaImp(); actualizarContadores();
  pg.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { I.filtro = b.dataset.f; renderImportar(); });
  const iq = $('iq');
  iq.oninput = () => { I.q = iq.value; renderTablaImp(); };
  if ($('tarjeta')) $('tarjeta').onchange = e => { I.tarjeta = e.target.value; actualizarContadores(); };
  if ($('hist')) $('hist').onchange = e => { I.historico = e.target.checked; };
  if ($('igual')) $('igual').onchange = e => { I.importarIgual = e.target.checked; actualizarContadores(); };
  if ($('reemp')) $('reemp').onchange = e => {
    I.reemplazar = e.target.checked;
    I.a.filas.forEach(f => { if (f.dup) I.dec[f.i].omitir = !I.reemplazar; });
    renderTablaImp(); actualizarContadores();
  };
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
const COLORES_CAT_OSC = ['#F2EFEB', '#C62F2B', '#E5574F', '#8C2A25', '#8A847E', '#5E5955', '#3A3634'];
const COLORES_CAT_CLARO = ['#1A1918', '#C62F2B', '#E5574F', '#8C2A25', '#6F6A65', '#A39E98', '#CFCAC4'];
const coloresCat = () => (document.documentElement.getAttribute('data-tema') === 'claro' ? COLORES_CAT_CLARO : COLORES_CAT_OSC);
const M = { movs: null, periodo: '', q: '', cuentas: [], tipos: [], dd: '', cat: '', campo: 'fecha', desc: true, limite: 120, edit: null };

const nombreMes = ym => MESES_CORTO[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
const mesesDe = lista => Array.from(new Set(lista.map(m => m.fecha.slice(0, 7)))).sort().reverse();
const sumaMov = lista => lista.reduce((s, m) => s + m.monto, 0);
const mv = n => n + (n === 1 ? ' movimiento' : ' movimientos');

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
  if (M.movs === null) { necesitaDatos(); return; }
  if (!M.movs.length) {
    $('page').innerHTML = '<div><h1>Movimientos</h1></div><div class="card vacio">Todavía no hay movimientos. Importá un resumen desde <b style="color:var(--text)">Resúmenes</b>.' +
      '<div style="margin-top:16px"><button class="btn primary" id="irimp">Ir a Resúmenes</button></div></div>';
    $('irimp').onclick = () => irVista('resumenes');
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
  const aparte = base.filter(m => m.tipo === 'Adelanto' || m.tipo === 'Pago Deuda' || m.tipo === 'Cobro Deuda');   // salen de tu bolsillo pero no son gasto
  const aparteARS = sumaMov(aparte.filter(m => m.moneda === 'ARS')), aparteUSD = sumaMov(aparte.filter(m => m.moneda === 'USD'));

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
  cats.forEach((c, i) => { c.color = coloresCat()[Math.min(i, coloresCat().length - 1)]; });
  const colorDeCat = n => { const c = cats.find(x => x.n === n) || cats.find(x => x.n === 'Otras'); return c ? c.color : coloresCat()[6]; };
  const grupoCat = m => { const c = categoriaDe(m); return otras.has(c) ? 'Otras' : c; };
  if (M.cat && !cats.some(c => c.n === M.cat)) M.cat = '';

  let acum = 0;
  const donut = totARS ? 'conic-gradient(' + cats.map(c => { const a = acum; acum += c.total / totARS * 100; return c.color + ' ' + a + '% ' + acum + '%'; }).join(',') + ')' : 'var(--surface-2)';
  const sel = cats.find(c => c.n === M.cat);

  // filtros de la tabla
  const q = M.q.trim().toLowerCase();
  const filas = base.filter(m =>
    (!M.cuentas.length || M.cuentas.indexOf(m.cuenta) >= 0) && (!M.tipos.length || M.tipos.indexOf(m.tipo) >= 0) &&
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
    const catTxt = esGasto ? esc(m.subcategoria) : (m.tipo === 'Transferencia' ? esc(m.cuenta) + ' → ' + esc(m.destino) : (m.asignado ? '→ ' + esc(m.asignado) : (m.subcategoria ? esc(m.subcategoria) : '—')));
    return '<tr data-id="' + esc(m.id) + '"><td class="mono mut">' + esc(fechaCorta(m.fecha).slice(0, 5)) + '</td><td class="desc">' + esc(m.desc) +
      (m.cuota ? ' <span class="tag">cuota ' + esc(m.cuota) + '</span>' : '') + (esProvisorio(m) ? ' <span class="tag">provisorio</span>' : '') + '</td><td><span class="dot" style="background:' + (esGasto ? colorDeCat(grupoCat(m)) : 'var(--border-strong)') + '"></span>' + catTxt +
      '</td><td class="mut cuentacol">' + esc(m.cuenta) + '</td><td class="mut tipocol">' + esc(m.tipo) + '</td><td class="r mono ' + (esGasto ? 'neg' : '') + '">' +
      (esGasto ? '− ' : esIng ? '+ ' : (m.tipo === 'Ajuste' ? (m.monto < 0 ? '− ' : '+ ') : '')) + esc(fmtMoney(Math.abs(m.monto), m.moneda)) + '</td></tr>';
  }).join('');

  const flecha = campo => M.campo === campo ? (M.desc ? ' ▼' : ' ▲') : '';
  const tabla = filas.length
    ? '<table class="movt"><thead><tr><th class="ord" data-ord="fecha">Fecha' + flecha('fecha') + '</th><th>Descripción</th><th>Categoría</th><th class="cuentacol">Cuenta</th><th class="tipocol">Tipo</th><th class="r ord neg" data-ord="monto">Monto' + flecha('monto') + '</th></tr></thead><tbody>' + filasHtml + '</tbody></table>' +
      (filas.length > M.limite ? '<div style="padding:14px;text-align:center"><button class="btn" id="mas">Mostrar más (' + (filas.length - M.limite) + ')</button></div>' : '') +
      '<div class="neto"><span class="mut">Neto filtrado</span><span class="mono">' + (netoARS < 0 ? '− ' : '+ ') + esc(fmtMoney(Math.abs(netoARS), 'ARS')) + (netoUSD ? '  ·  ' + (netoUSD < 0 ? '− ' : '+ ') + esc(fmtMoney(Math.abs(netoUSD), 'USD')) : '') + '</span></div>'
    : '<div class="vacio">Sin movimientos para estos filtros<div style="margin-top:14px"><button class="btn" id="limpiar">Limpiar filtros</button></div></div>';

  $('page').innerHTML =
    '<div class="titulo-fila"><h1>Movimientos</h1><div class="seg">' + periodos.map(p => '<button class="' + (M.periodo === p[0] ? 'on' : '') + '" data-per="' + p[0] + '">' + esc(p[1]) + '</button>').join('') + '</div></div>' +
    '<div class="kpis cinco">' + kpi('Gastos', fmtMoney(totARS, 'ARS'), mv(gARS.length) + ' en pesos', 'var(--danger)') + kpi('Gastos en dólares', fmtMoney(sumaMov(gUSD), 'USD'), mv(gUSD.length)) +
      kpi('Adelantos y pagos de deuda', fmtMoney(aparteARS, 'ARS') + (aparteUSD ? ' + ' + fmtMoney(aparteUSD, 'USD') : ''), mv(aparte.length) + ' · no cuentan como gasto') +
      kpi('Prescindible', (totARS ? Math.round(presc / totARS * 100) : 0) + '%', fmtMoney(presc, 'ARS') + ' del gasto en pesos') + kpi('Costo de deuda', fmtMoney(deuda, 'ARS'), 'intereses, comisiones y cuotas') + '</div>' +
    '<div class="card donutbox"><div class="donut" style="background:' + donut + '"><div class="hole"><span class="mut" style="font-size:12px;font-weight:400">' + esc(sel ? sel.n : 'Gastos') +
      '</span><span class="mono" style="font-size:16px;font-weight:600">' + esc(fmtMoney(sel ? sel.total : totARS, 'ARS')) + '</span></div></div><div class="legend">' + leyenda + '</div></div>' +
    '<div class="toolbar"><div class="search"><span class="lupa"></span><input id="mq" placeholder="Buscar…" value="' + esc(M.q) + '"></div>' +
      ddMov('cuentas', 'Cuentas', cuentasBase, M.cuentas) + ddMov('tipos', 'Tipos', tiposBase, M.tipos) +
      (M.cat ? '<button class="pill rojo" id="quitacat">' + esc(M.cat) + ' ×</button>' : '') +
      '<span class="count">' + filas.length + ' de ' + base.length + ' movimientos</span><button class="mini" id="exportar" title="Descarga todos tus movimientos en un archivo de Excel">Descargar Excel</button></div>' +
    '<div class="card tablewrap">' + tabla + '</div>';

  const pg = $('page');
  pg.querySelectorAll('[data-per]').forEach(b => b.onclick = () => { M.periodo = b.dataset.per; M.cat = ''; M.limite = 120; renderMovs(); });
  pg.querySelectorAll('.leg').forEach(l => l.onclick = () => { M.cat = M.cat === l.dataset.cat ? '' : l.dataset.cat; M.limite = 120; renderMovs(); });
  pg.querySelectorAll('[data-dd]').forEach(b => b.onclick = () => { M.dd = M.dd === b.dataset.dd ? '' : b.dataset.dd; renderMovs(); });
  pg.querySelectorAll('[data-ddop]').forEach(i => i.onchange = () => {
    const lista = i.dataset.ddop === 'cuentas' ? M.cuentas : M.tipos, k = lista.indexOf(i.value);
    if (i.checked && k < 0) lista.push(i.value); else if (!i.checked && k >= 0) lista.splice(k, 1);
    M.limite = 120; renderMovs();
  });
  pg.querySelectorAll('[data-ddlimpiar]').forEach(b => b.onclick = () => { if (b.dataset.ddlimpiar === 'cuentas') M.cuentas = []; else M.tipos = []; renderMovs(); });
  pg.querySelectorAll('[data-ord]').forEach(h => h.onclick = () => { if (M.campo === h.dataset.ord) M.desc = !M.desc; else { M.campo = h.dataset.ord; M.desc = true; } renderMovs(); });
  if ($('quitacat')) $('quitacat').onclick = () => { M.cat = ''; renderMovs(); };
  if ($('mas')) $('mas').onclick = () => { M.limite += 200; renderMovs(); };
  if ($('exportar')) $('exportar').onclick = descargarMovimientos;
  if ($('limpiar')) $('limpiar').onclick = () => { M.q = ''; M.cuentas = []; M.tipos = []; M.dd = ''; M.cat = ''; renderMovs(); };
  pg.querySelectorAll('tbody tr').forEach(tr => tr.onclick = () => abrirMov(tr.dataset.id));
  const mq = $('mq');
  mq.oninput = () => { M.q = mq.value; const p = mq.selectionStart; renderMovs(); const n = $('mq'); n.focus(); n.setSelectionRange(p, p); };
}

// ----- filtros desplegables de Movimientos (cuentas y tipos, se pueden elegir varias) -----
function ddMov(id, titulo, opciones, elegidas) {
  const abierto = M.dd === id;
  return '<div class="dd"><button type="button" class="pill dd-btn ' + (elegidas.length ? 'on' : '') + '" data-dd="' + id + '" aria-expanded="' + abierto + '">' + esc(titulo) +
    (elegidas.length ? ' <small>' + elegidas.length + '</small>' : '') + ' <span class="dd-flecha">▾</span></button>' +
    (abierto ? '<div class="dd-panel">' + opciones.map(o => '<label class="dd-op"><input type="checkbox" data-ddop="' + id + '" value="' + esc(o) + '"' + (elegidas.indexOf(o) >= 0 ? ' checked' : '') + '> ' + esc(o) + '</label>').join('') +
      (elegidas.length ? '<button type="button" class="mini dd-limpiar" data-ddlimpiar="' + id + '">Quitar selección</button>' : '') + '</div>' : '') + '</div>';
}
document.addEventListener('click', e => {
  if (M.dd && !e.target.closest('.dd')) { M.dd = ''; if (S.vista === 'movs' && M.movs) renderMovs(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && M.dd) { M.dd = ''; if (S.vista === 'movs' && M.movs) renderMovs(); }
});

// ----- descargar todos los movimientos en un Excel (.xlsx) -----
function libroMovimientos(lista) {
  const cols = [['Fecha', 'fecha'], ['Tipo', 'tipo'], ['Descripcion', 'desc'], ['Monto', 'monto'], ['Moneda', 'moneda'], ['Cuenta', 'cuenta'],
    ['Cuenta Destino', 'destino'], ['Monto Destino', 'montoDestino'], ['Subcategoria', 'subcategoria'], ['Asignado A', 'asignado'],
    ['Cuota', 'cuota'], ['Origen', 'origen'], ['Afecta Saldo', 'afecta'], ['ID', 'id']];
  const orden = lista.slice().sort((a, b) => a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0);
  const filas = [cols.map(c => c[0])].concat(orden.map(m => cols.map(c => m[c[1]] == null ? '' : m[c[1]])));
  const ws = XLSX.utils.aoa_to_sheet(filas);
  const serial = iso => { const p = String(iso).split('-').map(Number); return (Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 86400000; };
  orden.forEach((m, i) => {   // fechas y montos como fechas y números de verdad (no texto)
    const r = i + 1;
    ws[XLSX.utils.encode_cell({ r: r, c: 0 })] = { t: 'n', v: serial(m.fecha), z: 'dd/mm/yyyy' };
    ['monto', 'montoDestino'].forEach(k => {
      const c = cols.findIndex(x => x[1] === k), v = m[k];
      if (v !== '' && v != null && isFinite(Number(v))) ws[XLSX.utils.encode_cell({ r: r, c: c })] = { t: 'n', v: Number(v), z: '#,##0.00' };
    });
  });
  ws['!cols'] = [12, 14, 36, 14, 8, 22, 22, 14, 26, 24, 8, 26, 12, 14].map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filas.length - 1, c: cols.length - 1 } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');
  return wb;
}

async function descargarMovimientos() {
  try { await cargarXlsx(); } catch (e) { toast((e && e.message) || 'No se pudo preparar el Excel'); return; }
  const datos = XLSX.write(libroMovimientos(M.movs), { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([datos], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'movimientos-opus-' + hoyLocal() + '.xlsx';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Descargado: ' + M.movs.length + ' movimientos');
}

// ----- editar un movimiento -----
function abrirMov(id) {
  const m = M.movs.find(x => x.id === id);
  if (!m) return;
  const txt = n => n === '' || n == null ? '' : String(n).replace('.', ',');
  M.edit = { id, m, fecha: m.fecha, desc: m.desc, monto: txt(m.monto), cuenta: m.cuenta, destino: m.destino, montoDest: txt(m.montoDestino),
    sub: m.subcategoria === 'Sin categorizar' ? '' : m.subcategoria, asig: m.asignado, rec: false, par: true, txt: textoSugerido(m.desc), borrar: false };
  renderEditMov();
}

function renderEditMov() {
  const E = M.edit, m = E.m;
  const categorizable = ['Gasto', 'Adelanto', 'Pago Deuda'].indexOf(m.tipo) >= 0;
  const manual = m.origen === 'Manual';
  const dato = (l, v) => '<div class="dato"><span class="mut">' + l + '</span><span>' + esc(v) + '</span></div>';
  const campo = (l, ctl, ayuda) => '<label class="f">' + l + ctl + (ayuda ? '<div class="ayuda">' + esc(ayuda) + '</div>' : '') + '</label>';
  const sel = (k, opciones) => '<select class="in" data-k="' + k + '">' + opciones + '</select>';
  const cuentaAct = cuentaPorNombre(E.cuenta);
  const monedaCta = cuentaAct ? cuentaAct.Moneda : m.moneda;

  let campos = campo('Fecha', '<input class="in" type="date" data-k="fecha" value="' + esc(E.fecha) + '">') +
    campo('Descripción', '<input class="in" data-k="desc" autocomplete="off" value="' + esc(E.desc) + '">') +
    campo(m.tipo === 'Ajuste' ? 'Monto (positivo suma, negativo resta)' : 'Monto', '<input class="in" data-k="monto" inputmode="decimal" autocomplete="off" value="' + esc(E.monto) + '">', monedaCta === 'USD' ? 'En dólares' : monedaCta === 'UVA' ? 'En UVAs' : 'En pesos');
  campos += manual
    ? campo('Cuenta', sel('cuenta', '<option value="">Elegí una cuenta</option>' + (m.tipo === 'Transferencia' && S.data.tarjetas.filas.some(t => t.v.Nombre === E.destino) ? op(SIN_CUENTA, E.cuenta, 'Sin cuenta (lo pagó o acreditó el banco)') : '') + cuentasActivas().map(c => op(c.Nombre, E.cuenta, c.Nombre + ' (' + c.Moneda + ')')).join('')))
    : campo('Cuenta', '<div class="in" style="display:flex;align-items:center;opacity:.7">' + esc(m.cuenta) + '</div>', 'Es el origen del resumen importado y no se cambia.');

  if (m.tipo === 'Transferencia') {
    const cuentasD = cuentasActivas().filter(c => c.Nombre !== E.cuenta).map(c => op(c.Nombre, E.destino, c.Nombre + ' (' + c.Moneda + ')')).join('');
    const tarj = S.data.tarjetas.filas.filter(f => f.v.Moneda === monedaCta).map(f => op(f.v.Nombre, E.destino)).join('');
    campos += campo('Hacia', sel('destino', '<option value="">Elegí el destino</option><optgroup label="Cuentas">' + cuentasD + '</optgroup>' + (tarj ? '<optgroup label="Tarjetas">' + tarj + '</optgroup>' : '')));
    const dst = cuentaPorNombre(E.destino);
    if (dst && dst.Moneda !== monedaCta) campos += campo('Monto que llega (' + dst.Moneda + ')', '<input class="in" data-k="montoDest" inputmode="decimal" autocomplete="off" value="' + esc(E.montoDest) + '">');
  } else if (m.tipo === 'Ingreso') {
    campos += campo('Tipo de ingreso', sel('sub', '<option value="">Elegí un tipo</option>' + S.data.ingresos.filas.map(f => op(f.v['Tipo de Ingreso'], E.sub)).join('')));
  } else if (m.tipo === 'Cobro Deuda') {
    campos += campo('Deuda', sel('asig', S.data.deudas.filas.filter(f => f.v.Tipo === 'Por Cobrar').map(f => op(f.v.Nombre, E.asig)).join('')));
  } else if (categorizable) {
    campos += campo('Categoría', selSub({ clase: 'consumo' }, E.sub), 'Si asignás a una deuda o a un fijo, la categoría puede quedar vacía.') +
      campo('Asignar a', selAsig(E.asig), 'Una deuda hace que deje de contarse como gasto.') +
      '<label class="f recl"><input type="checkbox" data-k="rec" ' + (E.rec ? 'checked' : '') + '> Recordar para próximos resúmenes</label>' +
      '<div id="recbox" class="' + (E.rec ? '' : 'hide') + '"><input class="in" data-k="txt" value="' + esc(E.txt) + '">' +
      '<label class="f recl"><input type="checkbox" data-k="par" ' + (E.par ? 'checked' : '') + '> Aplicar también a los “Sin categorizar” que contengan ese texto</label></div>';
  }

  $('modal').innerHTML = '<div class="overlay" id="ov"><div class="panel"><header><h2>Movimiento</h2><button class="x" id="cerrar" aria-label="Cerrar">×</button></header>' +
    '<div class="body" id="body"><div id="err"></div><div class="datos">' + dato('Tipo', m.tipo) + (m.cuota ? dato('Cuota', m.cuota) : '') + dato('Origen', m.origen + (m.afecta === 'No' ? ' · histórico' : '')) + '</div>' + campos + '</div>' +
    '<footer><button class="btn primary" id="guardarmov">Guardar</button><button class="btn danger" id="borrarmov">' + (E.borrar ? 'Tocá de nuevo para eliminar' : 'Eliminar') + '</button></footer></div></div>';
  $('modal').classList.remove('hide');
  $('ov').onclick = e => { if (e.target.id === 'ov') cerrar(); };
  $('cerrar').onclick = cerrar;
  const manejar = e => {
    const k = e.target.dataset.k;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'rec') { E.rec = v; $('recbox').classList.toggle('hide', !E.rec); return; }
    E[k === 'asig' ? 'asig' : k === 'sub' ? 'sub' : k] = v;
    if ((k === 'cuenta' || k === 'destino') && e.type === 'change') { E.borrar = false; renderEditMov(); }
  };
  $('body').addEventListener('change', manejar);
  $('body').addEventListener('input', manejar);
  $('guardarmov').onclick = guardarMov;
  $('borrarmov').onclick = borrarMov;
}

async function guardarMov() {
  const E = M.edit, m = E.m;
  const b = $('guardarmov'); b.disabled = true;
  const num = s => { const n = numAR(s); return isFinite(n) ? n : s; };
  const d = { fecha: E.fecha, descripcion: E.desc, monto: num(E.monto) };
  if (m.origen === 'Manual') d.cuenta = E.cuenta;
  if (m.tipo === 'Transferencia') { d.destino = E.destino; if (E.montoDest !== '') d.montoDestino = num(E.montoDest); }
  else if (m.tipo === 'Ingreso') d.subcategoria = E.sub;
  else if (m.tipo === 'Cobro Deuda') d.asignarA = E.asig;
  else if (['Gasto', 'Adelanto', 'Pago Deuda'].indexOf(m.tipo) >= 0) Object.assign(d, { subcategoria: E.sub, asignarA: E.asig, recordar: E.rec ? E.txt : '', aplicarParecidos: E.rec && E.par });
  try {
    const res = await llamar('editarMovimiento', E.id, d);
    M.movs = res.movimientos; S.data = res.data; S.rev = res.revisiones; D.lista = null; C.recientes = null; R.lista = null; DB.movs = null;
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

// ---------- Deudas ----------
const D = { lista: null, hoy: '' };
const NOMBRE_MON = { ARS: 'pesos', USD: 'dólares', UVA: 'UVAs' };
const redondeo2 = n => Math.round(n * 100) / 100;

function tarjetaDeuda(d) {
  const pct = d.q ? Math.round(d.pagadas / d.q * 100) : 0;
  const vto = d.proximo ? 'Próximo vencimiento: ' + fechaCorta(d.proximo) + (d.proximo < D.hoy ? ' (vencido)' : '') : '';
  return '<div class="card dcard"><div class="dtop"><div><b>' + esc(d.nombre) + '</b><div class="mut small">' + esc(d.acreedor) + ' · ' + esc(d.tipo) + '</div></div>' +
    (d.tasa ? '<span class="tag">' + esc(fmtNum(d.tasa)) + '% anual</span>' : '') + '</div>' +
    '<div class="mut small" style="margin-top:12px">' + (d.porCobrar ? 'Te falta cobrar' : 'Te falta pagar') + '</div>' +
    '<div class="mono grande">' + esc(fmtMoney(d.pendiente, d.moneda)) + '</div>' +
    '<div class="barra"><i style="width:' + pct + '%"></i></div>' +
    '<div class="mut small">' + (d.porCobrar ? 'Te pagaron ' : 'Pagaste ') + d.pagadas + ' de ' + d.q + (d.q === 1 ? ' cuota' : ' cuotas') +
      (d.restantes && d.q > 1 ? ' · faltan ' + d.restantes + ' de ' + esc(fmtMoney(d.valor, d.moneda)) : '') + '</div>' +
    (vto ? '<div class="mut small">' + esc(vto) + '</div>' : '') +
    (d.registrados ? '<div class="mut small">Incluye ' + d.registrados + (d.registrados === 1 ? ' pago registrado' : ' pagos registrados') + ' en Movimientos</div>' : '') +
    '<div style="margin-top:10px"><button class="mini" data-edit="' + d.fila + '">Editar en DDMM</button></div></div>';
}

function renderDeudas() {
  if (D.lista === null) { necesitaDatos(); return; }
  if (!D.lista.length) {
    $('page').innerHTML = '<div><h1>Deudas</h1></div><div class="card vacio">No hay deudas cargadas. Agregalas en <b style="color:var(--text)">DDMM → Deudas</b>.</div>';
    return;
  }
  const vivas = D.lista.filter(d => d.estado !== 'Inactivo' && !d.finalizada);
  const cerradas = D.lista.filter(d => d.estado === 'Inactivo' || d.finalizada);
  const debo = vivas.filter(d => !d.porCobrar).sort((a, b) => b.tasa - a.tasa || b.pendiente - a.pendiente);
  const cobrar = vivas.filter(d => d.porCobrar).sort((a, b) => b.pendiente - a.pendiente);
  const suma = (lista, campo) => redondeo2(lista.reduce((s, d) => s + d[campo], 0));
  const textoPorMoneda = lista => ['ARS', 'USD', 'UVA'].filter(m => lista.some(d => d.moneda === m))
    .map(m => fmtMoney(suma(lista.filter(d => d.moneda === m), 'pendiente'), m)).join(' + ') || '—';
  const kpi = (l, v, s, color) => '<div class="card kpi"><span class="l">' + esc(l) + '</span><span class="v" ' + (color ? 'style="color:' + color + '"' : '') + '>' + esc(v) + '</span><span class="s">' + esc(s) + '</span></div>';

  const kpis = ['ARS', 'USD', 'UVA'].filter(m => debo.some(d => d.moneda === m)).map(m => {
    const l = debo.filter(d => d.moneda === m), cuotas = l.filter(d => d.q > 1 && d.restantes > 0);
    return kpi('Te falta pagar · ' + NOMBRE_MON[m], fmtMoney(suma(l, 'pendiente'), m),
      l.length + (l.length === 1 ? ' deuda' : ' deudas') + (cuotas.length ? ' · cuotas de ' + fmtMoney(suma(cuotas, 'valor'), m) + ' por mes' : ''), 'var(--danger)');
  });
  if (cobrar.length) kpis.push(kpi('Te falta cobrar', textoPorMoneda(cobrar), cobrar.length + (cobrar.length === 1 ? ' deuda' : ' deudas')));

  const cerradasHtml = cerradas.length
    ? '<details class="card rev"><summary><span class="n">' + cerradas.length + '</span> terminadas o inactivas</summary><ul>' + cerradas.map(d =>
      '<li><div class="t"><b>' + esc(d.nombre) + '</b><br><span class="mut">' + (d.finalizada ? 'Pagaste las ' + d.q + (d.q === 1 ? ' cuota' : ' cuotas') : 'Inactiva') +
      (d.finalizada && d.estado !== 'Inactivo' ? ' · pasala a Inactivo en DDMM para que no figure como activa' : '') + '</span></div>' +
      '<button class="mini" data-edit="' + d.fila + '">Editar en DDMM</button></li>').join('') + '</ul></details>'
    : '';

  $('page').innerHTML = '<div><h1>Deudas</h1></div>' +
    (kpis.length ? '<div class="kpis">' + kpis.join('') + '</div>' : '') +
    (debo.length ? '<div class="seccion">Lo que debés · de la más cara a la más barata</div><div class="dgrid">' + debo.map(tarjetaDeuda).join('') + '</div>' : '') +
    (cobrar.length ? '<div class="seccion">Lo que te deben</div><div class="dgrid">' + cobrar.map(tarjetaDeuda).join('') + '</div>' : '') +
    cerradasHtml;

  $('page').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    S.vista = 'maestros'; S.id = 'deudas'; S.q = ''; store.set('vista', 'maestros'); store.set('maestro', 'deudas');
    renderTabs(); renderPage(); abrir(Number(b.dataset.edit));
  });
}

// ---------- Inversiones ----------
const INV = { lista: null, valores: {}, error: '', avisos: [], ts: 0, auto: null, refrescando: false, form: null, venta: null };
const INV_TIPOS = ['Plazo fijo', 'Fondo común', 'Acción', 'CEDEAR', 'Bono', 'Cripto', 'Otro'];
const INV_AUTO_MS = 10 * 60 * 1000;

const invActiva = i => i.estado !== 'Vendida';
const invConPrecio = i => ['Fondo común', 'Acción', 'CEDEAR', 'Bono', 'Cripto'].indexOf(i.tipo) >= 0;

/** Lo que llega del servidor, conservando los precios de mercado si se pidieron hace menos de 10 minutos. */
function aplicarInversiones(r) {
  if (!r) return;
  INV.lista = r.lista || []; INV.valores = r.valores || {}; INV.error = r.error || '';
  if (INV.auto && Date.now() - INV.auto.ts < INV_AUTO_MS) {
    INV.lista.forEach(i => { const a = INV.auto.valores[i.id]; if (a && invActiva(i) && INV.valores[i.id]) INV.valores[i.id] = a; });
  }
}

/** Invertido y valor de hoy por moneda, de las inversiones activas. */
function invTotales() {
  const t = { ARS: { invertido: 0, valor: 0, n: 0 }, USD: { invertido: 0, valor: 0, n: 0 } };
  (INV.lista || []).filter(invActiva).forEach(i => {
    const v = INV.valores[i.id], m = i.moneda === 'USD' ? 'USD' : 'ARS';
    if (!v) return;
    t[m].invertido += i.costo; t[m].valor += v.valor; t[m].n++;
  });
  return t;
}

function haceCuanto(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 2) return 'recién';
  if (min < 60) return 'hace ' + min + ' min';
  const h = Math.round(min / 60);
  if (h < 24) return 'hace ' + h + (h === 1 ? ' hora' : ' horas');
  const d = Math.round(h / 24);
  return 'hace ' + d + (d === 1 ? ' día' : ' días');
}

/** Dólares ahorrados: compras y ventas de dólares hechas como transferencias entre tus cuentas, a precio promedio. */
function invDolares() {
  const mon = {};
  S.data.cuentas.filas.forEach(f => { mon[f.v.Nombre] = f.v.Moneda; });
  const ts = (DB.movs || []).filter(m => m.tipo === 'Transferencia' && m.afecta === 'Si' && mon[m.cuenta] && mon[m.destino] && mon[m.cuenta] !== mon[m.destino] &&
    ['ARS', 'USD'].indexOf(mon[m.cuenta]) >= 0 && ['ARS', 'USD'].indexOf(mon[m.destino]) >= 0)
    .sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0);
  let usd = 0, costo = 0, realizado = 0, compras = 0, ventas = 0;
  ts.forEach(m => {
    const otro = Number(m.montoDestino);
    if (!(m.monto > 0) || !(otro > 0)) return;
    if (mon[m.cuenta] === 'ARS') { usd += otro; costo += m.monto; compras++; return; }
    const prom = usd > 0 ? costo / usd : 0, sale = Math.min(m.monto, usd);
    realizado += otro * (sale / m.monto) - prom * sale;
    usd -= sale; costo -= prom * sale; ventas++;
  });
  if (!compras) return null;
  usd = Math.max(0, usd); costo = Math.max(0, costo);
  const tc = tcEfectivo(), valor = usd * tc;
  return { usd, costo, prom: usd > 0 ? costo / usd : 0, tc, valor, resultado: tc ? valor - costo : 0, realizado, compras, ventas };
}

function signoMon(n, mon) { return (n < 0 ? '− ' : n > 0 ? '+ ' : '') + fmtMoney(Math.abs(n), mon); }

function fuenteTxt(v) {
  if (v.fuente === 'calculado') return 'valor calculado con la tasa';
  if (v.fuente === 'auto') return 'precio de mercado · ' + (v.actualizado ? haceCuanto(v.actualizado) : 'ahora');
  if (v.fuente === 'ultimo') return 'último precio conocido' + (v.actualizado ? ' · ' + haceCuanto(v.actualizado) : '');
  if (v.fuente === 'manual') return 'valor cargado a mano' + (v.actualizado ? ' · ' + fechaCorta(v.actualizado) : '');
  return 'sin precio: se muestra lo invertido';
}

function tarjetaInversion(i) {
  const v = INV.valores[i.id] || { valor: i.costo, fuente: 'costo' };
  const res = v.valor - i.costo, pct = i.costo ? res / i.costo * 100 : 0;
  const detalle = i.tipo === 'Plazo fijo'
    ? 'TNA ' + fmtNum(i.tna) + '% · vence el ' + fechaCorta(i.vencimiento) + (v.diasRestantes != null ? (v.diasRestantes < 0 ? ' (ya venció)' : v.diasRestantes === 0 ? ' (hoy)' : ' (en ' + v.diasRestantes + (v.diasRestantes === 1 ? ' día' : ' días') + ')') : '') +
      (v.valorVenc ? ' · al vencimiento cobrás ' + fmtMoney(v.valorVenc, i.moneda) : '')
    : i.tipo === 'Otro' ? ''
    : fmtNum(i.cantidad) + (i.tipo === 'Bono' ? ' VN' : i.tipo === 'Fondo común' ? ' cuotapartes' : ' unidades') + ' · compra a ' + fmtMoney(i.precio, i.moneda) + (v.precio ? ' · hoy ' + fmtMoney(v.precio, i.moneda) : '');
  return '<div class="card dcard"><div class="dtop"><div><b>' + esc(i.nombre) + '</b><div class="mut small">' + esc(i.tipo) + (i.codigo && i.codigo !== i.nombre ? ' · ' + esc(i.codigo) : '') + ' · desde ' + esc(fechaCorta(i.fecha)) + '</div></div>' +
    '<span class="tag">' + esc(i.moneda) + '</span></div>' +
    '<div class="mut small" style="margin-top:12px">Vale hoy</div>' +
    '<div class="mono grande">' + esc(fmtMoney(v.valor, i.moneda)) + '</div>' +
    '<div class="mono small ' + (res < 0 ? 'bad' : res > 0 ? 'bien' : 'mut') + '">' + esc(signoMon(res, i.moneda)) + ' (' + (pct > 0 ? '+' : pct < 0 ? '−' : '') + esc(fmtNum(Math.abs(Math.round(pct * 10) / 10))) + '%) sobre ' + esc(fmtMoney(i.costo, i.moneda)) + ' invertidos</div>' +
    (detalle ? '<div class="mut small">' + esc(detalle) + '</div>' : '') +
    '<div class="mut small">' + esc(fuenteTxt(v)) + '</div>' +
    (i.nota ? '<div class="mut small">' + esc(i.nota) + '</div>' : '') +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="mini" data-inv-vender="' + esc(i.id) + '">' + (i.tipo === 'Plazo fijo' ? 'Lo cobré' : 'Vender') + '</button>' +
    '<button class="mini" data-inv-editar="' + esc(i.id) + '">Editar</button></div></div>';
}

function seccionDolares() {
  const d = invDolares();
  if (!d) return '';
  const kp = (l, v, s, c) => '<div class="card kpi"><span class="l">' + esc(l) + '</span><span class="v" ' + (c ? 'style="color:' + c + '"' : '') + '>' + esc(v) + '</span><span class="s">' + esc(s) + '</span></div>';
  return '<div class="seccion">Dólares ahorrados · no cuentan como inversión</div>' +
    '<div class="kpis">' +
    kp('Dólares comprados (neto)', fmtMoney(d.usd, 'USD'), d.compras + (d.compras === 1 ? ' compra' : ' compras') + (d.ventas ? ' · ' + d.ventas + (d.ventas === 1 ? ' venta' : ' ventas') : '')) +
    kp('Precio promedio de compra', d.usd > 0 ? fmtMoney(d.prom, 'ARS') : '—', 'por cada dólar') +
    kp('Valen hoy', d.tc ? fmtMoney(d.valor, 'ARS') : '—', d.tc ? 'dólar a ' + fmtMoney(d.tc, 'ARS') : 'sin cotización') +
    kp('Resultado', d.tc && d.usd > 0 ? signoMon(d.resultado, 'ARS') : '—', d.usd > 0 && d.costo ? (d.resultado >= 0 ? '+' : '−') + fmtNum(Math.abs(Math.round(d.resultado / d.costo * 1000) / 10)) + '% sobre lo que pagaste' : (d.ventas ? 'ya vendidos' : ''), d.resultado < 0 ? 'var(--danger)' : '') +
    '</div>' +
    '<div class="mut small">Se calcula con tus transferencias de pesos a dólares (y de dólares a pesos), a precio promedio.' + (d.ventas ? ' Lo ya vendido dejó ' + (d.realizado < 0 ? '− ' : '+ ') + fmtMoney(Math.abs(d.realizado), 'ARS') + '.' : '') + '</div>';
}

function renderInversiones() {
  if (INV.lista === null || DB.movs === null) { necesitaDatos(); return; }
  const activas = INV.lista.filter(invActiva), vendidas = INV.lista.filter(i => !invActiva(i));
  const tot = invTotales();
  const kp = (l, v, s, c) => '<div class="card kpi"><span class="l">' + esc(l) + '</span><span class="v" ' + (c ? 'style="color:' + c + '"' : '') + '>' + esc(v) + '</span><span class="s">' + esc(s) + '</span></div>';
  const kpis = ['ARS', 'USD'].filter(m => tot[m].n).map(m => {
    const t = tot[m], res = t.valor - t.invertido, pct = t.invertido ? res / t.invertido * 100 : 0, nom = NOMBRE_MON[m];
    return kp('Valor hoy · ' + nom, fmtMoney(t.valor, m), 'invertiste ' + fmtMoney(t.invertido, m)) +
      kp('Resultado · ' + nom, signoMon(res, m), (pct > 0 ? '+' : pct < 0 ? '−' : '') + fmtNum(Math.abs(Math.round(pct * 10) / 10)) + '%', res < 0 ? 'var(--danger)' : '');
  });
  const ordenadas = activas.slice().sort((a, b) => (INV.valores[b.id] ? INV.valores[b.id].valor : 0) - (INV.valores[a.id] ? INV.valores[a.id].valor : 0));
  const vendHtml = vendidas.length
    ? '<details class="card rev"><summary><span class="n">' + vendidas.length + '</span> ' + (vendidas.length === 1 ? 'vendida o cobrada' : 'vendidas o cobradas') + '</summary><ul>' + vendidas.map(i => {
      const recibido = i.tipo === 'Plazo fijo' ? i.precioVenta : (i.tipo === 'Bono' ? i.cantidad / 100 * i.precioVenta : i.cantidad * i.precioVenta), res = recibido - i.costo;
      return '<li><div class="t"><b>' + esc(i.nombre) + '</b><br><span class="mut">' + esc(i.tipo) + ' · ' + esc(fechaCorta(i.fecha)) + ' → ' + esc(fechaCorta(i.fechaVenta)) + ' · recibiste ' + esc(fmtMoney(recibido, i.moneda)) + ' · ' +
        '<span class="' + (res < 0 ? 'bad' : 'bien') + '">' + esc(signoMon(res, i.moneda)) + '</span></span></div>' +
        '<button class="mini" data-inv-editar="' + esc(i.id) + '">Ver / eliminar</button></li>';
    }).join('') + '</ul></details>' : '';
  const hayAuto = activas.some(invConPrecio);
  const estado = INV.refrescando ? 'Actualizando precios…' : INV.ts ? 'Precios actualizados ' + haceCuanto(INV.ts) : '';

  $('page').innerHTML = '<div class="titulo-fila"><h1>Inversiones</h1><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    (estado ? '<span class="mut small" id="invest">' + esc(estado) + '</span>' : '') +
    (hayAuto ? '<button class="mini" id="invact"' + (INV.refrescando ? ' disabled' : '') + '>Actualizar precios</button>' : '') +
    '<button class="btn primary" id="invnueva">Agregar</button></div></div>' +
    (INV.error ? '<div class="aviso">No pude leer la hoja de inversiones: ' + esc(INV.error) + '</div>' : '') +
    (INV.avisos.length ? '<div class="aviso-viejo">' + INV.avisos.map(esc).join('<br>') + '</div>' : '') +
    (kpis.length ? '<div class="kpis">' + kpis.join('') + '</div>' : '') +
    (ordenadas.length ? '<div class="seccion">Tus inversiones · de la más grande a la más chica</div><div class="dgrid">' + ordenadas.map(tarjetaInversion).join('') + '</div>'
      : '<div class="card vacio">Todavía no cargaste inversiones. Tocá <b style="color:var(--text)">Agregar</b>: plazo fijo, fondo, acciones, CEDEARs, bonos, cripto u otras. No es un consejo de inversión: solo te muestra cuánto vale lo que ya tenés.</div>') +
    vendHtml + seccionDolares();

  $('invnueva').onclick = () => abrirInversion(null);
  if ($('invact')) $('invact').onclick = () => actualizarPrecios(true);
  $('page').querySelectorAll('[data-inv-editar]').forEach(b => b.onclick = () => abrirInversion(b.dataset.invEditar));
  $('page').querySelectorAll('[data-inv-vender]').forEach(b => b.onclick = () => abrirVenta(b.dataset.invVender));
  if (hayAuto && !INV.refrescando && (!INV.ts || Date.now() - INV.ts > INV_AUTO_MS)) actualizarPrecios(false);
}

async function actualizarPrecios(manual) {
  if (INV.refrescando) return;
  INV.refrescando = true; INV.ts = INV.ts || 0;
  if (S.vista === 'inversiones' && !hayEdicionAbierta()) renderInversiones();
  try {
    const r = await llamar('valuarInversiones');
    INV.lista = r.lista; INV.valores = r.valores; INV.avisos = r.avisos || []; INV.ts = r.actualizado || Date.now();
    INV.auto = { valores: r.valores, ts: INV.ts };
  } catch (e) {
    INV.ts = Date.now();   // no se reintenta en bucle: queda el botón para volver a probar
    INV.avisos = ['No pude traer los precios ahora (' + ((e && e.message) || 'sin conexión') + '). Se muestran los últimos conocidos.'];
  }
  INV.refrescando = false;
  if (S.vista === 'inversiones' && !hayEdicionAbierta()) renderInversiones();
  else if (S.vista === 'dashboard' && !hayEdicionAbierta()) render();
}

// --- formulario ---
const INV_CAMPOS = {
  'Plazo fijo': ['nombre', 'moneda', 'fecha', 'cantidad', 'tna', 'vencimiento', 'nota'],
  'Fondo común': ['codigo', 'moneda', 'fecha', 'cantidad', 'precio', 'valorManual', 'nota'],
  'Acción': ['codigo', 'moneda', 'fecha', 'cantidad', 'precio', 'valorManual', 'nota'],
  'CEDEAR': ['codigo', 'moneda', 'fecha', 'cantidad', 'precio', 'valorManual', 'nota'],
  'Bono': ['codigo', 'moneda', 'fecha', 'cantidad', 'precio', 'valorManual', 'nota'],
  'Cripto': ['codigo', 'fecha', 'cantidad', 'precio', 'valorManual', 'nota'],
  'Otro': ['nombre', 'moneda', 'fecha', 'precio', 'valorManual', 'nota'],
};

function invEtiquetas(tipo) {
  const e = {
    nombre: ['Nombre', tipo === 'Plazo fijo' ? 'Por ejemplo: Plazo fijo Banco Nación (opcional)' : 'Por ejemplo: Departamento, Obligación negociable…'],
    codigo: [tipo === 'Fondo común' ? 'Nombre del fondo' : 'Código (ticker)', tipo === 'Fondo común' ? 'Escribilo como figura en el banco o la app; tocá Buscar para confirmarlo.' : tipo === 'Cripto' ? 'Por ejemplo: BTC, ETH, SOL' : 'Por ejemplo: GGAL, AAPL, AL30'],
    moneda: ['Moneda', ''],
    fecha: [tipo === 'Plazo fijo' ? 'Fecha de constitución' : 'Fecha de compra', ''],
    cantidad: [tipo === 'Plazo fijo' ? 'Capital' : tipo === 'Fondo común' ? 'Cuotapartes' : tipo === 'Bono' ? 'Valor nominal (VN)' : 'Cantidad', ''],
    precio: [tipo === 'Otro' ? 'Cuánto invertiste' : tipo === 'Bono' ? 'Precio de compra (cada 100 VN)' : tipo === 'Fondo común' ? 'Valor de la cuotaparte al comprar' : tipo === 'Cripto' ? 'Precio de compra (en dólares)' : 'Precio de compra (por unidad)', ''],
    tna: ['Tasa (TNA %)', 'La tasa nominal anual que te dio el banco.'],
    vencimiento: ['Vencimiento', ''],
    valorManual: [tipo === 'Otro' ? 'Cuánto vale hoy' : 'Valor actual (opcional)', tipo === 'Otro' ? 'Actualizalo cuando quieras; si lo dejás vacío vale lo que invertiste.' : 'Solo si el precio automático no se encuentra. Es el total, no por unidad.'],
    nota: ['Nota', ''],
  };
  return e;
}

function abrirInversion(id) {
  const i = id ? INV.lista.filter(x => x.id === id)[0] : null;
  if (id && !i) return;
  INV.form = {
    id: id, confirmaBorrar: false, err: '', consulta: '',
    v: i ? { tipo: i.tipo, nombre: i.nombre === i.codigo ? '' : i.nombre, codigo: i.codigo, moneda: i.moneda, fecha: i.fecha, cantidad: i.tipo === 'Plazo fijo' || i.tipo !== 'Otro' ? String(i.cantidad) : '', precio: i.tipo === 'Plazo fijo' ? '' : String(i.precio),
      vencimiento: i.vencimiento, tna: i.tna ? String(i.tna) : '', valorManual: i.valorManual && i.tipo !== 'Otro' ? String(i.valorManual) : (i.tipo === 'Otro' ? String(i.valorManual || '') : ''), nota: i.nota, vendida: !invActiva(i) }
      : { tipo: 'Plazo fijo', nombre: '', codigo: '', moneda: 'ARS', fecha: hoyLocal(), cantidad: '', precio: '', vencimiento: '', tna: '', valorManual: '', nota: '' },
  };
  renderInversionForm();
}

function renderInversionForm() {
  const F = INV.form, v = F.v, nuevo = !F.id, E = invEtiquetas(v.tipo);
  const campos = INV_CAMPOS[v.tipo].map(k => {
    const [et, ay] = E[k];
    let input;
    if (k === 'moneda') input = '<select class="in" data-ik="moneda"><option value="ARS" ' + (v.moneda === 'ARS' ? 'selected' : '') + '>Pesos</option><option value="USD" ' + (v.moneda === 'USD' ? 'selected' : '') + '>Dólares</option></select>';
    else if (k === 'fecha' || k === 'vencimiento') input = '<input class="in" type="date" data-ik="' + k + '" value="' + esc(v[k]) + '">';
    else if (k === 'nota') input = '<input class="in" data-ik="nota" autocomplete="off" value="' + esc(v.nota) + '">';
    else if (k === 'nombre' || k === 'codigo') input = '<input class="in" data-ik="' + k + '" autocomplete="off" value="' + esc(v[k]) + '">' +
      (k === 'codigo' ? '<div style="margin-top:6px"><button class="mini" type="button" id="invbuscar">Buscar precio</button></div><div id="invconsulta" class="ayuda">' + F.consulta + '</div>' : '');
    else input = '<input class="in" data-ik="' + k + '" inputmode="decimal" autocomplete="off" value="' + esc(v[k]) + '">';
    return '<label class="f">' + esc(et) + (['cantidad', 'precio', 'fecha', 'vencimiento', 'tna', 'codigo'].indexOf(k) >= 0 && !(k === 'precio' && v.tipo === 'Plazo fijo') ? ' <b>*</b>' : '') + input + (ay ? '<div class="ayuda">' + esc(ay) + '</div>' : '') + '</label>';
  }).join('');
  const tipoSel = '<label class="f">Tipo <b>*</b><select class="in" data-ik="tipo"' + (nuevo ? '' : ' disabled') + '>' + INV_TIPOS.map(t => op(t, v.tipo)).join('') + '</select></label>';
  const aviso = nuevo ? '<div class="ayuda" style="margin-bottom:10px">Esto solo registra la inversión: no mueve plata de tus cuentas. Si la pagaste desde una cuenta, descontala con un Ajuste en Cargar (nota “Compra …”) para que el patrimonio no la cuente dos veces.</div>' : '';
  const acciones = !nuevo ? '<button class="btn danger" id="invborrar">' + (F.confirmaBorrar ? 'Tocá de nuevo para eliminar' : 'Eliminar') + '</button>' : '';
  $('modal').innerHTML = '<div class="overlay" id="ov"><div class="panel"><header><h2>' + (nuevo ? 'Agregar inversión' : 'Editar inversión') + '</h2><button class="x" id="cerrar" aria-label="Cerrar">×</button></header>' +
    '<div class="body" id="body"><div id="err">' + (F.err ? '<div class="aviso">' + esc(F.err) + '</div>' : '') + '</div>' + aviso + tipoSel + campos + '</div>' +
    '<footer><button class="btn primary" id="invguardar">Guardar</button>' + acciones + '</footer></div></div>';
  $('modal').classList.remove('hide');
  $('ov').onclick = e => { if (e.target.id === 'ov') cerrarInv(); };
  $('cerrar').onclick = cerrarInv;
  $('body').querySelectorAll('[data-ik]').forEach(el => {
    el.onchange = el.oninput = () => {
      v[el.dataset.ik] = el.value;
      if (el.dataset.ik === 'tipo') { v.moneda = el.value === 'Cripto' ? 'USD' : v.moneda; F.consulta = ''; renderInversionForm(); }
    };
  });
  if ($('invbuscar')) $('invbuscar').onclick = buscarPrecio;
  $('invguardar').onclick = guardarInv;
  if ($('invborrar')) $('invborrar').onclick = borrarInv;
}

function cerrarInv() { INV.form = null; INV.venta = null; cerrar(); }

async function buscarPrecio() {
  const F = INV.form, box = $('invconsulta');
  box.textContent = 'Buscando…';
  try {
    const r = await llamar('consultarPrecio', F.v.tipo, F.v.codigo);
    if (!INV.form) return;
    if (r.encontrado) {
      F.consulta = 'Encontrado: ' + esc(r.nombre) + ' · precio actual ' + esc(fmtMoneyRaw(r.precio, F.v.tipo === 'Cripto' ? 'USD' : F.v.moneda)) + (F.v.tipo === 'Fondo común' ? ' (cuotaparte)' : '');
      if (F.v.tipo === 'Fondo común' && r.nombre) { F.v.codigo = r.nombre; $('body').querySelector('[data-ik="codigo"]').value = r.nombre; }
      if (!F.v.precio && !F.id) { F.v.precio = String(r.precio); const p = $('body').querySelector('[data-ik="precio"]'); if (p) p.value = String(r.precio).replace('.', ','); F.v.precio = String(r.precio).replace('.', ','); }
    } else {
      F.consulta = esc(r.motivo || 'No lo encontré') + (r.parecidos && r.parecidos.length ? '<br>' + r.parecidos.map(p => '<button class="mini" type="button" data-parecido="' + esc(p) + '" style="margin:4px 4px 0 0">' + esc(p) + '</button>').join('') : '');
    }
  } catch (e) { F.consulta = esc((e && e.message) || 'No pude consultar ahora'); }
  box.innerHTML = F.consulta;
  box.querySelectorAll('[data-parecido]').forEach(b => b.onclick = () => { F.v.codigo = b.dataset.parecido; F.consulta = ''; renderInversionForm(); });
}

async function guardarInv() {
  const F = INV.form, b = $('invguardar');
  b.disabled = true;
  try {
    const d = Object.assign({ id: F.id || undefined }, F.v);
    delete d.vendida;
    const r = await llamar('guardarInversion', d);
    aplicarInversiones(r); INV.auto = null; INV.ts = 0;
    cerrarInv(); toast('Inversión guardada');
    render();
  } catch (e) {
    F.err = (e && e.message) || 'No se pudo guardar';
    renderInversionForm(); $('body').scrollTop = 0;
  }
}

async function borrarInv() {
  const F = INV.form;
  if (!F.confirmaBorrar) { F.confirmaBorrar = true; renderInversionForm(); return; }
  try {
    const r = await llamar('eliminarInversion', F.id);
    aplicarInversiones(r);
    cerrarInv(); toast('Inversión eliminada'); render();
  } catch (e) { F.err = (e && e.message) || 'No se pudo eliminar'; F.confirmaBorrar = false; renderInversionForm(); }
}

// --- venta / cobro ---
function abrirVenta(id) {
  const i = INV.lista.filter(x => x.id === id)[0];
  if (!i) return;
  const v = INV.valores[id] || {};
  const pf = i.tipo === 'Plazo fijo';
  INV.venta = { id: id, pf: pf, err: '', fecha: hoyLocal(), precio: String(pf ? (v.valor || '') : (v.precio || i.precio || '')).replace('.', ',') };
  renderVenta();
}

function renderVenta() {
  const V = INV.venta, i = INV.lista.filter(x => x.id === V.id)[0];
  $('modal').innerHTML = '<div class="overlay" id="ov"><div class="panel"><header><h2>' + (V.pf ? 'Cobraste el plazo fijo' : 'Vender') + ' · ' + esc(i.nombre) + '</h2><button class="x" id="cerrar" aria-label="Cerrar">×</button></header>' +
    '<div class="body" id="body"><div id="err">' + (V.err ? '<div class="aviso">' + esc(V.err) + '</div>' : '') + '</div>' +
    '<label class="f">Fecha <b>*</b><input class="in" type="date" data-vk="fecha" value="' + esc(V.fecha) + '"></label>' +
    '<label class="f">' + (V.pf ? 'Total que cobraste' : i.tipo === 'Bono' ? 'Precio de venta (cada 100 VN)' : 'Precio de venta (por unidad)') + ' <b>*</b><input class="in" data-vk="precio" inputmode="decimal" autocomplete="off" value="' + esc(V.precio) + '">' +
    '<div class="ayuda">' + (V.pf ? 'Capital más intereses, en ' + (i.moneda === 'USD' ? 'dólares' : 'pesos') + '.' : 'En ' + (i.moneda === 'USD' ? 'dólares' : 'pesos') + '. Queda guardada en “vendidas” con su resultado.') + '</div></label>' +
    '<div class="ayuda">Esto solo anota la venta: no suma la plata a tus cuentas. Cargala como Ingreso o Ajuste en Cargar si querés que aparezca en tu saldo.</div></div>' +
    '<footer><button class="btn primary" id="vgrabar">Guardar</button></footer></div></div>';
  $('modal').classList.remove('hide');
  $('ov').onclick = e => { if (e.target.id === 'ov') cerrarInv(); };
  $('cerrar').onclick = cerrarInv;
  $('body').querySelectorAll('[data-vk]').forEach(el => { el.onchange = el.oninput = () => { V[el.dataset.vk] = el.value; }; });
  $('vgrabar').onclick = async () => {
    $('vgrabar').disabled = true;
    try {
      const r = await llamar('venderInversion', V.id, { fecha: V.fecha, precio: V.precio });
      aplicarInversiones(r); INV.auto = null; INV.ts = 0;
      cerrarInv(); toast(V.pf ? 'Plazo fijo cobrado' : 'Venta registrada'); render();
    } catch (e) { V.err = (e && e.message) || 'No se pudo guardar'; renderVenta(); }
  };
}

// ---------- Cargar ----------
const C = { tipo: 'Gasto', v: {}, recientes: null, pendientes: [], error: '' };
const SIN_CUENTA = '(Sin cuenta)';
const TIPOS_CARGA = [['Gasto', 'Gasto'], ['Ingreso', 'Ingreso'], ['Transferencia', 'Transferencia'], ['Dolares', 'Dólares'], ['Pago Tarjeta', 'Pago de tarjeta'], ['Deuda', 'Deuda'], ['Ajuste', 'Ajuste']];

const hoyLocal = () => { const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
const cuentasActivas = () => S.data.cuentas.filas.filter(f => f.v.Estado !== 'Inactivo').map(f => f.v);
const cuentaPorNombre = n => cuentasActivas().filter(c => c.Nombre === n)[0];

function tarjetasActivas() { return (((S.data || {}).tarjetas || {}).filas || []).filter(f => f.v.Estado !== 'Inactivo').map(f => f.v); }
function esTarjetaNombre(n) { return !!n && tarjetasActivas().some(t => t.Nombre === n); }
function medioPorNombre(n) { return cuentaPorNombre(n) || tarjetasActivas().filter(t => t.Nombre === n)[0]; }

function reiniciarCarga(conservarCuenta) {
  let cuenta = conservarCuenta ? C.v.cuenta : (store.get('cargar_cuenta') || '');
  if (cuenta === SIN_CUENTA || (C.tipo !== 'Gasto' && esTarjetaNombre(cuenta))) cuenta = '';
  C.v = { dir: (C.v && C.v.dir) || 'compra', tc: (C.v && C.v.tc) || '', cuenta: cuenta, destino: '', monto: '', montoDest: '', sub: '', tarjeta: '', deuda: '', fecha: hoyLocal(), nota: '' };
  C.error = '';
}
reiniciarCarga(false);

const optCuentas = (actual, excluir) => '<option value="">Elegí una cuenta</option>' +
  cuentasActivas().filter(c => c.Nombre !== excluir).map(c => op(c.Nombre, actual, c.Nombre + ' (' + c.Moneda + ')')).join('');

function campoC(etiqueta, control, ayuda) {
  return '<label class="f">' + etiqueta + control + (ayuda ? '<div class="ayuda">' + esc(ayuda) + '</div>' : '') + '</label>';
}

const numAR = raw => { let t = String(raw == null ? '' : raw).trim().replace(/\s/g, ''); if (t.indexOf(',') >= 0 || /^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); return t === '' ? NaN : Number(t); };
const optMedios = actual => optCuentas(actual) + (tarjetasActivas().length
  ? '<optgroup label="Tarjetas (queda provisorio hasta el resumen)">' + tarjetasActivas().map(t => op(t.Nombre, actual, t.Nombre + ' (' + t.Moneda + ')')).join('') + '</optgroup>' : '');
const optCuentasMon = (actual, mon) => '<option value="">Elegí una cuenta</option>' +
  cuentasActivas().filter(c => c.Moneda === mon).map(c => op(c.Nombre, actual, c.Nombre)).join('');

/** Cuenta de pesos y de dólares, según se compre o se venda. */
function datosDolares() {
  const v = C.v, compra = v.dir !== 'venta', monto = numAR(v.monto), tc = numAR(v.tc);
  const ok = isFinite(monto) && monto > 0 && isFinite(tc) && tc > 0;
  const otro = ok ? Math.round((compra ? monto / tc : monto * tc) * 100) / 100 : 0;
  return { compra, monto, tc, ok, otro, monOrigen: compra ? 'ARS' : 'USD', monDestino: compra ? 'USD' : 'ARS' };
}

function textoResultadoDolares() {
  const d = datosDolares();
  if (!d.ok) return 'Completá el monto y la cotización para ver el equivalente.';
  return 'Recibís ' + fmtMoney(d.otro, d.monDestino) + '  ·  cotización ' + fmtNum(d.tc);
}

function actualizarDolares() { const e = $('dolres'); if (e) e.textContent = textoResultadoDolares(); }

function formularioCarga() {
  const v = C.v, cta = medioPorNombre(v.cuenta), mon = cta ? cta.Moneda : '';
  const sel = (k, opciones) => '<select class="in" data-c="' + k + '">' + opciones + '</select>';
  const txt = (k, ph, modo) => '<input class="in" data-c="' + k + '" inputmode="' + (modo || 'text') + '" autocomplete="off" placeholder="' + esc(ph || '') + '" value="' + esc(v[k]) + '">';
  let c = '';

  if (C.tipo === 'Gasto' || C.tipo === 'Ingreso') {
    c += C.tipo === 'Gasto'
      ? campoC('Cuenta o tarjeta', sel('cuenta', optMedios(v.cuenta)), esTarjetaNombre(v.cuenta) ? 'Con la tarjeta queda como provisorio: se reemplaza solo cuando importes el resumen.' : '')
      : campoC('Cuenta', sel('cuenta', optCuentas(v.cuenta)));
    c += campoC(C.tipo === 'Gasto' ? 'Categoría' : 'Tipo de ingreso', C.tipo === 'Gasto'
      ? selSub({ clase: 'consumo' }, v.sub).replace('data-k="sub"', 'data-c="sub"').replace('(sin categorizar)', 'Elegí una categoría')
      : sel('sub', '<option value="">Elegí un tipo</option>' + S.data.ingresos.filas.map(f => op(f.v['Tipo de Ingreso'], v.sub)).join('')));
  } else if (C.tipo === 'Transferencia') {
    c += campoC('Desde', sel('cuenta', optCuentas(v.cuenta)));
    c += campoC('Hacia', sel('destino', optCuentas(v.destino, v.cuenta)));
    const dst = cuentaPorNombre(v.destino);
    if (cta && dst && dst.Moneda !== cta.Moneda) c += campoC('Monto que llega (' + dst.Moneda + ')', txt('montoDest', '0', 'decimal'), 'Son monedas distintas: indicá cuánto llegó a destino.');
  } else if (C.tipo === 'Dolares') {
    const d = datosDolares();
    c += '<div class="seg" id="dirdol" style="margin-top:14px"><button class="' + (d.compra ? 'on' : '') + '" data-dir="compra">Comprar dólares</button><button class="' + (d.compra ? '' : 'on') + '" data-dir="venta">Vender dólares</button></div>';
    c += campoC(d.compra ? 'Pagás desde (pesos)' : 'Vendés desde (dólares)', sel('cuenta', optCuentasMon(v.cuenta, d.monOrigen)));
    c += campoC(d.compra ? 'Los dólares van a' : 'Los pesos van a', sel('destino', optCuentasMon(v.destino, d.monDestino)));
    c += campoC('Cotización (pesos por dólar)', txt('tc', 'Ej: 1450', 'decimal'));
    c += '<div class="aviso" id="dolres" style="margin-top:16px;font-weight:500">' + esc(textoResultadoDolares()) + '</div>';
  } else if (C.tipo === 'Pago Tarjeta') {
    c += campoC('Desde', sel('cuenta', optCuentas(v.cuenta).replace('</option>', '</option><option value="' + SIN_CUENTA + '"' + (v.cuenta === SIN_CUENTA ? ' selected' : '') + '>Sin cuenta (lo pagó o acreditó el banco)</option>')), v.cuenta === SIN_CUENTA ? 'Baja la deuda de la tarjeta sin tocar ninguna de tus cuentas.' : '');
    const tarjetas = S.data.tarjetas.filas.filter(f => f.v.Estado !== 'Inactivo' && (!mon || f.v.Moneda === mon)).map(f => op(f.v.Nombre, v.tarjeta));
    c += campoC('Tarjeta', sel('tarjeta', '<option value="">Elegí la tarjeta</option>' + tarjetas.join('')), mon ? 'Se muestran las tarjetas en ' + mon + '.' : '');
  } else if (C.tipo === 'Deuda') {
    const act = S.data.deudas.filas.filter(f => f.v.Estado !== 'Inactivo');
    const grupo = (rot, lista) => lista.length ? '<optgroup label="' + rot + '">' + lista.map(f => op(f.v.Nombre, v.deuda)).join('') + '</optgroup>' : '';
    c += campoC('Deuda', sel('deuda', '<option value="">Elegí la deuda</option>' + grupo('Lo que debés', act.filter(f => f.v.Tipo !== 'Por Cobrar')) + grupo('Lo que te deben', act.filter(f => f.v.Tipo === 'Por Cobrar'))), 'Cada pago o cobro suma una cuota en la solapa Deudas.');
    c += campoC(esPorCobrar() ? 'Cuenta donde te pagaron' : 'Cuenta desde la que pagaste', sel('cuenta', optCuentas(v.cuenta)));
  } else {   // Ajuste
    c += campoC('Cuenta', sel('cuenta', optCuentas(v.cuenta)));
  }

  const rotuloMonto = C.tipo === 'Ajuste' ? 'Monto (positivo suma, negativo resta)' : C.tipo === 'Dolares' ? (C.v.dir === 'venta' ? 'Dólares que vendés' : 'Pesos que pagás') : 'Monto';
  const montoHtml = '<label class="f">' + rotuloMonto + (C.tipo === 'Dolares' ? ' <span class="mut">· ' + (C.v.dir === 'venta' ? 'USD' : 'ARS') + '</span>' : mon ? ' <span class="mut">· ' + esc(mon) + '</span>' : '') +
    '<input class="in monto-grande" data-c="monto" inputmode="decimal" autocomplete="off" placeholder="0" value="' + esc(v.monto) + '"></label>';
  const fecha = '<label class="f">Fecha<input class="in" type="date" data-c="fecha" value="' + esc(v.fecha) + '"></label>';
  const nota = campoC('Nota (opcional)', txt('nota', C.tipo === 'Ajuste' ? 'Ej: Saldo inicial' : ''));
  const rotuloBoton = C.tipo === 'Deuda' ? (esPorCobrar() ? 'Registrar cobro' : 'Registrar pago') : 'Guardar';
  return (C.error ? '<div class="errbox">' + esc(C.error) + '</div>' : '') + montoHtml + c + fecha + nota + '<button class="btn primary" id="guardarc" style="width:100%;margin-top:18px">' + rotuloBoton + '</button>';
}

function esPorCobrar() {
  const d = S.data.deudas.filas.filter(f => f.v.Nombre === C.v.deuda)[0];
  return !!d && d.v.Tipo === 'Por Cobrar';
}

function filaReciente(m) {
  const signo = m.tipo === 'Gasto' ? '− ' : m.tipo === 'Ingreso' ? '+ ' : (m.tipo === 'Ajuste' ? (m.monto < 0 ? '− ' : '+ ') : '');
  return '<div class="rec-fila"><div style="min-width:0"><div class="rec-desc">' + esc(m.desc) + '</div><div class="mut small">' + esc(fechaCorta(m.fecha).slice(0, 5)) + ' · ' + esc(m.tipo) + ' · ' + esc(m.cuenta) + (esProvisorio(m) ? ' · provisorio' : '') + (m.destino ? ' → ' + esc(m.destino) : '') + '</div></div>' +
    '<div class="mono ' + (m.tipo === 'Gasto' ? 'neg' : '') + '" style="white-space:nowrap">' + signo + esc(fmtMoney(Math.abs(m.monto), m.moneda)) + '</div>' +
    '<button class="mini" data-borrar="' + esc(m.id) + '">Borrar</button></div>';
}

function renderCargar() {
  if (C.recientes === null) { necesitaDatos(); return; }
  if (!C.v.fecha) C.v.fecha = hoyLocal();
  const pend = C.pendientes.length
    ? '<div class="card cuerpo-c"><h2 class="titulo-c">Pendientes de este mes</h2>' + C.pendientes.map((p, i) =>
      '<div class="pend"><div style="min-width:0"><div class="rec-desc">' + esc(p.nombre) + '</div><div class="mut small">' + esc(p.movimiento === 'Ingreso' ? 'Ingreso' : 'Gasto') + ' · ' + esc(p.medio) + '</div></div>' +
      '<input class="in" id="pm' + i + '" inputmode="decimal" value="' + esc(p.monto) + '" style="width:120px">' +
      '<button class="mini fix" data-pend="' + i + '">OK</button></div>').join('') + '</div>'
    : '';
  const recientes = C.recientes.length
    ? '<div class="card cuerpo-c"><h2 class="titulo-c">Lo último que cargaste</h2>' + C.recientes.map(filaReciente).join('') + '</div>' : '';
  $('page').innerHTML = '<div class="cargar"><div><h1>Cargar</h1></div>' + pend +
    '<div class="card cuerpo-c"><div class="seg" id="tiposc" style="margin-bottom:6px">' + TIPOS_CARGA.map(t => '<button class="' + (C.tipo === t[0] ? 'on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>' +
    '<div id="formc">' + formularioCarga() + '</div></div>' + recientes + '</div>';
  enlazarCargar();
}

function enlazarCargar() {
  const pg = $('page');
  pg.querySelectorAll('#tiposc button').forEach(b => b.onclick = () => { C.tipo = b.dataset.t; C.error = ''; C.v.sub = ''; if (C.v.cuenta === SIN_CUENTA || (C.tipo !== 'Gasto' && esTarjetaNombre(C.v.cuenta))) C.v.cuenta = ''; renderCargar(); });
  const refrescar = () => { $('formc').innerHTML = formularioCarga(); enlazarForm(); };
  const enlazarForm = () => {
    document.querySelectorAll('#dirdol button').forEach(b => b.onclick = () => { C.v.dir = b.dataset.dir; C.v.cuenta = ''; C.v.destino = ''; refrescar(); });
    $('formc').querySelectorAll('[data-c]').forEach(el => {
      const k = el.dataset.c;
      el.oninput = el.onchange = () => {
        C.v[k] = el.value;
        if (C.tipo === 'Dolares' && (k === 'monto' || k === 'tc')) actualizarDolares();
        if (k === 'cuenta') { if (el.value !== SIN_CUENTA) store.set('cargar_cuenta', el.value); if (C.tipo === 'Transferencia' && C.v.destino === el.value) C.v.destino = ''; if (C.tipo === 'Pago Tarjeta') C.v.tarjeta = ''; }
        if (el.tagName === 'SELECT' && ['cuenta', 'destino', 'deuda'].indexOf(k) >= 0) { const m = C.v.monto; refrescar(); C.v.monto = m; }
      };
    });
    if ($('guardarc')) $('guardarc').onclick = guardarCarga;
  };
  enlazarForm();
  pg.querySelectorAll('[data-pend]').forEach(b => b.onclick = () => registrarPendiente(Number(b.dataset.pend)));
  pg.querySelectorAll('[data-borrar]').forEach(b => b.onclick = async () => {
    if (b.dataset.ok !== '1') { b.dataset.ok = '1'; b.textContent = '¿Seguro?'; return; }
    try { await llamar('eliminarMovimiento', b.dataset.borrar); M.movs = null; D.lista = null; C.recientes = null; renderCargar(); toast('Borrado'); }
    catch (e) { toast((e && e.message) || 'No se pudo borrar'); }
  });
}

function datosParaEnviar() {
  const v = C.v, base = { fecha: v.fecha, monto: isFinite(numAR(v.monto)) ? numAR(v.monto) : v.monto, cuenta: v.cuenta, nota: v.nota };
  switch (C.tipo) {
    case 'Gasto': case 'Ingreso': return Object.assign(base, { tipo: C.tipo, subcategoria: v.sub });
    case 'Transferencia': return Object.assign(base, { tipo: 'Transferencia', destino: v.destino, montoDestino: isFinite(numAR(v.montoDest)) ? numAR(v.montoDest) : v.montoDest });
    case 'Dolares': {
      const d = datosDolares();
      if (!d.ok) throw new Error('Completá el monto y la cotización');
      const nota = v.nota || (d.compra ? 'Compra de USD a ' : 'Venta de USD a ') + fmtNum(d.tc);
      return { fecha: v.fecha, tipo: 'Transferencia', cuenta: v.cuenta, destino: v.destino, monto: d.monto, montoDestino: d.otro, nota: nota };
    }
    case 'Pago Tarjeta': return Object.assign(base, { tipo: 'Pago Tarjeta', tarjeta: v.tarjeta });
    case 'Deuda': return Object.assign(base, { tipo: esPorCobrar() ? 'Cobro Deuda' : 'Pago Deuda', asignarA: v.deuda });
    default: return Object.assign(base, { tipo: 'Ajuste' });
  }
}

function despuesDeCargar(res, mensaje) {
  C.recientes = res.recientes; C.pendientes = res.pendientes;
  M.movs = null; D.lista = null;   // Movimientos y Deudas se vuelven a calcular
  toast(mensaje);
}

async function guardarCarga() {
  const b = $('guardarc'); b.disabled = true;
  try {
    despuesDeCargar(await llamar('registrarMovimiento', datosParaEnviar()), 'Guardado ✓');
    reiniciarCarga(true); renderCargar();
    const m = document.querySelector('[data-c="monto"]'); if (m) m.focus();
  } catch (e) { C.error = (e && e.message) || 'No se pudo guardar'; renderCargar(); window.scrollTo(0, 0); }
}

async function registrarPendiente(i) {
  const p = C.pendientes[i], b = document.querySelector('[data-pend="' + i + '"]');
  b.disabled = true;
  try {
    despuesDeCargar(await llamar('registrarMovimiento', { tipo: p.movimiento, cuenta: p.medio, fijo: p.nombre, monto: $('pm' + i).value, subcategoria: p.subcategoria, fecha: hoyLocal() }), p.nombre + ' registrado ✓');
    renderCargar();
  } catch (e) { b.disabled = false; toast((e && e.message) || 'No se pudo registrar'); }
}

// ---------- Resúmenes (historial y detalle) ----------
const R = { lista: null, movs: [], sel: '' };

const tarjetaCorta = n => 'Tarjeta ' + (String(n).length > 4 ? '•••• ' + String(n).slice(-4) : n);
const movsDe = r => R.movs.filter(m => m.origen === r.origen);

function renderResumenes() {
  if (R.lista === null) { necesitaDatos(); return; }
  const sel = R.lista.filter(r => r.cierre === R.sel)[0];
  if (sel) { renderDetalleResumen(sel); return; }
  const boton = '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="impciclo">Cargar movimientos del mes</button><button class="btn primary" id="impnuevo">Importar resumen</button></div>';
  const cp = consumosProvisorios(), provARS = cp.lista.filter(m => m.tipo === 'Gasto' && m.moneda === 'ARS').reduce((t, m) => t + m.monto, 0);
  const cicloHtml = cp.lista.length
    ? '<div class="card cuerpo-c" style="max-width:640px"><h2 class="titulo-c">Ciclo en curso (provisorio)</h2>' +
      '<div class="dfila"><span class="n">Movimientos cargados</span><span class="mono">' + cp.lista.length + '</span></div>' +
      '<div class="dfila"><span class="n">Gastos en pesos</span><span class="mono">' + esc(fmtMoney(provARS, 'ARS')) + '</span></div>' +
      '<div class="dfila"><span class="n">Último movimiento</span><span class="mono">' + esc(fechaCorta(cp.ultima)) + '</span></div>' +
      '<div class="mut small" style="margin-top:10px">Subí de nuevo el Excel cuando quieras actualizarlo. Se reemplaza solo cuando importes el resumen oficial.</div></div>' : '';
  if (!R.lista.length) {
    $('page').innerHTML = '<div class="titulo-fila"><h1>Resúmenes</h1>' + boton + '</div>' +
      cicloHtml + '<div class="card vacio">Todavía no importaste ningún resumen. Apretá <b style="color:var(--text)">Importar resumen</b> para cargar el primero.</div>';
  } else {
    const filas = R.lista.map(r => {
      const n = movsDe(r).length;
      return '<tr class="fila-res" data-cierre="' + esc(r.cierre) + '"><td class="mono">' + esc(fechaCorta(r.cierre)) + '</td>' +
        '<td class="mono">' + esc(r.vencimiento ? fechaCorta(r.vencimiento) : '—') + '</td><td>' + esc(tarjetaCorta(r.tarjeta)) + '</td>' +
        '<td class="r mono">' + esc(fmtMoney(r.saldoActual.ars, 'ARS')) + '</td>' +
        '<td class="r mono">' + (r.saldoActual.usd ? esc(fmtMoney(r.saldoActual.usd, 'USD')) : '<span class="mut">—</span>') + '</td>' +
        '<td class="r mono">' + esc(fmtMoney(r.pagoMinimo, 'ARS')) + '</td><td class="r mono">' + n + '</td></tr>';
    }).join('');
    $('page').innerHTML = '<div class="titulo-fila"><h1>Resúmenes</h1>' + boton + '</div>' + cicloHtml +
      '<div class="card tablewrap"><table><thead><tr><th>Cierre</th><th>Vence</th><th>Tarjeta</th><th class="r">Saldo ARS</th><th class="r">Saldo USD</th><th class="r">Pago mínimo</th><th class="r">Movimientos</th></tr></thead><tbody>' + filas + '</tbody></table></div>' +
      '<div class="mut" style="font-weight:400;font-size:13px">Tocá un resumen para ver su detalle.</div>';
  }
  $('impnuevo').onclick = () => { resetImp(); irVista('importar'); };
  $('impciclo').onclick = () => { resetImp(); I.modo = 'ciclo'; irVista('importar'); };
  $('page').querySelectorAll('.fila-res').forEach(tr => tr.onclick = () => { R.sel = tr.dataset.cierre; renderResumenes(); window.scrollTo(0, 0); });
}

function renderDetalleResumen(r) {
  const ms = movsDe(r).slice().sort((a, b) => a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0);
  const kpi = (l, v, s) => '<div class="card kpi"><span class="l">' + l + '</span><span class="v">' + esc(v) + '</span><span class="s">' + esc(s) + '</span></div>';
  const usd = n => n ? ' · ' + fmtMoney(n, 'USD') : '';
  const kpis = '<div class="kpis">' +
    kpi('Saldo del resumen', fmtMoney(r.saldoActual.ars, 'ARS'), (r.saldoActual.usd ? fmtMoney(r.saldoActual.usd, 'USD') : 'Sin saldo en dólares')) +
    kpi('Saldo anterior', fmtMoney(r.saldoAnterior.ars, 'ARS'), 'Pagos: ' + fmtMoney(Math.abs(r.pagos.ars), 'ARS') + usd(Math.abs(r.pagos.usd))) +
    kpi('Arrastrado', fmtMoney(r.arrastrado.ars, 'ARS'), 'de lo anterior sin pagar' + usd(r.arrastrado.usd)) +
    kpi('Pago mínimo', fmtMoney(r.pagoMinimo, 'ARS'), 'Vence ' + (r.vencimiento ? fechaCorta(r.vencimiento) : '—')) + '</div>';
  const tot = { ARS: 0, USD: 0 };
  ms.forEach(m => { if (m.tipo === 'Gasto') tot[m.moneda] = (tot[m.moneda] || 0) + m.monto; });
  const filas = ms.map(m => {
    const cat = m.tipo === 'Gasto' ? (m.subcategoria || '<span class="bad">Sin categorizar</span>') : '<span class="mut">' + esc(m.tipo) + (m.asignado ? ' → ' + esc(m.asignado) : '') + '</span>';
    return '<tr><td class="mono">' + esc(fechaCorta(m.fecha).slice(0, 5)) + '</td><td>' + esc(m.desc) + '</td><td>' + (m.tipo === 'Gasto' ? (m.subcategoria ? esc(m.subcategoria) : cat) : cat) + '</td>' +
      '<td class="mono">' + esc(m.cuota || '') + '</td><td class="r mono">' + (m.tipo === 'Gasto' ? '− ' : '') + esc(fmtMoney(m.monto, m.moneda)) + '</td></tr>';
  }).join('');
  $('page').innerHTML =
    '<div><button class="mini" id="volverlista">← Resúmenes</button><h1 style="margin-top:14px">Resumen del ' + esc(fechaCorta(r.cierre)) + '</h1>' +
    '<div class="mut" style="font-weight:400;margin-top:4px">' + esc(tarjetaCorta(r.tarjeta)) + (r.importado ? ' · importado el ' + esc(fechaCorta(r.importado)) : '') + '</div></div>' + kpis +
    '<div class="card tablewrap">' + (ms.length
      ? '<table><thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Cuota</th><th class="r">Monto</th></tr></thead><tbody>' + filas + '</tbody></table>'
      : '<div class="vacio">No hay movimientos de este resumen en la planilla.</div>') + '</div>' +
    '<div class="mut" style="font-weight:400;font-size:13px">Gastos de este resumen: <b class="mono" style="color:var(--text)">' + esc(fmtMoney(tot.ARS, 'ARS')) + '</b>' +
    (tot.USD ? ' · <b class="mono" style="color:var(--text)">' + esc(fmtMoney(tot.USD, 'USD')) + '</b>' : '') +
    '. Para recategorizar un movimiento, usá la solapa Movimientos.</div>';
  $('volverlista').onclick = () => { R.sel = ''; renderResumenes(); window.scrollTo(0, 0); };
}

// ---------- Dashboard ----------
const DB = { movs: null, deudas: [], res: [], hoy: '', periodo: '' };

const mesAnterior = ym => { let a = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1; if (m < 1) { m = 12; a--; } return a + '-' + ('0' + m).slice(-2); };
const dosMon = (ars, usd) => {
  const tc = tcActual();
  if (VISTA_MON && tc) return fmtMoneyRaw(VISTA_MON === 'USD' ? ars / tc + (usd || 0) : ars + (usd || 0) * tc, VISTA_MON);   // dos monedas -> una sola
  return fmtMoney(ars, 'ARS') + (usd ? '  ·  ' + fmtMoney(usd, 'USD') : '');
};
/** Pesos y dólares con signo: "− $ x · US$ y", o un solo total si hay conversión activa. */
function dosMonSigno(ars, usd) {
  const tc = tcActual();
  if (VISTA_MON && tc) { const n = VISTA_MON === 'USD' ? ars / tc + usd : ars + usd * tc; return (n < 0 ? '− ' : '') + fmtMoneyRaw(Math.abs(n), VISTA_MON); }
  return (ars < 0 ? '− ' : '') + fmtMoney(Math.abs(ars), 'ARS') + '  ·  ' + (usd < 0 ? '− ' : '') + fmtMoney(Math.abs(usd), 'USD');
}
function centroDonut(n) {
  if (OCULTAR) return '***';
  const c = convertir(n, 'ARS');
  return c.mon === 'ARS' && c.n >= 1e6 ? '$ ' + (c.n / 1e6).toFixed(2).replace('.', ',') + ' M' : fmtMoneyRaw(c.mon === 'ARS' ? Math.round(c.n) : c.n, c.mon);
}
function cortoMiles(n) {
  if (OCULTAR) return '***';
  const c = convertir(n, 'ARS');
  return c.mon === 'USD' ? fmtNum(Math.round(c.n)) : fmtNum(Math.round(c.n / 1000)) + 'k';
}
const porc = (a, b) => b ? Math.round(a / b * 100) : 0;

/** Saldo de cada cuenta: lo que sumaron o restaron los movimientos que afectan saldo (ajustes incluidos). */
function saldosCuentas() {
  const cuentas = {};
  S.data.cuentas.filas.forEach(f => { cuentas[f.v.Nombre] = { nombre: f.v.Nombre, moneda: f.v.Moneda, estado: f.v.Estado, saldo: 0, mov: 0 }; });
  let hayAjuste = false;
  DB.movs.forEach(m => {
    if (m.afecta !== 'Si') return;
    const o = cuentas[m.cuenta], d = cuentas[m.destino];
    if (m.tipo === 'Ajuste') hayAjuste = true;
    if (m.tipo === 'Ingreso' || m.tipo === 'Cobro Deuda' || m.tipo === 'Ajuste') { if (o) { o.saldo += m.monto; o.mov++; } }
    else if (m.tipo === 'Gasto' || m.tipo === 'Pago Deuda') { if (o) { o.saldo -= m.monto; o.mov++; } }
    else if (m.tipo === 'Transferencia') {
      if (o) { o.saldo -= m.monto; o.mov++; }
      if (d) { d.saldo += Number(m.montoDestino) || m.monto; d.mov++; }
    }
  });
  const lista = Object.keys(cuentas).map(k => cuentas[k]).filter(c => c.estado !== 'Inactivo' || c.mov);
  const total = { ARS: 0, USD: 0 };
  lista.forEach(c => { total[c.moneda] = (total[c.moneda] || 0) + c.saldo; });
  return { lista, total, hayAjuste };
}

/** Lo que falta pagar de la tarjeta: saldo del último resumen menos los pagos cargados después del cierre. */
function tarjetaPendiente() {
  const r = DB.res[0];
  if (!r) return null;
  const nombres = S.data.tarjetas.filas.filter(f => String(f.v['N° Tarjeta']) === String(r.tarjeta)).map(f => f.v.Nombre);
  const pagado = { ARS: 0, USD: 0 };
  DB.movs.forEach(m => { if (m.tipo === 'Transferencia' && nombres.indexOf(m.destino) >= 0 && m.fecha > r.cierre) pagado[m.moneda] = (pagado[m.moneda] || 0) + (Number(m.montoDestino) || m.monto); });
  const ars = Math.max(0, r.saldoActual.ars - pagado.ARS), usd = Math.max(0, r.saldoActual.usd - pagado.USD);
  const dias = r.vencimiento ? Math.round((new Date(r.vencimiento + 'T00:00:00') - new Date(DB.hoy + 'T00:00:00')) / 86400000) : null;
  return { r, ars, usd, pagado, dias };
}

/** Cuotas de tarjeta que ya están comprometidas hacia adelante (según el último resumen). */
function cuotasFuturas() {
  const r = DB.res[0];
  const o = { prox: { ARS: 0, USD: 0 }, total: { ARS: 0, USD: 0 }, n: 0, lista: [] };
  if (!r) return o;
  DB.movs.filter(m => m.origen === r.origen && (m.tipo === 'Gasto' || m.tipo === 'Adelanto') && /^\d+\/\d+$/.test(m.cuota)).forEach(m => {
    const p = m.cuota.split('/'), faltan = Number(p[1]) - Number(p[0]);
    if (faltan <= 0) return;
    o.prox[m.moneda] = (o.prox[m.moneda] || 0) + m.monto;
    o.total[m.moneda] = (o.total[m.moneda] || 0) + m.monto * faltan;
    o.n++; o.lista.push({ desc: m.desc.replace(/\s+C\.\d{2}\/\d{2}.*/, ''), faltan, monto: m.monto, moneda: m.moneda, adelanto: m.tipo === 'Adelanto' });
  });
  o.lista.sort((a, b) => b.monto * b.faltan - a.monto * a.faltan);
  return o;
}

function barra(pct, rojo) {
  return '<div class="barra"><i style="width:' + Math.min(100, Math.max(0, pct)) + '%;' + (rojo ? 'background:var(--accent)' : '') + '"></i></div>';
}

function renderDashboard() {
  if (DB.movs === null) { necesitaDatos(); return; }
  const util = DB.movs.filter(m => m.tipo === 'Gasto' || m.tipo === 'Ingreso');
  const sal = saldosCuentas(), tj = tarjetaPendiente(), cf = cuotasFuturas();
  if (!util.length && !sal.lista.some(c => c.mov)) {
    $('page').innerHTML = '<div><h1>Dashboard</h1></div><div class="card vacio">Todavía no hay movimientos para mostrar. Importá un resumen en <b style="color:var(--text)">Resúmenes</b> o cargá algo en <b style="color:var(--text)">Cargar</b>.</div>';
    return;
  }
  const meses = mesesDe(util), anio = (meses[0] || DB.hoy).slice(0, 4);
  const { cat: catDe, nat: natDe } = mapasGastos();
  const fvDe = {}; S.data.gastos.filas.forEach(f => { fvDe[f.v.Subcategoria] = f.v['Fijo/Variable']; });
  const enPer = (m, per) => per === 'todo' ? true : per === 'anio' ? m.fecha.slice(0, 4) === anio : m.fecha.slice(0, 7) === per;
  const per = DB.periodo;
  const base = util.filter(m => enPer(m, per));
  const suma = (lista, tipo, mon) => lista.filter(m => m.tipo === tipo && m.moneda === mon).reduce((s, m) => s + m.monto, 0);
  const ing = { ARS: suma(base, 'Ingreso', 'ARS'), USD: suma(base, 'Ingreso', 'USD') };
  const gas = { ARS: suma(base, 'Gasto', 'ARS'), USD: suma(base, 'Gasto', 'USD') };
  // cuotas de deudas pagadas: no son gasto (bajan la deuda) pero sí son plata que sale, así que descuentan del ahorro
  const sumaDeuda = (lista, mon) => lista.filter(m => m.tipo === 'Pago Deuda' && m.moneda === mon).reduce((s, m) => s + m.monto, 0);
  const periodoDeuda = DB.movs.filter(m => m.tipo === 'Pago Deuda' && enPer(m, per));
  const cuotas = { ARS: sumaDeuda(periodoDeuda, 'ARS'), USD: sumaDeuda(periodoDeuda, 'USD') };
  const ahorro = { ARS: ing.ARS - gas.ARS - cuotas.ARS, USD: ing.USD - gas.USD - cuotas.USD };
  const gARS = base.filter(m => m.tipo === 'Gasto' && m.moneda === 'ARS');
  const nMeses = Math.max(1, new Set(base.map(m => m.fecha.slice(0, 7))).size);
  const esMes = per !== 'todo' && per !== 'anio';
  const previo = esMes ? util.filter(m => m.fecha.slice(0, 7) === mesAnterior(per)) : [];
  const gPrevio = suma(previo, 'Gasto', 'ARS');

  // patrimonio estimado (cada moneda por separado, sin convertir)
  const deudasAct = DB.deudas.filter(d => d.estado !== 'Inactivo' && !d.finalizada);
  const sumD = (porCobrar, mon) => deudasAct.filter(d => d.porCobrar === porCobrar && d.moneda === mon).reduce((s, d) => s + d.pendiente, 0);
  const deuda = { ARS: sumD(false, 'ARS'), USD: sumD(false, 'USD'), UVA: sumD(false, 'UVA') };
  const cobrar = { ARS: sumD(true, 'ARS'), USD: sumD(true, 'USD') };
  const tjAR = tj ? tj.ars : 0, tjUS = tj ? tj.usd : 0;
  const inv = invTotales();
  const pat = { ARS: sal.total.ARS + cobrar.ARS + inv.ARS.valor - tjAR - deuda.ARS, USD: sal.total.USD + cobrar.USD + inv.USD.valor - tjUS - deuda.USD };

  // categorías
  const porCat = {};
  gARS.forEach(m => { const c = catDe[m.subcategoria] || 'Otros'; porCat[c] = (porCat[c] || 0) + m.monto; });
  let cats = Object.keys(porCat).map(n => ({ n, total: porCat[n] })).sort((a, b) => b.total - a.total);
  if (cats.length > 7) { const resto = cats.slice(6); cats = cats.slice(0, 6).concat([{ n: 'Otras', total: resto.reduce((s, c) => s + c.total, 0) }]); }
  cats.forEach((c, i) => { c.color = coloresCat()[Math.min(i, coloresCat().length - 1)]; });
  let acum = 0;
  const donut = gas.ARS ? 'conic-gradient(' + cats.map(c => { const a = acum; acum += c.total / gas.ARS * 100; return c.color + ' ' + a + '% ' + acum + '%'; }).join(',') + ')' : 'var(--surface-2)';

  const grupo = (clave, valores) => valores.map(v => ({ n: v, total: gARS.filter(m => clave(m) === v).reduce((s, m) => s + m.monto, 0) })).filter(x => x.total > 0);
  const naturaleza = grupo(m => natDe[m.subcategoria] || 'Sin definir', ['Necesidad', 'Prescindible', 'Deuda', 'Sin definir']);
  const fijoVar = grupo(m => fvDe[m.subcategoria] || 'Variable', ['Fijo', 'Variable']);
  const sinCat = base.filter(m => m.tipo === 'Gasto' && !m.subcategoria).length;
  const costoDeuda = naturaleza.filter(x => x.n === 'Deuda').reduce((s, x) => s + x.total, 0);

  // presupuesto
  // cada mes se mide con el presupuesto que tenía en ese momento (si lo cambiás hoy, los meses pasados no se modifican)
  const mesesPer = Array.from(new Set(base.map(m => m.fecha.slice(0, 7))));
  if (!mesesPer.length) mesesPer.push(esMes ? per : DB.hoy.slice(0, 7));
  const presDeMes = presupuestoDeMes;
  const subsPres = Array.from(new Set(S.data.presupuesto.filas.map(f => f.v.Subcategoria).concat(...(DB.presHist || []).map(h => Object.keys(h.valores)), ...Object.keys(DB.presMes || {}).map(k => Object.keys(DB.presMes[k])))));
  const pres = subsPres.map(sub => ({ sub, tope: mesesPer.reduce((t, ym) => t + (presDeMes(ym)[sub] || 0), 0) })).filter(p => p.tope > 0)
    .map(p => { const real = gARS.filter(m => m.subcategoria === p.sub).reduce((s, m) => s + m.monto, 0); return Object.assign(p, { real, pct: porc(real, p.tope) }); })
    .sort((a, b) => b.pct - a.pct);
  const presTope = pres.reduce((s, p) => s + p.tope, 0), presReal = pres.reduce((s, p) => s + p.real, 0);

  // evolución de los últimos 6 meses con datos
  const ult = meses.slice(0, 6).reverse().map(ym => {
    const l = util.filter(m => m.fecha.slice(0, 7) === ym);
    return { ym, i: suma(l, 'Ingreso', 'ARS'), g: suma(l, 'Gasto', 'ARS') + sumaDeuda(DB.movs.filter(m => m.fecha.slice(0, 7) === ym), 'ARS') };
  });
  const maxEv = Math.max(1, ...ult.map(x => Math.max(x.i, x.g)));

  // para mirar
  const avisos = [];
  if (!sal.hayAjuste) avisos.push('Todavía no cargaste los saldos iniciales de tus cuentas: usá Cargar → Ajuste (nota “Saldo inicial”) para que el patrimonio sea real.');
  if (esMes && DB.res[0] && per + '-31' > DB.res[0].cierre) {
    const cp = consumosProvisorios();
    avisos.push(cp.lista.length
      ? 'Los números de ' + nombreMes(per) + ' incluyen ' + cp.lista.length + ' movimientos provisorios de la tarjeta (hasta el ' + fechaCorta(cp.ultima) + '). Si hay compras más nuevas, subí otra vez el Excel en Resúmenes. Se reemplazan solos al importar el resumen oficial.'
      : 'Los números de ' + nombreMes(per) + ' son provisorios: el último resumen de tarjeta que importaste cierra el ' + fechaCorta(DB.res[0].cierre) + ', así que los consumos con tarjeta posteriores todavía no están. Para verlos en vivo, cargá el Excel del banco en Resúmenes → “Cargar movimientos del mes”.');
  }
  if (tj && tj.dias !== null && tj.ars > 0) {
    const cuando = tj.dias < 0 ? 'venció hace ' + (-tj.dias) + ' días' : tj.dias === 0 ? 'vence hoy' : 'vence en ' + tj.dias + ' días';
    avisos.push('La tarjeta ' + cuando + ': falta pagar ' + fmtMoney(tj.ars, 'ARS') + (tj.usd ? ' y ' + fmtMoney(tj.usd, 'USD') : '') + (sal.hayAjuste && sal.total.ARS < tj.ars ? ' (tus cuentas en pesos hoy no alcanzan)' : '') + '.');
  }
  pres.filter(p => p.pct > 100).slice(0, 3).forEach(p => avisos.push('Te pasaste del presupuesto de ' + p.sub + ': ' + p.pct + '% (' + fmtMoney(p.real, 'ARS') + ' de ' + fmtMoney(p.tope, 'ARS') + ').'));
  if (esMes && gPrevio) { const v = Math.round((gas.ARS - gPrevio) / gPrevio * 100); avisos.push('Gastaste ' + (v >= 0 ? v + '% más' : (-v) + '% menos') + ' que en ' + nombreMes(mesAnterior(per)) + '.'); }
  const presc = naturaleza.filter(x => x.n === 'Prescindible').reduce((s, x) => s + x.total, 0);
  if (gas.ARS && presc) avisos.push('El ' + porc(presc, gas.ARS) + '% de tus gastos en pesos es prescindible (' + fmtMoney(presc, 'ARS') + '): ahí es donde más fácil se recorta.');
  if (costoDeuda) avisos.push('Pagaste ' + fmtMoney(costoDeuda, 'ARS') + ' en intereses, comisiones y cuotas de préstamos.');
  if (cf.total.ARS) avisos.push('Ya tenés comprometidos ' + fmtMoney(cf.total.ARS, 'ARS') + ' en cuotas de tarjeta hacia adelante (' + fmtMoney(cf.prox.ARS, 'ARS') + ' en el próximo resumen).');
  if (sinCat) avisos.push(sinCat + ' gastos sin categorizar en este período: asignales una categoría en Movimientos.');

  const kpi = (l, v, s, color) => '<div class="card kpi"><span class="l">' + l + '</span><span class="v" ' + (color ? 'style="color:' + color + '"' : '') + '>' + esc(v) + '</span></div>';
  const tasa = ing.ARS ? porc(ahorro.ARS, ing.ARS) : null;
  const kpis = '<div class="kpis cinco">' +
    kpi('Ingresos', (VISTA_MON ? dosMonSigno(ing.ARS, ing.USD) : fmtMoney(ing.ARS, 'ARS')), ing.USD ? fmtMoney(ing.USD, 'USD') : 'en pesos') +
    kpi('Gastos', (VISTA_MON ? dosMonSigno(gas.ARS, gas.USD) : fmtMoney(gas.ARS, 'ARS')), (gas.USD ? fmtMoney(gas.USD, 'USD') + ' en dólares · ' : '') + (cuotas.ARS || cuotas.USD ? 'más ' + dosMon(cuotas.ARS, cuotas.USD) + ' en cuotas de deudas' : 'en pesos'), 'var(--danger)') +
    kpi('Ahorro del período', VISTA_MON ? dosMonSigno(ahorro.ARS, ahorro.USD) : (ahorro.ARS < 0 ? '− ' : '') + fmtMoney(Math.abs(ahorro.ARS), 'ARS'), tasa === null ? 'sin ingresos cargados' : tasa + '% de lo que ingresó, después de cuotas de deudas') +
    kpi('Patrimonio estimado', VISTA_MON ? dosMonSigno(pat.ARS, pat.USD) : (pat.ARS < 0 ? '− ' : '') + fmtMoney(Math.abs(pat.ARS), 'ARS'), 'en pesos · ' + (pat.USD < 0 ? '− ' : '') + fmtMoney(Math.abs(pat.USD), 'USD')) +
    kpi('Deuda de tarjeta', tj ? (VISTA_MON ? dosMonSigno(tj.ars, tj.usd) : fmtMoney(tj.ars, 'ARS')) : '—', tj ? (tj.usd ? fmtMoney(tj.usd, 'USD') + ' · ' : '') + 'pago mínimo ' + fmtMoney(tj.r.pagoMinimo, 'ARS') : 'sin resúmenes importados') + '</div>';

  const periodos = '<select class="in" id="dbper" style="width:auto;margin:0">' + meses.slice(0, 12).map(ym => op(ym, per, nombreMes(ym))).join('') +
    op('anio', per, 'Año ' + anio) + op('todo', per, 'Todo') + '</select>';

  const card = (titulo, html, extra) => '<div class="card cuerpo-c ' + (extra || '') + '"><h2 class="titulo-c">' + titulo + '</h2>' + html + '</div>';
  const fila = (a, b, c) => '<div class="dfila"><span class="n">' + a + '</span>' + (c || '') + '<span class="mono">' + b + '</span></div>';
  const grupoHtml = lista => lista.length ? lista.map(x => '<div class="dgr"><div class="dfila"><span class="n">' + esc(x.n) + '</span><span class="mono mut">' + porc(x.total, gas.ARS) + '%</span><span class="mono">' + esc(fmtMoney(x.total, 'ARS')) + '</span></div>' + barra(porc(x.total, gas.ARS)) + '</div>').join('') : '<div class="mut" style="font-weight:400">Sin datos</div>';

  const evolucion = ult.length ? '<div class="evol">' + ult.map(x => '<div class="evcol"><div class="evbars"><i class="ing" style="height:' + Math.round(x.i / maxEv * 100) + '%" title="Ingresos"></i><i class="gas" style="height:' + Math.round(x.g / maxEv * 100) + '%" title="Gastos"></i></div>' +
    '<span class="mut small">' + esc(MESES_CORTO[Number(x.ym.slice(5, 7)) - 1]) + '</span><span class="mono small ' + (x.i - x.g < 0 ? 'neg' : '') + '">' + (x.i - x.g < 0 ? '−' : '') + esc(cortoMiles(Math.abs(x.i - x.g))) + '</span></div>').join('') + '</div>' +
    '<div class="mut small" style="margin-top:8px"><span class="sw ing"></span> Ingresos &nbsp; <span class="sw gas"></span> Gastos</div>' : '';

  const presHtml = pres.length
    ? '<div class="dfila" style="margin-bottom:10px"><span class="n"><b>Total</b></span><span class="mono mut">' + porc(presReal, presTope) + '%</span><span class="mono">' + esc(fmtMoney(presReal, 'ARS')) + ' / ' + esc(fmtMoney(presTope, 'ARS')) + '</span></div>' + barra(porc(presReal, presTope), presReal > presTope) +
      '<div style="margin-top:14px">' + pres.map(p => '<div class="dgr"><div class="dfila"><span class="n">' + esc(p.sub) + '</span><span class="mono ' + (p.pct > 100 ? 'bad' : 'mut') + '">' + p.pct + '%</span><span class="mono">' + esc(fmtMoney(p.real, 'ARS')) + ' / ' + esc(fmtMoney(p.tope, 'ARS')) + '</span></div>' + barra(p.pct, p.pct > 100) + '</div>').join('') + '</div>'
    : '<div class="mut" style="font-weight:400">No hay presupuestos cargados. Definilos en DDMM → Presupuesto.</div>';

  const cuentasLista = sal.lista.map(c => fila(esc(c.nombre) + (c.nombre.slice(-3) === c.moneda ? '' : ' <span class="mut small">' + esc(c.moneda) + '</span>'), (c.saldo < 0 ? '− ' : '') + esc(fmtMoney(Math.abs(c.saldo), c.moneda)), '')).join('') +
    '<div class="dfila total"><span class="n"><b>Total en cuentas</b></span><span class="mono">' + esc(dosMon(sal.total.ARS, sal.total.USD)) + '</span></div>';
  const cuentasHtml = CHK.abierto ? chequeoHtml(sal.lista) : cuentasLista + '<button class="mini" id="chkabrir" style="margin-top:12px">Chequear saldos</button>';

  const patHtml = fila('En cuentas', esc(dosMon(sal.total.ARS, sal.total.USD))) +
    fila('Te deben', esc(dosMon(cobrar.ARS, cobrar.USD))) +
    (inv.ARS.n || inv.USD.n ? fila('Inversiones', esc(dosMon(inv.ARS.valor, inv.USD.valor))) : '') +
    fila('Tarjeta por pagar', '− ' + esc(dosMon(tjAR, tjUS))) +
    fila('Deudas pendientes', '− ' + esc(dosMon(deuda.ARS, deuda.USD))) +
    (deuda.UVA ? fila('Deuda en UVA <span class="mut small">(no se suma)</span>', esc(fmtMoney(deuda.UVA, 'UVA'))) : '') +
    '<div class="dfila total"><span class="n"><b>Patrimonio estimado</b></span><span class="mono">' + esc(dosMonSigno(pat.ARS, pat.USD)) + '</span></div>';

  const prox = deudasAct.filter(d => d.proximo).sort((a, b) => a.proximo < b.proximo ? -1 : 1).slice(0, 6);
  const diasA = iso => Math.round((new Date(iso + 'T00:00:00') - new Date(DB.hoy + 'T00:00:00')) / 86400000);
  const deudasHtml = prox.length ? prox.map(d => fila(esc(d.nombre) + ' <span class="mut small">' + (d.porCobrar ? 'te pagan' : 'pagás') + ' · ' + esc(fechaCorta(d.proximo).slice(0, 5)) + ' (' + (diasA(d.proximo) <= 0 ? 'hoy' : 'en ' + diasA(d.proximo) + ' d') + ')</span>', esc(fmtMoney(d.valor, d.moneda)))).join('') +
    '<div class="dfila total"><span class="n"><b>Cuotas por mes</b> <span class="mut small">(de deudas activas, sin UVA)</span></span><span class="mono">' + esc(dosMon(deudasAct.filter(d => !d.porCobrar && d.moneda === 'ARS').reduce((s, d) => s + d.valor, 0), deudasAct.filter(d => !d.porCobrar && d.moneda === 'USD').reduce((s, d) => s + d.valor, 0))) + '</span></div>'
    : '<div class="mut" style="font-weight:400">No hay deudas activas con vencimiento.</div>';

  const tjHtml = tj ? fila('Resumen del ' + esc(fechaCorta(tj.r.cierre)), esc(dosMon(tj.r.saldoActual.ars, tj.r.saldoActual.usd))) +
    fila('Pagos cargados después', '− ' + esc(dosMon(tj.pagado.ARS || 0, tj.pagado.USD || 0))) +
    '<div class="dfila total"><span class="n"><b>Falta pagar</b></span><span class="mono">' + esc(dosMon(tj.ars, tj.usd)) + '</span></div>' +
    fila('Vencimiento', esc(tj.r.vencimiento ? fechaCorta(tj.r.vencimiento) + (tj.dias !== null ? ' (' + (tj.dias < 0 ? 'hace ' + (-tj.dias) + ' d' : tj.dias === 0 ? 'hoy' : 'en ' + tj.dias + ' d') + ')' : '') : '—')) +
    fila('Arrastrado de antes', esc(fmtMoney(tj.r.arrastrado.ars, 'ARS'))) +
    ''
    : '<div class="mut" style="font-weight:400">Importá un resumen para ver la deuda de la tarjeta.</div>';

  const cuotasHtml = cf.n ? fila('Próximo resumen', esc(dosMon(cf.prox.ARS, cf.prox.USD))) + fila('Total hasta terminarlas', esc(dosMon(cf.total.ARS, cf.total.USD))) +
    '<div style="margin-top:10px">' + cf.lista.slice(0, 5).map(x => fila(esc(x.desc) + ' <span class="mut small">faltan ' + x.faltan + (x.adelanto ? ' · adelanto' : '') + '</span>', esc(fmtMoney(x.monto * x.faltan, x.moneda)))).join('') + '</div>'
    : '<div class="mut" style="font-weight:400">No hay cuotas pendientes en el último resumen.</div>';

  const top = gARS.slice().sort((a, b) => b.monto - a.monto).slice(0, 6);
  const topHtml = top.length ? top.map(m => fila(esc(m.desc) + ' <span class="mut small">' + esc(fechaCorta(m.fecha).slice(0, 5)) + (m.subcategoria ? ' · ' + esc(m.subcategoria) : '') + '</span>', esc(fmtMoney(m.monto, 'ARS')))).join('') : '<div class="mut" style="font-weight:400">Sin gastos en este período</div>';

  const leyenda = cats.map(c => '<div class="leg"><span class="sw" style="background:' + c.color + '"></span><span class="n">' + esc(c.n) + '</span><span class="mono">' + esc(fmtMoney(c.total, 'ARS')) + '</span><span class="mono mut pc">' + porc(c.total, gas.ARS) + '%</span></div>').join('');
  const catHtml = '<div class="donutbox chico"><div class="donut" style="background:' + donut + '"><div class="hole"><span class="mut" style="font-size:12px;font-weight:400">Gastos</span><span class="mono" style="font-size:15px;font-weight:600">' + esc(centroDonut(gas.ARS)) + '</span></div></div><div class="legend">' + (leyenda || '<div class="mut" style="font-weight:400">Sin gastos en pesos</div>') + '</div></div>';

  // caja real: qué entró y salió de tus cuentas en el período (misma lógica que "Saldo por cuenta")
  const ctasDe = {}, tjsDe = {};
  S.data.cuentas.filas.forEach(f => { ctasDe[f.v.Nombre] = f.v; });
  S.data.tarjetas.filas.forEach(f => { tjsDe[f.v.Nombre] = true; });
  const desdeC = per === 'todo' ? '' : per === 'anio' ? anio + '-01-01' : per + '-01';
  const hastaC = per === 'todo' ? '9999-12-31' : per === 'anio' ? anio + '-12-31' : per + '-31';
  const caja = { inicio: { ARS: 0, USD: 0 }, filas: {} };
  const poner = (m, mon, cat, v) => {
    if (m.fecha < desdeC) { caja.inicio[mon] = (caja.inicio[mon] || 0) + v; return; }
    if (m.fecha > hastaC) return;
    const fila = caja.filas[cat] = caja.filas[cat] || {};
    fila[mon] = (fila[mon] || 0) + v;
  };
  DB.movs.forEach(m => {
    if (m.afecta !== 'Si') return;
    const o = ctasDe[m.cuenta], d = ctasDe[m.destino];
    if (m.tipo === 'Ingreso' && o) poner(m, o.Moneda, 'Ingresos', m.monto);
    else if (m.tipo === 'Cobro Deuda' && o) poner(m, o.Moneda, 'Cobros de deudas', m.monto);
    else if (m.tipo === 'Gasto' && o) poner(m, o.Moneda, 'Gastos pagados desde cuentas', -m.monto);
    else if (m.tipo === 'Pago Deuda' && o) poner(m, o.Moneda, 'Cuotas de deudas', -m.monto);
    else if (m.tipo === 'Ajuste' && o) poner(m, o.Moneda, 'Ajustes de saldo', m.monto);
    else if (m.tipo === 'Transferencia') {
      if (o && tjsDe[m.destino]) poner(m, o.Moneda, 'Pagos de tarjeta', -m.monto);
      else if (o && d && o.Moneda === d.Moneda) { /* entre tus cuentas: el total no cambia */ }
      else {
        if (o) poner(m, o.Moneda, 'Compra y venta de dólares', -m.monto);
        if (d) poner(m, d.Moneda, 'Compra y venta de dólares', Number(m.montoDestino) || m.monto);
      }
    }
  });
  const ordenCaja = ['Ingresos', 'Cobros de deudas', 'Gastos pagados desde cuentas', 'Pagos de tarjeta', 'Cuotas de deudas', 'Compra y venta de dólares', 'Ajustes de saldo'];
  const filasCaja = ordenCaja.filter(c => caja.filas[c] && (caja.filas[c].ARS || caja.filas[c].USD));
  const cierreC = { ARS: caja.inicio.ARS || 0, USD: caja.inicio.USD || 0 };
  filasCaja.forEach(c => { cierreC.ARS += caja.filas[c].ARS || 0; cierreC.USD += caja.filas[c].USD || 0; });
  const celdaC = (v, mon) => v ? (v < 0 ? '− ' : '+ ') + esc(fmtMoneyRaw(Math.abs(v), mon)) : '<span class="mut">—</span>';
  const filaC = (a, b, c, cls) => '<div class="dfila caja ' + (cls || '') + '"><span class="n">' + a + '</span><span class="mono">' + b + '</span><span class="mono">' + c + '</span></div>';
  const cajaHtml = filaC('', 'Pesos', 'Dólares', 'cab mut small') +
    (desdeC ? filaC('Saldo al inicio', esc(fmtMoneyRaw(caja.inicio.ARS || 0, 'ARS')), esc(fmtMoneyRaw(caja.inicio.USD || 0, 'USD'))) : '') +
    filasCaja.map(c => filaC(esc(c), celdaC(caja.filas[c].ARS, 'ARS'), celdaC(caja.filas[c].USD, 'USD'))).join('') +
    filaC('<b>Saldo al cierre</b>', esc(fmtMoneyRaw(cierreC.ARS, 'ARS')), esc(fmtMoneyRaw(cierreC.USD, 'USD')), 'total') +
    '';

  $('page').innerHTML =
    '<div class="titulo-fila"><h1>Dashboard</h1>' + periodos + '</div>' + kpis +
    (avisos.length ? card('Para mirar', '<ul class="avisos">' + avisos.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul>') : '') +
    '<div class="dgrid-db">' +
    card('Ingresos y gastos por mes', evolucion || '<div class="mut" style="font-weight:400">Sin datos</div>', 'ancho') +
    card('En qué se va la plata', catHtml) +
    card('Presupuesto vs real' + (nMeses > 1 ? ' <span class="mut" style="text-transform:none;letter-spacing:0">(' + nMeses + ' meses)</span>' : ''), presHtml) +
    card('Necesidad, prescindible y deuda', grupoHtml(naturaleza)) +
    card('Gastos fijos y variables', grupoHtml(fijoVar)) +
    card('Mayores gastos del período', topHtml) +
    card('Patrimonio estimado', patHtml) +
    card('Cómo se movió tu plata (caja real)', cajaHtml, 'ancho') +
    card('Saldo por cuenta', cuentasHtml + (sal.hayAjuste ? '' : '<div class="mut small" style="margin-top:8px">Sin saldos iniciales: los saldos reflejan solo lo cargado.</div>')) +
    card('Tarjeta de crédito', tjHtml) +
    card('Cuotas de tarjeta comprometidas', cuotasHtml) +
    card('Próximos pagos de deudas', deudasHtml) +
    '</div>' +
    '';
  $('dbper').onchange = e => { DB.periodo = e.target.value; renderDashboard(); };
  enlazarChk();
}

// ---------- Datos compartidos entre solapas ----------
// Un solo pedido ("cargarTodo") alimenta Movimientos, Deudas, Resúmenes, Dashboard y Cargar.
// Las solapas se dibujan al instante con lo que ya hay y se refrescan en segundo plano.
const K = { ts: 0, p: null, h: null };
const TITULOS = { dashboard: 'Dashboard', flujo: 'Cashflow', cargar: 'Cargar', movs: 'Movimientos', deudas: 'Deudas', inversiones: 'Inversiones', resumenes: 'Resúmenes' };

/** Pide algo al servidor y, si falla por un corte pasajero (Google, conexión, demora), lo vuelve a intentar antes de rendirse. */
async function pedirConReintentos(fn, args, intentos) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try { return await llamarCore(fn, args); }
    catch (e) {
      if (e && e.auth) throw e;
      ultimo = e;
      if (i < intentos - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw ultimo;
}

function traerTodo(forzar) {
  if (!forzar && K.p) return K.p;
  const p = pedirConReintentos('cargarTodo', [], 3);
  K.p = p; K.ts = Date.now();
  p.then(r => { K.ultimo = r; K.ultimoTs = Date.now(); }, () => { if (K.p === p) { K.p = null; K.ts = 0; } });
  return p;
}

function aplicarTodo(r) {
  M.movs = r.movimientos;
  const meses = mesesDe(M.movs);
  if (M.periodo !== 'todo' && M.periodo !== 'anio' && meses.indexOf(M.periodo) < 0) M.periodo = meses[0] || 'todo';
  D.lista = r.deudas; D.hoy = r.hoy;
  R.lista = r.resumenes; R.movs = r.movimientos;
  DB.movs = r.movimientos; DB.deudas = r.deudas; DB.hoy = r.hoy || hoyLocal(); DB.res = r.resumenes; DB.presHist = r.presHist || []; DB.presMes = r.presMes || {};
  const mu = mesesDe(DB.movs.filter(x => x.tipo === 'Gasto' || x.tipo === 'Ingreso'));
  if (DB.periodo !== 'todo' && DB.periodo !== 'anio' && mu.indexOf(DB.periodo) < 0) DB.periodo = mu[0] || 'todo';
  C.recientes = r.cargar.recientes; C.pendientes = r.cargar.pendientes;
  Object.assign(PREFS, r.prefs || {});
  aplicarInversiones(r.inversiones);
}

/** Algo cambió en la planilla: lo guardado ya no sirve. Se vuelve a pedir en un rato, sin que tengas que esperar. */
function invalidarTodo() {
  K.ts = 0; K.p = null;
  M.movs = null; D.lista = null; R.lista = null; DB.movs = null; C.recientes = null; INV.lista = null;
  clearTimeout(K.h);
  K.h = setTimeout(() => { if (!K.p) refrescarSilencioso(); }, 1500);
}

const hayEdicionAbierta = () => {
  const modal = $('modal'), a = document.activeElement;
  return (modal && !modal.classList.contains('hide')) || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && $('page').contains(a));
};

async function refrescarSilencioso() {
  try { aplicarTodo(await traerTodo(true)); } catch (e) { return; }
  if (['dashboard', 'flujo', 'movs', 'deudas', 'inversiones', 'resumenes'].indexOf(S.vista) >= 0 && !hayEdicionAbierta()) render();
}

function esqueleto(vista) {
  const bloque = alto => '<div class="card esq" style="height:' + alto + 'px"></div>';
  return '<div class="titulo-fila"><h1>' + esc(TITULOS[vista] || '') + '</h1></div>' +
    (vista === 'cargar' ? bloque(420) : '<div class="kpis">' + [1, 2, 3, 4].map(() => bloque(86)).join('') + '</div>' + bloque(260) + bloque(200));
}

/** Una solapa necesita datos que todavía no hay: se muestra un esqueleto (no la solapa anterior) hasta que lleguen. */
async function necesitaDatos() {
  const vista = S.vista;
  $('page').innerHTML = esqueleto(vista);
  let fallo = null;
  try { aplicarTodo(await traerTodo()); }
  catch (e) { fallo = e; }
  if (S.vista !== vista) return;
  if (!fallo) { render(); return; }
  const motivo = (fallo && fallo.message) || 'No se pudieron cargar los datos';
  if (K.ultimo) {
    // hay una copia de hace un rato: se muestra eso, avisando que no está al día
    aplicarTodo(K.ultimo);
    render();
    const min = Math.max(1, Math.round((Date.now() - K.ultimoTs) / 60000));
    $('page').insertAdjacentHTML('afterbegin', '<div class="aviso-viejo">No pude actualizar (' + esc(motivo) + ') Estás viendo los datos de hace ' + min + (min === 1 ? ' minuto' : ' minutos') + '. <button class="mini" id="reintentar">Reintentar</button></div>');
  } else {
    $('page').innerHTML = '<div class="card" style="max-width:560px"><h2 class="titulo-c">No pude cargar tus datos</h2><p class="mut">' + esc(motivo) +
      '</p><p class="mut small">No se perdió nada: está todo guardado en tu planilla. Es un problema para leerla en este momento.</p><button class="btn primary" id="reintentar">Reintentar</button></div>';
  }
  const b = $('reintentar');
  if (b) b.onclick = () => { K.p = null; necesitaDatos(); };
}

// ---------- Flujo de caja ----------
const PREFS = { proximoCobro: '', consumoCiclo: 0, tcManual: 0 };
const FL = { dias: 60, abiertos: {} };

const diasEntre = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
const isoDe = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
const masDias = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDe(d); };
const masMeses = (iso, n) => {
  const p = iso.split('-').map(Number), d = new Date(p[0], p[1] - 1 + n, 1);
  d.setDate(Math.min(p[2], new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return isoDe(d);
};

/** Todo lo que va a entrar y salir de tus cuentas en pesos, con fecha, desde hoy hasta el horizonte elegido. */
function armarFlujo() {
  const hoy = DB.hoy, cobro = PREFS.proximoCobro && PREFS.proximoCobro >= hoy ? PREFS.proximoCobro : '';
  const finVista = masDias(hoy, FL.dias);
  const fin = cobro && masMeses(cobro, 1) > finVista ? masMeses(cobro, 1) : finVista;
  const sal = saldosCuentas(), tj = tarjetaPendiente(), cf = cuotasFuturas();
  const ev = [], sinEstimar = [], enDolares = [];
  const poner = (fecha, concepto, monto, tipo) => { if (fecha <= fin) ev.push({ fecha, concepto, monto, tipo }); };

  // tarjeta: lo que ya se debe y el próximo resumen
  if (tj && tj.ars > 0) {
    const vencida = tj.r.vencimiento && tj.r.vencimiento < hoy;
    poner(vencida || !tj.r.vencimiento ? hoy : tj.r.vencimiento, 'Tarjeta: saldo del resumen del ' + fechaCorta(tj.r.cierre) + (vencida ? ' (ya vencido: genera intereses)' : ''), -tj.ars, 'tarjeta');
  }
  if (tj && tj.r.vencimiento) {
    let prox = masMeses(tj.r.vencimiento, 1);
    while (prox < hoy) prox = masMeses(prox, 1);
    const listaTarjeta = fijosActivos().filter(v => v.Movimiento === 'Gasto' && fijoEsDeTarjeta(v));
    const fijosTarjeta = listaTarjeta.reduce((t, v) => t + fijoEnPesos(v), 0);
    const cp = consumosProvisorios();
    const consumo = Math.round((cp.total + (PREFS.consumoCiclo || 0)) * 100) / 100;
    if (consumo > 0) poner(prox, 'Tarjeta: lo que ya gastaste este ciclo' + (cp.libres.length ? ' (' + cp.libres.length + ' compras cargadas' + (PREFS.consumoCiclo > 0 ? ' + lo que sumaste' : '') + ')' : ''), -consumo, 'tarjeta');
    if (cf.prox.ARS > 0) poner(prox, 'Tarjeta: cuotas del próximo resumen', -cf.prox.ARS, 'tarjeta');
    if (fijosTarjeta > 0) poner(prox, 'Tarjeta: ' + listaTarjeta.length + ' fijos del mes (seguro, suscripciones, cuota del club…)', -Math.round(fijosTarjeta * 100) / 100, 'tarjeta');
  }

  // cuotas de deudas (las de UVA se estiman con el último pago que cargaste)
  DB.deudas.filter(d => d.estado !== 'Inactivo' && !d.finalizada && d.proximo).forEach(d => {
    let valor = d.valor;
    if (d.moneda === 'USD') { enDolares.push(d); return; }
    if (d.moneda === 'UVA') {
      const pagos = DB.movs.filter(m => m.tipo === 'Pago Deuda' && m.asignado === d.nombre && m.moneda === 'ARS').sort((a, b) => a.fecha < b.fecha ? 1 : -1);
      if (!pagos.length) { sinEstimar.push(d.nombre); return; }
      valor = pagos[0].monto;
    }
    for (let k = 0; k < d.restantes; k++) {
      const fecha = masMeses(d.proximo, k);
      if (fecha > fin) break;
      poner(fecha < hoy ? hoy : fecha, (d.porCobrar ? 'Te pagan: ' : 'Cuota: ') + d.nombre + (d.moneda === 'UVA' ? ' (estimada)' : ''), d.porCobrar ? valor : -valor, d.porCobrar ? 'ingreso' : 'deuda');
    }
  });

  // fijos del mes que todavía no cargaste (gastos: se asume que salen ya; ingresos: llegan al cobrar)
  C.pendientes.filter(p => p.movimiento === 'Gasto' && p.moneda === 'ARS').forEach(p => poner(hoy, 'Fijo pendiente: ' + p.nombre, -Number(p.monto), 'fijo'));

  // fijos del mes siguiente que salen de tus cuentas (se asume que salen justo después de cobrar)
  const fijosCuenta = fijosActivos().filter(v => v.Movimiento === 'Gasto' && !fijoEsDeTarjeta(v) && v.Moneda === 'ARS');
  const totFijosCuenta = fijosCuenta.reduce((t, v) => t + (Number(v.Monto) || 0), 0);
  if (cobro && totFijosCuenta > 0) poner(masDias(cobro, 1), 'Fijos que salen de tus cuentas (' + fijosCuenta.map(v => v.Nombre).join(', ') + ')', -totFijosCuenta, 'fijo');

  // cobros
  const sueldos = S.data.fijos.filas.filter(f => f.v.Movimiento === 'Ingreso' && f.v.Estado !== 'Inactivo' && f.v.Moneda === 'ARS').reduce((s, f) => s + (Number(f.v.Monto) || 0), 0);
  if (cobro && sueldos > 0) {
    poner(cobro, 'Cobro de tus ingresos fijos', sueldos, 'cobro');
    poner(masMeses(cobro, 1), 'Cobro de tus ingresos fijos', sueldos, 'cobro');
  }

  // plazos fijos en pesos que vencen: vuelven a tus cuentas el capital y los intereses (los ya vencidos no se cuentan: si ya los cobraste, están en tu saldo)
  (INV.lista || []).filter(i => i.tipo === 'Plazo fijo' && i.estado !== 'Vendida' && i.moneda === 'ARS' && i.vencimiento >= hoy && INV.valores[i.id] && INV.valores[i.id].valorVenc).forEach(i => {
    poner(i.vencimiento, 'Vence plazo fijo: ' + i.nombre, INV.valores[i.id].valorVenc, 'ingreso');
  });

  ev.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.monto - b.monto);
  let saldo = sal.total.ARS;
  ev.forEach(e => { saldo += e.monto; e.saldo = saldo; });
  const evVista = ev.filter(e => e.fecha <= finVista);
  const primerRojo = evVista.filter(e => e.saldo < 0)[0];

  // cuánto podés gastar hasta cobrar
  let hasta = null;
  if (cobro) {
    const salidas = ev.filter(e => e.monto < 0 && e.fecha <= cobro), entradas = ev.filter(e => e.monto > 0 && e.fecha < cobro);
    const sumar = l => l.reduce((s, e) => s + e.monto, 0);
    const libre = sal.total.ARS + sumar(salidas) + sumar(entradas);
    // y después de cobrar: entra el sueldo y salen las cuotas y el resumen de la tarjeta hasta el siguiente cobro
    const siguiente = masMeses(cobro, 1);
    const post = ev.filter(e => (e.fecha === cobro && e.monto > 0) || (e.fecha > cobro && e.fecha < siguiente));
    const libre2 = libre + sumar(post), dias2 = Math.max(1, diasEntre(cobro, siguiente));
    const despues = { siguiente, post, libre2, dias2, porDia2: libre2 > 0 ? libre2 / dias2 : 0 };
    const tarjetaYa = salidas.filter(e => e.tipo === 'tarjeta' && e.fecha === hoy).reduce((s, e) => s - e.monto, 0);
    const dias = Math.max(1, diasEntre(hoy, cobro));
    hasta = { cobro, dias, salidas, entradas, despues, libre, porDia: libre > 0 ? libre / dias : 0, sinPagarTarjeta: libre + tarjetaYa, tarjetaYa };
  }
  return { hoy, fin, saldo: sal.total.ARS, saldoUSD: sal.total.USD, ev: evVista, hasta, primerRojo, sinEstimar, enDolares, sueldos };
}

function guardarPref(datos) {
  Object.assign(PREFS, datos);
  actualizarCabecera();
  render();
  llamar('guardarPrefs', datos).catch(e => toast((e && e.message) || 'No se pudo guardar'));
}

function renderFlujo() {
  if (DB.movs === null) { necesitaDatos(); return; }
  const F = armarFlujo();
  const money = n => (n < 0 ? '− ' : '') + fmtMoney(Math.abs(n), 'ARS');
  const card = (t, html) => '<div class="card cuerpo-c"><h2 class="titulo-c">' + t + '</h2>' + html + '</div>';
  const fila = (a, b, cls) => '<div class="dfila ' + (cls || '') + '"><span class="n">' + a + '</span><span class="mono">' + b + '</span></div>';
  const signoF = n => (n < 0 ? '− ' : '+ ') + fmtMoney(Math.abs(n), 'ARS');
  // una sola línea por grupo; tocándola se abre el detalle (queda abierta o cerrada aunque se vuelva a dibujar)
  const grupoF = (id, titulo, lista) => {
    if (!lista.length) return '';
    const total = lista.reduce((t, e) => t + e.monto, 0);
    return '<details class="desglose" data-g="' + id + '"' + (FL.abiertos[id] ? ' open' : '') + '><summary><div class="dfila"><span class="n">' + titulo +
      ' <span class="mut small">(' + lista.length + ')</span></span><span class="mono">' + esc(signoF(total)) + '</span></div></summary>' +
      lista.map(e => fila(esc(e.concepto) + ' <span class="mut small">' + esc(fechaCorta(e.fecha).slice(0, 5)) + '</span>', esc(signoF(e.monto)), 'sub')).join('') + '</details>';
  };

  const datos = card('Tus datos', '<div class="dgrid-db" style="gap:0 16px"><label class="f">Fecha cobro<input class="in" type="date" id="fcobro" value="' + esc(PREFS.proximoCobro) + '"></label>' +
    '<label class="f">' + 'Otros consumos sin cargar' + '<input class="in" id="fconsumo" inputmode="decimal" autocomplete="off" placeholder="0" value="' + (PREFS.consumoCiclo ? esc(String(PREFS.consumoCiclo).replace('.', ',')) : '') + '">' +
    '</label></div>');

  let hasta;
  if (!F.hasta) {
    hasta = card('Hasta que cobres', '<div class="mut" style="font-weight:400">Elegí arriba la fecha en que cobrás y te digo cuánto podés gastar hasta ese día.</div>');
  } else {
    const h = F.hasta, neg = h.libre < 0;
    const lineas = [fila('Plata hoy en tus cuentas' + (VISTA_MON ? '' : ' (pesos)'), money(F.saldo)), grupoF('hasta-ing', 'Ingresos', h.entradas), grupoF('hasta-gas', 'Gastos', h.salidas)];
    hasta = card('Para llegar al cobro (' + esc(fechaCorta(h.cobro).slice(0, 5)) + ', en ' + h.dias + (h.dias === 1 ? ' día' : ' días') + ')',
      '<div class="gran ' + (neg ? 'bad' : '') + '">' + esc(money(h.libre)) + '</div>' +
      '<div class="mut" style="font-weight:400;margin:2px 0 14px">' + (neg ? 'No te alcanza con lo que tenés: te faltan ' + esc(fmtMoney(-h.libre, 'ARS')) + ' para cubrir todo hasta cobrar.' : 'Es lo que podés gastar hasta cobrar, <b style="color:var(--text)">~' + esc(fmtMoney(Math.round(h.porDia), 'ARS')) + ' por día</b>, después de pagar lo que ya tenés comprometido.') + '</div>' +
      lineas.join('') + '<div class="dfila total"><span class="n"><b>Te queda para gastar hasta cobrar</b></span><span class="mono">' + esc(money(h.libre)) + '</span></div>' +
      (h.tarjetaYa ? '<div class="mut small" style="margin-top:10px">Si decidís no pagar todavía la tarjeta vencida, tendrías ' + esc(money(h.sinPagarTarjeta)) + ' libres, pero cada día de demora cuesta intereses (más IVA), y son altos.</div>' : ''));
  }

  let desp = '';
  if (F.hasta) {
    const h = F.hasta, d = h.despues, neg2 = d.libre2 < 0;
    const signo = n => (n < 0 ? '− ' : '+ ') + fmtMoney(Math.abs(n), 'ARS');
    const lin2 = [fila('Lo que te queda al llegar al cobro', money(h.libre)), grupoF('post-ing', 'Ingresos', d.post.filter(e => e.monto > 0)), grupoF('post-gas', 'Gastos', d.post.filter(e => e.monto < 0))];
    desp = card('Resto post-cobro',
      '<div class="gran ' + (neg2 ? 'bad' : '') + '">' + esc(money(d.libre2)) + '</div>' +
      '<div class="mut" style="font-weight:400;margin:2px 0 14px">' + (neg2 ? 'Saldo tras el cobro del ' + esc(fechaCorta(h.cobro).slice(0, 5)) + ' y los compromisos hasta el ' + esc(fechaCorta(d.siguiente).slice(0, 5)) + ': faltan ' + esc(fmtMoney(-d.libre2, 'ARS')) + '.' :
        'Saldo tras el cobro del ' + esc(fechaCorta(h.cobro).slice(0, 5)) + ' y los compromisos hasta el ' + esc(fechaCorta(d.siguiente).slice(0, 5)) + ' (disponible diario <b style="color:var(--text)">~' + esc(fmtMoney(Math.round(d.porDia2), 'ARS')) + '</b>).') + '</div>' +
      lin2.join('') + '<div class="dfila total"><span class="n"><b>Te queda para gastar</b></span><span class="mono">' + esc(money(d.libre2)) + '</span></div>' +
      '<div class="mut small" style="margin-top:10px">Incluye tus fijos del mes. No incluye gastos de efectivo o débito que todavía no hiciste.</div>');
  }

  const filasTl = F.ev.length ? F.ev.map(e => '<div class="tl' + (e.saldo < 0 ? ' rojo' : '') + '"><span class="mono mut">' + esc(fechaCorta(e.fecha).slice(0, 5)) + '</span><span class="n">' + esc(e.concepto) +
    '</span><span class="mono ' + (e.monto < 0 ? 'neg' : '') + '">' + (e.monto < 0 ? '− ' : '+ ') + esc(fmtMoney(Math.abs(e.monto), 'ARS')) + '</span><span class="mono sal">' + esc(money(e.saldo)) + '</span></div>').join('')
    : '<div class="mut" style="font-weight:400">No hay movimientos previstos en este período.</div>';
  const horizonte = '<div class="seg" id="horiz" style="margin-bottom:12px">' + [30, 60, 90].map(n => '<button class="' + (FL.dias === n ? 'on' : '') + '" data-d="' + n + '">' + n + ' días</button>').join('') + '</div>';
  const tl = card('Qué viene en los próximos días', horizonte +
    '<div class="tl cab"><span>Fecha</span><span>Descripción</span><span class="mono">Monto</span><span class="mono sal">Saldo</span></div>' + fila('Hoy: lo que tenés en cuentas' + (VISTA_MON ? '' : ' (pesos)'), money(F.saldo), 'tlini') + filasTl +
    '');

  const notas = [];
  if (F.enDolares.length) notas.push('No tiene en cuenta cuotas en USD');
  if (F.sinEstimar.length) notas.push('No pude estimar la cuota de ' + F.sinEstimar.map(esc).join(', ') + ' (está en UVA y todavía no cargaste ningún pago).');
  if (fijosActivos().some(v => v.Moneda === 'USD' && v.Movimiento === 'Gasto')) notas.push('Los fijos en dólares se pasan a pesos. ' + textoTC() + ' La tarjeta puede cobrar más por impuestos.');
  notas.push('No incluye gastos de efectivo o débito que todavía no hiciste. Cuanto más cargues, más preciso es.');

  $('page').innerHTML = '<div class="titulo-fila"><h1>Cashflow</h1></div>' + datos + desp + hasta + tl +
    '<div class="mut small" style="max-width:760px">' + notas.join('<br>') + '</div>';

  // mientras escribís el año (2 → 20 → 202 → 2026) el navegador ya da fechas "válidas": se espera a que el año sea real
  $('fcobro').onchange = e => { const v = e.target.value; if (v === '' || (v >= '2020-01-01' && v <= '2100-12-31')) guardarPref({ proximoCobro: v }); };
  $('fconsumo').onchange = e => { const n = numAR(e.target.value); guardarPref({ consumoCiclo: isFinite(n) && n >= 0 ? n : 0 }); };
  document.querySelectorAll('details.desglose').forEach(d => d.addEventListener('toggle', () => { FL.abiertos[d.dataset.g] = d.open; }));
  $('horiz').querySelectorAll('button').forEach(b => b.onclick = () => { FL.dias = Number(b.dataset.d); renderFlujo(); });
}

// ---------- Cotización del dólar y total de fijos ----------
const TC = { venta: 0, fecha: '', fuente: '' };
const tcEfectivo = () => (PREFS.tcManual > 0 ? PREFS.tcManual : TC.venta) || 0;

function cargarTC() {
  llamarCore('cotizacion', []).then(r => {
    if (!r) return;
    Object.assign(TC, r); actualizarCabecera();
    if ((S.vista === 'flujo' || (S.vista === 'maestros' && S.id === 'fijos')) && !hayEdicionAbierta()) render();
  }).catch(() => { /* sin cotización automática: se puede poner una a mano */ });
}

const fijosActivos = () => S.data.fijos.filas.map(f => f.v).filter(v => v.Estado !== 'Inactivo');
const fijoEsDeTarjeta = v => S.data.tarjetas.filas.some(t => t.v.Nombre === v['Medio de Pago']);
const fijoEnPesos = v => (Number(v.Monto) || 0) * (v.Moneda === 'USD' ? tcEfectivo() : 1);

function textoTC() {
  const tc = tcEfectivo();
  if (!tc) return 'Todavía no tengo la cotización del dólar: escribila abajo para ver el total en pesos.';
  const manual = PREFS.tcManual > 0;
  return 'Dólar a ' + fmtMoney(tc, 'ARS') + (manual ? ' (cotización que pusiste vos)' : ' · ' + (TC.fuente || 'Dólar oficial') + (TC.fecha ? ', ' + fechaCorta(TC.fecha.slice(0, 10)) : ''));
}

function resumenFijosHtml() {
  const fl = fijosActivos(), tc = tcEfectivo();
  const suma = (mov, mon) => fl.filter(v => v.Movimiento === mov && v.Moneda === mon).reduce((s, v) => s + (Number(v.Monto) || 0), 0);
  const g = { ARS: suma('Gasto', 'ARS'), USD: suma('Gasto', 'USD') }, i = { ARS: suma('Ingreso', 'ARS'), USD: suma('Ingreso', 'USD') };
  const totG = g.ARS + g.USD * tc, totI = i.ARS + i.USD * tc;
  const fila = (a, b, cls) => '<div class="dfila ' + (cls || '') + '"><span class="n">' + a + '</span><span class="mono">' + b + '</span></div>';
  const enTarjeta = fl.filter(v => v.Movimiento === 'Gasto' && fijoEsDeTarjeta(v)).reduce((s, v) => s + fijoEnPesos(v), 0);
  return '<div class="card cuerpo-c" style="max-width:640px"><h2 class="titulo-c">Total de fijos al mes (en pesos)</h2>' +
    fila('Gastos fijos en pesos', esc(fmtMoneyRaw(g.ARS, 'ARS'))) +
    (g.USD ? fila('Gastos fijos en dólares <span class="mut small">' + (tc ? esc(fmtMoneyRaw(g.USD, 'USD')) + ' × ' + esc(fmtNum(tc)) : esc(fmtMoneyRaw(g.USD, 'USD')) + ', sin cotización') + '</span>', tc ? esc(fmtMoneyRaw(Math.round(g.USD * tc * 100) / 100, 'ARS')) : '—') : '') +
    fila('<b>Total de gastos fijos</b>' + (enTarjeta ? ' <span class="mut small">· ' + esc(fmtMoneyRaw(Math.round(enTarjeta), 'ARS')) + ' van por la tarjeta</span>' : ''), '<b>' + esc(fmtMoneyRaw(Math.round(totG * 100) / 100, 'ARS')) + '</b>', 'total') +
    (totI ? fila('Ingresos fijos', esc(fmtMoneyRaw(Math.round(totI * 100) / 100, 'ARS'))) + fila('Te queda después de los fijos', esc((totI - totG < 0 ? '− ' : '') + fmtMoneyRaw(Math.abs(Math.round((totI - totG) * 100) / 100), 'ARS'))) : '') +
    '<div class="mut small" style="margin-top:12px">' + esc(textoTC()) + '</div>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap"><input class="in" id="tcmanual" inputmode="decimal" autocomplete="off" placeholder="Usar otra cotización" value="' + (PREFS.tcManual > 0 ? esc(String(PREFS.tcManual).replace('.', ',')) : '') + '" style="width:200px;margin:0">' +
    (PREFS.tcManual > 0 ? '<button class="mini" id="tcauto">Volver a la automática</button>' : '') + '</div></div>';
}

function enlazarTC() {
  const m = $('tcmanual'), a = $('tcauto');
  if (m) m.onchange = () => { const n = numAR(m.value); guardarPref({ tcManual: isFinite(n) && n > 0 ? n : 0 }); };
  if (a) a.onclick = () => guardarPref({ tcManual: 0 });
}

// ---------- Movimientos del mes (Excel "Últimos movimientos" del banco) ----------
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.core.min.js';
const XLSX_SRI = 'sha512-UhlYw//T419BPq/emC5xSZzkjjreRfN3426517rfsg/XIEC02ggQBb680V0VvP+zaDZ78zqse3rqnnI5EJ6rxA==';
const esProvisorio = m => String(m.origen || '').indexOf('Ciclo tarjeta') === 0;

function cargarXlsx() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = XLSX_URL; s.integrity = XLSX_SRI; s.crossOrigin = 'anonymous';
    s.onload = ok;
    s.onerror = () => no(new Error('No se pudo cargar el lector de Excel. ¿Tenés internet?'));
    document.head.appendChild(s);
  });
}

function fechaDeBanco(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return '';
  const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), mes = Number(m[2]), dia = Number(m[1]);
  const d = new Date(anio, mes - 1, dia);
  if (d.getFullYear() !== anio || d.getMonth() !== mes - 1 || d.getDate() !== dia) return '';
  return anio + '-' + ('0' + mes).slice(-2) + '-' + ('0' + dia).slice(-2);
}

function montoDeBanco(v) {
  const texto = String(v == null ? '' : v);
  let n = texto.replace(/[^0-9,.\-]/g, '');
  if (n.indexOf(',') >= 0) n = n.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(n)) n = n.replace(/\./g, '');
  const monto = Number(n);
  return n && isFinite(monto) && monto !== 0 ? { monto: monto, moneda: /usd|u\$s/i.test(texto) ? 'USD' : 'ARS' } : null;
}

function cuotaDeBanco(v) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
  return m ? Number(m[1]) + '/' + Number(m[2]) : '';
}

/** Convierte la hoja del banco en renglones { fecha, desc, cuota, monto (con signo), moneda }. */
function itemsDeExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'array' });
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  const norm = x => String(x == null ? '' : x).trim().toLowerCase();
  const h = filas.findIndex(f => f.some(c => norm(c).indexOf('fecha') === 0) && f.some(c => norm(c).indexOf('monto') === 0));
  if (h < 0) throw new Error('No encontré las columnas Fecha y Monto. ¿Es el Excel de “Últimos movimientos” de la tarjeta?');
  const col = nombre => filas[h].findIndex(c => norm(c).indexOf(nombre) === 0);
  const cf = col('fecha'), cd = col('movimiento'), cc = col('cuota'), cm = col('monto');
  if (cd < 0) throw new Error('No encontré la columna de movimientos en el Excel.');
  const items = []; let saltados = 0;
  filas.slice(h + 1).forEach(f => {
    const fecha = fechaDeBanco(f[cf]), desc = String(f[cd] == null ? '' : f[cd]).replace(/\s+/g, ' ').trim(), m = montoDeBanco(f[cm]);
    if (!fecha || !desc || !m) { if (desc || String(f[cm] || '').trim()) saltados++; return; }
    items.push({ fecha: fecha, desc: desc, cuota: cc >= 0 ? cuotaDeBanco(f[cc]) : '', monto: m.monto, moneda: m.moneda });
  });
  return { items: items, saltados: saltados };
}

async function leerExcelCiclo(file) {
  I.error = ''; I.a = null; I.resultado = null; I.modo = 'ciclo';
  I.cargando = 'Leyendo el Excel…'; renderImportar();
  try {
    await cargarXlsx();
    const r = itemsDeExcel(await file.arrayBuffer());
    I.items = r.items; I.saltados = r.saltados;
    I.cargando = 'Analizando los movimientos…'; renderImportar();
    I.a = await llamar('analizarCiclo', I.items, '');
    I.a.resumen = { controles: { ok: true } };
    prepararDecisiones();
  } catch (e) { I.error = (e && e.message) || String(e); }
  I.cargando = ''; renderImportar();
}

function htmlInicioCiclo() {
  return '<label class="drop" id="dropx"><input type="file" id="xls" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">' +
    '<b>Elegí el Excel de “Últimos movimientos” del banco</b><span class="mut" style="font-weight:400">o arrastralo hasta acá</span></label>' +
    '<div class="mut" style="font-weight:400;font-size:13px;max-width:680px;line-height:1.5">En el homebanking: tarjeta → Últimos movimientos → descargar en Excel. ' +
    'Estos movimientos son <b style="color:var(--text)">provisorios</b>: te dejan ver en vivo cuánto vas gastando, <b style="color:var(--text)">no cambian tus saldos</b> y se reemplazan solos cuando importás el resumen oficial. ' +
    'Los pagos y créditos del banco no se importan. Podés subir el Excel cuantas veces quieras: solo se agrega lo nuevo y se quita lo que el banco anuló.</div>';
}

function htmlRevisionCiclo() {
  const a = I.a, c = a.ciclo, nuevas = a.filas.filter(f => !f.dup);
  const suma = (l, mon) => l.filter(f => f.moneda === mon).reduce((s, f) => s + f.monto, 0);
  const kpis = [
    ['Compras nuevas', String(nuevas.length), (a.filas.length - nuevas.length) + ' ya estaban cargadas'],
    ['Total nuevo', fmtMoney(suma(nuevas, 'ARS'), 'ARS'), suma(nuevas, 'USD') ? fmtMoney(suma(nuevas, 'USD'), 'USD') + ' en dólares' : 'en pesos'],
    ['Ciclo', c.base ? 'desde el ' + fechaCorta(c.base) : 'sin resumen previo', c.proximoCierre ? 'cierra el ' + fechaCorta(c.proximoCierre) : 'según el último resumen'],
    ['Se ignoran', String(a.pagos.length), 'pagos y créditos del banco'],
  ].map(k => '<div class="card kpi"><span class="l">' + k[0] + '</span><span class="v">' + esc(k[1]) + '</span><span class="s">' + esc(k[2]) + '</span></div>').join('');
  const quitar = a.quitar.length
    ? '<div class="aviso">Ya no figuran en el Excel y se van a quitar (' + a.quitar.length + '): ' + a.quitar.map(x => esc(x.desc) + ' · ' + esc(fmtMoney(x.monto, x.moneda))).join(' · ') + '</div>' : '';
  const saltados = I.saltados ? '<div class="mut" style="font-weight:400;font-size:13px">No pude leer ' + I.saltados + ' renglones del Excel y los salteé.</div>' : '';
  return '<div class="kpis">' + kpis + '</div>' + quitar + htmlOmitidas() + saltados +
    '<div class="toolbar"><button class="pill ' + (I.filtro === 'todos' ? 'on' : '') + '" data-f="todos">Todos <small>' + a.filas.length + '</small></button>' +
    '<button class="pill ' + (I.filtro === 'sin' ? 'on' : '') + '" data-f="sin" id="chip-sin">Sin categorizar</button>' +
    '<button class="pill ' + (I.filtro === 'dup' ? 'on' : '') + '" data-f="dup">Ya cargados <small>' + a.filas.filter(f => f.dup).length + '</small></button>' +
    '<div class="search" style="margin-left:8px"><span class="lupa"></span><input id="iq" placeholder="Buscar…" value="' + esc(I.q) + '"></div></div>' +
    '<div class="card tablewrap" id="imptabla"></div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary" id="impconf">Cargar</button>' +
    '<button class="btn" id="otro">Cancelar</button><a href="#" id="verreglas" class="mut" style="margin-left:auto;color:var(--muted)">Ver reglas</a></div>';
}

function htmlResultadoCiclo() {
  const r = I.resultado;
  return '<div class="card" style="padding:24px"><h2 style="margin:0 0 12px;font-size:20px;letter-spacing:-.02em">Listo, movimientos del mes cargados</h2><div class="kpis">' +
    [['Cargados', r.importados], ['Ya estaban', r.duplicados], ['Quitados', r.quitados], ['Pagos ignorados', r.pagosIgnorados]].map(k =>
      '<div class="card kpi"><span class="l">' + k[0] + '</span><span class="v">' + k[1] + '</span></div>').join('') + '</div>' +
    '<p class="mut" style="font-weight:400;margin:16px 0 0">Quedaron como movimientos <b style="color:var(--text)">provisorios</b> de la tarjeta: ya suman en el Dashboard y en el Cashflow, y no tocan tus saldos. ' +
    'Cuando importes el resumen oficial se reemplazan solos.' + (r.reglasNuevas ? ' Se guardaron ' + r.reglasNuevas + ' reglas nuevas.' : '') + '</p>' +
    '<div style="display:flex;gap:8px;margin-top:20px;flex-wrap:wrap"><button class="btn primary" id="vermes">Ver el Dashboard</button><button class="btn" id="otro">Subir otro Excel</button><button class="btn" id="verreglas">Ver reglas</button></div></div>';
}

/** Lo ya cargado como provisorio de la tarjeta (lo que se está gastando en el ciclo). */
function consumosProvisorios() {
  const lista = (DB.movs || R.movs || []).filter(esProvisorio);
  const libres = lista.filter(m => m.tipo === 'Gasto' && !m.asignado && !m.cuota);
  const total = libres.reduce((t, m) => t + m.monto * (m.moneda === 'USD' ? tcEfectivo() : 1), 0);
  return { lista, libres, total: Math.round(total * 100) / 100, ultima: lista.filter(m => !m.cuota).map(m => m.fecha).sort().pop() || '' };
}

// ---------- Pasar de solapa deslizando el dedo ----------
const ORDEN_SOLAPAS = ['dashboard', 'flujo', 'cargar', 'movs', 'inversiones', 'deudas', 'resumenes', 'maestros'];

(function () {
  let ini = null;
  // zonas donde deslizar ya significa otra cosa: tablas y filtros que se mueven de costado, campos de texto, paneles
  const ZONAS = 'input, select, textarea, .tablewrap, .seg, .tabs, .pills, .toolbar, #modal, #login, .drop, .evol, [contenteditable]';
  const scrollHorizontal = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  const puedeDeslizar = () => {
    const modal = $('modal');
    if (modal && !modal.classList.contains('hide')) return false;
    if (ORDEN_SOLAPAS.indexOf(S.vista) < 0) return false;                                  // importando un resumen o viendo reglas: no
    if (S.vista === 'cargar' && C.v && (C.v.monto || C.v.nota || C.v.montoDest)) return false;   // hay algo escrito sin guardar
    return true;
  };

  document.addEventListener('touchstart', e => {
    ini = null;
    if (e.touches.length !== 1 || !puedeDeslizar()) return;
    const t = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    if (!t || t.closest(ZONAS) || scrollHorizontal(t)) return;
    // iPhone: desde el borde de la pantalla el sistema usa el gesto de "volver atrás"; ahí no se compite con él
    const x0 = e.touches[0].clientX;
    if (x0 < 28 || x0 > window.innerWidth - 28) return;
    ini = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!ini) return;
    const p = ini; ini = null;
    const c = e.changedTouches[0], dx = c.clientX - p.x, dy = c.clientY - p.y;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6 || Date.now() - p.t > 700) return;
    if (String(window.getSelection && window.getSelection()) !== '') return;
    const i = ORDEN_SOLAPAS.indexOf(S.vista), j = i + (dx < 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= ORDEN_SOLAPAS.length || !puedeDeslizar()) return;
    irVista(ORDEN_SOLAPAS[j]);
    const pg = $('page');
    pg.classList.remove('desliza-izq', 'desliza-der');
    void pg.offsetWidth;
    pg.classList.add(dx < 0 ? 'desliza-izq' : 'desliza-der');
    window.scrollTo(0, 0);
  }, { passive: true });
})();

// ---------- Presupuesto de meses anteriores ----------
const PM = { mes: '' };

/** El presupuesto con el que se mide un mes: el corregido a mano, si existe; si no, el del historial; si no, el actual. */
function presupuestoDeMes(ym) {
  const ov = (DB.presMes || {})[ym];
  if (ov) return ov;
  const h = (DB.presHist || []).filter(x => x.hasta >= ym)[0];   // el historial viene ordenado: vale el primer registro que llega hasta ese mes
  if (h) return h.valores;
  const o = {};
  S.data.presupuesto.filas.forEach(f => { o[f.v.Subcategoria] = Number(f.v.Presupuesto) || 0; });
  return o;
}

function presMesHtml() {
  if (DB.presHist === undefined || DB.presMes === undefined) {   // todavía no llegaron los datos: se piden y se vuelve a dibujar
    traerTodo().then(r => { aplicarTodo(r); if (S.vista === 'maestros' && S.id === 'presupuesto') renderPage(); }).catch(() => { /* sin historial: queda el presupuesto actual */ });
    return '';
  }
  const meses = [];
  let ym = mesAnterior((DB.hoy || hoyLocal()).slice(0, 7));
  for (let i = 0; i < 12; i++) { meses.push(ym); ym = mesAnterior(ym); }
  const corregido = !!(DB.presMes || {})[PM.mes];
  let cuerpo = '';
  if (PM.mes) {
    const vig = presupuestoDeMes(PM.mes);
    const subs = Array.from(new Set(S.data.presupuesto.filas.map(f => f.v.Subcategoria).concat(Object.keys(vig))));
    cuerpo = '<div style="margin-top:12px">' + subs.map(sub => '<label class="dfila" style="cursor:default"><span class="n">' + esc(sub) + '</span><input class="in" style="width:140px;margin:0;text-align:right" inputmode="decimal" autocomplete="off" data-pm="' + esc(sub) + '" value="' + esc(String(vig[sub] || 0).replace('.', ',')) + '"></label>').join('') + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="btn primary" id="pmguardar">Guardar ' + esc(nombreMes(PM.mes)) + '</button>' +
      (corregido ? '<button class="btn" id="pmvolver">Volver al original</button>' : '') + '</div>' +
      (corregido ? '<div class="mut small" style="margin-top:8px">Este mes está corregido a mano.</div>' : '');
  }
  return '<div class="card cuerpo-c" style="max-width:640px"><h2 class="titulo-c">Presupuesto de un mes anterior</h2>' +
    '<select class="in" id="pmmes" style="margin:0"><option value="">Elegí un mes</option>' + meses.map(m => op(m, PM.mes, nombreMes(m) + ((DB.presMes || {})[m] ? ' · corregido' : ''))).join('') + '</select>' + cuerpo + '</div>';
}

function enlazarPresMes() {
  if ($('pmmes')) $('pmmes').onchange = e => { PM.mes = e.target.value; renderPage(); };
  const cambiado = async (accion) => {
    try {
      await accion();
      aplicarTodo(await traerTodo(true));
      renderPage();
    } catch (e) { toast((e && e.message) || 'No se pudo guardar'); }
  };
  if ($('pmguardar')) $('pmguardar').onclick = () => {
    const vig = presupuestoDeMes(PM.mes), valores = {};
    document.querySelectorAll('[data-pm]').forEach(i => {
      const n = numAR(i.value);
      if (!isFinite(n) || n !== (vig[i.dataset.pm] || 0)) valores[i.dataset.pm] = isFinite(n) ? n : i.value;   // se envía solo lo que cambió (o lo que no se entiende, para que avise)
    });
    if (!Object.keys(valores).length) { toast('No cambiaste nada'); return; }
    cambiado(async () => { await llamar('guardarPresupuestoMes', PM.mes, valores); toast('Presupuesto de ' + nombreMes(PM.mes) + ' guardado'); });
  };
  if ($('pmvolver')) $('pmvolver').onclick = () => cambiado(async () => { await llamar('borrarPresupuestoMes', PM.mes); toast('Volvió al presupuesto original'); });
}

// ---------- Chequeo de saldos contra el banco ----------
const CHK = { abierto: false };

function chequeoHtml(lista) {
  const filas = lista.filter(c => c.estado !== 'Inactivo' || c.mov);
  return '<div class="mut small" style="margin-bottom:8px">Escribí lo que dice cada banco. Donde no coincida, se crea un ajuste por la diferencia.</div>' +
    filas.map(c => '<div class="chkfila" data-cuenta="' + esc(c.nombre) + '" data-calc="' + c.saldo + '" data-mon="' + esc(c.moneda) + '"><span class="n">' + esc(c.nombre) +
      '</span><span class="mono mut calc" title="Lo que calcula el sistema">' + esc((c.saldo < 0 ? '− ' : '') + fmtMoneyRaw(Math.abs(c.saldo), c.moneda)) + '</span>' +
      '<input class="in chkin" inputmode="decimal" autocomplete="off" placeholder="Según el banco"><span class="mono dif">—</span></div>').join('') +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn primary" id="chkok" disabled>Crear ajustes</button><button class="btn" id="chkno">Cancelar</button></div>';
}

function enlazarChk() {
  if ($('chkabrir')) $('chkabrir').onclick = () => { CHK.abierto = true; renderDashboard(); };
  if (!$('chkok')) return;
  $('chkno').onclick = () => { CHK.abierto = false; renderDashboard(); };
  const filas = Array.from(document.querySelectorAll('.chkfila'));
  const leer = () => filas.map(f => {
    const v = f.querySelector('.chkin').value, n = numAR(v);
    if (String(v).trim() === '' || !isFinite(n)) return null;
    return { cuenta: f.dataset.cuenta, mon: f.dataset.mon, dif: Math.round((n - Number(f.dataset.calc)) * 100) / 100 };
  });
  const actualizar = () => {
    let cuantos = 0;
    leer().forEach((p, i) => {
      const cel = filas[i].querySelector('.dif');
      if (!p) { cel.textContent = '—'; cel.className = 'mono dif'; return; }
      if (Math.abs(p.dif) < 0.005) { cel.textContent = '✓ coincide'; cel.className = 'mono dif ok'; return; }
      cel.textContent = (p.dif > 0 ? '+ ' : '− ') + fmtMoneyRaw(Math.abs(p.dif), p.mon);
      cel.className = 'mono dif ' + (p.dif < 0 ? 'neg' : '');
      cuantos++;
    });
    $('chkok').disabled = !cuantos;
    $('chkok').textContent = cuantos ? 'Crear ' + cuantos + (cuantos === 1 ? ' ajuste' : ' ajustes') : 'Crear ajustes';
  };
  filas.forEach(f => { f.querySelector('.chkin').oninput = actualizar; });
  $('chkok').onclick = async () => {
    const items = leer().filter(p => p && Math.abs(p.dif) >= 0.005).map(p => ({ cuenta: p.cuenta, monto: p.dif }));
    if (!items.length) return;
    $('chkok').disabled = true;
    try {
      await llamar('ajustarSaldos', items);
      CHK.abierto = false;
      aplicarTodo(await traerTodo(true));
      renderDashboard();
      toast(items.length + (items.length === 1 ? ' ajuste creado' : ' ajustes creados'));
    } catch (e) { toast((e && e.message) || 'No se pudieron crear los ajustes'); $('chkok').disabled = false; }
  };
}

// ---------- inicio ----------
traerTodo().catch(() => { /* si falla, cada solapa lo vuelve a pedir */ });
cargarTC();
llamar('iniciar').then(r => {
  S.schemas = r.schemas; S.data = r.data; S.rev = r.revisiones; S.avisos = r.avisos;
  S.schemas.forEach(s => { S.byId[s.id] = s; });
  const guardado = store.get('maestro');
  S.id = S.byId[guardado] && guardado !== 'reglas' ? guardado : S.schemas[0].id;
  S.vista = ['dashboard', 'flujo', 'resumenes', 'movs', 'deudas', 'inversiones', 'cargar', 'maestros'].indexOf(store.get('vista')) >= 0 ? store.get('vista') : 'dashboard';
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

function actualizarCabecera() {
  const tc = tcActual(), v = $('tcval');
  if (v) v.textContent = tc ? 'TC: ' + fmtNum(tc) : 'TC: —';
  document.querySelectorAll('#vmon button').forEach(b => b.classList.toggle('on', b.dataset.m === VISTA_MON));
  aplicarOjo();
  pintarBotonTema();
}
document.querySelectorAll('#vmon button').forEach(b => b.onclick = () => {
  if (!tcActual()) { toast('Todavía no tengo el tipo de cambio'); return; }
  VISTA_MON = VISTA_MON === b.dataset.m ? '' : b.dataset.m;   // tocar de nuevo el elegido vuelve a cada moneda original
  try { localStorage.setItem('vista_mon', VISTA_MON); } catch (e) { /* sin almacenamiento */ }
  actualizarCabecera();
  if (typeof hayEdicionAbierta === 'function' && !hayEdicionAbierta()) render();
});
// el logo de arriba a la izquierda lleva al Dashboard (como en cualquier app)
(function () {
  const marca = document.querySelector('.brand');
  if (!marca) return;
  const ir = () => { try { if (S.schemas.length) irVista('dashboard'); } catch (e) { /* todavía no hay sesión: no hay a dónde ir */ } };
  marca.setAttribute('role', 'link');
  marca.setAttribute('tabindex', '0');
  marca.setAttribute('aria-label', 'Ir al Dashboard');
  marca.title = 'Ir al Dashboard';
  marca.onclick = ir;
  marca.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ir(); } };
})();
if ($('tema')) $('tema').onclick = cambiarTema;
if ($('ojo')) $('ojo').onclick = () => {
  OCULTAR = !OCULTAR;
  try { localStorage.setItem('ocultar_saldos', OCULTAR ? '1' : '0'); } catch (e) { /* sin almacenamiento */ }
  aplicarOjo();
  if (typeof hayEdicionAbierta === 'function' && !hayEdicionAbierta()) render();
  toast(OCULTAR ? 'Saldos ocultos' : 'Saldos visibles');
};
actualizarCabecera();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* sin instalación: no pasa nada */ });
