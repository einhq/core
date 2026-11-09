/**
 * PG tier: the audit trail lives in the write's own transaction and reads back filtered, its ULIDs
 * kept as uuids and its times read from them; a forward read (`after`) is a range of the primary
 * key however many records the trail holds, and compressed chunks answer as the recent ones do. A
 * trail made when ids were text is set aside.
 * Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { ulid } from '@std/ulid';
import { type Access, ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { auditRecord, LocalNodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { uuidToUlid } from '../ulid-uuid.ts';

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

    await t.step('filters by session, and leaves out or keeps only pipeline runs', async () => {
      await vfs.create({ ...ADMIN_ACCESS, sid: 'pipeline:thumbnails/1' }, 'directory', '/myXalbum', 'derived');

      assertEquals((await vfs.audit(ADMIN_ACCESS, { sid: 'pipeline:thumbnails/1' })).map((r) => r.path), ['/myXalbum/derived']);
      assertEquals((await vfs.audit(ADMIN_ACCESS, { pipeline: true })).map((r) => r.path), ['/myXalbum/derived']);
      const people = await vfs.audit(ADMIN_ACCESS, { pipeline: false });
      assertEquals(people.some((r) => r.path === '/myXalbum/derived'), false);
      assertEquals(people.some((r) => r.sid === undefined) && people.some((r) => r.sid === 'session-anna'), true);
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

    await t.step('a record keeps the time in its id, and a time range reads by id', async () => {
      const node = await vfs.get(ADMIN_ACCESS, '/myXalbum/other');
      const day = 86_400_000;
      const now = Date.now();
      const record = (at: number, path: string) => ({ ...auditRecord(ANNA, { op: 'create', node, path })!, id: ulid(at), timestamp: at });

      const tx = await store.beginTransaction();
      await store.appendAudit([record(now - 30 * day, '/old/anna'), record(now - day, '/recent/anna')], tx);
      await tx.commit();

      const [old] = await vfs.audit(ADMIN_ACCESS, { pathPrefix: '/old' });
      assertEquals(old.timestamp, now - 30 * day);
      const within = async (since: number, until: number) => (await vfs.audit(ADMIN_ACCESS, { since, until })).map((r) => r.path);
      assertEquals(await within(now - 31 * day, now - 29 * day), ['/old/anna']);
      assertEquals(await within(now - 30 * day, now - 30 * day + 1), ['/old/anna']);
      assertEquals(await within(now - 30 * day + 1, now - 2 * day), []);
      assertEquals((await within(now - 14 * day, now + 1)).includes('/recent/anna'), true);
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
  }
});

pgTest('PgStore audit trail made when ids were text is set aside', async () => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const table = `${ctx.prefix}_nodes_audit`;
  await ctx.pool.query(`
    CREATE TABLE ${table} (
      id VARCHAR(26) PRIMARY KEY, at TIMESTAMPTZ NOT NULL, uid INTEGER NOT NULL, sid TEXT, cause VARCHAR(26),
      op VARCHAR(16) NOT NULL, node_id TEXT NOT NULL, node_type VARCHAR(64) NOT NULL,
      path TEXT NOT NULL, from_path TEXT, attrs JSONB, props JSONB
    )
  `);
  await ctx.pool.query(`CREATE INDEX ${table}_uid_idx ON ${table} (uid, id)`);
  await ctx.pool.query(`INSERT INTO ${table} (id, at, uid, op, node_id, node_type, path) VALUES ($1, now(), 0, 'create', $2, 'file', '/before')`, [ulid(), ulid()]);

  const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
  const vfs = new LocalNodeVFS(store, routerManager, { file: new MemoryFileRegistry() });
  try {
    await vfs.initialize();
    await vfs.create(ADMIN_ACCESS, 'directory', '/', 'after');

    assertEquals((await vfs.audit(ADMIN_ACCESS, {})).map((r) => r.path), ['/after']);
    assertEquals((await ctx.pool.query(`SELECT path FROM ${table}_v1`)).rows, [{ path: '/before' }]);
    const indexes = await ctx.pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY 1`, [`${table}_v1`]);
    assertEquals(indexes.rows.map((r) => r.indexname), [`${table}_pkey_v1`, `${table}_uid_idx_v1`]);
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await ctx.teardown();
  }
});

/**
 * A ULID as SQL makes one for a test trail, as a `uuid`: `ms` in its first 48 bits and `n` in the
 * rest. `idOf` is the same id as `vfs.audit` answers it.
 */
const idSql = (ms: string, n: string) => `(lpad(to_hex(${ms}), 12, '0') || lpad(to_hex(${n}), 20, '0'))::uuid`;
const idOf = (ms: number, n: number) => uuidToUlid(ms.toString(16).padStart(12, '0') + n.toString(16).padStart(20, '0'));

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
    // Compressing is this test's to do, not the policy's, which would change the plans under it.
    await ctx.pool.query(
      `SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE hypertable_name = $1`,
      [table],
    );
    // A million writes a second apart over 50 homes and 7 categories each, ids in time order, as a
    // trail years old: two chunks. Loaded without the trail's other indexes, which a second store's
    // start then makes again.
    for (const index of ['uid_idx', 'node_idx', 'path_idx', 'cause_idx']) await ctx.pool.query(`DROP INDEX ${table}_${index}`);
    await ctx.pool.query(`
      INSERT INTO ${table} (id, uid, op, node_id, node_type, path)
      SELECT ${idSql('(1700000000::bigint + g) * 1000', 'g')}, 1000 + g % 50, 'update', ${idSql('0', 'g')},
             (ARRAY['file', 'position', 'media-region', 'softlink', 'exif'])[1 + (g / 7) % 5],
             '/home/u' || (g % 50) || '/staging/files/c' || (g % 7) || '/batch/f' || g || '.jpg'
      FROM generate_series(1, 1000000) AS g
    `);
    await new PgStore({ pgPool: ctx.pool, name: ctx.prefix }).initialize();
    await ctx.pool.query(`ANALYZE ${table}`);
    const query = { pathPrefix: '/home/u7/staging/files/c0', after: idOf((1700000000 + 999_000) * 1000, 999_000), nodeTypes: ['file', 'position'], limit: 5000 };
    const sql = (store as unknown as { auditQuerySql: (q: typeof query) => { text: string; values: unknown[] } }).auditQuerySql(query);

    const scans = async (explain: string, values: unknown[]) => {
      const { rows } = await ctx.pool.query(`EXPLAIN (${explain}) ${sql.text}`, values);
      return planNodes((rows[0]['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0].Plan);
    };
    const onPrimaryKey = (nodes: Record<string, unknown>[]) => {
      assertEquals(nodes.some((node) => node['Node Type'] === 'Seq Scan'), false);
      // A chunk's copy of the primary key is named after the table's.
      const scan = nodes.find((node) => String(node['Index Name'] ?? '').endsWith(`${table}_pkey`));
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

    await t.step('compressed, answers a node, a forward read and a time range as before', async () => {
      const before = await vfs.audit(ADMIN_ACCESS, query);
      await ctx.pool.query(`SELECT compress_chunk(c) FROM show_chunks($1::regclass) c`, [table]);
      const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = $1 AND NOT is_compressed`, [table]);
      assertEquals(rows[0].n, 0);

      assertEquals(await vfs.audit(ADMIN_ACCESS, query), before);
      const nodeId = idOf(0, 424_242);
      assertEquals((await vfs.audit(ADMIN_ACCESS, { nodeId })).map((r) => [r.nodeId, r.timestamp]), [[nodeId, (1700000000 + 424_242) * 1000]]);
      const since = (1700000000 + 500_000) * 1000;
      const hour = await vfs.audit(ADMIN_ACCESS, { since, until: since + 3_600_000, limit: 5000 });
      assertEquals(hour.length, 3600);
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await ctx.teardown();
  }
});
