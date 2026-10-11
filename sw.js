// Service worker mínimo: permite instalar OPUS como app. No guarda nada en caché (los datos siempre vienen frescos).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
