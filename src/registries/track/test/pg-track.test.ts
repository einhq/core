/**
 * PG tier: track conformance against PostgreSQL/PostGIS.
 * Gated by EIN_TEST_PG.
 */

import { RouterManager } from '../../../managers/router/mod.ts';
import { PG_URL, pgTestContext } from '../../../testing/gates.ts';
import { TrackRegistry } from '../mod.ts';
import { trackConformanceTests } from './track-conformance.ts';

trackConformanceTests('TrackRegistry (PostGIS) conformance', async () => {
  const router = new RouterManager();
  await router.init();
  router.release();

  const ctx = pgTestContext();
  const registry = new TrackRegistry({ name: ctx.prefix, pool: ctx.pool, router });
  await registry.init();

  return {
    registry,
    router,
    teardown: async () => {
      await registry.dispose();
      await router.dispose();
      await ctx.teardown();
    },
  };
}, { ignore: !PG_URL, sanitize: false });
