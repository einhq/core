/**
 * The guide: the bundled documentation mounted read-only at `/usr/docs/guide` during boot
 * (`08_docs.sh`), its pages under `docs/` as the site has them.
 */

import { DOCS_GUIDE_PATH, DOCS_PATH } from '../../lib/paths.ts';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { SystemTestHarness, testCommands } from '../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

Deno.test({
  name: 'docs topology',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();

  try {
    await t.step(`${DOCS_PATH} holds the guide, mounted with its contents and pages`, async () => {
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${DOCS_GUIDE_PATH}/docs/SUMMARY.md`), true, 'missing the contents');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${DOCS_GUIDE_PATH}/docs/shell/ssh-sftp.md`), true, 'missing a page');

      // Served as it is (no ANSI); read raw through the VFS.
      const handle = await vfs.open(ADMIN_ACCESS, `${DOCS_GUIDE_PATH}/docs/index.md`, { mode: 'r' });
      try {
        assertStringIncludes(await toText(handle.readable), '# Welcome');
      } finally {
        await handle.close();
      }
    });

    await t.step('the guide is read-only', async () => {
      const client = await harness.createShellClient();
      await testCommands(client).shouldFail(`echo changed > ${DOCS_GUIDE_PATH}/docs/index.md`);
    });
  } finally {
    await harness.stop();
  }
});
