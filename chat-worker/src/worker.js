// lector-chat: Lector's Messages backend. Two people (more pairs later) chat; every message is stored
// with a full rendering in both thread languages, done by Workers AI on Brian's own Cloudflare account.
// Learners also get a private check-before-send and three reply helpers. Messages live only in D1 here.
import { translate, guessLang, correct, explain, helpers, aiState, allowed, AiUnavailable, AiFailed, BUDGET, PERSON, MODEL, today } from './ai.js';
import { edits as findEdits } from './diff.js';
import { accountRoutes, SESSION_MS } from './accounts.js';
import { connectorRoutes, handleMcp } from './mcp.js';
import { pushRoutes, pushKey, pushResubscribe, notifyNew } from './push.js';

// ---------- CORS ----------
const ALLOWED_ORIGINS = [
  'https://brianfliesballoons.github.io',
  'http://localhost:8000',
  'http://localhost:8010',   // the headless test harness
  'https://lector-preview.pages.dev',
];
const ALLOWED_ORIGIN_PATTERNS = [/^https:\/\/[a-z0-9-]+\.lector-preview\.pages\.dev$/];   // per-deploy previews only
const originOk = o => !!o && (ALLOWED_ORIGINS.includes(o) || ALLOWED_ORIGIN_PATTERNS.some(r => r.test(o)));
function cors(req) {
  const o = req.headers.get('Origin');
  const h = { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (originOk(o)) h['Access-Control-Allow-Origin'] = o;
  return h;
}

// ---------- limits ----------
const LIM = { text: 2000, check: 600, note: 1000, ref: 80, name: 60, title: 80 };
const PER_DAY = { message: 1000, check: 150, helpers: 100, report: 50, retranslate: 30, pushsub: 60, pushtest: 20 };   // per user per UTC day
const INVITE_DAYS = 14, INVITE_MAX_DAYS = 90;   // an invite link works this long unless it is used to make a session first
const LANGS = ['es', 'en'];
const LEVELS = ['beginner', 'elementary', 'getting by', 'intermediate', 'advanced', 'native'];
const REPORT_KINDS = ['translation', 'check', 'helper', 'other'];
const PAGE = 200;

// ---------- small helpers ----------
const rand = n => { const b = crypto.getRandomValues(new Uint8Array(n)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
async function body(req) { try { const b = await req.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch { return {}; } }
const bearer = req => (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();

// ---------- auth: the ONE place that decides who is calling ----------
// "Authorization: Bearer <token>", where the token is either
//   - a session (kind 'session', made by passkey or Google sign-in; 60-day expiry that slides forward with use), or
//   - a legacy invite token (kind 'invite', from a ?join= link; no expiry, retired once the person adds a passkey or Google).
// The endpoints only ever see the user row. _cid / _ckind / _cexp say which credential was used (never sent out).
async function authenticate(req, env) {
  const tok = bearer(req);
  if (!tok || tok.length < 20 || tok.length > 200) return null;
  const now = Date.now();
  const cred = await env.DB.prepare(`SELECT c.id _cid, c.kind _ckind, c.expires _cexp, c.last_used _clast, u.* FROM credentials c JOIN users u ON u.id = c.user_id
    WHERE c.hash = ? AND c.revoked = 0 AND c.kind IN ('invite', 'session') AND (c.expires IS NULL OR c.expires > ?)`).bind(await sha(tok), now).first();
  if (!cred) {
    // why it failed, for a kinder message: an invite that ran out says so (and nothing about anyone else's)
    const dead = await env.DB.prepare(`SELECT kind, revoked, expires FROM credentials WHERE hash = ? AND kind IN ('invite', 'session')`).bind(await sha(tok)).first();
    if (dead && dead.kind === 'invite' && !dead.revoked && dead.expires && dead.expires <= now) req.authWhy = 'invite-expired';
    return null;
  }
  const slide = cred._ckind === 'session' && cred._cexp - now < SESSION_MS - 864e5;
  if (slide) {
    cred._cexp = now + SESSION_MS;
    await env.DB.prepare('UPDATE credentials SET last_used = ?, expires = ? WHERE id = ?').bind(now, cred._cexp, cred._cid).run();
  } else if (!cred._clast || now - cred._clast > 36e5) await env.DB.prepare('UPDATE credentials SET last_used = ? WHERE id = ?').bind(now, cred._cid).run();
  const { _clast, ...user } = cred;
  return user;
}
async function isAdmin(req, env) {
  const k = bearer(req);
  if (!k || !env.ADMIN_KEY) return false;
  return (await sha(k)) === (await sha(env.ADMIN_KEY));   // compare digests, not the raw strings
}

const publicUser = u => ({ id: u.id, name: u.name, native: u.native, learning: u.learning, level: u.level });

async function member(env, threadId, userId) {
  return env.DB.prepare(`SELECT t.*, m.prefs FROM threads t JOIN members m ON m.thread_id = t.id WHERE t.id = ? AND m.user_id = ?`).bind(threadId, userId).first();
}
async function threadMembers(env, threadId) {
  return (await env.DB.prepare(`SELECT u.id, u.name, u.native, u.learning, u.level FROM members m JOIN users u ON u.id = m.user_id WHERE m.thread_id = ? ORDER BY m.joined`).bind(threadId).all()).results;
}

// counts one use; returns false once the user is over the day's allowance for that kind
async function use(env, userId, kind) {
  const r = await env.DB.prepare(`INSERT INTO uses(user_id, kind, day, n) VALUES(?1, ?2, ?3, 1)
    ON CONFLICT(user_id, kind, day) DO UPDATE SET n = n + 1 RETURNING n`).bind(userId, kind, today()).first();
  return r.n <= PER_DAY[kind];
}

// next value of the global change counter, as a statement usable inside a batch
const bumpSeq = env => env.DB.prepare(`UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'seq'`);
const SEQ = `(SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'seq')`;

function msgOut(m) {
  const pending = !!m.pending;
  return {
    id: m.id, thread: m.thread_id, from: m.user_id, created: m.created, seq: m.seq,
    deleted: !!m.deleted,
    text: m.deleted ? '' : m.text,
    lang: m.deleted ? null : m.lang,
    versions: m.deleted ? null : (m.versions ? JSON.parse(m.versions) : null),
    ...(pending && !m.deleted ? { translationPending: true } : {}),
    // gave up after MAX_TRIES (or a manual retry failed): the app shows "Couldn't translate · Retry"
    ...(m.failed && !pending && !m.deleted ? { translationFailed: true, translationError: m.failed } : {}),
  };
}

// language-day suggestion: the two languages alternate by calendar day, counted in Los Angeles time.
function languageDay(langs) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const dayNum = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
  return langs[dayNum % 2];
}

async function recentContext(env, threadId, beforeId, n, nameOf) {
  const rows = (await env.DB.prepare(`SELECT user_id, text FROM messages WHERE thread_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?`).bind(threadId, beforeId, n).all()).results.reverse();
  return rows.map(r => ({ who: nameOf(r.user_id), text: r.text }));
}

// translate one stored message (used on send, for back-filling pending ones and for a manual retry).
// Charged to the message's sender, whoever's request runs it.
async function fill(env, m, langs, nameOf) {
  const ctx = await recentContext(env, m.thread_id, m.id, 3, nameOf);
  const t = await translate(env, m.user_id, m.text, langs, ctx);
  await env.DB.batch([
    bumpSeq(env),
    env.DB.prepare(`UPDATE messages SET lang = ?, base = ?, versions = ?, pending = 0, claimed = NULL, next_try = NULL, failed = NULL, seq = ${SEQ} WHERE id = ? AND deleted = 0 AND pending = 1`)
      .bind(t.lang, t.base, JSON.stringify(t.versions), m.id),
  ]);
}

// A translation that fails is retried with backoff, then given up (S1, 2026-10-24). Before this, a message the
// model could not answer validly was retried on every poll, forever: ~1,000 neurons an hour from one open app.
// A used-up allowance is not a failure (nothing was tried): the message just waits, as before.
const MAX_TRIES = 3;
const BACKOFF_MS = [60e3, 5 * 60e3];     // wait after the 1st and 2nd failed try; the 3rd failure is final
const CLAIM_MS = 60000;
const CLAIMABLE = `pending = 1 AND deleted = 0 AND (claimed IS NULL OR claimed < ?) AND (next_try IS NULL OR next_try <= ?)`;
const claimableArgs = now => [now - CLAIM_MS, now];
// takes the translation job for one message; true only for the one request that wins it
async function claim(env, id) {
  const now = Date.now();
  const r = await env.DB.prepare(`UPDATE messages SET claimed = ? WHERE id = ? AND ${CLAIMABLE}`).bind(now, id, ...claimableArgs(now)).run();
  return r.meta.changes === 1;
}
// after a try that did not translate: release the claim; a real failure counts a try and backs off, the last one gives up
async function tryFailed(env, m, e) {
  if (e instanceof AiUnavailable && !(e instanceof AiFailed)) {   // allowance or share used up: not a try
    await env.DB.prepare('UPDATE messages SET claimed = NULL WHERE id = ?').bind(m.id).run();
    return;
  }
  const tries = (m.tries || 0) + 1, why = e instanceof AiFailed ? 'model' : 'error';
  console.log('translate failed', JSON.stringify({ message: m.id, try: tries, of: MAX_TRIES, reason: String(e && e.message || e).slice(0, 120) }));
  if (tries >= MAX_TRIES) {
    await env.DB.batch([
      bumpSeq(env),   // so polls pick up the change and the app can show "Couldn't translate · Retry"
      env.DB.prepare(`UPDATE messages SET pending = 0, claimed = NULL, next_try = NULL, tries = ?, failed = ?, seq = ${SEQ} WHERE id = ? AND deleted = 0 AND pending = 1`)
        .bind(tries, why, m.id),
    ]);
  } else {
    await env.DB.prepare('UPDATE messages SET claimed = NULL, tries = ?, next_try = ? WHERE id = ?').bind(tries, Date.now() + BACKOFF_MS[tries - 1], m.id).run();
  }
}

async function backfill(env, threadId) {
  if (!(await allowed(env, 'core'))) return;
  const th = await env.DB.prepare('SELECT langs FROM threads WHERE id = ?').bind(threadId).first();
  if (!th) return;
  const people = await threadMembers(env, threadId);
  const nameOf = id => (people.find(p => p.id === id) || {}).name || 'Someone';
  const rows = (await env.DB.prepare(`SELECT * FROM messages WHERE thread_id = ? AND ${CLAIMABLE} ORDER BY id LIMIT 3`).bind(threadId, ...claimableArgs(Date.now())).all()).results;
  for (const m of rows) {
    if (!(await claim(env, m.id))) continue;
    try { await fill(env, m, th.langs.split(','), nameOf); }
    catch (e) {
      await tryFailed(env, m, e);
      if (e instanceof AiUnavailable && !(e instanceof AiFailed) && e.reason !== 'person') return;   // the day is used up for everyone
    }
  }
}

export default {
  async fetch(req, env, ctx) {
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) } });
    const err = (status, msg, extra = {}) => json({ error: msg, ...extra }, status);
    const rawJson = (text, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const M = req.method;

    try {
      if (path === '/' && M === 'GET') return json({ ok: true, service: 'lector-chat' });

      // ---------- Claude connector (src/mcp.js): its own auth, the personal link IS the key ----------
      const mcp = path.match(/^\/mcp\/([^/]+)$/);
      if (mcp) return handleMcp(req, env, ctx, mcp[1], { sha });
      if (path === '/mcp') return err(404, 'Use your own connector link from Lector (Settings › Claude): it ends in /mcp/ and a long code.');

      // ---------- admin ----------
      if (path.startsWith('/admin/')) {
        if (!(await isAdmin(req, env))) return err(401, 'Admin key required.');
        const b = M === 'GET' ? {} : await body(req);
        if (path === '/admin/users' && M === 'POST') {
          const name = clean(b.name, LIM.name), native = b.native, learning = b.learning, level = clean(b.level || 'elementary', 20);
          if (!name || !LANGS.includes(native) || !LANGS.includes(learning) || native === learning) return err(400, 'Need name, native and learning (es or en, different).');
          if (!LEVELS.includes(level)) return err(400, `level must be one of: ${LEVELS.join(', ')}`);
          const id = 'u_' + rand(9);
          await env.DB.prepare('INSERT INTO users(id, name, native, learning, level, created) VALUES(?,?,?,?,?,?)').bind(id, name, native, learning, level, Date.now()).run();
          return json({ user: publicUser({ id, name, native, learning, level }) });
        }
        if (path === '/admin/users' && M === 'GET') {
          return json({ users: (await env.DB.prepare('SELECT id, name, native, learning, level, email, created FROM users ORDER BY created').all()).results });
        }
        if (path === '/admin/threads' && M === 'POST') {
          const ids = Array.isArray(b.members) ? [...new Set(b.members.map(String))] : [];
          if (ids.length < 2 || ids.length > 8) return err(400, 'members: 2 to 8 user ids.');
          const found = (await env.DB.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
          if (found.length !== ids.length) return err(400, 'Unknown user id in members.');
          const id = 't_' + rand(9), now = Date.now();
          await env.DB.batch([
            env.DB.prepare('INSERT INTO threads(id, title, langs, created) VALUES(?,?,?,?)').bind(id, clean(b.title, LIM.title) || null, 'es,en', now),
            ...ids.map(u => env.DB.prepare('INSERT INTO members(thread_id, user_id, joined) VALUES(?,?,?)').bind(id, u, now)),
          ]);
          return json({ thread: { id, title: b.title || null, members: ids } });
        }
        // invites: POST mints one (expires after `days`, default 14); POST /admin/invites/remint revokes that person's
        // earlier invites and mints a fresh one; GET lists them (never the tokens, which are not stored)
        if ((path === '/admin/invites' || path === '/admin/invites/remint') && M === 'POST') {
          const u = await env.DB.prepare('SELECT id, name FROM users WHERE id = ?').bind(String(b.user || '')).first();
          if (!u) return err(404, 'No such user.');
          const days = b.days === undefined ? INVITE_DAYS : Number(b.days);
          if (!Number.isFinite(days) || days < 1 || days > INVITE_MAX_DAYS) return err(400, `days must be between 1 and ${INVITE_MAX_DAYS}.`);
          const token = rand(32), id = 'c_' + rand(9), now = Date.now(), expires = now + Math.round(days * 864e5);
          let revoked = 0;
          if (b.revokeOld || path === '/admin/invites/remint')
            revoked = (await env.DB.prepare(`UPDATE credentials SET revoked = 1 WHERE user_id = ? AND kind = 'invite' AND revoked = 0`).bind(u.id).run()).meta.changes;
          await env.DB.prepare(`INSERT INTO credentials(id, user_id, kind, hash, label, created, expires) VALUES(?,?,?,?,?,?,?)`).bind(id, u.id, 'invite', await sha(token), clean(b.label, 60) || null, now, expires).run();
          return json({ user: u.id, credential: id, token, expires, revoked, link: `https://brianfliesballoons.github.io/lector/?join=${token}` });
        }
        if (path === '/admin/invites' && M === 'GET') {
          return json({ invites: (await env.DB.prepare(`SELECT c.id, c.user_id, u.name, c.label, c.created, c.expires, c.revoked, c.last_used FROM credentials c JOIN users u ON u.id = c.user_id
            WHERE c.kind = 'invite' ORDER BY c.created DESC LIMIT 200`).all()).results.map(r => ({ ...r, live: !r.revoked && (!r.expires || r.expires > Date.now()) })) });
        }
        if (path === '/admin/reports' && M === 'GET') {
          return json({ reports: (await env.DB.prepare('SELECT * FROM reports WHERE done = 0 ORDER BY id DESC LIMIT 500').all()).results });
        }
        const rd = path.match(/^\/admin\/reports\/(\d+)$/);
        if (rd && M === 'DELETE') { await env.DB.prepare('UPDATE reports SET done = 1 WHERE id = ?').bind(+rd[1]).run(); return json({ ok: true }); }
        if (path === '/admin/usage' && M === 'GET') {
          return json({ model: MODEL, budget: BUDGET, perPerson: PERSON, today: await aiState(env),
            people: (await env.DB.prepare('SELECT p.user_id, u.name, p.neurons, p.extra, p.calls FROM ai_person p LEFT JOIN users u ON u.id = p.user_id WHERE p.day = ? ORDER BY p.neurons DESC').bind(today()).all()).results,
            days: (await env.DB.prepare('SELECT * FROM ai_usage ORDER BY day DESC LIMIT 30').all()).results });
        }
        return err(404, 'Not found.');
      }

      // ---------- accounts: /auth/*, /account, /sync (src/accounts.js) ----------
      const acc = await accountRoutes(req, env, ctx, path, { json, rawJson, err, sha, rand, clean, body, bearer, publicUser, LANGS, LEVELS, originOk, authenticate });
      if (acc) return acc;

      // ---------- web push: the public key needs no sign-in (src/push.js) ----------
      if (path === '/push/key' && M === 'GET') return pushKey(env, { json });
      if (path === '/push/resubscribe' && M === 'POST') return pushResubscribe(req, env, { json, err, body, use });

      // ---------- everything below needs a person ----------
      const me = await authenticate(req, env);
      if (!me) return req.authWhy === 'invite-expired'
        ? err(401, 'This invite link has expired. Ask Brian for a new one.', { inviteExpired: true })
        : err(401, 'This device is not signed in. Sign in again, or open your invite link again.');

      // ---------- the app's side of the connector: /connector (make, check, turn off the link) and /context (Go deeper) ----------
      const con = await connectorRoutes(req, env, ctx, path, me, { json, err, sha, rand, body });
      if (con) return con;

      // ---------- web push: subscribe, unsubscribe, preferences, test (src/push.js) ----------
      const pr = await pushRoutes(req, env, ctx, path, me, { json, err, body, use });
      if (pr) return pr;

      if (path === '/me' && M === 'GET') {
        return json({ user: publicUser(me), ai: { available: await allowed(env, 'core', me.id), extrasAvailable: await allowed(env, 'extra', me.id) } });
      }

      if (path === '/threads' && M === 'GET') {
        const ths = (await env.DB.prepare(`SELECT t.*, m.prefs FROM threads t JOIN members m ON m.thread_id = t.id WHERE m.user_id = ? ORDER BY t.created`).bind(me.id).all()).results;
        const out = [];
        for (const t of ths) {
          const last = await env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1').bind(t.id).first();
          const prefs = JSON.parse(t.prefs || '{}'), langs = t.langs.split(',');
          out.push({
            id: t.id, title: t.title, langs, members: await threadMembers(env, t.id), prefs,
            languageDay: prefs.languageDays ? { suggest: languageDay(langs), note: 'A suggestion only. Write in any language.' } : null,
            last: last ? msgOut(last) : null,
          });
        }
        return json({ threads: out });
      }

      if (path === '/messages' && M === 'GET') {
        const th = await member(env, url.searchParams.get('thread') || '', me.id);
        if (!th) return err(404, 'No such conversation.');
        const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
        // first load (since=0): the newest PAGE messages; after that, every change past the cursor
        const rows = since === 0
          ? (await env.DB.prepare('SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?) ORDER BY id').bind(th.id, PAGE).all()).results
          : (await env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?').bind(th.id, since, PAGE).all()).results;
        const cursor = since === 0
          ? +(await env.DB.prepare(`SELECT v FROM meta WHERE k = 'seq'`).first()).v
          : rows.reduce((x, r) => Math.max(x, r.seq), since);
        if (await env.DB.prepare(`SELECT 1 FROM messages WHERE thread_id = ? AND ${CLAIMABLE} LIMIT 1`).bind(th.id, ...claimableArgs(Date.now())).first())
          ctx.waitUntil(backfill(env, th.id));   // finished translations arrive on a later poll
        return json({ messages: rows.map(msgOut), cursor, more: rows.length === PAGE, aiAvailable: await allowed(env, 'core', me.id) });
      }

      if (path === '/messages' && M === 'POST') {
        const b = await body(req);
        const th = await member(env, String(b.thread || ''), me.id);
        if (!th) return err(404, 'No such conversation.');
        const text = clean(b.text, LIM.text + 1);
        if (!text) return err(400, 'Nothing to send.');
        if (text.length > LIM.text) return err(400, `Messages can be up to ${LIM.text} characters.`);
        if (!(await use(env, me.id, 'message'))) return err(429, 'That is a lot of messages for one day. Please try again tomorrow.');
        const now = Date.now();
        const ins = await env.DB.batch([
          bumpSeq(env),
          env.DB.prepare(`INSERT INTO messages(thread_id, user_id, text, lang, pending, claimed, created, seq) VALUES(?, ?, ?, ?, 1, ?, ?, ${SEQ}) RETURNING *`).bind(th.id, me.id, text, guessLang(text), now, now),
        ]);
        let m = ins[1].results[0];
        const people = await threadMembers(env, th.id);
        const nameOf = id => (people.find(p => p.id === id) || {}).name || 'Someone';
        try {
          await fill(env, m, th.langs.split(','), nameOf);
          m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(m.id).first();
        } catch (e) {
          // the message is saved either way: a later poll tries again (with backoff), up to MAX_TRIES in all
          await tryFailed(env, m, e);
          m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(m.id).first();
        }
        // tell the other person's phones (after the translation was tried, so it can ride along); never holds up the send
        ctx.waitUntil(notifyNew(env, m));
        return json({ message: msgOut(m) }, 201);
      }

      // a manual retry of a translation that failed (or is still waiting): the sender or the reader can ask.
      // One try, charged to the sender like any translation; if it fails again the message goes back to failed.
      const rt = path.match(/^\/messages\/(\d+)\/retranslate$/);
      if (rt && M === 'POST') {
        const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(+rt[1]).first();
        if (!m || m.deleted) return err(404, 'No such message.');
        const th = await member(env, m.thread_id, me.id);
        if (!th) return err(404, 'No such message.');
        if (!m.pending && !m.failed) return json({ message: msgOut(m), note: 'Already translated.' });
        const now = Date.now();
        if (m.pending && m.claimed && m.claimed >= now - CLAIM_MS) return json({ message: msgOut(m), note: 'Already translating.' }, 202);
        if (!(await use(env, me.id, 'retranslate'))) return err(429, 'That is a lot of retries for one day. Please try again tomorrow.');
        const no = await allowed(env, 'core', m.user_id, true);
        if (no) return json({ message: msgOut(m), unavailable: true, note: no === 'person' ? 'Translation is resting for this person until tomorrow.' : 'Translation is resting until tomorrow.' });
        // take it: pending again, claimed by this request, one try left before it is marked failed again
        const took = await env.DB.batch([
          bumpSeq(env),
          env.DB.prepare(`UPDATE messages SET pending = 1, failed = NULL, claimed = ?, next_try = NULL, tries = ?, seq = ${SEQ}
            WHERE id = ? AND deleted = 0 AND (failed IS NOT NULL OR (pending = 1 AND (claimed IS NULL OR claimed < ?)))`).bind(now, MAX_TRIES - 1, m.id, now - CLAIM_MS),
        ]);
        if (took[1].meta.changes !== 1) return json({ message: msgOut(await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(m.id).first()), note: 'Already translating.' }, 202);
        const people = await threadMembers(env, m.thread_id);
        const nameOf = id => (people.find(p => p.id === id) || {}).name || 'Someone';
        const cur = { ...m, tries: MAX_TRIES - 1 };
        try { await fill(env, cur, th.langs.split(','), nameOf); }
        catch (e) { await tryFailed(env, cur, e); }
        return json({ message: msgOut(await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(m.id).first()) });
      }

      const del = path.match(/^\/messages\/(\d+)$/);
      if (del && M === 'DELETE') {
        const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(+del[1]).first();
        if (!m || m.deleted || !(await member(env, m.thread_id, me.id))) return err(404, 'No such message.');
        if (m.user_id !== me.id) return err(403, 'You can only delete your own messages.');
        await env.DB.batch([
          bumpSeq(env),
          env.DB.prepare(`UPDATE messages SET text = '', versions = NULL, lang = NULL, base = NULL, pending = 0, failed = NULL, deleted = 1, seq = ${SEQ} WHERE id = ?`).bind(m.id),
          env.DB.prepare(`UPDATE reports SET context = NULL WHERE ref = ?`).bind('msg:' + m.id),
        ]);
        return json({ ok: true, id: m.id });
      }

      if (path === '/check' && M === 'POST') {
        const b = await body(req);
        if (!(await member(env, String(b.thread || ''), me.id))) return err(404, 'No such conversation.');
        const text = clean(b.text, LIM.check + 1);
        if (!text) return err(400, 'Nothing to check.');
        if (text.length > LIM.check) return err(400, `The check works on up to ${LIM.check} characters at a time.`);
        const lang = LANGS.includes(b.lang) ? b.lang : me.learning;
        if (!(await use(env, me.id, 'check'))) return err(429, 'That is a lot of checks for one day. Please try again tomorrow.');
        try {
          // Two independent passes; only an edit both of them make is shown (guards against one-off over-correction).
          const [f1, f2] = await Promise.all([correct(env, me.id, text, lang, 0), correct(env, me.id, text, lang, 0.5)]);
          const e2 = new Set(findEdits(text, f2).map(e => `${e.start}|${e.end}|${e.to}`));
          const found = f1 === text || f2 === text ? [] : findEdits(text, f1).filter(e => e2.has(`${e.start}|${e.end}|${e.to}`));
          const fixed = f1;
          if (!found.length) return json({ ok: true, lang, edits: [] });
          const level = lang === me.learning ? me.level : 'native';
          let why;
          try { why = await explain(env, me.id, text, fixed, found, lang, me.native, level); }
          catch (e) { if (!(e instanceof AiUnavailable)) throw e; why = null; }
          if (!why) return json({ ok: false, lang, edits: found.map(e => ({ ...e, why: null })), explainPending: true });
          const kept = found.map((e, i) => ({ ...e, ...why.get(i + 1) })).filter(e => e.real).map(({ real, ...e }) => e);
          return json({ ok: kept.length === 0, lang, edits: kept });
        } catch (e) {
          if (e instanceof AiUnavailable) return json({ ok: null, unavailable: true, edits: [], reason: e.reason,
            note: e instanceof AiFailed ? 'The checker could not answer just now. Your message is fine to send.'
              : e.reason === 'person' ? 'You have used your share of checks for today. Your message is fine to send.'
              : 'The checker is resting until tomorrow. Your message is fine to send.' });
          throw e;
        }
      }

      if (path === '/helpers' && M === 'POST') {
        const b = await body(req);
        const th = await member(env, String(b.thread || ''), me.id);
        if (!th) return err(404, 'No such conversation.');
        const saved = JSON.parse(th.prefs || '{}').helperLang;
        const lang = LANGS.includes(b.lang) ? b.lang : LANGS.includes(saved) ? saved : me.learning;
        const last = await env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? AND user_id != ? AND deleted = 0 ORDER BY id DESC LIMIT 1').bind(th.id, me.id).first();
        if (!last) return json({ replies: [], note: 'Nothing to reply to yet.' });
        if (!(await use(env, me.id, 'helpers'))) return err(429, 'That is a lot of reply ideas for one day. Please try again tomorrow.');
        const people = await threadMembers(env, th.id);
        const nameOf = id => (people.find(p => p.id === id) || {}).name || 'Someone';
        const hist = await recentContext(env, th.id, last.id, 6, nameOf);
        try {
          const h = await helpers(env, me, lang, hist, { who: nameOf(last.user_id), text: last.text, versions: JSON.parse(last.versions || 'null') }, people);
          return json({ replyTo: last.id, lang, replies: h.replies });
        } catch (e) {
          if (e instanceof AiUnavailable) return json({ replyTo: last.id, lang, replies: [], unavailable: true, reason: e.reason,
            note: e instanceof AiFailed ? 'Reply ideas could not be made just now. Please try again.'
              : e.reason === 'person' ? 'You have used your share of reply ideas for today.' : 'Reply ideas are resting until tomorrow.' });
          throw e;
        }
      }

      if (path === '/report' && M === 'POST') {
        const b = await body(req);
        const kind = REPORT_KINDS.includes(b.kind) ? b.kind : null;
        if (!kind) return err(400, `kind must be one of: ${REPORT_KINDS.join(', ')}`);
        if (!(await use(env, me.id, 'report'))) return err(429, 'Thanks, that is plenty of reports for today.');
        const ref = clean(b.ref, LIM.ref) || null, note = clean(b.note, LIM.note) || null;
        let context = b.context && typeof b.context === 'object' ? JSON.stringify(b.context).slice(0, 4000) : null;
        const mm = ref && ref.match(/^msg:(\d+)$/);
        if (mm) {
          const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(+mm[1]).first();
          if (!m || !(await member(env, m.thread_id, me.id))) return err(404, 'No such message.');
          if (!m.deleted) context = JSON.stringify({ text: m.text, lang: m.lang, versions: JSON.parse(m.versions || 'null') });
        }
        const r = await env.DB.prepare('INSERT INTO reports(user_id, kind, ref, note, context, created) VALUES(?,?,?,?,?,?) RETURNING id').bind(me.id, kind, ref, note, context, Date.now()).first();
        return json({ ok: true, id: r.id }, 201);
      }

      if (path === '/prefs' && M === 'PUT') {
        const b = await body(req);
        const th = await member(env, String(b.thread || ''), me.id);
        if (!th) return err(404, 'No such conversation.');
        const prefs = JSON.parse(th.prefs || '{}');
        if ('languageDays' in b) {
          if (typeof b.languageDays !== 'boolean') return err(400, 'languageDays must be true or false.');
          prefs.languageDays = b.languageDays;
        }
        if ('helperLang' in b) {
          if (b.helperLang !== null && !LANGS.includes(b.helperLang)) return err(400, 'helperLang must be es, en or null.');
          prefs.helperLang = b.helperLang;
        }
        await env.DB.prepare('UPDATE members SET prefs = ? WHERE thread_id = ? AND user_id = ?').bind(JSON.stringify(prefs), th.id, me.id).run();
        const langs = th.langs.split(',');
        return json({ prefs, languageDay: prefs.languageDays ? { suggest: languageDay(langs), note: 'A suggestion only. Write in any language.' } : null });
      }

      return err(404, 'Not found.');
    } catch (e) {
      console.log('error', String(e && e.stack || e));
      return err(500, 'Something went wrong on our side. Please try again.');
    }
  },
};
