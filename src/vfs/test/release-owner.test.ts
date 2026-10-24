/**
 * `releaseOwner`: a deleted user's uid or group's gid leaves every node, in this VFS's store and in
 * every store mounted into it.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS, LINK_UID_BASE } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';

Deno.test('releaseOwner hands ownership over and drops ACL entries, through mounts', async () => {
  const outer = await createTestVfs();
  const inner = await createTestVfs();
  try {
    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'mnt', { props: { mode: 0o755 } });
    await outer.vfs.mount(ADMIN_ACCESS, '/mnt', inner.vfs);

    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'owned', { props: { mode: 0o750, uid: 2001, gid: 2001 } });
    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'shared', {
      props: { mode: 0o700, acl: [{ uid: 2001, mode: 0o5 }, { uid: 2002, mode: 0o4 }, { gid: 2001, mode: 0o4 }] },
    });
    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/mnt', 'only', { props: { mode: 0o700, acl: [{ uid: 2001, mode: 0o4 }] } });

    const released = await outer.vfs.releaseOwner(ADMIN_ACCESS, { kind: 'uid', id: 2001, to: 2003 });
    assertEquals(released, { owned: 1, acl: 2 });

    const owned = await outer.vfs.get(ADMIN_ACCESS, '/owned');
    // Only the uid: the gid is the group's, released on its own.
    assertEquals([owned.props.uid, owned.props.gid], [2003, 2001]);
    assertEquals((await outer.vfs.get(ADMIN_ACCESS, '/shared')).props.acl, [{ uid: 2002, mode: 0o4 }, { gid: 2001, mode: 0o4 }]);
    // An ACL left empty is no ACL.
    assertEquals((await outer.vfs.get(ADMIN_ACCESS, '/mnt/only')).props.acl, undefined);

    assertEquals(await outer.vfs.releaseOwner(ADMIN_ACCESS, { kind: 'gid', id: 2001, to: 0 }), { owned: 1, acl: 1 });
    assertEquals((await outer.vfs.get(ADMIN_ACCESS, '/owned')).props.gid, 0);
    assertEquals((await outer.vfs.get(ADMIN_ACCESS, '/shared')).props.acl, [{ uid: 2002, mode: 0o4 }]);

    await assertRejects(() => outer.vfs.releaseOwner({ uid: 2002, gid: 2002, gids: [2002] }, { kind: 'uid', id: 2002, to: 2002 }));
  } finally {
    await inner.dispose();
    await outer.dispose();
  }
});

const LINK = LINK_UID_BASE;

Deno.test("releaseOwner of a share link's uid drops its entries everywhere and owns nothing", async () => {
  const outer = await createTestVfs();
  const inner = await createTestVfs();
  try {
    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'mnt', { props: { mode: 0o755 } });
    await outer.vfs.mount(ADMIN_ACCESS, '/mnt', inner.vfs);

    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'album', { props: { mode: 0o700, acl: [{ uid: LINK, mode: 0o5 }, { gid: 2001, mode: 0o5 }] } });
    // Moved out of the album, it took the entry along.
    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/mnt', 'moved', { props: { mode: 0o700, acl: [{ uid: LINK, mode: 0o5 }] } });
    await outer.vfs.create(ADMIN_ACCESS, 'directory', '/', 'other', { props: { mode: 0o700, acl: [{ uid: LINK + 1, mode: 0o5 }] } });

    assertEquals(await outer.vfs.releaseOwner(ADMIN_ACCESS, { kind: 'uid', id: LINK, to: 0 }), { owned: 0, acl: 2 });

    assertEquals((await outer.vfs.get(ADMIN_ACCESS, '/album')).props.acl, [{ gid: 2001, mode: 0o5 }]);
    assertEquals((await outer.vfs.get(ADMIN_ACCESS, '/mnt/moved')).props.acl, undefined);
    assertEquals((await outer.vfs.get(ADMIN_ACCESS, '/other')).props.acl, [{ uid: LINK + 1, mode: 0o5 }]);
  } finally {
    await inner.dispose();
    await outer.dispose();
  }
});
