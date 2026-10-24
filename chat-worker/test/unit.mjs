// Unit tests: Google ID-token verification and the profile sync rules (validation, stamps, the wipe guard). Run: node test/unit.mjs .  (from chat-worker/)
const dir = process.argv[2];
const { verifyGoogleIdToken } = await import(dir + '/src/google.js');
const { validateIncoming } = await import(dir + '/src/sync.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const b64u = b => Buffer.from(b).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
const getKeys = async () => [pub];
const CID = 'test-client.apps.googleusercontent.com';
const now = Date.now(), t = Math.floor(now / 1000);
async function tok(claims, { key = kp.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const h = b64u(JSON.stringify({ alg, kid, typ: 'JWT' })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const good = { iss: 'https://accounts.google.com', aud: CID, sub: '1234567890', email: 'Test@Example.com', email_verified: true, iat: t, exp: t + 3600, nonce: 'n1', name: 'Test Person' };
const expectFail = async (p, m) => { try { await p; ok(false, m + ' (accepted)'); } catch (e) { ok(true); } };
const r = await verifyGoogleIdToken(await tok(good), CID, { getKeys, now });
ok(r.sub === '1234567890' && r.email === 'test@example.com' && r.nonce === 'n1' && r.name === 'Test Person', 'good token');
ok((await verifyGoogleIdToken(await tok({ ...good, iss: 'accounts.google.com' }), CID, { getKeys, now })).sub, 'bare iss accepted');
await expectFail(verifyGoogleIdToken(await tok({ ...good, aud: 'someone-else' }), CID, { getKeys, now }), 'wrong aud');
await expectFail(verifyGoogleIdToken(await tok({ ...good, iss: 'https://evil.example' }), CID, { getKeys, now }), 'wrong iss');
await expectFail(verifyGoogleIdToken(await tok({ ...good, exp: t - 120 }), CID, { getKeys, now }), 'expired');
await expectFail(verifyGoogleIdToken(await tok({ ...good, iat: t + 600 }), CID, { getKeys, now }), 'future iat');
await expectFail(verifyGoogleIdToken(await tok({ ...good, email_verified: false }), CID, { getKeys, now }), 'unverified email');
await expectFail(verifyGoogleIdToken(await tok({ ...good, email_verified: undefined }), CID, { getKeys, now }), 'missing email_verified');
await expectFail(verifyGoogleIdToken(await tok(good, { key: other.privateKey }), CID, { getKeys, now }), 'wrong signing key');
await expectFail(verifyGoogleIdToken(await tok(good, { kid: 'k-unknown' }), CID, { getKeys, now }), 'unknown kid');
await expectFail(verifyGoogleIdToken(await tok(good, { alg: 'none' }), CID, { getKeys, now }), 'alg none');
const parts = (await tok(good)).split('.');
await expectFail(verifyGoogleIdToken(`${parts[0]}.${b64u(JSON.stringify({ ...good, sub: 'attacker' }))}.${parts[2]}`, CID, { getKeys, now }), 'tampered payload');
await expectFail(verifyGoogleIdToken(await tok(good), '', { getKeys, now }), 'no client id configured');
await expectFail(verifyGoogleIdToken('not.a.token', CID, { getKeys, now }), 'garbage');

// ---- sync rules (the merge itself runs in D1 and is tested end to end in test/sync.mjs) ----
const { keyStamp, removedBy, decide, WIPE_LIMIT } = await import(dir + '/src/sync.js');
ok(keyStamp(100, 1000) === 100 && keyStamp(9e15, 1000) === 1000 && keyStamp('x', 1000) === 1000 && keyStamp(0, 1000) === 1000, 'key stamps: kept, clamped to now, or now');
ok(decide('words', { a: {} }, 5, 10, { kind: 'map' }) === 'entries', 'a map onto a stored map merges entry by entry, whatever the key stamps');
ok(decide('words', { a: {} }, 5, 10, { kind: 'absent' }) === 'skip' && decide('words', { a: {} }, 20, 10, { kind: 'absent' }) === 'replace-map', 'a map onto nothing: only with a newer stamp');
ok(decide('words', null, 20, 10, { kind: 'map' }) === 'replace' && decide('words', null, 10, 10, { kind: 'map' }) === 'skip', 'null clears with a newer stamp only (equal keeps)');
ok(decide('settings', { theme: 'x' }, 20, 10, { kind: 'value' }) === 'replace' && decide('settings', { theme: 'x' }, 5, 10, { kind: 'value' }) === 'skip', 'whole keys: newer wins, older loses');
const many = Object.fromEntries([...Array(30)].map((_, i) => ['es:w' + i, { t: 1, w: 'w' + i }]));
ok(removedBy(many, null, true) === 30 && removedBy(many, { 'es:w0': {} }, true) === 29 && removedBy([1, 2, 3], [1], false) === 2, 'the wipe guard counts what a replacement removes');
ok(removedBy({ a: { t: 1, deleted: true } }, null, true) === 0, 'tombstones do not count as entries');
ok(WIPE_LIMIT === 20, 'WIPE_LIMIT is 20');
// validation: every top-level key's type and shape
const bad = [null, [], { doc: [] }, { doc: { '1x': 1 } }, { doc: { 'a b': 1 } }, { doc: {}, stamps: [] },
  { doc: { words: [] } },                                   // the reviewer's PUT {doc:{words:[]}} that wiped every word
  { doc: { words: 'x' } }, { doc: { srs: 5 } }, { doc: { notes: true } }, { doc: { progress: [] } }, { doc: { library: [1] } }, { doc: { reports: 'r' } },
  { doc: { words: { 'es:a': 'hola' } } }, { doc: { words: { 'es:a': [] } } }, { doc: { words: { 'es:a': { t: 1 } } } }, { doc: { words: { 'es:a': { t: '1', w: 'a' } } } },
  { doc: { words: { '': { t: 1, w: 'a' } } } }, { doc: { words: { ['x'.repeat(301)]: { t: 1, w: 'a' } } } },
  { doc: { srs: { 'es:a': { t: 1, due: 'tomorrow' } } } }, { doc: { notes: { 'es:a': { t: 1, items: 'x' } } } }, { doc: { words: { 'es:a': { t: 1, deleted: 'yes' } } } },
  { doc: { settings: [] } }, { doc: { settings: 'dark' } }, { doc: { last: 5 } },
  { doc: { settings: {} }, stamps: { settings: 'now' } }, { doc: {}, confirmWipe: 'yes' }];
for (const b of bad) try { validateIncoming(b); ok(false, 'accepted bad ' + JSON.stringify(b).slice(0, 80)); } catch (e) { ok(e.status === 400, 'refused with 400: ' + JSON.stringify(b).slice(0, 60)); }
try { validateIncoming({ doc: Object.fromEntries([...Array(41)].map((_, i) => ['k' + i, 1])) }); ok(false, '41 keys accepted'); } catch { ok(true); }
const good2 = [{ doc: { words: { 'es:a': { t: 1, w: 'a', lang: 'es' }, 'es:b': { t: 2, deleted: true } }, srs: { 'es:a': { t: 1, due: 5, s: 1, d: 5, reps: 1, lapses: 0, st: 1, lr: 0 } } }, stamps: { words: 1, srs: 1 } },
  { doc: { words: null, settings: { theme: 'dark' }, last: { id: 'x' }, other: [1, 2], flag: true } }, { doc: { words: {} }, confirmWipe: true }];
for (const b of good2) try { validateIncoming(b); ok(true); } catch (e) { ok(false, 'refused good ' + JSON.stringify(b).slice(0, 80) + ': ' + e.message); }
console.log(`unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
