/**
 * `mod setup` and `mod remove` bundle the modules' pages again (`ui-build --all`) where the browser
 * shell is served, and leave them alone where it is not.
 */

import { assertEquals } from '@std/assert';
import { UI_MANIFEST_PATH } from '@ui/ui-cache';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({ name: 'mod pages', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const id = crypto.randomUUID().slice(0, 8);
  const built = async () => (await client.exec(`test -e ${UI_MANIFEST_PATH}`)).success;
  const makeModule = (name: string) => client.exec(`mkdir -p $MOD_PATH/${name} && echo '${JSON.stringify({ name, version: '1.0.0' })}' > $MOD_PATH/${name}/mod.json`);

  try {
    await makeModule(`first-${id}`);
    await makeModule(`second-${id}`);

    await t.step('without the shell, a setup builds nothing', async () => {
      assertEquals((await client.exec(`mod-setup first-${id}`)).success, true);
      assertEquals(await built(), false);
    });

    await client.exec('mkdir -p $WWW_PATH/ui');

    await t.step('with the shell, a setup builds the pages', async () => {
      assertEquals((await client.exec(`mod-setup second-${id}`)).success, true);
      assertEquals(await built(), true);
    });

    await t.step('a removal builds them again', async () => {
      await client.exec(`rm ${UI_MANIFEST_PATH}`);
      await client.exec(`mod-remove --force second-${id}`);
      assertEquals(await built(), true);
    });
  } finally {
    await testCtx.teardown();
  }
});
