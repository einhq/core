/**
 * log-append: an entry, optionally backdated, reaches a log node through the
 * shell. The backdating itself is the log registry conformance suite's.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'log-append command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('appends JSON entries (with and without --at), returning entry ids', async () => {
      await cmd.shouldSucceed('mknode -t log /applog');
      const r1 = await client.execJson<{ id: number }>(`log-append /applog --data '{"value":10}' --at 2018-01-01T00:00:00Z`);
      const r2 = await client.execJson<{ id: number }>(`log-append /applog --data '{"value":20}'`);
      assertEquals(typeof r1.id, 'number');
      assertEquals(r2.id > r1.id, true);
    });

    await t.step('rejects a non-log target', async () => {
      await cmd.shouldSucceed('mkfile /notalog');
      await cmd.shouldFailWith(`log-append /notalog --data '{"x":1}'`, 'not a log');
    });

    await t.step('rejects invalid --at and invalid JSON', async () => {
      await cmd.shouldFailWith(`log-append /applog --data '{"x":1}' --at nonsense`, 'invalid --at');
      await cmd.shouldFailWith(`log-append /applog --data notjson`, 'not valid JSON');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
