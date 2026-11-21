import { assertEquals, assertRejects } from '@std/assert';
import { BodyTooLargeError, readBody } from '../body-limit.ts';

const chunked = (chunks: number, size: number, pulled: { bytes: number; cancelled: boolean }) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.bytes >= chunks * size) return controller.close();
      pulled.bytes += size;
      controller.enqueue(new Uint8Array(size).fill(1));
    },
    cancel() {
      pulled.cancelled = true;
    },
  }, { highWaterMark: 0 });

Deno.test('a body within its limit is read whole', async () => {
  const pulled = { bytes: 0, cancelled: false };
  const bytes = await readBody(new Request('http://x/', { method: 'POST', body: chunked(4, 10, pulled) }), 40);
  assertEquals([bytes.length, bytes.every((byte) => byte === 1)], [40, true]);
});

Deno.test('a body that grows past its limit is cancelled there', async () => {
  const pulled = { bytes: 0, cancelled: false };
  await assertRejects(() => readBody(new Request('http://x/', { method: 'POST', body: chunked(1000, 10, pulled) }), 35), BodyTooLargeError);
  assertEquals([pulled.bytes, pulled.cancelled], [40, true]);
});

Deno.test('a declared length over the limit is refused before anything is read', async () => {
  const req = new Request('http://x/', { method: 'POST', body: 'x'.repeat(100), headers: { 'content-length': '100' } });
  await assertRejects(() => readBody(req, 50), BodyTooLargeError);
});

Deno.test('no body is an empty one', async () => {
  assertEquals((await readBody(new Request('http://x/'), 10)).length, 0);
});
