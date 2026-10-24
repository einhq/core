/**
 * Admission bounds an instance whose work is *delegated*, not just one whose
 * step the engine runs itself.
 *
 * `dispatchStep` is what populates `inFlight`, and a `pool:` step never goes
 * through it: it is marked `waiting` and handed to `/pools/*`. So an instance
 * whose steps are all pooled would be admitted without being counted at all,
 * and the engine would keep claiming triggers while holding an unbounded
 * number of them open. The gate therefore also counts `advanceLocks`, one entry
 * per instance the engine holds open.
 *
 * The limit it counts against is `CFG_PIPELINE_MAX_OPEN_INSTANCES`, not
 * `CFG_PIPELINE_MAX_ADMITTED_STEPS`: a parked promise holding a command and a
 * Map entry differ in cost by orders of magnitude. This test therefore sets the
 * instance limit; setting the step limit alone would not bound anything here.
 *
 * No worker is started here on purpose: the pool jobs stay `ready`, so every
 * admitted instance stays open and the cap is what has to stop the rest.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { PoolJob } from '../../../registries/pool/mod.ts';

const TEST_MIME = 'application/x-admission-pool';
/** The open-instance ceiling under test — every instance here is pool-delegated. */
const MAX_ADMITTED = 6;

/**
 * The dispatched-step ceiling, set far below the instance one on purpose.
 *
 * The gap is what makes this test able to fail: an engine that charged instances against the
 * step limit would stop at one or two instances and the wait for six would time out. A gap of
 * one would be satisfied by the in-flight overshoot and prove nothing.
 */
const MAX_STEPS = 1;

/** Pinned so the overshoot from claims already in flight is exact. */
const TRIGGER_CONCURRENCY = 1;

const harness = new SystemTestHarness({
  ssh: false,
  boot: true,
  env: {
    CFG_PIPELINE_MAX_OPEN_INSTANCES: String(MAX_ADMITTED),
    // Deliberately *below* the instance ceiling. Nothing here is ever dispatched — the only
    // step is pooled — so this must not bound anything, and the instance count settling at
    // MAX_ADMITTED rather than at this is what proves the two limits are separate.
    CFG_PIPELINE_MAX_ADMITTED_STEPS: String(MAX_STEPS),
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
  name: 'engine admission control bounds pooled instances',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  // Constructor-read, so it must be set before the harness boots the engine
  // service and cleared in the finally (see admission.test.ts).
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

  const instances = async (): Promise<string[]> => {
    const res = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/test-admit-pool`);
    return res.success ? res.data as string[] : [];
  };

  const stepStatus = async (id: string): Promise<string> =>
    (await client.execJson<{ status: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/test-admit-pool/${id}/steps/heavy`)).status;

  try {
    await client.exec('mkdir -p /work');
    await client.exec('mkfile /work/test-admit-pool.yaml');
    await writeFile(
      '/work/test-admit-pool.yaml',
      [
        'name: test-admit-pool',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: ${TEST_MIME}`,
        'steps:',
        '  heavy:',
        // Never runs: nothing claims this pool for the length of the test.
        '    command: pool-never $NODE_PATH',
        '    pool: admitpool',
        '    kind: heavy',
      ].join('\n'),
    );
    assertEquals((await client.exec('pipeline define /work/test-admit-pool.yaml')).success, true);

    await t.step('delegated work counts against the cap', async () => {
      for (let i = 0; i < 10; i++) {
        await client.exec(`mknode -t file --as "name=b${i}.bin" --as "mimetype=${TEST_MIME}" /work/b${i}.bin`);
        await client.exec(`chmod 644 /work/b${i}.bin`);
      }

      await waitFor(async () => (await instances()).length >= MAX_ADMITTED, 'the cap to be reached');

      // Long enough that the trigger loop would have drained the rest.
      await new Promise((r) => setTimeout(r, 3000));

      const ceiling = MAX_ADMITTED + TRIGGER_CONCURRENCY;
      const admitted = await instances();
      assertEquals(
        admitted.length <= ceiling,
        true,
        `admitted ${admitted.length} instances with a cap of ${MAX_ADMITTED} (+${TRIGGER_CONCURRENCY} in-flight claims)`,
      );

      // Nothing is in `inFlight` holding the gate: every admitted instance is
      // waiting on the pool.
      for (const id of admitted) assertEquals(await stepStatus(id), 'waiting');

      // The rest is still owed, durably, as trigger rows.
      const live = (await triggerJobs()).filter((job) => job.state === 'ready' || job.state === 'claimed');
      assertEquals(live.length > 0, true, 'the remaining subjects must be waiting in the pool');
    });
  } finally {
    await harness.stop();
  }
});
