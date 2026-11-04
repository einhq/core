/**
 * `createSha256Stream`: the digest of the bytes fed, whether they stay in the
 * first batch or go to the hashing thread in several, copied or handed over.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { createSha256Stream } from '../mod.ts';

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** `length` bytes that differ from one position to the next. */
const bytes = (length: number): Uint8Array => {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
  return data;
};

/** Feeds data to stream in chunks of chunkSize. */
const feed = (stream: ReturnType<typeof createSha256Stream>, data: Uint8Array, chunkSize: number) => {
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    stream.update(data.subarray(offset, offset + chunkSize));
  }
};

Deno.test('sha256 stream', async (t) => {
  await t.step('a stream that gets nothing digests nothing', async () => {
    const stream = createSha256Stream();
    assertEquals(await stream.peekHex(), sha256Hex(new Uint8Array()));
    stream.free();
  });

  await t.step('a small stream digests what it got', async () => {
    const data = bytes(40_000);
    const stream = createSha256Stream();
    feed(stream, data, 999);
    assertEquals(await stream.peekHex(), sha256Hex(data));
    stream.free();
  });

  for (const chunkSize of [32_768, 31_952, 300_000, 3 * 1024 * 1024]) {
    await t.step(`several batches in ${chunkSize}-byte chunks digest as one`, async () => {
      const data = bytes(3 * 1024 * 1024 + 17);
      const stream = createSha256Stream();
      feed(stream, data, chunkSize);
      assertEquals(await stream.peekHex(), sha256Hex(data));
      stream.free();
    });
  }

  await t.step('a digest mid-stream leaves it usable', async () => {
    const data = bytes(1024 * 1024 + 5);
    const half = 600_000;
    const stream = createSha256Stream();
    feed(stream, data.subarray(0, half), 32_768);
    assertEquals(await stream.peekHex(), sha256Hex(data.subarray(0, half)));
    feed(stream, data.subarray(half), 32_768);
    assertEquals(await stream.peekHex(), sha256Hex(data));
    stream.free();
  });

  await t.step('the bytes are copied: a chunk reused after update does not change the digest', async () => {
    const data = bytes(700_000);
    const stream = createSha256Stream();
    const chunk = new Uint8Array(70_000);
    for (let offset = 0; offset < data.length; offset += chunk.length) {
      chunk.set(data.subarray(offset, offset + chunk.length));
      stream.update(chunk);
      chunk.fill(0);
    }
    assertEquals(await stream.peekHex(), sha256Hex(data));
    stream.free();
  });

  /**
   * Feeds data in chunks of chunkSize, handing over each buffer `given` says
   * to, in a buffer of its own; the others are copied from a reused one.
   */
  const feedMixed = (
    stream: ReturnType<typeof createSha256Stream>,
    data: Uint8Array,
    chunkSize: number,
    given: (index: number) => boolean,
  ) => {
    const reused = new Uint8Array(chunkSize);
    for (let offset = 0, index = 0; offset < data.length; offset += chunkSize, index++) {
      const piece = data.subarray(offset, offset + chunkSize);
      if (given(index)) {
        const own = piece.slice();
        stream.update(own, true);
        // Handed over before the batch holding it went: taken away or still whole.
        assertEquals(own.byteLength === 0 || own.byteLength === piece.length, true);
      } else {
        reused.set(piece);
        stream.update(reused.subarray(0, piece.length));
        reused.fill(0);
      }
    }
  };

  for (
    const [name, length, given] of [
      ['all handed over, under a batch', 500_000, () => true],
      ['all handed over, several batches', 3 * 1024 * 1024 + 17, () => true],
      ['handed over and copied in turn', 3 * 1024 * 1024 + 17, (i: number) => i % 2 === 0],
      ['mostly handed over, a copy now and then', 3 * 1024 * 1024 + 17, (i: number) => i % 7 !== 3],
      ['copied, then handed over while the first batch grows', 200_000, (i: number) => i >= 3],
    ] as const
  ) {
    await t.step(`chunks ${name} digest in order`, async () => {
      const data = bytes(length);
      const stream = createSha256Stream();
      feedMixed(stream, data, 32_739, given);
      assertEquals(await stream.peekHex(), sha256Hex(data));
      stream.free();
    });
  }

  await t.step('a handed-over buffer goes to the hashing thread as it is', async () => {
    const stream = createSha256Stream();
    const chunks = Array.from({ length: 40 }, (_, i) => bytes(32_768 + i));
    for (const chunk of chunks) stream.update(chunk, true);
    // Over a batch's worth went, taking the buffers with it.
    assertEquals(chunks[0].byteLength, 0);
    stream.free();
  });

  await t.step('streams fed in turn keep their own digests', async () => {
    const a = bytes(900_000);
    const b = bytes(1_100_000).reverse();
    const sa = createSha256Stream();
    const sb = createSha256Stream();
    for (let offset = 0; offset < b.length; offset += 50_000) {
      sa.update(a.subarray(offset, offset + 50_000));
      sb.update(b.subarray(offset, offset + 50_000));
    }
    assertEquals(await Promise.all([sa.peekHex(), sb.peekHex()]), [sha256Hex(a), sha256Hex(b)]);
    sa.free();
    sb.free();
  });

  await t.step('a freed stream refuses a digest rather than give a wrong one', async () => {
    for (const length of [10, 1024 * 1024]) {
      const stream = createSha256Stream();
      stream.update(bytes(length));
      stream.free();
      await assertRejects(() => stream.peekHex());
    }
  });
});
