/**
 * `runAndCapture`'s `signal`: the caller hanging up stops the running command, as its deadline
 * does, and stops a loop between passes rather than only the command inside it. And its
 * `onOutput`: the caller hears of output while the command still runs.
 */

import { assert, assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { Shell } from '../shell.ts';

Deno.test({
  name: 'a hung-up capture stops its command',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const { vfs, cem, bufferManager } = await harness.startPrimary();
    const { sessionPath } = await harness.createHttpSession();
    const shell = new Shell({ vfs, cem, bufferManager, sessionPath });
    await shell.open();

    try {
      await t.step('a sleeping command returns when the signal aborts', async () => {
        const hangUp = new AbortController();
        const started = Date.now();
        const capture = shell.runAndCapture('sleep 60', undefined, { signal: hangUp.signal });

        setTimeout(() => hangUp.abort(), 200);
        await capture;

        assert(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
      });

      await t.step('a loop ends at the hang-up instead of starting its next pass', async () => {
        const hangUp = new AbortController();
        const capture = shell.runAndCapture('while true; do echo pass; sleep 60; done', undefined, { signal: hangUp.signal });

        setTimeout(() => hangUp.abort(), 200);
        const { stdout } = await capture;

        assertEquals(stdout.trim().split('\n'), ['pass']);
      });

      await t.step('an already-aborted signal runs nothing to completion', async () => {
        const hangUp = new AbortController();
        hangUp.abort();
        const started = Date.now();

        await shell.runAndCapture('sleep 60', undefined, { signal: hangUp.signal });

        assert(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
      });

      await t.step('onOutput hears of output while the command runs', async () => {
        const heard: number[] = [];
        const started = Date.now();
        await shell.runAndCapture('echo one; sleep 1; echo two >&2', undefined, { onOutput: () => heard.push(Date.now() - started) });

        assert(heard.length >= 2, `heard ${heard.length} chunks`);
        assert(heard[0] < 900, `first output heard after ${heard[0]}ms, not as it was written`);
      });
    } finally {
      await shell.close();
      await harness.stop();
    }
  },
});
