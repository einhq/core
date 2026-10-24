/**
 * Fanout timing. Delivery is deferred to a macrotask on purpose, so the manager owns timers
 * that outlive the `publish()` that scheduled them and has to account for them at teardown.
 *
 * These run with the default sanitizers, which is the point of the last one: an uncancelled
 * fanout timer is a leaked op, and whether it fires before the test ends is down to how busy
 * the loop is.
 */

import { assertEquals } from '@std/assert';
import { RouterManager } from '../mod.ts';

/** One turn of the timer queue — long enough for a deferred fanout to have run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

Deno.test('a released router delivers to every consumer, one macrotask later', async () => {
  const router = new RouterManager();
  await router.init();
  router.release();

  const seen: string[] = [];
  router.on((key) => {
    seen.push(`a:${key}`);
    return Promise.resolve();
  });
  router.on((key) => {
    seen.push(`b:${key}`);
    return Promise.resolve();
  });

  router.publish('logs/x', { n: 1 });
  assertEquals(seen, [], 'delivery is deferred, not synchronous');

  await tick();
  assertEquals(seen.toSorted(), ['a:logs/x', 'b:logs/x']);

  await router.dispose();
});

Deno.test('what was published before release is delivered when it comes', async () => {
  const router = new RouterManager();
  await router.init();

  const seen: string[] = [];
  router.on((key) => {
    seen.push(key);
    return Promise.resolve();
  });

  router.publish('boot/early', {});
  await tick();
  assertEquals(seen, [], 'nothing is delivered before release');

  router.release();
  await tick();
  assertEquals(seen, ['boot/early']);

  await router.dispose();
});

/**
 * The consumer is captured by the deferred callback, so emptying the consumer set does not
 * stop a delivery already in the timer queue — it would call a consumer whose registry is
 * gone. Cancelling settles those ops too, which is what keeps `dispose()` from leaving a
 * test's leak sanitizer with timers to complain about.
 */
Deno.test('dispose cancels a fanout that has not fired yet', async () => {
  const router = new RouterManager();
  await router.init();
  router.release();

  let calls = 0;
  router.on(() => {
    calls++;
    return Promise.resolve();
  });

  router.publish('logs/x', {});
  router.publish('logs/y', {});
  await router.dispose();

  await tick();
  assertEquals(calls, 0, 'a consumer ran after the router that owns it was disposed');
});
