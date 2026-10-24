/**
 * A finished command leaves nothing behind: its `running` CmdState is dropped, and the `exited`
 * copy kept for `wait` does not hold `opts`, which reaches the exec context, its env and its
 * streams.
 */

import { assertEquals } from '@std/assert';
import { createTestContext } from '../../../testing/mod.ts';

// No boot: the count below is of every running state in the manager, and a
// booted instance's services are mid-pass (`session-reap`, `pipeline prune`,
// `ls /pools`) or asleep depending on when they are looked at, so two looks
// could differ without a leak. The commands under test do not need the services.
const testCtx = createTestContext();

Deno.test({
  name: 'command state lifecycle',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const ctx = await testCtx.setup();
  const cem = ctx.cem;
  const client = await testCtx.server.createShellClient();

  const runningStates = () => cem.states().filter((s) => s.state === 'running');

  // `ls`, not `echo`: echo is a shell builtin and never reaches the
  // ExecManager, so a test written against it would pass with a leak.
  const REAL_COMMAND = 'ls /';

  try {
    await t.step('a finished command leaves no running state', async () => {
      const before = runningStates().length;

      await client.exec(REAL_COMMAND);

      assertEquals(
        runningStates().length,
        before,
        'the running entry must be dropped when the command finishes',
      );
    });

    await t.step('fifty commands leave fifty nothings', async () => {
      const before = runningStates().length;

      for (let i = 0; i < 50; i++) {
        await client.exec(REAL_COMMAND);
      }

      const after = runningStates().length;
      assertEquals(
        after,
        before,
        `50 executions added ${after - before} permanent running states`,
      );
    });

    // The retained copy is what `wait` answers from for a minute after exit. It
    // needs the exit code and the timing, not `opts`.
    await t.step('an exited state keeps its exit code but not its opts', async () => {
      await client.exec(REAL_COMMAND);

      const exited = cem.states().filter((s) => s.state === 'exited' && s.name === 'ls');
      assertEquals(exited.length > 0, true, 'the exited state must be retained for `wait`');

      for (const state of exited) {
        assertEquals(state.opts, undefined, 'a finished command must not hold its exec context');
        assertEquals(typeof state.exitCode, 'number');
        assertEquals(typeof state.exitTime, 'number');
      }
    });

    await t.step('a command that exits non-zero cleans up too', async () => {
      const before = runningStates().length;

      await client.exec('ls /no-such-path-here');

      assertEquals(runningStates().length, before);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
