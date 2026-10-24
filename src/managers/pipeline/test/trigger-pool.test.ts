/**
 * A matched trigger becomes a pool job, and a re-announced subject is free.
 *
 * The in-flight guard (see trigger-guard.test.ts) only suppresses while an
 * instance is *running*; announcements that arrive before anything has been
 * created still each cost an instance. `/pools/triggers` closes that: the job
 * is keyed on `(pipeline, node)` and `dedupKey` is unique among a pool's
 * non-terminal jobs, so N announcements of one subject collapse to one row and
 * one instance — a property a queue cannot have however cheap its messages are.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { PoolJob } from '../../../registries/pool/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-triggerpool';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'trigger pool',
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

  const instancesOf = async (name: string): Promise<string[]> => {
    const res = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/${name}`);
    return res.success ? res.data as string[] : [];
  };

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /work');

    // A step that blocks, so a created instance stays `running` and the test can
    // observe the pool rather than racing completion.
    await client.exec('mkfile /opt/steps/pool-slow && chmod 755 /opt/steps/pool-slow');
    await writeFile('/opt/steps/pool-slow', 'sleep 30');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    const yaml = [
      'name: test-pool',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  match:',
      `    mimetype: ${TEST_MIME}`,
      'steps:',
      '  slow:',
      '    command: pool-slow',
    ].join('\n');
    await client.exec('mkfile /work/test-pool.yaml');
    await writeFile('/work/test-pool.yaml', yaml);
    assertEquals((await client.exec('pipeline define /work/test-pool.yaml')).success, true);

    await t.step('the trigger pool exists whether or not a step delegates', async () => {
      assertEquals(await client.exec(`info ${POOLS_PATH}/triggers`).then((r) => r.success), true);
    });

    await t.step('a matched trigger becomes an instance via the pool', async () => {
      await client.exec(`mknode -t file --as "name=p.bin" --as "mimetype=${TEST_MIME}" /work/p.bin`);
      await client.exec('chmod 644 /work/p.bin');

      await waitFor(async () => (await instancesOf('test-pool')).length === 1, 'instance created');

      // The job that produced it is terminal, not lingering as ready work.
      const ready = (await triggerJobs()).filter((j) => j.state === 'ready');
      assertEquals(ready.length, 0);
    });

    await t.step('ten announcements of one subject yield one instance', async () => {
      const before = await instancesOf('test-pool');
      assertEquals(before.length, 1);

      for (let i = 0; i < 10; i++) {
        await client.exec(`attrs /work/p.bin -s nudge=${i}`);
      }
      await new Promise((r) => setTimeout(r, 2000));

      assertEquals((await instancesOf('test-pool')).length, 1, 'still one instance');

      // At most one non-terminal job for the subject, whatever arrived. (The
      // in-flight guard drops most of these before the pool sees them; the
      // dedup key is what makes the rest free rather than merely rare.)
      const live = (await triggerJobs()).filter((j) => j.state === 'ready' || j.state === 'claimed');
      assertEquals(live.filter((j) => j.dedupKey?.startsWith('test-pool/')).length <= 1, true, `expected at most one live job, got ${live.length}`);
    });

    await t.step('a distinct subject gets its own job and instance', async () => {
      await client.exec(`mknode -t file --as "name=q.bin" --as "mimetype=${TEST_MIME}" /work/q.bin`);
      await client.exec('chmod 644 /work/q.bin');

      await waitFor(async () => (await instancesOf('test-pool')).length === 2, 'second instance created');

      // The key is `<pipeline>/<nodeId>` — one per subject per pipeline. That
      // shape is the whole of the engine's contribution to dedup; the pool's
      // upsert-on-dedupKey does the rest (see pool-conformance).
      const ids = await instancesOf('test-pool');
      const keys = new Set((await triggerJobs()).map((j) => j.dedupKey));
      for (const id of ids) {
        assertEquals(keys.has(`test-pool/${id}`), true, `expected a job keyed test-pool/${id}, got ${[...keys]}`);
      }
    });

    await t.step('a job for an undefined pipeline is dropped, not retried forever', async () => {
      await vfs.poolAdd(ADMIN_ACCESS, `${POOLS_PATH}/triggers`, {
        kind: 'no-such-pipeline',
        dedupKey: 'no-such-pipeline/whatever',
        params: { pipelineName: 'no-such-pipeline', triggerPath: '/work/p.bin', nodeId: 'x' },
      });

      await waitFor(async () => {
        const job = (await triggerJobs()).find((j) => j.dedupKey === 'no-such-pipeline/whatever');
        return job !== undefined && job.state !== 'ready' && job.state !== 'claimed';
      }, 'undefined-pipeline job reaches a terminal state');

      const job = (await triggerJobs()).find((j) => j.dedupKey === 'no-such-pipeline/whatever');
      assertEquals(job?.state, 'done');
    });
  } finally {
    await harness.stop();
  }
});
