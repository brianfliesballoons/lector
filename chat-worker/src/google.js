// Verifies a Google ID token (the `credential` that Google Identity Services hands the page) with Google's
// published keys. No dependencies: WebCrypto only, so it runs the same in the Worker and in a Node test.
// Checks: RS256 signature by a current Google key, iss, aud = our client id, exp / iat, sub, email_verified, nonce.

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const SKEW_S = 60;   // seconds of clock difference tolerated

export class GoogleTokenError extends Error {}

let cached = { keys: null, until: 0 };

// Google rotates its keys; honour the Cache-Control max-age it sends (usually hours), refetch on an unknown kid.
export async function googleKeys(force = false) {
  if (!force && cached.keys && Date.now() < cached.until) return cached.keys;
  const r = await fetch(GOOGLE_JWKS_URL);
  if (!r.ok) throw new Error(`Google keys fetch failed: ${r.status}`);
  const j = await r.json();
  const age = +((r.headers.get('Cache-Control') || '').match(/max-age=(\d+)/) || [])[1] || 3600;
  cached = { keys: Array.isArray(j.keys) ? j.keys : [], until: Date.now() + Math.min(age, 86400) * 1000 };
  return cached.keys;
}

const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

// getKeys(force) -> JWK array. Injected so a test can use its own key pair; the Worker uses googleKeys.
export async function verifyGoogleIdToken(token, clientId, { getKeys = googleKeys, now = Date.now() } = {}) {
  if (!clientId) throw new GoogleTokenError('Google sign-in is not set up yet.');
  if (typeof token !== 'string' || token.length > 4096) throw new GoogleTokenError('That Google sign-in could not be read.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new GoogleTokenError('That Google sign-in could not be read.');
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw new GoogleTokenError('That Google sign-in could not be read.'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleTokenError('That Google sign-in is not signed the way Google signs.');

  let jwk = (await getKeys(false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(true)).find(k => k.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA') throw new GoogleTokenError('That Google sign-in is signed with a key Google does not publish.');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new GoogleTokenError('That Google sign-in failed its signature check.');

  const t = Math.floor(now / 1000);
  if (!ISSUERS.includes(claims.iss)) throw new GoogleTokenError('That sign-in did not come from Google.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new GoogleTokenError('That Google sign-in was made for a different app.');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) throw new GoogleTokenError('That Google sign-in has expired. Please try again.');
  if (typeof claims.iat === 'number' && claims.iat - SKEW_S > t) throw new GoogleTokenError('That Google sign-in is dated in the future.');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new GoogleTokenError('That Google sign-in has no account id.');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new GoogleTokenError('Google has not verified the email on that account.');
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
    name: typeof claims.name === 'string' ? claims.name : (typeof claims.given_name === 'string' ? claims.given_name : null),
    nonce: typeof claims.nonce === 'string' ? claims.nonce : null,
  };
}
