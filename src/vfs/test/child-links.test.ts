/**
 * `getChildLinksByIds` — the children of a batch of ids, name and id, without a path.
 *
 * A caller walks thousands of files down to their embeddings with it. Many of those ids are
 * leaves at some level, and an id with no children here is not sent on to a mount whose store
 * refuses ids it has never seen.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { FilesystemStore } from '../../stores/filesystem/index.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { LocalNodeVFS } from '../mod.ts';
import { mkdir, mkfile } from './helpers.ts';

Deno.test('VFS child links', async (t) => {
  // Mounted under a router-only root, as the primary instance is: every id is foreign there.
  const ctx = await createTestVfs({ rootMount: true });
  const { vfs } = ctx;
  const disk = await Deno.makeTempDir({ prefix: 'child-links-' });

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'dir');
    const parent = await vfs.get(ADMIN_ACCESS, '/dir');
    const a = await mkfile(vfs, ADMIN_ACCESS, '/dir', 'a.txt', 'a');
    const b = await mkfile(vfs, ADMIN_ACCESS, '/dir', 'b.txt', 'b');
    await mkdir(vfs, ADMIN_ACCESS, '/', 'fs');
    await vfs.mount(ADMIN_ACCESS, '/fs', new LocalNodeVFS(new FilesystemStore({ rootPath: disk }), ctx.routerManager, {}));

    await t.step('reports each parent’s children for the whole batch', async () => {
      const links = await vfs.getChildLinksByIds(ADMIN_ACCESS, [parent.id]);
      assertEquals(links.get(parent.id)?.map((link) => [link.name, link.id]).toSorted(), [['a.txt', a.id], ['b.txt', b.id]]);
    });

    await t.step('a leaf has no children, an id nobody holds is absent — and no mount refuses either', async () => {
      const links = await vfs.getChildLinksByIds(ADMIN_ACCESS, [parent.id, a.id, '01ZZZZZZZZZZZZZZZZZZZZZZZZ']);
      assertEquals(links.get(a.id), []);
      assertEquals([...links.keys()].toSorted(), [parent.id, a.id].toSorted());
      assertEquals(await vfs.getChildLinksByIds(ADMIN_ACCESS, []), new Map());
    });
  } finally {
    await ctx.dispose();
    await Deno.remove(disk, { recursive: true });
  }
});
