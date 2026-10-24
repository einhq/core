/**
 * Recursive unlink: batched bottom-up removal.
 *
 * The subtree is emptied in transactions of `WRITE_BATCH` nodes rather than one
 * transaction over the whole tree, so the trees here are deliberately larger
 * than that batch — a tree that fits in one batch never spans transactions.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeInvalidOperationError } from '../mod.ts';
import { mkdir, mkfile, readFile } from './helpers.ts';

/** Wider than WRITE_BATCH (128) so a delete spans several transactions. */
const WIDE = 300;

Deno.test('VFS recursive delete', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await t.step('removes a subtree wider than one batch', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'wide');

      for (let i = 0; i < WIDE; i++) {
        await mkfile(vfs, ADMIN_ACCESS, '/wide', `f${i}.txt`, `body ${i}`);
      }

      assertEquals((await vfs.children(ADMIN_ACCESS, '/wide')).length, WIDE);

      await vfs.unlink(ADMIN_ACCESS, '/wide', '/', { recursive: true });

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/wide'), false);
    });

    await t.step('removes a subtree deeper than one batch', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'deep');

      let path = '/deep';
      for (let i = 0; i < 200; i++) {
        await mkdir(vfs, ADMIN_ACCESS, path, `d${i}`);
        path = `${path}/d${i}`;
      }
      await mkfile(vfs, ADMIN_ACCESS, path, 'leaf.txt', 'bottom');

      await vfs.unlink(ADMIN_ACCESS, '/deep', '/', { recursive: true });

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/deep'), false);
    });

    await t.step('non-recursive unlink of a non-empty node still fails', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'keepme');
      await mkfile(vfs, ADMIN_ACCESS, '/keepme', 'a.txt', 'a');

      await assertRejects(
        () => vfs.unlink(ADMIN_ACCESS, '/keepme', '/'),
        NodeInvalidOperationError,
      );

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/keepme/a.txt'), true);
    });

    await t.step('a hard-linked child keeps its own subtree', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'tree');
      await mkdir(vfs, ADMIN_ACCESS, '/tree', 'shared');
      await mkfile(vfs, ADMIN_ACCESS, '/tree/shared', 'data.txt', 'survives');
      await mkdir(vfs, ADMIN_ACCESS, '/', 'elsewhere');
      await vfs.link(ADMIN_ACCESS, '/tree/shared', '/elsewhere', 'shared');

      await vfs.unlink(ADMIN_ACCESS, '/tree', '/', { recursive: true });

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/tree'), false);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/elsewhere/shared/data.txt'), 'survives');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/elsewhere/shared')).props.count, 1);
    });

    await t.step('a directory linked twice within the subtree goes with its contents', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'twice');
      await mkdir(vfs, ADMIN_ACCESS, '/twice', 'a');
      await mkdir(vfs, ADMIN_ACCESS, '/twice', 'b');
      await mkdir(vfs, ADMIN_ACCESS, '/twice/a', 'inner');
      await mkfile(vfs, ADMIN_ACCESS, '/twice/a/inner', 'data.txt', 'goes');
      await vfs.link(ADMIN_ACCESS, '/twice/a/inner', '/twice/b', 'inner');
      await vfs.link(ADMIN_ACCESS, '/twice/a/inner', '/twice', 'top');

      await vfs.unlink(ADMIN_ACCESS, '/twice', '/', { recursive: true });

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/twice'), false);
    });

    await t.step('a softlink child is removed, its target is not', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'targets');
      await mkfile(vfs, ADMIN_ACCESS, '/targets', 'real.txt', 'untouched');
      await mkdir(vfs, ADMIN_ACCESS, '/', 'album');
      await vfs.create(ADMIN_ACCESS, 'softlink', '/album', 'member', {
        props: { mode: 0o777, softlink: '/targets/real.txt' },
      });

      await vfs.unlink(ADMIN_ACCESS, '/album', '/', { recursive: true });

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/album'), false);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/targets/real.txt'), 'untouched');
    });

    await t.step('unlinking one of several links leaves the subtree alone', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'twice');
      await mkfile(vfs, ADMIN_ACCESS, '/twice', 'inner.txt', 'kept');
      await mkdir(vfs, ADMIN_ACCESS, '/', 'other');
      await vfs.link(ADMIN_ACCESS, '/twice', '/other', 'twice');

      await vfs.unlink(ADMIN_ACCESS, '/twice', '/', { recursive: true });

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/twice'), false);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/other/twice/inner.txt'), 'kept');
    });

    // Two descents into one subtree must not interleave their locks into a
    // cycle nothing can break.
    await t.step('concurrent recursive deletes of the same subtree settle', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'contended');

      for (let i = 0; i < WIDE; i++) {
        await mkdir(vfs, ADMIN_ACCESS, '/contended', `s${i}`);
        await mkfile(vfs, ADMIN_ACCESS, `/contended/s${i}`, 'f.txt', `${i}`);
      }

      const results = await Promise.allSettled([
        vfs.unlink(ADMIN_ACCESS, '/contended', '/', { recursive: true }),
        vfs.unlink(ADMIN_ACCESS, '/contended', '/', { recursive: true }),
      ]);

      assertEquals(results.some((r) => r.status === 'fulfilled'), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/contended'), false);
    });

    await t.step('writes elsewhere are not blocked by a running delete', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'bulk');
      for (let i = 0; i < WIDE; i++) {
        await mkfile(vfs, ADMIN_ACCESS, '/bulk', `f${i}.txt`, `${i}`);
      }
      await mkdir(vfs, ADMIN_ACCESS, '/', 'busy');

      const deleting = vfs.unlink(ADMIN_ACCESS, '/bulk', '/', { recursive: true });

      const writes: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        writes.push(mkfile(vfs, ADMIN_ACCESS, '/busy', `w${i}.txt`, `${i}`));
      }

      await Promise.all(writes);
      await deleting;

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/bulk'), false);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/busy')).length, 20);
    });
  } finally {
    await ctx.dispose();
  }
});
