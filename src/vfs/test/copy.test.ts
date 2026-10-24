/**
 * VFS copy semantics: single file, recursive trees, overwrite behavior,
 * attribute/mode preservation, cross-mount copies, and copies that are refused.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAccessDeniedError, NodeAlreadyExistsError, type NodeEvent } from '../mod.ts';
import { mkdir, mkfile, readFile } from './helpers.ts';

const USER: Access = { uid: 5000, gid: 4000, gids: [4000] };

Deno.test('VFS copy', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  try {
    await mkdir(vfs, ADMIN_ACCESS, '/', 'src');
    await mkdir(vfs, ADMIN_ACCESS, '/', 'dst');
    await mkfile(vfs, ADMIN_ACCESS, '/src', 'a.txt', 'content a');

    await t.step('copies a single file with content', async () => {
      const copy = await vfs.copy(ADMIN_ACCESS, '/src/a.txt', '/dst');

      assertEquals(copy.type, 'file');
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dst/a.txt'), 'content a');

      // Source is untouched
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/src/a.txt'), 'content a');
    });

    await t.step('copies under a new name', async () => {
      await vfs.copy(ADMIN_ACCESS, '/src/a.txt', '/dst', 'renamed.txt');
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dst/renamed.txt'), 'content a');
    });

    await t.step('fails on existing destination without overwrite', async () => {
      await assertRejects(
        () => vfs.copy(ADMIN_ACCESS, '/src/a.txt', '/dst'),
        NodeAlreadyExistsError,
      );
    });

    await t.step('overwrites when overwrite is set', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/src', 'b.txt', 'new content');
      await vfs.copy(ADMIN_ACCESS, '/src/b.txt', '/dst', 'a.txt', { overwrite: true });

      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dst/a.txt'), 'new content');
    });

    await t.step('copies a tree recursively', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/src', 'tree');
      await mkdir(vfs, ADMIN_ACCESS, '/src/tree', 'sub');
      await mkfile(vfs, ADMIN_ACCESS, '/src/tree', 'top.txt', 'top');
      await mkfile(vfs, ADMIN_ACCESS, '/src/tree/sub', 'deep.txt', 'deep');

      await vfs.copy(ADMIN_ACCESS, '/src/tree', '/dst', undefined, { recursive: true });

      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dst/tree/top.txt'), 'top');
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dst/tree/sub/deep.txt'), 'deep');
    });

    await t.step('preserves mode and attrs', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/src', 'mode.txt', 'x', 0o600);
      await vfs.copy(ADMIN_ACCESS, '/src/mode.txt', '/dst');

      const copy = await vfs.get(ADMIN_ACCESS, '/dst/mode.txt');
      assertEquals(copy.props.mode, 0o600);
      assertEquals(copy.attrs.mimetype, 'text/plain');
    });

    await t.step('copies across mounts (different backend)', async () => {
      const inner = await createTestVfs();
      await mkdir(vfs, ADMIN_ACCESS, '/', 'mnt');
      await vfs.mount(ADMIN_ACCESS, '/mnt', inner.vfs);

      try {
        await vfs.copy(ADMIN_ACCESS, '/src/a.txt', '/mnt');
        assertEquals(await readFile(vfs, ADMIN_ACCESS, '/mnt/a.txt'), 'content a');

        // Verify it actually landed on the inner VFS
        assertEquals(await readFile(inner.vfs, ADMIN_ACCESS, '/a.txt'), 'content a');
      } finally {
        await vfs.unmount(ADMIN_ACCESS, '/mnt');
        await inner.dispose();
      }
    });

    await t.step('a read-only tree copies with its modes', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'area', 0o777);
      await mkdir(vfs, USER, '/area', 'ro');
      await mkfile(vfs, USER, '/area/ro', 'note.txt', 'kept');
      await vfs.update(USER, '/area/ro/note.txt', { props: { mode: 0o444 } });
      await vfs.update(USER, '/area/ro', { props: { mode: 0o555 } });

      await vfs.copy(USER, '/area/ro', '/area', 'ro-copy', { recursive: true });

      assertEquals(await readFile(vfs, USER, '/area/ro-copy/note.txt'), 'kept');
      assertEquals((await vfs.get(USER, '/area/ro-copy')).props.mode, 0o555);
      assertEquals((await vfs.get(USER, '/area/ro-copy/note.txt')).props.mode, 0o444);
    });

    await t.step('a frozen file copies frozen', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/src', 'frozen.txt', 'still');
      await vfs.update(ADMIN_ACCESS, '/src/frozen.txt', { attrs: { frozen: true } });

      await vfs.copy(ADMIN_ACCESS, '/src/frozen.txt', '/dst');

      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/dst/frozen.txt'), 'still');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/dst/frozen.txt')).attrs.frozen, true);
    });

    await t.step('an unreadable node in the source leaves no copy behind', async () => {
      await mkdir(vfs, USER, '/area', 'mixed');
      await mkfile(vfs, USER, '/area/mixed', 'open.txt', 'open');
      await mkfile(vfs, ADMIN_ACCESS, '/area/mixed', 'closed.txt', 'closed', 0o600);

      await assertRejects(
        () => vfs.copy(USER, '/area/mixed', '/area', 'mixed-copy', { recursive: true }),
        NodeAccessDeniedError,
      );
      assertEquals(await vfs.exists(USER, '/area/mixed-copy'), false);
    });

    await t.step('a copied file is announced once its children are written', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/src', 'photo.jpg');
      await mkdir(vfs, ADMIN_ACCESS, '/src/photo.jpg', 'metadata');
      await mkdir(vfs, ADMIN_ACCESS, '/src/photo.jpg', 'thumbnails');

      // Stands in for an indexer: a node announced without `metadata/` gets `thumbnails/` made.
      const seen: string[] = [];
      const subscription = await vfs.subscribe(() => ADMIN_ACCESS, async (event: NodeEvent) => {
        if (event.type !== 'created' || event.path !== '/dst/photo.jpg') return;
        seen.push(event.path);
        if (!await vfs.exists(ADMIN_ACCESS, '/dst/photo.jpg/metadata')) await mkdir(vfs, ADMIN_ACCESS, '/dst/photo.jpg', 'thumbnails');
      });

      try {
        await vfs.copy(ADMIN_ACCESS, '/src/photo.jpg', '/dst', undefined, { recursive: true });
      } finally {
        await subscription.unsubscribe();
      }

      assertEquals(seen, ['/dst/photo.jpg']);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/dst/photo.jpg')).map((child) => child.name).sort(), ['metadata', 'thumbnails']);
    });
  } finally {
    await ctx.dispose();
  }
});
