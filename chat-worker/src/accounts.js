// lector-chat accounts (build step G): passkeys, Google sign-in, sessions, profile sync.
// worker.js calls accountRoutes() first; it answers /auth/*, /account and /sync and returns null for anything else.
// Who is calling is still decided only by authenticate() in worker.js (passed in as h.authenticate).
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { verifyGoogleIdToken, googleKeys, GoogleTokenError } from './google.js';
import { validateIncoming, SyncError, MAX_BYTES } from './sync.js';
import { saveProfile, profileJson, profileVersion } from './profile.js';

export const SESSION_MS = 60 * 864e5;        // 60 days, sliding
const SLIDE_AFTER_MS = 864e5;                // extend a session at most once a day
const MAX_SESSIONS = 30;                     // per person; the least recently used beyond this are revoked
const CHALLENGE_MS = 5 * 60e3;
const NONCE_MS = 10 * 60e3;

// Relying-party ids. A passkey is bound to one of these and works only there.
export const LIVE_RP = 'brianfliesballoons.github.io';
export const PREVIEW_RP = 'lector-preview.pages.dev';
export function rpFor(origin, originOk) {
  if (!origin || !originOk(origin)) return null;
  if (origin === 'https://brianfliesballoons.github.io') return LIVE_RP;
  if (origin === 'https://lector-preview.pages.dev' || /^https:\/\/[a-z0-9-]+\.lector-preview\.pages\.dev$/.test(origin)) return PREVIEW_RP;
  if (/^http:\/\/localhost:\d+$/.test(origin)) return 'localhost';   // the local test harness only
  return null;
}

// Rate limits (fixed windows). ip = an HMAC-style hash of the address; raw addresses are never stored.
const RATE = {
  auth:       { n: 60,  ms: 10 * 60e3 },     // every POST/PUT/DELETE under /auth, per address
  signup:     { n: 5,   ms: 864e5 },         // new accounts per address per day
  signupAll:  { n: 50,  ms: 864e5 },         // new accounts per day, everyone together
  sync:       { n: 600, ms: 36e5 },          // profile writes per person per hour
};

const uaLabel = req => {
  const ua = req.headers.get('User-Agent') || '';
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
};

export async function accountRoutes(req, env, ctx, path, h) {
  if (!(path.startsWith('/auth/') || path === '/account' || path === '/sync')) return null;
  const { json, rawJson, err, sha, rand, clean, body, bearer, publicUser, LANGS, LEVELS } = h;
  const M = req.method, now = Date.now();
  const origin = req.headers.get('Origin') || '';
  const DB = env.DB;

  const ipKey = async () => (await sha(`${env.ADMIN_KEY || ''}|${req.headers.get('CF-Connecting-IP') || 'unknown'}`)).slice(0, 24);
  async function hit(bucket, who) {
    const { n, ms } = RATE[bucket];
    const start = Math.floor(now / ms) * ms;
    const r = await DB.prepare(`INSERT INTO rate(k, n, expires) VALUES(?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n`)
      .bind(`${bucket}|${who}|${start}`, start + ms).first();
    return r.n <= n;
  }
  // old challenges, rate windows and long-dead sessions are swept now and then, not on every request
  if (Math.random() < 0.05) ctx.waitUntil(DB.batch([
    DB.prepare('DELETE FROM challenges WHERE expires < ?').bind(now),
    DB.prepare('DELETE FROM rate WHERE expires < ?').bind(now),
    DB.prepare(`DELETE FROM credentials WHERE kind = 'session' AND (revoked = 1 OR expires < ?) AND created < ?`).bind(now - 7 * 864e5, now - 7 * 864e5),
  ]).catch(e => console.log('sweep failed', String(e))));

  if (path.startsWith('/auth/') && M !== 'GET' && !(await hit('auth', await ipKey())))
    return err(429, 'Too many sign-in attempts from here. Please wait ten minutes and try again.');

  const me = await h.authenticate(req, env);
  const sentBadToken = !me && !!bearer(req);

  // ---------- helpers ----------
  async function newSession(userId, via) {
    const token = rand(32), id = 's_' + rand(9);
    await DB.batch([
      DB.prepare(`INSERT INTO credentials(id, user_id, kind, hash, label, created, last_used, expires, via) VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(id, userId, 'session', await sha(token), uaLabel(req), now, now, now + SESSION_MS, via),
      DB.prepare(`UPDATE credentials SET revoked = 1 WHERE id IN (SELECT id FROM credentials WHERE user_id = ? AND kind = 'session' AND revoked = 0
        ORDER BY COALESCE(last_used, created) DESC LIMIT -1 OFFSET ?)`).bind(userId, MAX_SESSIONS),
    ]);
    return { token, expires: now + SESSION_MS };
  }
  async function methods(userId) {
    const u = await DB.prepare('SELECT google_sub, email FROM users WHERE id = ?').bind(userId).first();
    const p = (await DB.prepare('SELECT COUNT(*) n FROM passkeys WHERE user_id = ?').bind(userId).first()).n;
    const i = (await DB.prepare(`SELECT COUNT(*) n FROM credentials WHERE user_id = ? AND kind = 'invite' AND revoked = 0 AND (expires IS NULL OR expires > ?)`).bind(userId, now).first()).n;
    return { passkeys: p, invites: i, google: !!(u && u.google_sub), googleEmail: u ? u.email : null, total: p + i + (u && u.google_sub ? 1 : 0) };
  }
  // once someone has a real way to sign in, their invite link stops working (it was only ever a stand-in)
  async function retireInvites(userId) {
    return (await DB.prepare(`UPDATE credentials SET revoked = 1 WHERE user_id = ? AND kind = 'invite' AND revoked = 0`).bind(userId).run()).meta.changes;
  }
  async function takeChallenge(handle, kind) {
    if (typeof handle !== 'string' || handle.length > 64) return null;
    const row = await DB.prepare('DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING *').bind(handle, kind).first();
    return row && row.expires >= now ? row : null;
  }
  async function newAccountAllowed() {
    if (env.SIGNUP === 'closed') return 'New accounts are closed right now. Ask Brian for an invite link.';
    if (!(await hit('signup', await ipKey())) || !(await hit('signupAll', 'all'))) return 'Too many new accounts today. Please try again tomorrow.';
    return null;
  }
  // id: a passkey sign-up passes the id its passkey was made for (the passkey's user handle), so the two match
  async function createUser({ id = 'u_' + rand(9), name, native, learning, level, email = null, googleSub = null }) {
    if (!/^u_[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error('bad new user id');
    await DB.prepare('INSERT INTO users(id, name, native, learning, level, email, google_sub, created) VALUES(?,?,?,?,?,?,?,?)')
      .bind(id, name, native, learning, level, email, googleSub, now).run();
    return { id, name, native, learning, level };
  }
  const profileIn = b => {
    const native = LANGS.includes(b.native) ? b.native : 'en';
    let learning = LANGS.includes(b.learning) ? b.learning : (native === 'en' ? 'es' : 'en');
    if (learning === native) learning = native === 'en' ? 'es' : 'en';
    return { name: clean(b.name, 60) || 'Reader', native, learning, level: LEVELS.includes(b.level) ? b.level : 'elementary' };
  };
  const googleClient = () => (env.GOOGLE_CLIENT_ID || '').trim();
  // Test hook: a local `wrangler dev` may supply its own Google keys. Ignored on any non-local hostname.
  const local = ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);
  const getKeys = local && env.GOOGLE_TEST_JWKS ? async () => JSON.parse(env.GOOGLE_TEST_JWKS).keys : googleKeys;
  async function google(credential) {
    const g = await verifyGoogleIdToken(credential, googleClient(), { getKeys });
    if (!g.nonce) throw new GoogleTokenError('Start Google sign-in from Lector so it carries a one-time code.');
    const row = await DB.prepare(`DELETE FROM challenges WHERE kind = 'google' AND challenge = ? RETURNING *`).bind(g.nonce).first();
    if (!row || row.expires < now) throw new GoogleTokenError('That Google sign-in was already used or has expired. Please try again.');
    return g;
  }

  // ---------- public: what this page can use ----------
  if (path === '/auth/config' && M === 'GET') {
    return json({ google: { configured: !!googleClient(), clientId: googleClient() || null }, signup: env.SIGNUP === 'closed' ? 'closed' : 'open', passkeyRpId: rpFor(origin, h.originOk) });
  }

  // ---------- passkeys ----------
  if (path === '/auth/passkey/register/options' && M === 'POST') {
    const rpID = rpFor(origin, h.originOk);
    if (!rpID) return err(400, 'Passkeys can only be made from the Lector app itself.');
    if (sentBadToken) return err(401, 'This device is no longer signed in. Sign in again first.');
    const b = await body(req);
    let userId, name, data;
    if (me) { userId = me.id; name = me.name; data = { adding: true }; }
    else {
      if (env.SIGNUP === 'closed') return err(403, 'New accounts are closed right now. Ask Brian for an invite link.');
      const p = profileIn(b);
      userId = 'u_' + rand(9); name = p.name; data = { signup: { ...p, id: userId } };
    }
    const have = me ? (await DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ? AND rp_id = ?').bind(me.id, rpID).all()).results : [];
    const options = await generateRegistrationOptions({
      rpName: 'Lector', rpID, userName: name, userDisplayName: name, userID: new TextEncoder().encode(userId),
      attestationType: 'none', timeout: CHALLENGE_MS,
      excludeCredentials: have.map(p => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
    });
    const handle = 'h_' + rand(18);
    await DB.prepare('INSERT INTO challenges(id, kind, challenge, rp_id, origin, user_id, data, expires) VALUES(?,?,?,?,?,?,?,?)')
      .bind(handle, 'reg', options.challenge, rpID, origin, me ? me.id : null, JSON.stringify(data), now + CHALLENGE_MS).run();
    return json({ handle, options });
  }

  if (path === '/auth/passkey/register/verify' && M === 'POST') {
    const b = await body(req);
    const row = await takeChallenge(b.handle, 'reg');
    if (!row) return err(400, 'That passkey request has expired. Please start again.');
    if (origin !== row.origin) return err(400, 'That passkey request came from a different site.');
    if (row.user_id ? (!me || me.id !== row.user_id) : (me || sentBadToken)) return err(401, 'Your sign-in changed part way through. Please start again.');
    let v;
    try {
      v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: row.challenge, expectedOrigin: row.origin, expectedRPID: row.rp_id, requireUserVerification: true });
    } catch (e) { return err(400, 'That passkey could not be checked. Please try again.', { detail: String(e && e.message || e).slice(0, 200) }); }
    if (!v.verified) return err(400, 'That passkey could not be checked. Please try again.');
    const info = v.registrationInfo, c = info.credential;
    if (await DB.prepare('SELECT 1 FROM passkeys WHERE id = ?').bind(c.id).first()) return err(409, 'That passkey is already registered.');
    const data = JSON.parse(row.data || '{}');
    let user = me, session = null, created = false;
    if (data.signup) {
      const no = await newAccountAllowed();
      if (no) return err(429, no);
      user = await createUser(data.signup);
      created = true;
    }
    await DB.prepare(`INSERT INTO passkeys(id, user_id, rp_id, public_key, counter, transports, device_type, backed_up, label, created) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(c.id, user.id, row.rp_id, isoBase64URL.fromBuffer(c.publicKey), c.counter || 0, c.transports ? JSON.stringify(c.transports) : null,
        info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, clean(b.device, 40) || uaLabel(req), now).run();
    if (created) session = await newSession(user.id, 'signup-passkey');
    else if (me._ckind === 'invite') session = await newSession(user.id, 'upgrade');
    // A preview passkey cannot sign in on the live app, so it does not retire the invite.
    const invitesRevoked = row.rp_id === PREVIEW_RP ? 0 : await retireInvites(user.id);
    return json({ user: publicUser(user), created, passkey: { id: c.id, rpId: row.rp_id, synced: info.credentialDeviceType === 'multiDevice' }, session, invitesRevoked }, 201);
  }

  if (path === '/auth/passkey/login/options' && M === 'POST') {
    const rpID = rpFor(origin, h.originOk);
    if (!rpID) return err(400, 'Passkeys can only be used from the Lector app itself.');
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: CHALLENGE_MS });
    const handle = 'h_' + rand(18);
    await DB.prepare('INSERT INTO challenges(id, kind, challenge, rp_id, origin, expires) VALUES(?,?,?,?,?,?)')
      .bind(handle, 'auth', options.challenge, rpID, origin, now + CHALLENGE_MS).run();
    return json({ handle, options });
  }

  if (path === '/auth/passkey/login/verify' && M === 'POST') {
    const b = await body(req);
    const row = await takeChallenge(b.handle, 'auth');
    if (!row) return err(400, 'That sign-in request has expired. Please try again.');
    if (origin !== row.origin) return err(400, 'That sign-in request came from a different site.');
    const credId = b.response && typeof b.response.id === 'string' ? b.response.id.slice(0, 1024) : '';
    const pk = credId && await DB.prepare('SELECT * FROM passkeys WHERE id = ? AND rp_id = ?').bind(credId, row.rp_id).first();
    if (!pk) return err(401, row.rp_id === PREVIEW_RP || row.rp_id === LIVE_RP
      ? 'That passkey is not registered for this site. A passkey made on the preview site does not work on the live app, and the reverse.'
      : 'That passkey is not registered for this site.');
    const uh = b.response.response && b.response.response.userHandle;
    if (uh) {
      let who = '';
      try { who = new TextDecoder().decode(isoBase64URL.toBuffer(uh)); } catch {}
      if (who !== pk.user_id) return err(401, 'That passkey belongs to a different account.');
    }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: b.response, expectedChallenge: row.challenge, expectedOrigin: row.origin, expectedRPID: row.rp_id, requireUserVerification: true,
        credential: { id: pk.id, publicKey: isoBase64URL.toBuffer(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined },
      });
    } catch (e) { return err(401, 'That passkey could not be checked. Please try again.', { detail: String(e && e.message || e).slice(0, 200) }); }
    if (!v.verified) return err(401, 'That passkey could not be checked. Please try again.');
    await DB.prepare('UPDATE passkeys SET counter = ?, last_used = ?, backed_up = ? WHERE id = ?')
      .bind(v.authenticationInfo.newCounter, now, v.authenticationInfo.credentialBackedUp ? 1 : 0, pk.id).run();
    const user = await DB.prepare('SELECT * FROM users WHERE id = ?').bind(pk.user_id).first();
    if (!user) return err(401, 'That account no longer exists.');
    return json({ user: publicUser(user), session: await newSession(user.id, 'passkey') });
  }

  // ---------- Google ----------
  if (path.startsWith('/auth/google') && !googleClient() && M !== 'GET')
    return err(503, 'Google sign-in is not set up yet.', { notConfigured: true });

  if (path === '/auth/google/nonce' && M === 'POST') {
    const nonce = rand(24);
    await DB.prepare('INSERT INTO challenges(id, kind, challenge, origin, expires) VALUES(?,?,?,?,?)').bind('g_' + rand(12), 'google', nonce, origin, now + NONCE_MS).run();
    return json({ nonce, clientId: googleClient() });
  }

  if (path === '/auth/google' && M === 'POST') {
    if (me) return err(409, 'You are already signed in. To add Google to this account, use "Add Google" in Settings.');
    if (sentBadToken) return err(401, 'This device is no longer signed in. Clear it and sign in again.');
    const b = await body(req);
    let g;
    try { g = await google(b.credential); } catch (e) { if (e instanceof GoogleTokenError) return err(401, e.message); throw e; }
    const found = await DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(g.sub).first();
    if (found) return json({ user: publicUser(found), created: false, session: await newSession(found.id, 'google') });
    // No silent linking by email: an account that already has this email must add Google itself, while signed in.
    if (g.email && await DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(g.email).first())
      return err(409, 'A Lector account already uses this Google email. Sign in to it another way, then choose "Add Google" in Settings.');
    const no = await newAccountAllowed();
    if (no) return err(env.SIGNUP === 'closed' ? 403 : 429, no);
    const user = await createUser({ ...profileIn({ ...b, name: b.name || g.name }), email: g.email, googleSub: g.sub });
    return json({ user: publicUser(user), created: true, session: await newSession(user.id, 'signup-google') }, 201);
  }

  // ---------- everything below needs a person ----------
  if (!me) return err(401, sentBadToken ? 'This device is no longer signed in. Please sign in again.' : 'Please sign in first.');

  if (path === '/auth/google/link' && M === 'POST') {
    const b = await body(req);
    let g;
    try { g = await google(b.credential); } catch (e) { if (e instanceof GoogleTokenError) return err(401, e.message); throw e; }
    const other = await DB.prepare('SELECT id FROM users WHERE google_sub = ? AND id != ?').bind(g.sub, me.id).first();
    if (other) return err(409, 'That Google account is already linked to a different Lector account.');
    if (me.google_sub && me.google_sub !== g.sub) return err(409, 'This account is linked to a different Google account. Remove that one first.');
    const emailFree = g.email && !(await DB.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').bind(g.email, me.id).first());
    await DB.prepare('UPDATE users SET google_sub = ?, email = ? WHERE id = ?').bind(g.sub, emailFree ? g.email : me.email, me.id).run();
    const session = me._ckind === 'invite' ? await newSession(me.id, 'upgrade') : null;
    return json({ linked: true, email: emailFree ? g.email : me.email, session, invitesRevoked: await retireInvites(me.id) });
  }

  if (path === '/auth/google' && M === 'DELETE') {
    const m = await methods(me.id);
    if (!m.google) return err(404, 'No Google account is linked.');
    if (m.total <= 1) return err(409, 'Google is your only way to sign in. Add a passkey first, then remove Google.');
    await DB.prepare('UPDATE users SET google_sub = NULL, email = NULL WHERE id = ?').bind(me.id).run();
    return json({ ok: true });
  }

  if (path === '/auth/passkeys' && M === 'GET') {
    const here = rpFor(origin, h.originOk);
    const rows = (await DB.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created').bind(me.id).all()).results;
    return json({ passkeys: rows.map(p => ({ id: p.id, rpId: p.rp_id, thisSite: p.rp_id === here, label: p.label, synced: p.device_type === 'multiDevice', created: p.created, lastUsed: p.last_used })) });
  }
  const pkDel = path.match(/^\/auth\/passkeys\/([A-Za-z0-9_-]{1,1024})$/);
  if (pkDel && M === 'DELETE') {
    const pk = await DB.prepare('SELECT id FROM passkeys WHERE id = ? AND user_id = ?').bind(pkDel[1], me.id).first();
    if (!pk) return err(404, 'No such passkey.');
    if ((await methods(me.id)).total <= 1) return err(409, 'That is your only way to sign in. Add another passkey or Google first.');
    await DB.prepare('DELETE FROM passkeys WHERE id = ?').bind(pk.id).run();
    return json({ ok: true, note: 'Removed from Lector. The passkey itself stays on your device until you delete it in your phone\'s passwords.' });
  }

  if (path === '/auth/sessions' && M === 'GET') {
    const rows = (await DB.prepare(`SELECT id, kind, label, via, created, last_used, expires FROM credentials
      WHERE user_id = ? AND revoked = 0 AND kind IN ('session','invite') AND (expires IS NULL OR expires > ?) ORDER BY COALESCE(last_used, created) DESC`).bind(me.id, now).all()).results;
    return json({ sessions: rows.map(r => ({ id: r.id, kind: r.kind, label: r.label, via: r.via, created: r.created, lastUsed: r.last_used, expires: r.expires, current: r.id === me._cid })) });
  }
  const sDel = path.match(/^\/auth\/sessions\/([A-Za-z0-9_-]{1,40})$/);
  if (sDel && M === 'DELETE') {
    const c = await DB.prepare(`SELECT id, kind FROM credentials WHERE id = ? AND user_id = ? AND revoked = 0 AND kind IN ('session','invite')`).bind(sDel[1], me.id).first();
    if (!c) return err(404, 'No such session.');
    if (c.kind === 'invite' && (await methods(me.id)).total <= 1) return err(409, 'That invite link is your only way to sign in. Add a passkey or Google first.');
    await DB.prepare('UPDATE credentials SET revoked = 1 WHERE id = ?').bind(c.id).run();
    return json({ ok: true, current: c.id === me._cid });
  }
  if (path === '/auth/signout' && M === 'POST') {
    if (me._ckind !== 'session') return json({ ok: true, note: 'This device signed in with an invite link, which stays valid. Forget it on this device, or revoke it from your sessions.' });
    await DB.prepare('UPDATE credentials SET revoked = 1 WHERE id = ?').bind(me._cid).run();
    return json({ ok: true });
  }

  // ---------- the account itself ----------
  if (path === '/account' && M === 'GET') {
    return json({ user: publicUser(me), signIn: await methods(me.id), current: { kind: me._ckind, expires: me._cexp || null } });
  }
  if (path === '/account' && M === 'PUT') {
    const b = await body(req);
    const u = { name: me.name, native: me.native, learning: me.learning, level: me.level };
    if ('name' in b) { u.name = clean(b.name, 60); if (!u.name) return err(400, 'A name cannot be empty.'); }
    if ('native' in b) { if (!LANGS.includes(b.native)) return err(400, `native must be one of: ${LANGS.join(', ')}`); u.native = b.native; }
    if ('learning' in b) { if (!LANGS.includes(b.learning)) return err(400, `learning must be one of: ${LANGS.join(', ')}`); u.learning = b.learning; }
    if ('level' in b) { if (!LEVELS.includes(b.level)) return err(400, `level must be one of: ${LEVELS.join(', ')}`); u.level = b.level; }
    if (u.native === u.learning) return err(400, 'native and learning must be different.');
    await DB.prepare('UPDATE users SET name = ?, native = ?, learning = ?, level = ? WHERE id = ?').bind(u.name, u.native, u.learning, u.level, me.id).run();
    return json({ user: publicUser({ ...me, ...u }) });
  }

  // ---------- profile sync ----------
  // The profile is stored a row per key and per entry (src/profile.js); D1 assembles the answer into one string,
  // so the Worker never parses a large profile (CPU, S3-12). The PUT answer is the merged profile, as before.
  if (path === '/sync' && M === 'GET') {
    const v = parseInt(new URL(req.url).searchParams.get('version') || '', 10);
    if (Number.isFinite(v)) { const cur = await profileVersion(DB, me.id); if (v === cur) return json({ unchanged: true, version: cur }); }
    return rawJson(await profileJson(DB, me.id));
  }
  if (path === '/sync' && M === 'PUT') {
    if (+(req.headers.get('Content-Length') || 0) > MAX_BYTES * 1.2) return err(413, 'That is more than a profile can hold (1 MB).');
    if (!(await hit('sync', me.id))) return err(429, 'That is a lot of saving for one hour. Please wait a little.');
    const text = await req.text();
    if (text.length > MAX_BYTES * 1.2) return err(413, 'That is more than a profile can hold (1 MB).');
    let b;
    try { b = JSON.parse(text); } catch { return err(400, 'That profile is not valid JSON.'); }
    try { validateIncoming(b); } catch (e) { if (e instanceof SyncError) return err(e.status, e.message); throw e; }
    const r = await saveProfile(DB, me.id, b.doc, b.stamps || {}, now, { confirmWipe: b.confirmWipe === true });
    if (!r.ok) return err(r.status, r.error, r.extra || {});
    return rawJson(await profileJson(DB, me.id, { changed: r.changed }));
  }

  return err(404, 'Not found.');
}
