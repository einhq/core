/**
 * PG tier: position conformance against PostgreSQL/PostGIS.
 * Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { PG_URL, pgTestContext } from '../../../testing/gates.ts';
import { PositionRegistry } from '../mod.ts';
import { positionConformanceTests } from './position-conformance.ts';

positionConformanceTests('PositionRegistry (PostGIS) conformance', async () => {
  const ctx = pgTestContext();
  const registry = new PositionRegistry({ name: ctx.prefix, pool: ctx.pool });
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
      await ctx.teardown();
    },
  };
}, { ignore: !PG_URL, sanitize: false });

Deno.test({ name: 'PositionRegistry gains owner_types on a table made without it', ignore: !PG_URL, sanitizeResources: false, sanitizeOps: false }, async () => {
  const ctx = pgTestContext();
  const table = `${ctx.prefix}_positions`;
  await ctx.pool.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
  await ctx.pool.query(`
    CREATE TABLE ${table} (
      id VARCHAR(26) PRIMARY KEY, geog GEOGRAPHY(POINT, 4326), radius DOUBLE PRECISION NOT NULL DEFAULT 0,
      polygon GEOGRAPHY(POLYGON, 4326), size_bytes INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await ctx.pool.query(`INSERT INTO ${table} (id, geog) VALUES ('old', ST_Point(11.97, 57.7)::geography)`);

  const registry = new PositionRegistry({ name: ctx.prefix, pool: ctx.pool });
  try {
    await registry.init();
    assertEquals(await registry.unowned(10), ['old']);
    assertEquals(await registry.findNearby(57.7, 11.97, 10, 10, { ownerTypes: ['location'] }), []);

    await registry.setOwners(new Map([['old', ['location']]]));
    assertEquals(await registry.unowned(10), []);
    assertEquals((await registry.findNearby(57.7, 11.97, 10, 10, { ownerTypes: ['location'] })).map((m) => m.id), ['old']);
  } finally {
    await registry.dispose();
    await ctx.teardown();
  }
});
