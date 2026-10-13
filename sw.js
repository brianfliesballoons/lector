// Lector service worker: the page and the shelf list are network-first (so updates land);
// dictionary shards, book files, the free-book catalogues, fonts and the zip library are
// cache-first (so reading works offline). Only the small app shell is precached: a language's dictionary
// (dict/ for Spanish, dict/fr/ for French) is fetched only once a word in it is looked up,
// or when that language's dictionary is saved for offline.
const CACHE = 'lector-v3';
const isFont = url => /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
// Immutable files: safe to carry from an older cache into a new one.
const keepable = url => isFont(url) || /jszip/.test(url.pathname) || /\.epub$/.test(url.pathname) ||
  (/\/dict\//.test(url.pathname) && !url.pathname.endsWith('_index.json'));
const sticky = url => keepable(url) || /\/books\/catalog-[a-z]{2}\.json$/.test(url.pathname);

// The app shell is saved at install so the installed app (Android's "Install app", iPhone's
// Add to Home Screen) opens with no signal. Dictionaries and books are never precached.
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'jszip.min.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())));
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
