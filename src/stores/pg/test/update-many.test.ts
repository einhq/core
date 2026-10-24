/**
 * PG tier: batched writes and listings.
 *
 * `updateMany` against real row locks, alongside the writers a running system has on the same
 * nodes — neither side may block the other forever, which the memory store cannot show — and the
 * store's batched forms: `updateNodes` stamps what it changed and returns the nodes as written,
 * `getNodes` inside a transaction locks what it read, and `getChildrenMany` lists as
 * `getChildren` does. Gated by EIN_TEST_PG.
 */

import { assert, assertEquals, assertInstanceOf } from '@std/assert';
import type { Pool } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS, NodeTierImmutableError } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';

/** Wider than WRITE_BATCH (128), so a call spans several transactions. */
const NODES = 300;

/** A wedge is indistinguishable from slowness without a bound on the wait. */
const DEADLINE_MS = 60_000;

async function createPgVfs(pool: Pool, name: string) {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new PgStore({ pgPool: pool, name });
  const vfs = new LocalNodeVFS(store, routerManager, { file: new MemoryFileRegistry() });
  await vfs.initialize();

  return {
    vfs,
    store,
    dispose: async () => {
      await vfs.dispose();
      await routerManager.dispose();
    },
  };
}

/** Reject rather than hang, so a regression fails the run instead of stalling it. */
function withDeadline<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${DEADLINE_MS}ms`)), DEADLINE_MS);
  });

  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

pgTest('PgStore batched updates and listings', async (t) => {
  const ctx = pgTestContext();
  const { vfs, store, dispose } = await createPgVfs(ctx.pool, ctx.prefix);

  const paths: string[] = [];

  try {
    await t.step('build the subtree', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'album', { props: { mode: 0o755 } });
      for (let i = 0; i < NODES; i++) {
        await vfs.createTree(ADMIN_ACCESS, '/album', [{
          type: 'directory',
          name: `p${i}`,
          props: { mode: 0o755 },
          children: [{ type: 'directory', name: 'faces', props: { mode: 0o755 } }],
        }]);
        paths.push(`/album/p${i}`);
      }
    });

    await t.step('a batched update finishes while other writers change the same nodes', async () => {
      const updating = vfs.updateMany(ADMIN_ACCESS, paths, { props: { mode: 0o750 } });

      // What the pipeline does to the photos of an album being shared: attrs writes on nodes the
      // batches hold, in the opposite order.
      const writers = [...paths].reverse().map(async (path) => {
        for (let round = 0; round < 3; round++) {
          await vfs.update(ADMIN_ACCESS, path, { attrs: { round } });
        }
      });

      await withDeadline('concurrent writers', Promise.all(writers));
      const results = await withDeadline('batched update', updating);

      assert(results.every((result) => result.status === 'fulfilled'));
      for (const path of paths) {
        const node = await vfs.get(ADMIN_ACCESS, path);
        assertEquals(node.props.mode & 0o777, 0o750);
        assertEquals(node.attrs.round, 2);
      }
    });

    await t.step('updateNodes stamps what it changed and returns the nodes as written', async () => {
      const ids = (await vfs.childrenMany(ADMIN_ACCESS, ['/album']))
        .flatMap((listing) => listing.status === 'fulfilled' ? listing.value.map((child) => child.node.id) : [])
        .slice(0, 3);
      const before = await store.getNodes(ids);

      const tx = await store.beginTransaction();
      const written = await store.updateNodes(1234, ids, { mode: 0o700 }, undefined, tx);
      await tx.commit();

      for (const id of ids) {
        const node = written.get(id)!;
        assertEquals(node.props.mode & 0o777, 0o700);
        assertEquals(node.props.count, 1);
        assertEquals(node.props.changetime.uid, 1234);
        assertEquals(node.props.modtime, before.get(id)!.props.modtime);
        assertEquals(node, await store.getNode(id));
      }

      const attrsTx = await store.beginTransaction();
      const touched = await store.updateNodes(4321, ids, undefined, { label: 'x' }, attrsTx);
      await attrsTx.commit();

      assertEquals(touched.get(ids[0])!.props.modtime.uid, 4321);
      assertEquals(touched.get(ids[0])!.props.changetime.uid, 1234);
      assertEquals(touched.get(ids[0])!.attrs.label, 'x');
    });

    await t.step('getNodes inside a transaction holds what it read until the transaction ends', async () => {
      const { id } = await vfs.get(ADMIN_ACCESS, paths[0]);

      const holder = await store.beginTransaction();
      await store.getNodes([id], holder);

      let landed = false;
      const writer = (async () => {
        const tx = await store.beginTransaction();
        await store.updateNodes(ADMIN_ACCESS.uid, [id], { mode: 0o711 }, undefined, tx);
        await tx.commit();
        landed = true;
      })();

      await new Promise((resolve) => setTimeout(resolve, 300));
      assertEquals(landed, false);

      await holder.commit();
      await withDeadline('the waiting writer', writer);
      assertEquals((await store.getNode(id)).props.mode & 0o777, 0o711);
    });

    await t.step('a tier sent back unchanged is no change, and a new one is refused', async () => {
      await vfs.create(ADMIN_ACCESS, 'file', '/', 'tiered.txt', { props: { tier: 'db' } });

      const [same] = await vfs.updateMany(ADMIN_ACCESS, ['/tiered.txt'], { props: { tier: 'db', mode: 0o600 } });
      const [moved] = await vfs.updateMany(ADMIN_ACCESS, ['/tiered.txt'], { props: { tier: 'disk' } });

      assertEquals(same.status, 'fulfilled');
      assertInstanceOf(moved.status === 'rejected' ? moved.reason : undefined, NodeTierImmutableError);
    });

    await t.step('getChildrenMany lists each parent as getChildren does', async () => {
      const parents = [paths[0], paths[1], `${paths[2]}/faces`];
      const entries = await Promise.all(parents.map((path) => vfs.resolveEntry(ADMIN_ACCESS, path)));

      const many = await store.getChildrenMany(entries.map((entry) => entry.id));

      assertEquals(many.get(entries[0].id), await store.getChildren(entries[0].id));
      assertEquals(many.get(entries[1].id), await store.getChildren(entries[1].id));
      // A parent with no children is absent.
      assertEquals(many.has(entries[2].id), false);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});
