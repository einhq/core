/**
 * The engine's concurrency semaphore must serve high-priority waiters first.
 *
 * Every inline step shares one `Semaphore(maxConcurrent)` in the engine. With a
 * plain FIFO queue, a burst of cheap instances that arrives first (OCR, say)
 * holds every permit and a more valuable pipeline (face detection) piles up
 * behind them; `options.priority` decides who gets the next freed permit.
 */

import { assertEquals } from '@std/assert';
import { Semaphore } from '../../../lib/async/semaphore.ts';

/** The dispatch shape from engine.ts: acquire(priority), run, release in finally. */
async function dispatch(
  sem: Semaphore,
  priority: number,
  label: string,
  order: string[],
  hold: Promise<void>,
): Promise<void> {
  await sem.acquire(priority);
  try {
    order.push(label);
    await hold;
  } finally {
    sem.release();
  }
}

Deno.test('semaphore serves higher priority first', async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];

  // Occupy the only permit so everything else parks.
  let releaseBlocker!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseBlocker = resolve));
  const blocker = dispatch(sem, 0, 'blocker', order, blocked);
  await Promise.resolve();

  // Park a low-priority waiter FIRST, then a high-priority one. FIFO would run
  // low before high; priority must invert that.
  const done = Promise.resolve();
  const low = dispatch(sem, 0, 'low', order, done);
  await Promise.resolve();
  const high = dispatch(sem, 10, 'high', order, done);
  await Promise.resolve();

  releaseBlocker();
  await Promise.all([blocker, low, high]);

  assertEquals(order, ['blocker', 'high', 'low']);
});

Deno.test('equal priorities stay FIFO', async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];

  let releaseBlocker!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseBlocker = resolve));
  const blocker = dispatch(sem, 0, 'blocker', order, blocked);
  await Promise.resolve();

  const done = Promise.resolve();
  const waiters: Promise<void>[] = [];
  for (const label of ['a', 'b', 'c']) {
    waiters.push(dispatch(sem, 5, label, order, done));
    await Promise.resolve();
  }

  releaseBlocker();
  await Promise.all([blocker, ...waiters]);

  assertEquals(order, ['blocker', 'a', 'b', 'c']);
});

Deno.test('a flood of low-priority work cannot starve high-priority work', async () => {
  // The real scenario: OCR instances flood in, then face detection arrives.
  const sem = new Semaphore(2);
  const order: string[] = [];
  const done = Promise.resolve();

  let releaseBlockers!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseBlockers = resolve));
  const blockers = [
    dispatch(sem, 0, 'blocker-1', order, blocked),
    dispatch(sem, 0, 'blocker-2', order, blocked),
  ];
  await Promise.resolve();

  const flood: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    flood.push(dispatch(sem, 0, `ocr-${i}`, order, done));
    await Promise.resolve();
  }

  // Face detection arrives last, behind all 20.
  const faces = dispatch(sem, 10, 'faces', order, done);
  await Promise.resolve();

  releaseBlockers();
  await Promise.all([...blockers, ...flood, faces]);

  // It must not wait for the flood to drain — it runs as soon as a permit frees.
  const facesAt = order.indexOf('faces');
  assertEquals(facesAt, 2, `faces ran at ${facesAt}, after ${order.slice(2, facesAt).join(', ')}`);
});

Deno.test('default priority preserves plain FIFO behaviour', async () => {
  // Callers that never pass a priority (every existing one) must be unaffected.
  const sem = new Semaphore(1);
  const order: string[] = [];

  let releaseBlocker!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseBlocker = resolve));
  const blocker = dispatch(sem, 0, 'blocker', order, blocked);
  await Promise.resolve();

  const done = Promise.resolve();
  const waiters: Promise<void>[] = [];
  for (const label of ['first', 'second', 'third']) {
    // Mirrors `await sem.acquire()` with no argument.
    waiters.push((async () => {
      await sem.acquire();
      try {
        order.push(label);
        await done;
      } finally {
        sem.release();
      }
    })());
    await Promise.resolve();
  }

  releaseBlocker();
  await Promise.all([blocker, ...waiters]);

  assertEquals(order, ['blocker', 'first', 'second', 'third']);
});
