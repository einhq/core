/**
 * `changedBeyondPages`: two trees of one module are the same to its services when they differ
 * only under `ui/`, in the install record, or in `mod.json`'s `version` and `ui`. A file changed,
 * added or removed anywhere else, or any other field of `mod.json`, is a change.
 */

import { assertEquals } from '@std/assert';
import { dirname } from '@std/path';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { mkdirp, mkfile } from '../../vfs/test/helpers.ts';
import type { NodeVFS } from '../../vfs/mod.ts';
import { changedBeyondPages } from '../install.ts';

type Tree = Record<string, string>;

const manifest = (version: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'beacon', version, ui: { routes: { '/beacon': 'ui/pages/beacon.tsx' } }, ...extra });

const base: Tree = {
  'mod.json': manifest('1.0.0'),
  '.install.json': '{"commit":"aaa"}',
  'bin/beacon': '#!bash\necho one\n',
  'lib/beacon.ts': 'export const one = 1;\n',
  'services/beacon/start.sh': 'sleep 3600\n',
  'ui/pages/beacon.tsx': "export default () => 'first';\n",
};

let trees = 0;

const write = async (vfs: NodeVFS, tree: Tree): Promise<string> => {
  const root = `/modules/tree-${trees++}`;
  await mkdirp(vfs, ADMIN_ACCESS, root);
  for (const [path, text] of Object.entries(tree)) {
    const full = `${root}/${path}`;
    await mkdirp(vfs, ADMIN_ACCESS, dirname(full));
    await mkfile(vfs, ADMIN_ACCESS, dirname(full), full.slice(dirname(full).length + 1), text);
  }
  return root;
};

Deno.test('changedBeyondPages', async (t) => {
  const { vfs, dispose } = await createTestVfs();
  try {
    const before = await write(vfs, base);
    const changed = async (tree: Tree): Promise<boolean> => await changedBeyondPages(vfs, ADMIN_ACCESS, before, await write(vfs, tree));

    await t.step('a release of new pages is no change', async () => {
      assertEquals(await changed(base), false);
      assertEquals(
        await changed({
          ...base,
          'mod.json': manifest('1.0.1', { ui: { routes: { '/beacon': 'ui/pages/beacon.tsx', '/beacon/new': 'ui/pages/new.tsx' } } }),
          '.install.json': '{"commit":"bbb"}',
          'ui/pages/beacon.tsx': "export default () => 'second';\n",
          'ui/pages/new.tsx': "export default () => 'new';\n",
        }),
        false,
      );
    });

    await t.step('a command, a lib, a service or the rest of mod.json changed is a change', async () => {
      assertEquals(await changed({ ...base, 'bin/beacon': '#!bash\necho two\n' }), true);
      assertEquals(await changed({ ...base, 'lib/beacon.ts': 'export const one = 2;\n' }), true);
      assertEquals(await changed({ ...base, 'services/beacon/start.sh': 'sleep 60\n' }), true);
      assertEquals(await changed({ ...base, 'mod.json': manifest('1.0.1', { dependencies: { base: '^1.0.0' } }) }), true);
    });

    await t.step('a file added or removed outside ui/ is a change', async () => {
      assertEquals(await changed({ ...base, 'bin/other': '#!bash\necho other\n' }), true);
      const { 'lib/beacon.ts': _removed, ...without } = base;
      assertEquals(await changed(without), true);
    });
  } finally {
    await dispose();
  }
});
