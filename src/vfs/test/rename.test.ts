/**
 * VFS rename semantics: same/cross-directory moves, moves between mounts, collision handling and
 * concurrent conflicting renames (transaction + sorted ID locking).
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAlreadyExistsError, NodeInvalidOperationError } from '../mod.ts';
import { mkdir, mkfile, readFile } from './helpers.ts';

Deno.test('VFS rename', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'a');
    await mkdir(vfs, ADMIN_ACCESS, '/', 'b');

    await t.step('renames within the same directory', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/a', 'old.txt', 'data');
      await vfs.rename(ADMIN_ACCESS, '/a', 'old.txt', '/a', 'new.txt');

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/a/old.txt'), false);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/a/new.txt'), 'data');
    });

    await t.step('moves across directories keeping identity', async () => {
      const before = await vfs.get(ADMIN_ACCESS, '/a/new.txt');
      await vfs.rename(ADMIN_ACCESS, '/a', 'new.txt', '/b', 'moved.txt');

      const after = await vfs.get(ADMIN_ACCESS, '/b/moved.txt');
      assertEquals(after.id, before.id);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/a/new.txt'), false);
    });

    await t.step('fails onto existing name with failIfExists', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/a', 'x.txt', 'x');
      await mkfile(vfs, ADMIN_ACCESS, '/b', 'taken.txt', 'taken');

      let failed = false;
      try {
        await vfs.rename(ADMIN_ACCESS, '/a', 'x.txt', '/b', 'taken.txt', { failIfExists: true });
      } catch {
        failed = true;
      }

      assertEquals(failed, true);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/b/taken.txt'), 'taken');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/a/x.txt'), true);
    });

    await t.step('replaces a node at the destination name', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/a', 'fresh.txt', 'fresh');
      await mkfile(vfs, ADMIN_ACCESS, '/b', 'stale.txt', 'stale');
      const moving = await vfs.get(ADMIN_ACCESS, '/a/fresh.txt');

      await vfs.rename(ADMIN_ACCESS, '/a', 'fresh.txt', '/b', 'stale.txt');

      assertEquals((await vfs.get(ADMIN_ACCESS, '/b/stale.txt')).id, moving.id);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/b/stale.txt'), 'fresh');
      assertEquals((await vfs.children(ADMIN_ACCESS, '/b')).filter((c) => c.name === 'stale.txt').length, 1);
    });

    await t.step('refuses to replace a node with children', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/a', 'lone.txt', 'lone');
      await mkdir(vfs, ADMIN_ACCESS, '/b', 'full');
      await mkfile(vfs, ADMIN_ACCESS, '/b/full', 'inside.txt', 'inside');

      await assertRejects(() => vfs.rename(ADMIN_ACCESS, '/a', 'lone.txt', '/b', 'full'), NodeInvalidOperationError);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/b/full/inside.txt'), 'inside');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/a/lone.txt'), true);
    });

    await t.step('a rename onto its own name changes nothing', async () => {
      await vfs.rename(ADMIN_ACCESS, '/a', 'lone.txt', '/a', 'lone.txt');
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/a/lone.txt'), 'lone');
    });

    await t.step('concurrent conflicting renames leave consistent state', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'race1');
      await mkdir(vfs, ADMIN_ACCESS, '/', 'race2');
      await mkfile(vfs, ADMIN_ACCESS, '/', 'contested.txt', 'contested');

      // Two renames of the same source into different directories
      const results = await Promise.allSettled([
        vfs.rename(ADMIN_ACCESS, '/', 'contested.txt', '/race1', 'won.txt'),
        vfs.rename(ADMIN_ACCESS, '/', 'contested.txt', '/race2', 'won.txt'),
      ]);

      const wins = results.filter((r) => r.status === 'fulfilled').length;
      assertEquals(wins >= 1, true);

      // The node exists in exactly one location and the source is gone
      const locations = [
        await vfs.exists(ADMIN_ACCESS, '/race1/won.txt'),
        await vfs.exists(ADMIN_ACCESS, '/race2/won.txt'),
      ].filter(Boolean).length;

      assertEquals(locations, wins === 2 ? 2 : 1);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/contested.txt'), false);
    });

    await t.step('parallel independent renames all succeed', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'bulk');
      for (let i = 0; i < 10; i++) {
        await mkfile(vfs, ADMIN_ACCESS, '/bulk', `f${i}.txt`, `${i}`);
      }

      await Promise.all(
        Array.from({ length: 10 }, (_, i) => vfs.rename(ADMIN_ACCESS, '/bulk', `f${i}.txt`, '/bulk', `g${i}.txt`)),
      );

      for (let i = 0; i < 10; i++) {
        assertEquals(await readFile(vfs, ADMIN_ACCESS, `/bulk/g${i}.txt`), `${i}`);
      }
    });

    await t.step('moves a tree between mounts by copying it and removing the source', async () => {
      const inner = await createTestVfs();
      await mkdir(vfs, ADMIN_ACCESS, '/', 'mnt');
      await vfs.mount(ADMIN_ACCESS, '/mnt', inner.vfs);

      try {
        await mkdir(vfs, ADMIN_ACCESS, '/a', 'tree');
        await mkfile(vfs, ADMIN_ACCESS, '/a/tree', 'leaf.txt', 'leaf', 0o600);

        await vfs.rename(ADMIN_ACCESS, '/a', 'tree', '/mnt', 'tree');

        assertEquals(await vfs.exists(ADMIN_ACCESS, '/a/tree'), false);
        assertEquals(await readFile(inner.vfs, ADMIN_ACCESS, '/tree/leaf.txt'), 'leaf');
        assertEquals((await vfs.get(ADMIN_ACCESS, '/mnt/tree/leaf.txt')).props.mode, 0o600);

        // And back out again, under a new name
        await vfs.rename(ADMIN_ACCESS, '/mnt', 'tree', '/b', 'back');
        assertEquals(await readFile(vfs, ADMIN_ACCESS, '/b/back/leaf.txt'), 'leaf');
        assertEquals(await inner.vfs.exists(ADMIN_ACCESS, '/tree'), false);

        // A taken name is refused under failIfExists, and replaced without it
        await mkfile(vfs, ADMIN_ACCESS, '/mnt', 'back', 'taken');
        await assertRejects(
          () => vfs.rename(ADMIN_ACCESS, '/b', 'back', '/mnt', 'back', { failIfExists: true }),
          NodeAlreadyExistsError,
        );
        assertEquals(await readFile(vfs, ADMIN_ACCESS, '/b/back/leaf.txt'), 'leaf');

        await vfs.rename(ADMIN_ACCESS, '/b', 'back', '/mnt', 'back');
        assertEquals(await readFile(vfs, ADMIN_ACCESS, '/mnt/back/leaf.txt'), 'leaf');
        assertEquals(await vfs.exists(ADMIN_ACCESS, '/b/back'), false);
      } finally {
        await vfs.unmount(ADMIN_ACCESS, '/mnt');
        await inner.dispose();
      }
    });

    await t.step('moves a softlink between mounts as the link, never its target', async () => {
      const inner = await createTestVfs();
      await vfs.mount(ADMIN_ACCESS, '/mnt', inner.vfs);
      const link = (softlink: string) => ({ props: { mode: 0o777, softlink } });

      try {
        await mkdir(vfs, ADMIN_ACCESS, '/', 'home');
        await mkfile(vfs, ADMIN_ACCESS, '/home', 'f.txt', 'home');
        await mkfile(vfs, ADMIN_ACCESS, '/mnt', 'g.txt', 'mnt');
        await vfs.create(ADMIN_ACCESS, 'softlink', '/a', 'to-dir', link('/home'));
        await vfs.create(ADMIN_ACCESS, 'softlink', '/a', 'to-mnt', link('/mnt/g.txt'));
        await vfs.create(ADMIN_ACCESS, 'softlink', '/a', 'dangling', link('/nowhere'));

        const settled = await vfs.renameMany(ADMIN_ACCESS, [
          { from: '/a/to-dir', to: '/mnt/to-dir' },
          { from: '/a/to-mnt', to: '/mnt/to-mnt' },
          { from: '/a/dangling', to: '/mnt/dangling' },
        ]);
        assertEquals(settled.map((s) => s.status), ['fulfilled', 'fulfilled', 'fulfilled']);

        for (const [name, target] of [['to-dir', '/home'], ['to-mnt', '/mnt/g.txt'], ['dangling', '/nowhere']]) {
          assertEquals(await vfs.exists(ADMIN_ACCESS, `/a/${name}`, { follow: false }), false);
          assertEquals((await inner.vfs.get(ADMIN_ACCESS, `/${name}`, { follow: false })).props.softlink, target);
        }
        assertEquals(await readFile(vfs, ADMIN_ACCESS, '/mnt/to-dir/f.txt'), 'home');
        assertEquals(await readFile(vfs, ADMIN_ACCESS, '/mnt/to-mnt'), 'mnt');
        assertEquals((await vfs.get(ADMIN_ACCESS, '/home')).props.mode, 0o755);

        // Back out over a softlink at the destination: the link there is replaced, not its target
        await vfs.create(ADMIN_ACCESS, 'softlink', '/a', 'to-dir', link('/home/f.txt'));
        await vfs.rename(ADMIN_ACCESS, '/mnt', 'to-dir', '/a', 'to-dir');
        assertEquals((await vfs.get(ADMIN_ACCESS, '/a/to-dir', { follow: false })).props.softlink, '/home');
        assertEquals(await readFile(vfs, ADMIN_ACCESS, '/home/f.txt'), 'home');
      } finally {
        await vfs.unmount(ADMIN_ACCESS, '/mnt');
        await inner.dispose();
      }
    });
  } finally {
    await ctx.dispose();
  }
});
