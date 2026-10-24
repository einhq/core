/**
 * mknode --tier: the storage tier is a node prop, set at creation.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'mknode --tier',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('sets the tier prop, and the bytes read back from it', async () => {
      await cmd.shouldSucceed('mknode -t file /dbfile --as "mimetype=text/plain" --tier db');

      const props = await client.execJson<{ tier?: string }>('props /dbfile');
      assertEquals(props.tier, 'db');
      const attrs = await client.execJson<Record<string, unknown>>('attrs /dbfile');
      assertEquals('tier' in attrs, false);

      await client.exec('echo "on the db tier" > /dbfile');
      assertEquals((await client.execString('cat /dbfile')).trim(), 'on the db tier');
    });

    await t.step('refuses an unknown tier', async () => {
      await cmd.shouldFailWith('mknode -t file /badtier --tier tape', "invalid tier 'tape'");
    });

    await t.step('refuses tier as an attribute', async () => {
      await cmd.shouldFailWith('mknode -t file /attrtier --as "tier=db"', 'use --tier');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
