/**
 * The recursive access walk on its own: a subtree wider than one write batch is written whole, a
 * directory the caller cannot list is reported with its subtree left alone, an interrupted walk
 * writes nothing more — the root included — many roots are one walk, and a root in a wide
 * directory reads nothing of its siblings.
 */

import { assertEquals } from '@std/assert';
import type { Access } from '../../../../../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../../../../../lib/access/mod.ts';
import { createTestVfs } from '../../../../../../testing/test-vfs.ts';
import { applySubtree, applySubtrees } from '../walk.ts';

const OWNER: Access = { uid: 5000, gid: 4000, gids: [4000] };

/** Wider than the VFS's write batch (128), so the walk spans several transactions. */
const WIDE = 300;

Deno.test('recursive access walk', async (t) => {
  const ctx = await createTestVfs();
  const { vfs } = ctx;

  const mode = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).props.mode & 0o777;

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'album', { props: { mode: 0o755 } });
    for (let i = 0; i < WIDE; i++) {
      await vfs.createTree(ADMIN_ACCESS, '/album', [{
        type: 'directory',
        name: `p${i}`,
        props: { mode: 0o755 },
        children: [{ type: 'directory', name: 'faces', props: { mode: 0o755 } }],
      }]);
    }

    await t.step('a subtree wider than one batch is written whole', async () => {
      const result = await applySubtree(vfs, ADMIN_ACCESS, '/album', { props: { mode: 0o750 } }, { recursive: true });

      assertEquals(result.updated, 2 * WIDE + 1);
      assertEquals(result.failed, 0);
      assertEquals(await mode('/album'), 0o750);
      assertEquals(await mode(`/album/p${WIDE - 1}/faces`), 0o750);
    });

    await t.step('an interrupted walk writes nothing more, the root included', async () => {
      const interrupt = new AbortController();
      const subscription = await vfs.subscribe(() => ADMIN_ACCESS, () => interrupt.abort(), { eventTypes: ['updated'] });

      try {
        const result = await applySubtree(vfs, ADMIN_ACCESS, '/album', { props: { mode: 0o700 } }, { recursive: true, signal: interrupt.signal });

        // The first batch landed; the rest were never reached, which is not a failure.
        assertEquals(result.updated, 128);
        assertEquals(result.failed, 0);
        assertEquals(await mode('/album'), 0o750);
      } finally {
        await subscription.unsubscribe();
      }
    });

    await t.step('a directory the caller cannot read is reported against its parent, its subtree left alone', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'mine', { props: { mode: 0o777, uid: OWNER.uid, gid: OWNER.gid } });
      await vfs.create(ADMIN_ACCESS, 'directory', '/mine', 'open', { props: { mode: 0o777 } });
      await vfs.create(ADMIN_ACCESS, 'directory', '/mine', 'closed', { props: { mode: 0o700 } });
      await vfs.create(ADMIN_ACCESS, 'directory', '/mine/closed', 'inside', { props: { mode: 0o777 } });

      const result = await applySubtree(vfs, OWNER, '/mine', { props: { mode: 0o775 } }, { recursive: true });

      // /mine and open written; closed is not listed to the caller, so it is counted against /mine
      // without its name; inside never reached.
      assertEquals(result.updated, 2);
      assertEquals(result.failed, 1);
      assertEquals(result.failures.map((failure) => failure.path), ['/mine']);
      assertEquals(await mode('/mine/closed/inside'), 0o777);
    });

    await t.step('many roots are one walk: each counted to its own root, and one that fails fails alone', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'roots', { props: { mode: 0o777 } });
      for (const name of ['a.jpg', 'b.jpg']) {
        await vfs.createTree(OWNER, '/roots', [{ type: 'file', name, props: { mode: 0o700 }, children: [{ type: 'directory', name: 'thumbnails', props: { mode: 0o700 } }] }]);
      }
      await vfs.create(ADMIN_ACCESS, 'file', '/roots', 'theirs.jpg', { props: { mode: 0o644 } });
      await vfs.create(OWNER, 'softlink', '/roots', 'to-a', { props: { mode: 0o777, softlink: '/roots/a.jpg' } });
      let listings = 0;
      const childrenMany = vfs.childrenMany.bind(vfs);
      vfs.childrenMany = (...args) => {
        listings++;
        return childrenMany(...args);
      };

      try {
        const results = await applySubtrees(vfs, OWNER, ['/roots/a.jpg', '/roots/b.jpg', '/roots/theirs.jpg', '/roots/gone.jpg', '/roots/to-a'], {
          props: { mode: 0o750 },
        }, { recursive: true });

        assertEquals(results.slice(0, 2).map((result) => result.status === 'fulfilled' && result.value.updated), [2, 2]);
        assertEquals(results[2].status, 'rejected');
        assertEquals(results[3].status, 'rejected');
        // A softlink root is followed, as `vfs.get` follows it, to a node the walk already writes.
        assertEquals(results[4].status === 'fulfilled' && results[4].value.updated, 1);
        assertEquals([await mode('/roots/a.jpg/thumbnails'), await mode('/roots/b.jpg'), await mode('/roots/theirs.jpg')], [0o750, 0o750, 0o644]);
        // The roots' directory once, then the children of every root in one listing; the empty
        // thumbnails directories have nothing to list.
        assertEquals(listings, 2);
      } finally {
        vfs.childrenMany = childrenMany;
      }
    });

    await t.step('roots in a wide directory are resolved by path, and their directory is listed only when they are a good share of it', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'wide', { props: { mode: 0o755 } });
      for (let i = 0; i < 100; i++) await vfs.create(ADMIN_ACCESS, 'file', '/wide', `f${i}.jpg`, { props: { mode: 0o644 } });
      let rows = 0;
      const childrenMany = vfs.childrenMany.bind(vfs);
      vfs.childrenMany = (async (...args: Parameters<typeof childrenMany>) => {
        const listings = await childrenMany(...args);
        for (const listing of listings) if (listing.status === 'fulfilled') rows += listing.value.length;
        return listings;
      }) as typeof vfs.childrenMany;
      const files = (count: number) => Array.from({ length: count }, (_, i) => `/wide/f${i}.jpg`);

      try {
        const one = await applySubtree(vfs, ADMIN_ACCESS, '/wide/f7.jpg', { props: { mode: 0o640 } }, { recursive: true });
        assertEquals([one.updated, rows], [1, 0]);

        // Six of a hundred: a path walk each beats reading all hundred.
        const few = await applySubtrees(vfs, ADMIN_ACCESS, files(6), { props: { mode: 0o640 } }, { recursive: true });
        assertEquals([few.filter((result) => result.status === 'fulfilled').length, rows], [6, 0]);

        const many = await applySubtrees(vfs, ADMIN_ACCESS, files(8), { props: { mode: 0o600 } }, { recursive: true });
        assertEquals([many.filter((result) => result.status === 'fulfilled').length, rows], [8, 100]);
        assertEquals([await mode('/wide/f7.jpg'), await mode('/wide/f8.jpg')], [0o600, 0o644]);
      } finally {
        vfs.childrenMany = childrenMany;
      }
    });
  } finally {
    await ctx.dispose();
  }
});
