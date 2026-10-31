/**
 * Batched unlinks.
 *
 * `unlinkMany` removes the edge each path names — a softlink there itself, never what it points
 * at — a chunk at a time, one lock set and one transaction per chunk. A node losing its last link
 * is deleted, once, however many of its names one call takes. A node that would lose it while it
 * has children, a parent the caller may not write and a path with nothing at it fail alone. With
 * `recursive`, a node losing its last link is emptied first, a chunk's subtrees in one walk, and
 * again when children arrive before its edge goes.
 */

import { assertEquals, assertInstanceOf } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { NodeAccessDeniedError, NodeBusyError, type NodeEvent, NodeInvalidOperationError, NodeNotFoundError } from '../mod.ts';
import { mkdir, mkdirp, mkfile, readFile, refillAfterReap } from './helpers.ts';

const OWNER: Access = { uid: 5000, gid: 4000, gids: [4000] };

/** Wider than WRITE_BATCH (128), so a call spans several transactions. */
const WIDE = 300;

const value = <T>(result: PromiseSettledResult<T>): T => {
  if (result.status === 'rejected') throw new Error(`expected a value, got ${result.reason}`);
  return result.value;
};

const reason = <T>(result: PromiseSettledResult<T>): unknown => {
  if (result.status === 'fulfilled') throw new Error('expected a refusal, got a value');
  return result.reason;
};

Deno.test('VFS unlinkMany', async (t) => {
  const ctx = await createTestVfs();
  const { vfs, store } = ctx;

  let transactions = 0;
  const begin = store.beginTransaction.bind(store);
  store.beginTransaction = () => {
    transactions++;
    return begin();
  };

  const events: NodeEvent[] = [];
  const subscription = await vfs.subscribe(() => ADMIN_ACCESS, (event) => {
    if (event.type === 'deleted' || event.type === 'child-detached') events.push(event);
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  try {
    await mkdirp(vfs, ADMIN_ACCESS, '/files');
    await mkfile(vfs, ADMIN_ACCESS, '/files', 'a.jpg', 'a');

    await t.step('links go a chunk at a time, deleted, and what they point at stays', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/group');
      await vfs.createTree(
        ADMIN_ACCESS,
        '/group',
        Array.from({ length: WIDE }, (_, i) => ({ type: 'softlink', name: `l${i}`, props: { mode: 0o777, softlink: '/files/a.jpg' } })),
      );
      transactions = 0;
      events.length = 0;

      const results = await vfs.unlinkMany(ADMIN_ACCESS, Array.from({ length: WIDE }, (_, i) => `/group/l${i}`));

      assertEquals(transactions, Math.ceil(WIDE / 128));
      assertEquals(results.map(value), Array(WIDE).fill(true));
      assertEquals((await vfs.children(ADMIN_ACCESS, '/group')).length, 0);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/files/a.jpg'), 'a');
      await settle();
      assertEquals(events.filter((event) => event.type === 'deleted').length, WIDE);
      // The group's losing members is announced once per transaction, not once per link.
      assertEquals(events.filter((event) => event.type === 'child-detached').length, Math.ceil(WIDE / 128));
      assertEquals((await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/group', op: 'delete', limit: 1000 })).length, WIDE);
    });

    await t.step('a node keeps its other names, and goes once the call takes the last', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/hard');
      await vfs.create(ADMIN_ACCESS, 'file', '/hard', 'one.jpg', { props: { mode: 0o644 } });
      await vfs.link(ADMIN_ACCESS, '/hard/one.jpg', '/hard', 'two.jpg');
      await vfs.link(ADMIN_ACCESS, '/hard/one.jpg', '/hard', 'three.jpg');
      events.length = 0;

      const first = await vfs.unlinkMany(ADMIN_ACCESS, ['/hard/one.jpg']);
      assertEquals(value(first[0]), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/hard/two.jpg'), true);

      const rest = await vfs.unlinkMany(ADMIN_ACCESS, ['/hard/two.jpg', '/hard/three.jpg']);
      assertEquals(rest.map(value), [false, true]);
      await settle();
      assertEquals(events.filter((event) => event.type === 'deleted').map((event) => event.path), ['/hard/three.jpg']);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/hard')).length, 0);
    });

    await t.step('one that cannot go fails alone, and the others in its chunk go', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/mixed/full/child');
      await vfs.create(ADMIN_ACCESS, 'file', '/mixed', 'loose.jpg', { props: { mode: 0o644 } });
      await mkdir(vfs, ADMIN_ACCESS, '/', 'theirs', 0o755);
      await vfs.create(ADMIN_ACCESS, 'file', '/theirs', 'kept.jpg', { props: { mode: 0o666 } });
      await mkdir(vfs, ADMIN_ACCESS, '/', 'open', 0o777);
      await mkfile(vfs, OWNER, '/open', 'mine.jpg', 'm');

      const results = await vfs.unlinkMany(OWNER, ['/open/mine.jpg', '/theirs/kept.jpg', '/open/gone.jpg', '/open/mine.jpg']);

      assertEquals(value(results[0]), true);
      assertInstanceOf(reason(results[1]), NodeAccessDeniedError);
      assertInstanceOf(reason(results[2]), NodeNotFoundError);
      // The same edge named twice is gone after the first.
      assertInstanceOf(reason(results[3]), NodeNotFoundError);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/theirs/kept.jpg'), true);

      const admin = await vfs.unlinkMany(ADMIN_ACCESS, ['/mixed/full', '/mixed/loose.jpg', '/']);
      assertInstanceOf(reason(admin[0]), NodeInvalidOperationError);
      assertEquals(value(admin[1]), true);
      assertInstanceOf(reason(admin[2]), NodeInvalidOperationError);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/mixed/full/child'), true);
    });

    await t.step('recursive empties the subtrees of a chunk together', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/entries');
      await vfs.createTree(
        ADMIN_ACCESS,
        '/entries',
        Array.from(
          { length: WIDE },
          (_, i) => ({ type: 'directory', name: `e${i}`, props: { mode: 0o755 }, children: [{ type: 'file', name: 'f.jpg', props: { mode: 0o644 } }] }),
        ),
      );
      transactions = 0;

      const results = await vfs.unlinkMany(ADMIN_ACCESS, Array.from({ length: WIDE }, (_, i) => `/entries/e${i}`), { recursive: true });

      assertEquals(results.map(value), Array(WIDE).fill(true));
      assertEquals((await vfs.children(ADMIN_ACCESS, '/entries')).length, 0);
      // Per chunk, one transaction for the files of all its entries and one for the entries.
      assertEquals(transactions, 2 * Math.ceil(WIDE / 128));
    });

    await t.step('recursive: a subtree that cannot be emptied fails alone', async () => {
      await mkdir(vfs, ADMIN_ACCESS, '/', 'shared', 0o777);
      await mkdir(vfs, OWNER, '/shared', 'mine', 0o755);
      await mkfile(vfs, OWNER, '/shared/mine', 'a.jpg', 'a');
      await mkdir(vfs, OWNER, '/shared', 'locked', 0o777);
      await mkdir(vfs, ADMIN_ACCESS, '/shared/locked', 'admins', 0o755);
      await mkfile(vfs, ADMIN_ACCESS, '/shared/locked/admins', 'b.jpg', 'b');

      const results = await vfs.unlinkMany(OWNER, ['/shared/mine', '/shared/locked'], { recursive: true });

      assertEquals(value(results[0]), true);
      assertInstanceOf(reason(results[1]), NodeAccessDeniedError);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/shared/mine'), false);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/shared/locked/admins/b.jpg'), 'b');
    });

    await t.step('recursive: children that arrive after a subtree is emptied go too', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/albums/x');
      await mkfile(vfs, ADMIN_ACCESS, '/albums/x', 'a.jpg', 'a');
      await mkdirp(vfs, ADMIN_ACCESS, '/albums/y');
      const restore = refillAfterReap(vfs, ADMIN_ACCESS, '/albums/x', 2);

      let results: PromiseSettledResult<boolean>[];
      try {
        results = await vfs.unlinkMany(ADMIN_ACCESS, ['/albums/x', '/albums/y'], { recursive: true });
      } finally {
        restore();
      }

      assertEquals(results.map(value), [true, true]);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/albums')).length, 0);
    });

    await t.step('a mounted node is unlinked by its own VFS, and a mount point stays', async () => {
      const mounted = await createTestVfs();
      try {
        await mkdir(vfs, ADMIN_ACCESS, '/', 'mnt');
        await vfs.mount(ADMIN_ACCESS, '/mnt', mounted.vfs);
        await vfs.create(ADMIN_ACCESS, 'softlink', '/mnt', 'far', { props: { mode: 0o777, softlink: '/files/a.jpg' } });

        const results = await vfs.unlinkMany(ADMIN_ACCESS, ['/mnt/far', '/mnt']);

        assertEquals(value(results[0]), true);
        assertEquals(await mounted.vfs.exists(ADMIN_ACCESS, '/far', { follow: false }), false);
        assertInstanceOf(reason(results[1]), NodeBusyError);
      } finally {
        await mounted.dispose();
      }
    });
  } finally {
    await subscription.unsubscribe();
    await ctx.dispose();
  }
});
