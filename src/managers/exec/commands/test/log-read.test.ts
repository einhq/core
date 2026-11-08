/**
 * log-read: a log's entries by time through the shell, as they are or summed up per interval, as
 * text in `cat -t`'s form and as JSON. What a range and an interval hold is the log registry
 * conformance suite's.
 */

import { assertEquals } from '@std/assert';
import type { LogReadBuckets, LogReadEntries } from '../../../../lib/api/streams.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'log-read command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await cmd.shouldSucceed('mknode -t log /readings');
    for (const [at, value] of [['2026-01-05T00:00:00Z', 10], ['2026-01-05T00:30:00Z', 20], ['2026-01-05T01:30:00Z', 40]] as const) {
      await cmd.shouldSucceed(`log-append /readings --data '{"value":${value}}' --at ${at}`);
    }
    await cmd.shouldSucceed(`log-append /readings --data '{"value":50}'`);

    await t.step('the entries of a range, oldest first, in the form cat -t prints', async () => {
      const text = await client.execString('JSON_OUTPUT=0 log-read /readings --since 2026-01-05T00:15:00Z --until 2026-01-06T00:00:00Z');
      assertEquals(text, '2026-01-05T00:30:00.000Z\t{"value":20}\n2026-01-05T01:30:00.000Z\t{"value":40}\n');
    });

    await t.step('a duration is that long ago; -n keeps the latest', async () => {
      const recent = await client.execJson<LogReadEntries>('log-read /readings --since 1h');
      assertEquals(recent.entries.map((entry) => entry.data), [{ value: 50 }]);
      const latest = await client.execJson<LogReadEntries>('log-read /readings -n 2');
      assertEquals(latest.entries.map((entry) => entry.data), [{ value: 40 }, { value: 50 }]);
    });

    await t.step('per interval, by a field, in a time zone', async () => {
      const hours = await client.execJson<LogReadBuckets>('log-read /readings --until 2026-01-06T00:00:00Z --bucket 1h --field value --agg max --tz UTC');
      assertEquals(hours.buckets, [
        { at: '2026-01-05T00:00:00.000Z', value: 20, count: 2 },
        { at: '2026-01-05T01:00:00.000Z', value: 40, count: 1 },
      ]);
      const text = await client.execString('JSON_OUTPUT=0 log-read /readings --until 2026-01-06T00:00:00Z --bucket 1d --field value --tz Europe/Stockholm');
      assertEquals(text, '2026-01-04T23:00:00.000Z\t{"value":23.333333333333332,"count":3}\n');
    });

    await t.step('refuses what it cannot read', async () => {
      await cmd.shouldSucceed('mkfile /notalog');
      await cmd.shouldFailWith('log-read /notalog', 'not a log');
      await cmd.shouldFailWith('log-read /readings --since yesterday', 'invalid --since');
      await cmd.shouldFailWith('log-read /readings --bucket 1h --agg median', '--agg takes');
      await cmd.shouldFailWith('log-read /readings --bucket 10ms', '--bucket takes');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
