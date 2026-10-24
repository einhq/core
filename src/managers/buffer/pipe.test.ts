import { assertEquals, assertLess, assertRejects } from '@std/assert';
import { BrokenPipeError } from '@ein/bash-executor';
import { Pipe } from './pipe.ts';

const bytes = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i + seed) % 251);

Deno.test('closing a full pipe wakes a blocked writer', async () => {
  const pipe = new Pipe(1);
  await pipe.write(new Uint8Array([1]));

  const blockedWrite = pipe.write(new Uint8Array([2]));
  await Promise.resolve();
  pipe.close();

  await assertRejects(() => blockedWrite, Error, 'closed');
});

Deno.test('closing a full pipe for reading fails its blocked writer with a broken pipe', async () => {
  const pipe = new Pipe(1);
  await pipe.write(new Uint8Array([1]));

  const blockedWrite = pipe.write(new Uint8Array([2]));
  await Promise.resolve();
  pipe.closeRead();

  await assertRejects(() => blockedWrite, BrokenPipeError);
});

Deno.test('a pipe closed for reading drops what it holds and refuses writes', async () => {
  const pipe = new Pipe(64 * 1024);
  await pipe.write(bytes(4096));

  pipe.closeRead();

  assertEquals(pipe.unread, true);
  assertEquals(pipe.size, 0);
  assertEquals(pipe.allocated, 0);
  await assertRejects(() => pipe.write(bytes(1)), BrokenPipeError);
});

Deno.test('an unused pipe allocates nothing', () => {
  const pipe = new Pipe(64 * 1024);

  assertEquals(pipe.capacity, 64 * 1024);
  assertEquals(pipe.allocated, 0);
});

Deno.test('a pipe allocates for what it holds, not for its capacity', async () => {
  const pipe = new Pipe(64 * 1024);
  await pipe.write(new TextEncoder().encode('hello\n'));

  assertLess(pipe.allocated, 64 * 1024);
  assertEquals(pipe.size, 6);
});

Deno.test('a pipe grows up to capacity and no further', async () => {
  const pipe = new Pipe(4096);
  const written = bytes(4096);

  await pipe.write(written);

  assertEquals(pipe.allocated, 4096);
  assertEquals(pipe.size, 4096);

  // Full: the next write parks until a reader makes room.
  let done = false;
  const blocked = pipe.write(new Uint8Array([1])).then(() => done = true);
  await Promise.resolve();
  assertEquals(done, false);

  assertEquals(await pipe.read(4096), written);
  await blocked;
  assertEquals(pipe.allocated, 4096);
});

Deno.test('growth preserves wrapped content in order', async () => {
  const pipe = new Pipe(64 * 1024);

  // Fill, drain part, then write past the end so the content wraps before the
  // pipe has to grow — the case where growth has to linearize two segments.
  await pipe.write(bytes(1024));
  assertEquals(pipe.allocated, 1024);
  assertEquals(await pipe.read(768), bytes(768));

  const tail = bytes(2048, 7);
  await pipe.write(tail);

  const expected = new Uint8Array([...bytes(1024).subarray(768), ...tail]);
  assertEquals(await pipe.read(expected.length), expected);
});

Deno.test('a reader that keeps up leaves the pipe at its first allocation', async () => {
  const pipe = new Pipe(64 * 1024);

  for (let i = 0; i < 200; i++) {
    await pipe.write(bytes(512, i));
    assertEquals(await pipe.read(512), bytes(512, i));
  }

  assertEquals(pipe.allocated, 1024);
});

Deno.test('a closed, drained pipe gives its bytes back', async () => {
  const pipe = new Pipe(64 * 1024);
  await pipe.write(bytes(4096));
  pipe.close();

  assertEquals((await pipe.read(4096)).length, 4096);
  assertEquals(pipe.allocated, 0);
  assertEquals((await pipe.read(4096)).length, 0, 'still EOF after the release');
});

Deno.test('closing an empty pipe releases immediately', async () => {
  const pipe = new Pipe(64 * 1024);
  await pipe.write(bytes(64));
  assertEquals(await pipe.read(64), bytes(64));

  pipe.close();

  assertEquals(pipe.allocated, 0);
});

Deno.test('a zero-capacity pipe still discards writes and reads EOF', async () => {
  const pipe = new Pipe(0);

  assertEquals(await pipe.write(bytes(32)), 32);
  assertEquals(pipe.allocated, 0);
  assertEquals((await pipe.read(32)).length, 0);
});

Deno.test('a capacity below the first allocation is honoured exactly', async () => {
  const pipe = new Pipe(4);
  await pipe.write(bytes(4));

  assertEquals(pipe.allocated, 4);
  assertEquals(await pipe.read(4), bytes(4));
});

Deno.test('a slow reader gets every byte of a write larger than capacity', async () => {
  const pipe = new Pipe(4096);
  const source = bytes(20_000, 3);

  const writer = pipe.write(source).then(() => pipe.close());

  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await pipe.read(1000);
    if (chunk.length === 0) break;
    chunks.push(chunk);
  }
  await writer;

  assertEquals(new Uint8Array(chunks.flatMap((c) => [...c])), source);
});
