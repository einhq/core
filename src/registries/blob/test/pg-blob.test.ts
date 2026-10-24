/**
 * PG tier: blob conformance against PostgreSQL large objects. Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { binaryConformanceTests } from '../../test/binary-conformance.ts';
import { PG_URL, pgTestContext } from '../../../testing/gates.ts';
import { PgBlobRegistry } from '../mod.ts';

binaryConformanceTests('PgBlobRegistry conformance', async () => {
  const ctx = pgTestContext();
  const registry = new PgBlobRegistry({ prefix: ctx.prefix, pool: ctx.pool });
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
  name: 'PgBlobHandle holds no connection between calls',
  ignore: !PG_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const ctx = pgTestContext();
    const registry = new PgBlobRegistry({ prefix: ctx.prefix, pool: ctx.pool });
    try {
      await registry.init();
      const enc = new TextEncoder();
      const handles = await Promise.all(
        ['a', 'b', 'c'].map((id) => registry.open(id, {}, 'w+')),
      );
      for (const h of handles) await h.write(enc.encode(`content ${h.id}`));
      assertEquals(ctx.pool.totalCount, ctx.pool.idleCount);

      // A write is visible to another reader before the writing handle closes
      const r = await registry.open('b', {}, 'r');
      assertEquals(new TextDecoder().decode(await r.read(100)), 'content b');
      await r.close();

      for (const h of handles) await h.close();
    } finally {
      await ctx.teardown();
    }
  },
});
