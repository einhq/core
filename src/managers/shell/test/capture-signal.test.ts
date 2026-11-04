/**
 * `runAndCapture`'s `signal`: the caller hanging up stops the running command, as its deadline
 * does, and stops a loop between passes rather than only the command inside it. And its
 * `onOutput`: the caller hears of output while the command still runs; and `onProgress`: it hears
 * what a command anywhere in the script says of how much it has done.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { Shell } from '../shell.ts';

/** A module command that says it is halfway, then more than done. */
const HALFWAY = '/usr/modules/progress-demo/bin/halfway';

Deno.test({
  name: 'a hung-up capture stops its command',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const harness = new SystemTestHarness({ boot: true, ssh: false });
    const { vfs, cem, bufferManager } = await harness.start();
    const { sessionPath } = await harness.createHttpSession();
    const shell = new Shell({ vfs, cem, bufferManager, sessionPath });
    await shell.open();

    const write = async (path: string, body: string) => {
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop()!;
      let dir = '';
      for (const part of parts) {
        await vfs.ensure(ADMIN_ACCESS, 'directory', dir || '/', part, { props: { mode: 0o755 } });
        dir = `${dir}/${part}`;
      }
      await vfs.ensure(ADMIN_ACCESS, 'file', dir, name, { props: { mode: 0o755 }, attrs: { name, mimetype: 'text/plain' } });
      const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(body));
      } finally {
        await handle.close();
      }
    };

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

      await t.step("onProgress hears a command's progress, in a nested script too", async () => {
        await write('/usr/modules/progress-demo/mod.json', JSON.stringify({ name: 'progress-demo', version: '0.1.0' }));
        await write(
          HALFWAY,
          "#!ts\nexport default Object.assign(async (cmd) => { cmd.progress(0.5); cmd.progress(2); return 0; }, { spec: { name: 'halfway', description: 'halfway', effect: 'read' } });\n",
        );
        const heard: number[] = [];
        const { code, stderr } = await shell.runAndCapture(`${HALFWAY}; (${HALFWAY})`, undefined, { onProgress: (fraction) => heard.push(fraction) });

        assertEquals(code, 0, stderr);
        assertEquals(heard, [0.5, 1, 0.5, 1]);
      });

      await t.step('a script given no onProgress runs a command that reports progress', async () => {
        const { code, stderr } = await shell.runAndCapture(HALFWAY);
        assertEquals(code, 0, stderr);
      });
    } finally {
      await shell.close();
      await harness.stop();
    }
  },
});
