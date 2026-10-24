/**
 * Streaming SHA-256, on the platform's native implementation.
 *
 * Several registries hash the same way — read a file or blob in 64 KB chunks,
 * update, hex-digest — and `file-sync` puts that on the crawl's hot path
 * several times per media file, all of it main-thread CPU. A pure-JS hash is
 * an order of magnitude slower than `node:crypto`'s native `createHash`.
 *
 * `crypto.subtle.digest` is *not* the answer here despite being the obvious web
 * API: it takes a whole BufferSource and rejects an async iterable, so it
 * cannot hash a stream without buffering the entire file.
 *
 * `@noble/hashes` stays in `deno.jsonc` for the tests: an independent pure-JS
 * implementation asserting against this one is what catches a divergence.
 */

import { createHash } from 'node:crypto';

export type Sha256Hasher = {
  update(chunk: Uint8Array): void;
  /** Lowercase hex digest. Finalises the hasher — call once. */
  hex(): string;
  /**
   * Digest of everything fed so far, leaving the hasher usable.
   *
   * For a writer that reports at every flush point rather than only at close:
   * `hex()` finalises, so a handle that sync'd mid-write could not go on
   * hashing. Backed by `Hash.copy()`, which is the native path and costs a
   * clone of the 32-byte state rather than a re-read.
   */
  peekHex(): string;
};

export const createSha256 = (): Sha256Hasher => {
  const hash = createHash('sha256');

  return {
    update: (chunk: Uint8Array) => {
      hash.update(chunk);
    },
    hex: () => hash.digest('hex'),
    peekHex: () => hash.copy().digest('hex'),
  };
};
