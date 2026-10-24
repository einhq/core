/**
 * `mknode --under`: the boundary that stops `-p` rebuilding a deleted tree.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'mknode --under',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('creates levels below the boundary', async () => {
      await cmd.shouldSucceed(`mkdir -p /archive/albums/trip/files`);
      await cmd.shouldSucceed(`mknode -p --under /archive/albums/trip/files -t embedding /archive/albums/trip/files/a.png/metadata/sscd-image`);

      const names = await client.execJson<string[]>(`ls /archive/albums/trip/files/a.png/metadata`);
      assertEquals(names.includes('sscd-image'), true);
    });

    await t.step('refuses when the boundary itself is gone', async () => {
      await cmd.shouldSucceed(`mkdir -p /archive/albums/gone/files`);
      await cmd.shouldSucceed(`rm -rf /archive/albums/gone`);

      const result = await client.exec(`mknode -p --under /archive/albums/gone/files -t embedding /archive/albums/gone/files/a.png/metadata/sscd-image`);
      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', 'does not exist');
    });

    await t.step('and leaves nothing behind when it refuses', async () => {
      // An unbounded `-p` would rebuild the album, the file and every level
      // between as `directory` nodes around the one node it wanted.
      const names = await client.execJson<string[]>(`ls /archive/albums`);
      assertEquals(names.includes('gone'), false);
    });

    await t.step('refuses a path that is not under the boundary', async () => {
      await cmd.shouldSucceed(`mkdir -p /archive/albums/other`);

      const result = await client.exec(`mknode -p --under /archive/albums/other -t directory /archive/albums/elsewhere/x`);
      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', 'not under');
    });

    await t.step('still no-ops on a node that already exists', async () => {
      await cmd.shouldSucceed(`mknode -p --under /archive/albums/other -t directory /archive/albums/other/x`);
      await cmd.shouldSucceed(`mknode -p --under /archive/albums/other -t directory /archive/albums/other/x`);
    });

    await t.step('unbounded -p is unchanged', async () => {
      await cmd.shouldSucceed('mkdir -p /deep/nested/path');
      await cmd.shouldSucceed('ls /deep/nested/path');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
