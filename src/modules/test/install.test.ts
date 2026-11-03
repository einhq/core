/**
 * `changedBeyondPages`: two trees of one module are the same to its services when they differ
 * only under `ui/`, in the install record, or in `mod.json`'s `version` and `ui`. A file changed,
 * added or removed anywhere else, or any other field of `mod.json`, is a change.
 *
 * `unpackArchive`: a tree of many files in many directories, written several at once, is all in
 * place with its modes when it returns; a path outside the module, or a write that fails, fails
 * the unpack once every write under way has ended.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { dirname } from '@std/path';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { type Files, tarball } from '../../testing/fake-forge.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { mkdirp, mkfile } from '../../vfs/test/helpers.ts';
import type { NodeVFS } from '../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { changedBeyondPages, unpackArchive } from '../install.ts';

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

Deno.test('unpackArchive', async (t) => {
  const { vfs, dispose } = await createTestVfs();
  let dests = 0;
  const unpack = async (files: Files) => {
    const dest = `/unpacked-${dests++}`;
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', dest.slice(1));
    const counted: number[] = [];
    const unpacked = await unpackArchive(vfs, ADMIN_ACCESS, tarball('module-tiles', files), dest, async (n) => {
      counted.push(n);
    });
    return { dest, unpacked, counted };
  };
  const read = async (path: string): Promise<string> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
    try {
      return await new Response(handle.readable).text();
    } finally {
      await handle.close();
    }
  };

  try {
    await t.step('many files in many directories are all in place, with their modes', async () => {
      const files: Files = { 'bin/tiles': { text: '#!bash\necho tiles\n', mode: 0o755 } };
      for (let i = 0; i < 100; i++) files[`tiles/${i % 7}/${i % 3}/${i}.png`] = `tile ${i}`;
      const { dest, unpacked, counted } = await unpack(files);

      assertEquals(unpacked, { files: 101, skipped: [] });
      assertEquals(counted.toSorted((a, b) => a - b), Array.from({ length: 101 }, (_, i) => i + 1));
      assertEquals(await read(`${dest}/tiles/6/2/20.png`), 'tile 20');
      assertEquals((await vfs.children(ADMIN_ACCESS, `${dest}/tiles`)).length, 7);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${dest}/bin/tiles`)).props.mode & 0o777, 0o755);
    });

    await t.step('a path outside the module is refused', async () => {
      const files: Files = { 'mod.json': '{}', '../escape.txt': 'out' };
      for (let i = 0; i < 40; i++) files[`tiles/${i}.png`] = `tile ${i}`;
      await assertRejects(() => unpack(files), Error, 'a path outside the module');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/escape.txt'), false);
    });

    await t.step('a write that fails fails the unpack, once the others under way have ended', async () => {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'failing');
      const files: Files = {};
      for (let i = 0; i < 40; i++) files[`tiles/${i}.png`] = `tile ${i}`;
      let settled = 0;
      await assertRejects(
        () =>
          unpackArchive(vfs, ADMIN_ACCESS, tarball('module-tiles', files), '/failing', async (n) => {
            settled = n;
            if (n === 5) throw new Error('the disk is full');
          }),
        Error,
        'the disk is full',
      );
      const written = settled;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assertEquals(settled, written);
    });
  } finally {
    await dispose();
  }
});
