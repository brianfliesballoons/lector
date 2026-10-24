// End-to-end test of lector-chat accounts in a real headless Chrome with a virtual passkey authenticator.
// Run through test/run.sh (local) or: node test/e2e.mjs remote <chat-worker dir>
// local = a throwaway copy under wrangler dev on :8787 with a test Google key; remote = the deployed Worker.
// Makes throwaway 'ZZ test' people only, deletes every row it made, never reads Brian's or MA's invites.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const MODE = process.argv[2], WDIR = process.argv[3];
const S = process.env.LECTOR_TEST_DIR || fs.mkdtempSync(os.tmpdir() + '/lector-chat-test-');
const BASE = MODE === 'local' ? 'http://localhost:8787' : 'https://lector-chat.brianfliesballoons.workers.dev';
const ADMIN = MODE === 'local' ? fs.readFileSync(S + '/local-admin-key', 'utf8').trim() : fs.readFileSync(os.homedir() + '/.config/lector-chat/admin-key', 'utf8').trim();
const PAGE_ORIGIN = 'http://localhost:8010';
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };
const tokFp = t => t ? t.slice(0, 4) + '…' : null;   // never print a whole token

// ---- server-side helpers (Node) ----
async function api(p, { method = 'GET', token, body, origin = PAGE_ORIGIN } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, headers: r.headers };
}
function sql(command) {
  const args = ['wrangler@3', 'd1', 'execute', 'lector-chat', MODE === 'local' ? '--local' : '--remote', '--json', '--command', command];
  if (MODE === 'local') args.push('--persist-to', S + '/state');
  const env = { ...process.env }; delete env.CLOUDFLARE_ACCOUNT_ID;
  const out = execFileSync('npx', args, { cwd: WDIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

// ---- the test page ----
const PAGE = `<!doctype html><meta charset=utf-8><title>t</title><script>
window.call = async (base, p, method, token, body) => {
  const h = {'Content-Type':'application/json'}; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, {method, headers: h, body: body === undefined ? undefined : JSON.stringify(body)});
  let j = null; try { j = await r.json(); } catch {} return {status: r.status, json: j};
};
window.register = async (base, token, extra) => {
  const o = await call(base, '/auth/passkey/register/options', 'POST', token, extra || {});
  if (o.status !== 200) return {step: 'options', ...o};
  let cred; try { cred = await navigator.credentials.create({publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(o.json.options)}); }
  catch (e) { return {step: 'create', error: e.name}; }
  return {step: 'verify', ...(await call(base, '/auth/passkey/register/verify', 'POST', token, {handle: o.json.handle, response: cred.toJSON()}))};
};
window.login = async (base) => {
  const o = await call(base, '/auth/passkey/login/options', 'POST', null, {});
  if (o.status !== 200) return {step: 'options', ...o};
  let cred; try { cred = await navigator.credentials.get({publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(o.json.options)}); }
  catch (e) { return {step: 'get', error: e.name}; }
  const assertion = cred.toJSON();
  return {step: 'verify', handle: o.json.handle, assertion, ...(await call(base, '/auth/passkey/login/verify', 'POST', null, {handle: o.json.handle, response: assertion}))};
};
</script>ok`;
// The page is served by Chrome itself (CDP Fetch interception of http://localhost:8010/), so nothing has to listen on
// :8010 and another local server there (the front end's) never gets in the way.

// ---- Chrome over CDP ----
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = fs.mkdtempSync(S + '/chrome-');
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
  // an intercepted page has no network address, so Chrome would treat it as public and block its calls to localhost
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch('http://127.0.0.1:9333/json/list')).json(); if (targets.find(t => t.type === 'page')) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0; const waiting = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  else if (m.method === 'Fetch.requestPaused') ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.fulfillRequest', params: { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(PAGE).toString('base64') } }));
});
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
async function page(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
await cdp('Fetch.enable', { patterns: [{ urlPattern: PAGE_ORIGIN + '/*', requestStage: 'Request' }] });
await cdp('Page.navigate', { url: PAGE_ORIGIN + '/' });
for (let i = 0; i < 50 && (await page('document.readyState').catch(() => '')) !== 'complete'; i++) await new Promise(r => setTimeout(r, 100));
await cdp('WebAuthn.enable', { enableUI: false });
const { authenticatorId: AUTH } = await cdp('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const B = JSON.stringify(BASE);
const register = (token, extra) => page(`register(${B}, ${JSON.stringify(token || null)}, ${JSON.stringify(extra || {})})`);
const login = () => page(`login(${B})`);
const call = (p, method, token, body) => page(`call(${B}, ${JSON.stringify(p)}, ${JSON.stringify(method)}, ${JSON.stringify(token || null)}, ${body === undefined ? 'undefined' : JSON.stringify(body)})`);

const created = { users: [] };
try {
  console.log(`\n== ${MODE}: ${BASE}`);
  // ---- setup: two throwaway people with throwaway invites ----
  const mk = async name => {
    const u = await api('/admin/users', { method: 'POST', token: ADMIN, body: { name, native: 'en', learning: 'es', level: 'elementary' } });
    created.users.push(u.json.user.id);
    const i = await api('/admin/invites', { method: 'POST', token: ADMIN, body: { user: u.json.user.id, label: 'e2e test' } });
    return { id: u.json.user.id, invite: i.json.token };
  };
  const A = await mk('ZZ test A'), T2 = await mk('ZZ test B');

  console.log('-- config, legacy invite');
  const cfg = await call('/auth/config', 'GET');
  ok(cfg.status === 200 && cfg.json.passkeyRpId === 'localhost', 'GET /auth/config gives this origin\'s passkey RP id', cfg);
  ok((await api('/me', { token: T2.invite })).status === 200, 'a legacy invite token still signs in (GET /me)');
  const acc0 = await api('/account', { token: A.invite });
  ok(acc0.status === 200 && acc0.json.signIn.invites === 1 && acc0.json.signIn.passkeys === 0 && acc0.json.current.kind === 'invite', 'GET /account shows the invite as the only way in', acc0.json);

  console.log('-- add a passkey to an invited person (upgrade)');
  const reg = await register(A.invite);
  ok(reg.step === 'verify' && reg.status === 201 && reg.json.created === false && reg.json.user.id === A.id, 'passkey registered to the SAME user', reg);
  ok(reg.json && reg.json.session && reg.json.session.token && reg.json.invitesRevoked === 1, 'the upgrade returns a session and retires the invite');
  const S1 = reg.json.session.token;
  ok((await api('/me', { token: A.invite })).status === 401, 'the retired invite no longer signs in');
  const me1 = await api('/me', { token: S1 });
  ok(me1.status === 200 && me1.json.user.id === A.id, 'the session signs in as the same person');
  const dup = await register(S1);
  ok(dup.step === 'create' && dup.error === 'InvalidStateError', 'a second passkey on the same device is refused (excludeCredentials)', dup);

  console.log('-- sign in with the passkey');
  const li = await login();
  ok(li.step === 'verify' && li.status === 200 && li.json.user.id === A.id && li.json.session.token, 'passkey sign-in returns a session for the right person', { ...li, assertion: undefined });
  const S2 = li.json.session.token;
  const replay = await api('/auth/passkey/login/verify', { method: 'POST', body: { handle: li.handle, response: li.assertion } });
  ok(replay.status === 400, 'replaying the same sign-in is refused (challenge used up)', replay.json);
  const fresh = await api('/auth/passkey/login/options', { method: 'POST', body: {} });
  const replay2 = await api('/auth/passkey/login/verify', { method: 'POST', body: { handle: fresh.json.handle, response: li.assertion } });
  ok(replay2.status === 401, 'an old signature against a new challenge is refused', replay2.json);
  const prev = await api('/auth/passkey/login/options', { method: 'POST', body: {}, origin: 'https://lector-preview.pages.dev' });
  ok(prev.status === 200 && prev.json.options.rpId === 'lector-preview.pages.dev', 'the preview origin gets RP id lector-preview.pages.dev', prev.json);
  const cross = await api('/auth/passkey/login/verify', { method: 'POST', body: { handle: prev.json.handle, response: li.assertion }, origin: 'https://lector-preview.pages.dev' });
  ok(cross.status === 401 && /not registered for this site/.test(cross.json.error), 'a passkey made for one RP id does not sign in on another', cross.json);
  const fresh2 = await api('/auth/passkey/login/options', { method: 'POST', body: {} });
  const wrongOrigin = await api('/auth/passkey/login/verify', { method: 'POST', body: { handle: fresh2.json.handle, response: li.assertion }, origin: 'https://lector-preview.pages.dev' });
  ok(wrongOrigin.status === 400, 'finishing a sign-in from a different origin than it started is refused', wrongOrigin.json);
  const live = await api('/auth/passkey/register/options', { method: 'POST', body: {}, token: S1, origin: 'https://brianfliesballoons.github.io' });
  ok(live.status === 200 && live.json.options.rp.id === 'brianfliesballoons.github.io', 'the live origin gets RP id brianfliesballoons.github.io');
  const evil = await api('/auth/passkey/login/options', { method: 'POST', body: {}, origin: 'https://evil.example' });
  ok(evil.status === 400 && !evil.headers.get('access-control-allow-origin'), 'an unknown origin gets no options and no CORS header', evil.json);

  console.log('-- sessions, sign out, last-method guard');
  const ss = await api('/auth/sessions', { token: S1 });
  const s2row = ss.json.sessions.find(s => !s.current);
  ok(ss.status === 200 && ss.json.sessions.length === 2 && ss.json.sessions.some(s => s.current), 'GET /auth/sessions lists both sessions and marks this one', ss.json);
  ok((await api('/auth/sessions/' + s2row.id, { method: 'DELETE', token: S1 })).status === 200 && (await api('/me', { token: S2 })).status === 401, 'revoking the other session signs it out');
  ok((await api('/auth/signout', { method: 'POST', token: S1 })).status === 200 && (await api('/me', { token: S1 })).status === 401, 'sign out ends this session');
  const S3 = (await login()).json.session.token;
  const pks = await api('/auth/passkeys', { token: S3 });
  ok(pks.status === 200 && pks.json.passkeys.length === 1 && pks.json.passkeys[0].thisSite === true, 'GET /auth/passkeys lists it, marked as this site\'s', pks.json);
  const lastDel = await api('/auth/passkeys/' + pks.json.passkeys[0].id, { method: 'DELETE', token: S3 });
  ok(lastDel.status === 409, 'removing the only way to sign in is refused', lastDel.json);
  ok((await api('/auth/signout', { method: 'POST', token: S2 })).status === 401, 'a revoked session cannot call anything');

  console.log('-- expiry and sliding');
  const s3id = (await api('/auth/sessions', { token: S3 })).json.sessions.find(s => s.current).id;
  sql(`UPDATE credentials SET expires = ${Date.now() - 1000} WHERE id = '${s3id}'`);
  ok((await api('/me', { token: S3 })).status === 401, 'an expired session is refused');
  const S4 = (await login()).json.session.token;
  const s4id = (await api('/auth/sessions', { token: S4 })).json.sessions.find(s => s.current).id;
  sql(`UPDATE credentials SET expires = ${Date.now() + 30 * 864e5} WHERE id = '${s4id}'`);
  const slid = await api('/account', { token: S4 });
  ok(slid.status === 200 && slid.json.current.expires > Date.now() + 59 * 864e5, 'using a session slides its expiry forward to 60 days', slid.json.current);
  const row4 = sql(`SELECT expires FROM credentials WHERE id = '${s4id}'`)[0];
  ok(row4.expires > Date.now() + 59 * 864e5, 'the slide is saved in D1');

  console.log('-- profile sync');
  const S5 = (await login()).json.session.token;   // a second "device"
  ok((await api('/sync', { token: S4 })).json.version === 0, 'a new profile starts empty');
  let p = await api('/sync', { method: 'PUT', token: S4, body: { doc: { settings: { theme: 'dark', size: 18 } }, stamps: { settings: Date.now() - 5000 } } });
  ok(p.status === 200 && p.json.version === 1 && p.json.changed[0] === 'settings', 'PUT /sync saves a key', p.json);
  p = await api('/sync', { method: 'PUT', token: S5, body: { doc: { settings: { theme: 'light' } }, stamps: { settings: Date.now() - 9000 } } });
  ok(p.json.doc.settings.theme === 'dark' && p.json.changed.length === 0, 'an older change from another device loses');
  p = await api('/sync', { method: 'PUT', token: S5, body: { doc: { settings: { theme: 'sepia' } }, stamps: { settings: Date.now() } } });
  ok(p.json.doc.settings.theme === 'sepia', 'a newer change from another device wins');
  await api('/sync', { method: 'PUT', token: S4, body: { doc: { words: { 'es:hola': { t: 100, w: 'hola', card: { due: 1 } }, 'es:casa': { t: 100, w: 'casa', card: { due: 1 } } } }, stamps: { words: 100 } } });
  await Promise.all([
    api('/sync', { method: 'PUT', token: S4, body: { doc: { words: { 'es:hola': { t: 200, w: 'hola', card: { due: 2 } } } }, stamps: { words: 200 } } }),
    api('/sync', { method: 'PUT', token: S5, body: { doc: { words: { 'es:casa': { t: 150, w: 'casa', card: { due: 3 } } } }, stamps: { words: 150 } } }),
  ]);
  let g = await api('/sync', { token: S5 });
  ok(g.json.doc.words['es:hola'].card.due === 2 && g.json.doc.words['es:casa'].card.due === 3, 'two devices reviewing different words at once: both reviews kept', g.json.doc.words);
  const keys = [...Array(8)].map((_, i) => 'k' + i);
  const res = await Promise.all(keys.map((k, i) => api('/sync', { method: 'PUT', token: i % 2 ? S4 : S5, body: { doc: { [k]: i }, stamps: { [k]: Date.now() } } })));
  g = await api('/sync', { token: S4 });
  ok(res.every(r => r.status === 200) && keys.every((k, i) => g.json.doc[k] === i), '8 simultaneous writes from two devices: none lost', res.map(r => r.status));
  ok((await api('/sync?version=' + g.json.version, { token: S4 })).json.unchanged === true, 'GET /sync?version= answers "unchanged" cheaply');
  const big = await api('/sync', { method: 'PUT', token: S4, body: { doc: { blob: 'x'.repeat(1_050_000) } } });
  ok(big.status === 413, 'a profile over 1 MB is refused', big.json);
  ok((await api('/sync', { method: 'PUT', token: S4, body: { doc: { 'bad key': 1 } } })).status === 400, 'a bad key name is refused');
  ok((await api('/sync', { token: A.invite })).status === 401, 'the retired invite cannot read the profile');
  const other = await api('/sync', { token: T2.invite });
  ok(other.status === 200 && other.json.version === 0, 'another person sees only their own (empty) profile');

  console.log('-- a brand-new account by passkey');
  await cdp('WebAuthn.clearCredentials', { authenticatorId: AUTH });
  const su = await register(null, { name: 'ZZ test signup' });
  ok(su.step === 'verify' && su.status === 201 && su.json.created === true && su.json.session.token, 'sign-up with a passkey creates a person and a session', su);
  if (su.json && su.json.user) created.users.push(su.json.user.id);
  const su2 = await login();
  ok(su2.status === 200 && su2.json.user.id === su.json.user.id, 'the new person signs in with that passkey', { ...su2, assertion: undefined });
  const bad = await register('x'.repeat(43), {});
  ok(bad.step === 'options' && bad.status === 401, 'a dead token never silently becomes a new account');

  console.log('-- Google');
  if (MODE === 'remote') {
    const n = await api('/auth/google/nonce', { method: 'POST', body: {} });
    ok(n.status === 503 && n.json.notConfigured === true, 'Google sign-in says "not set up yet" until GOOGLE_CLIENT_ID is set', n.json);
    ok((await api('/auth/config')).json.google.configured === false, '/auth/config reports Google not configured');
  } else {
    const { signToken } = await import(new URL('./gtoken.mjs', import.meta.url));
    const nonce = async () => (await api('/auth/google/nonce', { method: 'POST', body: {} })).json.nonce;
    const t1 = await signToken({ sub: 'g-sub-1', email: 'zz1@example.com', nonce: await nonce(), name: 'ZZ test google' });
    const g1 = await api('/auth/google', { method: 'POST', body: { credential: t1 } });
    ok(g1.status === 201 && g1.json.created === true && g1.json.session.token, 'first Google sign-in makes an account', g1.json);
    created.users.push(g1.json.user.id);
    ok((await api('/auth/google', { method: 'POST', body: { credential: t1 } })).status === 401, 'the same Google token cannot be used twice (nonce)');
    const g1b = await api('/auth/google', { method: 'POST', body: { credential: await signToken({ sub: 'g-sub-1', email: 'zz1@example.com', nonce: await nonce() }) } });
    ok(g1b.status === 200 && g1b.json.user.id === g1.json.user.id && g1b.json.created === false, 'signing in again with Google finds the same account');
    const lk = await api('/auth/google/link', { method: 'POST', token: T2.invite, body: { credential: await signToken({ sub: 'g-sub-2', email: 'zz2@example.com', nonce: await nonce() }) } });
    ok(lk.status === 200 && lk.json.linked && lk.json.invitesRevoked === 1 && lk.json.session.token, 'an invited person adds Google: linked, invite retired, session returned', lk.json);
    ok((await api('/me', { token: T2.invite })).status === 401 && (await api('/me', { token: lk.json.session.token })).json.user.id === T2.id, 'their invite stops; the new session is the same person');
    const lk2 = await api('/auth/google/link', { method: 'POST', token: g1b.json.session.token, body: { credential: await signToken({ sub: 'g-sub-2', email: 'zz2@example.com', nonce: await nonce() }) } });
    ok(lk2.status === 409, 'a Google account already linked elsewhere cannot be linked again', lk2.json);
    const same = await api('/auth/google', { method: 'POST', body: { credential: await signToken({ sub: 'g-sub-3', email: 'zz2@example.com', nonce: await nonce() }) } });
    ok(same.status === 409, 'a different Google account with an existing email is NOT silently linked', same.json);
    ok((await api('/auth/google', { method: 'POST', token: lk.json.session.token, body: { credential: await signToken({ sub: 'g-sub-2', nonce: await nonce() }) } })).status === 409, 'Google sign-in while already signed in points to "Add Google" instead');
    ok((await api('/auth/google', { method: 'POST', body: { credential: await signToken({ sub: 'g-sub-9' }) } })).status === 401, 'a token without our one-time nonce is refused');
    ok((await api('/auth/google', { method: 'POST', body: { credential: await signToken({ sub: 'g-sub-9', nonce: await nonce(), aud: 'other-app' }) } })).status === 401, 'a token for a different client id is refused');
    ok((await api('/auth/google', { method: 'POST', body: { credential: await signToken({ sub: 'g-sub-9', nonce: await nonce(), email_verified: false }) } })).status === 401, 'an unverified Google email is refused');
    ok((await api('/auth/google', { method: 'DELETE', token: g1b.json.session.token })).status === 409, 'removing Google when it is the only way in is refused');
  }

  console.log('-- rate limit (last: it blocks this address for 10 minutes)');
  let limited = false;
  for (let i = 0; i < 70 && !limited; i++) limited = (await api('/auth/passkey/login/options', { method: 'POST', body: {} })).status === 429;
  ok(limited, 'auth endpoints answer 429 after 60 calls in 10 minutes from one address');
} catch (e) { fail++; console.log('  ERROR', e.stack || e); }
finally {
  // ---- cleanup: every row the test made ----
  try {
    const ids = created.users.map(u => `'${u}'`).join(',');
    if (ids) sql(`DELETE FROM passkeys WHERE user_id IN (${ids}); DELETE FROM profile_items WHERE user_id IN (${ids}); DELETE FROM profiles WHERE user_id IN (${ids}); DELETE FROM credentials WHERE user_id IN (${ids}); DELETE FROM uses WHERE user_id IN (${ids}); DELETE FROM reports WHERE user_id IN (${ids}); DELETE FROM users WHERE id IN (${ids}); DELETE FROM challenges; DELETE FROM rate;`);
    const left = sql(`SELECT (SELECT COUNT(*) FROM users WHERE name LIKE 'ZZ test%') u, (SELECT COUNT(*) FROM passkeys) p, (SELECT COUNT(*) FROM profiles) pr, (SELECT COUNT(*) FROM credentials WHERE kind = 'session') s`)[0];
    console.log('cleanup: left behind', JSON.stringify(left));
  } catch (e) { console.log('cleanup failed', String(e).slice(0, 300)); fail++; }
  ws.close(); chrome.kill(); await new Promise(r => chrome.once('exit', r)); try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  console.log(`\n${MODE}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
