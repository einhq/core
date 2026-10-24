/**
 * `getParentLinksByIds` — which parent a batch of ids hangs under, and under
 * what name, without building a single path.
 *
 * A caller holding thousands of ids from a registry uses this to tell what each
 * one *is* before deciding which few are worth resolving in full, so the two
 * things that matter are that it answers for the whole batch at once and that
 * it reports every edge a hard-linked node has.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { mkdir, mkdirp, mkfile } from './helpers.ts';

Deno.test('VFS parent links', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'dir1');
    await mkdir(vfs, ADMIN_ACCESS, '/', 'dir2');
    const a = await mkfile(vfs, ADMIN_ACCESS, '/dir1', 'a.txt', 'a');
    const b = await mkfile(vfs, ADMIN_ACCESS, '/dir2', 'b.txt', 'b');
    const dir1 = await vfs.get(ADMIN_ACCESS, '/dir1');
    const dir2 = await vfs.get(ADMIN_ACCESS, '/dir2');

    await t.step('reports the parent and the name for a whole batch', async () => {
      const links = await vfs.getParentLinksByIds(ADMIN_ACCESS, [a.id, b.id]);

      assertEquals(links.get(a.id), [{ parentId: dir1.id, name: 'a.txt' }]);
      assertEquals(links.get(b.id), [{ parentId: dir2.id, name: 'b.txt' }]);
    });

    await t.step('a hard link is a second edge, not a second node', async () => {
      await vfs.link(ADMIN_ACCESS, '/dir1/a.txt', '/dir2', 'also-a.txt');

      const links = await vfs.getParentLinksByIds(ADMIN_ACCESS, [a.id]);
      assertEquals(links.get(a.id)?.length, 2);
      assertEquals(
        links.get(a.id)?.map((link) => link.name).toSorted(),
        ['a.txt', 'also-a.txt'],
      );
    });

    await t.step('an id that hangs nowhere is simply absent', async () => {
      const links = await vfs.getParentLinksByIds(ADMIN_ACCESS, [a.id, '01ZZZZZZZZZZZZZZZZZZZZZZZZ']);

      assertEquals(links.has(a.id), true);
      assertEquals(links.has('01ZZZZZZZZZZZZZZZZZZZZZZZZ'), false);
      assertEquals(await vfs.getParentLinksByIds(ADMIN_ACCESS, []), new Map());
    });

    await t.step('a registry hit names what it belongs to', async () => {
      // A position registry hit is a `position` child; one batched lookup gives
      // the node it belongs to, a file or a location alike, without a resolve per hit.
      await mkdirp(vfs, ADMIN_ACCESS, '/archive/locations');
      const photo = await mkfile(vfs, ADMIN_ACCESS, '/dir1', 'photo.jpg', 'x');
      const location = await vfs.create(ADMIN_ACCESS, 'location', '/archive/locations', 'the-park');
      const geo = await vfs.create(ADMIN_ACCESS, 'position', '/dir1/photo.jpg', 'position');
      const shape = await vfs.create(ADMIN_ACCESS, 'position', `/archive/locations/the-park`, 'position');

      const links = await vfs.getParentLinksByIds(ADMIN_ACCESS, [geo.id, shape.id]);
      assertEquals(links.get(geo.id), [{ parentId: photo.id, name: 'position' }]);
      assertEquals(links.get(shape.id), [{ parentId: location.id, name: 'position' }]);
    });
  } finally {
    await ctx.dispose();
  }
});
