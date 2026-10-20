// Aplica el modo (claro u oscuro) antes de que se dibuje la pantalla, para que no parpadee. Por defecto: oscuro.
(function () {
  var t = 'oscuro';
  try { t = localStorage.getItem('tema') === 'claro' ? 'claro' : 'oscuro'; } catch (e) { /* sin almacenamiento: oscuro */ }
  document.documentElement.setAttribute('data-tema', t);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'claro' ? '#FFFFFF' : '#0F0E0E');
})();
