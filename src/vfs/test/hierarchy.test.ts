/**
 * Hierarchy lives beside the nodes, not on them: a node read carries no child
 * list, and adding or dropping one edge must not touch its siblings.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAlreadyExistsError, NodeInvalidOperationError } from '../mod.ts';
import { mkdir, mkfile } from './helpers.ts';

Deno.test('VFS hierarchy', async (t) => {
  const ctx = await createTestVfs();
  const { vfs, store } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'dir');

    await t.step('childCount answers without listing', async () => {
      assertEquals(await vfs.childCount(ADMIN_ACCESS, '/dir'), 0);

      await mkfile(vfs, ADMIN_ACCESS, '/dir', 'a.txt', 'a');
      await mkfile(vfs, ADMIN_ACCESS, '/dir', 'b.txt', 'b');

      assertEquals(await vfs.childCount(ADMIN_ACCESS, '/dir'), 2);
    });

    await t.step('listing carries each entry name and child count', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/dir', 'sub');
      await mkfile(vfs, ADMIN_ACCESS, '/dir/sub', 'c.txt', 'c');

      const entries = await vfs.children(ADMIN_ACCESS, '/dir');
      assertEquals(entries.map((e) => e.name).toSorted(), ['a.txt', 'b.txt', 'sub']);

      const sub = entries.find((e) => e.name === 'sub');
      assertEquals(sub?.childCount, 1);
      assertEquals(entries.find((e) => e.name === 'a.txt')?.childCount, 0);
    });

    await t.step('child links come only when asked for', async () => {
      const plain = await vfs.children(ADMIN_ACCESS, '/dir');
      assertEquals(plain.find((e) => e.name === 'sub')?.children, undefined);

      const withLinks = await vfs.children(ADMIN_ACCESS, '/dir', { childLinks: true });
      assertEquals(withLinks.find((e) => e.name === 'sub')?.children?.map((c) => c.name), ['c.txt']);
      assertEquals(withLinks.find((e) => e.name === 'a.txt')?.children, []);
    });

    // One edge in, one edge out, whatever the directory's size: the siblings'
    // edges are left as they are, not recreated.
    await t.step('linking leaves the siblings untouched', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'many');
      for (let i = 0; i < 5; i++) {
        await mkfile(vfs, ADMIN_ACCESS, '/many', `f${i}.txt`, String(i));
      }

      const before = await store.getChildLinks((await vfs.get(ADMIN_ACCESS, '/many')).id);
      await vfs.link(ADMIN_ACCESS, '/dir/a.txt', '/many', 'linked.txt');
      const after = await store.getChildLinks((await vfs.get(ADMIN_ACCESS, '/many')).id);

      assertEquals(after.length, before.length + 1);
      // Every pre-existing edge kept its id, name and slot
      for (const link of before) {
        const still = after.find((l) => l.name === link.name);
        assertEquals(still?.id, link.id);
        assertEquals(still?.position, link.position);
      }
    });

    await t.step('unlinking removes only its own edge', async () => {
      const parentId = (await vfs.get(ADMIN_ACCESS, '/many')).id;
      await vfs.unlink(ADMIN_ACCESS, '/many/linked.txt', '/many');

      const after = await store.getChildLinks(parentId);
      assertEquals(after.map((l) => l.name).toSorted(), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
      assertEquals(await vfs.childCount(ADMIN_ACCESS, '/many'), 5);
    });

    await t.step('renaming in place keeps the entry ordering', async () => {
      const parentId = (await vfs.get(ADMIN_ACCESS, '/many')).id;
      const before = await store.getChildLinks(parentId);
      const slot = before.find((l) => l.name === 'f2.txt');

      await vfs.rename(ADMIN_ACCESS, '/many', 'f2.txt', '/many', 'renamed.txt');

      const after = await store.getChildLinks(parentId);
      const moved = after.find((l) => l.name === 'renamed.txt');
      assertEquals(moved?.id, slot?.id);
      assertEquals(moved?.position, slot?.position);
      assertEquals(after.length, before.length);
    });

    await t.step('a name is still unique within a parent', async () => {
      await assertRejects(
        () => mkdir(vfs, ADMIN_ACCESS, '/many', 'f0.txt'),
        NodeAlreadyExistsError,
      );
      await assertRejects(
        () => vfs.link(ADMIN_ACCESS, '/dir/a.txt', '/many', 'f0.txt'),
        NodeAlreadyExistsError,
      );
    });

    await t.step('a non-empty node still needs recursive to go', async () => {
      await assertRejects(
        () => vfs.unlink(ADMIN_ACCESS, '/dir/sub', '/dir'),
        NodeInvalidOperationError,
      );

      await vfs.unlink(ADMIN_ACCESS, '/dir/sub', '/dir', { recursive: true });
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/dir/sub'), false);
    });

    await t.step('a node read carries no child list', async () => {
      const node = await vfs.get(ADMIN_ACCESS, '/many');
      assertEquals('children' in node.props, false);
    });
  } finally {
    await ctx.dispose();
  }
});
