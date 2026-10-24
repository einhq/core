/**
 * PG tier: a module's partial attr index over a nested attr, `duplicate_found` (archive's
 * `duplicate.inbox`, `.kind`, `.where`, for rows with a `kind`), serves the reads made over it:
 * a page of one class with equalities on all three keys and the node-id keyset, read straight off
 * the index with no sort; the counts of an inbox's copies by class; the ids of an inbox's findings; a
 * checksum's twins off `sha256_idx`; and the twins of 500 checksums, `sha256 in`, a lookup on it per
 * checksum. Each holds as a generic plan too, which a prepared statement may be given whatever its
 * values. The memory and PostgreSQL stores page alike. Gated by
 * EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import type { Pool, PoolClient } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { IndexDecl } from '../../../lib/contributions/types.ts';
import { NOT_DERIVED } from '../../../lib/kinds/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { repoModules } from '../../../modules/repo.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { createTestVfs } from '../../../testing/test-vfs.ts';
import { type AttrRef, LocalNodeVFS, type NodeQuery, type NodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { buildAggregateSql, buildQuerySql, type SqlQuery } from '../query.ts';

const field = (name: string): AttrRef => ({ path: ['duplicate', name] });
const INBOXES = ['anna', 'bob', 'carl'];
const FINDINGS = 5_000;
const PAGE = 50;

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

async function createPgVfs(pool: Pool, name: string) {
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();
  const vfs = new LocalNodeVFS(new PgStore({ pgPool: pool, name }), routerManager, { file: new MemoryFileRegistry() });
  await vfs.initialize();
  await vfs.ensureAttrIndexes(ADMIN_ACCESS, await declaredIndexes());
  return {
    vfs,
    dispose: async () => {
      await vfs.dispose();
      await routerManager.dispose();
    },
  };
}

/**
 * Findings over three inboxes: a third of them exact copies in the library, a third in the inbox,
 * a third markers (no `kind`); a few trashed forms (no `inbox`); and files with no finding.
 */
async function seed(vfs: NodeVFS): Promise<void> {
  await vfs.create(ADMIN_ACCESS, 'directory', '/', 'staged', { props: { mode: 0o755 } });
  for (let start = 0; start < FINDINGS; start += 1_000) {
    await vfs.createTree(
      ADMIN_ACCESS,
      '/staged',
      Array.from({ length: 1_000 }, (_, k) => {
        const i = start + k;
        const sha256 = String(i % 1_500).padStart(64, '0');
        const kind = i % 3 === 2 ? {} : { kind: 'exact', where: i % 3 === 0 ? 'library' : 'inbox', of: `o${i % 1_500}` };
        const duplicate = i % 97 === 0
          ? { sha256, at: '2026-10-18T10:00:00Z' }
          : { inbox: INBOXES[i % 3 === 0 ? 0 : i % 5 === 0 ? 1 : 2], sha256, at: '2026-10-18T10:00:00Z', ...kind };
        return { type: 'file', name: `f${i}.jpg`, attrs: { mimetype: 'image/jpeg', size: 10, sha256, duplicate } };
      }),
    );
  }
  await vfs.createTree(ADMIN_ACCESS, '/staged', Array.from({ length: 500 }, (_, i) => ({ type: 'file', name: `plain${i}.jpg`, attrs: { mimetype: 'image/jpeg', size: 10 } })));
}

/** One class's page, with equalities on all three keys and the node-id keyset. */
const classPage = (inbox: string, where: string, after?: { value: string | null; id: string }): NodeQuery => ({
  types: ['file'],
  where: [{ ref: field('inbox'), op: 'eq', value: inbox }, { ref: field('kind'), op: 'eq', value: 'exact' }, { ref: field('where'), op: 'eq', value: where }],
  ...(after ? { after } : {}),
  limit: PAGE,
});

/** Every name one class lists, page by page, checking each page comes in id order. */
const listClass = async (vfs: NodeVFS, inbox: string, where: string): Promise<string[]> => {
  const names: string[] = [];
  let after: { value: string | null; id: string } | undefined;
  for (;;) {
    const rows = await vfs.query(ADMIN_ACCESS, classPage(inbox, where, after));
    const ids = rows.map((row) => row.id);
    assertEquals(ids, [...ids].sort(), 'a page comes in id order');
    names.push(...rows.map((row) => row.absPath));
    if (rows.length < PAGE) return names.sort();
    after = { value: null, id: ids[ids.length - 1] };
  }
};

/** The plan of `sql`: as planned for its values, or the generic plan a prepared statement may be given whatever they are. */
const planOf = async (client: PoolClient, sql: SqlQuery, generic: boolean): Promise<string> => {
  const explained = generic
    ? await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (GENERIC_PLAN) ${sql.text}`)
    : await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values);
  return explained.rows.map((r) => r['QUERY PLAN']).join('\n');
};

pgTest('duplicate findings are paged, counted and listed off the duplicate_found index', async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const memory = await createTestVfs();
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const found = `${attrsTable}_duplicate_found_idx`;
  const sha = `${attrsTable}_sha256_idx`;

  try {
    await t.step('seed 5,000 findings over three inboxes, with markers, trashed forms and plain files', async () => {
      await seed(vfs);
      await seed(memory.vfs);
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('each read is planned on its index, as its own plan and as a generic one', async () => {
      const reads: [string, SqlQuery, string][] = [
        ['a class page', buildQuerySql(classPage('carl', 'inbox', { value: null, id: '0' }), nodesTable, attrsTable), found],
        [
          "an inbox's counts",
          buildAggregateSql(
            { where: [{ ref: field('inbox'), op: 'eq', value: 'anna' }, { ref: field('kind'), op: 'eq', value: 'exact' }], group: [{ ref: field('where') }] },
            nodesTable,
            attrsTable,
          ),
          found,
        ],
        [
          "an inbox's finding ids",
          buildAggregateSql(
            { types: ['file'], where: [{ ref: field('inbox'), op: 'eq', value: 'bob' }, { ref: field('kind'), op: 'exists' }], group: [{ column: 'id' }] },
            nodesTable,
            attrsTable,
          ),
          found,
        ],
        [
          "a checksum's twins",
          buildQuerySql({ types: ['file'], where: [{ ref: 'sha256', op: 'eq', value: '7'.padStart(64, '0') }, NOT_DERIVED], limit: 1_000 }, nodesTable, attrsTable),
          sha,
        ],
        [
          "many checksums' twins",
          buildQuerySql(
            {
              types: ['file'],
              where: [{ ref: 'sha256', op: 'in', value: Array.from({ length: 500 }, (_, i) => String(i * 3).padStart(64, '0')) }, NOT_DERIVED],
              limit: 1_000,
            },
            nodesTable,
            attrsTable,
            undefined,
            (ref) => ref === 'sha256',
          ),
          sha,
        ],
      ];
      const client = await ctx.pool.connect();
      try {
        for (const [name, sql, index] of reads) {
          for (const generic of [false, true]) {
            const plan = await planOf(client, sql, generic);
            const label = `${name}${generic ? ' (generic)' : ''}`;
            assert(new RegExp(`(Index|Index Only|Bitmap Index) Scan[^\\n]*${index}`).test(plan), `${label}: expected ${index}, got:\n${plan}`);
            assert(!plan.includes(`Seq Scan on ${attrsTable}`), `${label}: attrs table was seq scanned:\n${plan}`);
            if (name === 'a class page') assert(!/\bSort\b/.test(plan), `${label}: a page is sorted:\n${plan}`);
            if (name === "many checksums' twins") assert(/Nested Loop[\s\S]*Function Scan on unnest/.test(plan), `${label}: not a lookup per checksum:\n${plan}`);
          }
        }
      } finally {
        client.release();
      }
    });

    await t.step('pages list every finding of a class once, alike in both stores', async () => {
      for (const inbox of INBOXES) {
        for (const where of ['library', 'inbox']) {
          const [pg, mem] = [await listClass(vfs, inbox, where), await listClass(memory.vfs, inbox, where)];
          assertEquals(pg, mem, `${inbox}/${where}`);
          assertEquals(new Set(pg).size, pg.length);
        }
      }
      const total = (await Promise.all(INBOXES.flatMap((inbox) => ['library', 'inbox'].map((where) => listClass(vfs, inbox, where))))).reduce(
        (sum, names) => sum + names.length,
        0,
      );
      const expected = Array.from({ length: FINDINGS }, (_, i) => i).filter((i) => i % 97 !== 0 && i % 3 !== 2).length;
      assertEquals(total, expected);
    });
  } finally {
    await memory.dispose();
    await dispose();
    await ctx.teardown();
  }
});
