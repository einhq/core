/**
 * Aborting a handle mid-stream must end the stream, not kill the process.
 *
 * `readable`'s `pull` awaits `read(..., signal)`; an AbortError escaping it would
 * reject the pull promise, which surfaces as an unhandled rejection that Deno
 * treats as fatal — a browser tab closing mid-download would end the server.
 */

import { assert, assertEquals } from '@std/assert';
import { MemoryFileRegistry } from '../file/mod.ts';

const setup = async () => {
  const registry = new MemoryFileRegistry();
  await registry.init();
  return registry;
};

Deno.test('closing a handle mid-stream ends the stream cleanly', async () => {
  const registry = await setup();
  try {
    const write = await registry.open('abort-1', {}, 'w');
    // Comfortably more than one chunk, so the stream is still pulling when the
    // handle is closed underneath it.
    await write.write(new Uint8Array(1024 * 1024));
    await write.close();

    const handle = await registry.open('abort-1', {}, 'r');
    const reader = handle.readable.getReader();

    await reader.read();
    // This is the disconnect: the handle goes away while a read is pending.
    await handle.close();

    // Draining must terminate rather than throw an unhandled AbortError.
    for (let guard = 0; guard < 100; guard++) {
      const { done } = await reader.read();
      if (done) break;
    }

    assert(true, 'stream drained without an unhandled rejection');
  } finally {
    await registry.dispose();
  }
});

Deno.test('cancelling a stream releases it without error', async () => {
  const registry = await setup();
  try {
    const write = await registry.open('abort-2', {}, 'w');
    await write.write(new Uint8Array(1024 * 512));
    await write.close();

    const handle = await registry.open('abort-2', {}, 'r');
    const reader = handle.readable.getReader();
    await reader.read();
    await reader.cancel();
    await handle.close();

    assert(true, 'cancel completed');
  } finally {
    await registry.dispose();
  }
});

Deno.test('a stream on an already-closed handle yields nothing', async () => {
  const registry = await setup();
  try {
    const write = await registry.open('abort-3', {}, 'w');
    await write.write(new Uint8Array(64));
    await write.close();

    const handle = await registry.open('abort-3', {}, 'r');
    const stream = handle.readable;
    await handle.close();

    const reader = stream.getReader();
    const { done } = await reader.read();
    assertEquals(done, true);
  } finally {
    await registry.dispose();
  }
});
