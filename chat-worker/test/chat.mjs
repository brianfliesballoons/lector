// Messages hardening, LOCAL ONLY, against a throwaway copy started with AI_FORCE_BAD=1 (test/run.sh does this on :8788):
// every model "call" is simulated as an invalid reply that costs 1 neuron, so no real AI allowance is spent.
//   S1    a translation that keeps failing is tried 3 times with backoff, then marked failed; POST /messages/:id/retranslate
//   S3-9  each person's share of the day (translation charged to the sender), the global caps still apply
//   S3-10 invites expire (14 days by default), the admin can list and re-mint them
// Run: node test/chat.mjs <test dir> <worker copy dir>   (test dir holds local-admin-key and the D1 state for :8788)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = process.argv[2], WDIR = process.argv[3];
const BASE = 'http://localhost:8788';
const ADMIN = fs.readFileSync(T + '/local-admin-key', 'utf8').trim();
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:8010' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const go = () => fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  // wrangler dev drops idle keep-alive sockets while the slow `wrangler d1 execute` checks run; retry once on a fresh one
  const r = await go().catch(e => { if (e.cause && e.cause.code === 'UND_ERR_SOCKET') return go(); throw e; });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
function sql(command) {
  const env = { ...process.env }; delete env.CLOUDFLARE_ACCOUNT_ID;
  const out = execFileSync('npx', ['wrangler@3', 'd1', 'execute', 'lector-chat', '--local', '--json', '--persist-to', T + '/state-bad', '--command', command], { cwd: WDIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
const calls = () => (sql('SELECT calls FROM ai_usage')[0] || { calls: 0 }).calls;
const person = id => sql(`SELECT neurons, extra FROM ai_person WHERE user_id = '${id}'`)[0] || { neurons: 0, extra: 0 };
const row = id => sql(`SELECT pending, tries, next_try, failed, claimed FROM messages WHERE id = ${id}`)[0];

try {
  console.log(`\n== messages hardening (local, AI_FORCE_BAD): ${BASE}`);
  const mk = async (name, native, learning) => {
    const u = await api('/admin/users', { method: 'POST', token: ADMIN, body: { name, native, learning, level: 'elementary' } });
    const i = await api('/admin/invites', { method: 'POST', token: ADMIN, body: { user: u.json.user.id, label: 'chat test' } });
    return { id: u.json.user.id, tok: i.json.token, inv: i.json };
  };
  const A = await mk('ZZ test A', 'en', 'es'), B = await mk('ZZ test B', 'es', 'en'), C = await mk('ZZ test C', 'es', 'en');
  const th = (await api('/admin/threads', { method: 'POST', token: ADMIN, body: { title: 'ZZ test', members: [A.id, B.id] } })).json.thread.id;

  console.log('-- S1: tries, backoff, give up');
  const c0 = calls();
  const s = await api('/messages', { method: 'POST', token: A.tok, body: { thread: th, text: 'How do you say shed in Spanish? I am building one for the dog 🐶' } });
  const id = s.json.message.id;
  let r = row(id);
  ok(s.status === 201 && s.json.message.translationPending && r.tries === 1 && r.next_try > Date.now() + 30e3 && calls() - c0 === 2, 'the send is saved; its failed try (2 model calls) counts 1 and backs off a minute', { r, calls: calls() - c0 });
  for (let i = 0; i < 4; i++) { await api(`/messages?thread=${th}&since=0`, { token: B.tok }); await sleep(250); }
  await sleep(800);
  ok(calls() - c0 === 2 && row(id).tries === 1, 'polling during the backoff calls the model 0 times (it used to retry on every poll)', calls() - c0);
  sql(`UPDATE messages SET next_try = ${Date.now() - 1} WHERE id = ${id}`);
  await api(`/messages?thread=${th}&since=0`, { token: B.tok }); await sleep(1500);
  r = row(id);
  ok(r.tries === 2 && r.pending === 1 && r.next_try > Date.now() + 200e3 && calls() - c0 === 4, 'after the backoff a poll tries once more, then backs off 5 minutes', { r, calls: calls() - c0 });
  sql(`UPDATE messages SET next_try = ${Date.now() - 1} WHERE id = ${id}`);
  await api(`/messages?thread=${th}&since=0`, { token: B.tok }); await sleep(1500);
  r = row(id);
  ok(r.tries === 3 && r.pending === 0 && r.failed === 'model' && calls() - c0 === 6, 'the third failed try gives up: pending 0, failed "model"', { r, calls: calls() - c0 });
  for (let i = 0; i < 5; i++) { await api(`/messages?thread=${th}&since=0`, { token: B.tok }); await sleep(200); }
  await sleep(800);
  ok(calls() - c0 === 6, 'after giving up, polling never calls the model again (6 calls in all, ~6 neurons a day at most per bad message)');
  const g = await api(`/messages?thread=${th}&since=0`, { token: B.tok });
  const gm = g.json.messages.find(m => m.id === id);
  ok(gm.translationFailed === true && gm.translationError === 'model' && !gm.translationPending && gm.text.startsWith('How do'), 'the poll shows translationFailed (the app: "Couldn\'t translate · Retry"), with the original text', gm);
  const since = await api(`/messages?thread=${th}&since=${s.json.message.seq}`, { token: A.tok });
  ok(since.json.messages.some(m => m.id === id && m.translationFailed), 'a since= poll picks up the change to failed (seq moved)');

  console.log('-- S1: the manual retry');
  const pa = person(A.id).neurons, pb = person(B.id).neurons;
  r = await api(`/messages/${id}/retranslate`, { method: 'POST', token: B.tok });
  ok(r.status === 200 && r.json.message.translationFailed && calls() - c0 === 8 && row(id).failed === 'model', 'the reader can retry: one try (2 calls); it fails again here, so it goes straight back to failed', { s: r.status, j: r.json, calls: calls() - c0 });
  ok(person(A.id).neurons - pa === 2 && person(B.id).neurons === pb, 'the retry is charged to the SENDER (A), not to the reader who asked (B)', { A: person(A.id), B: person(B.id) });
  ok((await api(`/messages/${id}/retranslate`, { method: 'POST', token: C.tok })).status === 404, 'someone outside the conversation cannot retry it (404)');
  sql(`INSERT INTO messages(thread_id, user_id, text, lang, base, versions, pending, created, seq) VALUES('${th}', '${B.id}', 'Hola', 'es', 'es', '{"es":"Hola","en":"Hello"}', 0, ${Date.now()}, 0)`);
  const okId = sql(`SELECT MAX(id) id FROM messages`)[0].id;
  const c1 = calls();
  r = await api(`/messages/${okId}/retranslate`, { method: 'POST', token: A.tok });
  ok(r.status === 200 && r.json.note === 'Already translated.' && calls() === c1, 'a translated message is not re-translated (no model call)', r.json);
  sql(`INSERT INTO uses(user_id, kind, day, n) VALUES('${B.id}', 'retranslate', '${new Date().toISOString().slice(0, 10)}', 30) ON CONFLICT(user_id, kind, day) DO UPDATE SET n = 30`);
  r = await api(`/messages/${id}/retranslate`, { method: 'POST', token: B.tok });
  ok(r.status === 429 && calls() === c1, 'retries are rate-limited (30 a day per person)', r.json);

  console.log('-- S3-9: each person\'s share');
  const day = new Date().toISOString().slice(0, 10);
  sql(`INSERT INTO ai_person(day, user_id, neurons, extra, calls) VALUES('${day}', '${A.id}', 4500, 0, 1) ON CONFLICT(day, user_id) DO UPDATE SET neurons = 4500`);
  const c2 = calls();
  const s2 = await api('/messages', { method: 'POST', token: A.tok, body: { thread: th, text: 'Another one' } });
  const r2 = row(s2.json.message.id);
  ok(s2.status === 201 && s2.json.message.translationPending && r2.tries === 0 && calls() === c2, 'A over their half: the message is saved and waits; no model call, and it is not counted as a failed try', { r2 });
  const ca = await api('/check', { method: 'POST', token: A.tok, body: { thread: th, text: 'Hola amigo' } });
  ok(ca.json.unavailable && ca.json.reason === 'person' && /share/.test(ca.json.note) && calls() === c2, 'A\'s check: unavailable, reason "person"', ca.json);
  const cb = await api('/check', { method: 'POST', token: B.tok, body: { thread: th, text: 'Hello friend' } });
  ok(cb.json.unavailable && cb.json.reason === 'failed' && calls() > c2, 'B is not blocked by A\'s use: B\'s check reaches the model (which, in this test copy, always fails)', cb.json);
  ok((await api('/me', { token: A.tok })).json.ai.available === false && (await api('/me', { token: B.tok })).json.ai.available === true, '/me: A\'s AI is resting, B\'s is available');
  sql(`UPDATE ai_person SET neurons = 0, extra = 3500 WHERE user_id = '${A.id}'`);
  const me2 = (await api('/me', { token: A.tok })).json.ai;
  ok(me2.available === true && me2.extrasAvailable === false, 'the extras share (3,500) stops checks and helpers but leaves translation of A\'s messages', me2);
  sql(`UPDATE ai_usage SET neurons = 9000`);
  const cg = await api('/check', { method: 'POST', token: B.tok, body: { thread: th, text: 'Hello friend' } });
  ok(cg.json.unavailable && cg.json.reason === 'budget', 'the global caps still apply to everyone (reason "budget")', cg.json);
  sql(`UPDATE ai_usage SET neurons = 0`);
  const us = (await api('/admin/usage', { token: ADMIN })).json;
  ok(us.perPerson.total === 4500 && us.perPerson.extras === 3500 && us.people.some(p => p.user_id === A.id), 'GET /admin/usage shows the per-person shares and today\'s spend per person', us.perPerson);

  console.log('-- S3-10: invites expire');
  ok(A.inv.expires > Date.now() + 13.9 * 864e5 && A.inv.expires < Date.now() + 14.1 * 864e5, 'a new invite expires in 14 days', A.inv.expires);
  const li = (await api('/admin/invites', { token: ADMIN })).json.invites;
  ok(li.length >= 3 && li.every(x => !('hash' in x) && !('token' in x)) && li.find(x => x.user_id === A.id).live === true, 'GET /admin/invites lists them (no hashes, no tokens) with live/expiry', li[0]);
  ok((await api('/admin/invites', { method: 'POST', token: ADMIN, body: { user: A.id, days: 0 } })).status === 400 && (await api('/admin/invites', { method: 'POST', token: ADMIN, body: { user: A.id, days: 91 } })).status === 400, 'days must be 1 to 90');
  sql(`UPDATE credentials SET expires = ${Date.now() - 1000} WHERE id = '${C.inv.credential}'`);
  const ex = await api('/me', { token: C.tok });
  ok(ex.status === 401 && ex.json.inviteExpired === true && /expired/.test(ex.json.error), 'an expired invite gets 401 "This invite link has expired"', ex.json);
  const rm = await api('/admin/invites/remint', { method: 'POST', token: ADMIN, body: { user: C.id, label: 'again', days: 3 } });
  ok(rm.status === 200 && rm.json.revoked === 1 && rm.json.expires < Date.now() + 3.1 * 864e5 && (await api('/me', { token: rm.json.token })).status === 200, 're-mint: the old one is revoked, the new one works (3 days here)', { ...rm.json, token: undefined, link: undefined });
  ok((await api('/me', { token: C.tok })).status === 401, 'the old invite stays dead');
} catch (e) { fail++; console.log('  ERROR', e.stack || e, e.cause || ''); }
console.log(`\nmessages (local) : ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
