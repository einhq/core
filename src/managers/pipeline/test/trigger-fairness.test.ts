/**
 * Trigger admission is fair across pipelines, not first-come-first-served.
 *
 * Every trigger job is created at priority 0, and the pool orders
 * `eff_priority DESC, created_at ASC`, so an unfiltered claim is strict global
 * FIFO. That starves one class of pipeline systematically rather than randomly:
 * anything triggered by a *domain event* is only announced after an upstream
 * step has run on that file, so its job is always younger than the upstream
 * jobs of every file queued since, and behind a backlog it never runs.
 *
 * The engine is pinned tight here — one creation at a time, five admitted steps,
 * a blocking step — so it admits a handful of instances and then parks on the
 * admission gate. The backlog cannot drain, so reaching the late arrival at all
 * is only possible by rotating: a FIFO claim spends every one of those five
 * admissions on the older kind.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';

// Read by the engine constructor, so they must be set before the harness boots.
const harness = new SystemTestHarness({
  ssh: false,
  boot: true,
  env: { CFG_PIPELINE_MAX_ADMITTED_STEPS: '5', CFG_PIPELINE_TRIGGER_CONCURRENCY: '1' },
});

const BACKLOG = 30;

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'trigger admission rotates across pipelines',
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

  const instancesOf = async (name: string): Promise<string[]> => {
    const res = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/${name}`);
    return res.success ? res.data as string[] : [];
  };

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /work');
    // Stage the whole backlog before admission starts. Otherwise the engine can
    // fill its five slots while this test is still appending the older jobs,
    // which tests producer speed rather than claim ordering.
    assertEquals((await client.exec('service stop pipeline-engine')).success, true);

    // Blocking, so admitted instances stay running and the gate stays shut.
    await client.exec('mkfile /opt/steps/fair-slow && chmod 755 /opt/steps/fair-slow');
    await writeFile('/opt/steps/fair-slow', 'sleep 60');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    // A trigger is mandatory, so each pipeline gets a mimetype match that nothing
    // in this test ever carries. Nothing announces them implicitly and the pool
    // contents are exactly what this test puts there.
    for (const name of ['bulk-pipe', 'late-pipe']) {
      const yaml = [
        `name: ${name}`,
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: application/x-${name}-never`,
        'steps:',
        '  slow:',
        '    command: fair-slow',
      ].join('\n');
      await client.exec(`mkfile /work/${name}.yaml`);
      await writeFile(`/work/${name}.yaml`, yaml);
      assertEquals((await client.exec(`pipeline define /work/${name}.yaml`)).success, true);
    }

    await t.step('a late arrival is admitted despite an older backlog of another kind', async () => {
      // The backlog goes in first, so every one of these is strictly older than
      // the late job — the exact condition FIFO cannot recover from.
      for (let i = 0; i < BACKLOG; i++) {
        const triggerPath = `/work/bulk-${i}`;
        await client.exec(`mkfile ${triggerPath}`);
        const nodeId = (await vfs.get(ADMIN_ACCESS, triggerPath)).id;
        await vfs.poolAdd(ADMIN_ACCESS, `${POOLS_PATH}/triggers`, {
          kind: 'bulk-pipe',
          dedupKey: `bulk-pipe/${nodeId}`,
          params: { pipelineName: 'bulk-pipe', triggerPath, nodeId },
        });
      }

      const latePath = '/work/late';
      await client.exec(`mkfile ${latePath}`);
      const lateNodeId = (await vfs.get(ADMIN_ACCESS, latePath)).id;
      await vfs.poolAdd(ADMIN_ACCESS, `${POOLS_PATH}/triggers`, {
        kind: 'late-pipe',
        dedupKey: `late-pipe/${lateNodeId}`,
        params: { pipelineName: 'late-pipe', triggerPath: latePath, nodeId: lateNodeId },
      });

      assertEquals((await client.exec('service start pipeline-engine')).success, true);
      await waitFor(async () => (await instancesOf('late-pipe')).length === 1, 'late-pipe instance created');

      // The point is not merely that it ran, but that it ran *without the backlog
      // draining first* — otherwise this would pass under plain FIFO too.
      const bulk = await instancesOf('bulk-pipe');
      assertEquals(
        bulk.length < BACKLOG,
        true,
        `expected late-pipe to be admitted before the backlog drained, but ${bulk.length}/${BACKLOG} bulk instances already existed`,
      );
    });
  } finally {
    await client.close();
    await harness.stop();
  }
});
