/**
 * PG tier: stored reach conformance against PgStore, the fill of a table made before `reach`, a
 * deleted node's hard-linked child, and the pruning of classes no node refers to. Gated by
 * EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { type Access, ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import type { NodeStore, Transaction } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { runReachConformance } from '../../test/reach-conformance.ts';

const OWNER: Access = { uid: 5000, gid: 5000, gids: [5000] };
const OTHER: Access = { uid: 6000, gid: 6000, gids: [6000] };

const inTx = async <T>(store: NodeStore, fn: (tx: Transaction) => Promise<T>): Promise<T> => {
  const tx = await store.beginTransaction();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
};

// Seed 1 prunes every few classes made, so prunes run between and beside the writes.
for (const [seed, reachPruneAfter] of [[674, undefined], [1, 3]]) {
  pgTest(`PgStore stored reach agrees with a walk (seed ${seed})`, async (t) => {
    const ctx = pgTestContext();
    try {
      await runReachConformance(
        t,
        async () => {
          const store = new PgStore({ pgPool: ctx.pool, name: `${ctx.prefix}_s${seed}`, reachPruneAfter });
          await store.initialize();
          return { store, dispose: () => store.dispose() };
        },
        seed,
        120,
      );
    } finally {
      await ctx.teardown();
    }
  });
}

pgTest("PgStore fills reach for a table made before it, and keeps a deleted node's hard-linked child reachable", async () => {
  const ctx = pgTestContext();
  try {
    const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
    await store.initialize();
    const root = store.rootId;
    // /closed (0700, owned by OWNER) holding /closed/photo, which is also linked under /open.
    const { closed, open, photo, face } = await inTx(store, async (tx) => {
      const closed = await store.createNode(0, 'directory', root, 'closed', { mode: 0o700, uid: OWNER.uid, gid: OWNER.gid }, {}, tx);
      const open = await store.createNode(0, 'directory', root, 'open', { mode: 0o755, uid: 0, gid: 0 }, {}, tx);
      const photo = await store.createNode(0, 'file', closed.id, 'photo', { mode: 0o755, uid: 0, gid: 0 }, {}, tx);
      const face = await store.createNode(0, 'face', photo.id, 'face', { mode: 0o755, uid: 0, gid: 0 }, {}, tx);
      await store.linkChild(0, open.id, photo.id, 'photo', tx);
      return { closed, open, photo, face };
    });
    const reached = async (access: Access) => [...(await store.reachable(access, [closed.id, open.id, photo.id, face.id])).keys()].sort();
    assertEquals(await reached(OTHER), [closed.id, face.id, open.id, photo.id].sort());

    // A table from before the column: no reach anywhere, and the classes gone with it.
    await ctx.pool.query(`UPDATE ${ctx.prefix}_nodes SET reach = NULL`);
    await ctx.pool.query(`TRUNCATE ${ctx.prefix}_nodes_reach RESTART IDENTITY`);
    const reopened = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
    await reopened.initialize();
    assertEquals([...(await reopened.reachable(OTHER, [closed.id, open.id, photo.id, face.id])).keys()].sort(), [closed.id, face.id, open.id, photo.id].sort());

    // Unlinked from /open, the photo is reached only through the closed directory.
    await inTx(reopened, (tx) => reopened.unlinkChild(0, open.id, photo.id, 'photo', tx));
    assertEquals([...(await reopened.reachable(OTHER, [photo.id, face.id])).keys()], []);
    assertEquals([...(await reopened.reachable(OWNER, [photo.id, face.id])).keys()].sort(), [face.id, photo.id].sort());

    // Linked back and the closed directory deleted with the edge still there: the photo is left
    // with /open alone, and is open again.
    await inTx(reopened, (tx) => reopened.linkChild(0, open.id, photo.id, 'photo', tx));
    await inTx(reopened, (tx) => reopened.deleteNodes(0, [closed.id], tx));
    assertEquals([...(await reopened.reachable(OTHER, [photo.id, face.id])).keys()].sort(), [face.id, photo.id].sort());
    assertEquals((await reopened.reachable(ADMIN_ACCESS, [closed.id])).size, 0);
  } finally {
    await ctx.teardown();
  }
});

pgTest('PgStore prunes classes no node refers to at boot, and another store over the table stops handing them out', async () => {
  const ctx = pgTestContext();
  try {
    const writer = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
    await writer.initialize();
    // /closed (0700, owned by OWNER) holding /closed/photo: the photo's class admits OWNER alone.
    const { closed, photo } = await inTx(writer, async (tx) => {
      const closed = await writer.createNode(0, 'directory', writer.rootId, 'closed', { mode: 0o700, uid: OWNER.uid, gid: OWNER.gid }, {}, tx);
      const photo = await writer.createNode(0, 'file', closed.id, 'photo', { mode: 0o755, uid: 0, gid: 0 }, {}, tx);
      return { closed, photo };
    });
    const classOf = async (id: string) => (await ctx.pool.query(`SELECT reach FROM ${ctx.prefix}_nodes WHERE id = $1`, [id])).rows[0].reach as number;
    const ownerOnly = await classOf(photo.id);

    // Opened, nothing refers to the owner-only class any more; a store booting over the table deletes it.
    await inTx(writer, (tx) => writer.updateNodes!(0, [closed.id], { mode: 0o755 }, undefined, tx));
    const booted = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
    await booted.initialize();
    const classes = (await ctx.pool.query(`SELECT id FROM ${ctx.prefix}_nodes_reach`)).rows.map((row) => row.id as number);
    assertEquals(classes.includes(ownerOnly), false);
    assertEquals(classes.sort((a, b) => a - b), [...new Set(await Promise.all([writer.rootId, closed.id, photo.id].map(classOf)))].sort((a, b) => a - b));

    // Closed again, the first store makes the formula anew under a new number rather than the deleted one.
    await inTx(writer, (tx) => writer.updateNodes!(0, [closed.id], { mode: 0o700 }, undefined, tx));
    const remade = await classOf(photo.id);
    assertEquals(remade !== ownerOnly, true);
    assertEquals((await ctx.pool.query(`SELECT 1 FROM ${ctx.prefix}_nodes_reach WHERE id = $1`, [remade])).rowCount, 1);
    assertEquals([...(await booted.reachable(OWNER, [photo.id])).keys()], [photo.id]);
    assertEquals((await booted.reachable(OTHER, [photo.id])).size, 0);

    // A write holds the shared class lock until it ends, and a prune skips while one is held.
    await inTx(writer, (tx) => writer.updateNodes!(0, [closed.id], { mode: 0o755 }, undefined, tx));
    const lockKey = `hashtext('${ctx.prefix}_nodes_reach')`;
    await inTx(writer, async (tx) => {
      await writer.createNode(0, 'directory', writer.rootId, 'held', { mode: 0o755, uid: 0, gid: 0 }, {}, tx);
      const held = await ctx.pool.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND mode = 'ShareLock' AND objid = ${lockKey}::oid`);
      assertEquals(held.rowCount, 1);
    });
    const holder = await ctx.pool.connect();
    try {
      await holder.query(`BEGIN; SELECT pg_advisory_xact_lock_shared(${lockKey})`);
      const skipped = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
      await skipped.initialize();
      assertEquals((await ctx.pool.query(`SELECT 1 FROM ${ctx.prefix}_nodes_reach WHERE id = $1`, [remade])).rowCount, 1);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    await writer.dispose();
    await booted.dispose();
  } finally {
    await ctx.teardown();
  }
});

pgTest('PgStore prunes classes in the background once it has made enough of them', async () => {
  const ctx = pgTestContext();
  try {
    const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix, reachPruneAfter: 2 });
    await store.initialize();
    const classOf = async (id: string) => (await ctx.pool.query(`SELECT reach FROM ${ctx.prefix}_nodes WHERE id = $1`, [id])).rows[0].reach as number;
    const kept = async (id: number) => (await ctx.pool.query(`SELECT 1 FROM ${ctx.prefix}_nodes_reach WHERE id = $1`, [id])).rowCount === 1;
    const { closed, photo } = await inTx(store, async (tx) => {
      const closed = await store.createNode(0, 'directory', store.rootId, 'closed', { mode: 0o700, uid: OWNER.uid, gid: OWNER.gid }, {}, tx);
      const photo = await store.createNode(0, 'file', closed.id, 'photo', { mode: 0o755, uid: 0, gid: 0 }, {}, tx);
      return { closed, photo };
    });
    const ownerOnly = await classOf(photo.id);

    // One class made: no prune starts, and the unused one stays.
    await inTx(store, (tx) => store.updateNodes!(0, [closed.id], { mode: 0o755 }, undefined, tx));
    assertEquals(await kept(ownerOnly), true);

    // A second one made: the write that made it ends with a prune, which `dispose` waits for.
    await inTx(store, (tx) => store.updateNodes!(0, [closed.id], { mode: 0o750 }, undefined, tx));
    await store.dispose();
    assertEquals(await kept(ownerOnly), false);
    assertEquals(await kept(await classOf(photo.id)), true);
  } finally {
    await ctx.teardown();
  }
});
