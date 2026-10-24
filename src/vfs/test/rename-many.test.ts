/**
 * Batched moves.
 *
 * `renameMany` moves many nodes a chunk at a time — one lock set and one transaction per chunk —
 * and re-points, in that chunk, every softlink whose target is a moved path or lies under one,
 * with a relation link's `peerLink`. A move that cannot be made fails alone, before anything is
 * written; a link the caller may not write fails its chunk. A call made again finds its moves
 * made. Between two stores the tree is copied, and the links follow once it is.
 */

import { assert, assertEquals, assertInstanceOf } from '@std/assert';
import type { Access } from '../../lib/access/mod.ts';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import type { RelationAttrs } from '../../lib/api/relation.ts';
import { RouterManager } from '../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../registries/file/mod.ts';
import { InMemoryStore } from '../../stores/memory/index.ts';
import { createMemoryTestVfs } from '../../testing/memory-vfs.ts';
import { createTestVfs } from '../../testing/test-vfs.ts';
import { LocalNodeVFS, NodeAccessDeniedError, NodeAlreadyExistsError, type NodeEvent, NodeInvalidOperationError, NodeNotFoundError, type NodeVFS } from '../mod.ts';
import { mkdir, mkdirp, mkfile, readFile } from './helpers.ts';

const OWNER: Access = { uid: 5000, gid: 4000, gids: [4000] };

/** Wider than WRITE_BATCH (128), so a call spans several chunks. */
const WIDE = 300;

const value = <T>(result: PromiseSettledResult<T>): T => {
  if (result.status === 'rejected') throw new Error(`expected a value, got ${result.reason}`);
  return result.value;
};

const reason = <T>(result: PromiseSettledResult<T>): unknown => {
  if (result.status === 'fulfilled') throw new Error('expected a refusal, got a value');
  return result.reason;
};

const link = (vfs: NodeVFS, access: Access, parent: string, name: string, target: string, attrs?: RelationAttrs) =>
  vfs.create(access, 'softlink', parent, name, { props: { mode: 0o777, softlink: target }, ...(attrs ? { attrs } : {}) });

const targetOf = async (vfs: NodeVFS, path: string) => (await vfs.get(ADMIN_ACCESS, path, { readlink: true })).props.softlink;

Deno.test('VFS renameMany', async (t) => {
  const ctx = await createTestVfs();
  const { vfs, store } = ctx;

  let transactions = 0;
  const begin = store.beginTransaction.bind(store);
  store.beginTransaction = () => {
    transactions++;
    return begin();
  };

  try {
    await t.step("the links at or under a moved directory follow it, and a relation link's peerLink with them", async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/lib/trip/sub');
      await mkdirp(vfs, ADMIN_ACCESS, '/lib/tripx');
      await mkdirp(vfs, ADMIN_ACCESS, '/elsewhere');
      await mkdirp(vfs, ADMIN_ACCESS, '/archive');
      await mkdirp(vfs, ADMIN_ACCESS, '/people/anna/relations');
      await mkfile(vfs, ADMIN_ACCESS, '/lib/trip', 'a.jpg', 'a', 0o755);
      await mkfile(vfs, ADMIN_ACCESS, '/lib/trip/sub', 'c.jpg', 'c');
      await mkdir(vfs, ADMIN_ACCESS, '/lib/trip/a.jpg', 'relations');
      await link(vfs, ADMIN_ACCESS, '/elsewhere', 'to-trip', '/lib/trip');
      await link(vfs, ADMIN_ACCESS, '/elsewhere', 'to-a', '/lib/trip/a.jpg');
      await link(vfs, ADMIN_ACCESS, '/elsewhere', 'to-c', '/lib/trip/sub/c.jpg');
      await link(vfs, ADMIN_ACCESS, '/elsewhere', 'to-tripx', '/lib/tripx');
      await link(vfs, ADMIN_ACCESS, '/people/anna/relations', 'in-a.jpg', '/lib/trip/a.jpg', {
        relation: { label: 'in', peerLink: '/lib/trip/a.jpg/relations/of-anna' },
      });
      await link(vfs, ADMIN_ACCESS, '/lib/trip/a.jpg/relations', 'of-anna', '/people/anna', {
        relation: { label: 'of', peerLink: '/people/anna/relations/in-a.jpg' },
      });

      const [moved] = await vfs.renameMany(ADMIN_ACCESS, [{ from: '/lib/trip', to: '/archive/trip' }]);

      assertEquals(value(moved).relinked, 4);
      assertEquals(value(moved).node.id, (await vfs.get(ADMIN_ACCESS, '/archive/trip')).id);
      assertEquals(await targetOf(vfs, '/elsewhere/to-trip'), '/archive/trip');
      assertEquals(await targetOf(vfs, '/elsewhere/to-a'), '/archive/trip/a.jpg');
      assertEquals(await targetOf(vfs, '/elsewhere/to-c'), '/archive/trip/sub/c.jpg');
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/elsewhere/to-c'), 'c');
      // A sibling that shares the moved path's prefix is not under it.
      assertEquals(await targetOf(vfs, '/elsewhere/to-tripx'), '/lib/tripx');

      const anna = await vfs.get<RelationAttrs>(ADMIN_ACCESS, '/people/anna/relations/in-a.jpg', { readlink: true });
      assertEquals(anna.props.softlink, '/archive/trip/a.jpg');
      assertEquals(anna.attrs.relation?.peerLink, '/archive/trip/a.jpg/relations/of-anna');
      // The half inside the moved tree points out of it, so it stays as it was.
      const half = await vfs.get<RelationAttrs>(ADMIN_ACCESS, '/archive/trip/a.jpg/relations/of-anna', { readlink: true });
      assertEquals(half.props.softlink, '/people/anna');
      assertEquals(half.attrs.relation?.peerLink, '/people/anna/relations/in-a.jpg');
    });

    await t.step('300 moves are 3 chunks, one transaction each, and every link follows its move', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/bulk/src');
      await mkdirp(vfs, ADMIN_ACCESS, '/bulk/dst');
      await mkdirp(vfs, ADMIN_ACCESS, '/bulk/links');
      for (let i = 0; i < WIDE; i++) {
        await vfs.create(ADMIN_ACCESS, 'file', '/bulk/src', `f${i}.jpg`, { props: { mode: 0o644 } });
        await link(vfs, ADMIN_ACCESS, '/bulk/links', `l${i}`, `/bulk/src/f${i}.jpg`);
      }
      transactions = 0;

      const moves = Array.from({ length: WIDE }, (_, i) => ({ from: `/bulk/src/f${i}.jpg`, to: `/bulk/dst/f${i}.jpg` }));
      const results = await vfs.renameMany(ADMIN_ACCESS, moves);

      assertEquals(transactions, Math.ceil(WIDE / 128));
      assertEquals(results.map((result) => value(result).relinked), Array(WIDE).fill(1));
      assertEquals((await vfs.children(ADMIN_ACCESS, '/bulk/src')).length, 0);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/bulk/dst')).length, WIDE);
      assertEquals(await targetOf(vfs, '/bulk/links/l299'), '/bulk/dst/f299.jpg');
      // Each move is recorded as `rename` records one.
      assertEquals((await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/bulk/dst', op: 'move', limit: 1000 })).length, WIDE);
    });

    await t.step('a call made again finds its moves made', async () => {
      const moves = [{ from: '/bulk/src/f0.jpg', to: '/bulk/dst/f0.jpg' }, { from: '/bulk/src/f1.jpg', to: '/bulk/dst/f1.jpg' }];
      transactions = 0;

      const results = await vfs.renameMany(ADMIN_ACCESS, moves);

      assertEquals(results.map((result) => value(result).already), [true, true]);
      assertEquals(value(results[0]).node.id, (await vfs.get(ADMIN_ACCESS, '/bulk/dst/f0.jpg')).id);
      assertEquals(transactions, 0);
    });

    await t.step('a link the caller may not write fails its chunk, with nothing in it written', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/u');
      await vfs.update(ADMIN_ACCESS, '/u', { props: { uid: OWNER.uid, gid: OWNER.gid } });
      await mkdir(vfs, OWNER, '/u', 'src');
      await mkdir(vfs, OWNER, '/u', 'dst');
      await mkfile(vfs, OWNER, '/u/src', 'x.jpg', 'x');
      await mkfile(vfs, OWNER, '/u/src', 'y.jpg', 'y');
      await mkdirp(vfs, ADMIN_ACCESS, '/pub');
      await vfs.create(ADMIN_ACCESS, 'softlink', '/pub', 'hold', { props: { mode: 0o755, softlink: '/u/src/x.jpg' } });

      const results = await vfs.renameMany(OWNER, [{ from: '/u/src/x.jpg', to: '/u/dst/x.jpg' }, { from: '/u/src/y.jpg', to: '/u/dst/y.jpg' }]);

      assertInstanceOf(reason(results[0]), NodeAccessDeniedError);
      assertInstanceOf(reason(results[1]), NodeAccessDeniedError);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/u/src')).map((entry) => entry.name).sort(), ['x.jpg', 'y.jpg']);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/u/dst')).length, 0);
      assertEquals(await targetOf(vfs, '/pub/hold'), '/u/src/x.jpg');

      // Without relinking there is no link to write, and the moves are the caller's to make.
      const unlinked = await vfs.renameMany(OWNER, [{ from: '/u/src/x.jpg', to: '/u/dst/x.jpg' }], { relink: false });
      assertEquals(value(unlinked[0]).relinked, 0);
      assertEquals(await targetOf(vfs, '/pub/hold'), '/u/src/x.jpg');
    });

    await t.step('a move that cannot be made fails alone, and the others in its chunk are made', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/odd/dst');
      await mkdirp(vfs, ADMIN_ACCESS, '/odd/dir/inner');
      for (const name of ['ok.jpg', 'taken.jpg', 'twice.jpg', 'again.jpg']) await vfs.create(ADMIN_ACCESS, 'file', '/odd', name, { props: { mode: 0o644 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/odd/dst', 'taken.jpg', { props: { mode: 0o644 } });

      const results = await vfs.renameMany(ADMIN_ACCESS, [
        { from: '/odd/ok.jpg', to: '/odd/dst/ok.jpg' },
        { from: '/odd/taken.jpg', to: '/odd/dst/taken.jpg' },
        { from: '/odd/gone.jpg', to: '/odd/dst/gone.jpg' },
        { from: '/odd/dir', to: '/odd/dir/inner/dir' },
        { from: '/odd/twice.jpg', to: '/odd/dst/same.jpg' },
        { from: '/odd/again.jpg', to: '/odd/dst/same.jpg' },
        { from: '/', to: '/odd/root' },
      ], { failIfExists: true });

      assertEquals(value(results[0]).node.id, (await vfs.get(ADMIN_ACCESS, '/odd/dst/ok.jpg')).id);
      assertInstanceOf(reason(results[1]), NodeAlreadyExistsError);
      assertInstanceOf(reason(results[2]), NodeNotFoundError);
      assertInstanceOf(reason(results[3]), NodeInvalidOperationError);
      assert(value(results[4]));
      assertInstanceOf(reason(results[5]), NodeAlreadyExistsError);
      assertInstanceOf(reason(results[6]), NodeInvalidOperationError);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/odd/again.jpg'), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/odd/dir/inner'), true);
    });

    await t.step('a taken name is replaced, as rename replaces it, unless the node there has children', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/rep/dst/full/child');
      await vfs.create(ADMIN_ACCESS, 'file', '/rep', 'new.jpg', { props: { mode: 0o644 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/rep/dst', 'new.jpg', { props: { mode: 0o644 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/rep', 'full', { props: { mode: 0o644 } });
      const id = (await vfs.get(ADMIN_ACCESS, '/rep/new.jpg')).id;

      const results = await vfs.renameMany(ADMIN_ACCESS, [{ from: '/rep/new.jpg', to: '/rep/dst/new.jpg' }, { from: '/rep/full', to: '/rep/dst/full' }]);

      assertEquals(value(results[0]).node.id, id);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/rep/dst/new.jpg')).id, id);
      assertInstanceOf(reason(results[1]), NodeInvalidOperationError);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/rep/dst/full/child'), true);
    });

    await t.step('moves nested in one chunk: a link follows the longest moved source it lies under', async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/nest/a/b');
      await mkdirp(vfs, ADMIN_ACCESS, '/nest/links');
      await vfs.create(ADMIN_ACCESS, 'file', '/nest/a/b', 'c.jpg', { props: { mode: 0o644 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/nest/a', 'q.jpg', { props: { mode: 0o644 } });
      await link(vfs, ADMIN_ACCESS, '/nest/links', 'c', '/nest/a/b/c.jpg');
      await link(vfs, ADMIN_ACCESS, '/nest/links', 'q', '/nest/a/q.jpg');

      const results = await vfs.renameMany(ADMIN_ACCESS, [{ from: '/nest/a', to: '/nest/x' }, { from: '/nest/a/b', to: '/nest/y' }]);

      assertEquals(results.map((result) => value(result).relinked), [1, 1]);
      assertEquals(await targetOf(vfs, '/nest/links/c'), '/nest/y/c.jpg');
      assertEquals(await targetOf(vfs, '/nest/links/q'), '/nest/x/q.jpg');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/nest/y/c.jpg'), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/nest/x/q.jpg'), true);
    });

    await t.step("events arrive once the chunk is written: a move's three, and an update per link", async () => {
      await mkdirp(vfs, ADMIN_ACCESS, '/ev/src');
      await mkdirp(vfs, ADMIN_ACCESS, '/ev/dst');
      await vfs.create(ADMIN_ACCESS, 'file', '/ev/src', 'e.jpg', { props: { mode: 0o644 } });
      await link(vfs, ADMIN_ACCESS, '/ev', 'to-e', '/ev/src/e.jpg');

      const seen: { type: string; path: string; fromPath?: string; written: boolean }[] = [];
      const subscription = await vfs.subscribe(() => ADMIN_ACCESS, async (event: NodeEvent) => {
        if (!event.path.startsWith('/ev')) return;
        // Delivered after the writes: the node is where it went, and the link already follows it.
        const written = await vfs.exists(ADMIN_ACCESS, '/ev/dst/e.jpg') && await targetOf(vfs, '/ev/to-e') === '/ev/dst/e.jpg';
        seen.push({ type: event.type, path: event.path, fromPath: event.fromPath, written });
      });
      try {
        await vfs.renameMany(ADMIN_ACCESS, [{ from: '/ev/src/e.jpg', to: '/ev/dst/e.jpg' }]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        await subscription.unsubscribe();
      }

      assertEquals(seen.map(({ type, path }) => `${type} ${path}`).sort(), [
        'child-attached /ev/dst',
        'child-detached /ev/src',
        'moved /ev/dst/e.jpg',
        'updated /ev/to-e',
      ]);
      assert(seen.every((event) => event.written));
      // A moved event says where the node came from.
      assertEquals(seen.find((event) => event.type === 'moved')?.fromPath, '/ev/src/e.jpg');
    });
  } finally {
    await ctx.dispose();
  }
});

Deno.test('VFS renameMany across mounts', async (t) => {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  // As production: a router-only root with the data VFS mounted at `/`, and another store below.
  const { vfs } = await createMemoryTestVfs(routerManager, { rootMount: true });
  const mounted = new LocalNodeVFS(new InMemoryStore({}), routerManager, { file: new MemoryFileRegistry() });
  await mounted.initialize();

  try {
    await mkdirp(vfs, ADMIN_ACCESS, '/data/links');
    await mkdirp(vfs, ADMIN_ACCESS, '/mnt');
    await vfs.mount(ADMIN_ACCESS, '/mnt', mounted);
    await mkdirp(vfs, ADMIN_ACCESS, '/mnt/in');
    await vfs.create(ADMIN_ACCESS, 'directory', '/mnt', 'out', { props: { mode: 0o755 } });

    await t.step('a move within the mount is made by its own VFS, and a link outside it follows', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/mnt/in', 'm.jpg', { props: { mode: 0o755 } });
      await link(vfs, ADMIN_ACCESS, '/data/links', 'to-m', '/mnt/in/m.jpg');
      await link(vfs, ADMIN_ACCESS, '/mnt', 'to-m', '/mnt/in/m.jpg');

      const [result] = await vfs.renameMany(ADMIN_ACCESS, [{ from: '/mnt/in/m.jpg', to: '/mnt/out/m.jpg' }]);

      // One link in the mount's own store, in its transaction; one in the data store, after it.
      assertEquals(value(result).relinked, 2);
      assertEquals(await targetOf(vfs, '/mnt/to-m'), '/mnt/out/m.jpg');
      assertEquals(await targetOf(vfs, '/data/links/to-m'), '/mnt/out/m.jpg');
    });

    await t.step('a move between stores copies the node, and the links to it follow', async () => {
      await mkfile(vfs, ADMIN_ACCESS, '/mnt/out', 'n.jpg', 'n');
      await link(vfs, ADMIN_ACCESS, '/data/links', 'to-n', '/mnt/out/n.jpg');

      const [result] = await vfs.renameMany(ADMIN_ACCESS, [{ from: '/mnt/out/n.jpg', to: '/data/n.jpg' }]);

      assertEquals(value(result).relinked, 1);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/mnt/out/n.jpg'), false);
      assertEquals(await readFile(vfs, ADMIN_ACCESS, '/data/n.jpg'), 'n');
      assertEquals(await targetOf(vfs, '/data/links/to-n'), '/data/n.jpg');
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
  }
});
