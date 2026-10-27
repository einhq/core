/**
 * Docs topology: the `/docs` guide mount and per-module docs symlinks created
 * during boot (`08_docs.sh` and `mod setup`).
 */

import { DOCS_MODULES_PATH, DOCS_PATH, MOD_PATH } from '../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { NODE_TYPE_SOFTLINK } from '../../vfs/types/softlink.ts';
import { SystemTestHarness, testCommands } from '../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

Deno.test({
  name: 'docs topology',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();

  try {
    await t.step(`${DOCS_PATH} is a plain directory with the guide mounted`, async () => {
      assertEquals(await vfs.exists(ADMIN_ACCESS, DOCS_PATH), true, `missing ${DOCS_PATH}`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${DOCS_PATH}/guide/index.md`), true, 'missing guide index');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${DOCS_PATH}/guide/node-tree.md`), true, 'missing node-tree');

      // Content is served as-is (no ANSI); read raw through the VFS.
      const handle = await vfs.open(ADMIN_ACCESS, `${DOCS_PATH}/guide/index.md`, { mode: 'r' });
      let text: string;
      try {
        text = await toText(handle.readable);
      } finally {
        await handle.close();
      }
      assertEquals(text.includes('EiN'), true, 'guide index content unexpected');
    });

    await t.step(`module docs are linked under ${DOCS_MODULES_PATH} as softlinks`, async () => {
      // A module that is a manifest and a docs/ folder, set up as an installed one is.
      const client = await harness.createShellClient();
      const dir = `${MOD_PATH}/docs-fixture`;
      await client.exec(`mkdir -p ${dir}/docs && echo '# Fixture' > ${dir}/docs/index.md`);
      await client.exec(`echo '${JSON.stringify({ name: 'docs-fixture', version: '0.1.0', coreApi: '^0.4.0' })}' > ${dir}/mod.json`);
      await testCommands(client).shouldSucceed('mod setup docs-fixture');

      const link = await vfs.get(ADMIN_ACCESS, `${DOCS_MODULES_PATH}/docs-fixture`, { follow: false });
      assertEquals(link.type, NODE_TYPE_SOFTLINK, 'expected a softlink');

      // The link resolves transparently to the module's own docs.
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${DOCS_MODULES_PATH}/docs-fixture/index.md`), true, 'module doc not resolvable');
    });
  } finally {
    await harness.stop();
  }
});
