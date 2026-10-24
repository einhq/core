/**
 * PG tier: batched moves and links under a path.
 *
 * `renameMany` and `updateEach` against real transactions and row locks: links at or under a
 * moved path are re-pointed in the move's own transaction, two calls over the same parents in
 * opposite orders both finish — from one VFS and from two over the same tables, as two processes
 * would — and the store's batched statements write what they are given. The `C`-collated softlink
 * index serves a path prefix, which never takes in a sibling sharing it. Gated by EIN_TEST_PG.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { Pool } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { RelationAttrs } from '../../../lib/api/relation.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { LocalNodeVFS, type NodeAttrs } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';

/** Wider than WRITE_BATCH (128), so a call spans several transactions. */
const WIDE = 300;

/** A wedge is indistinguishable from slowness without a bound on the wait. */
const DEADLINE_MS = 60_000;

async function createPgVfs(pool: Pool, name: string) {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new PgStore({ pgPool: pool, name });
  const vfs = new LocalNodeVFS(store, routerManager, { file: new MemoryFileRegistry() });
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

function withDeadline<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${DEADLINE_MS}ms`)), DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const value = <T>(result: PromiseSettledResult<T>): T => {
  if (result.status === 'rejected') throw new Error(`expected a value, got ${result.reason}`);
  return result.value;
};

pgTest('PgStore batched moves and links under a path', async (t) => {
  const ctx = pgTestContext();
  const { vfs, store, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const second = await createPgVfs(ctx.pool, ctx.prefix);
  const targetOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path, { readlink: true })).props.softlink;
  const mkdirp = async (path: string) => {
    let parent = '/';
    for (const name of path.split('/').filter(Boolean)) {
      await vfs.ensure(ADMIN_ACCESS, 'directory', parent, name, { props: { mode: 0o755 } });
      parent = parent === '/' ? `/${name}` : `${parent}/${name}`;
    }
  };
  const link = (parent: string, name: string, target: string, attrs?: RelationAttrs) =>
    vfs.create(ADMIN_ACCESS, 'softlink', parent, name, { props: { mode: 0o777, softlink: target }, ...(attrs ? { attrs } : {}) });

  try {
    await t.step('boot keeps one softlink index, byte-ordered, in place of the default-collation one', async () => {
      const client = await ctx.pool.connect();
      try {
        await client.query(`CREATE INDEX ${ctx.prefix}_nodes_softlink_idx ON ${ctx.prefix}_nodes (softlink) WHERE softlink IS NOT NULL`);
        await createPgVfs(ctx.pool, ctx.prefix).then((booted) => booted.dispose());
        const { rows } = await client.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef ILIKE '%softlink%'`,
          [`${ctx.prefix}_nodes`],
        );
        assertEquals(rows.map((row) => row.indexname), [`${ctx.prefix}_nodes_softlink_c_idx`]);
        assertStringIncludes(rows[0].indexdef, 'COLLATE "C"');
      } finally {
        client.release();
      }
    });

    await t.step('a path prefix is one range scan of that index', async () => {
      const client = await ctx.pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        const explained = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT l.id FROM unnest($1::text[], $2::text[]) AS r(lo, hi)
           JOIN ${ctx.prefix}_nodes l ON l.softlink COLLATE "C" >= r.lo AND l.softlink COLLATE "C" < r.hi AND l.softlink IS NOT NULL`,
          [['/a/b/'], ['/a/b0']],
        );
        assertStringIncludes(explained.rows.map((row) => row['QUERY PLAN']).join('\n'), `${ctx.prefix}_nodes_softlink_c_idx`);
      } finally {
        await client.query('RESET enable_seqscan').catch(() => {});
        client.release();
      }
    });

    await t.step('the prefix of /a/b does not take in /a/bc, /a/b-c or /a/b.c', async () => {
      await mkdirp('/pointers');
      for (const [i, target] of ['/a/b', '/a/b/c', '/a/bc', '/a/b-c', '/a/b.c', '/a/b0'].entries()) await link('/pointers', `p${i}`, target);

      const found = await store.findSoftlinksUnder(['/a/b'], 100);
      assertEquals(found.map((node) => node.props.softlink).sort(), ['/a/b', '/a/b/c']);
    });

    await t.step('links under many paths are read by index, not by reading the table, however many rows it holds', async () => {
      const client = await ctx.pool.connect();
      try {
        // Rows of links alone, in the table the lookup searches.
        await client.query(
          `INSERT INTO ${ctx.prefix}_nodes (id, type, mode, uid, gid, birth_uid, birth_time, change_uid, change_time, mod_uid, mod_time, softlink)
           SELECT 'L' || lpad(i::text, 25, '0'), 'softlink', 511, 0, 0, 0, now(), 0, now(), 0, now(), '/bulk/d' || (i / 1000) || '/f' || i
           FROM generate_series(1, 50000) i`,
        );
        await client.query(`ANALYZE ${ctx.prefix}_nodes`);

        let seen: { text: string; values: unknown[] } | undefined;
        const capture = {
          active: true,
          client: {
            query: (text: string, values: unknown[]) => {
              seen = { text, values };
              return Promise.resolve({ rows: [] });
            },
          },
        } as unknown as Parameters<typeof store.findSoftlinksUnder>[2];
        await store.findSoftlinksUnder(Array.from({ length: 50 }, (_, i) => `/inbox/f${i}.jpg`), 100_000, capture);
        assert(seen, 'the lookup asked nothing');

        const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${seen.text}`, seen.values);
        const plan = explained.rows.map((row) => row['QUERY PLAN']).join('\n');
        assert(!plan.includes('Hash Join') && !plan.includes(`Seq Scan on ${ctx.prefix}_nodes n`), `the lookup reads the table:\n${plan}`);
        // Each range is its own index scan, bounded by it: a join that filters every link against
        // every range is what a planner guessing too few ranges falls back to.
        assert(/Index Cond: \(+\(?softlink\)?::text >= r\.lo/.test(plan), `the lookup filters every link against every range:\n${plan}`);
      } finally {
        client.release();
      }
    });

    await t.step('a moved directory takes every link into it along, peerLink and all, in its transaction', async () => {
      await mkdirp('/lib/trip/sub');
      await mkdirp('/people/anna/relations');
      await mkdirp('/elsewhere');
      await mkdirp('/archive');
      await vfs.create(ADMIN_ACCESS, 'file', '/lib/trip', 'a.jpg', { props: { mode: 0o755 } });
      await vfs.create(ADMIN_ACCESS, 'file', '/lib/trip/sub', 'c.jpg', { props: { mode: 0o644 } });
      await vfs.create(ADMIN_ACCESS, 'directory', '/lib/trip/a.jpg', 'relations', { props: { mode: 0o755 } });
      await link('/elsewhere', 'to-trip', '/lib/trip');
      await link('/elsewhere', 'to-c', '/lib/trip/sub/c.jpg');
      await link('/people/anna/relations', 'in-a.jpg', '/lib/trip/a.jpg', { relation: { label: 'in', peerLink: '/lib/trip/a.jpg/relations/of-anna' } });
      await link('/lib/trip/a.jpg/relations', 'of-anna', '/people/anna', { relation: { label: 'of', peerLink: '/people/anna/relations/in-a.jpg' } });

      const [moved] = await vfs.renameMany(ADMIN_ACCESS, [{ from: '/lib/trip', to: '/archive/trip' }]);

      assertEquals(value(moved).relinked, 3);
      assertEquals(await targetOf('/elsewhere/to-trip'), '/archive/trip');
      assertEquals(await targetOf('/elsewhere/to-c'), '/archive/trip/sub/c.jpg');
      const anna = await vfs.get<RelationAttrs>(ADMIN_ACCESS, '/people/anna/relations/in-a.jpg', { readlink: true });
      assertEquals(anna.props.softlink, '/archive/trip/a.jpg');
      assertEquals(anna.attrs.relation?.peerLink, '/archive/trip/a.jpg/relations/of-anna');
      assertEquals((await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/archive/trip', op: 'move', limit: 10 })).length, 1);
    });

    await t.step('moved edges go to the tail of their new parent, in the order given', async () => {
      await mkdirp('/order/src');
      await mkdirp('/order/dst');
      await vfs.create(ADMIN_ACCESS, 'file', '/order/dst', 'first.jpg', { props: { mode: 0o644 } });
      for (const name of ['c.jpg', 'a.jpg', 'b.jpg']) await vfs.create(ADMIN_ACCESS, 'file', '/order/src', name, { props: { mode: 0o644 } });

      const results = await vfs.renameMany(ADMIN_ACCESS, ['b.jpg', 'c.jpg', 'a.jpg'].map((name) => ({ from: `/order/src/${name}`, to: `/order/dst/${name}` })));

      assert(results.every((result) => result.status === 'fulfilled'));
      assertEquals((await vfs.children(ADMIN_ACCESS, '/order/dst')).map((entry) => entry.name), ['first.jpg', 'b.jpg', 'c.jpg', 'a.jpg']);
    });

    await t.step('two calls over the same parents in opposite orders both finish, from one VFS and from two', async () => {
      await mkdirp('/swap/left');
      await mkdirp('/swap/right');
      await mkdirp('/swap/links');
      const indexes = Array.from({ length: WIDE }, (_, i) => i);
      for (const side of ['left', 'right']) {
        const prefix = side[0];
        await vfs.createTree(ADMIN_ACCESS, `/swap/${side}`, indexes.map((i) => ({ type: 'file', name: `${prefix}${i}.jpg`, props: { mode: 0o644 } })));
        await vfs.createTree(
          ADMIN_ACCESS,
          '/swap/links',
          indexes.map((i) => ({ type: 'softlink', name: `${prefix}${i}`, props: { mode: 0o777, softlink: `/swap/${side}/${prefix}${i}.jpg` } })),
        );
      }
      const across = (from: string, to: string, prefix: string) =>
        Array.from({ length: WIDE }, (_, i) => ({ from: `/swap/${from}/${prefix}${i}.jpg`, to: `/swap/${to}/${prefix}${i}.jpg` }));

      const [rightward, leftward] = await withDeadline(
        'two renameMany calls in one VFS',
        Promise.all([vfs.renameMany(ADMIN_ACCESS, across('left', 'right', 'l')), vfs.renameMany(ADMIN_ACCESS, across('right', 'left', 'r'))]),
      );
      assert([...rightward, ...leftward].every((result) => result.status === 'fulfilled'));
      assertEquals(await targetOf('/swap/links/l7'), '/swap/right/l7.jpg');
      assertEquals(await targetOf('/swap/links/r7'), '/swap/left/r7.jpg');

      // Back again, each from its own VFS: no shared in-process locks, only the database's.
      const [back, forth] = await withDeadline(
        'two renameMany calls in two VFSs',
        Promise.all([vfs.renameMany(ADMIN_ACCESS, across('right', 'left', 'l')), second.vfs.renameMany(ADMIN_ACCESS, across('left', 'right', 'r'))]),
      );
      assert([...back, ...forth].every((result) => result.status === 'fulfilled'));
      assertEquals(await targetOf('/swap/links/l299'), '/swap/left/l299.jpg');
      assertEquals(await targetOf('/swap/links/r299'), '/swap/right/r299.jpg');
      assertEquals((await vfs.children(ADMIN_ACCESS, '/swap/left')).length, WIDE);
    });

    await t.step('updateEach writes each node its own change, in three statements per batch', async () => {
      await mkdirp('/each');
      const paths: string[] = [];
      for (let i = 0; i < 5; i++) {
        await vfs.create(ADMIN_ACCESS, 'file', '/each', `f${i}.jpg`, { props: { mode: 0o644 }, attrs: { keep: true, drop: 'x' } });
        paths.push(`/each/f${i}.jpg`);
      }
      const before = await vfs.get(ADMIN_ACCESS, paths[0]);

      const results = await vfs.updateEach<NodeAttrs>(ADMIN_ACCESS, [
        { ref: paths[0], props: { mode: 0o600 } },
        { ref: paths[1], attrs: { rank: 1, drop: null } },
        { ref: paths[2], props: { mode: 0o640, gid: 7 }, attrs: { rank: 2 } },
        { ref: paths[3], props: { acl: [{ uid: 9, mode: 0o4 }] } },
      ]);

      const [zero, one, two, three] = results.map(value);
      assertEquals([zero.props.mode & 0o777, zero.attrs], [0o600, { keep: true, drop: 'x' }]);
      // Props alone stamp the change time, attrs the modification time.
      assertEquals(zero.props.modtime, before.props.modtime);
      assertEquals(one.attrs, { keep: true, rank: 1 });
      assertEquals(one.props.mode & 0o777, 0o644);
      assertEquals([two.props.mode & 0o777, two.props.gid, two.attrs.rank], [0o640, 7, 2]);
      assertEquals(three.props.acl, [{ uid: 9, mode: 0o4 }]);
      assertEquals(three.props.count, 1);
      assertEquals((await vfs.get(ADMIN_ACCESS, paths[4])).props.mode & 0o777, 0o644);
    });
  } finally {
    await second.dispose();
    await dispose();
    await ctx.teardown();
  }
});
