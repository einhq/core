/**
 * Looking at a queue without consuming it: `queue-peek` and `head`.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

type Peeked = { items: { id: number; state: string; attempts: number; routingKey: string; data: unknown }[] };

Deno.test({
  name: 'queue-peek and head leave a queue as it was',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('setup: a queue with three entries', async () => {
      await cmd.shouldSucceed('mknode -t directory /qp');
      await cmd.shouldSucceed('mknode -t queue /qp/q');
      for (const n of [1, 2, 3]) await client.exec(`echo '{"n":${n}}' >> /qp/q`);
    });

    await t.step('queue-peek lists them in order, in JSON and as a table', async () => {
      const peeked = await client.execJson<Peeked>('queue-peek /qp/q');
      assertEquals(peeked.items.map((item) => item.data), [{ n: 1 }, { n: 2 }, { n: 3 }]);
      assertEquals(peeked.items.map((item) => item.state), ['ready', 'ready', 'ready']);
      assertEquals((await client.execJson<Peeked>('queue-peek -n 2 /qp/q')).items.length, 2);
      assertStringIncludes(await client.execString('queue-peek /qp/q', { json: false }), '{"n":2}');
    });

    await t.step('head shows the front of the queue and takes nothing', async () => {
      assertEquals(await client.execString('head -n 2 /qp/q', { json: false }), '{"n":1}\n{"n":2}\n');
      assertEquals((await client.execJson<Peeked>('queue-peek /qp/q')).items.length, 3);
    });

    await t.step('an empty queue says so', async () => {
      await cmd.shouldSucceed('mknode -t queue /qp/empty');
      assertEquals((await client.execJson<Peeked>('queue-peek /qp/empty')).items, []);
      assertEquals((await client.execString('queue-peek /qp/empty', { json: false })).trim(), 'Empty');
      // A read of a queue waits at the end for more; the head of one must not.
      assertEquals(await client.execString('head /qp/empty', { json: false }), '');
    });

    await t.step('queue-peek refuses what is not a queue', async () => {
      await cmd.shouldFail('queue-peek /qp');
      await cmd.shouldFail('queue-peek -n 0 /qp/q');
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
