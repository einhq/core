/**
 * A writable handle whose node is deleted before it closes: the bookkeeping the close does on the
 * node (a file's size and digest, a position's `updated` report) has nothing to update, and that
 * is not logged as an error.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';

const enc = new TextEncoder();

/** Runs `fn` and returns what it wrote to `console.error`. */
async function errorsDuring(fn: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const seen: string[] = [];
  console.error = (...args: unknown[]) => void seen.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return seen;
}

Deno.test('a write that closes after its node is deleted', async (t) => {
  const { vfs } = await createTestVfs();

  await t.step('a file logs no error', async () => {
    await vfs.create(ADMIN_ACCESS, 'file', '/', 'gone.bin', {
      attrs: { name: 'gone.bin', mimetype: 'application/octet-stream', size: 0 },
    });
    const errors = await errorsDuring(async () => {
      const handle = await vfs.open(ADMIN_ACCESS, '/gone.bin', { mode: 'w' });
      await handle.write(enc.encode('hello'));
      await vfs.unlink(ADMIN_ACCESS, '/gone.bin', '/');
      await handle.close().catch(() => {});
    });
    assertEquals(errors.filter((line) => line.includes('size tracking')), []);
  });

  await t.step('a position logs no error', async () => {
    await vfs.create(ADMIN_ACCESS, 'file', '/', 'photo.jpg', {
      attrs: { name: 'photo.jpg', mimetype: 'image/jpeg', size: 0 },
    });
    await vfs.create(ADMIN_ACCESS, 'position', '/photo.jpg', 'position', { props: { mode: 0o775 } });
    const errors = await errorsDuring(async () => {
      const handle = await vfs.open(ADMIN_ACCESS, '/photo.jpg/position', { mode: 'w' });
      await handle.write(enc.encode(JSON.stringify({ lat: 57.72, lng: 11.92 })));
      await vfs.unlink(ADMIN_ACCESS, '/photo.jpg', '/', { recursive: true });
      await handle.close().catch(() => {});
    });
    assertEquals(errors.filter((line) => line.includes('position write report')), []);
  });
});
