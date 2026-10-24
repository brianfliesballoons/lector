// Lector service worker: the page and the shelf list are network-first (so updates land);
// dictionary shards, verb-table shards (conj/), book files, the free-book catalogues, fonts and the zip
// library are cache-first (so reading, reviews and the verb charts work offline). Only the small app shell is precached: a language's dictionary
// (dict/ for Spanish, dict/fr/ for French, dict/en/ for English: all cache-first by the /dict/ rule) is fetched only once a word in it is looked up,
// or when that language's dictionary is saved for offline.
const CACHE = 'lector-v7';
const isFont = url => /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
// Immutable files: safe to carry from an older cache into a new one. The vendored libraries
// carry their version in the name (ts-fsrs-5.4.2.js), so an upgrade is a new file, never a stale one.
// conj/ shards are kept like dictionary shards; its index, key and top-300 list (with their tables)
// stay network-first so a rebuild reaches the phone, and fall back to the cached copy offline.
const keepable = url => isFont(url) || /jszip|ts-fsrs-/.test(url.pathname) || /\.epub$/.test(url.pathname) ||
  (/\/dict\//.test(url.pathname) && !url.pathname.endsWith('_index.json')) ||
  (/\/conj\/[a-z_]{2}\.json$/.test(url.pathname));
// A Reference card's PDF (refs/pdf/) is kept once opened, so Print works again with no signal; a new version
// of the app fetches them afresh (they are rebuilt whenever a card changes).
const isPdf = url => /\/refs\/pdf\/[a-z0-9-]+\.pdf$/.test(url.pathname);
const sticky = url => keepable(url) || isPdf(url) || /\/books\/catalog-[a-z]{2}\.json$/.test(url.pathname);

// The app shell is saved at install so the installed app (Android's "Install app", iPhone's
// Add to Home Screen) opens with no signal. Dictionaries and books are never precached. The Reference shelf
// (refs/cards.json), the 300 top verbs it draws on (conj/top.json) and the English verb chart (conj-en/verbs.json) are, so the reference works offline.
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'jszip.min.js', 'ts-fsrs-5.4.2.js', 'refs/cards.json', 'conj/top.json', 'conj-en/verbs.json'];
// A card's PDF never opened before cannot open offline: say so, and point back to Print in the app.
const pdfOffline = () => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lector</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:32em;margin:12vh auto;padding:0 20px;color:#1f1c17;background:#faf7f2}</style></head>
<body><p>This card’s printable copy needs a connection the first time. Go back to the card and use Print there: it prints the page itself.</p>
<p lang="es">Esta tarjeta necesita conexión la primera vez. Regresa a la tarjeta y toca Imprimir: se imprime la página misma.</p></body></html>`, {headers: {'Content-Type': 'text/html; charset=utf-8'}});
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())));
// An invite link (?join=<token>) is a secret: it is never stored. A page is cached under its address without the
// query, so /?join=… and /?suite=… are both kept as the one page; the token never lands in Cache Storage.
const pageKey = (req, url) => req.mode === 'navigate' || url.search ? url.origin + url.pathname : req;
const hasJoin = u => /[?&]join=/.test(u);
self.addEventListener('activate', e => e.waitUntil((async () => {
  // Move the saved dictionary, books and fonts across so a version bump never makes
  // someone download the dictionary again; then drop the old caches.
  const fresh = await caches.open(CACHE);
  for (const req of await fresh.keys()) if (hasJoin(req.url)) await fresh.delete(req);   // anything an older version kept
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
      let r;
      try { r = await fetch(e.request) } catch (err) { if (isPdf(url)) return pdfOffline(); throw err }
      if (r.ok || (font && r.type === 'opaque')) c.put(e.request, r.clone());
      return r;
    }
    const key = pageKey(e.request, url);
    try {
      const r = await fetch(e.request);
      if (r.ok) c.put(key, r.clone());
      return r;
    } catch (err) {
      const hit = await c.match(key) || await c.match(e.request, {ignoreSearch: true});
      if (hit) return hit;
      throw err;
    }
  }));
});
