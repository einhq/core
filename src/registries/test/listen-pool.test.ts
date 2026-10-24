/**
 * PG tier: the four registries that hold a LISTEN connection take it from the
 * listen pool, not the work pool. Gated by EIN_TEST_PG.
 *
 * A notification connection is held for the registry's whole lifetime and can
 * never serve a query, so taking it from the work pool would subtract it from
 * that pool for good.
 *
 * Checked-out count on each pool rather than a connect counter: what is being
 * asserted is which pool ends up short a connection, not how many times either
 * was asked.
 */

import { assert, assertEquals } from '@std/assert';
import { Pool } from 'pg';
import { RouterManager } from '../../managers/router/mod.ts';
import { PG_URL, pgTest, pgTestContext } from '../../testing/gates.ts';
import { PgLogRegistry } from '../log/mod.ts';
import { PgPoolRegistry } from '../pool/mod.ts';
import { PgQueueRegistry } from '../queue/mod.ts';
import { TrackRegistry } from '../track/mod.ts';

const checkedOut = (pool: Pool) => pool.totalCount - pool.idleCount;

/**
 * Arm each registry's listener, then report where the connection came from.
 *
 * `arm` is the operation that first needs notifications — for two of them that
 * is `init` itself, for the other two it is the blocking read they exist to
 * serve.
 */
const listenPoolTest = (
  name: string,
  build: (pools: { pool: Pool; listenPool: Pool; router: RouterManager; prefix: string }) => {
    arm: () => Promise<void>;
    dispose: () => Promise<void>;
  },
) =>
  pgTest(`${name} takes its LISTEN connection from the listen pool`, async () => {
    const ctx = pgTestContext();
    const listenPool = new Pool({ connectionString: PG_URL });
    const router = new RouterManager();
    await router.init();
    router.release();

    const { arm, dispose } = build({ pool: ctx.pool, listenPool, router, prefix: ctx.prefix });

    try {
      await arm();
      // Let the work pool's own clients go idle, so what is left checked out is
      // only what is being held on purpose.
      await new Promise((resolve) => setTimeout(resolve, 100));

      assertEquals(checkedOut(listenPool), 1, 'the listen pool should be holding exactly the notification client');
      assertEquals(checkedOut(ctx.pool), 0, 'the work pool should be holding nothing');
    } finally {
      await dispose();
      await router.dispose();
      await listenPool.end();
      await ctx.teardown();
    }
  });

listenPoolTest('PgLogRegistry', ({ pool, listenPool, router, prefix }) => {
  const registry = new PgLogRegistry({ name: prefix, pool, listenPool, router });
  return {
    // The bindings-invalidation channel is armed by init itself.
    arm: () => registry.init(),
    dispose: () => registry.dispose(),
  };
});

listenPoolTest('PgQueueRegistry', ({ pool, listenPool, router, prefix }) => {
  const registry = new PgQueueRegistry({ name: prefix, pool, listenPool, router });
  return {
    arm: () => registry.init(),
    dispose: () => registry.dispose(),
  };
});

listenPoolTest('PgPoolRegistry', ({ pool, listenPool, prefix }) => {
  const registry = new PgPoolRegistry({ name: prefix, pool, listenPool });
  const abort = new AbortController();

  return {
    // A blocking claim on an empty pool is what first needs notifications here.
    arm: async () => {
      await registry.init();
      await registry.touch('waiters', {});
      registry.claim('waiters', { owner: 'test' }, abort.signal).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    dispose: async () => {
      abort.abort();
      await registry.dispose();
    },
  };
});

listenPoolTest('TrackRegistry', ({ pool, listenPool, router, prefix }) => {
  const registry = new TrackRegistry({ name: prefix, pool, listenPool, router });
  const abort = new AbortController();

  return {
    // Same for a blocking read past the end of a track.
    arm: async () => {
      await registry.init();
      await registry.touch('waited', {});
      const handle = await registry.open('waited', {}, 'r+');
      handle.read(1, abort.signal).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    dispose: async () => {
      abort.abort();
      await registry.dispose();
    },
  };
});

/** Left unset, the listen pool is the work pool, as the harness and the in-memory mounts get it. */
pgTest('without a listen pool the LISTEN connection still comes from the work pool', async () => {
  const ctx = pgTestContext();
  const router = new RouterManager();
  await router.init();
  router.release();

  const registry = new PgLogRegistry({ name: ctx.prefix, pool: ctx.pool, router });

  try {
    await registry.init();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(checkedOut(ctx.pool) === 1, `expected the work pool to hold the notification client, held ${checkedOut(ctx.pool)}`);
  } finally {
    await registry.dispose();
    await router.dispose();
    await ctx.teardown();
  }
});
