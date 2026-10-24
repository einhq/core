/**
 * PG tier: the audit trail lives in the write's own transaction, and reads back filtered; a
 * forward read (`after`) is a range of the primary key however many records the trail holds.
 * Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { type Access, ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { auditRecord, LocalNodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';

const ANNA: Access = { uid: 1003, gid: 1003, gids: [1003], sid: 'session-anna' };

pgTest('PgStore audit trail', async (t) => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
  const vfs = new LocalNodeVFS(store, routerManager, { file: new MemoryFileRegistry() });
  await vfs.initialize();

  try {
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'my_album', { props: { mode: 0o777 } });
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'myXalbum', { props: { mode: 0o777 } });

    await t.step('round-trips a record with its session and values', async () => {
      const node = await vfs.create(ANNA, 'directory', '/my_album', 'trip', { attrs: { title: 'A sailboat', tags: ['sea'] } });
      await vfs.update(ANNA, '/my_album/trip', { attrs: { title: 'Two sailboats', tags: null } });

      const [update, create] = await vfs.audit(ADMIN_ACCESS, { nodeId: node.id });
      assertEquals(create.op, 'create');
      assertEquals(create.sid, 'session-anna');
      assertEquals(create.attrs, { title: { to: 'A sailboat' }, tags: { to: ['sea'] } });
      assertEquals(update.op, 'update');
      assertEquals(update.uid, ANNA.uid);
      assertEquals(update.attrs, { title: { from: 'A sailboat', to: 'Two sailboats' }, tags: { from: ['sea'] } });
      assertEquals(Math.abs(update.timestamp - Date.now()) < 60_000, true);
    });

    await t.step('matches a path prefix literally, move on either side', async () => {
      await vfs.create(ANNA, 'directory', '/myXalbum', 'other');
      await vfs.rename(ANNA, '/my_album', 'trip', '/myXalbum', 'trip');

      // `_` is a LIKE wildcard; unescaped, /my_album would also match /myXalbum.
      const under = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/my_album' });
      // The last is /my_album itself.
      assertEquals(under.map((r) => r.op), ['move', 'update', 'create', 'create']);
      assertEquals(under[0].fromPath, '/my_album/trip');
      assertEquals(under[0].path, '/myXalbum/trip');
    });

    await t.step('filters by user, op and time', async () => {
      assertEquals((await vfs.audit(ADMIN_ACCESS, { uid: ANNA.uid, op: 'create' })).length, 2);
      assertEquals((await vfs.audit(ADMIN_ACCESS, { since: Date.now() + 60_000 })).length, 0);
      assertEquals((await vfs.audit(ADMIN_ACCESS, { limit: 2 })).length, 2);
    });

    await t.step('round-trips a cause, and finds a record by id and by cause', async () => {
      const [cause] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/myXalbum/other' });
      const step: Access = { ...ADMIN_ACCESS, sid: 'pipeline:derive/n1', cause: cause.id };
      await vfs.create(step, 'directory', '/myXalbum/other', 'thumbnail');

      const [derived] = await vfs.audit(ADMIN_ACCESS, { cause: cause.id });
      assertEquals([derived.path, derived.sid, derived.cause], ['/myXalbum/other/thumbnail', 'pipeline:derive/n1', cause.id]);
      assertEquals((await vfs.audit(ADMIN_ACCESS, { id: cause.id })).map((r) => r.path), ['/myXalbum/other']);
    });

    await t.step('a rolled-back transaction takes its records with it', async () => {
      const before = await vfs.audit(ADMIN_ACCESS, { limit: 1000 });
      const node = await vfs.get(ADMIN_ACCESS, '/myXalbum/other');

      const tx = await store.beginTransaction();
      await store.appendAudit([auditRecord(ANNA, { op: 'delete', node, path: '/myXalbum/other' })!], tx);
      await tx.rollback();

      assertEquals((await vfs.audit(ADMIN_ACCESS, { limit: 1000 })).length, before.length);
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
  }
});

pgTest('PgStore audit trail made without `cause` gains the column', async () => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  await ctx.pool.query(`
    CREATE TABLE ${ctx.prefix}_nodes_audit (
      id VARCHAR(26) PRIMARY KEY, at TIMESTAMPTZ NOT NULL, uid INTEGER NOT NULL, sid TEXT,
      op VARCHAR(16) NOT NULL, node_id TEXT NOT NULL, node_type VARCHAR(64) NOT NULL,
      path TEXT NOT NULL, from_path TEXT, attrs JSONB, props JSONB
    )
  `);

  const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
  const vfs = new LocalNodeVFS(store, routerManager, { file: new MemoryFileRegistry() });
  try {
    await vfs.initialize();
    await vfs.create({ ...ADMIN_ACCESS, cause: 'r1' }, 'directory', '/', 'thumbnail');

    const [record] = await vfs.audit(ADMIN_ACCESS, { cause: 'r1' });
    assertEquals(record.path, '/thumbnail');
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await ctx.teardown();
  }
});

/** Every plan node of an `EXPLAIN (FORMAT JSON)` answer, depth first. */
const planNodes = (plan: Record<string, unknown>): Record<string, unknown>[] => [
  plan,
  ...((plan.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(planNodes),
];

pgTest('PgStore audit trail reads forward on its primary key over a million records', async (t) => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
  const vfs = new LocalNodeVFS(store, routerManager, { file: new MemoryFileRegistry() });
  const table = `${ctx.prefix}_nodes_audit`;
  try {
    await vfs.initialize();
    // A million writes over 50 homes and 7 categories each, ids in time order, as a trail years old.
    // Loaded without the trail's other indexes, which a second store's start then makes again.
    for (const index of ['uid_idx', 'node_idx', 'path_idx', 'cause_idx']) await ctx.pool.query(`DROP INDEX ${table}_${index}`);
    await ctx.pool.query(`
      INSERT INTO ${table} (id, at, uid, op, node_id, node_type, path)
      SELECT '01J' || lpad(g::text, 23, '0'), to_timestamp(1700000000 + g), 1000 + g % 50, 'update', 'n' || g,
             (ARRAY['file', 'position', 'media-region', 'softlink', 'exif'])[1 + (g / 7) % 5],
             '/home/u' || (g % 50) || '/staging/files/c' || (g % 7) || '/batch/f' || g || '.jpg'
      FROM generate_series(1, 1000000) AS g
    `);
    await new PgStore({ pgPool: ctx.pool, name: ctx.prefix }).initialize();
    await ctx.pool.query(`ANALYZE ${table}`);
    const query = { pathPrefix: '/home/u7/staging/files/c0', after: '01J' + String(999_000).padStart(23, '0'), nodeTypes: ['file', 'position'], limit: 5000 };
    const sql = (store as unknown as { auditQuerySql: (q: typeof query) => { text: string; values: unknown[] } }).auditQuerySql(query);

    const scans = async (explain: string, values: unknown[]) => {
      const { rows } = await ctx.pool.query(`EXPLAIN (${explain}) ${sql.text}`, values);
      return planNodes((rows[0]['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0].Plan);
    };
    const onPrimaryKey = (nodes: Record<string, unknown>[]) => {
      assertEquals(nodes.some((node) => node['Node Type'] === 'Seq Scan'), false);
      const scan = nodes.find((node) => node['Index Name'] === `${table}_pkey`);
      assertEquals(/\bid\b\)?(::text)? > /.test(String(scan?.['Index Cond'] ?? '')), true);
    };

    await t.step('with its values known', async () => {
      onPrimaryKey(await scans('FORMAT JSON', sql.values));
    });

    await t.step('as a generic plan, as a prepared statement may be planned', async () => {
      onPrimaryKey(await scans('GENERIC_PLAN, FORMAT JSON', []));
    });

    await t.step('answers the records after the id, oldest first', async () => {
      const records = await vfs.audit(ADMIN_ACCESS, query);
      assertEquals(records.length > 0, true);
      assertEquals(records.every((r) => r.id > query.after && r.path.startsWith('/home/u7/staging/files/c0/') && ['file', 'position'].includes(r.nodeType)), true);
      assertEquals(records.map((r) => r.id), records.map((r) => r.id).toSorted());
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await ctx.teardown();
  }
});
