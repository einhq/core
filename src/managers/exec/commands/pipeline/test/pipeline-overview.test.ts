/**
 * pipeline-overview: the dashboard's single round trip.
 *
 * The load-bearing assertion is that instance counts and step counts never
 * cross-contaminate — the command discriminates the two node kinds purely by
 * which attr they carry (`pipelineName` vs `stepName`), so a definition with
 * both an inline and a delegated step is driven here to exercise both.
 */

import { assertEquals } from '@std/assert';
import { PIPELINES_PATH, POOLS_PATH } from '../../../../../lib/paths.ts';
import { ADMIN_ACCESS } from '../../../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../../../testing/mod.ts';
import type { PipelineOverview } from '../../../../../lib/api/pipeline.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'pipeline overview',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const overview = () => client.execJson<PipelineOverview>('pipeline-overview');
  // Ready jobs in the unworked pool; 0 until the engine has created it.
  const nobodyReady = async (): Promise<number> => {
    const res = await client.exec(`pool stat ${POOLS_PATH}/nobody`);
    return res.success ? (res.data as { counts: { ready: number } }).counts.ready : 0;
  };
  let instanceId = '';

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /work');
    await client.exec('mkfile /opt/steps/step-ok && chmod 755 /opt/steps/step-ok');
    const handle = await vfs.open(ADMIN_ACCESS, '/opt/steps/step-ok', { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode('exit 0\n'));
    } finally {
      await handle.close();
    }
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    // Never auto-triggers (filter exits 1), so instances are driven by hand.
    // `slow` is delegated to a pool nobody is working, so it parks in 'waiting' and the
    // instance stays live for the duration of the test — live but *not executing*, which is
    // exactly the state the matrix and the active list have to tell apart.
    const yaml = [
      'name: ovw',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  filter: |',
      '    exit 1',
      'steps:',
      '  quick:',
      '    command: step-ok',
      '  slow:',
      '    command: step-ok',
      '    pool: nobody',
      '    dependsOn: [quick]',
      '',
    ].join('\n');

    await client.exec('mkfile /work/ovw.yaml');
    const def = await vfs.open(ADMIN_ACCESS, '/work/ovw.yaml', { mode: 'w' });
    try {
      await def.write(new TextEncoder().encode(yaml));
    } finally {
      await def.close();
    }
    await client.exec('pipeline define /work/ovw.yaml');

    await t.step('an empty system reports zeroes, not errors', async () => {
      const data = await overview();
      assertEquals(data.instances.byPipeline.find((row) => row.pipeline === 'ovw'), undefined);
      assertEquals(typeof data.instances.total, 'number');
      assertEquals(Array.isArray(data.completions), true);
    });

    await t.step('an instance parked in a pool counts as queued, not running', async () => {
      // Nobody works the 'nobody' pool, so the step cannot be executing, and an instance that
      // is merely holding a queued job is reported as queued, not running.
      await client.exec('mknode -t file --as "name=a.bin" /work/a.bin');
      const started = await client.execJson<{ id: string }>('pipeline start ovw /work/a.bin');
      instanceId = started.id;

      // Parks once `slow` is delegated to the unworked 'nobody' pool. Waiting
      // on the pool rather than the step status: the engine marks the step
      // 'waiting' and *then* adds the job, so the pool is the later of the two.
      await waitFor(async () => (await nobodyReady()) === 1, 'slow step to be delegated');
      await waitFor(async () => (await overview()).instances.byPipeline.find((r) => r.pipeline === 'ovw')?.queued === 1, 'the instance to settle as queued');

      const data = await overview();
      const row = data.instances.byPipeline.find((r) => r.pipeline === 'ovw');
      assertEquals(row?.queued, 1);
      assertEquals(row?.running, 0);
      assertEquals(row?.total, 1);
      assertEquals(data.instances.byStatus.queued >= 1, true);

      // `active` is the "what is executing" list, so a parked instance is absent from it.
      assertEquals(data.active.filter((a) => a.pipeline === 'ovw').length, 0);
    });

    await t.step('step counts do not leak into instance counts', async () => {
      const data = await overview();

      // One instance, whatever the step count is.
      const row = data.instances.byPipeline.find((r) => r.pipeline === 'ovw');
      assertEquals(row?.total, 1);

      // The delegated step is unfinished; the inline one already completed and
      // must not be counted as live work.
      assertEquals(data.steps.byStatus['waiting'], 1);
      assertEquals(data.steps.byStatus['completed'], undefined);

      // No pipeline row is ever named after a step.
      assertEquals(data.instances.byPipeline.some((r) => r.pipeline === 'quick' || r.pipeline === 'slow'), false);
    });

    await t.step('a running step that has written nothing for long is listed as quiet', async () => {
      // Written by hand: the overview reads the step's own record, and waiting out the
      // threshold on a real step would take half an hour.
      const stepPath = `${PIPELINES_PATH}/instances/ovw/${instanceId}/steps/slow`;
      const quiet = async () => (await overview()).quiet.filter((step) => step.pipeline === 'ovw');
      const hourAgo = Date.now() - 60 * 60 * 1000;

      await vfs.update(ADMIN_ACCESS, stepPath, { attrs: { status: 'running', startedAt: hourAgo } });
      const listed = await quiet();
      assertEquals(listed.map((step) => [step.id, step.step, step.startedAt, step.outputAt]), [[instanceId, 'slow', hourAgo, undefined]]);

      // Output a minute ago: slow, but saying something.
      await vfs.update(ADMIN_ACCESS, stepPath, { attrs: { outputAt: Date.now() - 60 * 1000 } });
      assertEquals(await quiet(), []);

      // A step started a minute ago has not been quiet for long, whatever it has written.
      await vfs.update(ADMIN_ACCESS, stepPath, { attrs: { startedAt: Date.now() - 60 * 1000, outputAt: undefined } });
      assertEquals(await quiet(), []);

      await vfs.update(ADMIN_ACCESS, stepPath, { attrs: { status: 'waiting', startedAt: undefined } });
    });

    await t.step('completed instances move from running to completed', async () => {
      const cancelled = await client.exec(`pipeline cancel ovw/${instanceId}`);
      assertEquals(cancelled.success, true, `cancel failed: ${JSON.stringify(cancelled)}`);

      await waitFor(async () => {
        const row = (await overview()).instances.byPipeline.find((r) => r.pipeline === 'ovw');
        return row?.running === 0;
      }, 'instance to leave running');

      const data = await overview();
      const row = data.instances.byPipeline.find((r) => r.pipeline === 'ovw');
      assertEquals(row?.total, 1);
      assertEquals(row?.cancelled, 1);
      assertEquals(data.active.some((a) => a.pipeline === 'ovw'), false);
      // Cancelling finalises the step and drops its pool job with it.
      assertEquals(await nobodyReady(), 0);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
