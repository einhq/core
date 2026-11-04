/**
 * A redirect into a file closes its write handle, and the close is what
 * records the write on the node: size, sha256 and writtenAt.
 */

import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { createHash } from 'node:crypto';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { createTestContext, type ShellClient } from '../../../testing/mod.ts';

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

const testCtx = createTestContext();

Deno.test({
  name: 'a redirect records its write on the node',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const attrs = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).attrs as Record<string, unknown>;

  try {
    await t.step('> records size, sha256 and writtenAt', async () => {
      const result = await client.exec('echo hello > /r');
      assertEquals(result.success, true, `echo hello > /r failed: ${result.error}`);

      const written = await attrs('/r');
      assertEquals(written.size, 6);
      assertEquals(written.sha256, sha256Hex('hello\n'));
      assert(typeof written.writtenAt === 'string', 'writtenAt was not recorded');
    });

    await t.step('> over an existing file replaces its sha256', async () => {
      await client.exec('echo bye > /r');
      const written = await attrs('/r');
      assertEquals(written.size, 4);
      assertEquals(written.sha256, sha256Hex('bye\n'));
    });

    await t.step('>> records the size and clears the sha256 rather than leaving it stale', async () => {
      const before = await attrs('/r');
      await client.exec('echo more >> /r');

      const written = await attrs('/r');
      assertEquals(written.size, 9);
      assertEquals(written.sha256 ?? null, null);
      assertNotEquals(written.writtenAt, before.writtenAt);
      assertEquals(await client.execString('cat /r'), 'bye\nmore\n');
    });

    await t.step('>> into a new file hashes it', async () => {
      await client.exec('echo first >> /fresh');
      assertEquals((await attrs('/fresh')).sha256, sha256Hex('first\n'));
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
