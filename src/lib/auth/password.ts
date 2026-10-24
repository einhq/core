/**
 * Password hashing for `.password` files.
 *
 * One location for the KDF, so the cost is decided once. The stored string is
 * scrypt's own 96-byte format (<https://github.com/Tarsnap/scrypt/blob/master/FORMAT>),
 * base64: it carries logN, r, p and the salt, so `verifyPassword` follows
 * whatever a hash was made with and only `hashPassword` needs to know the
 * cost. Every existing `.password` is in that format.
 *
 * The KDF itself is `node:crypto`'s: native, and run off the main thread, so a
 * login does not stall HTTP, the pipeline engine and every service for the
 * length of a hash.
 */

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { decodeBase64, encodeBase64 } from '@std/encoding/base64';

/**
 * N = 2^16, r = 8: ~150 ms and 64 MiB per hash. A hash made at another cost
 * carries it in its header and verifies at that cost; only a new hash is made
 * at this one.
 */
export const PASSWORD_HASH_LOGN = 16;

const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;
const MAGIC = new TextEncoder().encode('scrypt\0');

/**
 * `CFG_PASSWORD_HASH_LOGN` lowers the work factor for a process whose
 * passwords protect nothing: the fast test tier sets 10, which turns ~300 ms
 * per hash — and per login, since verification recomputes the hash — into a
 * few milliseconds, without changing what a login test exercises. Production
 * leaves it unset.
 */
export function passwordHashLogN(env: Record<string, string | undefined>): number {
  const configured = Number.parseInt(env.CFG_PASSWORD_HASH_LOGN ?? '', 10);
  return Number.isInteger(configured) && configured >= 1 && configured <= 63 ? configured : PASSWORD_HASH_LOGN;
}

export async function hashPassword(password: string, env: Record<string, string | undefined> = {}): Promise<string> {
  const salt = new Uint8Array(randomBytes(SALT_LENGTH));
  const logN = passwordHashLogN(env);
  const key = await deriveKey(password, salt, logN, BLOCK_SIZE, PARALLELISM);
  return encodeBase64(encode(key, logN, BLOCK_SIZE, PARALLELISM, salt));
}

/**
 * Recompute the hash with the stored parameters and compare it whole, which
 * covers the header checksum and the HMAC alike. A string that is not a hash
 * in this format — or a hash of any other length — is simply not a match.
 */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  let stored: Uint8Array;
  try {
    stored = decodeBase64(passwordHash.trim());
  } catch {
    return false;
  }
  if (stored.length !== 96 || !bytesEqual(stored.subarray(0, MAGIC.length), MAGIC)) {
    return false;
  }
  const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
  const logN = view.getUint8(7);
  const r = view.getUint32(8);
  const p = view.getUint32(12);
  const salt = stored.subarray(16, 48);
  if (logN < 1 || logN > 63 || r < 1 || p < 1) {
    return false;
  }
  const key = await deriveKey(password, salt, logN, r, p);
  return timingSafeEqual(encode(key, logN, r, p, salt), stored);
}

function deriveKey(password: string, salt: Uint8Array, logN: number, r: number, p: number): Promise<Uint8Array> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    // Node's default maxmem is 32 MiB, under what logN 16 needs (128 · N · r),
    // and a stored hash may carry a higher logN.
    scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r * 2 }, (error, key) => {
      if (error) reject(error);
      else resolve(new Uint8Array(key.buffer, key.byteOffset, key.byteLength));
    });
  });
}

/**
 * The 96 bytes: `scrypt\0`, logN, r and p big-endian, the 32-byte salt, the
 * first 16 bytes of SHA-256 over those 48, then HMAC-SHA256 over those 64
 * keyed with the second half of the derived key.
 */
function encode(key: Uint8Array, logN: number, r: number, p: number, salt: Uint8Array): Uint8Array {
  const out = new Uint8Array(96);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(7, logN);
  view.setUint32(8, r);
  view.setUint32(12, p);
  out.set(salt, 16);
  out.set(createHash('sha256').update(out.subarray(0, 48)).digest().subarray(0, 16), 48);
  out.set(createHmac('sha256', key.subarray(32)).update(out.subarray(0, 64)).digest(), 64);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
