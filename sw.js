// Lector service worker: the page itself is network-first (so updates land),
// dictionary shards, books, fonts and the zip library are cache-first (so reading works offline).
const CACHE = 'lector-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const font = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  const sticky = font || (/\/dict\/|\/books\/|jszip/.test(url.pathname) && !url.pathname.endsWith('_index.json'));
  e.respondWith(caches.open(CACHE).then(async c => {
    if (sticky){
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || (font && r.type === 'opaque')) c.put(e.request, r.clone());
      return r;
    }
    try {
      const r = await fetch(e.request);
      if (r.ok && url.origin === location.origin) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      const hit = await c.match(e.request);
      if (hit) return hit;
      throw err;
    }
  }));
});
