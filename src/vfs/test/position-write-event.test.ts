/**
 * A position handle write emits `updated` with no attr changed, so a subscriber
 * can see a point being written, though writers `ensure` the node (the
 * `created` event) and write the point after.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import type { NodeEvent } from '../mod.ts';

const enc = new TextEncoder();

Deno.test('position write emits updated', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  const events: NodeEvent[] = [];
  const sub = await vfs.subscribe!(() => ADMIN_ACCESS, (event) => {
    events.push(event);
  });

  const settle = () => new Promise((r) => setTimeout(r, 30));
  const updates = (from: number) => events.slice(from).filter((e) => e.type === 'updated' && e.path === '/spot');

  try {
    await vfs.create(ADMIN_ACCESS, 'position', '/', 'spot', { attrs: { name: 'Exempelplats' } });

    await t.step('writing a point emits one updated, attrs untouched', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/spot', { mode: 'w' });
      await h.write(enc.encode(JSON.stringify({ lat: 57.7, lng: 11.9 })));
      await h.close();
      await settle();

      const seen = updates(before);
      assertEquals(seen.length, 1);
      assertEquals(seen[0].node.attrs, seen[0].previousNode?.attrs);
      assertEquals(seen[0].node.attrs.name, 'Exempelplats');
    });

    await t.step('opening for write and closing without a byte emits nothing', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/spot', { mode: 'w' });
      await h.close();
      await settle();

      assertEquals(updates(before).length, 0);
    });

    await t.step('a read emits nothing', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/spot', { mode: 'r' });
      await h.read(8192);
      await h.close();
      await settle();

      assertEquals(updates(before).length, 0);
    });
  } finally {
    await sub.unsubscribe();
    await ctx.dispose();
  }
});
