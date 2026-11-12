/**
 * A module's archive roots: made when missing, open to everyone signed in, passed through by
 * others, and left as they are once they exist.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, ADMIN_UID, USERS_GID } from '../../access/mod.ts';
import { createTestVfs } from '../../../testing/test-vfs.ts';
import { mkdirp } from '../../../vfs/test/helpers.ts';
import { ensureArchiveRoots } from '../roots.ts';

Deno.test('archive roots', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;
  try {
    await mkdirp(vfs, ADMIN_ACCESS, '/archive');

    await t.step('a missing root is the users group’s to fill and others only pass through it', async () => {
      assertEquals(await ensureArchiveRoots(vfs, ['/archive/things']), ['/archive/things']);
      const { props } = await vfs.get(ADMIN_ACCESS, '/archive/things');
      assertEquals([props.mode & 0o777, props.uid, props.gid], [0o771, ADMIN_UID, USERS_GID]);
    });

    await t.step('one that exists keeps its mode', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/archive/chosen');
      await vfs.update(ADMIN_ACCESS, '/archive/chosen', { props: { mode: 0o755 } });
      assertEquals(await ensureArchiveRoots(vfs, ['/archive/chosen', '/archive/things']), []);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/archive/chosen')).props.mode & 0o777, 0o755);
    });
  } finally {
    await ctx.dispose();
  }
});
