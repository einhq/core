/**
 * A filesystem mount counts and names only the children the caller may read, as the data store
 * does: its store has no count of its own, so the VFS judges each child by its file mode.
 */

import { assertEquals } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { FilesystemStore } from '../../stores/filesystem/index.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { LocalNodeVFS } from '../mod.ts';
import { mkdir } from './helpers.ts';

// Neither the owner nor in the group of the files the test writes: only the other bits apply.
const OTHER: Access = { uid: 6100, gid: 6100, gids: [6100] };

Deno.test('a filesystem mount counts the children the caller may read', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;
  const disk = await Deno.makeTempDir({ prefix: 'mount-readable-' });

  try {
    await Deno.chmod(disk, 0o755);
    await Deno.mkdir(`${disk}/album`, { mode: 0o755 });
    await Deno.mkdir(`${disk}/closed`, { mode: 0o700 });
    await Deno.writeTextFile(`${disk}/album/shared.jpg`, 'a', { mode: 0o644 });
    await Deno.writeTextFile(`${disk}/album/private.jpg`, 'b', { mode: 0o600 });
    // The process umask must not decide the modes.
    await Deno.chmod(`${disk}/album`, 0o755);
    await Deno.chmod(`${disk}/closed`, 0o700);
    await Deno.chmod(`${disk}/album/shared.jpg`, 0o644);
    await Deno.chmod(`${disk}/album/private.jpg`, 0o600);
    await mkdir(vfs, ADMIN_ACCESS, '/', 'fs', 0o755);
    await vfs.mount(ADMIN_ACCESS, '/fs', new LocalNodeVFS(new FilesystemStore({ rootPath: disk }), ctx.routerManager, {}));

    await t.step('counts', async () => {
      assertEquals(await vfs.childCount(OTHER, '/fs/album'), 1);
      assertEquals(await vfs.childCount(OTHER, '/fs/album', { all: true }), 2);
      assertEquals(await vfs.childCount(ADMIN_ACCESS, '/fs/album'), 2);

      const listing = await vfs.children(OTHER, '/fs');
      assertEquals(listing.map((child) => [child.name, child.childCount]), [['album', 1]]);
    });

    await t.step('child edges', async () => {
      const [album] = await vfs.children(OTHER, '/fs', { childLinks: true });
      assertEquals(album.children?.map((link) => link.name), ['shared.jpg']);
    });
  } finally {
    await ctx.dispose();
    await Deno.remove(disk, { recursive: true });
  }
});
