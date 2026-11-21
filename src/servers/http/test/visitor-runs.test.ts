/**
 * Visitors — the guest where it may browse, a share link's holders — run few lines at once,
 * all of them together, so their loops leave members the event loop; a line that signs in
 * waits for none, and closing a socket ends what it was running.
 */

import { assert, assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ boot: true, ssh: false });

/** Whether `promise` settles within `ms`. */
const settlesWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  await Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

Deno.test({
  name: 'visitor runs',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await harness.start();
  const admin = await harness.createShellClient();
  assertEquals((await admin.exec('config set CFG_GUEST_BROWSING true')).success, true);
  const visitors = await Promise.all(Array.from({ length: 6 }, () => harness.createShellClient({ login: false })));

  try {
    await t.step('four loops take every turn; the next waits, a member and a sign-in do not', async () => {
      for (const visitor of visitors.slice(0, 4)) visitor.exec('while :; do :; done', { timeout: 120_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));

      const waiting = visitors[4].exec('echo turn', { timeout: 120_000 });
      assertEquals(await settlesWithin(waiting, 1000), false);

      const started = Date.now();
      assertEquals(await admin.execString('echo member'), 'member\n');
      const whoami = await visitors[5].exec('user-whoami');
      assertEquals(whoami.success, true, JSON.stringify(whoami));
      assert(Date.now() - started < 3000, `${Date.now() - started} ms`);

      // Closing a looping visitor's socket ends its loop and gives its turn on
      visitors[0].close();
      assertEquals(await settlesWithin(waiting, 5000), true);
      assertEquals(String((await waiting).data), 'turn\n');
    });
  } finally {
    for (const visitor of visitors) visitor.close();
    await admin.exec('config unset CFG_GUEST_BROWSING');
    admin.close();
    await harness.stop();
  }
});
