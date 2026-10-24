// Web push for new messages: the subscription endpoints, the throttle, and the send that runs after a message is stored.
// Nothing here calls Workers AI: a push carries only what is already in D1 (the text as written, and a translation
// only if one already exists when the push goes out). Sends run in ctx.waitUntil, so a send never waits on them.
import { sendPush, validP256, b64u } from './webpush.js';

export const WINDOW = 20000;     // at most one push per person per conversation per 20 s
export const STALE = 60000;      // a held flush whose Worker died is taken over after this
export const MAX_SUBS = 5;       // browsers per person; a sixth replaces the one heard from least recently
export const MAX_FAILS = 5;      // failures in a row before a subscription is dropped
const TEXT_MAX = 120, BYTES_MAX = 900;
const OK = new Set([200, 201, 202, 204]);
const LANGS = ['en', 'es'];

export function vapidOf(env) {
  const publicKey = String(env.VAPID_PUBLIC || '').trim(), privateKey = String(env.VAPID_PRIVATE || '').trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: String(env.VAPID_SUBJECT || 'mailto:brianfliesballoons@gmail.com') };
}

// The start of a message, cut on a whole character (an emoji or an accented letter is never split), with an ellipsis.
let seg = null;
try { seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { seg = null; }
export function snippet(text, max = TEXT_MAX, maxBytes = BYTES_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  let g = seg ? [...seg.segment(s)].map(x => x.segment) : Array.from(s);
  let cut = g.length > max;
  if (cut) g = g.slice(0, max);
  const enc = new TextEncoder();
  while (g.length && enc.encode(g.join('')).length > maxBytes) { g.pop(); cut = true; }
  let out = g.join('');
  if (cut) out = out.replace(/[\s.,;:!?¡¿-]+$/u, '') + '…';
  return out;
}

// ---------- the throttle (optimistic: read, then a guarded write; a lost race reads again) ----------
// take(): a new message for this person in this conversation. Either it goes now ({send:true, k}: k = how many
// messages this push stands for, counting any held ones a dead flush left behind), or it is held
// ({send:false, flushAt}: flushAt is set only for the ONE call that must send the held ones when the window ends).
export async function take(db, uid, tid, msgId, now = Date.now()) {
  await db.prepare('INSERT OR IGNORE INTO push_state(user_id, thread_id, last_sent, held) VALUES(?, ?, 0, 0)').bind(uid, tid).run();
  for (let i = 0; i < 6; i++) {
    const r = await db.prepare('SELECT last_sent, held, flush_at FROM push_state WHERE user_id = ? AND thread_id = ?').bind(uid, tid).first();
    const guard = 'WHERE user_id = ? AND thread_id = ? AND last_sent = ? AND held = ? AND flush_at IS ?';
    const g = [uid, tid, r.last_sent, r.held, r.flush_at];
    const free = now - r.last_sent >= WINDOW && (r.flush_at == null || r.flush_at < now - STALE);
    if (free) {
      const u = await db.prepare(`UPDATE push_state SET last_sent = ?, held = 0, flush_at = NULL, last_msg = ? ${guard}`).bind(now, msgId, ...g).run();
      if (u.meta.changes === 1) return { send: true, k: 1 + (r.flush_at != null ? r.held : 0) };
    } else {
      const at = r.flush_at != null ? r.flush_at : r.last_sent + WINDOW;
      const u = await db.prepare(`UPDATE push_state SET held = held + 1, last_msg = ?, flush_at = ? ${guard}`).bind(msgId, at, ...g).run();
      if (u.meta.changes === 1) return { send: false, flushAt: r.flush_at == null ? at : null };
    }
  }
  return { send: false, flushAt: null };   // six lost races in a row: someone else is sending for this window
}
// flush(): the window ended; send what was held, once. Returns {k, msgId} for the one caller that wins, else null.
export async function flush(db, uid, tid, at, now = Date.now()) {
  const r = await db.prepare('SELECT held, flush_at, last_msg FROM push_state WHERE user_id = ? AND thread_id = ?').bind(uid, tid).first();
  if (!r || r.flush_at !== at || !r.held) return null;
  const u = await db.prepare('UPDATE push_state SET held = 0, flush_at = NULL, last_sent = ? WHERE user_id = ? AND thread_id = ? AND flush_at = ? AND held = ?')
    .bind(now, uid, tid, at, r.held).run();
  return u.meta.changes === 1 ? { k: r.held, msgId: r.last_msg } : null;
}

// ---------- the payload one browser gets (encrypted for it alone) ----------
// The service worker builds the notification from this: title = from, body = text (or "New message" / "Mensaje
// nuevo" in lang when the preview is off), "3 new messages" when k plus what is already showing is more than one.
export function payloadFor(m, { senderName, recipient, preview, lang, k }) {
  const p = { v: 1, kind: 'msg', thread: m.thread_id, id: m.id, from: senderName, lang: LANGS.includes(lang) ? lang : 'en', k: Math.max(1, k | 0), url: './#messages' };
  if (preview && !m.deleted && m.text) {
    p.text = snippet(m.text);
    // a translation is added only if one is already stored, in the reader's own language, and says something different
    let v = null; try { v = m.versions ? JSON.parse(m.versions) : null; } catch { v = null; }
    const mine = recipient && recipient.native;
    if (v && mine && m.lang !== mine && v[mine] && v[mine].trim() !== m.text.trim()) { p.tr = snippet(v[mine]); p.trLang = mine; }
  }
  return p;
}

// ---------- sending, with clean-up ----------
// Sends to every live subscription of one person. A subscription whose sign-in was revoked or ran out is deleted
// first (a phone signed out from another device must not keep getting message text). 404/410 = gone: deleted.
// Anything else counts a failure; the 5th in a row deletes it.
export async function deliver(env, uid, make, { fetchFn, topic, now = Date.now(), only } = {}) {
  const vapid = vapidOf(env);
  if (!vapid) return { sent: 0, ok: 0, removed: 0 };
  const rows = (await env.DB.prepare(`SELECT s.*, c.user_id c_user, c.kind c_kind, c.revoked c_revoked, c.expires c_expires
    FROM push_subs s LEFT JOIN credentials c ON c.id = s.cred_id WHERE s.user_id = ?${only ? ' AND s.endpoint = ?' : ''}`).bind(...(only ? [uid, only] : [uid])).all()).results;
  let sent = 0, ok = 0, removed = 0;
  for (const s of rows) {
    const live = s.c_user === uid && !s.c_revoked && (s.c_kind === 'session' || s.c_kind === 'invite') && (s.c_expires == null || s.c_expires > now);
    if (!live) { await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(s.id).run(); removed++; continue; }
    sent++;
    const status = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, make(s), vapid, { topic, fetchFn: fetchFn || fetch });
    if (OK.has(status)) { ok++; await env.DB.prepare('UPDATE push_subs SET last_ok = ?, fail_count = 0 WHERE id = ?').bind(now, s.id).run(); }
    else if (status === 404 || status === 410) { await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(s.id).run(); removed++; }
    else {
      const r = await env.DB.prepare('UPDATE push_subs SET fail_count = fail_count + 1 WHERE id = ? RETURNING fail_count').bind(s.id).first();
      if (r && r.fail_count >= MAX_FAILS) { await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(s.id).run(); removed++; }
      console.log('push failed', JSON.stringify({ status, sub: s.id }));   // never the text, never the endpoint
    }
  }
  return { sent, ok, removed };
}

async function prefsOf(db, uid) {
  const r = await db.prepare('SELECT notify, preview FROM push_prefs WHERE user_id = ?').bind(uid).first();
  return { notify: r ? !!r.notify : true, preview: r ? !!r.preview : true };
}

// After a message is stored (and its translation tried): tell everyone else in the conversation.
// opts.sleep / opts.fetchFn / opts.now are for tests. Never throws.
export async function notifyNew(env, m, opts = {}) {
  try {
    if (!vapidOf(env)) return;
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const clock = opts.now || (() => Date.now());
    const people = (await env.DB.prepare('SELECT u.id, u.name, u.native FROM members mb JOIN users u ON u.id = mb.user_id WHERE mb.thread_id = ?').bind(m.thread_id).all()).results;
    const sender = people.find(p => p.id === m.user_id);
    const senderName = (sender && sender.name) || 'Lector';
    const later = [];
    for (const r of people) {
      if (r.id === m.user_id) continue;
      const pf = await prefsOf(env.DB, r.id);
      if (!pf.notify) continue;
      if (!(await env.DB.prepare('SELECT 1 FROM push_subs WHERE user_id = ? LIMIT 1').bind(r.id).first())) continue;
      const t = await take(env.DB, r.id, m.thread_id, m.id, clock());
      if (t.send) await deliver(env, r.id, s => payloadFor(m, { senderName, recipient: r, preview: pf.preview, lang: s.lang, k: t.k }), { fetchFn: opts.fetchFn, topic: m.thread_id, now: clock() });
      else if (t.flushAt) later.push({ r, at: t.flushAt });
    }
    if (!later.length) return;
    await sleep(Math.max(0, Math.max(...later.map(x => x.at)) - clock()));
    for (const { r, at } of later) {
      const f = await flush(env.DB, r.id, m.thread_id, at, clock());
      if (!f) continue;
      const last = (await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(f.msgId).first()) || { ...m, deleted: 1 };
      const pf = await prefsOf(env.DB, r.id);
      if (!pf.notify) continue;
      await deliver(env, r.id, s => payloadFor(last, { senderName, recipient: r, preview: pf.preview, lang: s.lang, k: f.k }), { fetchFn: opts.fetchFn, topic: m.thread_id, now: clock() });
    }
  } catch (e) {
    console.log('push error', String(e && e.message || e).slice(0, 200));
  }
}

// ---------- validation ----------
// A subscription as PushSubscription.toJSON() gives it. Push services are https only; a Worker running locally
// (wrangler dev, hostname localhost) also takes http://localhost, so the test suite can run a mock push service.
export async function checkSubscription(sub, localWorker) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return 'subscription must be an object.';
  const ep = sub.endpoint, keys = sub.keys;
  if (typeof ep !== 'string' || ep.length < 12 || ep.length > 1000) return 'subscription.endpoint must be a URL.';
  let u; try { u = new URL(ep); } catch { return 'subscription.endpoint must be a URL.'; }
  const localOk = localWorker && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !localOk) return 'subscription.endpoint must be https.';
  if (u.username || u.password) return 'subscription.endpoint must not carry a user name.';
  if (!localOk && (u.hostname === 'localhost' || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || u.hostname.startsWith('['))) return 'subscription.endpoint must be a push service.';
  if (!keys || typeof keys !== 'object' || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return 'subscription.keys must have p256dh and auth.';
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.auth)) return 'subscription.keys must be base64url.';
  let p, a; try { p = b64u.dec(keys.p256dh); a = b64u.dec(keys.auth); } catch { return 'subscription.keys must be base64url.'; }
  if (p.length !== 65 || p[0] !== 4 || !(await validP256(p))) return 'subscription.keys.p256dh must be a P-256 public key.';
  if (a.length !== 16) return 'subscription.keys.auth must be 16 bytes.';
  return null;
}

// ---------- routes: /push/* (GET /push/key needs no sign-in; the rest need a person) ----------
export async function pushKey(env, h) {
  const v = vapidOf(env);
  return h.json({ configured: !!v, key: v ? v.publicKey : null });
}
// POST /push/resubscribe {old:{endpoint, auth}, subscription}: from the service worker when the push service replaced
// this browser's subscription (pushsubscriptionchange). No sign-in (a service worker cannot read the app's token):
// the old subscription's auth secret is the proof, since only this browser and lector-chat ever had it (the push
// service never sees it). The row keeps its person, sign-in and language; only the address and keys change.
export async function pushResubscribe(req, env, h) {
  if (!vapidOf(env)) return h.err(503, 'Notifications are not set up on the server yet.', { notConfigured: true });
  const b = await h.body(req), old = b.old && typeof b.old === 'object' ? b.old : {};
  if (typeof old.endpoint !== 'string' || typeof old.auth !== 'string' || !old.endpoint || !old.auth) return h.err(400, 'old.endpoint and old.auth are required.');
  const local = ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);
  const why = await checkSubscription(b.subscription, local);
  if (why) return h.err(400, why);
  const row = await env.DB.prepare('SELECT id, user_id, auth FROM push_subs WHERE endpoint = ?').bind(old.endpoint).first();
  if (!row || !(await sameSecret(row.auth, old.auth.replace(/=+$/, '')))) return h.err(404, 'No such subscription.');
  if (!(await h.use(env, row.user_id, 'pushsub'))) return h.err(429, 'That is a lot of notification changes for one day. Please try again tomorrow.');
  const s = b.subscription;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND id != ?').bind(s.endpoint, row.id),
    env.DB.prepare('UPDATE push_subs SET endpoint = ?, p256dh = ?, auth = ?, fail_count = 0 WHERE id = ?').bind(s.endpoint, s.keys.p256dh.replace(/=+$/, ''), s.keys.auth.replace(/=+$/, ''), row.id),
  ]);
  return h.json({ ok: true });
}
async function sameSecret(a, b) {   // compare digests, not the raw strings
  const d = async s => b64u.enc(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)))));
  return (await d(a)) === (await d(b));
}

export async function pushRoutes(req, env, ctx, path, me, h) {
  if (!path.startsWith('/push/')) return null;
  const M = req.method, now = Date.now();
  const b = M === 'GET' ? {} : await h.body(req);
  if (path === '/push/prefs' && M === 'GET') {
    const pf = await prefsOf(env.DB, me.id);
    const n = (await env.DB.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id = ?').bind(me.id).first()).n;
    return h.json({ ...pf, devices: n, configured: !!vapidOf(env) });
  }
  if (path === '/push/prefs' && M === 'PUT') {
    for (const k of ['notify', 'preview']) if (k in b && typeof b[k] !== 'boolean') return h.err(400, `${k} must be true or false.`);
    const cur = await prefsOf(env.DB, me.id);
    const next = { notify: 'notify' in b ? b.notify : cur.notify, preview: 'preview' in b ? b.preview : cur.preview };
    await env.DB.prepare(`INSERT INTO push_prefs(user_id, notify, preview, updated) VALUES(?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET notify = excluded.notify, preview = excluded.preview, updated = excluded.updated`).bind(me.id, next.notify ? 1 : 0, next.preview ? 1 : 0, now).run();
    return h.json(next);
  }
  if (path === '/push/subscribe' && M === 'POST') {
    if (!vapidOf(env)) return h.err(503, 'Notifications are not set up on the server yet.', { notConfigured: true });
    const local = ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);
    const why = await checkSubscription(b.subscription, local);
    if (why) return h.err(400, why);
    if ('preview' in b && typeof b.preview !== 'boolean') return h.err(400, 'preview must be true or false.');
    if (!(await h.use(env, me.id, 'pushsub'))) return h.err(429, 'That is a lot of notification changes for one day. Please try again tomorrow.');
    const s = b.subscription, lang = LANGS.includes(b.lang) ? b.lang : (me.native === 'es' ? 'es' : 'en');
    // upsert by endpoint: the same browser again updates its row (and moves to this person if someone else had it)
    await env.DB.prepare(`INSERT INTO push_subs(user_id, endpoint, p256dh, auth, lang, cred_id, created, fail_count) VALUES(?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang,
        cred_id = excluded.cred_id, fail_count = 0, created = CASE WHEN push_subs.user_id = excluded.user_id THEN push_subs.created ELSE excluded.created END`)
      .bind(me.id, s.endpoint, s.keys.p256dh.replace(/=+$/, ''), s.keys.auth.replace(/=+$/, ''), lang, me._cid || null, now).run();
    // the cap: keep the MAX_SUBS most recently heard from (this one included)
    const extra = (await env.DB.prepare(`SELECT id FROM push_subs WHERE user_id = ? AND endpoint != ? ORDER BY COALESCE(last_ok, created) DESC, id DESC LIMIT -1 OFFSET ?`)
      .bind(me.id, s.endpoint, MAX_SUBS - 1).all()).results;
    for (const x of extra) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(x.id).run();
    if ('preview' in b) await env.DB.prepare(`INSERT INTO push_prefs(user_id, notify, preview, updated) VALUES(?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET preview = excluded.preview, updated = excluded.updated`).bind(me.id, b.preview ? 1 : 0, now).run();
    const n = (await env.DB.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id = ?').bind(me.id).first()).n;
    return h.json({ ok: true, devices: n, replaced: extra.length, ...(await prefsOf(env.DB, me.id)) }, 201);
  }
  if (path === '/push/unsubscribe' && M === 'POST') {
    const ep = typeof b.endpoint === 'string' ? b.endpoint : '';
    if (!ep) return h.err(400, 'endpoint is required.');
    const r = await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(ep, me.id).run();
    return h.json({ ok: true, removed: r.meta.changes });
  }
  if (path === '/push/test' && M === 'POST') {
    if (!vapidOf(env)) return h.err(503, 'Notifications are not set up on the server yet.', { notConfigured: true });
    const ep = typeof b.endpoint === 'string' && b.endpoint ? b.endpoint : null;
    if (ep && !(await env.DB.prepare('SELECT 1 FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(ep, me.id).first())) return h.err(404, 'This device is not set up for notifications.');
    if (!ep && !(await env.DB.prepare('SELECT 1 FROM push_subs WHERE user_id = ? LIMIT 1').bind(me.id).first())) return h.err(404, 'No device is set up for notifications.');
    // one a minute, 20 a day
    const recent = await env.DB.prepare(`SELECT 1 FROM push_state WHERE user_id = ? AND thread_id = '#test' AND last_sent > ?`).bind(me.id, now - 60000).first();
    if (recent) return h.err(429, 'A test was just sent. Please wait a minute.');
    if (!(await h.use(env, me.id, 'pushtest'))) return h.err(429, 'That is a lot of tests for one day. Please try again tomorrow.');
    await env.DB.prepare(`INSERT INTO push_state(user_id, thread_id, last_sent, held) VALUES(?, '#test', ?, 0)
      ON CONFLICT(user_id, thread_id) DO UPDATE SET last_sent = excluded.last_sent`).bind(me.id, now).run();
    const r = await deliver(env, me.id, s => ({ v: 1, kind: 'test', lang: LANGS.includes(s.lang) ? s.lang : 'en', url: './#settings' }), { only: ep, topic: 'lector-test' });
    return h.json(r);
  }
  return h.err(404, 'Not found.');
}
