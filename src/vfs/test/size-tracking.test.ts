/**
 * Write-time size tracking: writable file handles refresh attrs.size on
 * flush (close/sync) and emit an 'updated' event, so followers can subscribe
 * instead of polling.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import type { NodeEvent } from '../mod.ts';

const enc = new TextEncoder();

Deno.test('write-time size tracking', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  const events: NodeEvent[] = [];
  const sub = await vfs.subscribe!(() => ADMIN_ACCESS, (event) => {
    events.push(event);
  });

  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting for event');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  try {
    await t.step('file close updates attrs.size and emits updated', async () => {
      await vfs.create(ADMIN_ACCESS, 'file', '/', 'f.txt', {
        attrs: { name: 'f.txt', mimetype: 'text/plain', size: 0 },
      });

      const h = await vfs.open(ADMIN_ACCESS, '/f.txt', { mode: 'w' });
      await h.write(enc.encode('hello'));
      await h.close();

      const node = await vfs.get(ADMIN_ACCESS, '/f.txt');
      assertEquals(node.attrs.size, 5);
      await waitFor(() => events.some((e) => e.type === 'updated' && e.path === '/f.txt' && e.node.attrs.size === 5));
    });

    await t.step('append grows size and emits another updated', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/f.txt', { mode: 'a' });
      await h.write(enc.encode(' world'));
      await h.close();

      const node = await vfs.get(ADMIN_ACCESS, '/f.txt');
      assertEquals(node.attrs.size, 11);
      await waitFor(() => events.slice(before).some((e) => e.type === 'updated' && e.node.attrs.size === 11));
    });

    await t.step('no-op write does not update or emit', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/f.txt', { mode: 'a' });
      await h.close();
      await new Promise((r) => setTimeout(r, 30));

      assertEquals(events.length, before);
      const node = await vfs.get(ADMIN_ACCESS, '/f.txt');
      assertEquals(node.attrs.size, 11);
    });

    // A same-length rewrite moves the bytes without moving attrs.size — the node
    // write still has to happen, since modtime and the event ride on it.
    await t.step('same-length overwrite bumps modtime and emits', async () => {
      const before = events.length;
      const mtBefore = (await vfs.get(ADMIN_ACCESS, '/f.txt')).props.modtime.timestamp;
      await new Promise((r) => setTimeout(r, 10));

      const h = await vfs.open(ADMIN_ACCESS, '/f.txt', { mode: 'r+' });
      await h.write(enc.encode('HELLO WORLD'));
      await h.close();

      const node = await vfs.get(ADMIN_ACCESS, '/f.txt');
      assertEquals(node.attrs.size, 11);
      assert(node.props.modtime.timestamp > mtBefore, 'modtime did not move');
      await waitFor(() => events.slice(before).some((e) => e.type === 'updated' && e.path === '/f.txt'));
    });

    await t.step('same-length overwrite through the writable stream also counts', async () => {
      const before = events.length;
      const mtBefore = (await vfs.get(ADMIN_ACCESS, '/f.txt')).props.modtime.timestamp;
      await new Promise((r) => setTimeout(r, 10));

      const h = await vfs.open(ADMIN_ACCESS, '/f.txt', { mode: 'r+' });
      const writer = h.writable.getWriter();
      await writer.write(enc.encode('hello world'));
      await writer.close();
      await h.close();

      const node = await vfs.get(ADMIN_ACCESS, '/f.txt');
      assertEquals(node.attrs.size, 11);
      assert(node.props.modtime.timestamp > mtBefore, 'modtime did not move');
      await waitFor(() => events.slice(before).some((e) => e.type === 'updated' && e.path === '/f.txt'));
    });

    // The truncation happens inside the registry open, so the handle's start size
    // is already 0 — only the mode says the content changed.
    await t.step("a 'w' open that writes nothing still empties attrs.size", async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/f.txt', { mode: 'w' });
      await h.close();

      const node = await vfs.get(ADMIN_ACCESS, '/f.txt');
      assertEquals(node.attrs.size, 0);
      await waitFor(() => events.slice(before).some((e) => e.type === 'updated' && e.path === '/f.txt' && e.node.attrs.size === 0));
    });

    await t.step('db-tier file close updates attrs.size', async () => {
      await vfs.create(ADMIN_ACCESS, 'file', '/', 'b.bin', {
        props: { tier: 'db' },
        attrs: { name: 'b.bin', mimetype: 'application/octet-stream', size: 0 },
      });

      const h = await vfs.open(ADMIN_ACCESS, '/b.bin', { mode: 'w' });
      await h.write(enc.encode('abcd'));
      await h.close();

      const node = await vfs.get(ADMIN_ACCESS, '/b.bin');
      assertEquals(node.attrs.size, 4);
    });
  } finally {
    await sub.unsubscribe();
    await ctx.dispose();
  }
});
