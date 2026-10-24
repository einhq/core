/**
 * VFS link semantics: hard link refcounting, softlink resolution
 * (follow / no-follow, dangling, loops) and unlink behavior.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeNotFoundError } from '../mod.ts';
import { mkdir, mkfile, readFile } from './helpers.ts';

Deno.test('VFS links', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'dir1');
    await mkdir(vfs, ADMIN_ACCESS, '/', 'dir2');

    await t.step('hard link shares identity and increments count', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/dir1', 'orig.txt', 'shared');
      const orig = await vfs.get(ADMIN_ACCESS, '/dir1/orig.txt');
      assertEquals(orig.props.count, 1);

      const linked = await vfs.link(ADMIN_ACCESS, '/dir1/orig.txt', '/dir2', 'hard.txt');
      assertEquals(linked.id, orig.id);
      assertEquals(linked.props.count, 2);

      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dir2/hard.txt'), 'shared');
    });

    await t.step('node survives until the last unlink', async () => {
      const id = (await vfs.get(ADMIN_ACCESS, '/dir1/orig.txt')).id;

      await vfs.unlink(ADMIN_ACCESS, '/dir1/orig.txt', '/dir1');

      // Still reachable through the second link
      const viaLink = await vfs.get(ADMIN_ACCESS, '/dir2/hard.txt');
      assertEquals(viaLink.id, id);
      assertEquals(viaLink.props.count, 1);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dir2/hard.txt'), 'shared');

      // Last unlink deletes the node
      await vfs.unlink(ADMIN_ACCESS, '/dir2/hard.txt', '/dir2');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/dir2/hard.txt'), false);
    });

    await t.step('unlinking one of two names under one parent keeps the other', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/dir1', 'a.txt', 'twice');
      await vfs.link(ADMIN_ACCESS, '/dir1/a.txt', '/dir1', 'b.txt');

      await vfs.unlink(ADMIN_ACCESS, '/dir1/b.txt', '/dir1');
      const viaA = await vfs.get(ADMIN_ACCESS, '/dir1/a.txt');
      assertEquals(viaA.props.count, 1);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/dir1/b.txt'), false);

      await vfs.link(ADMIN_ACCESS, '/dir1/a.txt', '/dir1', 'b.txt');
      await vfs.unlink(ADMIN_ACCESS, '/dir1/a.txt', '/dir1');
      const viaB = await vfs.get(ADMIN_ACCESS, '/dir1/b.txt');
      assertEquals(viaB.props.count, 1);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dir1/b.txt'), 'twice');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/dir1/a.txt'), false);

      await vfs.unlink(ADMIN_ACCESS, '/dir1/b.txt', '/dir1');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/dir1/b.txt'), false);
    });

    await t.step('softlink resolves to its target', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/dir1', 'target.txt', 'the target');
      await vfs.create(ADMIN_ACCESS, 'softlink', '/dir2', 'soft', {
        props: { mode: 0o777, softlink: '/dir1/target.txt' },
      });

      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dir2/soft'), 'the target');

      const followed = await vfs.get(ADMIN_ACCESS, '/dir2/soft');
      assertEquals(followed.type, 'file');
    });

    await t.step('follow:false returns the softlink itself', async () => {
      const link = await vfs.get(ADMIN_ACCESS, '/dir2/soft', { follow: false });
      assertEquals(link.type, 'softlink');
      assertEquals(link.props.softlink, '/dir1/target.txt');
    });

    await t.step('dangling softlink fails to resolve', async () => {
      await vfs.create(ADMIN_ACCESS, 'softlink', '/dir2', 'dangling', {
        props: { mode: 0o777, softlink: '/nonexistent/nowhere' },
      });

      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/dir2/dangling'), NodeNotFoundError);

      // But it is visible without following
      const link = await vfs.get(ADMIN_ACCESS, '/dir2/dangling', { follow: false });
      assertEquals(link.type, 'softlink');
    });

    await t.step('softlink loops are detected', async () => {
      await vfs.create(ADMIN_ACCESS, 'softlink', '/dir2', 'loop-a', {
        props: { mode: 0o777, softlink: '/dir2/loop-b' },
      });
      await vfs.create(ADMIN_ACCESS, 'softlink', '/dir2', 'loop-b', {
        props: { mode: 0o777, softlink: '/dir2/loop-a' },
      });

      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/dir2/loop-a'));
    });

    await t.step('unlink of non-empty directory requires recursive', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'full');
      await mkfile(vfs, ADMIN_ACCESS, '/full', 'child.txt', 'x');

      await assertRejects(() => vfs.unlink(ADMIN_ACCESS, '/full', '/'));

      await vfs.unlink(ADMIN_ACCESS, '/full', '/', { recursive: true });
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/full'), false);
    });

    await t.step('recursive unlink drops softlink children, not their targets', async () => {
      // The shape every album of softlink members has: a recursive unlink
      // removes the album's links, never the media they point at.
      await mkdir(vfs, ADMIN_ACCESS, '/', 'media');
      await mkfile(vfs, ADMIN_ACCESS, '/media', 'photo.jpg', 'bytes');
      await mkdir(vfs, ADMIN_ACCESS, '/', 'album');
      await vfs.create(ADMIN_ACCESS, 'softlink', '/album', 'photo.jpg', {
        props: { mode: 0o777, softlink: '/media/photo.jpg' },
      });

      await vfs.unlink(ADMIN_ACCESS, '/album', '/', { recursive: true });

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/album'), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/media/photo.jpg'), true);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/media/photo.jpg'), 'bytes');
    });
  } finally {
    await ctx.dispose();
  }
});
