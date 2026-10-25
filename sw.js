// Lector service worker: the page and the shelf list are network-first (so updates land);
// dictionary shards, verb-table shards (conj/), book files, the free-book catalogues, fonts and the zip
// library are cache-first (so reading, reviews and the verb charts work offline). Only the small app shell is precached: a language's dictionary
// (dict/ for Spanish, dict/fr/ for French, dict/en/ for English: all cache-first by the /dict/ rule) is fetched only once a word in it is looked up,
// or when that language's dictionary is saved for offline.
const CACHE = 'lector-v11';
const isFont = url => /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
// Immutable files: safe to carry from an older cache into a new one. The vendored libraries
// carry their version in the name (ts-fsrs-5.4.2.js), so an upgrade is a new file, never a stale one.
// conj/ shards and the real-sentence shards (sent/es, sent/en) are kept like dictionary shards; its index, key and top-300 list (with their tables)
// stay network-first so a rebuild reaches the phone, and fall back to the cached copy offline.
const keepable = url => isFont(url) || /jszip|ts-fsrs-/.test(url.pathname) || /\.epub$/.test(url.pathname) ||
  (/\/dict\//.test(url.pathname) && !url.pathname.endsWith('_index.json')) ||
  (/\/conj\/[a-z_]{2}\.json$/.test(url.pathname)) || (/\/sent\/(es|en)\/[a-z_]{2}\.json$/.test(url.pathname));
// A Reference card's PDF (refs/pdf/) is kept once opened, so Print works again with no signal; a new version
// of the app fetches them afresh (they are rebuilt whenever a card changes).
const isPdf = url => /\/refs\/pdf\/[a-z0-9-]+\.pdf$/.test(url.pathname);
const sticky = url => keepable(url) || isPdf(url) || /\/books\/catalog-[a-z]{2}\.json$/.test(url.pathname);

// The app shell is saved at install so the installed app (Android's "Install app", iPhone's
// Add to Home Screen) opens with no signal. Dictionaries and books are never precached. The Reference shelf
// (refs/cards.json), the 300 top verbs it draws on (conj/top.json), the English verb chart (conj-en/verbs.json) and the two
// real-sentence indexes (sent/*/_index.json) are, so the reference and verb practice work offline; the app saves every
// sentence shard once on Wi-Fi (prefetchSents), and those are cache-first.
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png', 'jszip.min.js', 'ts-fsrs-5.4.2.js', 'refs/cards.json', 'conj/top.json', 'conj-en/verbs.json', 'sent/es/_index.json', 'sent/en/_index.json'];
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

// ---------- notifications: a push from lector-chat when the other person writes ----------
// The payload arrives encrypted for this browser alone (RFC 8291) and holds: kind 'msg' or 'test', from (the
// sender's name), text (the start of the message, only if that person allows previews), tr (a translation, if one
// already existed), thread, k (how many messages this push stands for), lang (this phone's app language).
const NW = {
  en: {newMsg: 'New message', many: n => `${n} new messages`, testB: 'Notifications are on. New messages will show up like this.'},
  es: {newMsg: 'Mensaje nuevo', many: n => `${n} mensajes nuevos`, testB: 'Las notificaciones están activadas. Los mensajes nuevos se verán así.'}
};
const scoped = p => new URL(p, self.registration.scope).href;
// Safari (iPhone and Mac) ends a subscription whose pushes show nothing, so there a notification is always shown,
// and closed straight away when the app is already showing that conversation.
const SAFARI = /AppleWebKit/.test(self.navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(self.navigator.userAgent);
// Asks an open Lector window whether it is on screen showing this conversation (it answers within a moment, or not at all).
const ask = (c, msg) => new Promise(res => {
  const ch = new MessageChannel(), t = setTimeout(() => res(null), 500);
  ch.port1.onmessage = ev => { clearTimeout(t); res(ev.data || null) };
  try { c.postMessage(msg, [ch.port2]) } catch (err) { clearTimeout(t); res(null) }
});
self.addEventListener('push', e => e.waitUntil(onPush(e)));
async function onPush(e){
  let d = {}; try { d = e.data ? e.data.json() : {} } catch (err) { d = {} }
  const W = NW[d.lang] || NW.en, base = {icon: scoped('icons/icon-192.png'), badge: scoped('icons/badge-96.png')};
  if (d.kind === 'test') return self.registration.showNotification('Lector', {...base, body: W.testB, tag: 'lector-test', data: {url: scoped('./#settings')}});
  if (d.kind !== 'msg' || !d.thread) return self.registration.showNotification('Lector', {...base, body: W.newMsg, tag: 'lector', data: {url: scoped('./#messages')}});
  // every open window fetches the new message now (no waiting for its next poll); one that is showing this
  // conversation on screen says so, and then no notification is needed
  const wins = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  const answers = await Promise.all(wins.map(c => ask(c, {type: 'lector-push', thread: d.thread, id: d.id})));
  const seen = answers.some(a => a && a.showing);
  if (seen && !SAFARI) return;
  // messages that arrive while a notification for this conversation is still up are counted into it
  const prev = await self.registration.getNotifications({tag: d.thread});
  const n = prev.reduce((x, p) => x + ((p.data && p.data.n) || 1), 0) + Math.max(1, d.k | 0);
  const lines = [];
  if (n > 1) lines.push(W.many(n));
  if (d.text) lines.push(d.text);
  if (d.text && d.tr) lines.push(d.tr);
  if (!d.text && n === 1) lines.push(W.newMsg);
  await self.registration.showNotification(d.from || 'Lector', {...base, body: lines.join('\n'), tag: d.thread, renotify: true,
    timestamp: Date.now(), data: {url: scoped('./#messages'), thread: d.thread, n}});
  if (seen) for (const x of await self.registration.getNotifications({tag: d.thread})) x.close();
}
// A tap on a notification: bring Lector forward on Messages (or Settings, for the test), or open it there.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || scoped('./#messages');
  const tab = /#settings$/.test(url) ? 'settings' : 'messages';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const w = wins.find(c => c.url.startsWith(self.registration.scope));
    if (w){ try { await w.focus() } catch (err) {} w.postMessage({type: 'lector-open', tab}); return }
    await self.clients.openWindow(url);
  })());
});
// The push service replaced this browser's subscription: make a new one with the same key and tell lector-chat,
// which moves the old row (and who it belongs to) to the new address. The app keeps the API address in Cache
// Storage under push-config (this worker cannot read localStorage); without it, the app re-subscribes when next opened.
self.addEventListener('pushsubscriptionchange', e => e.waitUntil((async () => {
  const old = e.oldSubscription, key = old && old.options && old.options.applicationServerKey;
  let sub = e.newSubscription;
  if (!sub && key) sub = await self.registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
  const cfg = await (await caches.open('push-config')).match(scoped('push-config.json'));
  if (!sub || !old || !cfg) return;
  const {api} = await cfg.json();
  await fetch(api + '/push/resubscribe', {method: 'POST', headers: {'Content-Type': 'application/json'},
    // the old auth secret proves this is the same browser: it is shared only by this browser and lector-chat, never the push service
    body: JSON.stringify({old: {endpoint: old.endpoint, auth: (old.toJSON().keys || {}).auth}, subscription: sub.toJSON()})}).catch(() => {});
})()));
