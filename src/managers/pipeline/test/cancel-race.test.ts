/**
 * A cancel that lands inside an advance does not leave a live step under a
 * cancelled instance (ein/core#483).
 *
 * `pipeline cancel` does not take the engine's per-instance lock. An advance
 * that has already read a step `pending` goes on to write it `waiting` (pooled)
 * or `queued` (inline) — after the cancel has skipped it — and nothing would
 * ever finish it.
 *
 * The step's own condition is the cancel: it runs after the advance has read
 * the step and before it writes it, which is exactly the losing interleaving,
 * every time.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../types.ts';

const POOL = `${POOLS_PATH}/racepool`;

const harness = new SystemTestHarness({ ssh: false, boot: true });

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if (await predicate()) return;
    } catch { /* not there yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'a cancel racing an advance leaves no live step',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: string): Promise<void> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body + '\n'));
    } finally {
      await handle.close();
    }
  };

  /** Define a pipeline whose one step cancels its own instance from its condition. */
  const define = async (name: string, pooled: boolean): Promise<void> => {
    await client.exec(`mkfile /work/${name}.yaml`);
    await writeFile(
      `/work/${name}.yaml`,
      [
        `name: ${name}`,
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: application/x-${name}`,
        'steps:',
        '  work:',
        '    command: race-never $NODE_PATH',
        `    condition: pipeline cancel ${name}/$(cat /tmp/race/${name}); exit 0`,
        ...(pooled ? ['    pool: racepool'] : []),
      ].join('\n'),
    );
    assertEquals((await client.exec(`pipeline define /work/${name}.yaml`)).success, true);
  };

  /** Trigger the pipeline and return its instance once the cancel has gone through. */
  const run = async (name: string): Promise<string> => {
    await client.exec(`mknode -t file --as "name=${name}.bin" --as "mimetype=application/x-${name}" /work/${name}.bin`);
    const id = (await vfs.get(ADMIN_ACCESS, `/work/${name}.bin`)).id;
    await client.exec(`echo ${id} > /tmp/race/${name}`);
    await client.exec(`chmod 644 /work/${name}.bin`);

    const instancePath = join(PIPELINE_INSTANCES_PATH, name, id);
    await waitFor(
      async () => (await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs.status === 'cancelled',
      'the instance to be cancelled',
    );
    // Let the advance that lost the race finish its write.
    await new Promise((r) => setTimeout(r, 500));
    return instancePath;
  };

  try {
    await client.exec('mkdir -p /work && mkdir -p /tmp/race');

    await t.step('a pooled step is not left waiting', async () => {
      await define('race-pooled', true);
      const instancePath = await run('race-pooled');
      const stepPath = join(instancePath, 'steps', 'work');

      assertEquals((await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, stepPath)).attrs.status, 'skipped');
      assertEquals((await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs.status, 'cancelled');
      const jobs = await vfs.poolJobs(ADMIN_ACCESS, POOL, { state: ['ready', 'claimed'], dedupKey: stepPath });
      assertEquals(jobs.length, 0);
    });

    await t.step('an inline step is not left queued', async () => {
      await define('race-inline', false);
      const instancePath = await run('race-inline');

      assertEquals((await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, join(instancePath, 'steps', 'work'))).attrs.status, 'skipped');
      assertEquals((await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, instancePath)).attrs.status, 'cancelled');
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
