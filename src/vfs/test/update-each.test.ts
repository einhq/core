/**
 * Batched writes of a different change per node.
 *
 * `updateEach` gives each node its own props and attrs, a batch at a time — one lock set and one
 * transaction per batch — and a node that refuses fails alone. Two changes to one node are made in
 * the order given. Each write is announced and recorded as `update` announces and records one.
 */

import { assert, assertEquals, assertInstanceOf } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAccessDeniedError, type NodeAttrs, type NodeEvent, NodeNotFoundError, NodeReadonlyError } from '../mod.ts';
import { mkdir, mkdirp, mkfile } from './helpers.ts';

const OWNER: Access = { uid: 5000, gid: 4000, gids: [4000] };

/** Wider than WRITE_BATCH (128), so a call spans several transactions. */
const WIDE = 300;

const value = <T>(result: PromiseSettledResult<T>): T => {
  if (result.status === 'rejected') throw new Error(`expected a value, got ${result.reason}`);
  return result.value;
};

const reason = <T>(result: PromiseSettledResult<T>): unknown => {
  if (result.status === 'fulfilled') throw new Error('expected a refusal, got a value');
  return result.reason;
};

Deno.test('VFS updateEach', async (t) => {
  const ctx = await createTestVfs();
  const { vfs, store } = ctx;

  let transactions = 0;
  const begin = store.beginTransaction.bind(store);
  store.beginTransaction = () => {
    transactions++;
    return begin();
  };

  const events: NodeEvent[] = [];
  const subscription = await vfs.subscribe(() => ADMIN_ACCESS, (event) => {
    if (event.type === 'updated') events.push(event);
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  try {
    await t.step('each node gets its own change, one transaction per batch', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/each');
      const paths: string[] = [];
      for (let i = 0; i < WIDE; i++) {
        await vfs.create(ADMIN_ACCESS, 'file', '/each', `f${i}.jpg`, { props: { mode: 0o644 }, attrs: { rank: 0, stale: true } });
        paths.push(`/each/f${i}.jpg`);
      }
      transactions = 0;
      events.length = 0;

      const results = await vfs.updateEach<NodeAttrs>(
        ADMIN_ACCESS,
        paths.map((ref, i) => ({ ref, attrs: { rank: i, stale: null }, ...(i % 2 ? { props: { mode: 0o600 } } : {}) })),
      );

      assertEquals(transactions, Math.ceil(WIDE / 128));
      for (const [i, path] of paths.entries()) {
        const node = await vfs.get(ADMIN_ACCESS, path);
        assertEquals(value(results[i]).id, node.id);
        assertEquals(node.attrs.rank, i);
        // A key given as null is removed.
        assertEquals('stale' in node.attrs, false);
        assertEquals(node.props.mode & 0o777, i % 2 ? 0o600 : 0o644);
      }

      await settle();
      assertEquals(events.length, WIDE);
      assertEquals(events[1].previousNode!.attrs.rank, 0);
      assertEquals(events[1].previousNode!.props.count, events[1].node.props.count);
      assertEquals((await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/each', op: 'update', limit: 1000 })).length, WIDE);
    });

    await t.step('a node that refuses fails alone', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'mixed', 0o777);
      await mkfile(vfs, OWNER, '/mixed', 'mine.txt', 'mine');
      await mkfile(vfs, ADMIN_ACCESS, '/mixed', 'theirs.txt', 'theirs');

      const results = await vfs.updateEach<NodeAttrs>(OWNER, [
        { ref: '/mixed/mine.txt', attrs: { label: 'a' } },
        { ref: '/mixed/theirs.txt', attrs: { label: 'b' } },
        { ref: '/mixed/gone.txt', attrs: { label: 'c' } },
      ]);

      assertEquals(value(results[0]).attrs.label, 'a');
      assertInstanceOf(reason(results[1]), NodeAccessDeniedError);
      assertInstanceOf(reason(results[2]), NodeNotFoundError);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/mixed/theirs.txt')).attrs.label, undefined);
    });

    await t.step('two changes to one node are made in order', async () => {
      transactions = 0;
      const results = await vfs.updateEach<NodeAttrs>(ADMIN_ACCESS, [
        { ref: '/mixed/mine.txt', attrs: { label: 'first', kept: 1 } },
        { ref: '/mixed/theirs.txt', attrs: { label: 'other' } },
        { ref: '/mixed/mine.txt', attrs: { label: 'second' } },
      ]);

      assertEquals(results.map((result) => value(result).attrs.label), ['first', 'other', 'second']);
      const mine = await vfs.get(ADMIN_ACCESS, '/mixed/mine.txt');
      assertEquals([mine.attrs.label, mine.attrs.kept], ['second', 1]);
      // The second change to the node starts a batch of its own.
      assertEquals(transactions, 2);
    });

    await t.step('a softlink is changed itself with readlink', async () => {
      await vfs.create(ADMIN_ACCESS, 'softlink', '/mixed', 'to-mine', { props: { mode: 0o777, softlink: '/mixed/mine.txt' } });

      const [result] = await vfs.updateEach(ADMIN_ACCESS, [{ ref: '/mixed/to-mine', readlink: true, props: { softlink: '/mixed/theirs.txt' } }]);

      assertEquals(value(result).props.softlink, '/mixed/theirs.txt');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/mixed/to-mine')).id, (await vfs.get(ADMIN_ACCESS, '/mixed/theirs.txt')).id);
    });

    await t.step('paths in one directory cost one walk to it, not one each', async () => {
      let lookups = 0;
      const getChildren = store.getChildren.bind(store);
      store.getChildren = (...args) => {
        lookups++;
        return getChildren(...args);
      };
      try {
        const paths = Array.from({ length: WIDE }, (_, i) => `/each/f${i}.jpg`);
        const results = await vfs.updateEach<NodeAttrs>(ADMIN_ACCESS, paths.map((ref) => ({ ref, attrs: { walked: true } })));

        assertEquals(results.filter((result) => value(result).attrs.walked).length, WIDE);
        assert(lookups < 5, `${lookups} lookups for ${WIDE} paths`);
      } finally {
        store.getChildren = getChildren;
      }
    });

    await t.step('a softlink among paths found together is followed, unless read itself', async () => {
      await vfs.create(ADMIN_ACCESS, 'softlink', '/mixed', 'link-a', { props: { mode: 0o777, softlink: '/mixed/mine.txt' } });
      await vfs.create(ADMIN_ACCESS, 'softlink', '/mixed', 'link-b', { props: { mode: 0o777, softlink: '/mixed/mine.txt' } });

      const followed = await vfs.updateEach<NodeAttrs>(ADMIN_ACCESS, [
        { ref: '/mixed/link-a', attrs: { via: 'a' } },
        { ref: '/mixed/link-b', attrs: { via: 'b' } },
      ]);
      const mine = await vfs.get(ADMIN_ACCESS, '/mixed/mine.txt');
      assertEquals(followed.map((result) => value(result).id), [mine.id, mine.id]);
      assertEquals(mine.attrs.via, 'b');

      const read = await vfs.updateEach<NodeAttrs>(ADMIN_ACCESS, [
        { ref: '/mixed/link-a', readlink: true, attrs: { via: 'self' } },
        { ref: '/mixed/link-b', readlink: true, attrs: { via: 'self' } },
      ]);
      assertEquals(read.map((result) => value(result).props.softlink), ['/mixed/mine.txt', '/mixed/mine.txt']);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/mixed/mine.txt')).attrs.via, 'b');
    });

    await t.step('a mounted node is written by its own VFS, and a read-only one is refused', async () => {
      const mounted = await createTestVfs();
      const readonly = await createTestVfs();
      try {
        await mkdir(vfs, ADMIN_ACCESS, '/', 'mnt');
        await mkdir(vfs, ADMIN_ACCESS, '/', 'ro');
        await vfs.mount(ADMIN_ACCESS, '/mnt', mounted.vfs);
        await vfs.mount(ADMIN_ACCESS, '/ro', readonly.vfs, { readonly: true });
        await vfs.create(ADMIN_ACCESS, 'file', '/mnt', 'far.jpg', { props: { mode: 0o644 } });
        await readonly.vfs.create(ADMIN_ACCESS, 'file', '/', 'fixed.jpg', { props: { mode: 0o644 } });

        await vfs.create(ADMIN_ACCESS, 'file', '/mnt', 'also.jpg', { props: { mode: 0o644 } });

        const results = await vfs.updateEach<NodeAttrs>(ADMIN_ACCESS, [
          { ref: '/mnt/far.jpg', attrs: { label: 'far' } },
          { ref: '/ro/fixed.jpg', attrs: { label: 'fixed' } },
          { ref: '/mixed/mine.txt', attrs: { label: 'near' } },
          { ref: '/mnt/also.jpg', attrs: { label: 'also' } },
        ]);

        assertEquals(value(results[0]).attrs.label, 'far');
        assertEquals((await mounted.vfs.get(ADMIN_ACCESS, '/also.jpg')).attrs.label, 'also');
        assertEquals((await mounted.vfs.get(ADMIN_ACCESS, '/far.jpg')).attrs.label, 'far');
        assertInstanceOf(reason(results[1]), NodeReadonlyError);
        assertEquals(value(results[2]).attrs.label, 'near');
      } finally {
        await mounted.dispose();
        await readonly.dispose();
      }
    });
  } finally {
    await subscription.unsubscribe();
    await ctx.dispose();
  }
});
