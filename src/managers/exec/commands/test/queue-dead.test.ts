/**
 * The entries a queue set aside: `queue-dead` lists them, and retries or drops them.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

type Dead = { items: { id: number; attempts: number; deadAt: string; routingKey: string; data: unknown }[] };
type Peeked = { items: { id: number; data: unknown }[] };

Deno.test({
  name: 'queue-dead lists, retries and drops dead letters',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('setup: a queue whose first two entries ran out of attempts', async () => {
      await cmd.shouldSucceed('mknode -t directory /qd');
      await cmd.shouldSucceed('mknode -t queue /qd/q');
      await vfs.update(ADMIN_ACCESS, '/qd/q', { attrs: { maxAttempts: 1 } });
      for (const n of [1, 2, 3]) await client.exec(`echo '{"n":${n}}' >> /qd/q`);

      const handle = await vfs.open(ADMIN_ACCESS, '/qd/q', { mode: 'r+' });
      try {
        for (let i = 0; i < 2; i++) {
          await handle.read(1);
          await handle.write(new TextEncoder().encode('nack\n'));
        }
      } finally {
        await handle.close();
      }
    });

    await t.step('queue-dead lists them, in JSON and as a table', async () => {
      const dead = await client.execJson<Dead>('queue-dead /qd/q');
      assertEquals(dead.items.map((item) => [item.data, item.attempts]), [[{ n: 1 }, 1], [{ n: 2 }, 1]]);
      assertStringIncludes(await client.execString('queue-dead /qd/q', { json: false }), '{"n":2}');
      assertEquals((await client.execJson<Peeked>('queue-peek /qd/q')).items.map((item) => item.data), [{ n: 3 }]);
    });

    await t.step('--retry --id puts one back in line', async () => {
      const [first] = (await client.execJson<Dead>('queue-dead /qd/q')).items;
      assertEquals(await client.execJson<{ ok: boolean; settled: number }>(`queue-dead --retry --id ${first.id} /qd/q`), { ok: true, settled: 1 });
      assertEquals((await client.execJson<Peeked>('queue-peek /qd/q')).items.map((item) => item.data), [{ n: 1 }, { n: 3 }]);
    });

    await t.step('--drop deletes the rest', async () => {
      assertEquals((await client.execString('queue-dead --drop /qd/q', { json: false })).trim(), '1 entry dropped');
      assertEquals((await client.execJson<Dead>('queue-dead /qd/q')).items, []);
      assertEquals((await client.execString('queue-dead /qd/q', { json: false })).trim(), 'None');
    });

    await t.step('queue-dead refuses what it cannot do', async () => {
      await cmd.shouldFail('queue-dead /qd');
      await cmd.shouldFail('queue-dead --retry --drop /qd/q');
      await cmd.shouldFail('queue-dead --id 1 /qd/q');
      await cmd.shouldFail('queue-dead --drop --id x /qd/q');
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
