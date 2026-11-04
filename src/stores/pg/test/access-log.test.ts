/**
 * PG tier: the access log round-trips every field, reads back filtered and in either direction,
 * matches a path prefix literally, and is purged by age without touching the audit trail.
 * Gated by EIN_TEST_PG.
 */

import { assertEquals } from '@std/assert';
import { ulid } from '@std/ulid';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { RouterManager } from '../../../managers/router/mod.ts';
import { MemoryFileRegistry } from '../../../registries/file/mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';
import { type AccessRecord, LocalNodeVFS, recordAccess } from '../../../vfs/mod.ts';
import { PgStore } from '../index.ts';

pgTest('PgStore access log', async (t) => {
  const ctx = pgTestContext();
  const routerManager = new RouterManager();
  await routerManager.init();
  routerManager.release();

  const store = new PgStore({ pgPool: ctx.pool, name: ctx.prefix });
  const vfs = new LocalNodeVFS(store, routerManager, { file: new MemoryFileRegistry() });
  await vfs.initialize();

  try {
    await t.step('round-trips a record with every field, and leaves out what it lacks', async () => {
      await recordAccess(vfs, { event: 'sign-in-failed', reason: 'authentication failed', from: '192.0.2.7', via: 'ssh', method: 'password', sid: 'ssh-1' });
      await recordAccess(vfs, { event: 'download-archive', uid: 1003, sid: 'session-anna', from: '192.0.2.8', via: 'http', path: '/my_album/files', count: 3, linkId: 'abc' });

      const [archive, failed] = await vfs.accessLog(ADMIN_ACCESS, {});
      assertEquals(failed.uid, undefined);
      assertEquals([failed.event, failed.reason, failed.from, failed.via, failed.method, failed.sid], [
        'sign-in-failed',
        'authentication failed',
        '192.0.2.7',
        'ssh',
        'password',
        'ssh-1',
      ]);
      const { id: _, timestamp, ...rest } = archive;
      assertEquals(rest, { event: 'download-archive', uid: 1003, sid: 'session-anna', from: '192.0.2.8', via: 'http', path: '/my_album/files', count: 3, linkId: 'abc' });
      assertEquals(Math.abs(timestamp - Date.now()) < 60_000, true);
    });

    await t.step('filters by user, event, session, address, link and path, the prefix literally', async () => {
      await recordAccess(vfs, { event: 'download', uid: 1003, path: '/myXalbum/files/a.jpg' });

      assertEquals((await vfs.accessLog(ADMIN_ACCESS, { uid: 1003 })).length, 2);
      assertEquals((await vfs.accessLog(ADMIN_ACCESS, { events: ['download', 'sign-in-failed'] })).map((r) => r.event), ['download', 'sign-in-failed']);
      assertEquals((await vfs.accessLog(ADMIN_ACCESS, { sid: 'ssh-1' })).length, 1);
      assertEquals((await vfs.accessLog(ADMIN_ACCESS, { from: '192.0.2.8' })).length, 1);
      assertEquals((await vfs.accessLog(ADMIN_ACCESS, { linkId: 'abc' })).length, 1);
      // `_` is a LIKE wildcard; unescaped, /my_album would also match /myXalbum.
      assertEquals((await vfs.accessLog(ADMIN_ACCESS, { pathPrefix: '/my_album' })).map((r) => r.path), ['/my_album/files']);
      assertEquals((await vfs.accessLog(ADMIN_ACCESS, { pathPrefix: '/' })).length, 2);
    });

    await t.step('reads forward from an id, oldest first', async () => {
      const [, , oldest] = await vfs.accessLog(ADMIN_ACCESS, {});
      const forward = await vfs.accessLog(ADMIN_ACCESS, { after: oldest.id });
      assertEquals(forward.map((r) => r.event), ['download-archive', 'download']);
    });

    await t.step('a purge removes only what is older than asked', async () => {
      const old: AccessRecord = { id: ulid(Date.now() - 400 * 86_400_000), timestamp: Date.now() - 400 * 86_400_000, event: 'sign-in', uid: 1003 };
      await store.appendAccessLog([old]);

      assertEquals(await vfs.accessLogPurge(ADMIN_ACCESS, { before: Date.now() - 365 * 86_400_000 }), 1);
      assertEquals((await vfs.accessLog(ADMIN_ACCESS, {})).length, 3);
    });
  } finally {
    await vfs.dispose();
    await routerManager.dispose();
    await ctx.teardown();
  }
});
