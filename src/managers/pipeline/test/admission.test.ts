/**
 * The engine admits a bounded amount of work.
 *
 * A dispatched step is tracked in `inFlight` and *then* parks on the
 * concurrency semaphore — so every ready step of every live instance is a live
 * promise holding its command and paths, and a fast trigger pool can exhaust
 * the heap with them.
 *
 * So the invariant here is not "it goes fast", it is that the engine refuses to
 * admit more than `PIPELINE_MAX_ADMITTED_STEPS` at a time and leaves the rest in
 * the pool, where a backlog costs a row instead of a parked promise.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { PoolJob } from '../../../registries/pool/mod.ts';

const TEST_MIME = 'application/x-admission';
const MAX_ADMITTED = 2;

/**
 * Claims already in flight when the gate closes still land, so admission
 * overshoots by up to `triggerConcurrency` instances. Pinned to 1 here to make
 * the bound exact rather than dependent on the default.
 */
const TRIGGER_CONCURRENCY = 1;

const harness = new SystemTestHarness({
  ssh: false,
  boot: true,
  // Reaches the engine service through the boot shell's environment, not
  // Deno.env, which the parallel fast tier would apply to every other harness.
  env: {
    CFG_PIPELINE_MAX_ADMITTED_STEPS: String(MAX_ADMITTED),
    CFG_PIPELINE_TRIGGER_CONCURRENCY: String(TRIGGER_CONCURRENCY),
  },
});

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'engine admission control',
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

  const triggerJobs = (): Promise<PoolJob[]> => vfs.poolJobs(ADMIN_ACCESS, `${POOLS_PATH}/triggers`);

  const runningInstances = async (): Promise<number> => {
    const res = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/test-admit`);
    return res.success ? (res.data as string[]).length : 0;
  };

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /work');

    // A step that blocks, so admitted work stays admitted for the whole test.
    await client.exec('mkfile /opt/steps/admit-slow && chmod 755 /opt/steps/admit-slow');
    await writeFile('/opt/steps/admit-slow', 'sleep 30');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    await client.exec('mkfile /work/test-admit.yaml');
    await writeFile(
      '/work/test-admit.yaml',
      [
        'name: test-admit',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: ${TEST_MIME}`,
        'steps:',
        '  slow:',
        '    command: admit-slow',
      ].join('\n'),
    );
    assertEquals((await client.exec('pipeline define /work/test-admit.yaml')).success, true);

    await t.step('work past the cap waits in the pool, not in the engine', async () => {
      // Ten subjects, each of which would dispatch a step that never returns.
      for (let i = 0; i < 10; i++) {
        await client.exec(`mknode -t file --as "name=a${i}.bin" --as "mimetype=${TEST_MIME}" /work/a${i}.bin`);
        await client.exec(`chmod 644 /work/a${i}.bin`);
      }

      // The cap is reached...
      await waitFor(async () => (await runningInstances()) >= MAX_ADMITTED, 'the cap to be reached');

      // ...and stays reached. Without the gate every one of the ten becomes a
      // running instance with a parked step, which is the shape that OOM'd.
      await new Promise((r) => setTimeout(r, 3000));

      const ceiling = MAX_ADMITTED + TRIGGER_CONCURRENCY;
      const running = await runningInstances();
      assertEquals(
        running <= ceiling,
        true,
        `admitted ${running} instances with a cap of ${MAX_ADMITTED} (+${TRIGGER_CONCURRENCY} in-flight claims)`,
      );

      // The rest is still owed, and owed durably — as pool rows.
      const live = (await triggerJobs()).filter((job) => job.state === 'ready' || job.state === 'claimed');
      assertEquals(live.length > 0, true, 'the remaining subjects must be waiting in the pool');
    });
  } finally {
    await harness.stop();
  }
});
