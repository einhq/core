/**
 * PG tier: position conformance against PostgreSQL/PostGIS.
 * Gated by EIN_TEST_PG.
 */

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
