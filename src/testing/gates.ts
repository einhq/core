/**
 * Test tier gates.
 *
 * PG-tier tests run only when EIN_TEST_PG holds a connection string
 * (e.g. postgres://ein:ein@localhost:5432/ein); container-tier
 * tests only when EIN_TEST_CONTAINER is set. Gated tests show up as
 * ignored in default runs.
 */

import { Pool } from 'pg';
import { ulid } from '@std/ulid/ulid';
import { SYSTEM_TIME_ZONE } from '../lib/datetime/mod.ts';

export const PG_URL = Deno.env.get('EIN_TEST_PG');
export const IN_CONTAINER = Boolean(Deno.env.get('EIN_TEST_CONTAINER'));

export type PgTestContext = {
  pool: Pool;
  /** unique lowercase prefix for table names, safe for identifiers */
  prefix: string;
  /** drop all tables created under the prefix and end the pool */
  teardown(): Promise<void>;
};

export function pgTestContext(): PgTestContext {
  // Same session TimeZone the running system pins (`src/primary-main.ts`), so the pg tier
  // exercises the configuration production has. Without it a birthtime aggregate would be
  // bucketed by the server default here and by SYSTEM_TIME_ZONE there, and the store
  // conformance suite would be comparing the memory store against the wrong pg behaviour.
  const pool = new Pool({ connectionString: PG_URL, options: `-c timezone=${SYSTEM_TIME_ZONE}` });
  const prefix = `t${ulid().toLowerCase()}`;

  return {
    pool,
    prefix,
    async teardown() {
      const client = await pool.connect();
      try {
        // A test that leaves a transaction open would otherwise make the DROP
        // wait for it forever, turning a failed test into a hung run.
        await client.query(`SET lock_timeout = '10s'`);

        const res = await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE $1`,
          [`${prefix}%`],
        );
        for (const row of res.rows) {
          await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
        }
      } finally {
        client.release();
        await pool.end();
      }
    },
  };
}

/** Deno.test wrapper that is ignored unless EIN_TEST_PG is set. */
export function pgTest(name: string, fn: (t: Deno.TestContext) => Promise<void>) {
  Deno.test({
    name,
    ignore: !PG_URL,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

/** Deno.test wrapper that is ignored unless EIN_TEST_CONTAINER is set. */
export function containerTest(name: string, fn: (t: Deno.TestContext) => Promise<void>) {
  Deno.test({
    name,
    ignore: !IN_CONTAINER,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}
