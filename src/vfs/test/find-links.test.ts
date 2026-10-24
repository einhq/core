/**
 * Backlinks: finding the softlinks that point *at* a node, which is how a
 * person or a location answers "what refers to me?" without walking the tree.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, GUEST_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { mkdir, mkdirp, mkfile } from './helpers.ts';

Deno.test('VFS findLinks', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  const mklink = (parent: string, name: string, target: string) =>
    vfs.create(ADMIN_ACCESS, 'softlink', parent, name, {
      props: { mode: 0o777, softlink: target },
    });

  try {
    await mkdirp(vfs, ADMIN_ACCESS, '/archive/locations');
    await mkdirp(vfs, ADMIN_ACCESS, '/archive/people');
    await mkdirp(vfs, ADMIN_ACCESS, '/archive/albums');
    await vfs.create(ADMIN_ACCESS, 'location', '/archive/locations', 'park');
    await vfs.create(ADMIN_ACCESS, 'location', '/archive/locations', 'beach');

    // A file holds its links as children, so it needs execute to be passed through — as every
    // media file in a real archive has.
    await mkfile(vfs, ADMIN_ACCESS, '/archive/albums', 'a.jpg', 'a', 0o755);
    await mkfile(vfs, ADMIN_ACCESS, '/archive/albums', 'b.jpg', 'b', 0o755);
    await mkfile(vfs, ADMIN_ACCESS, '/archive/albums', 'c.jpg', 'c', 0o755);

    await t.step('finds every link to a target, with the holder as parent', async () => {
      await mklink(`/archive/albums/a.jpg`, 'location', `/archive/locations/park`);
      await mklink(`/archive/albums/b.jpg`, 'location', `/archive/locations/park`);
      await mklink(`/archive/albums/c.jpg`, 'location', `/archive/locations/beach`);

      const links = await vfs.findLinks(ADMIN_ACCESS, `/archive/locations/park`);
      assertEquals(links.length, 2);
      assertEquals(links.map((l) => l.absPath).sort(), [`/archive/albums/a.jpg/location`, `/archive/albums/b.jpg/location`]);
      assertEquals(links.every((l) => l.target === `/archive/locations/park`), true);

      // parentId is the file holding the link — what a caller actually wants.
      const fileId = (await vfs.get(ADMIN_ACCESS, `/archive/albums/a.jpg`)).id;
      assertEquals(links.find((l) => l.absPath.startsWith(`/archive/albums/a.jpg`))?.parentId, fileId);
    });

    await t.step('takes several targets at once', async () => {
      const links = await vfs.findLinks(ADMIN_ACCESS, [`/archive/locations/park`, `/archive/locations/beach`]);
      assertEquals(links.length, 3);
    });

    await t.step('ignores links to other targets and non-link nodes', async () => {
      assertEquals((await vfs.findLinks(ADMIN_ACCESS, `/archive/locations/nowhere`)).length, 0);
      assertEquals((await vfs.findLinks(ADMIN_ACCESS, [])).length, 0);
    });

    await t.step('a link nested under a subdirectory reports that directory', async () => {
      await mkdir(vfs, ADMIN_ACCESS, `/archive/albums/a.jpg`, 'people');
      await mklink(`/archive/albums/a.jpg/people`, 'anna', `/archive/people/anna`);

      const links = await vfs.findLinks(ADMIN_ACCESS, `/archive/people/anna`);
      assertEquals(links.length, 1);
      assertEquals(links[0].absPath, `/archive/albums/a.jpg/people/anna`);

      const dirId = (await vfs.get(ADMIN_ACCESS, `/archive/albums/a.jpg/people`)).id;
      assertEquals(links[0].parentId, dirId);
    });

    await t.step('honours the limit', async () => {
      assertEquals((await vfs.findLinks(ADMIN_ACCESS, `/archive/locations/park`, 1)).length, 1);
      assertEquals((await vfs.findLinks(ADMIN_ACCESS, `/archive/locations/park`, 0)).length, 0);
    });

    await t.step('drops links the caller cannot read', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/archive/albums', 'secret.jpg', 's');
      await vfs.create(ADMIN_ACCESS, 'softlink', `/archive/albums/secret.jpg`, 'location', {
        props: { mode: 0o700, uid: 0, gid: 0, softlink: `/archive/locations/beach` },
      });

      const asAdmin = await vfs.findLinks(ADMIN_ACCESS, `/archive/locations/beach`);
      assertEquals(asAdmin.length, 2);

      const asGuest = await vfs.findLinks(GUEST_ACCESS, `/archive/locations/beach`);
      assertEquals(asGuest.map((l) => l.absPath), [`/archive/albums/c.jpg/location`]);
    });

    await t.step('drops links under a directory the caller cannot pass through', async () => {
      // Readable itself, but only reachable through a 0700 directory — the way a path walk sees it.
      await mkdir(vfs, ADMIN_ACCESS, '/archive/albums', 'private', 0o700);
      await mkfile(vfs, ADMIN_ACCESS, `/archive/albums/private`, 'd.jpg', 'd', 0o755);
      await mklink(`/archive/albums/private/d.jpg`, 'location', `/archive/locations/park`);

      assertEquals((await vfs.findLinks(ADMIN_ACCESS, `/archive/locations/park`)).length, 3);
      const asGuest = await vfs.findLinks(GUEST_ACCESS, `/archive/locations/park`);
      assertEquals(asGuest.map((l) => l.absPath).sort(), [`/archive/albums/a.jpg/location`, `/archive/albums/b.jpg/location`]);
    });
  } finally {
    await ctx.dispose();
  }
});
