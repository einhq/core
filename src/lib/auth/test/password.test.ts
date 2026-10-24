/**
 * The stored format is scrypt's own 96-byte one: a hash made by another
 * implementation of it verifies, and a new hash reads back the same way.
 */

import { assertEquals } from '@std/assert';
import { hashPassword, PASSWORD_HASH_LOGN, passwordHashLogN, verifyPassword } from '../password.ts';

// `hash('correct horse battery staple', { logN: 12, salt: [3, 10, 17, …] })`
// made by @denorg/scrypt 4.4.4, an independent implementation of the format.
const LEGACY_HASH = 'c2NyeXB0AAwAAAAIAAAAAQMKERgfJi00O0JJUFdeZWxzeoGIj5adpKuyucDHztXcGOkLqhsv8wR21KR5HpMGLlddrRg/gOzfEjq/0w6kXhBPVoFtMiD2F09zd+uLEboB';

const CHEAP = { CFG_PASSWORD_HASH_LOGN: '10' };

Deno.test('password hashing', async (t) => {
  await t.step('a hash written by the old library still verifies', async () => {
    assertEquals(await verifyPassword('correct horse battery staple', LEGACY_HASH), true);
    assertEquals(await verifyPassword('correct horse battery stable', LEGACY_HASH), false);
  });

  await t.step('a fresh hash round-trips and rejects the wrong password', async () => {
    const hash = await hashPassword('admin', CHEAP);
    assertEquals(await verifyPassword('admin', hash), true);
    assertEquals(await verifyPassword('Admin', hash), false);
    assertEquals(await verifyPassword('', hash), false);
  });

  await t.step('the cost is carried by the hash, not by the verifier', async () => {
    const hash = await hashPassword('admin', CHEAP);
    // Byte 7 of the 96 is logN; the verifier has no env and still follows it.
    const logN = Uint8Array.from(atob(hash), (c) => c.charCodeAt(0))[7];
    assertEquals(logN, 10);
    assertEquals(await verifyPassword('admin', hash), true);
  });

  await t.step('two hashes of one password differ by salt', async () => {
    assertEquals(await hashPassword('admin', CHEAP) === await hashPassword('admin', CHEAP), false);
  });

  await t.step('not a hash is not a match, not an error', async () => {
    assertEquals(await verifyPassword('admin', ''), false);
    assertEquals(await verifyPassword('admin', 'admin'), false);
    assertEquals(await verifyPassword('admin', '$scrypt$ln=10,r=8,p=1$c2FsdA$aGFzaA'), false);
    assertEquals(await verifyPassword('admin', 'not base64!'), false);
  });

  await t.step('the cost knob is bounded and defaults to production', () => {
    assertEquals(passwordHashLogN({}), PASSWORD_HASH_LOGN);
    assertEquals(PASSWORD_HASH_LOGN, 16);
    assertEquals(passwordHashLogN({ CFG_PASSWORD_HASH_LOGN: '10' }), 10);
    assertEquals(passwordHashLogN({ CFG_PASSWORD_HASH_LOGN: '0' }), PASSWORD_HASH_LOGN);
    assertEquals(passwordHashLogN({ CFG_PASSWORD_HASH_LOGN: '64' }), PASSWORD_HASH_LOGN);
    assertEquals(passwordHashLogN({ CFG_PASSWORD_HASH_LOGN: 'lots' }), PASSWORD_HASH_LOGN);
  });

  await t.step('the derivation does not block the event loop', async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 1);
    try {
      // logN 14 is ~40 ms of KDF; a blocked loop would deliver no ticks at all.
      await hashPassword('admin', { CFG_PASSWORD_HASH_LOGN: '14' });
    } finally {
      clearInterval(interval);
    }
    assertEquals(ticks > 0, true, 'the event loop must keep turning during the KDF');
  });
});
