/**
 * PG tier: recursive delete under concurrent writes.
 *
 * A delete holding Postgres row locks while another writer holds a JS mutex it
 * waits for would be a cycle neither side can detect; only real row locks can
 * produce it, so the memory-store tests cannot, and this one pins that it does
 * not happen. Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import type { Pool } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';

/** Wider than WRITE_BATCH (128), so the delete spans several transactions. */
const INSTANCES = 200;

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

pgTest('PgStore recursive delete does not wedge the subtree', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);

  const paths: string[] = [];

  try {
    await t.step('build the subtree', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'instances', { props: { mode: 0o755 } });

      for (let i = 0; i < INSTANCES; i++) {
        const name = `i${i}`;
        await vfs.create(ADMIN_ACCESS, 'directory', '/instances', name, { props: { mode: 0o755 } });
        await vfs.create(ADMIN_ACCESS, 'directory', `/instances/${name}`, 'steps', { props: { mode: 0o755 } });
        await vfs.create(ADMIN_ACCESS, 'directory', `/instances/${name}/steps`, 'leaf', { props: { mode: 0o755 } });
        paths.push(`/instances/${name}/steps`);
      }
    });

    await t.step('delete it while other writers touch nodes inside it', async () => {
      const deleting = vfs.unlink(ADMIN_ACCESS, '/instances', '/', { recursive: true });

      // What the pipeline engine does to instances it is running: update nodes
      // the delete is walking past. Most of these lose the race and the node is
      // gone by the time they land — that is expected, the point is that
      // neither side blocks the other forever.
      const writers = paths.map(async (path) => {
        for (let round = 0; round < 3; round++) {
          try {
            await vfs.update(ADMIN_ACCESS, path, { attrs: { round } });
          } catch {
            return;
          }
        }
      });

      await withDeadline('concurrent writers', Promise.all(writers));
      await withDeadline('recursive delete', deleting);

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/instances'), false);
    });

    await t.step('a delete racing moves across the subtree finishes', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'instances', { props: { mode: 0o755 } });
      for (let i = 0; i < INSTANCES; i++) {
        await vfs.create(ADMIN_ACCESS, 'directory', '/instances', `i${i}`, { props: { mode: 0o755 } });
        await vfs.create(ADMIN_ACCESS, 'directory', `/instances/i${i}`, 'leaf', { props: { mode: 0o755 } });
      }

      const deleting = vfs.unlink(ADMIN_ACCESS, '/instances', '/', { recursive: true });

      // The shape that would cycle: a move whose *source* the delete has
      // already removed (uncommitted, so it still resolves under MVCC) and
      // whose *destination* the delete has not reached yet. A delete holding
      // one transaction over the subtree would block the move on the source row
      // while the move holds the mutex on a destination the delete waits for.
      // Fired across the tree because which pairs land in that window is a
      // matter of timing.
      const moves = [];
      for (let i = 0; i < INSTANCES; i++) {
        const from = `/instances/i${i}`;
        const to = `/instances/i${INSTANCES - 1 - i}`;
        moves.push(vfs.rename(ADMIN_ACCESS, from, 'leaf', to, `leaf-${i}`).catch(() => {}));
      }

      await withDeadline('concurrent moves', Promise.all(moves));
      await withDeadline('recursive delete under moves', deleting);

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/instances'), false);
    });

    await t.step('the tree accepts writes again immediately', async () => {
      // A single `mv` after the delete completes.
      await withDeadline(
        'post-delete write',
        (async () => {
          await vfs.create(ADMIN_ACCESS, 'directory', '/', 'after', { props: { mode: 0o755 } });
          await vfs.rename(ADMIN_ACCESS, '/', 'after', '/', 'moved');
          assertEquals(await vfs.exists(ADMIN_ACCESS, '/moved'), true);
        })(),
      );
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});
