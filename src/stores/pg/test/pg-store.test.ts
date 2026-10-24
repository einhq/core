/**
 * PG tier: PgStore through LocalNodeVFS — CRUD, children, persistence
 * across re-instantiation and concurrent conflicting renames (row locking).
 * Gated by EIN_TEST_PG.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { Pool } from 'pg';
import { type Access, ADMIN_ACCESS, LINK_UID_BASE } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS, NodeAccessDeniedError, NodeAlreadyExistsError, NodeNotFoundError, NodeTierImmutableError } from '../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../vfs/types/directory.ts';
import { PgStore } from '../index.ts';

async function createPgVfs(pool: Pool, name: string) {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new PgStore({ pgPool: pool, name });
  const vfs = new LocalNodeVFS(store, routerManager, {
    file: new MemoryFileRegistry(),
  });
  await vfs.initialize();

  return {
    vfs,
    store,
    dispose: async () => {
      await vfs.dispose();
      await routerManager.dispose();
    },
  };
}

/**
 * Store round trips while `fn` runs, counted at `pool.connect`: reads go through
 * `runParameterized`, which takes a client and queries on that, so a spy on the
 * pool's own query method never fires.
 */
async function countConnects(pool: Pool, fn: () => Promise<unknown>): Promise<number> {
  let connects = 0;
  const original = pool.connect.bind(pool);
  // deno-lint-ignore no-explicit-any
  (pool as any).connect = (...args: unknown[]) => {
    connects++;
    // deno-lint-ignore no-explicit-any
    return (original as any)(...args);
  };
  try {
    await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (pool as any).connect = original;
  }
  return connects;
}

pgTest('PgStore node CRUD and children', async (t) => {
  const ctx = pgTestContext();
  const { vfs, store, dispose } = await createPgVfs(ctx.pool, ctx.prefix);

  try {
    await t.step('create, get and update nodes', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'dir', { props: { mode: 0o755 } });
      const created = await vfs.create(ADMIN_ACCESS, 'directory', '/dir', 'child', {
        props: { mode: 0o700 },
        attrs: { label: 'v1' },
      });

      const fetched = await vfs.get(ADMIN_ACCESS, '/dir/child');
      assertEquals(fetched.id, created.id);
      assertEquals(fetched.props.mode & 0o777, 0o700);
      assertEquals(fetched.attrs.label, 'v1');

      await vfs.update(ADMIN_ACCESS, '/dir/child', { attrs: { label: 'v2' } });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/dir/child')).attrs.label, 'v2');
    });

    // The attrs update is a merge (`attributes || $1`), so omitting a key means "leave it
    // alone"; a null or undefined value is what removes one.
    await t.step('null or undefined in an attrs update deletes the key', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'attrdel', { props: { mode: 0o755 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/attrdel', 'note', {
        props: { mode: 0o644 },
        attrs: { keep: 'yes', drop: 'no', unnamed: true },
      });

      await vfs.update(ADMIN_ACCESS, '/attrdel/note', { attrs: { drop: null, unnamed: null } });

      const attrs = (await vfs.get(ADMIN_ACCESS, '/attrdel/note')).attrs;
      assertEquals(Object.hasOwn(attrs, 'drop'), false, 'drop should be gone, not null');
      assertEquals(Object.hasOwn(attrs, 'unnamed'), false, 'unnamed should be gone, not false');
      assertEquals(attrs.keep, 'yes', 'untouched keys survive');

      // Deleting an absent key is a no-op, not an error, and must not disturb the rest.
      await vfs.update(ADMIN_ACCESS, '/attrdel/note', { attrs: { neverThere: null } });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/attrdel/note')).attrs.keep, 'yes');

      // Undefined deletes as null does, rather than vanishing in the JSON and leaving the key.
      await vfs.update(ADMIN_ACCESS, '/attrdel/note', { attrs: { keep: undefined } });
      assertEquals(Object.hasOwn((await vfs.get(ADMIN_ACCESS, '/attrdel/note')).attrs, 'keep'), false);
    });

    await t.step('tier prop round-trips and is immutable', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'tierdir', { props: { mode: 0o755 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/tierdir', 'note', {
        props: { mode: 0o644, tier: 'db' },
        attrs: { name: 'note', mimetype: 'text/plain', size: 0 },
      });
      // the tier column persists as a prop (not in attrs)
      const node = await vfs.get(ADMIN_ACCESS, '/tierdir/note');
      assertEquals(node.props.tier, 'db');
      assertEquals('tier' in node.attrs, false);

      // changing it is rejected; re-sending the same value is a no-op
      await assertRejects(
        () => vfs.update(ADMIN_ACCESS, '/tierdir/note', { props: { tier: 'disk' } }),
        NodeTierImmutableError,
      );
      await vfs.update(ADMIN_ACCESS, '/tierdir/note', { props: { tier: 'db' } });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/tierdir/note')).props.tier, 'db');
    });

    await t.step('timestamps are numbers, not strings', async () => {
      // pg returns extract(epoch …) numeric as a string; PgStore must coerce it.
      const node = await vfs.get(ADMIN_ACCESS, '/dir/child');
      for (const t of [node.props.birthtime, node.props.changetime, node.props.modtime]) {
        assertEquals(typeof t.timestamp, 'number');
        assertEquals(Number.isFinite(t.timestamp), true);
      }
    });

    await t.step('children listing', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/dir', 'second', { props: { mode: 0o755 } });

      const children = await vfs.children(ADMIN_ACCESS, '/dir');
      assertEquals(children.map((c) => c.name).toSorted(), ['child', 'second']);
    });

    // The `(parent_id, name)` primary key is what answers this — nothing reads
    // the parent's children first — so the constraint has to surface as the
    // VFS's own error rather than a raw driver one.
    await t.step('duplicate child names are rejected', async () => {
      await assertRejects(
        () => vfs.create(ADMIN_ACCESS, 'directory', '/dir', 'child', {}),
        NodeAlreadyExistsError,
      );
    });

    // A subtree is one transaction, so a name taken part-way through it takes
    // the nodes already written with it. The memory store has no transaction to
    // roll back, which is why this half of `createTree` is pinned here.
    await t.step('createTree rolls back a subtree that collides part-way', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'instances', { props: { mode: 0o755 } });

      await vfs.createTree(ADMIN_ACCESS, '/instances', [{
        type: 'directory',
        name: 'inst',
        children: [{ type: 'directory', name: 'steps', children: [{ type: 'directory', name: 'one' }] }],
      }]);

      assertEquals((await vfs.children(ADMIN_ACCESS, '/instances/inst/steps')).map((c) => c.name), ['one']);

      await assertRejects(
        () =>
          vfs.createTree(ADMIN_ACCESS, '/instances', [{
            type: 'directory',
            name: 'doomed',
            children: [{ type: 'directory', name: 'steps' }, { type: 'directory', name: 'steps' }],
          }]),
        NodeAlreadyExistsError,
      );

      assertEquals(await vfs.exists(ADMIN_ACCESS, '/instances/doomed'), false, 'the whole subtree went with the failure');
    });

    // One indexed query for the whole batch, and it must agree with the path
    // walk about who the parent is — that is the only thing callers substitute
    // it for.
    await t.step('parent links come back for a whole batch at once', async () => {
      const dirId = (await vfs.get(ADMIN_ACCESS, '/dir')).id;
      const childId = (await vfs.get(ADMIN_ACCESS, '/dir/child')).id;
      const secondId = (await vfs.get(ADMIN_ACCESS, '/dir/second')).id;

      const links = await store.getParentLinksMany!([childId, secondId]);
      assertEquals(links.get(childId), [{ parentId: dirId, name: 'child' }]);
      assertEquals(links.get(secondId), [{ parentId: dirId, name: 'second' }]);

      const resolved = await store.resolvePaths!([childId]);
      assertEquals(links.get(childId)?.[0].parentId, resolved.get(childId)?.[0].parentId);

      assertEquals((await store.getParentLinksMany!([])).size, 0);
    });

    // What the VFS checks execute on for a path it did not walk: every directory
    // it passes through, root first.
    await t.step('a resolved path lists its ancestors, and ownership comes back alone', async () => {
      const dirId = (await vfs.get(ADMIN_ACCESS, '/dir')).id;
      const childId = (await vfs.get(ADMIN_ACCESS, '/dir/child')).id;

      const [path] = (await store.resolvePaths!([childId])).get(childId)!;
      assertEquals(path.path, '/dir/child');
      assertEquals(path.ancestors, [store.rootId, dirId]);
      assertEquals((await store.resolvePaths!([store.rootId])).get(store.rootId)?.[0].ancestors, []);

      const owners = await store.getOwnership!([childId, dirId]);
      const child = await vfs.get(ADMIN_ACCESS, '/dir/child');
      assertEquals(owners.get(childId), { mode: child.props.mode, uid: child.props.uid, gid: child.props.gid });
      assertEquals(owners.size, 2);
    });

    await t.step('releaseOwner hands ownership over and drops ACL entries naming the id', async () => {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'left', { props: { mode: 0o750, uid: 2001, gid: 2001 } });
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'granted', {
        props: { mode: 0o700, acl: [{ uid: 2001, mode: 0o5 }, { gid: 2001, mode: 0o4 }] },
      });
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'only', { props: { mode: 0o700, acl: [{ uid: 2001, mode: 0o4 }] } });
      // A walk through it fills the path cache, which the release must drop.
      await vfs.get(ADMIN_ACCESS, '/left');

      assertEquals(await store.releaseOwner({ kind: 'uid', id: 2001, to: 2003 }, 0), { owned: 1, acl: 2 });
      const left = await vfs.get(ADMIN_ACCESS, '/left');
      assertEquals([left.props.uid, left.props.gid], [2003, 2001]);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/granted')).props.acl, [{ gid: 2001, mode: 0o4 }]);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/only')).props.acl ?? undefined, undefined);
      assertEquals((await store.resolveChain!(store.rootId, ['left'])).entries[0].props.uid, 2003);

      assertEquals(await store.releaseOwner({ kind: 'gid', id: 2001, to: 0 }, 0), { owned: 1, acl: 1 });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/left')).props.gid, 0);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/granted')).props.acl ?? undefined, undefined);
    });

    await t.step('unlink removes nodes', async () => {
      await vfs.unlink(ADMIN_ACCESS, '/dir/second', '/dir');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/dir/second'), false);
    });

    await t.step('unlink drops only the named edge of two under one parent', async () => {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/dir', 'twice');
      await vfs.link(ADMIN_ACCESS, '/dir/twice', '/dir', 'again');

      await vfs.unlink(ADMIN_ACCESS, '/dir/twice', '/dir');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/dir/twice'), false);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/dir/again')).props.count, 1);

      await vfs.unlink(ADMIN_ACCESS, '/dir/again', '/dir');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/dir/again'), false);
    });

    await t.step('a node id is bound as a value, not spliced into the SQL', async () => {
      const id = "x' OR '1'='1";
      await assertRejects(() => store.getNode(id), NodeNotFoundError);
      assertEquals(await store.getParents(id), []);
    });

    // A node read must not depend on how many children it has.
    await t.step('a node read carries no child list', async () => {
      const node = await vfs.get(ADMIN_ACCESS, '/dir');
      assertEquals('children' in node.props, false);
      assertEquals(await vfs.childCount(ADMIN_ACCESS, '/dir'), 1);
    });

    // …and neither must a write: adding one edge leaves every sibling row as it
    // was, which the surviving positions below pin.
    await t.step('adding an edge leaves the sibling rows alone', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'many', { props: { mode: 0o755 } });
      const manyId = (await vfs.get(ADMIN_ACCESS, '/many')).id;
      for (let i = 0; i < 5; i++) {
        await vfs.create(ADMIN_ACCESS, 'directory', '/many', `d${i}`, { props: { mode: 0o755 } });
      }

      const before = await store.getChildLinks(manyId);
      await vfs.create(ADMIN_ACCESS, 'directory', '/many', 'late', { props: { mode: 0o755 } });
      const after = await store.getChildLinks(manyId);

      assertEquals(after.length, before.length + 1);
      for (const link of before) {
        const still = after.find((l) => l.name === link.name);
        assertEquals(still?.id, link.id);
        assertEquals(still?.position, link.position);
      }
      // The new edge lands at the tail
      assertEquals(after.at(-1)?.name, 'late');
    });

    await t.step('siblings made together take the tail in the order given, and a name taken there makes none', async () => {
      const manyId = (await vfs.get(ADMIN_ACCESS, '/many')).id;
      const tail = (await store.getChildLinks(manyId)).at(-1)?.position ?? 0;

      const made = await vfs.createTree(ADMIN_ACCESS, '/many', [
        { type: 'file', name: 'b.jpg', attrs: { rank: 1 } },
        { type: 'softlink', name: 'a-link', props: { mode: 0o777, softlink: '/many/b.jpg' } },
        { type: 'directory', name: 'c', children: [{ type: 'file', name: 'inner.txt' }] },
      ]);
      const links = await store.getChildLinks(manyId);
      assertEquals(links.slice(-3).map((link) => [link.name, link.id, link.position]), [
        ['b.jpg', made[0].id, tail + 1],
        ['a-link', made[1].id, tail + 2],
        ['c', made[2].id, tail + 3],
      ]);
      const stored = await store.getNode(made[1].id);
      assertEquals([stored.type, stored.props.softlink, stored.props.count], ['softlink', '/many/b.jpg', 1]);
      assertEquals((await store.getNode(made[0].id)).attrs, { rank: 1 });
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/many/c/inner.txt'), true);

      const refused = await assertRejects(
        () => vfs.createTree(ADMIN_ACCESS, '/many', [{ type: 'file', name: 'new.jpg' }, { type: 'file', name: 'b.jpg' }]),
        NodeAlreadyExistsError,
      );
      assertEquals(refused.message.includes('b.jpg'), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/many/new.jpg'), false);
    });

    await t.step('rename in place keeps its slot, across parents takes the tail', async () => {
      const manyId = (await vfs.get(ADMIN_ACCESS, '/many')).id;
      const slot = (await store.getChildLinks(manyId, { name: 'd2' }))[0];

      await vfs.rename(ADMIN_ACCESS, '/many', 'd2', '/many', 'd2-renamed');
      const renamed = (await store.getChildLinks(manyId, { name: 'd2-renamed' }))[0];
      assertEquals(renamed.id, slot.id);
      assertEquals(renamed.position, slot.position);

      await vfs.rename(ADMIN_ACCESS, '/many', 'd2-renamed', '/dir', 'moved');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/many/d2-renamed'), false);
      const moved = (await store.getChildLinks((await vfs.get(ADMIN_ACCESS, '/dir')).id, { name: 'moved' }))[0];
      assertEquals(moved.id, slot.id);
    });

    await t.step('rename onto a taken name replaces it, or refuses under failIfExists', async () => {
      const incoming = await vfs.create(ADMIN_ACCESS, 'directory', '/dir', 'incoming', { props: { mode: 0o755 } });
      await vfs.create(ADMIN_ACCESS, 'directory', '/dir', 'occupant', { props: { mode: 0o755 } });

      await assertRejects(
        () => vfs.rename(ADMIN_ACCESS, '/dir', 'incoming', '/dir', 'occupant', { failIfExists: true }),
        NodeAlreadyExistsError,
      );

      await vfs.rename(ADMIN_ACCESS, '/dir', 'incoming', '/dir', 'occupant');
      const dirId = (await vfs.get(ADMIN_ACCESS, '/dir')).id;
      const links = await store.getChildLinks(dirId, { name: 'occupant' });
      assertEquals(links.map((link) => link.id), [incoming.id]);
    });

    await t.step('a store move onto a taken name says so', async () => {
      const dirId = (await vfs.get(ADMIN_ACCESS, '/dir')).id;
      await vfs.create(ADMIN_ACCESS, 'directory', '/dir', 'spare', { props: { mode: 0o755 } });
      const tx = await store.beginTransaction();
      try {
        await assertRejects(() => store.moveChild!(0, dirId, 'spare', dirId, 'occupant', tx), NodeAlreadyExistsError);
      } finally {
        await tx.rollback();
      }
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('PgStore persists across re-instantiation', async () => {
  const ctx = pgTestContext();

  {
    const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'persisted', {
      props: { mode: 0o750 },
      attrs: { marker: 42 },
    });
    await dispose();
  }

  {
    const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
    const node = await vfs.get(ADMIN_ACCESS, '/persisted');
    assertEquals(node.props.mode & 0o777, 0o750);
    assertEquals(node.attrs.marker, 42);
    await dispose();
  }

  await ctx.teardown();
});

pgTest('PgStore concurrent conflicting renames stay consistent', async () => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'race1', {});
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'race2', {});
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'contested', {});

    const results = await Promise.allSettled([
      vfs.rename(ADMIN_ACCESS, '/', 'contested', '/race1', 'won'),
      vfs.rename(ADMIN_ACCESS, '/', 'contested', '/race2', 'won'),
    ]);

    const wins = results.filter((r) => r.status === 'fulfilled').length;
    assertEquals(wins >= 1, true);

    const locations = [
      await vfs.exists(ADMIN_ACCESS, '/race1/won'),
      await vfs.exists(ADMIN_ACCESS, '/race2/won'),
    ].filter(Boolean).length;

    assertEquals(locations, wins === 2 ? 2 : 1);
    assertEquals(await vfs.exists(ADMIN_ACCESS, '/contested'), false);
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

/**
 * `resolveChain` walks a whole path in one recursive descent, rather than the
 * round trip per segment every VFS operation would otherwise pay first.
 *
 * The contract is deliberately narrow: return the nodes, in order, stopping
 * wherever the hierarchy does. It knows nothing about mounts or softlinks; the
 * caller replays those checks over whatever it gets and steps for the rest.
 */
pgTest('PgStore.resolveChain walks a path in one query', async (t) => {
  const ctx = pgTestContext();
  const { vfs, store, dispose } = await createPgVfs(ctx.pool, ctx.prefix);

  try {
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'a');
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/a', 'b');
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/a/b', 'c');

    await t.step('returns every level in order', async () => {
      const { root, entries } = await store.resolveChain(store.rootId, ['a', 'b', 'c']);

      assertEquals(root.id, store.rootId);
      assertEquals(entries.map((entry) => entry.name), ['a', 'b', 'c']);

      // Each entry carries what the caller runs permission checks and softlink
      // detection against, as the full node has it.
      const direct = await vfs.get(ADMIN_ACCESS, '/a/b/c');
      assertEquals(entries[2].id, direct.id);
      assertEquals(entries[2].props.mode, direct.props.mode);
      assertEquals(entries[2].props.uid, direct.props.uid);
      assertEquals(entries[2].props.softlink, undefined);
    });

    await t.step('stops at the first missing segment instead of failing', async () => {
      // A short chain is the contract, not an error: it is how the caller learns
      // to fall back to stepping.
      assertEquals((await store.resolveChain(store.rootId, ['a', 'nope', 'c'])).entries.map((e) => e.name), ['a']);
      assertEquals((await store.resolveChain(store.rootId, ['nope'])).entries, []);
      assertEquals((await store.resolveChain(store.rootId, [])).entries, []);
    });

    await t.step('follows the named edge, not just any edge to the node', async () => {
      // Hard links mean one node can hang under several parents, and the same
      // name can be reused under a different one. Resolving must follow the
      // edge from *this* parent, so a chain cannot jump between branches.
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'other');
      const shared = await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/a/b', 'shared');
      await vfs.link(ADMIN_ACCESS, '/a/b/shared', '/other', 'shared');

      const chain = await store.resolveChain(store.rootId, ['a', 'b', 'shared']);
      assertEquals(chain.entries.map((e) => e.name), ['a', 'b', 'shared']);
      assertEquals(chain.entries[2].id, shared.id);

      const viaOther = await store.resolveChain(store.rootId, ['other', 'shared']);
      assertEquals(viaOther.entries.map((e) => e.name), ['other', 'shared']);
      assertEquals(viaOther.entries[1].id, shared.id);
    });

    await t.step('resolving a deep path takes one query, not one per segment', async () => {
      // Creating `z` resolved `/x/y` but never read the edge to `z`, so this walk is not cached.
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'x');
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/x', 'y');
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/x/y', 'z');

      const first = await countConnects(ctx.pool, () => store.resolveChain(store.rootId, ['x', 'y', 'z']));
      assertEquals(first, 1, 'the root and a three-segment path must cost one round trip');

      // The comparison that matters: stepping the same path is one per level.
      const stepped = await countConnects(ctx.pool, async () => {
        let parent = store.rootId;
        for (const name of ['x', 'y', 'z']) {
          parent = (await store.getChildren(parent, { name }))[0].node.id;
        }
      });
      assertEquals(stepped, 3, 'the per-segment walk this replaces costs one each');
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

/**
 * A walk `resolveChain` has answered is answered again from memory, and every
 * write that changes what it read is seen by the very next walk — no waiting
 * for anything to expire.
 */
pgTest('PgStore caches path walks until a write changes them', async (t) => {
  const ctx = pgTestContext();
  const { vfs, store, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const OTHER: Access = { uid: 6000, gid: 6000, gids: [6000] };

  try {
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/', 'c');
    await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 'a');
    const b = await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c/a', 'b');

    await t.step('a repeated walk costs no query', async () => {
      await store.resolveChain(store.rootId, ['c', 'a', 'b']);
      assertEquals(await countConnects(ctx.pool, () => store.resolveChain(store.rootId, ['c', 'a', 'b'])), 0);
      // What is left of a `get` is reading the node itself.
      assertEquals(await countConnects(ctx.pool, () => vfs.get(ADMIN_ACCESS, '/c/a/b')), 1);
    });

    await t.step('a missing name is remembered as missing', async () => {
      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/c/later'), NodeNotFoundError);
      assertEquals(await countConnects(ctx.pool, () => store.resolveChain(store.rootId, ['c', 'later'])), 0);
    });

    await t.step('a missing name created afterwards is walked to', async () => {
      // The VFS steps past a chain that ends early, so it would find `later` anyway; the
      // store's own walk is what shows the "missing" was forgotten.
      const c = await vfs.get(ADMIN_ACCESS, '/c');
      const later = await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 'later');
      const { entries } = await store.resolveChain(store.rootId, ['c', 'later']);
      assertEquals(entries.map((entry) => entry.id), [c.id, later.id]);
    });

    await t.step('a renamed directory is found under its new name, with what is below it', async () => {
      await vfs.rename(ADMIN_ACCESS, '/c', 'a', '/c', 'renamed');

      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/c/a/b'), NodeNotFoundError);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/c/renamed/b')).id, b.id);
    });

    await t.step('a directory closed by chmod stops the next walk through it', async () => {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 'locked');
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c/locked', 'inner');
      await vfs.get(OTHER, '/c/locked/inner');

      await vfs.update(ADMIN_ACCESS, '/c/locked', { props: { mode: 0o700 } });
      await assertRejects(() => vfs.get(OTHER, '/c/locked/inner'), NodeAccessDeniedError);
    });

    await t.step('a retargeted softlink is followed to its new target', async () => {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 't1');
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 't2');
      const x1 = await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c/t1', 'x');
      const x2 = await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c/t2', 'x');
      await vfs.create(ADMIN_ACCESS, 'softlink', '/c', 'link', { props: { mode: 0o777, softlink: '/c/t1' } });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/c/link/x')).id, x1.id);

      await vfs.update(ADMIN_ACCESS, '/c/link', { readlink: true, props: { softlink: '/c/t2' } });
      assertEquals((await vfs.get(ADMIN_ACCESS, '/c/link/x')).id, x2.id);
    });

    await t.step('a name unlinked and made again resolves to the new node', async () => {
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 'again');
      await vfs.get(ADMIN_ACCESS, '/c/again');
      await vfs.unlink(ADMIN_ACCESS, '/c/again', '/c');
      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/c/again'), NodeNotFoundError);

      const made = await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 'again');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/c/again')).id, made.id);
    });

    await t.step('a create that loses to an existing name leaves the walk as it was', async () => {
      const kept = await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 'dup');
      await assertRejects(() => vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 'dup'), NodeAlreadyExistsError);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/c/dup')).id, kept.id);
    });

    await t.step('a walk inside a transaction sees its own writes; one outside sees the committed tree', async () => {
      const parent = await vfs.get(ADMIN_ACCESS, '/c');
      const moved = await vfs.create(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, '/c', 'before');
      await store.resolveChain(store.rootId, ['c', 'before']);

      const tx = await store.beginTransaction();
      try {
        await store.moveChild(ADMIN_ACCESS.uid, parent.id, 'before', parent.id, 'after', tx);

        const inside = await store.resolveChain(store.rootId, ['c', 'after'], tx);
        assertEquals(inside.entries.map((entry) => entry.id), [parent.id, moved.id]);

        const outside = await store.resolveChain(store.rootId, ['c', 'before']);
        assertEquals(outside.entries.map((entry) => entry.id), [parent.id, moved.id]);
      } finally {
        await tx.rollback();
      }

      assertEquals((await vfs.get(ADMIN_ACCESS, '/c/before')).id, moved.id);
      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/c/after'), NodeNotFoundError);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

/**
 * Ephemeral writes commit without waiting for the WAL flush. The statement is
 * the thing to pin — `SET LOCAL … ; COMMIT` as one query — and that Postgres
 * accepts it: a session node written through the VFS must come back readable
 * after the relaxed commit, and a transaction with any durable write in it
 * must still commit plainly.
 */
pgTest('PgStore commits ephemeral-only transactions with synchronous_commit off', async (t) => {
  const ctx = pgTestContext();
  const { vfs, store, dispose } = await createPgVfs(ctx.pool, ctx.prefix);

  // Every transaction's statements, so the commit each one ended with can be read back.
  const commits: string[] = [];
  const begin = store.beginTransaction.bind(store);
  store.beginTransaction = async () => {
    const tx = await begin();
    const client = (tx as unknown as { client: { query: (...args: unknown[]) => Promise<unknown> } }).client;
    const query = client.query.bind(client);
    client.query = (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('COMMIT')) commits.push(sql);
      return query(...args);
    };
    return tx;
  };
  const lastCommit = () => commits[commits.length - 1];

  try {
    await t.step('a session node commits relaxed and is readable afterwards', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'sessions', { props: { mode: 0o755 } });
      assertEquals(lastCommit(), 'COMMIT');

      await vfs.create(ADMIN_ACCESS, 'session', '/sessions', 's1', { attrs: { secret: 'x' } });
      assertEquals(lastCommit(), 'SET LOCAL synchronous_commit TO OFF; COMMIT');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/sessions/s1')).attrs.secret, 'x');

      await vfs.update(ADMIN_ACCESS, '/sessions/s1', { attrs: { secret: 'y' } });
      assertEquals(lastCommit(), 'SET LOCAL synchronous_commit TO OFF; COMMIT');
      assertEquals((await vfs.get(ADMIN_ACCESS, '/sessions/s1')).attrs.secret, 'y');

      await vfs.unlink(ADMIN_ACCESS, '/sessions/s1', '/sessions');
      assertEquals(lastCommit(), 'SET LOCAL synchronous_commit TO OFF; COMMIT');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/sessions/s1'), false);
    });

    await t.step('the setting does not leak into the next transaction on the same connection', async () => {
      // SET LOCAL is scoped to its transaction; a durable write right after,
      // very likely on the same pooled connection, must see the default again.
      await vfs.create(ADMIN_ACCESS, 'session', '/sessions', 's2', { attrs: {} });
      await vfs.create(ADMIN_ACCESS, 'directory', '/sessions', 'durable', { props: { mode: 0o755 } });
      assertEquals(lastCommit(), 'COMMIT');

      const tx = await begin();
      const { rows } = await (tx as unknown as { client: { query: (sql: string) => Promise<{ rows: { synchronous_commit: string }[] }> } })
        .client.query('SHOW synchronous_commit');
      await tx.rollback();
      assertEquals(rows[0].synchronous_commit, 'on');
    });

    await t.step('one durable write in a subtree pins the commit', async () => {
      await vfs.createTree(ADMIN_ACCESS, '/sessions', [{
        type: 'session',
        name: 's3',
        attrs: {},
        children: [{ type: 'directory', name: 'scratch', attrs: {} }],
      }]);
      assertEquals(lastCommit(), 'COMMIT');
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

// The SQL counterpart of `id-lookup-access.test.ts`'s aggregate step: the store filters by the
// reader's mode bits and access list, and through the directories it can pass.
pgTest('PgStore aggregate counts only what the reader can reach', async () => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const owner: Access = { uid: 5000, gid: 5000, gids: [5000] };
  const other: Access = { uid: 6000, gid: 6000, gids: [6000] };
  const friend: Access = { uid: 7000, gid: 7000, gids: [7000] };

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'home', { props: { mode: 0o755, uid: owner.uid, gid: owner.gid } });
    await vfs.create(ADMIN_ACCESS, 'directory', '/home', 'staging', { props: { mode: 0o700, uid: owner.uid, gid: owner.gid } });
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'shared', { props: { mode: 0o755 } });
    for (const dir of ['/home/staging', '/shared']) {
      await vfs.create(ADMIN_ACCESS, 'file', dir, 'a.jpg', { props: { mode: 0o775, uid: owner.uid, gid: owner.gid }, attrs: { label: 'photo' } });
      await vfs.create(ADMIN_ACCESS, 'position', `${dir}/a.jpg`, 'position', { props: { mode: 0o775, uid: owner.uid, gid: owner.gid } });
    }
    // Readable by its owner alone, though in an open directory.
    await vfs.create(ADMIN_ACCESS, 'file', '/shared', 'private.jpg', { props: { mode: 0o700, uid: owner.uid, gid: owner.gid }, attrs: { label: 'photo' } });

    const count = async (access: Access, type: string) => (await vfs.aggregate(access, { types: [type], group: [{ column: 'type' }] }))[0]?.count ?? 0;
    assertEquals(await count(ADMIN_ACCESS, 'file'), 3);
    assertEquals(await count(owner, 'file'), 3);
    assertEquals(await count(other, 'file'), 1);
    assertEquals(await count(owner, 'position'), 2);
    assertEquals(await count(other, 'position'), 1);

    // An access-list entry opens staging to one other person.
    await vfs.update(ADMIN_ACCESS, '/home/staging', { props: { acl: [{ uid: friend.uid, mode: 0o5 }] } });
    assertEquals(await count(friend, 'file'), 2);
    assertEquals(await count(other, 'file'), 1);

    // The file's own access list grants read: to a user, a group, or a share link while it is
    // live; an entry without the read bit grants nothing.
    const link = LINK_UID_BASE + 7;
    await vfs.update(ADMIN_ACCESS, '/shared/private.jpg', {
      props: { acl: [{ uid: other.uid, mode: 0o2 }, { gid: 4000, mode: 0o4 }, { uid: link, mode: 0o4 }] },
    });
    assertEquals(await count(other, 'file'), 1);
    assertEquals(await count({ ...other, gids: [6000, 4000] }, 'file'), 2);
    assertEquals(await count({ uid: link, gid: link, gids: [], link: { id: 'l' } }, 'file'), 2);
    assertEquals(await count({ uid: link, gid: link, gids: [], link: { id: 'l', expiresAt: 1 } }, 'file'), 1);
  } finally {
    await dispose();
  }
});
