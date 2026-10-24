/**
 * Read-only mount enforcement: reads pass through a mount flagged readonly,
 * every mutation is rejected with NodeReadonlyError, a writable mount is
 * unaffected, and nested paths / structural mounts inside a readonly mount
 * are blocked too.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeReadonlyError } from '../mod.ts';
import { mkdir, mkfile, readFile } from './helpers.ts';

Deno.test('VFS read-only mount', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  // Backend mounted read-only, seeded directly (the readonly flag lives on the
  // parent mount, not on the backend, so direct writes here are fine).
  const ro = await createTestVfs();
  await mkdir(ro.vfs, ADMIN_ACCESS, '/', 'dir');
  await mkfile(ro.vfs, ADMIN_ACCESS, '/dir', 'deep.txt', 'deep');
  await mkfile(ro.vfs, ADMIN_ACCESS, '/', 'g.txt', 'world');

  // Writable control backend.
  const rw = await createTestVfs();
  await mkfile(rw.vfs, ADMIN_ACCESS, '/', 'c.txt', 'ctrl');

  await mkfile(vfs, ADMIN_ACCESS, '/', 'keep.txt', 'keep');
  await mkdir(vfs, ADMIN_ACCESS, '/', 'ro');
  await mkdir(vfs, ADMIN_ACCESS, '/', 'rw');
  await vfs.mount(ADMIN_ACCESS, '/ro', ro.vfs, { readonly: true });
  await vfs.mount(ADMIN_ACCESS, '/rw', rw.vfs);

  try {
    await t.step('reads pass through a read-only mount', async () => {
      assertEquals((await vfs.get(ADMIN_ACCESS, '/ro/dir')).type, 'directory');
      const names = (await vfs.children(ADMIN_ACCESS, '/ro')).map((c) => c.name).sort();
      assertEquals(names, ['dir', 'g.txt']);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/ro/g.txt'), 'world');
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/ro/dir/deep.txt'), 'deep');
      const stat = await vfs.stat(ADMIN_ACCESS, '/ro/g.txt');
      assertEquals(typeof stat.size, 'number');
    });

    await t.step('create is rejected', async () => {
      await assertRejects(
        () => vfs.create(ADMIN_ACCESS, 'directory', '/ro', 'new'),
        NodeReadonlyError,
      );
    });

    await t.step('create in a nested read-only dir is rejected', async () => {
      await assertRejects(
        () => vfs.create(ADMIN_ACCESS, 'file', '/ro/dir', 'x.txt'),
        NodeReadonlyError,
      );
    });

    await t.step('update is rejected', async () => {
      await assertRejects(
        () => vfs.update(ADMIN_ACCESS, '/ro/g.txt', { attrs: { size: 1 } }),
        NodeReadonlyError,
      );
    });

    await t.step('open for write is rejected', async () => {
      await assertRejects(
        () => vfs.open(ADMIN_ACCESS, '/ro/g.txt', { mode: 'w' }),
        NodeReadonlyError,
      );
    });

    await t.step('unlink is rejected', async () => {
      await assertRejects(
        () => vfs.unlink(ADMIN_ACCESS, '/ro/g.txt', '/ro'),
        NodeReadonlyError,
      );
    });

    await t.step('rename is rejected', async () => {
      await assertRejects(
        () => vfs.rename(ADMIN_ACCESS, '/ro', 'g.txt', '/ro', 'h.txt'),
        NodeReadonlyError,
      );
    });

    await t.step('link into a read-only mount is rejected', async () => {
      await assertRejects(
        () => vfs.link(ADMIN_ACCESS, '/keep.txt', '/ro', 'linked.txt'),
        NodeReadonlyError,
      );
    });

    await t.step('copy into a read-only mount is rejected', async () => {
      await assertRejects(
        () => vfs.copy(ADMIN_ACCESS, '/keep.txt', '/ro'),
        NodeReadonlyError,
      );
      // Backend is untouched.
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/ro/keep.txt'), false);
    });

    await t.step('mounting inside a read-only mount is rejected', async () => {
      const extra = await createTestVfs();
      try {
        await assertRejects(
          () => vfs.mount(ADMIN_ACCESS, '/ro/dir', extra.vfs),
          NodeReadonlyError,
        );
      } finally {
        await extra.dispose();
      }
    });

    await t.step('a writable mount still accepts writes', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/rw', 'made');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/rw/made')).type, 'directory');
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/rw/c.txt'), 'ctrl');
    });

    await t.step('the read-only mount itself can be unmounted', async () => {
      await vfs.unmount(ADMIN_ACCESS, '/ro');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/ro'), true); // mount point dir remains
      assertEquals((await vfs.children(ADMIN_ACCESS, '/ro')).length, 0);
    });
  } finally {
    // /ro already unmounted (and its backend disposed) by the last step.
    await vfs.unmount(ADMIN_ACCESS, '/rw');
    await rw.dispose();
    await ro.dispose();
    await ctx.dispose();
  }
});
