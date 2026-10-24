/**
 * IdLockManager: mutual exclusion per id, and a map that does not grow forever.
 *
 * The eviction is the point: an id's mutex is dropped once nothing holds or
 * waits for it, so the map holds only the ids locked right now, not every node
 * id ever locked on the hottest path in the system.
 */

import { assertEquals } from '@std/assert';
import { IdLockManager } from '../id-lock-manager.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test('IdLockManager', async (t) => {
  await t.step('drops a lock once nothing holds or wants it', async () => {
    const locks = new IdLockManager();

    await locks.withLocks(['a'], async () => {
      assertEquals(locks.size, 1, 'held while in use');
    });

    assertEquals(locks.size, 0, 'evicted once released');
  });

  await t.step('a thousand distinct ids leave nothing behind', async () => {
    const locks = new IdLockManager();

    for (let i = 0; i < 1000; i++) {
      await locks.withLocks([`node-${i}`], async () => {});
    }

    assertEquals(locks.size, 0);
  });

  await t.step('still excludes: a waiter keeps the lock alive and gets it', async () => {
    const locks = new IdLockManager();
    const order: string[] = [];

    let releaseFirst: () => void = () => {};
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = locks.withLocks(['shared'], async () => {
      order.push('first-in');
      await firstDone;
      order.push('first-out');
    });

    await tick();

    const second = locks.withLocks(['shared'], async () => {
      order.push('second-in');
    });

    await tick();
    // The waiter must not have been let in, and the entry must still exist —
    // evicting it here would hand `second` a fresh mutex and break exclusion.
    assertEquals(order, ['first-in']);
    assertEquals(locks.size, 1);

    releaseFirst();
    await Promise.all([first, second]);

    assertEquals(order, ['first-in', 'first-out', 'second-in']);
    assertEquals(locks.size, 0, 'evicted once the queue drains');
  });

  await t.step('concurrent writers to one id serialise', async () => {
    const locks = new IdLockManager();
    let inside = 0;
    let maxInside = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        locks.withLocks(['hot'], async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await tick();
          inside--;
        })),
    );

    assertEquals(maxInside, 1, 'never two at once');
    assertEquals(locks.size, 0);
  });

  await t.step('multi-id locks release and evict every id', async () => {
    const locks = new IdLockManager();

    await locks.withLocks(['x', 'y', 'z'], async () => {
      assertEquals(locks.size, 3);
    });

    assertEquals(locks.size, 0);
  });

  await t.step('a throwing body still releases and evicts', async () => {
    const locks = new IdLockManager();

    try {
      await locks.withLocks(['boom'], async () => {
        throw new Error('nope');
      });
    } catch { /* expected */ }

    assertEquals(locks.size, 0);
  });
});
