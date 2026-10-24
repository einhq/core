/**
 * Batched writes and listings.
 *
 * `updateMany` writes many nodes a batch at a time — one lock set and one transaction per batch,
 * never one for the lot — and a node that refuses fails alone. `childrenMany` lists many
 * directories in one read, each checked as `children` checks it. Both hand what lies in a mount to
 * that mount and answer in the order they were asked.
 */

import { assert, assertEquals, assertInstanceOf } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { assertAccess, type Node, NodeAccessDeniedError, type NodeEvent, NodeNotFoundError, NodeReadonlyError, NodeTierImmutableError } from '../mod.ts';
import { mkdir, mkfile } from './helpers.ts';

const OWNER: Access = { uid: 5000, gid: 4000, gids: [4000] };

/** Wider than WRITE_BATCH (128), so a call spans several transactions. */
const WIDE = 300;

const modeOf = (node: Node) => node.props.mode & 0o777;

/** The value of a fulfilled result, or the test fails saying why it was not. */
const value = <T>(result: PromiseSettledResult<T>): T => {
  if (result.status === 'rejected') throw new Error(`expected a value, got ${result.reason}`);
  return result.value;
};

const reason = <T>(result: PromiseSettledResult<T>): unknown => {
  if (result.status === 'fulfilled') throw new Error('expected a refusal, got a value');
  return result.reason;
};

Deno.test('VFS updateMany', async (t) => {
  const ctx = await createTestVfs();
  const { vfs, store } = ctx;

  let transactions = 0;
  const begin = store.beginTransaction.bind(store);
  store.beginTransaction = () => {
    transactions++;
    return begin();
  };

  const events: NodeEvent[] = [];
  let onUpdated = (_event: NodeEvent) => {};
  const subscription = await vfs.subscribe(() => ADMIN_ACCESS, (event) => {
    if (event.type !== 'updated') return;
    events.push(event);
    onUpdated(event);
  });

  /** `count` directories under a new `/name`, all at `mode`. */
  const wide = async (name: string, count: number, mode = 0o755) => {
    await mkdir(vfs, ADMIN_ACCESS, '/', name);
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      await mkdir(vfs, ADMIN_ACCESS, `/${name}`, `d${i}`, mode);
      paths.push(`/${name}/d${i}`);
    }
    return paths;
  };

  try {
    await t.step('every node is written, one transaction per batch', async () => {
      const paths = await wide('wide', WIDE);
      transactions = 0;
      events.length = 0;

      const results = await vfs.updateMany(ADMIN_ACCESS, paths, { props: { mode: 0o750 } });

      assertEquals(transactions, Math.ceil(WIDE / 128));
      assertEquals(results.length, WIDE);
      for (const [i, path] of paths.entries()) {
        assertEquals(value(results[i]).id, (await vfs.get(ADMIN_ACCESS, path)).id);
        assertEquals(modeOf(value(results[i])), 0o750);
      }

      // Each write is announced and recorded as `update` announces and records one.
      assertEquals(events.length, WIDE);
      assertEquals(modeOf(events[0].previousNode!), 0o755);
      assertEquals(events[0].previousNode!.props.count, events[0].node.props.count);
      assertEquals((await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/wide', op: 'update', limit: 1000 })).length, WIDE);
    });

    await t.step('a node that refuses fails alone', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'mixed', 0o777);
      await mkfile(vfs, OWNER, '/mixed', 'mine.txt', 'mine', 0o644);
      await mkfile(vfs, ADMIN_ACCESS, '/mixed', 'theirs.txt', 'theirs', 0o644);

      const results = await vfs.updateMany(OWNER, ['/mixed/mine.txt', '/mixed/theirs.txt', '/mixed/gone.txt'], { props: { mode: 0o600 } });

      assertEquals(modeOf(value(results[0])), 0o600);
      assertInstanceOf(reason(results[1]), NodeAccessDeniedError);
      assertInstanceOf(reason(results[2]), NodeNotFoundError);
      assertEquals(modeOf(await vfs.get(ADMIN_ACCESS, '/mixed/theirs.txt')), 0o644);
    });

    await t.step('the guard refuses for a caller writing with more authority than its own', async () => {
      const results = await vfs.updateMany(ADMIN_ACCESS, ['/mixed/mine.txt', '/mixed/theirs.txt'], {
        props: { gid: 4000 },
        guard: (node) => assertAccess(OWNER, node, 'w'),
      });

      assertEquals(value(results[0]).props.gid, 4000);
      assertInstanceOf(reason(results[1]), NodeAccessDeniedError);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/mixed/theirs.txt')).props.gid, 0);
    });

    await t.step('a node reached by two names is written once', async () => {
      await vfs.link(ADMIN_ACCESS, '/mixed/mine.txt', '/mixed', 'also-mine.txt');
      events.length = 0;

      const results = await vfs.updateMany(ADMIN_ACCESS, ['/mixed/mine.txt', '/mixed/also-mine.txt'], { props: { mode: 0o640 } });

      assertEquals(value(results[0]).id, value(results[1]).id);
      assertEquals(events.map((event) => event.path), ['/mixed/mine.txt']);
    });

    await t.step('an abort stops it between batches', async () => {
      const paths = await wide('stop', WIDE);
      const controller = new AbortController();
      onUpdated = () => controller.abort();

      try {
        const results = await vfs.updateMany(ADMIN_ACCESS, paths, { props: { mode: 0o700 }, signal: controller.signal });

        // The batch under way when it aborted finishes; nothing after it starts.
        const written = results.filter((result) => result.status === 'fulfilled').length;
        assertEquals(written, 128);
        assert(results.slice(written).every((result) => reason(result) === controller.signal.reason));
        assertEquals(modeOf(await vfs.get(ADMIN_ACCESS, paths[WIDE - 1])), 0o755);
      } finally {
        onUpdated = () => {};
      }
    });

    await t.step('a mounted node is written by its own VFS, and a read-only one is refused', async () => {
      const mounted = await createTestVfs();
      const readonly = await createTestVfs();
      try {
        await mkfile(mounted.vfs, ADMIN_ACCESS, '/', 'x.txt', 'x', 0o644);
        await mkfile(readonly.vfs, ADMIN_ACCESS, '/', 'y.txt', 'y', 0o644);
        await mkdir(vfs, ADMIN_ACCESS, '/', 'm');
        await mkdir(vfs, ADMIN_ACCESS, '/', 'ro');
        await vfs.mount(ADMIN_ACCESS, '/m', mounted.vfs);
        await vfs.mount(ADMIN_ACCESS, '/ro', readonly.vfs, { readonly: true });

        const results = await vfs.updateMany(ADMIN_ACCESS, ['/m/x.txt', '/ro/y.txt', '/mixed/theirs.txt'], { props: { mode: 0o600 } });

        assertEquals(modeOf(value(results[0])), 0o600);
        assertEquals(modeOf(await mounted.vfs.get(ADMIN_ACCESS, '/x.txt')), 0o600);
        assertInstanceOf(reason(results[1]), NodeReadonlyError);
        assertEquals(modeOf(value(results[2])), 0o600);
      } finally {
        await vfs.unmount(ADMIN_ACCESS, '/m');
        await vfs.unmount(ADMIN_ACCESS, '/ro');
      }
    });

    await t.step('a tier sent back unchanged is no change, and a new one is refused', async () => {
      await vfs.create(ADMIN_ACCESS, 'file', '/', 'tiered.txt', { props: { tier: 'db' } });

      const [same] = await vfs.updateMany(ADMIN_ACCESS, ['/tiered.txt'], { props: { tier: 'db', mode: 0o600 } });
      const [moved] = await vfs.updateMany(ADMIN_ACCESS, ['/tiered.txt'], { props: { tier: 'disk' } });

      assertEquals(modeOf(value(same)), 0o600);
      assertInstanceOf(reason(moved), NodeTierImmutableError);
    });
  } finally {
    await subscription.unsubscribe();
    await ctx.dispose();
  }
});

Deno.test('VFS childrenMany', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'lists', 0o755);
    await mkdir(vfs, ADMIN_ACCESS, '/lists', 'two', 0o755);
    await mkfile(vfs, ADMIN_ACCESS, '/lists/two', 'b.txt', 'b');
    await mkfile(vfs, ADMIN_ACCESS, '/lists/two', 'a.txt', 'a');
    await mkdir(vfs, ADMIN_ACCESS, '/lists', 'empty', 0o755);
    await mkdir(vfs, ADMIN_ACCESS, '/lists', 'closed', 0o700);
    await mkfile(vfs, ADMIN_ACCESS, '/lists/closed', 'secret.txt', 's');

    await t.step('each directory is listed as children lists it, in the order asked', async () => {
      const results = await vfs.childrenMany(ADMIN_ACCESS, ['/lists/two', '/lists/empty', '/lists']);

      assertEquals(value(results[0]).map((child) => child.name), (await vfs.children(ADMIN_ACCESS, '/lists/two')).map((child) => child.name));
      assertEquals(value(results[1]), []);
      assertEquals(value(results[2]).find((child) => child.name === 'two')?.childCount, 2);
    });

    await t.step('a directory the caller cannot list fails alone', async () => {
      const results = await vfs.childrenMany(OWNER, ['/lists/closed', '/lists/two', '/lists/gone']);

      assertInstanceOf(reason(results[0]), NodeAccessDeniedError);
      assertEquals(value(results[1]).length, 2);
      assertInstanceOf(reason(results[2]), NodeNotFoundError);
    });

    await t.step('a mount point is listed as the mounted root, and listed by its own VFS', async () => {
      const mounted = await createTestVfs();
      try {
        await mkfile(mounted.vfs, ADMIN_ACCESS, '/', 'inside.txt', 'in');
        await mkdir(vfs, ADMIN_ACCESS, '/lists', 'm');
        await vfs.mount(ADMIN_ACCESS, '/lists/m', mounted.vfs);

        const [lists, inside] = await vfs.childrenMany(ADMIN_ACCESS, ['/lists', '/lists/m']);

        assertEquals(value(lists).find((child) => child.name === 'm')?.node.id, mounted.vfs.rootId);
        assertEquals(value(inside).map((child) => child.name), ['inside.txt']);
      } finally {
        await vfs.unmount(ADMIN_ACCESS, '/lists/m');
      }
    });
  } finally {
    await ctx.dispose();
  }
});
