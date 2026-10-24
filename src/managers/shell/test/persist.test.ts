/**
 * `Shell.persist()` runs in the `finally` of every run()/runAndCapture(), so it
 * is paid per command, and it skips a write that would change nothing but a
 * timestamp. These tests pin that state changes are still written and only
 * redundant writes are skipped.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { Shell } from '../shell.ts';
import type { NodeEvent } from '../../../vfs/types.ts';

Deno.test({
  name: 'Shell.persist skips writes that would change nothing',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const { vfs, cem, bufferManager } = await harness.startPrimary();

    const { sessionPath } = await harness.createHttpSession();
    const shell = new Shell({ vfs, cem, bufferManager, sessionPath });
    await shell.open();

    // Count updates to this shell's tty node specifically — other shells and
    // the boot's own traffic must not be able to affect the assertions.
    const ttyPath = `${sessionPath}/${shell.name}`;
    let updates = 0;
    const sub = await vfs.subscribe!(() => ADMIN_ACCESS, (event: NodeEvent) => {
      if (event.type === 'updated' && event.path === ttyPath) updates++;
    });

    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    try {
      await t.step('repeated no-op commands write the tty node at most once', async () => {
        // The first may legitimately write: nothing has been persisted yet, so
        // the fingerprint is unset.
        await shell.run('true');
        await settle();
        updates = 0;

        for (let i = 0; i < 10; i++) await shell.run('true');
        await settle();

        assertEquals(updates, 0, 'ten commands that change no shell state must not write ten times');
      });

      await t.step('a cwd change is still persisted', async () => {
        updates = 0;
        await shell.run('cd /etc');
        await settle();

        assert(updates >= 1, 'cd must reach the tty node — cwd is part of the fingerprint');

        const node = await vfs.get(ADMIN_ACCESS, ttyPath);
        assertEquals((node.attrs as { cwd?: string }).cwd, '/etc');
      });

      await t.step('an env change is still persisted', async () => {
        updates = 0;
        await shell.run('export MRX_PERSIST_TEST=1');
        await settle();

        assert(updates >= 1, 'export must reach the tty node');

        const node = await vfs.get(ADMIN_ACCESS, ttyPath);
        const env = (node.attrs as { env?: Record<string, string> }).env ?? {};
        assertEquals(env.MRX_PERSIST_TEST, '1');
      });

      await t.step('going back to a previously seen state still writes', async () => {
        // The fingerprint is compared against the last write, not against a set
        // of everything ever seen, so returning to an earlier cwd must persist.
        await shell.run('cd /');
        await settle();
        updates = 0;

        await shell.run('cd /etc');
        await settle();

        assert(updates >= 1, 'returning to an earlier cwd must still be written');
        const node = await vfs.get(ADMIN_ACCESS, ttyPath);
        assertEquals((node.attrs as { cwd?: string }).cwd, '/etc');
      });
    } finally {
      await sub.unsubscribe();
      await shell.close();
      await harness.stop();
    }
  },
});

Deno.test({
  name: 'Shell.open writes the tty node once, with the sourced environment in it',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const { vfs, cem, bufferManager } = await harness.startPrimary();

    const { sessionPath } = await harness.createHttpSession();
    const shell = new Shell({ vfs, cem, bufferManager, sessionPath });

    // /etc/bashrc rewrites most of the environment, and the node is created
    // once with the result rather than created and then updated. Watch the
    // whole session subtree from before open(), so the create and any update
    // both count.
    const ttyPath = `${sessionPath}/${shell.name}`;
    const writes: string[] = [];
    const sub = await vfs.subscribe!(() => ADMIN_ACCESS, (event: NodeEvent) => {
      if (event.path === ttyPath && (event.type === 'created' || event.type === 'updated')) {
        writes.push(event.type);
      }
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    try {
      await shell.open();
      await settle();
      assertEquals(writes, ['created'], 'open() must create the tty node and not update it afterwards');

      // The environment the node carries is the one after /etc/bashrc.
      const node = await vfs.get(ADMIN_ACCESS, ttyPath);
      const env = (node.attrs as { env?: Record<string, string> }).env ?? {};
      assertEquals(env.ETC_PATH, '/etc', 'the tty node must carry the environment /etc/bashrc exported');
      assertEquals(env, shell.getEnv(), 'the tty node must carry exactly the environment the shell has');

      // And the first command finds nothing to persist.
      await shell.run('true');
      await settle();
      assertEquals(writes, ['created'], 'the first command must not write the tty node again');
    } finally {
      await sub.unsubscribe();
      await shell.close();
      await harness.stop();
    }
  },
});
