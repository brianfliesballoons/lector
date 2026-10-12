// Lector service worker: the page and the shelf list are network-first (so updates land);
// dictionary shards, book files, the free-book catalogue, fonts and the zip library are
// cache-first (so reading works offline).
const CACHE = 'lector-v2';
const isFont = url => /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
// Immutable files: safe to carry from an older cache into a new one.
const keepable = url => isFont(url) || /jszip/.test(url.pathname) || /\.epub$/.test(url.pathname) ||
  (/\/dict\//.test(url.pathname) && !url.pathname.endsWith('_index.json'));
const sticky = url => keepable(url) || url.pathname.endsWith('/books/catalog-es.json');

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  // Move the saved dictionary, books and fonts across so a version bump never makes
  // someone download the dictionary again; then drop the old caches.
  const fresh = await caches.open(CACHE);
  for (const name of await caches.keys()){
    if (name === CACHE || !name.startsWith('lector-')) continue;
    const old = await caches.open(name);
    for (const req of await old.keys()){
      if (!keepable(new URL(req.url))) continue;
      if (await fresh.match(req)) continue;
      const res = await old.match(req); if (res) await fresh.put(req, res);
    }
    await caches.delete(name);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const font = isFont(url);
  if (url.origin !== location.origin && !font) return;   // the book relay and anything else: straight to the network
  e.respondWith(caches.open(CACHE).then(async c => {
    if (sticky(url)){
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || (font && r.type === 'opaque')) c.put(e.request, r.clone());
      return r;
    }
    try {
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      const hit = await c.match(e.request);
      if (hit) return hit;
      throw err;
    }
  }));
});
