// Signs fake Google ID tokens with a local test key (for wrangler dev only; the deployed Worker never trusts this key).
import fs from 'node:fs';
const dir = process.env.LECTOR_TEST_DIR + '/';
const priv = JSON.parse(fs.readFileSync(dir + 'gtest-private.jwk', 'utf8'));
const key = await crypto.subtle.importKey('jwk', priv, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
const b64u = b => Buffer.from(b).toString('base64url');
export async function signToken(c) {
  const t = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://accounts.google.com', aud: 'test-client.apps.googleusercontent.com', iat: t, exp: t + 3600, email_verified: true, ...c };
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'test-k1', typ: 'JWT' })), p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p))))}`;
}
