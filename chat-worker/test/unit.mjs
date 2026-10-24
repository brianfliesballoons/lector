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
  { doc: { words: null, settings: { theme: 'dark' }, last: { id: 'x' }, other: [1, 2], flag: true } }, { doc: { words: {} }, confirmWipe: true },
  // a saved verb (Words › Verbs) is a word entry that carries verb; its drill cards are srs entries per verb + tense + person
  { doc: { words: { 'es:tener': { t: 1, w: 'tener', lang: 'es', src: 'lesson', verb: 'tener' }, 'en:go': { t: 1, w: 'go', lang: 'en', src: 'lesson', verb: 'go' } }, srs: { 'en:cj:go:p': { t: 1, due: 5, s: 1, d: 5, reps: 1, lapses: 0, st: 2, lr: 0 }, 'es:cj:tener:pret:0': { t: 1, due: 5, s: 1, d: 5, reps: 1, lapses: 0, st: 2, lr: 0 } } }, stamps: { words: 1, srs: 1 } }];
for (const b of good2) try { validateIncoming(b); ok(true); } catch (e) { ok(false, 'refused good ' + JSON.stringify(b).slice(0, 80) + ': ' + e.message); }

// ---- web push (src/webpush.js, src/push.js) ----
{
  const { encrypt, vapidAuth, b64u: wb64 } = await import(dir + '/src/webpush.js');
  const P = await import(dir + '/src/push.js');
  const { subscriber, checkVapid, fakeD1, b64u } = await import(dir + '/test/pushlib.mjs');
  // RFC 8291 Appendix A, exactly: fixed sender key and salt give the published body, byte for byte
  const V = { plain: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw', auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN' };
  const vec = await encrypt(b64u.dec(V.plain), { p256dh: V.uaPublic, auth: V.auth }, { asPublic: V.asPublic, asPrivate: V.asPrivate, salt: V.salt });
  ok(b64u.enc(vec) === V.body, 'push: RFC 8291 Appendix A body matches exactly');
  ok(vec.length === 86 + 42 + 16 && b64u.enc(vec.slice(0, 86)) === b64u.enc(b64u.dec('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')), 'push: RFC 8291 86-octet header, then 41 bytes + delimiter + 16-byte tag');
  const ua = await subscriber({ publicKey: V.uaPublic, privateKey: V.uaPrivate, auth: V.auth });
  ok((await ua.decrypt(b64u.dec(V.body))).text === 'When I grow up, I want to be a watermelon', 'push: the RFC body decrypts with the receiver key (test decrypter is right)');
  const sb = await subscriber();
  const msg = JSON.stringify({ text: 'Hola, ¿cómo estás? 👋🏽 Ñandú' });
  const enc1 = await encrypt(msg, sb), enc2 = await encrypt(msg, sb), d1 = await sb.decrypt(enc1);
  ok(d1.text === msg && d1.rs === 4096 && d1.idlen === 65, 'push: random round trip (UTF-8), rs 4096, 65-byte key id');
  ok(b64u.enc(enc1) !== b64u.enc(enc2), 'push: a fresh key and salt every message');
  try { await encrypt('x'.repeat(4096), sb); ok(false, 'push: oversize payload accepted'); } catch { ok(true); }
  // VAPID
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const VK = { publicKey: b64u.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), privateKey: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d, subject: 'mailto:test@example.com' };
  const ep1 = 'https://fcm.googleapis.com/fcm/send/abc123';
  const va = await checkVapid(await vapidAuth(ep1, VK), ep1, VK.publicKey);
  ok(va.ok && va.claims.aud === 'https://fcm.googleapis.com', 'push: VAPID JWT is ES256, signed by the key, aud = the push origin, exp <= 12 h: ' + (va.why || ''));
  ok(!(await checkVapid(await vapidAuth(ep1, VK), 'https://web.push.apple.com/x', VK.publicKey)).ok, 'push: a JWT for one push service is not valid for another');
  // snippet: whole characters only
  const fam = '👨‍👩‍👧';
  const sn = P.snippet(fam.repeat(200));
  ok(sn.endsWith('…') && [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sn.slice(0, -1))].every(g => g.segment === fam) && new TextEncoder().encode(sn).length <= 903, 'push: snippet cuts on whole graphemes and caps the bytes');
  ok(P.snippet('a'.repeat(150)).length === 121 && P.snippet('short') === 'short', 'push: snippet ~120 characters + ellipsis, short text untouched');
  // subscription validation
  const goodSub = { endpoint: ep1, keys: sb.keys };
  ok(await P.checkSubscription(goodSub, false) === null, 'push: a real subscription is accepted');
  const badSubs = [null, [], { endpoint: 'http://fcm.googleapis.com/x', keys: sb.keys }, { endpoint: 'ftp://x.example/y', keys: sb.keys }, { endpoint: 'not a url', keys: sb.keys },
    { endpoint: 'https://u:p@fcm.googleapis.com/x', keys: sb.keys }, { endpoint: 'https://127.0.0.1/x', keys: sb.keys }, { endpoint: 'https://localhost/x', keys: sb.keys },
    { endpoint: 'http://localhost:9/x', keys: sb.keys }, { endpoint: ep1 }, { endpoint: ep1, keys: { p256dh: sb.keys.p256dh } },
    { endpoint: ep1, keys: { p256dh: 'AAAA', auth: sb.keys.auth } }, { endpoint: ep1, keys: { p256dh: b64u.enc(new Uint8Array(65).fill(4)), auth: sb.keys.auth } },
    { endpoint: ep1, keys: { p256dh: sb.keys.p256dh, auth: 'AAAA' } }, { endpoint: ep1 + 'x'.repeat(1000), keys: sb.keys }, { endpoint: ep1, keys: { p256dh: '<script>', auth: sb.keys.auth } }];
  let refused = 0; for (const x of badSubs) if (await P.checkSubscription(x, false)) refused++;
  ok(refused === badSubs.length, `push: ${refused}/${badSubs.length} bad subscriptions refused (http, IP, localhost, user:pass, missing/short/off-curve keys)`);
  ok(await P.checkSubscription({ endpoint: 'http://localhost:9/x', keys: sb.keys }, true) === null, 'push: http://localhost only for a Worker running locally (the test mock)');

  // ---- the Worker end to end, on the real migrations (node:sqlite stands in for D1); no AI is ever called ----
  const W = (await import(dir + '/src/worker.js')).default;
  const DB = await fakeD1(dir + '/migrations');
  let aiCalls = 0;
  const env = { DB, AI: { run: async () => { aiCalls++; throw new Error('no AI in tests'); } }, AI_FORCE_LIMIT: '1', SIGNUP: 'closed', VAPID_PUBLIC: VK.publicKey, VAPID_PRIVATE: VK.privateKey, VAPID_SUBJECT: VK.subject };
  const shaHex = async s => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('hex');
  const now0 = Date.now();
  const mk = async (id, name, native, learning) => DB.prepare('INSERT INTO users(id,name,native,learning,level,created) VALUES(?,?,?,?,?,?)').bind(id, name, native, learning, 'elementary', now0).run();
  await mk('u_b', 'TEST Brian', 'en', 'es'); await mk('u_m', 'TEST María', 'es', 'en'); await mk('u_x', 'TEST Other', 'en', 'es');
  await DB.prepare("INSERT INTO threads(id,title,langs,created) VALUES('t_one',NULL,'es,en',?)").bind(now0).run();
  for (const u of ['u_b', 'u_m']) await DB.prepare("INSERT INTO members(thread_id,user_id,joined) VALUES('t_one',?,?)").bind(u, now0).run();
  const TOK = { u_b: 'tokB'.padEnd(40, 'b'), u_m: 'tokM'.padEnd(40, 'm'), u_x: 'tokX'.padEnd(40, 'x') };
  for (const [u, t] of Object.entries(TOK)) await DB.prepare("INSERT INTO credentials(id,user_id,kind,hash,created) VALUES(?,?,'invite',?,?)").bind('c_' + u, u, await shaHex(t), now0).run();
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const call = async (method, path, b, who, host = 'https://lector-chat.example') => {
    const h = { 'Content-Type': 'application/json' }; if (who) h.Authorization = 'Bearer ' + TOK[who];
    const r = await W.fetch(new Request(host + path, { method, headers: h, body: b && method !== 'GET' ? JSON.stringify(b) : undefined }), env, ctx);
    let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j };
  };
  // a mock push service: records every request; status per endpoint
  const sent = [], statusFor = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { const u = String(url); if (!u.startsWith('https://push.test/')) return realFetch(url, init); sent.push({ url: u, headers: init.headers, body: init.body }); return new Response(null, { status: statusFor[u] || 201 }); };
  const settle = async () => { while (waits.length) await waits.shift(); };
  try {
    const k = await call('GET', '/push/key');
    ok(k.s === 200 && k.j.configured === true && k.j.key === VK.publicKey, 'push: GET /push/key needs no sign-in and gives the public key');
    let noAuth = 0; for (const [m, p] of [['POST', '/push/subscribe'], ['POST', '/push/unsubscribe'], ['POST', '/push/test'], ['GET', '/push/prefs'], ['PUT', '/push/prefs']]) if ((await call(m, p, {})).s === 401) noAuth++;
    ok(noAuth === 5, 'push: subscribe, unsubscribe, test and prefs all need a signed-in person (401): ' + noAuth);
    const B1 = await subscriber(), B2 = await subscriber(), M1 = await subscriber();
    ok((await call('POST', '/push/subscribe', { subscription: { endpoint: 'http://push.test/b1', keys: B1.keys } }, 'u_b')).s === 400, 'push: http endpoint refused on the deployed Worker');
    ok((await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/b1', keys: { p256dh: 'AAAA', auth: B1.auth } } }, 'u_b')).s === 400, 'push: a bad key refused');
    const s1 = await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/b1', keys: B1.keys }, lang: 'en' }, 'u_b');
    ok(s1.s === 201 && s1.j.devices === 1 && s1.j.preview === true && s1.j.notify === true, 'push: subscribe 201, preview and notify on by default');
    const s1b = await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/b1', keys: B1.keys }, lang: 'en' }, 'u_b');
    ok(s1b.j.devices === 1, 'push: subscribing the same browser again updates its row (upsert by endpoint)');
    const row = await DB.prepare("SELECT * FROM push_subs WHERE endpoint = 'https://push.test/b1'").first();
    ok(row && row.user_id === 'u_b' && row.cred_id === 'c_u_b' && row.lang === 'en', 'push: the row records the person, the sign-in it came from and the language');
    for (let i = 0; i < 6; i++) await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/x' + i, keys: (await subscriber()).keys } }, 'u_x');
    ok((await DB.prepare("SELECT COUNT(*) n FROM push_subs WHERE user_id = 'u_x'").first()).n === 5, 'push: capped at 5 browsers per person (the oldest goes)');
    await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/m1', keys: M1.keys }, lang: 'es' }, 'u_m');
    const un = await call('POST', '/push/unsubscribe', { endpoint: 'https://push.test/m1' }, 'u_b');
    ok(un.j.removed === 0, 'push: nobody can unsubscribe someone else’s browser');

    // a message from María reaches Brian's browser, encrypted, without waiting for the send
    const sm = await call('POST', '/messages', { thread: 't_one', text: 'Hola Brian, ¿ya llegaste a casa? Te extraño mucho.' }, 'u_m');
    ok(sm.s === 201 && waits.length >= 1, 'push: the send returns 201 with the push left to ctx.waitUntil');
    await settle();
    ok(sent.length === 1 && sent[0].url === 'https://push.test/b1', 'push: exactly one push, to the partner (never to the sender): ' + sent.map(x => x.url).join(','));
    const h0 = sent[0].headers;
    ok(h0.TTL === '86400' && h0.Urgency === 'high' && h0.Topic === 't_one' && h0['Content-Encoding'] === 'aes128gcm', 'push: TTL 86400, Urgency high, Topic = the conversation, aes128gcm');
    ok((await checkVapid(h0.Authorization, sent[0].url, VK.publicKey)).ok, 'push: the request carries a valid VAPID Authorization');
    const pl = JSON.parse((await B1.decrypt(sent[0].body)).text);
    ok(pl.kind === 'msg' && pl.from === 'TEST María' && pl.text === 'Hola Brian, ¿ya llegaste a casa? Te extraño mucho.' && pl.thread === 't_one' && pl.k === 1 && pl.lang === 'en' && !pl.tr, 'push: payload has the sender, the text as written, the conversation, k=1: ' + JSON.stringify(pl));
    ok(aiCalls === 0, 'push: nothing in the send + push path called the AI binding');

    // the rest drives notifyNew() directly on a fake clock (the window is 20 s of real time otherwise)
    const env2 = { ...env, AI_FORCE_LIMIT: undefined };   // a live AI binding this time: the push path must still never touch it
    let clock = Date.now() + 60000;
    const ins = async (text, versions, lang = 'es') => (await DB.prepare("INSERT INTO messages(thread_id,user_id,text,lang,versions,pending,created,seq) VALUES('t_one','u_m',?,?,?,0,?,0) RETURNING *").bind(text, lang, versions ? JSON.stringify(versions) : null, clock).first());
    sent.length = 0;
    const mA = await ins('¿Comiste?', { es: '¿Comiste?', en: 'Did you eat?' });
    await P.notifyNew(env2, mA, { now: () => clock });
    const pA = JSON.parse((await B1.decrypt(sent[0].body)).text);
    ok(pA.text === '¿Comiste?' && pA.tr === 'Did you eat?' && pA.trLang === 'en', 'push: a translation already stored rides along, in the reader’s language');
    // two more inside 20 s: held, then one push for both
    let release; const gate = new Promise(r => release = r); let slept = -1;
    clock += 2000; const mB = await ins('Oye', null);
    const pB = P.notifyNew(env2, mB, { now: () => clock, sleep: ms => { slept = ms; return gate; } });
    await new Promise(r => setTimeout(r, 30));
    clock += 2000; const mC = await ins('¿Estás ahí?', null);
    await P.notifyNew(env2, mC, { now: () => clock, sleep: () => { throw new Error('second flush scheduled'); } });
    ok(sent.length === 1 && slept > 17000 && slept <= 18000, 'push: inside the 20 s window nothing is sent; one flush is scheduled for the window’s end: ' + slept);
    clock += 16100; release(); await pB;
    ok(sent.length === 2, 'push: when the window ends, ONE push for the held messages');
    const pC = JSON.parse((await B1.decrypt(sent[1].body)).text);
    ok(pC.k === 2 && pC.text === '¿Estás ahí?', 'push: the collapsed push says 2 and shows the newest text: ' + JSON.stringify(pC));
    clock += 21000; await P.notifyNew(env2, await ins('Ya', null), { now: () => clock });
    ok(sent.length === 3, 'push: after the window, the next message goes at once');
    // preview off: no text, no translation
    await call('PUT', '/push/prefs', { preview: false }, 'u_b');
    clock += 21000; await P.notifyNew(env2, await ins('Secreto', { es: 'Secreto', en: 'Secret' }), { now: () => clock });
    const pD = JSON.parse((await B1.decrypt(sent[3].body)).text);
    ok(pD.kind === 'msg' && pD.from === 'TEST María' && !('text' in pD) && !('tr' in pD), 'push: with "show message text" off the payload carries no text at all: ' + JSON.stringify(pD));
    ok((await call('PUT', '/push/prefs', { preview: 'no' }, 'u_b')).s === 400, 'push: prefs must be true or false');
    await call('PUT', '/push/prefs', { preview: true, notify: false }, 'u_b');
    clock += 21000; await P.notifyNew(env2, await ins('Nada', null), { now: () => clock });
    ok(sent.length === 4, 'push: notify off sends nothing');
    await call('PUT', '/push/prefs', { notify: true }, 'u_b');
    ok(aiCalls === 0, 'push: still no AI call after every push path');
    // clean-up: 410 deletes; other errors count, the 5th deletes
    await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/b2', keys: B2.keys } }, 'u_b');
    statusFor['https://push.test/b1'] = 410; statusFor['https://push.test/b2'] = 500;
    clock += 21000; await P.notifyNew(env2, await ins('Uno', null), { now: () => clock });
    ok(!(await DB.prepare("SELECT 1 FROM push_subs WHERE endpoint = 'https://push.test/b1'").first()), 'push: 410 Gone deletes the subscription');
    ok((await DB.prepare("SELECT fail_count FROM push_subs WHERE endpoint = 'https://push.test/b2'").first()).fail_count === 1, 'push: a 500 counts one failure');
    for (let i = 0; i < 4; i++) { clock += 21000; await P.notifyNew(env2, await ins('Otra ' + i, null), { now: () => clock }); }
    ok(!(await DB.prepare("SELECT 1 FROM push_subs WHERE endpoint = 'https://push.test/b2'").first()), 'push: the 5th failure in a row deletes it');
    statusFor['https://push.test/b3'] = 404;
    await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/b3', keys: B2.keys } }, 'u_b');
    clock += 21000; await P.notifyNew(env2, await ins('Dos', null), { now: () => clock });
    ok(!(await DB.prepare("SELECT 1 FROM push_subs WHERE endpoint = 'https://push.test/b3'").first()), 'push: 404 deletes it too');
    // a phone whose sign-in was revoked (signed out from another device) gets nothing, and its row goes
    await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/b4', keys: B1.keys } }, 'u_b');
    await DB.prepare("UPDATE credentials SET revoked = 1 WHERE id = 'c_u_b'").run();
    const before = sent.length; clock += 21000; await P.notifyNew(env2, await ins('Tres', null), { now: () => clock });
    ok(sent.length === before && !(await DB.prepare("SELECT 1 FROM push_subs WHERE endpoint = 'https://push.test/b4'").first()), 'push: a revoked sign-in gets no push and its subscription is deleted');
    await DB.prepare("UPDATE credentials SET revoked = 0 WHERE id = 'c_u_b'").run();
    // the test button: one push, then rate-limited
    await call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.test/b5', keys: B1.keys }, lang: 'es' }, 'u_b');
    sent.length = 0;
    const t1 = await call('POST', '/push/test', {}, 'u_b'), t2 = await call('POST', '/push/test', {}, 'u_b');
    const pT = sent[0] && JSON.parse((await B1.decrypt(sent[0].body)).text);
    ok(t1.s === 200 && t1.j.ok === 1 && pT && pT.kind === 'test' && pT.lang === 'es', 'push: POST /push/test sends one test push in the browser’s language');
    ok(t2.s === 429 && sent.length === 1, 'push: a second test straight away is refused (429)');
    ok((await call('POST', '/push/test', { endpoint: 'https://push.test/m1' }, 'u_b')).s === 404, 'push: the test cannot target someone else’s browser');
    // the service worker's pushsubscriptionchange: no sign-in, the old auth secret is the proof
    const NB = await subscriber();
    const rsBad = await call('POST', '/push/resubscribe', { old: { endpoint: 'https://push.test/b5', auth: NB.auth }, subscription: { endpoint: 'https://push.test/b6', keys: NB.keys } });
    ok(rsBad.s === 404 && (await DB.prepare("SELECT 1 FROM push_subs WHERE endpoint = 'https://push.test/b5'").first()), 'push: resubscribe with the wrong old secret is refused (404) and changes nothing');
    const rsOk = await call('POST', '/push/resubscribe', { old: { endpoint: 'https://push.test/b5', auth: B1.auth }, subscription: { endpoint: 'https://push.test/b6', keys: NB.keys } });
    const moved = await DB.prepare("SELECT * FROM push_subs WHERE endpoint = 'https://push.test/b6'").first();
    ok(rsOk.s === 200 && moved && moved.user_id === 'u_b' && moved.cred_id === 'c_u_b' && moved.lang === 'es' && moved.auth === NB.auth && !(await DB.prepare("SELECT 1 FROM push_subs WHERE endpoint = 'https://push.test/b5'").first()), 'push: resubscribe moves the row to the new address, keeping the person, sign-in and language');
    await DB.prepare("UPDATE push_subs SET endpoint = 'https://push.test/b5', p256dh = ?, auth = ? WHERE id = ?").bind(B1.p256dh, B1.auth, moved.id).run();
    // unsubscribe
    ok((await call('POST', '/push/unsubscribe', { endpoint: 'https://push.test/b5' }, 'u_b')).j.removed === 1 && !(await DB.prepare("SELECT 1 FROM push_subs WHERE user_id = 'u_b'").first()), 'push: unsubscribe removes this browser');
  } finally { globalThis.fetch = realFetch; }
}
console.log(`unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
