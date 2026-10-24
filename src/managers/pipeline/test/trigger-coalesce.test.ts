/**
 * `options.coalesce: rerun` and `options.debounceMs` — the aggregate-subject shape.
 *
 * A per-file pipeline drops a trigger that meets its own live instance, because
 * that trigger is the tail of its own writes. A pipeline whose subject is an
 * aggregate (an album, announced once per member) must do the opposite: a
 * trigger during the run is a change the run cannot have seen, so it is folded
 * into the live instance and the subject is announced once more when it ends.
 * The debounce is what turns a burst before the first run into one run.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { PoolJob } from '../../../registries/pool/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const EVENT = 'test.aggregate.changed';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'trigger coalescing by rerun',
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

  const runs = async (): Promise<number> => {
    const result = await client.exec('cat /tmp/markers/runs');
    return result.success ? String(result.data).trim().split('\n').filter(Boolean).length : 0;
  };

  const instanceStatus = async (nodeId: string): Promise<string | undefined> => {
    try {
      return (await vfs.get(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/test-aggregate/${nodeId}`)).attrs.status as string;
    } catch {
      return undefined;
    }
  };

  const announce = async (subject: string, label: string): Promise<void> => {
    const event = { id: `01J${label}`, type: EVENT, subject, time: Date.now(), source: 'coalesce-test', data: { label } };
    await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`);
  };

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /tmp/markers && mkdir -p /work');
    // Each run appends one line and then holds long enough for triggers to
    // arrive while it is live.
    await client.exec('mkfile /opt/steps/agg-step && chmod 755 /opt/steps/agg-step');
    await writeFile('/opt/steps/agg-step', 'echo "$1" >> /tmp/markers/runs\nsleep 2');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    const yaml = [
      'name: test-aggregate',
      'trigger:',
      `  on: ${EVENT}`,
      'steps:',
      '  work:',
      '    command: agg-step $NODE_PATH',
      'options:',
      '  coalesce: rerun',
      '  debounceMs: 1000',
    ].join('\n');
    await client.exec('mkfile /work/test-aggregate.yaml');
    await writeFile('/work/test-aggregate.yaml', yaml);
    assertEquals((await client.exec('pipeline define /work/test-aggregate.yaml')).success, true);

    await client.exec('mkdir -p /work/album');
    const nodeId = (await vfs.get(ADMIN_ACCESS, '/work/album')).id;

    await t.step('a burst before the first run is one held job and one run', async () => {
      for (let i = 0; i < 5; i++) await announce('/work/album', `B${i}`);

      // Held: the job exists but is not claimable until the debounce elapses.
      await waitFor(async () => (await triggerJobs()).some((job) => job.dedupKey === `test-aggregate/${nodeId}`), 'trigger job');
      const job = (await triggerJobs()).find((job) => job.dedupKey === `test-aggregate/${nodeId}`)!;
      assertEquals(job.state, 'ready');
      assertEquals(job.availableAt.getTime() > Date.now() + 200, true, 'job is held by the debounce');
      assertEquals(await instanceStatus(nodeId), undefined, 'no instance before the hold elapses');

      await waitFor(async () => (await runs()) === 1, 'the first run');
      await waitFor(async () => (await instanceStatus(nodeId)) === 'completed', 'first instance completion');
      assertEquals(await runs(), 1, 'five announcements, one run');
    });

    await t.step('a trigger during a live run folds in and runs once more after it', async () => {
      await announce('/work/album', 'C0');
      await waitFor(async () => (await runs()) === 2, 'the second run');
      await waitFor(async () => (await instanceStatus(nodeId)) === 'running', 'second instance live');

      // Three arrivals while the instance is live: folded, not dropped, not queued.
      for (let i = 1; i <= 3; i++) await announce('/work/album', `C${i}`);
      await waitFor(async () => {
        const attrs = (await vfs.get(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/test-aggregate/${nodeId}`)).attrs;
        return attrs.rerun !== undefined;
      }, 'the fold to be recorded on the live instance');
      assertEquals(await runs(), 2, 'still the second run while it is live');

      // One further run — the folded arrivals, not one run each.
      await waitFor(async () => (await runs()) === 3, 'the rerun', 30000);
      await waitFor(async () => (await instanceStatus(nodeId)) === 'completed', 'rerun completion', 30000);
      await new Promise((r) => setTimeout(r, 2500));
      assertEquals(await runs(), 3, 'three folded arrivals are one rerun');
    });

    await t.step('a trigger right after completion starts a fresh run — there is no grace window', async () => {
      await announce('/work/album', 'D0');
      await waitFor(async () => (await runs()) === 4, 'a run after completion', 30000);
      await waitFor(async () => (await instanceStatus(nodeId)) === 'completed', 'fourth instance completion', 30000);
    });
  } finally {
    await harness.stop();
  }
});
