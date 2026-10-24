// Test helpers for web push: a browser-side subscriber (its own P-256 key + auth secret) that can decrypt what the
// Worker sends (RFC 8291 receiver side), a VAPID header checker, and a D1 stand-in over node:sqlite so the real
// migrations and SQL run in the unit suite. Test code only; nothing here is bundled into the Worker.
import fs from 'node:fs';

const te = new TextEncoder(), td = new TextDecoder();
export const b64u = {
  enc: b => Buffer.from(b).toString('base64url'),
  dec: s => new Uint8Array(Buffer.from(String(s).replace(/\s+/g, ''), 'base64url')),
};
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }
const hkdf = async (salt, ikm, info, len) => (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, len);
const jwk = (pub, d) => ({ kty: 'EC', crv: 'P-256', x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ...(d ? { d } : {}) });

// A subscriber like a browser: {p256dh, auth} to hand to the server, and decrypt() for what arrives.
// With fixed = {publicKey, privateKey, auth} (base64url) it uses those (the RFC 8291 receiver keys).
export async function subscriber(fixed) {
  let pub, priv, auth;
  if (fixed) {
    pub = b64u.dec(fixed.publicKey); auth = b64u.dec(fixed.auth);
    priv = await crypto.subtle.importKey('jwk', jwk(pub, fixed.privateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)); priv = kp.privateKey; auth = crypto.getRandomValues(new Uint8Array(16));
  }
  return {
    p256dh: b64u.enc(pub), auth: b64u.enc(auth),
    keys: { p256dh: b64u.enc(pub), auth: b64u.enc(auth) },
    // RFC 8291 §3-4, receiver side. Returns {text, rs, idlen, header} or throws.
    async decrypt(body) {
      body = body instanceof Uint8Array ? body : new Uint8Array(body);
      const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20];
      const asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
      const asKey = await crypto.subtle.importKey('jwk', jwk(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));
      const ikm = await hkdf(auth, ecdh, cat(te.encode('WebPush: info\0'), pub, asPublic), 32);
      const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
      const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      let pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct));
      let end = pt.length - 1; while (end >= 0 && pt[end] === 0) end--;
      if (pt[end] !== 2) throw new Error('no last-record delimiter');
      return { text: td.decode(pt.slice(0, end)), rs, idlen, asPublic };
    },
  };
}

// Checks "Authorization: vapid t=<JWT>, k=<key>": ES256 signature by k, aud = the endpoint's origin, exp within 12 h,
// sub a mailto:. Returns {ok, why, claims}.
export async function checkVapid(header, endpoint, expectKey, now = Date.now()) {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header || '');
  if (!m) return { ok: false, why: 'not a vapid header' };
  const [h, p, s] = m[1].split('.');
  const head = JSON.parse(td.decode(b64u.dec(h))), claims = JSON.parse(td.decode(b64u.dec(p)));
  if (head.alg !== 'ES256' || head.typ !== 'JWT') return { ok: false, why: 'header ' + JSON.stringify(head) };
  if (expectKey && m[2] !== expectKey) return { ok: false, why: 'k is not the server key' };
  const key = await crypto.subtle.importKey('jwk', jwk(b64u.dec(m[2])), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u.dec(s), te.encode(`${h}.${p}`));
  if (!good) return { ok: false, why: 'bad signature' };
  if (claims.aud !== new URL(endpoint).origin) return { ok: false, why: 'aud ' + claims.aud };
  const left = claims.exp - now / 1000;
  if (!(left > 0 && left <= 12 * 3600 + 5)) return { ok: false, why: 'exp ' + left };
  if (!/^mailto:/.test(claims.sub || '')) return { ok: false, why: 'sub ' + claims.sub };
  return { ok: true, claims };
}

// D1 stand-in: prepare().bind().first()/all()/run(), batch(). The real migration files are applied in order.
export async function fakeD1(migrationsDir) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(migrationsDir + '/' + f, 'utf8'));
  const fix = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  const plain = r => r ? { ...r } : null;
  const prepare = sql => {
    let args = [];
    const st = {
      bind(...a) { args = a.map(fix); return st; },
      async first() { return plain(db.prepare(sql).get(...args)); },
      async all() { return { results: db.prepare(sql).all(...args).map(plain) }; },
      async run() {
        const s = db.prepare(sql);
        if (/\bRETURNING\b/i.test(sql)) { const rows = s.all(...args).map(plain); return { results: rows, meta: { changes: rows.length } }; }
        const r = s.run(...args); return { results: [], meta: { changes: Number(r.changes) } };
      },
    };
    return st;
  };
  return { prepare, async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; }, raw: db };
}
