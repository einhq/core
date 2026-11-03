/**
 * PG tier: track conformance against PostgreSQL/PostGIS.
 * Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
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

Deno.test({
  name: 'TrackRegistry (PostGIS): a track judged by older rules is judged again on its first read',
  ignore: !PG_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const router = new RouterManager();
    await router.init();
    router.release();

    const ctx = pgTestContext();
    const base = Date.parse('2015-07-04T10:00:00.000Z');
    // Steady going, three fixes two degrees north, and back.
    const points = Array.from({ length: 23 }, (_, i) => ({
      lat: 57.7 + (i >= 10 && i < 13 ? 2 : 0),
      lng: 11.97 + i * 0.0001,
      ts: new Date(base + i * 1000).toISOString(),
    }));

    try {
      const stored = new TrackRegistry({ name: ctx.prefix, pool: ctx.pool, router });
      await stored.init();
      await stored.touch('old', {});
      await stored.appendPoints('old', points);
      // A person's verdict, which judging again leaves as it is.
      await stored.markPoints('old', { from: points[10].ts, to: points[11].ts }, 'accept');
      await stored.dispose();

      // As a track stored before the rules, or judged by an older version of them, is.
      await ctx.pool.query(`UPDATE ${ctx.prefix}_tracks_points SET rule = NULL`);
      await ctx.pool.query(`UPDATE ${ctx.prefix}_tracks SET rules = 0, points = 23`);

      const registry = new TrackRegistry({ name: ctx.prefix, pool: ctx.pool, router });
      await registry.init();
      try {
        assertEquals((await registry.readPoints('old')).points, 21);
        assertEquals((await registry.summary('old')).points, 21);
      } finally {
        await registry.dispose();
      }
    } finally {
      await router.dispose();
      await ctx.teardown();
    }
  },
});
