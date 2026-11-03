/**
 * A change to a track's fixes through the VFS — points appended, marked by hand,
 * moved to another track — emits `updated` with no attr changed, so a subscriber
 * can follow a track as it grows and derive again what it derived from it.
 */

import { assertEquals, assertInstanceOf } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { TrackHandle } from '../../registries/track/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import type { NodeEvent } from '../mod.ts';

const enc = new TextEncoder();

Deno.test("a change to a track's fixes emits updated", async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  const events: NodeEvent[] = [];
  const sub = await vfs.subscribe!(() => ADMIN_ACCESS, (event) => {
    events.push(event);
  });

  const settle = () => new Promise((r) => setTimeout(r, 30));
  const updates = (from: number, path = '/route') => events.slice(from).filter((e) => e.type === 'updated' && e.path === path);
  const fix = (minute: number) => ({ lat: 57.7 + minute / 1000, lng: 11.9, ts: new Date(Date.UTC(2026, 5, 1, 10, minute)).toISOString() });

  const appendOnce = async (points: ReturnType<typeof fix>[]) => {
    const h = await vfs.open(ADMIN_ACCESS, '/route', { mode: 'a' });
    assertInstanceOf(h, TrackHandle);
    const written = await h.appendPoints(points);
    await h.close();
    await settle();
    return written;
  };

  try {
    await vfs.create(ADMIN_ACCESS, 'track', '/', 'route', { attrs: { name: 'Exempelresa' } });

    await t.step('appending points emits one updated, attrs untouched', async () => {
      const before = events.length;
      assertEquals(await appendOnce([fix(0), fix(1)]), 2);

      const seen = updates(before);
      assertEquals(seen.length, 1);
      assertEquals(seen[0].node.attrs, seen[0].previousNode?.attrs);
      assertEquals(seen[0].node.attrs.name, 'Exempelresa');
    });

    await t.step('an append of only duplicates emits nothing', async () => {
      const before = events.length;
      assertEquals(await appendOnce([fix(0), fix(1)]), 0);

      assertEquals(updates(before).length, 0);
    });

    await t.step('many appends on one open handle emit one updated until it closes', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/route', { mode: 'a' });
      assertInstanceOf(h, TrackHandle);
      await h.appendPoints([fix(10)]);
      await h.appendPoints([fix(11)]);
      await h.appendPoints([fix(12)]);
      await settle();
      assertEquals(updates(before).length, 1);

      await h.close();
      await settle();
      assertEquals(updates(before).length, 2);
    });

    await t.step('JSONL written through the byte stream emits updated', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/route', { mode: 'a' });
      await h.write(enc.encode(JSON.stringify(fix(20)) + '\n' + JSON.stringify(fix(21)) + '\n'));
      await h.close();
      await settle();

      assertEquals(updates(before).length, 1);
    });

    await t.step('opening for append and closing without a point emits nothing', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/route', { mode: 'a' });
      await h.close();
      await settle();

      assertEquals(updates(before).length, 0);
    });

    await t.step('a verdict given by hand emits updated, and one that changes nothing emits nothing', async () => {
      const h = await vfs.open(ADMIN_ACCESS, '/route', { mode: 'a' });
      assertInstanceOf(h, TrackHandle);
      const before = events.length;
      assertEquals(await h.markPoints({ from: fix(10).ts, to: fix(11).ts }, 'reject'), 1);
      assertEquals(await h.markPoints({ from: fix(10).ts, to: fix(11).ts }, 'reject'), 0);
      await h.close();
      await settle();

      assertEquals(updates(before).length, 1);
    });

    await t.step('a move emits updated on both tracks', async () => {
      await vfs.create(ADMIN_ACCESS, 'track', '/', 'other', {});
      const from = await vfs.open(ADMIN_ACCESS, '/route', { mode: 'a' });
      const to = await vfs.open(ADMIN_ACCESS, '/other', { mode: 'a' });
      assertInstanceOf(from, TrackHandle);
      assertInstanceOf(to, TrackHandle);
      const before = events.length;
      assertEquals(await from.movePoints({ from: fix(20).ts }, to), 2);
      await from.close();
      await to.close();
      await settle();

      assertEquals(updates(before).length, 1);
      assertEquals(updates(before, '/other').length, 1);
    });

    await t.step('a read emits nothing', async () => {
      const before = events.length;
      const h = await vfs.open(ADMIN_ACCESS, '/route', { mode: 'r' });
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
