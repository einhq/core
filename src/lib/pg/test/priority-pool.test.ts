/**
 * PG tier: the interactive reservation. Gated by EIN_TEST_PG.
 *
 * Real connections rather than a fake pool, because the property under test is
 * about the driver's own queue as much as about the gate above it — the second
 * admission condition exists precisely to keep background acquisitions out of
 * `pg-pool`'s FIFO, and a stub of `Pool` would have no FIFO to stay out of.
 *
 * Every pool here is small (`max` of 3 or 4) so saturation is reachable in a
 * test rather than being a load experiment.
 */

import { assert, assertEquals } from '@std/assert';
import { deferred } from '../../async/deferred.ts';
import { PG_URL, pgTest } from '../../../testing/gates.ts';
import { PriorityPool } from '../priority-pool.ts';
import { runAsBackground } from '../work-class.ts';

const pool = (max: number, reserved: number) => new PriorityPool({ connectionString: PG_URL, max, reserved });

/** Resolves once `check` holds, polling the microtask/timer queue. Fails the test by timing out. */
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(check(), 'condition never held');
};

pgTest('background acquisitions stop at max - reserved, interactive keeps the rest', async () => {
  const pg = pool(4, 2);

  try {
    const held = [
      await runAsBackground(() => pg.connect()),
      await runAsBackground(() => pg.connect()),
    ];

    assertEquals(pg.poolStats().backgroundInside, 2);

    // The third background acquisition is over the cap and must not reach the
    // driver at all — if it did, it would be holding a physical connection.
    let third = false;
    const parked = runAsBackground(() => pg.connect()).then((client) => {
      third = true;
      return client;
    });

    await until(() => pg.poolStats().backgroundGated === 1);
    assertEquals(third, false);

    // Meanwhile the reserved half is untouched: two interactive acquisitions
    // complete while that third one is still parked.
    const interactive = [
      await pg.connect(),
      await pg.connect(),
    ];
    assertEquals(third, false);
    assertEquals((await interactive[0].query('SELECT 1 AS n')).rows[0].n, 1);

    for (const client of interactive) client.release();
    held.pop()!.release();

    // Freeing one lets exactly the parked one through.
    (await parked).release();
    for (const client of held) client.release();
  } finally {
    await pg.end();
  }
});

pgTest('background work waits at the gate, not in the driver queue', async () => {
  const pg = pool(3, 1);

  try {
    // Background load that holds its connection while it works, which is what a
    // pipeline step does and what makes the queue a queue. Ten of them against
    // three connections.
    const load = Array.from({ length: 10 }, () =>
      runAsBackground(async () => {
        const client = await pg.connect();
        await client.query('SELECT pg_sleep(0.05)');
        client.release();
      }));

    await until(() => pg.poolStats().backgroundGated > 0);
    const stats = pg.poolStats();

    // The assertion the second admission condition exists for. Background is
    // parked at the gate and *not* in `pg-pool`'s own FIFO, so the next
    // interactive acquisition is not behind any of it. With `reserved: 0` the
    // same load would put seven of them in the driver queue.
    assertEquals(stats.waiting, 0);
    assert(stats.backgroundGated >= 7, `expected background parked at the gate, got ${stats.backgroundGated}`);

    const client = await pg.connect();
    assertEquals((await client.query('SELECT 1 AS n')).rows[0].n, 1);
    client.release();

    await Promise.all(load);
  } finally {
    await pg.end();
  }
});

pgTest('reserved: 0 is a plain pool — every caller is equal again', async () => {
  const pg = pool(3, 0);

  try {
    const clients = await Promise.all([
      runAsBackground(() => pg.connect()),
      runAsBackground(() => pg.connect()),
      runAsBackground(() => pg.connect()),
    ]);

    assertEquals(pg.poolStats().backgroundGated, 0);
    for (const client of clients) client.release();
  } finally {
    await pg.end();
  }
});

pgTest('pool.query() goes through the gate, not around it', async () => {
  const pg = pool(3, 1);

  try {
    const held = [
      await runAsBackground(() => pg.connect()),
      await runAsBackground(() => pg.connect()),
    ];

    // `Pool.query` acquires through the callback form of `connect`, and most
    // registry traffic is `pool.query`: the gate covers that form too.
    const done = deferred<void>();
    runAsBackground(() => pg.query('SELECT 1')).then(() => done.resolve());

    await until(() => pg.poolStats().backgroundGated === 1);

    held.pop()!.release();
    await done;
    held.pop()!.release();
  } finally {
    await pg.end();
  }
});

pgTest('an untagged context counts as interactive', async () => {
  const pg = pool(3, 2);

  try {
    // One background client is the cap (3 - 2). Two untagged acquisitions still
    // succeed — the permissive default is what makes a missed tag harmless.
    const background = await runAsBackground(() => pg.connect());
    const first = await pg.connect();
    const second = await pg.connect();

    assertEquals(pg.poolStats().interactiveInside, 2);
    assertEquals(pg.poolStats().backgroundInside, 1);

    first.release();
    second.release();
    background.release();
  } finally {
    await pg.end();
  }
});

pgTest('an idle connection the server closes is dropped, not thrown', async () => {
  const pg = pool(3, 1);

  try {
    const client = await pg.connect();
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    client.release();

    // The driver reports a lost idle client as an `error` event on the pool, which nothing
    // awaits: unheard, it is an uncaught error that ends the process.
    const removed = new Promise((resolve) => pg.once('remove', resolve));
    const admin = pool(1, 0);
    try {
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      await admin.end();
    }
    await removed;

    assertEquals((await pg.query('SELECT 1 AS n')).rows[0].n, 1);
  } finally {
    await pg.end();
  }
});

pgTest('the work class survives the await chain a VFS call actually makes', async () => {
  const pg = pool(3, 1);

  try {
    const held = [
      await runAsBackground(() => pg.connect()),
      await runAsBackground(() => pg.connect()),
    ];

    // The tag is set once at a service's root and read many awaits later, so
    // what matters is that it survives the shape of a real call chain — timers,
    // nested async functions, a promise resolved from elsewhere — rather than a
    // single `await`.
    const deep = async (depth: number): Promise<number> => {
      if (depth === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return pg.poolStats().backgroundGated;
      }
      await Promise.resolve();
      return deep(depth - 1);
    };

    let gated = -1;
    const parked = runAsBackground(async () => {
      const before = deep(6).then((value) => {
        gated = value;
      });
      const client = await pg.connect();
      await before;
      return client;
    });

    await until(() => gated >= 0);
    assertEquals(gated, 1, 'the nested chain acquired as background');

    held.pop()!.release();
    (await parked).release();
    held.pop()!.release();
  } finally {
    await pg.end();
  }
});

/**
 * The accounting must come back to zero, or the gate tightens over the life of
 * the process until background work is throttled for no reason. Both classes,
 * both acquisition forms, and a failed acquisition — the paths that each have
 * their own decrement.
 */
pgTest('every acquisition path gives its slot back', async () => {
  const pg = pool(4, 1);

  try {
    for (let round = 0; round < 25; round++) {
      const clients = await Promise.all([
        runAsBackground(() => pg.connect()),
        pg.connect(),
        runAsBackground(() => pg.connect()),
      ]);
      for (const client of clients) client.release();

      await Promise.all([
        runAsBackground(() => pg.query('SELECT 1')),
        pg.query('SELECT 1'),
      ]);

      // A statement that throws still releases; the class count must follow it.
      await runAsBackground(() => pg.query('SELECT nope')).catch(() => {});
    }

    const stats = pg.poolStats();
    assertEquals(stats.backgroundInside, 0);
    assertEquals(stats.interactiveInside, 0);
    assertEquals(stats.backgroundGated, 0);
  } finally {
    await pg.end();
  }
});
