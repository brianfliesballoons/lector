// Web Push from the Worker, with WebCrypto only (no npm dependency).
//   - VAPID (RFC 8292): an ES256 JWT for the push service's origin, valid at most 12 hours.
//   - Message encryption (RFC 8291, "aes128gcm" from RFC 8188): ECDH with a fresh key per message, HKDF, one 4096-byte record.
// The push service (Google's FCM for Chrome on Android, Apple's for iPhone, Mozilla's for Firefox) only ever sees
// ciphertext: the text can be read only by the browser that made the subscription.
// encrypt() takes an optional fixed sender key and salt so it can be checked against RFC 8291 Appendix A exactly.

const te = new TextEncoder();
export const b64u = {
  enc(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = String(str).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '='.repeat((4 - s.length % 4) % 4)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; },
};
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF with one output block (every length used here is <= 32 bytes): extract, then expand with counter 0x01.
async function hkdf(salt, ikm, info, len) { return (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, len); }

// A P-256 key from its raw uncompressed public point (65 bytes, 0x04 || x || y) and, for a private key, its 32-byte d.
function jwk(pubRaw, d) {
  if (!(pubRaw instanceof Uint8Array) || pubRaw.length !== 65 || pubRaw[0] !== 4) throw new Error('bad P-256 public key');
  const k = { kty: 'EC', crv: 'P-256', x: b64u.enc(pubRaw.slice(1, 33)), y: b64u.enc(pubRaw.slice(33, 65)), ext: true };
  if (d) k.d = typeof d === 'string' ? d : b64u.enc(d);
  return k;
}
// A browser's subscription key (p256dh) must be a real point on the curve: importing it checks that.
export async function validP256(pubRaw) {
  try { await crypto.subtle.importKey('jwk', jwk(pubRaw), { name: 'ECDH', namedCurve: 'P-256' }, false, []); return true; } catch { return false; }
}

export const RECORD = 4096;

// RFC 8291 §3-4: returns the whole request body (header || ciphertext).
// sub = {p256dh, auth} (base64url, as the browser's PushSubscription.toJSON() gives them).
// fixed = {asPublic, asPrivate, salt} (base64url): for the RFC test vector only.
export async function encrypt(plaintext, sub, fixed) {
  const uaPublic = b64u.dec(sub.p256dh), authSecret = b64u.dec(sub.auth);
  if (authSecret.length !== 16) throw new Error('bad auth secret');
  const data = typeof plaintext === 'string' ? te.encode(plaintext) : plaintext;
  // one record: data + the 0x02 delimiter + the 16-byte tag must fit in RECORD, header excluded
  if (data.length + 1 + 16 > RECORD) throw new Error('payload too large');
  let asPrivate, asPublic;
  if (fixed) {
    asPublic = b64u.dec(fixed.asPublic);
    asPrivate = await crypto.subtle.importKey('jwk', jwk(asPublic, fixed.asPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey; asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('jwk', jwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const keyInfo = cat(te.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = fixed ? b64u.dec(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(data, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, RECORD); header[20] = asPublic.length; header.set(asPublic, 21);
  return cat(header, ct);
}

// RFC 8292: "Authorization: vapid t=<JWT>, k=<public key>". The JWT's aud is the push service's origin.
// vapid = {publicKey, privateKey, subject}: publicKey is the raw point (base64url), privateKey its d (base64url).
const jwtCache = new Map();   // aud -> {auth, until}: one signature per push service per ~hour, not one per message
export async function vapidAuth(endpoint, vapid, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const hit = jwtCache.get(aud);
  if (hit && hit.key === vapid.publicKey && hit.until > now) return hit.auth;
  const exp = Math.floor(now / 1000) + 12 * 3600;   // the most RFC 8292 allows is 24 h; services like 12 h or less
  const h = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u.enc(te.encode(JSON.stringify({ aud, exp, sub: vapid.subject })));
  const key = await crypto.subtle.importKey('jwk', jwk(b64u.dec(vapid.publicKey), vapid.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is already r || s (64 bytes), which is what JWS ES256 wants
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${h}.${p}`)));
  const auth = `vapid t=${h}.${p}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
  jwtCache.set(aud, { auth, key: vapid.publicKey, until: now + 3600e3 });
  return auth;
}

// One push. Returns the HTTP status (0 when the network failed). The body is JSON, encrypted for that one browser.
// topic: a short [A-Za-z0-9_-] tag (<= 32) so the push service keeps only the newest undelivered push per conversation.
export async function sendPush(sub, payload, vapid, { ttl = 86400, urgency = 'high', topic, fetchFn = fetch } = {}) {
  const body = await encrypt(JSON.stringify(payload), sub);
  const headers = {
    Authorization: await vapidAuth(sub.endpoint, vapid),
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    TTL: String(ttl), Urgency: urgency,
  };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  try { const r = await fetchFn(sub.endpoint, { method: 'POST', headers, body }); return r.status; }
  catch { return 0; }
}
