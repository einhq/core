/**
 * Log tailing over the api-shell (log.follow/log.unfollow). The follow stream must deliver
 * existing entries first and then live appends without polling.
 */

import { assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false });

type Entry = { id: number; createdAt: string; data: { value?: number; lat?: number; ts?: string } };

function collector() {
  const received: Entry[] = [];
  let notify: (() => void) | null = null;

  return {
    received,
    onEvent: (event: unknown) => {
      const entries = (event as { entries?: Entry[] } | null)?.entries ?? [];
      received.push(...entries);
      notify?.();
    },
    async waitFor(count: number, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} entries (got ${received.length})`);
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 100);
        });
        notify = null;
      }
    },
  };
}

Deno.test({
  name: 'log follow',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await harness.start();
  const client = await harness.createShellClient();

  try {
    await t.step('log.follow streams history then live appends', async () => {
      await client.execJson('mknode -t log /follow-me');
      await client.execJson(`log-append /follow-me --data '{"value":1}'`);
      await client.execJson(`log-append /follow-me --data '{"value":2}'`);

      const events = collector();
      const unfollow = await client.followLog('/follow-me', events.onEvent);

      // History arrives without any new appends
      await events.waitFor(2);
      assertEquals(events.received.map((e) => e.data.value), [1, 2]);

      // Live append is pushed
      await client.execJson(`log-append /follow-me --data '{"value":3}'`);
      await events.waitFor(3);
      assertEquals(events.received[2].data.value, 3);
      assertEquals(events.received[2].id > events.received[1].id, true);

      // After unfollow nothing more arrives
      await unfollow();
      await client.execJson(`log-append /follow-me --data '{"value":4}'`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assertEquals(events.received.length, 3);
    });

    await t.step('log.follow rejects non-log nodes', async () => {
      await client.execJson('mkfile /not-a-log');
      let failed = false;
      try {
        await client.followLog('/not-a-log', () => {});
      } catch {
        failed = true;
      }
      assertEquals(failed, true);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
