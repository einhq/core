/**
 * Log tailing over the api-shell (log.follow/log.unfollow) and HTTP log
 * ingest (POST /log/<path>). The follow stream must deliver existing
 * entries first and then live appends without polling.
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
  name: 'log follow and HTTP log ingest',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { baseUrl } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const { cookie } = await harness.createHttpSession();

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

    await t.step('POST /log appends JSON entries (array, ts backdating)', async () => {
      await client.execJson('mknode -t log /http-log');

      const res = await fetch(`${baseUrl}/log/http-log`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { lat: 57.7, lng: 11.97, ts: '2020-05-01T10:00:00Z' },
          { lat: 57.71, lng: 11.98 },
        ]),
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { appended: 2 });

      const events = collector();
      const unfollow = await client.followLog('/http-log', events.onEvent);
      await events.waitFor(2);
      await unfollow();
      assertEquals(events.received[0].data.lat, 57.7);
      assertEquals(events.received[1].data.lat, 57.71);
    });

    await t.step('POST /log rejects bad input', async () => {
      const bad = await fetch(`${baseUrl}/log/http-log`, {
        method: 'POST',
        headers: { cookie },
        body: 'not json at all {',
      });
      assertEquals(bad.status, 400);
      await bad.body?.cancel();

      const notLog = await fetch(`${baseUrl}/log/not-a-log`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ x: 1 }),
      });
      assertEquals(notLog.status, 400);
      await notLog.body?.cancel();
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
