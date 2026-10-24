/**
 * PG tier: a module's partial attr index whose partial attr is not among its keys, `staging_edit`
 * (archive's journal entries by `stagingJournal.inbox`, `.category` and `.at`, for the entries
 * that keep a grouping edit, `stagingEdit.op`), serves the read the organizer makes of one
 * category's live edits — as the plan for its values and as the generic plan a prepared statement
 * may be given whatever they are — and the memory and PostgreSQL stores answer it alike. Gated by
 * EIN_TEST_PG.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import type { Pool, PoolClient } from 'pg';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import type { IndexDecl } from '../../../lib/contributions/types.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { repoModules } from '../../../modules/repo.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { createTestVfs } from '../../../testing/test-vfs.ts';
import { type AttrRef, LocalNodeVFS, type NodeQuery, type NodeVFS } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';
import { buildQuerySql } from '../query.ts';

const journal = (name: string): AttrRef => ({ path: ['stagingJournal', name] });
const INBOXES = ['anna', 'bob', 'carl'];
const CATEGORIES = ['inbox', 'scans', 'phone'];
const ENTRIES = 6_000;

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

/** Journal entries over three inboxes and categories: one in ten keeps an edit, one in four of those undone. */
async function seed(vfs: NodeVFS): Promise<void> {
  await vfs.create(ADMIN_ACCESS, 'directory', '/', 'journal', { props: { mode: 0o755 } });
  for (let start = 0; start < ENTRIES; start += 1_000) {
    await vfs.createTree(
      ADMIN_ACCESS,
      '/journal',
      Array.from({ length: 1_000 }, (_, k) => {
        const i = start + k;
        const edit = i % 10 === 0;
        const stagingJournal = {
          inbox: INBOXES[i % 3],
          category: CATEGORIES[Math.floor(i / 3) % 3],
          at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
          action: edit ? 'edit' : 'promote',
          files: 1,
          summary: '',
          state: 'done',
          ...(edit && i % 40 === 0 ? { undoneAt: '2026-10-18T00:00:00Z' } : {}),
        };
        return {
          type: 'file',
          name: `e${String(i).padStart(5, '0')}`,
          attrs: { stagingJournal, ...(edit ? { stagingEdit: { category: stagingJournal.category, op: 'cut', after: `f${i}` } } : {}) },
        };
      }),
    );
  }
}

/** One category's live edits, a page of them, as the organizer reads them. */
const liveEdits = (inbox: string, category: string, after?: { value: string | null; id: string }): NodeQuery => ({
  types: ['file'],
  where: [
    { ref: journal('inbox'), op: 'eq', value: inbox },
    { ref: journal('category'), op: 'eq', value: category },
    { ref: { path: ['stagingEdit', 'op'] }, op: 'exists' },
    { ref: journal('undoneAt'), op: 'missing' },
  ],
  ...(after ? { after } : {}),
  limit: 1_000,
});

const planOf = async (client: PoolClient, text: string, values: unknown[], generic: boolean): Promise<string> => {
  const explained = generic
    ? await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (GENERIC_PLAN) ${text}`)
    : await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, values);
  return explained.rows.map((r) => r['QUERY PLAN']).join('\n');
};

pgTest("a category's live grouping edits are read off the staging_edit index", async (t) => {
  const ctx = pgTestContext();
  const { vfs, dispose } = await createPgVfs(ctx.pool, ctx.prefix);
  const memory = await createTestVfs();
  const nodesTable = `${ctx.prefix}_nodes`;
  const attrsTable = `${nodesTable}_attr`;
  const index = `${attrsTable}_staging_edit_idx`;

  try {
    await t.step('seed 6,000 journal entries over three inboxes and categories', async () => {
      await seed(vfs);
      await seed(memory.vfs);
      await ctx.pool.query(`ANALYZE ${attrsTable}`);
      await ctx.pool.query(`ANALYZE ${nodesTable}`);
    });

    await t.step('the read is planned on the index, as its own plan and as a generic one', async () => {
      const sql = buildQuerySql(liveEdits('bob', 'scans', { value: null, id: '0' }), nodesTable, attrsTable);
      const client = await ctx.pool.connect();
      try {
        for (const generic of [false, true]) {
          const plan = await planOf(client, sql.text, sql.values, generic);
          const label = generic ? 'generic' : 'custom';
          assert(new RegExp(`(Index|Index Only|Bitmap Index) Scan[^\\n]*${index}`).test(plan), `${label}: expected ${index}, got:\n${plan}`);
          assert(!plan.includes(`Seq Scan on ${attrsTable}`), `${label}: attrs table was seq scanned:\n${plan}`);
        }
      } finally {
        client.release();
      }
    });

    await t.step('both stores answer alike: the live edits of one inbox and category, none undone', async () => {
      const names = async (store: NodeVFS) => (await store.query(ADMIN_ACCESS, liveEdits('bob', 'scans'))).map((row) => row.absPath).sort();
      const [pg, mem] = [await names(vfs), await names(memory.vfs)];
      assertEquals(pg, mem);
      const expected = Array.from({ length: ENTRIES }, (_, i) => i).filter((i) =>
        i % 10 === 0 && i % 40 !== 0 && INBOXES[i % 3] === 'bob' && CATEGORIES[Math.floor(i / 3) % 3] === 'scans'
      );
      assertEquals(pg.length, expected.length);
    });
  } finally {
    await memory.dispose();
    await dispose();
    await ctx.teardown();
  }
});
