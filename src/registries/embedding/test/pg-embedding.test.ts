/**
 * PG tier: embedding conformance against PostgreSQL/pgvector.
 * Gated by EIN_TEST_PG.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { PG_URL, pgTestContext } from '../../../testing/gates.ts';
import { EmbeddingRegistry } from '../mod.ts';
import { embeddingConformanceTests } from './embedding-conformance.ts';

embeddingConformanceTests('EmbeddingRegistry (pgvector) conformance', async () => {
  const ctx = pgTestContext();
  const registry = new EmbeddingRegistry({ name: ctx.prefix, pool: ctx.pool });
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
      await ctx.teardown();
    },
  };
}, { ignore: !PG_URL, sanitize: false });

Deno.test({
  name: 'EmbeddingRegistry (pgvector) findSimilar returns more rows than the HNSW search list holds',
  ignore: !PG_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const ctx = pgTestContext();
    const registry = new EmbeddingRegistry({ name: ctx.prefix, pool: ctx.pool });
    await registry.init();
    try {
      // Distinct directions over a quarter circle: similarity to [1, 0, 0] falls with the index.
      const count = 3000;
      const limit = 1500;
      const embeddings = `${ctx.prefix}_embeddings`;
      const vectors = `${embeddings}_deep_data`;
      // A `vector` table: 3000 directions a fraction of a degree apart are finer than float16
      // separates, and this test is about the scan, not the storage. It also covers a table
      // keeping a `vector` column.
      await ctx.pool.query(
        `CREATE TABLE ${vectors} (id VARCHAR(26) PRIMARY KEY REFERENCES ${embeddings}(id) ON DELETE CASCADE,
                                  embedding vector(3) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      await ctx.pool.query(`CREATE INDEX ${vectors}_hnsw_idx ON ${vectors} USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);
      const handle = await registry.open('deep-0', { embeddingType: 'deep', capacity: 3 }, 'w');
      await handle.write(new TextEncoder().encode('[1,0,0]'));
      await handle.close();

      // Bulk rows straight into the registry's tables: one handle write per row would take
      // longer than the rest of the suite.
      await ctx.pool.query(
        `INSERT INTO ${embeddings} (id, type, size, size_bytes)
         SELECT 'deep-' || i, 'deep', 3, 0 FROM generate_series(1, $1 - 1) i`,
        [count],
      );
      await ctx.pool.query(
        `INSERT INTO ${vectors} (id, embedding)
         SELECT 'deep-' || i, ('[' || cos(i::float / $1 * pi() / 2) || ',' || sin(i::float / $1 * pi() / 2) || ',0]')::vector
         FROM generate_series(1, $1 - 1) i`,
        [count],
      );
      // With statistics the planner serves the query from the HNSW index, as it does on a real
      // corpus; a never-analyzed table gets a sequential scan, which has no row ceiling at all.
      await ctx.pool.query(`ANALYZE ${vectors}`);
      const plan = await ctx.pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT id FROM ${vectors} ORDER BY embedding <=> '[1,0,0]'::vector LIMIT ${limit}`,
      );
      assertStringIncludes(plan.rows.map((row) => row['QUERY PLAN']).join('\n'), 'Index Scan');

      const matches = await registry.findSimilar('deep', new TextEncoder().encode('[1,0,0]'), limit, 0);
      assertEquals(matches.length, limit);
      assertEquals(matches.map((match) => match.id), Array.from({ length: limit }, (_, i) => `deep-${i}`));
    } finally {
      await registry.dispose();
      await ctx.teardown();
    }
  },
});

Deno.test({
  name: 'EmbeddingRegistry (pgvector) stores a new type as halfvec and searches it',
  ignore: !PG_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const ctx = pgTestContext();
    const registry = new EmbeddingRegistry({ name: ctx.prefix, pool: ctx.pool });
    await registry.init();
    try {
      // 2560 dimensions: past `vector`'s 2000-dimension HNSW limit, inside halfvec's 4000.
      const dims = 2560;
      const unit = (axis: number) => `[${Array.from({ length: dims }, (_, i) => (i === axis ? 1 : 0)).join(',')}]`;
      for (const [id, axis] of [['wide-a', 0], ['wide-b', 1], ['wide-c', 2]] as const) {
        const handle = await registry.open(id, { embeddingType: 'wide', capacity: dims }, 'w');
        await handle.write(new TextEncoder().encode(unit(axis)));
        await handle.close();
      }
      const column = await ctx.pool.query<{ kind: string }>(
        `SELECT t.typname AS kind FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = to_regclass($1) AND a.attname = 'embedding'`,
        [`${ctx.prefix}_embeddings_wide_data`],
      );
      assertEquals(column.rows[0]?.kind, 'halfvec');

      const matches = await registry.findSimilar('wide', new TextEncoder().encode(unit(1)), 3, 0.5);
      assertEquals(matches.map((match) => match.id), ['wide-b']);
      const within = await registry.findSimilar('wide', new TextEncoder().encode(unit(2)), 3, 0.5, ['wide-a', 'wide-c']);
      assertEquals(within.map((match) => match.id), ['wide-c']);
      const read = await registry.getVectors('wide', ['wide-a']);
      assertEquals(JSON.parse(new TextDecoder().decode(read.get('wide-a')!))[0], 1);
    } finally {
      await registry.dispose();
      await ctx.teardown();
    }
  },
});
