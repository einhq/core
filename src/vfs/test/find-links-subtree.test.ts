/**
 * Links under a path: `findLinksUnder` finds the softlinks pointing at each path or at
 * anything under it — what a move of those paths has to re-point — as `findLinks` finds them:
 * access-filtered, resolved to absolute paths, and through mounts.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, GUEST_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { mkdir, mkdirp } from './helpers.ts';

Deno.test('VFS findLinksUnder', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  const mklink = (parent: string, name: string, target: string, mode = 0o777) => vfs.create(ADMIN_ACCESS, 'softlink', parent, name, { props: { mode, softlink: target } });
  const targets = async (paths: string[], access = ADMIN_ACCESS) => (await vfs.findLinksUnder(access, paths, 100)).map((link) => `${link.absPath} -> ${link.target}`).sort();

  try {
    await mkdirp(vfs, ADMIN_ACCESS, '/links');
    await mklink('/links', 'album', '/archive/albums/trip');
    await mklink('/links', 'photo', '/archive/albums/trip/files/a.jpg');
    await mklink('/links', 'face', '/archive/albums/trip/files/a.jpg/regions/r1');
    await mklink('/links', 'sibling', '/archive/albums/trips');
    await mklink('/links', 'dashed', '/archive/albums/trip-2');
    await mklink('/links', 'other', '/archive/albums/beach');

    await t.step('a path and everything under it, never a sibling that shares its prefix', async () => {
      assertEquals(await targets(['/archive/albums/trip']), [
        '/links/album -> /archive/albums/trip',
        '/links/face -> /archive/albums/trip/files/a.jpg/regions/r1',
        '/links/photo -> /archive/albums/trip/files/a.jpg',
      ]);
    });

    await t.step('several paths at once, a link counted once', async () => {
      assertEquals((await targets(['/archive/albums/trip/files', '/archive/albums/trip/files/a.jpg', '/archive/albums/beach'])).length, 3);
    });

    await t.step('findLinks takes only the links at the path itself', async () => {
      assertEquals((await vfs.findLinks(ADMIN_ACCESS, '/archive/albums/trip')).map((link) => link.absPath), ['/links/album']);
    });

    await t.step('a link the caller cannot read is left out', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'private', 0o700);
      await mklink('/private', 'hidden', '/archive/albums/trip/files/b.jpg', 0o700);

      assertEquals((await targets(['/archive/albums/trip'])).length, 4);
      assertEquals((await targets(['/archive/albums/trip'], GUEST_ACCESS)).length, 3);
    });

    await t.step('a link held in a mount is found, under its mount point', async () => {
      const mounted = await createTestVfs();
      try {
        await mkdir(vfs, ADMIN_ACCESS, '/', 'mnt');
        await vfs.mount(ADMIN_ACCESS, '/mnt', mounted.vfs);
        await vfs.create(ADMIN_ACCESS, 'softlink', '/mnt', 'far', { props: { mode: 0o777, softlink: '/archive/albums/trip/files/c.jpg' } });

        assertEquals((await targets(['/archive/albums/trip/files'])).filter((line) => line.startsWith('/mnt/')), [
          '/mnt/far -> /archive/albums/trip/files/c.jpg',
        ]);
      } finally {
        await mounted.dispose();
      }
    });
  } finally {
    await ctx.dispose();
  }
});
