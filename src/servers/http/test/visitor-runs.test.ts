/**
 * Visitors — the guest where it may browse, a share link's holders — run few lines at once,
 * all of them together, so their loops leave members the event loop; a line that signs in
 * waits for none, and closing a socket ends what it was running.
 */

import { assert, assertEquals } from '@std/assert';
import { type CommandResult, SystemTestHarness } from '../../../testing/mod.ts';

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
      // Each visitor's shell opens on its first line, before any loop holds the event loop
      for (const visitor of visitors) assertEquals((await visitor.exec('user-whoami')).success, true);
      for (const visitor of visitors.slice(0, 4)) visitor.exec('while :; do :; done', { timeout: 120_000 }).catch(() => {});

      // The loops hold every turn once a visitor's line still waits after a member's line and a
      // sign-in have run: one that runs before then found a loop that had not taken its turn yet.
      const began = Date.now();
      let waiting: Promise<CommandResult>;
      for (;;) {
        assert(Date.now() - began < 20_000, 'a visitor still finds a turn while four others loop');
        waiting = visitors[4].exec('echo turn', { timeout: 120_000 });
        if (await settlesWithin(waiting, 1000)) continue;
        assertEquals(await admin.execString('echo member'), 'member\n');
        const whoami = await visitors[5].exec('user-whoami');
        assertEquals(whoami.success, true, JSON.stringify(whoami));
        if (!await settlesWithin(waiting, 0)) break;
      }

      // Closing a looping visitor's socket ends its loop and gives its turn on, well before the
      // loops' own 60 s are up
      visitors[0].close();
      assertEquals(await settlesWithin(waiting, 25_000), true);
      assertEquals(String((await waiting).data), 'turn\n');
    });
  } finally {
    for (const visitor of visitors) visitor.close();
    await admin.exec('config unset CFG_GUEST_BROWSING');
    admin.close();
    await harness.stop();
  }
});
