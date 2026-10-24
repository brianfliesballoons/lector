// Makes a throwaway test Google key + local admin key, and the .dev.vars of the throwaway worker copy. node gkeys.mjs <test dir>
import fs from 'node:fs';
const dir = process.argv[2];
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
fs.writeFileSync(dir + '/gtest-private.jwk', JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)));
const pub = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'test-k1' };
const admin = crypto.randomUUID() + crypto.randomUUID();
fs.writeFileSync(dir + '/local-admin-key', admin);
fs.writeFileSync(dir + '/cw/.dev.vars', `ADMIN_KEY="${admin}"\nGOOGLE_CLIENT_ID="test-client.apps.googleusercontent.com"\nGOOGLE_TEST_JWKS='${JSON.stringify({ keys: [pub] })}'\n`);
