// Profile sync (PUT/GET /sync) end to end: the merge rules as D1 now runs them, type checks, the wipe guard,
// the size cap and person-to-person isolation. No AI is used.
// Run through test/run.sh, or: node test/sync.mjs remote <chat-worker dir>
// Makes throwaway 'ZZ test sync' people only and deletes every row it made. Never prints a token.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
const MODE = process.argv[2], WDIR = process.argv[3];
const S = process.env.LECTOR_TEST_DIR || '';
const BASE = MODE === 'local' ? 'http://localhost:8787' : 'https://lector-chat.brianfliesballoons.workers.dev';
const ADMIN = MODE === 'local' ? fs.readFileSync(S + '/local-admin-key', 'utf8').trim() : fs.readFileSync(os.homedir() + '/.config/lector-chat/admin-key', 'utf8').trim();
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };
async function api(p, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:8010' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
function sql(command) {
  const args = ['wrangler@3', 'd1', 'execute', 'lector-chat', MODE === 'local' ? '--local' : '--remote', '--json', '--command', command];
  if (MODE === 'local') args.push('--persist-to', S + '/state');
  const env = { ...process.env }; delete env.CLOUDFLARE_ACCOUNT_ID;
  const run = () => execFileSync('npx', args, { cwd: WDIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let out; try { out = run(); } catch { out = run(); }   // a remote call now and then fails once for no reason of ours
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
const put = (tok, doc, stamps, extra = {}) => api('/sync', { method: 'PUT', token: tok, body: { doc, stamps, ...extra } });

const created = [];
try {
  console.log(`\n== sync, ${MODE}: ${BASE}`);
  const mk = async name => {
    const u = await api('/admin/users', { method: 'POST', token: ADMIN, body: { name, native: 'en', learning: 'es', level: 'elementary' } });
    created.push(u.json.user.id);
    return (await api('/admin/invites', { method: 'POST', token: ADMIN, body: { user: u.json.user.id, label: 'sync test' } })).json.token;
  };
  const A = await mk('ZZ test sync A'), B = await mk('ZZ test sync B');

  console.log('-- whole keys: last writer wins');
  let r = await put(A, { settings: { theme: 'dark' } }, { settings: 100 });
  ok(r.status === 200 && r.json.doc.settings.theme === 'dark' && r.json.stamps.settings === 100 && r.json.version === 1 && r.json.changed.join() === 'settings', 'first write', r.json);
  r = await put(A, { settings: { theme: 'light' } }, { settings: 50 });
  ok(r.json.doc.settings.theme === 'dark' && r.json.changed.length === 0 && r.json.version === 1, 'an older stamp loses (and the version does not move)', r.json);
  r = await put(A, { settings: { theme: 'light' } }, { settings: 100 });
  ok(r.json.doc.settings.theme === 'dark' && r.json.version === 1, 'an equal stamp keeps what is stored (a retried PUT changes nothing)');
  r = await put(A, { settings: { theme: 'light' } }, { settings: 200 });
  ok(r.json.doc.settings.theme === 'light' && r.json.version === 2, 'a newer stamp wins');
  r = await put(A, { settings: { theme: 'sepia' } }, { settings: 9e15 });
  const clamped = r.json.stamps.settings;
  ok(r.json.doc.settings.theme === 'sepia' && clamped <= Date.now() + 1000 && clamped > Date.now() - 60000, 'a future stamp is pulled back to now', r.json.stamps);
  r = await put(A, { other: [1, 2, 3], flag: true, n: 2.5, s: 'text', z: null }, {});
  ok(JSON.stringify(r.json.doc.other) === '[1,2,3]' && r.json.doc.flag === true && r.json.doc.n === 2.5 && r.json.doc.s === 'text' && r.json.doc.z === null, 'other value types round-trip exactly', r.json.doc);

  console.log('-- entry maps: merged entry by entry');
  r = await put(A, { words: { 'es:hola': { t: 10, w: 'hola', card: 1 }, 'es:casa': { t: 10, w: 'casa', card: 1 } } }, { words: 10 });
  ok(r.json.changed.join() === 'words' && Object.keys(r.json.doc.words).length === 2, 'a new map is stored');
  r = await put(A, { words: { 'es:hola': { t: 20, w: 'hola', card: 2 } } }, { words: 20 });             // phone
  r = await put(A, { words: { 'es:casa': { t: 15, w: 'casa', card: 3 }, 'es:hola': { t: 12, w: 'hola', card: 9 } } }, { words: 15 });   // tablet, older
  ok(r.json.doc.words['es:hola'].card === 2 && r.json.doc.words['es:casa'].card === 3, 'two devices\' reviews are both kept; each entry wins on its own t', r.json.doc.words);
  r = await put(A, { words: { 'es:hola': { t: 20, w: 'hola', card: 7 } } }, { words: 99 });
  ok(r.json.doc.words['es:hola'].card === 2 && r.json.changed.length === 0, 'an entry with an equal t keeps what is stored');
  r = await put(A, { words: { 'es:pan': { w: 'pan' } } }, { words: 30 });
  ok(r.json.doc.words['es:pan'] && !('t' in r.json.doc.words['es:pan']), 'an entry without t takes its key stamp and is stored as sent');
  r = await put(A, { words: { 'es:pan': { w: 'pan', card: 5 } } }, { words: 31 });
  ok(r.json.doc.words['es:pan'].card === 5, '…and a later one without t (newer key stamp) replaces it');
  r = await put(A, { words: { 'es:sol': { t: 9e15, w: 'sol' } } }, { words: 32 });
  ok(r.json.doc.words['es:sol'].t <= Date.now() + 1000, 'an entry from the future is stored with t = now');
  r = await put(A, { words: { 'es:casa': { t: 40, deleted: true } } }, { words: 40 });
  ok(r.json.doc.words['es:casa'].deleted === true && r.json.doc.words['es:hola'].card === 2, 'a tombstone deletes one entry and keeps the rest');
  r = await put(A, { words: {} }, { words: 41 });
  ok(Object.keys(r.json.doc.words).length === 4, 'an empty map changes nothing (absence is not deletion)');
  r = await put(A, { words: null }, { words: 100 });
  ok(r.json.doc.words === null, 'null clears a small map (at most 20 entries, no confirmation needed)', r.json.doc.words);
  r = await put(A, { words: { 'es:pan': { t: 51, w: 'pan' } } }, { words: 101 });
  ok(r.json.doc.words['es:pan'] && !r.json.doc.words['es:hola'], 'after a clear, a newer map starts it again');

  console.log('-- types and shapes (S3-8)');
  const before = (await api('/sync', { token: A })).json;
  for (const [doc, what] of [[{ words: [] }, 'PUT {doc:{words:[]}} (the reviewer\'s wipe)'], [{ words: 'x' }, 'words as text'], [{ srs: [1] }, 'srs as a list'],
    [{ notes: 5 }, 'notes as a number'], [{ words: { 'es:x': 'hola' } }, 'a word that is not an object'], [{ words: { 'es:x': { t: 1 } } }, 'a word without w'],
    [{ srs: { 'es:x': { t: 1, due: 'soon' } } }, 'an srs entry with a text due'], [{ settings: [] }, 'settings as a list'], [{ library: [] }, 'library as a list']]) {
    const x = await put(A, doc, { [Object.keys(doc)[0]]: Date.now() });
    ok(x.status === 400 && x.json && x.json.error, `400 for ${what}`, x.json);
  }
  ok((await put(A, { words: {} }, { words: 'now' })).status === 400, '400 for a stamp that is not a number');
  const after = (await api('/sync', { token: A })).json;
  ok(after.version === before.version && JSON.stringify(after.doc) === JSON.stringify(before.doc), 'none of the bad PUTs changed anything');

  console.log('-- the wipe guard');
  const many = Object.fromEntries([...Array(30)].map((_, i) => ['es:w' + i, { t: 100 + i, w: 'w' + i }]));
  r = await put(A, { words: many }, { words: 60 });
  ok(Object.keys(r.json.doc.words).length === 31, '31 words stored');
  r = await put(A, { words: null }, { words: Date.now() });
  ok(r.status === 409 && r.json.needsConfirm === true && r.json.removing === 31 && r.json.key === 'words', 'clearing 31 words at once is refused with 409 needsConfirm', r.json);
  ok(Object.keys((await api('/sync', { token: A })).json.doc.words).length === 31, '…and nothing was removed');
  r = await put(A, { words: null }, { words: Date.now() }, { confirmWipe: true });
  ok(r.status === 200 && r.json.doc.words === null, 'with confirmWipe: true it goes through');
  const bigSettings = Object.fromEntries([...Array(25)].map((_, i) => ['s' + i, i]));
  r = await put(A, { settings: bigSettings }, { settings: Date.now() });
  ok(r.status === 200 && Object.keys(r.json.doc.settings).length === 25, 'settings with 25 fields stored');
  await new Promise(x => setTimeout(x, 20));
  r = await put(A, { settings: { s0: 1 } }, { settings: Date.now() });
  ok(r.status === 409 && r.json.removing === 24, 'replacing an object key that drops 24 of its fields is refused too', r.json);
  await new Promise(x => setTimeout(x, 20));
  r = await put(A, { settings: { ...bigSettings, s0: 'x' } }, { settings: Date.now() });
  ok(r.status === 200 && r.json.doc.settings.s0 === 'x', 'an ordinary settings change is not affected');

  console.log('-- size, versions, isolation');
  const big = await api('/sync', { method: 'PUT', token: A, body: { doc: { blob: 'x'.repeat(1_050_000) } } });
  ok(big.status === 413, 'a profile over 1 MB is refused (413), and rolled back whole', big.json);
  const v = (await api('/sync', { token: A })).json;
  ok(!('blob' in v.doc) && v.bytes < 10000, '…nothing of it was stored', { bytes: v.bytes });
  ok((await api('/sync?version=' + v.version, { token: A })).json.unchanged === true, 'GET /sync?version= answers "unchanged" cheaply');
  ok((await api('/sync', { token: B })).json.version === 0 && JSON.stringify((await api('/sync', { token: B })).json.doc) === '{}', 'another person sees only their own (empty) profile');
  const keys = [...Array(8)].map((_, i) => 'k' + i);
  const res = await Promise.all(keys.map((k, i) => put(A, { [k]: i }, { [k]: Date.now() })));   // 8 different keys at once
  const g = (await api('/sync', { token: A })).json;
  ok(res.every(x => x.status === 200) && keys.every((k, i) => g.doc[k] === i), '8 simultaneous writes: none lost', res.map(x => x.status));
  await Promise.all([
    put(A, { words: { 'es:uno': { t: 200, w: 'uno' } } }, { words: Date.now() }),
    put(A, { words: { 'es:dos': { t: 200, w: 'dos' } } }, { words: Date.now() }),
    put(A, { srs: { 'es:uno': { t: 200, due: 1, reps: 1 } } }, { srs: Date.now() }),
  ]);
  const t0 = Date.now() - 60000, order = [3, 0, 5, 1, 4, 2];
  const race = await Promise.all(order.map(i => put(A, { race: { from: i } }, { race: t0 + i * 1000 })));
  const gr = (await api('/sync', { token: A })).json;
  ok(race.every(x => x.status === 200) && gr.doc.race.from === 5 && gr.stamps.race === t0 + 5000, '6 simultaneous writes to ONE key, arriving in any order: the newest stamp wins', { st: race.map(x => x.status), race: gr.doc.race });
  const burst = await Promise.all([...Array(20)].map((_, i) => put(A, { words: { ['es:b' + i]: { t: 300 + i, w: 'b' + i } } }, { words: Date.now() })));
  const gb = (await api('/sync', { token: A })).json;
  ok(burst.every(x => x.status === 200) && [...Array(20)].every((_, i) => gb.doc.words['es:b' + i]), '20 simultaneous one-word writes into the same map: all 20 kept', burst.map(x => x.status));
  const g2 = (await api('/sync', { token: A })).json;
  ok(g2.doc.words['es:uno'] && g2.doc.words['es:dos'] && g2.doc.srs['es:uno'], 'simultaneous entry writes to the same map: both kept', g2.doc);
  const rowBytes = sql(`SELECT bytes FROM profiles WHERE user_id = '${created[0]}'`)[0].bytes, real = JSON.stringify(g2.doc).length;
  ok(Math.abs(rowBytes - real) < real * 0.2 + 200, `the stored size (${rowBytes}) tracks the real JSON size (${real})`);
} catch (e) { fail++; console.log('  ERROR', e.stack || e); }
finally {
  try {
    const u = created.map(x => `'${x}'`).join(',');
    if (u) sql(`DELETE FROM profile_items WHERE user_id IN (${u}); DELETE FROM profiles WHERE user_id IN (${u}); DELETE FROM credentials WHERE user_id IN (${u}); DELETE FROM uses WHERE user_id IN (${u}); DELETE FROM users WHERE id IN (${u});`);
    const left = sql(`SELECT (SELECT COUNT(*) FROM users WHERE name LIKE 'ZZ test%') u, (SELECT COUNT(*) FROM profile_items WHERE user_id IN (${u || "''"})) i`)[0];
    console.log('cleanup: left behind', JSON.stringify(left));
    if (left.u || left.i) fail++;
  } catch (e) { console.log('cleanup failed', String(e).slice(0, 300)); fail++; }
  console.log(`\nsync ${MODE}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
