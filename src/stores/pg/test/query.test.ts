/**
 * PG tier: NodeQuery conformance against PgStore, plus a plan assertion that
 * time-ordered queries actually ride the module-declared attr indexes.
 *
 * The conformance suite is shared with the in-memory store — the SQL builder
 * and `query-eval.ts` must agree on every op. It runs three times: with the
 * store's own plan choice, and with every subtree read by each plan, which
 * must answer alike. Gated by EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import type { Pool } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { IndexDecl } from '../../../lib/contributions/types.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { repoModules } from '../../../modules/repo.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { type AttrRef, LocalNodeVFS, NAME_LANGUAGES } from '../../../vfs/mod.ts';
import { runQueryConformance } from '../../test/query-conformance.ts';
import { type PgQueryPlanOptions, PgStore } from '../index.ts';
import { attrSortExpr, attrTextExpr, buildAggregateSql, buildQuerySql, buildUpwalkSql } from '../query.ts';

Deno.test('nested attr SQL expressions preserve the validated JSONB path', () => {
  const ref: AttrRef = { path: ['relation', 'from'] };
  assertEquals(attrTextExpr(ref), "attributes->'relation'->>'from'");
  assertEquals(attrSortExpr(ref), `(attributes->'relation'->>'from') COLLATE "C"`);
  assertEquals(
    attrTextExpr({ coalesce: [ref, 'fallback'] }, 'a.attributes'),
    "COALESCE(a.attributes->'relation'->>'from', a.attributes->>'fallback')",
  );
});

Deno.test('a creator filter binds the nodes column and forces the aggregate join', () => {
  const query = buildQuerySql({ birthUid: 77, limit: 10 }, 'nodes', 'attrs');
  assert(query.text.includes('n.birth_uid = $1'), query.text);
  assertEquals(query.values, [77, 10]);

  // Attr-only aggregates skip the nodes join; a node-column filter cannot.
  const aggregate = buildAggregateSql({ birthUid: 77, group: [{ ref: 'takenAt', prefixLength: 4 }] }, 'nodes', 'attrs');
  assert(aggregate.text.includes('JOIN nodes n ON n.id = a.node_id'), aggregate.text);
  assert(aggregate.text.includes('n.birth_uid = $1'), aggregate.text);
});

Deno.test('a keyset cursor bounds the attrs row, which the attrs indexes can seek to', () => {
  const after = { value: null, id: '01ABCDEFGHJKMNPQRSTVWXYZ00' };
  const unordered = buildQuerySql({ types: ['embedding'], after, limit: 10 }, 'nodes', 'attrs');
  assert(unordered.text.includes('a.node_id > $2'), unordered.text);

  const ordered = buildQuerySql({ orderBy: { ref: 'takenAtUtc', dir: 'desc' }, after, limit: 10 }, 'nodes', 'attrs');
  assert(ordered.text.includes(`(${attrSortExpr('takenAtUtc', 'a.attributes')}, a.node_id) < ($1, $2)`), ordered.text);
});

Deno.test('an in on an indexed attr, in id order and unscoped, is read value by value', () => {
  const indexed = (ref: unknown) => ref === 'sha256';
  const query = {
    types: ['file'],
    where: [{ ref: 'sha256', op: 'in' as const, value: ['a', 'b', 'a'] }],
    after: { value: null, id: '01ABCDEFGHJKMNPQRSTVWXYZ00' },
    limit: 10,
  };
  const each = buildQuerySql(query, 'nodes', 'attrs', 'lnk', indexed);
  assert(each.text.includes('CROSS JOIN LATERAL'), each.text);
  assert(each.text.includes(`${attrSortExpr('sha256', 'a.attributes')} = k.v`), each.text);
  assert(each.text.includes('a.node_id > $3'), each.text);
  assertEquals(each.values, [['a', 'b'], ['file'], '01ABCDEFGHJKMNPQRSTVWXYZ00', 10]);

  // An ordered, a scoped or an unindexed `in` stays one `= ANY`.
  for (
    const other of [
      buildQuerySql({ ...query, orderBy: { ref: 'sha256', dir: 'asc' } }, 'nodes', 'attrs', 'lnk', indexed),
      buildQuerySql({ ...query, withinId: '01ROOT' }, 'nodes', 'attrs', 'lnk', indexed),
      buildQuerySql(query, 'nodes', 'attrs', 'lnk', () => false),
      buildQuerySql(query, 'nodes', 'attrs', 'lnk'),
    ]
  ) assert(!other.text.includes('LATERAL') && other.text.includes('= ANY('), other.text);
});

Deno.test('one type in name order is matched on the attrs row, with =', () => {
  const name = { ref: 'name', dir: 'asc' as const, collation: 'sv' as const };
  const one = buildQuerySql({ types: ['person'], orderBy: name, limit: 10 }, 'nodes', 'attrs');
  assert(one.text.includes('a.node_type = $1'), one.text);
  assert(!one.text.includes('n.type ='), one.text);
  assertEquals(one.values[0], 'person');
  const english = buildQuerySql({ types: ['person'], orderBy: { ...name, collation: 'en' }, limit: 10 }, 'nodes', 'attrs');
  assert(english.text.includes('a.node_type = $1'), english.text);

  for (
    const query of [
      { types: ['person', 'album'], orderBy: name },
      { types: ['person'], orderBy: { ref: 'name', dir: 'asc' as const } },
      { types: ['person'], orderBy: { ref: 'takenAtUtc', dir: 'asc' as const } },
      { types: ['person'] },
    ]
  ) {
    const text = buildQuerySql({ ...query, limit: 10 }, 'nodes', 'attrs').text;
    assert(text.includes('n.type = ANY($1)') && !text.includes('a.node_type'), text);
  }
});

/** Every index the repository's modules declare, as `mod setup` would create them. */
async function declaredIndexes(): Promise<IndexDecl[]> {
  const indexes: IndexDecl[] = [];
  for (const { dir } of repoModules()) {
    try {
      const manifest = JSON.parse(await Deno.readTextFile(join(dir, 'mod.json'))) as { indexes?: IndexDecl[] };
      indexes.push(...manifest.indexes ?? []);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory)) throw error;
    }
  }
  return indexes;
}

async function createPgVfs(pool: Pool, name: string, queryPlan?: Partial<PgQueryPlanOptions>) {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new PgStore({ pgPool: pool, name, queryPlan });
  const vfs = new LocalNodeVFS(store, routerManager, {
    file: new MemoryFileRegistry(),
  });
  await vfs.initialize();
  // The indexes on module attrs are the modules' (`mod.json` `indexes`), created at `mod setup`.
  await vfs.ensureAttrIndexes(ADMIN_ACCESS, await declaredIndexes());

  return {
    vfs,
    dispose: async () => {
      await vfs.dispose();
      await routerManager.dispose();
    },
  };
}

for (
  const [plan, queryPlan] of [
    ['', undefined],
    [', every subtree read by P2', { scopeThreshold: 0 }],
    [', every subtree read by P1', { scopeThreshold: Infinity }],
    // Two-row batches: a P2 query crosses several, from a cursor, before it fills or runs out.
    [', every subtree read by P2 two rows at a time', { scopeThreshold: 0, batchMax: 2 }],
  ] as const
) {
  pgTest(`PgStore node query conformance${plan}`, async (t) => {
    const ctx = pgTestContext();
    await runQueryConformance(t, async () => {
      const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix, queryPlan);
      return {
        vfs,
        dispose: async () => {
          await dispose();
          await ctx.teardown();
        },
      };
    });
  });
}

Deno.test('a subtree is read through its materialized members, or walked up to from a batch', () => {
  const p1 = buildQuerySql({ withinId: '01ROOT', notWithinIds: ['01AWAY'], orderBy: { ref: 'takenAtUtc', dir: 'desc' }, limit: 10 }, 'nodes', 'attrs', 'lnk');
  assert(p1.text.includes('within_members AS MATERIALIZED'), p1.text);
  assert(p1.text.includes('FROM within_members m JOIN attrs a ON a.node_id = m.id'), p1.text);
  assert(p1.text.includes('NOT EXISTS (SELECT 1 FROM lnk x WHERE x.child_id = a.node_id AND x.parent_id = ANY(ARRAY(SELECT id FROM excluded_tree)))'), p1.text);

  const counted = buildAggregateSql(
    { withinId: '01ROOT', group: [{ ref: 'sha256' }], counts: { dated: [{ ref: 'takenAtUtc', op: 'exists' }] }, minCount: 2 },
    'nodes',
    'attrs',
    'lnk',
  );
  assert(counted.text.includes('COUNT(*) FILTER (WHERE'), counted.text);
  assert(/HAVING COUNT\(\*\) >= \$\d+/.test(counted.text), counted.text);
});

pgTest('the plans of a subtree query use the indexes they are built for', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const hierarchyTable = `${nodesTable}_lnk`;

  const explain = async (sql: { text: string; values: unknown[] }): Promise<string> => {
    const client = await ctx.pool.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
      return explained.rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('RESET enable_seqscan').catch(() => {});
      client.release();
    }
  };

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'media', { props: { mode: 0o755 } });
    await vfs.create(ADMIN_ACCESS, 'directory', '/media', 'inbox', { props: { mode: 0o755 } });
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const file = await vfs.create(ADMIN_ACCESS, 'file', i % 2 ? '/media' : '/media/inbox', `f${i}.jpg`, {
        props: { mode: 0o644 },
        attrs: { mimetype: 'image/jpeg', takenAtUtc: `${1980 + (i % 45)}-06-01T10:00:00Z` },
      });
      ids.push(file.id);
    }
    await ctx.pool.query(`ANALYZE ${attrsTable}`);
    await ctx.pool.query(`ANALYZE ${hierarchyTable}`);
    const inbox = (await vfs.get(ADMIN_ACCESS, '/media/inbox')).id;

    await t.step('P1 materializes the members once', async () => {
      const plan = await explain(buildQuerySql({ withinId: inbox, orderBy: { ref: 'takenAtUtc', dir: 'desc' }, limit: 60 }, nodesTable, attrsTable, hierarchyTable));
      assert(plan.includes('CTE within_members'), plan);
      assert(plan.includes('Recursive Union'), plan);
    });

    await t.step('a P2 batch reads the time index', async () => {
      const plan = await explain(buildQuerySql({ orderBy: { ref: 'takenAtUtc', dir: 'desc' }, limit: 64 }, nodesTable, attrsTable, hierarchyTable));
      assert(new RegExp(`Index Scan[^\\n]*${attrsTable}_taken_utc_idx`).test(plan), plan);
    });

    await t.step('the up-walk reads the hierarchy by child', async () => {
      const plan = await explain(buildUpwalkSql(ids, [inbox], [inbox], { nodes: nodesTable, hierarchy: hierarchyTable }));
      assert(plan.includes(`${hierarchyTable}_child_idx`), plan);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('one type in name order walks the type and name index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const nodeTypes = async () =>
    Object.fromEntries(
      (await ctx.pool.query<{ entry: string; node_type: string | null }>(
        `SELECT h.name AS entry, a.node_type FROM ${nodesTable}_lnk h JOIN ${attrsTable} a ON a.node_id = h.child_id`,
      )).rows.map((row) => [row.entry, row.node_type]),
    );

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'people', { props: { mode: 0o755 } });
    for (let i = 0; i < 120; i++) {
      await vfs.create(ADMIN_ACCESS, i % 4 ? 'file' : 'directory', '/people', `n${i}`, { props: { mode: 0o755 }, attrs: { name: `Anna ${i}` } });
    }
    await vfs.create(ADMIN_ACCESS, 'directory', '/people', 'unnamed', { props: { mode: 0o755 } });
    await ctx.pool.query(`ANALYZE ${attrsTable}`);

    await t.step('every insert carries its type', async () => {
      const types = await nodeTypes();
      assertEquals(types.n0, 'directory');
      assertEquals(types.n1, 'file');
      assertEquals(types.people, 'directory');
    });

    await t.step('a page from a cursor is an index walk, without a sort', async () => {
      const sql = buildQuerySql(
        { types: ['directory'], orderBy: { ref: 'name', dir: 'asc', collation: 'sv' }, after: { value: 'Anna 4', id: '0' }, limit: 102 },
        nodesTable,
        attrsTable,
      );
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_bitmapscan = off');
        // A table this size is cheaper to hash and sort; with sorting priced out, a plan without
        // a Sort is one the index gives the order for.
        await client.query('SET LOCAL enable_sort = off');
        const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values)).rows.map((r) => r['QUERY PLAN']).join('\n');
        assert(new RegExp(`Index Scan using ${attrsTable}_type_name_sorted_sv_idx`).test(plan), plan);
        assert(!plan.includes('Sort'), plan);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    await t.step('a table made before the column has it on its named rows, and an update fills the rest', async () => {
      await ctx.pool.query(`ALTER TABLE ${attrsTable} DROP COLUMN node_type`);
      const again = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
      await again.initialize();
      const types = await nodeTypes();
      assertEquals(types.n0, 'directory');
      assertEquals(types.n1, 'file');
      assertEquals(types.unnamed, null);

      await vfs.update(ADMIN_ACCESS, '/people/unnamed', { attrs: { name: 'Bertil' } });
      assertEquals((await nodeTypes()).unnamed, 'directory');
      const found = await vfs.query(ADMIN_ACCESS, {
        types: ['directory'],
        where: [{ ref: 'name', op: 'eq', value: 'Bertil' }],
        orderBy: { ref: 'name', dir: 'asc', collation: 'sv' },
        limit: 5,
      });
      assertEquals(found.map((entry) => entry.absPath), ['/people/unnamed']);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('time-ordered queries use the takenAtUtc index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  // The **instant**, which is what ordering and cursors read. The wall clock `takenAt` is only
  // ever range-scanned by prefix and has no index of its own.
  const takenAtUtc: AttrRef = 'takenAtUtc';
  // PgStore appends `_nodes` to the configured name (see its constructor).
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const indexName = `${attrsTable}_taken_utc_idx`;

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'media', { props: { mode: 0o755 } });

    await t.step('seed rows', async () => {
      for (let i = 0; i < 120; i++) {
        const year = 1980 + (i % 45);
        await vfs.create(ADMIN_ACCESS, 'file', '/media', `f${i}.jpg`, {
          props: { mode: 0o644 },
          attrs: {
            mimetype: i % 3 === 0 ? 'video/mp4' : 'image/jpeg',
            takenAt: `${year}-06-01T12:00:00`,
            takenAtUtc: `${year}-06-01T10:00:00Z`,
          },
        });
      }
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('planner can serve the ordered range from the index', async () => {
      const sql = buildQuerySql(
        {
          types: ['file'],
          where: [
            { ref: takenAtUtc, op: 'gte', value: '1995-01-01T00:00:00Z' },
            { ref: takenAtUtc, op: 'lt', value: '2001-01-01T00:00:00Z' },
          ],
          orderBy: { ref: takenAtUtc, dir: 'asc' },
          limit: 60,
        },
        nodesTable,
        attrsTable,
      );

      // On a test-sized table a seq scan is genuinely cheaper, so the planner
      // would take it even with a perfectly matching index and the assertion
      // would prove nothing. Disabling seqscan makes this a pure question of
      // *can* the index serve this predicate — which is exactly the
      // expression-mismatch failure mode we're guarding against. A mismatched
      // index still leaves the planner no choice but to seq scan.
      const client = await ctx.pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
        const plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');

        const indexScan = new RegExp(`Index (Only )?Scan[^\\n]*${indexName}`);
        assert(indexScan.test(plan), `expected an index scan on ${indexName}, got:\n${plan}`);
        assert(!plan.includes(`Seq Scan on ${attrsTable}`), `attrs table was seq scanned:\n${plan}`);
      } finally {
        await client.query('RESET enable_seqscan').catch(() => {});
        client.release();
      }
    });

    await t.step('a seek in either direction has what the planner needs to read in order', async () => {
      // The media feed's seek: a bound on the ordering attr, `sourceId IS NULL`,
      // sixty rows. Without statistics for the sourceId expression the planner
      // underestimates the seek by orders of magnitude and sorts everything past
      // the bound; the statistics object created at init is what lets it see the
      // ordered index scan for the LIMIT it is. On a table this small
      // a sort of sixty rows is genuinely cheapest, so the plan's *shape* is
      // not asserted — only that the two inputs to the right one are there.
      const stats = await ctx.pool.query(`SELECT 1 FROM pg_statistic_ext WHERE stxname = $1`, [`${attrsTable}_source_stats`]);
      assertEquals(stats.rows.length, 1, 'statistics object for the sourceId expression is missing');

      for (const dir of ['asc', 'desc'] as const) {
        const sql = buildQuerySql(
          {
            where: [
              { ref: 'sourceId', op: 'missing' },
              { ref: takenAtUtc, op: dir === 'asc' ? 'gte' : 'lt', value: '2000-01-01T00:00:00Z' },
            ],
            orderBy: { ref: takenAtUtc, dir },
            limit: 60,
          },
          nodesTable,
          attrsTable,
        );
        // The range already excludes rows without the attr; a second, redundant
        // `IS NOT NULL` would make the planner count the null fraction twice.
        assert(!sql.text.includes('IS NOT NULL'), sql.text);

        const client = await ctx.pool.connect();
        try {
          await client.query('SET enable_seqscan = off');
          const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
          const plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');
          assert(new RegExp(`Index Scan[^\\n]*${indexName}`).test(plan), `expected the time index to serve the ${dir} seek:\n${plan}`);
        } finally {
          await client.query('RESET enable_seqscan').catch(() => {});
          client.release();
        }
      }
    });

    await t.step('index expression matches the query expression verbatim', async () => {
      // A mismatch here is how the plan above silently degrades in production,
      // where the row count means the planner picks whatever is cheapest.
      const indexDef = await ctx.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
        [indexName],
      );
      assertEquals(indexDef.rows.length, 1);
      // PG stores the expression in its own canonical form — explicit `::text`
      // casts, extra parens, spaces around operators — so compare on a
      // normalized skeleton rather than the literal string.
      const normalize = (s: string) => s.replace(/::text/g, '').replace(/[\s"'()]/g, '').toLowerCase();
      assert(
        normalize(indexDef.rows[0].indexdef).includes(normalize(attrTextExpr(takenAtUtc))),
        `index definition does not carry the takenAtUtc projection:\n${indexDef.rows[0].indexdef}`,
      );
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('undated device queries use the device/time index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const indexName = `${attrsTable}_device_taken_utc_idx`;
  const devicePath = '/devices/scanjet';

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'media', { props: { mode: 0o755 } });

    await t.step('seed rows', async () => {
      for (let i = 0; i < 120; i++) {
        const target = i % 10 === 0;
        await vfs.create(ADMIN_ACCESS, 'file', '/media', `f${i}.jpg`, {
          props: { mode: 0o644 },
          attrs: {
            mimetype: 'image/jpeg',
            devicePath: target ? devicePath : '/devices/other',
            ...(target ? {} : { takenAtUtc: '2000-01-01T00:00:00Z' }),
          },
        });
      }
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('planner narrows the undated phase by device', async () => {
      // The second phase of a device's `search --subject device:…` timeline: membership
      // remains pushed down, while missing capture time replaces the ordering.
      const sql = buildQuerySql(
        {
          types: ['file'],
          where: [
            { ref: 'devicePath', op: 'eq', value: devicePath },
            { ref: 'takenAtUtc', op: 'missing' },
            { ref: 'sourceId', op: 'missing' },
          ],
          limit: 60,
        },
        nodesTable,
        attrsTable,
      );

      const client = await ctx.pool.connect();
      try {
        // With the tiny fixture the primary-key walk can be cheaper because an
        // unordered NodeQuery pages on id. Disable it with seq scans so this
        // answers whether the device-leading index can serve the predicates.
        await client.query('SET enable_seqscan = off');
        await client.query('SET enable_indexscan = off');
        const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
        const plan = explained.rows.map((row) => row['QUERY PLAN']).join('\n');

        assert(new RegExp(`Bitmap Index Scan on ${indexName}`).test(plan), `expected a bitmap index scan on ${indexName}, got:\n${plan}`);
        assert(!plan.includes(`Seq Scan on ${attrsTable}`), `attrs table was seq scanned:\n${plan}`);
      } finally {
        await client.query('RESET enable_seqscan').catch(() => {});
        await client.query('RESET enable_indexscan').catch(() => {});
        client.release();
      }
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('faces-of-a-person query uses the personId index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const indexName = `${attrsTable}_person_idx`;
  const personId = '01ABCDEFGHJKMNPQRSTVWXYZ00';

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'faces', { props: { mode: 0o755 } });

    await t.step('seed faces across several people', async () => {
      for (let i = 0; i < 120; i++) {
        await vfs.create(ADMIN_ACCESS, 'embedding', '/faces', `face-${i}`, {
          props: { mode: 0o644 },
          attrs: {
            embeddingType: 'face',
            capacity: 4,
            // One person in ten is the one asked for, so the index is selective
            // in the way the real corpus is.
            personId: i % 10 === 0 ? personId : `other-${i}`,
          },
        });
      }
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('planner can serve facesOf from the index', async () => {
      // The query a person's faces listing builds.
      const sql = buildQuerySql(
        {
          types: ['embedding'],
          where: [
            { ref: 'embeddingType', op: 'eq', value: 'face' },
            { ref: 'personId', op: 'eq', value: personId },
          ],
          limit: 500000,
        },
        nodesTable,
        attrsTable,
      );

      // Same reasoning as the takenAt case: on a test-sized table a seq scan is
      // genuinely cheaper, so this asks whether the index *can* serve the
      // predicate — which is the expression-mismatch failure mode being guarded.
      const client = await ctx.pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
        const plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');

        const indexScan = new RegExp(`Index (Only )?Scan[^\\n]*${indexName}`);
        assert(indexScan.test(plan), `expected an index scan on ${indexName}, got:\n${plan}`);
        assert(!plan.includes(`Seq Scan on ${attrsTable}`), `attrs table was seq scanned:\n${plan}`);
      } finally {
        await client.query('RESET enable_seqscan').catch(() => {});
        client.release();
      }
    });

    await t.step('index expression matches the query expression verbatim', async () => {
      const indexDef = await ctx.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
        [indexName],
      );
      assertEquals(indexDef.rows.length, 1);
      const normalize = (s: string) => s.replace(/::text/g, '').replace(/[\s"'()]/g, '').toLowerCase();
      assert(
        normalize(indexDef.rows[0].indexdef).includes(normalize(attrTextExpr('personId'))),
        `index definition does not carry the personId projection:\n${indexDef.rows[0].indexdef}`,
      );
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('a page of one embedding kind seeks to its cursor in the embeddingType index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const indexName = `${attrsTable}_embedding_type_idx`;

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'media', { props: { mode: 0o755 } });

    await t.step('seed embeddings of several kinds among files', async () => {
      for (let i = 0; i < 120; i++) {
        await vfs.create(ADMIN_ACCESS, 'file', '/media', `f${i}.jpg`, { props: { mode: 0o644 }, attrs: { mimetype: 'image/jpeg' } });
        await vfs.create(ADMIN_ACCESS, 'embedding', '/media', `e${i}`, {
          props: { mode: 0o644 },
          attrs: { embeddingType: ['sscd-image', 'face', 'voice'][i % 3], capacity: 4 },
        });
      }
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('the cursor is an index condition, not a filter', async () => {
      // A page in the middle of a walk, as `album-stack` pages through every photo fingerprint.
      const sql = buildQuerySql(
        {
          types: ['embedding'],
          where: [{ ref: 'embeddingType', op: 'eq', value: 'sscd-image' }],
          after: { value: null, id: '01M00000000000000000000000' },
          limit: 20,
        },
        nodesTable,
        attrsTable,
      );

      const client = await ctx.pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
        const plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');

        assert(new RegExp(`Index Scan[^\\n]*${indexName}`).test(plan), `expected an index scan on ${indexName}, got:\n${plan}`);
        assert(/Index Cond: .*embeddingType.*node_id/.test(plan), `expected the cursor in the index condition:\n${plan}`);
        assert(!plan.includes(`Seq Scan on ${attrsTable}`), `attrs table was seq scanned:\n${plan}`);
      } finally {
        await client.query('RESET enable_seqscan').catch(() => {});
        client.release();
      }
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('name search uses the trigram index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const indexName = `${attrsTable}_name_trgm_idx`;

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'media', { props: { mode: 0o755 } });

    await t.step('seed filenames', async () => {
      for (let i = 0; i < 120; i++) {
        // One name in ten carries the substring searched for below, so the
        // index is selective in the way a real filename search is.
        const name = i % 10 === 0 ? `vasaloppet-${i}.jpg` : `DSC_${4000 + i}.JPG`;
        await vfs.create(ADMIN_ACCESS, 'file', '/media', `f${i}.jpg`, {
          props: { mode: 0o644 },
          attrs: { name, mimetype: 'image/jpeg' },
        });
      }
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('planner can serve a substring match from the index', async () => {
      // The query search-media's name half builds.
      const sql = buildQuerySql(
        {
          types: ['file'],
          where: [
            { ref: 'name', op: 'contains', value: 'vasaloppet' },
            { ref: 'sourceId', op: 'missing' },
          ],
          orderBy: { ref: 'name', dir: 'asc', match: 'vasaloppet' },
          limit: 200,
        },
        nodesTable,
        attrsTable,
      );

      // Same reasoning as the two cases above: on a test-sized table a seq scan
      // is cheaper regardless, so this asks whether the index *can* serve the
      // predicate. A GIN index is reached through a bitmap scan, never a plain
      // index scan — matching on "Index Scan" here would fail on a working index.
      //
      // Plain index scans are disabled as well as seq scans, which the other two
      // cases do not need. With only seqscan off the planner can walk the attrs
      // primary key instead: on 120 rows reading them all beats a bitmap scan,
      // and the ILIKE lands in a Filter. That is a row-count judgement, not an
      // index that cannot serve the predicate, which is what this step is about.
      //
      // The `name_sorted_<language>` and `type_name_sorted_<language>` btrees are
      // dropped for the same reason, inside a transaction that is rolled back.
      // They are partial on `name IS NOT NULL`, which the strict ILIKE implies,
      // so a bitmap scan of the whole of one is the cheapest way into 120 rows
      // and the ILIKE again lands in a Filter.
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_indexscan = off');
        for (const language of NAME_LANGUAGES) {
          await client.query(`DROP INDEX ${attrsTable}_name_sorted_${language}_idx`);
          await client.query(`DROP INDEX ${attrsTable}_type_name_sorted_${language}_idx`);
        }
        const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
        const plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');

        assert(
          new RegExp(`Bitmap Index Scan on ${indexName}`).test(plan),
          `expected a bitmap index scan on ${indexName}, got:\n${plan}`,
        );
        assert(!plan.includes(`Seq Scan on ${attrsTable}`), `attrs table was seq scanned:\n${plan}`);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    await t.step('index expression matches the query expression verbatim', async () => {
      const indexDef = await ctx.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
        [indexName],
      );
      assertEquals(indexDef.rows.length, 1);
      const normalize = (s: string) => s.replace(/::text/g, '').replace(/[\s"'()]/g, '').toLowerCase();
      const def = indexDef.rows[0].indexdef;
      assert(
        normalize(def).includes(normalize(attrTextExpr('name'))),
        `index definition does not carry the name projection:\n${def}`,
      );
      // Uncollated, and a trigram GIN: a COLLATE "C" wrapper or a btree here is
      // an index `contains` can never use, and nothing else would notice.
      assert(!def.includes('COLLATE'), `the trigram index must not be collated:\n${def}`);
      assert(def.includes('gin_trgm_ops'), `expected a trigram operator class:\n${def}`);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('words in what is said are found through the spoken text index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;

  try {
    await t.step('the planner can serve a phrase from the index', async () => {
      // Many minutes of speech, one of which says the phrase.
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'said', { props: { mode: 0o755 } });
      for (let i = 0; i < 120; i++) {
        const text = i === 60 ? 'Nu ska vi åka och fiske i sjön.' : `Minut ${i} av samtalet om väder och vind.`;
        await vfs.create(ADMIN_ACCESS, 'embedding', '/said', `t${i * 60}`, { attrs: { embeddingType: 'text_jina5s', text } });
      }
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);

      // The query search-media's spoken half builds. As for names, plain index scans are off: on a
      // table this size the attrs primary key, in the id order the query asks for, is cheaper.
      const sql = buildQuerySql({ types: ['embedding'], where: [{ ref: 'text', op: 'contains', value: 'åka och fiske' }], limit: 200 }, nodesTable, attrsTable);
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_indexscan = off');
        const plan = (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values)).rows.map((r) => r['QUERY PLAN']).join('\n');
        assert(plan.includes(`Bitmap Index Scan on ${attrsTable}_spoken_text_idx`), plan);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    await t.step('the attr has statistics of its own', async () => {
      // Which is what keeps an archive's planner from walking millions of rows without text in id
      // order for a query's limit; a table this size cannot show it.
      const stats = await ctx.pool.query<{ exprs: string }>(`SELECT pg_get_statisticsobjdef_expressions(oid)::text AS exprs FROM pg_statistic_ext WHERE stxname = $1`, [
        `${attrsTable}_spoken_text_stats`,
      ]);
      assertEquals(stats.rows.length, 1);
      assert(stats.rows[0].exprs.includes("'text'"), stats.rows[0].exprs);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('a name sort walks the name_sorted index of its language from its cursor', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const indexName = `${attrsTable}_name_sorted_sv_idx`;

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'albums', { props: { mode: 0o755 } });

    await t.step('seed named albums', async () => {
      for (let i = 0; i < 120; i++) {
        await vfs.create(ADMIN_ACCESS, 'directory', '/albums', `a${i}`, { props: { mode: 0o755 }, attrs: { name: `Album ${i}` } });
      }
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('the order and the cursor are index conditions', async () => {
      // The query a name-sorted search page builds.
      const sql = buildQuerySql(
        { orderBy: { ref: 'name', dir: 'asc', collation: 'sv' }, after: { value: 'Album 5', id: '0' }, limit: 20 },
        nodesTable,
        attrsTable,
      );
      const client = await ctx.pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
        const plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');

        assert(new RegExp(`Index Scan[^\\n]*${indexName}`).test(plan), `expected an index scan on ${indexName}, got:\n${plan}`);
        assert(/Index Cond: .*'name'.*node_id/.test(plan), `expected the cursor in the index condition:\n${plan}`);
        assert(!/Sort Key/.test(plan), `the rows were sorted rather than read in order:\n${plan}`);
      } finally {
        await client.query('RESET enable_seqscan').catch(() => {});
        client.release();
      }
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});

pgTest('a staging journal page and its totals use the staging_journal index, and its keyset holds across equal times', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const indexName = `${attrsTable}_staging_journal_idx`;
  const field = (name: string) => ({ path: ['stagingJournal', name] });
  const categories = ['inbox', 'google-photos', 'box-3'];
  const ENTRIES = 5_000;
  const listQuery = (after?: { value: string | null; id: string }) => ({
    types: ['file'],
    where: [{ ref: field('inbox'), op: 'eq' as const, value: 'anna' }, { ref: field('category'), op: 'eq' as const, value: 'inbox' }],
    orderBy: { ref: field('at'), dir: 'desc' as const },
    ...(after ? { after } : {}),
    limit: 50,
  });

  try {
    await t.step('seed 5,000 entries over three categories, five to each second, and other files', async () => {
      await vfs.create(ADMIN_ACCESS, 'directory', '/', 'journal', { props: { mode: 0o755 } });
      for (let start = 0; start < ENTRIES; start += 1_000) {
        await vfs.createTree(
          ADMIN_ACCESS,
          '/journal',
          Array.from({ length: 1_000 }, (_, k) => {
            const i = start + k;
            const second = String(Math.floor(i / 5) % 60).padStart(2, '0');
            const minute = String(Math.floor(i / 300)).padStart(2, '0');
            return {
              type: 'file',
              name: `e${i}`,
              attrs: {
                stagingJournal: {
                  inbox: i % 10 === 0 ? 'bob' : 'anna',
                  category: categories[i % 3],
                  at: `2026-10-17T10:${minute}:${second}.000Z`,
                  action: i % 4 === 0 ? 'discard' : 'promote',
                  files: 3,
                  ...(i % 7 === 0 ? { undoneAt: '2026-10-17T12:00:00.000Z' } : {}),
                },
              },
            };
          }),
        );
      }
      await vfs.createTree(ADMIN_ACCESS, '/journal', Array.from({ length: 500 }, (_, i) => ({ type: 'file', name: `other${i}`, attrs: { mimetype: 'image/jpeg' } })));
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('a page and the totals are planned on the index', async () => {
      const page = buildQuerySql(listQuery({ value: '2026-10-17T10:08:00.000Z', id: '0' }), nodesTable, attrsTable);
      const totals = buildAggregateSql(
        {
          types: ['file'],
          where: [{ ref: field('inbox'), op: 'eq', value: 'anna' }, { ref: field('undoneAt'), op: 'missing' }],
          group: [{ ref: field('category') }, { ref: field('action') }],
          sum: field('files'),
        },
        nodesTable,
        attrsTable,
      );
      const client = await ctx.pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        for (const sql of [page, totals]) {
          const explained = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
          const plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');
          assert(new RegExp(`(Index|Bitmap Index) Scan[^\\n]*${indexName}`).test(plan), `expected the staging_journal index, got:\n${plan}`);
          assert(!plan.includes(`Seq Scan on ${attrsTable}`), `attrs table was seq scanned:\n${plan}`);
        }
      } finally {
        await client.query('RESET enable_seqscan').catch(() => {});
        client.release();
      }
    });

    await t.step('pages by (at, id) list every entry of the category once, newest first', async () => {
      const seen: { at: string; id: string }[] = [];
      let after: { value: string | null; id: string } | undefined;
      for (;;) {
        const rows = await vfs.query(ADMIN_ACCESS, listQuery(after));
        seen.push(...rows.map((row) => ({ at: row.sortValue!, id: row.id })));
        if (rows.length < 50) break;
        after = { value: rows[rows.length - 1].sortValue, id: rows[rows.length - 1].id };
      }
      const expected = Array.from({ length: ENTRIES }, (_, i) => i).filter((i) => i % 10 !== 0 && i % 3 === 0).length;
      assertEquals(seen.length, expected);
      assertEquals(new Set(seen.map((row) => row.id)).size, expected);
      const ordered = [...seen].sort((a, b) => b.at.localeCompare(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      assertEquals(seen, ordered);
    });
  } finally {
    await dispose();
    await ctx.teardown();
  }
});
