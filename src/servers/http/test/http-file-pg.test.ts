import { assertEquals } from '@std/assert';
import { PgBlobRegistry } from '../../../registries/blob/mod.ts';
import type { ResourceHandleIf } from '../../../registries/types.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { handleGetFile } from '../handlers/get-file.ts';
import type { HttpServerConfig } from '../types.ts';

pgTest('HTTP database-backed downloads return every transaction to the pool', async () => {
  const ctx = pgTestContext();
  const registry = new PgBlobRegistry({ pool: ctx.pool, prefix: ctx.prefix });
  const opened: ResourceHandleIf[] = [];
  try {
    await registry.init();
    const writer = await registry.open('asset', {}, 'w');
    try {
      await writer.write(new TextEncoder().encode('0123456789'));
    } finally {
      await writer.close();
    }
    // Keep the real PostgreSQL storage path; a minimal VFS/session facade
    // isolates HTTP body ownership from unrelated harness boot services. The
    // requests are the site's own (`site`): what this measures is the pool, not
    // who may read, and the facade holds no settings to ask.
    const config = {
      env: { COOKIE_NAME: 'session' },
      vfs: {
        resolvePath: (_access: unknown, path: string) => Promise.resolve(path),
        get: () => Promise.resolve({ type: 'file', attrs: { size: 10, mimetype: 'text/plain' } }),
        open: async () => {
          const handle = await registry.open('asset', {}, 'r');
          opened.push(handle);
          return handle;
        },
      },
    } as unknown as HttpServerConfig;
    for (let i = 0; i < 50; i++) {
      const range = i % 2 === 1;
      const req = new Request('http://localhost/file/asset', { headers: range ? { range: 'bytes=3-5' } : {} });
      const res = await handleGetFile(config, req, new URL(req.url), { site: true });
      if (i % 5 === 0) await res.body!.cancel();
      else assertEquals(await res.text(), range ? '345' : '0123456789');
      assertEquals(ctx.pool.idleCount, ctx.pool.totalCount, `request ${i} retained a pooled connection`);
      assertEquals(opened.at(-1)!.closed, true);
    }
  } finally {
    // Teardown must not hang behind a leaked transaction, should the
    // assertion above find one.
    await Promise.all(opened.map((handle) => handle.close()));
    await registry.dispose();
    await ctx.teardown();
  }
});
