/**
 * Pool delegation end-to-end: a step with `pool:` becomes a pool job, a
 * `pipeline-worker --pool` claims it if its capacity covers `requires`, and the
 * engine advances on completion.
 *
 * Beyond the plain path: a worker whose capacity is too small leaves the job
 * alone rather than taking work it cannot run, a higher-priority job of the
 * *same* pipeline jumps ahead, and a step left 'waiting' with no job behind it
 * heals itself instead of stalling forever.
 *
 * Runs against the full-boot harness (engine runs as the pipeline-engine service).
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { type ShellClient, SystemTestHarness, testCommands } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testpool';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function markers(client: ShellClient, name: string): Promise<string[]> {
  const result = await client.exec(`cat /tmp/markers/${name}`);
  if (!result.success) return [];
  return String(result.data).trim().split('\n').filter(Boolean);
}

async function writeFile(vfs: Awaited<ReturnType<SystemTestHarness['startPrimary']>>['vfs'], path: string, body: string) {
  const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(body + '\n'));
  } finally {
    await handle.close();
  }
}

Deno.test({
  name: 'pool delegation',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  const instanceIdFor = async (triggerPath: string): Promise<string | null> => {
    const listing = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/test-pool`);
    if (!listing.success) return null;
    for (const id of listing.data as string[]) {
      try {
        const a = await client.execJson<{ triggerPath: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/test-pool/${id}`);
        if (a.triggerPath === triggerPath) return id;
      } catch { /* vanished */ }
    }
    return null;
  };
  const instanceStatus = async (id: string): Promise<string> => (await client.execJson<{ status: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/test-pool/${id}`)).status;
  const stepStatus = async (id: string, step: string): Promise<string> =>
    (await client.execJson<{ status: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/test-pool/${id}/steps/${step}`)).status;
  const poolCounts = async (): Promise<Record<string, number>> => (await client.execJson<{ counts: Record<string, number> }>(`pool stat ${POOLS_PATH}/testpool`)).counts;

  try {
    // ---- Fixture: stub step commands, worker service, pipeline definition ----

    await client.exec('mkdir -p /opt/steps && mkdir -p /tmp/markers && mkdir -p /work && mkdir -p /opt/testpool-worker');

    const scripts: Record<string, string> = {
      'pool-prep': 'name=$(basename "$1")\necho prep >> "/tmp/markers/$name"',
      'pool-heavy': 'name=$(basename "$1")\necho heavy >> "/tmp/markers/$name"',
    };
    for (const [name, body] of Object.entries(scripts)) {
      await client.exec(`mkfile /opt/steps/${name} && chmod 755 /opt/steps/${name}`);
      await writeFile(vfs, `/opt/steps/${name}`, body);
    }

    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    // The worker offers less VRAM than the heavy step needs, so it can see the
    // job but must not take it. Raised later in the test.
    await client.exec('mkfile /opt/testpool-worker/start.sh && chmod 755 /opt/testpool-worker/start.sh');
    await writeFile(
      vfs,
      '/opt/testpool-worker/start.sh',
      // Concatenated rather than interpolated: `${TESTPOOL_VRAM:-1000}` is shell
      // syntax the worker script expands at run time, so it must not be a JS
      // template literal.
      'pipeline-worker --pool ' + POOLS_PATH + '/testpool --capacity gpu=1 --capacity vramMb="${TESTPOOL_VRAM:-1000}" --concurrency 1',
    );

    const pipelineYaml = [
      'name: test-pool',
      'description: pool delegation fixture',
      '',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  filter: |',
      '    case "$MIMETYPE" in',
      `      ${TEST_MIME}) exit 0;;`,
      '      *) exit 1;;',
      '    esac',
      '',
      'steps:',
      '  prep:',
      '    command: pool-prep $NODE_PATH',
      '  heavy:',
      '    command: pool-heavy $NODE_PATH',
      '    dependsOn: [prep]',
      '    pool: testpool',
      '    kind: heavy',
      '    priority: 10',
      '    requires:',
      '      gpu: 1',
      '      vramMb: 4000',
      '',
      'options:',
      '  maxAttempts: 3',
    ].join('\n');
    await client.exec('mkfile /work/test-pool.yaml');
    await writeFile(vfs, '/work/test-pool.yaml', pipelineYaml);

    await t.step('defining the pipeline creates the pool it names', async () => {
      await cmd.shouldSucceed('pipeline define /work/test-pool.yaml');
      await cmd.shouldSucceed('service add testpool-worker /opt/testpool-worker');
      await cmd.shouldSucceed('service enable testpool-worker');

      await waitFor(async () =>
        (await client.exec(`ls ${POOLS_PATH}`)).success &&
        (await client.execJson<string[]>(`ls ${POOLS_PATH}`)).includes('testpool'), 'testpool pool created');
    });

    await t.step('the step becomes a pool job carrying its requirements', async () => {
      await client.exec(`mknode -t file --as "name=a.bin" --as "mimetype=${TEST_MIME}" /work/a.bin`);
      await client.exec('chmod 644 /work/a.bin');

      await waitFor(async () => (await markers(client, 'a.bin')).includes('prep'), 'prep to run');
      const id = await instanceIdFor('/work/a.bin');
      assertEquals(typeof id, 'string');
      await waitFor(async () => (await stepStatus(id!, 'heavy')) === 'waiting', 'heavy delegated to waiting');

      const jobs = await client.execJson<{ items: { kind: string; priority: number; requires: Record<string, number>; dedupKey: string }[] }>(
        `pool list ${POOLS_PATH}/testpool`,
      );
      assertEquals(jobs.items.length, 1);
      assertEquals(jobs.items[0].kind, 'heavy');
      assertEquals(jobs.items[0].priority, 10);
      assertEquals(jobs.items[0].requires, { gpu: 1, vramMb: 4000 });
      assertEquals(jobs.items[0].dedupKey, `${PIPELINE_INSTANCES_PATH}/test-pool/${id}/steps/heavy`);
    });

    await t.step('a worker without the capacity leaves the job alone', async () => {
      await cmd.shouldSucceed('service start testpool-worker');

      // Give the worker time to claim if it were going to.
      await new Promise((r) => setTimeout(r, 1500));

      assertEquals((await markers(client, 'a.bin')).includes('heavy'), false);
      assertEquals((await poolCounts()).ready, 1);
      assertEquals((await poolCounts()).claimed, 0);
    });

    await t.step('raising capacity is all it takes to run the work', async () => {
      await cmd.shouldSucceed('service stop testpool-worker');
      await writeFile(
        vfs,
        '/opt/testpool-worker/start.sh',
        `pipeline-worker --pool ${POOLS_PATH}/testpool --capacity gpu=1 --capacity vramMb=16000 --concurrency 1`,
      );
      await cmd.shouldSucceed('service start testpool-worker');

      await waitFor(async () => (await markers(client, 'a.bin')).includes('heavy'), 'worker runs heavy step');
      const id = (await instanceIdFor('/work/a.bin'))!;
      await waitFor(async () => (await instanceStatus(id)) === 'completed', 'instance completes after delegation');
      assertEquals(await stepStatus(id, 'heavy'), 'completed');
      await waitFor(async () => (await poolCounts()).done === 1, 'job marked done');
    });

    await t.step('a running worker picks up module bins added to bashrc', async () => {
      await client.exec('mkdir -p /opt/late-steps');
      await client.exec('mkfile /opt/late-steps/pool-late && chmod 755 /opt/late-steps/pool-late');
      await writeFile(vfs, '/opt/late-steps/pool-late', 'name=$(basename "$1")\necho late >> "/tmp/markers/$name"');

      // The worker is already running. The append event must update that existing shell's PATH;
      // starting a fresh worker would not show whether the running one picks it up.
      await client.exec(`echo 'export PATH="$PATH:/opt/late-steps"' >> /etc/bashrc`);

      const latePipeline = [
        'name: test-pool-late',
        'description: live worker PATH refresh fixture',
        '',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  filter: |',
        '    case "$MIMETYPE" in',
        '      application/x-testpool-late) exit 0;;',
        '      *) exit 1;;',
        '    esac',
        '',
        'steps:',
        '  late:',
        '    command: pool-late $NODE_PATH',
        '    pool: testpool',
        '    kind: heavy',
        '    requires:',
        '      gpu: 1',
        '      vramMb: 4000',
      ].join('\n');
      await client.exec('mkfile /work/test-pool-late.yaml');
      await writeFile(vfs, '/work/test-pool-late.yaml', latePipeline);
      await cmd.shouldSucceed('pipeline define /work/test-pool-late.yaml');

      await client.exec('mknode -t file --as "name=late.bin" --as "mimetype=application/x-testpool-late" /work/late.bin');
      await client.exec('chmod 644 /work/late.bin');
      await waitFor(async () => (await markers(client, 'late.bin')).includes('late'), 'running worker to refresh PATH');
    });

    await t.step('a waiting step with no job behind it heals on the next advance', async () => {
      // The engine died between marking the step and enqueueing. The add is
      // keyed on the step path, so the next advance restores it rather than
      // needing pipeline-repair.
      await cmd.shouldSucceed('service stop testpool-worker');

      await client.exec(`mknode -t file --as "name=c.bin" --as "mimetype=${TEST_MIME}" /work/c.bin`);
      await client.exec('chmod 644 /work/c.bin');

      await waitFor(async () => (await instanceIdFor('/work/c.bin')) !== null, 'c instance created');
      const cId = (await instanceIdFor('/work/c.bin'))!;
      await waitFor(async () => (await stepStatus(cId, 'heavy')) === 'waiting', 'c heavy delegated');

      const stepPath = `${PIPELINE_INSTANCES_PATH}/test-pool/${cId}/steps/heavy`;

      // Drop the job while leaving the step 'waiting' — exactly the broken shape.
      await cmd.shouldSucceed(`pool cancel ${POOLS_PATH}/testpool --key ${stepPath}`);
      await cmd.shouldSucceed(`pool purge ${POOLS_PATH}/testpool`);
      assertEquals((await poolCounts()).ready, 0);

      // Any advance of the instance re-adds it; touching the step is enough.
      await cmd.shouldSucceed(`attrs ${stepPath} -s error=nudge`);
      await waitFor(async () => (await poolCounts()).ready === 1, 'job restored by the next advance');

      await cmd.shouldSucceed('service start testpool-worker');
      await waitFor(async () => (await markers(client, 'c.bin')).includes('heavy'), 'restored job runs');
      await waitFor(async () => (await instanceStatus(cId)) === 'completed', 'c completes');
    });

    await t.step('removing an instance drops its pool job', async () => {
      await cmd.shouldSucceed('service stop testpool-worker');

      await client.exec(`mknode -t file --as "name=d.bin" --as "mimetype=${TEST_MIME}" /work/d.bin`);
      await client.exec('chmod 644 /work/d.bin');

      await waitFor(async () => (await instanceIdFor('/work/d.bin')) !== null, 'd instance created');
      const dId = (await instanceIdFor('/work/d.bin'))!;
      await waitFor(async () => (await stepStatus(dId, 'heavy')) === 'waiting', 'd heavy delegated');
      assertEquals((await poolCounts()).ready, 1);

      await cmd.shouldSucceed(`pipeline remove test-pool/${dId} --force`);

      // Without the explicit cancel this job would stay ready forever, with no
      // step left for a worker to re-validate against.
      await waitFor(async () => (await poolCounts()).ready === 0, 'job cancelled with its instance');
    });

    await t.step('pruning a terminal instance drops the pool job of its waiting step', async () => {
      await client.exec(`mknode -t file --as "name=e.bin" --as "mimetype=${TEST_MIME}" /work/e.bin`);
      await client.exec('chmod 644 /work/e.bin');

      await waitFor(async () => (await instanceIdFor('/work/e.bin')) !== null, 'e instance created');
      const eId = (await instanceIdFor('/work/e.bin'))!;
      await waitFor(async () => (await stepStatus(eId, 'heavy')) === 'waiting', 'e heavy delegated');
      assertEquals((await poolCounts()).ready, 1);

      // Failed elsewhere while `heavy` still waits on its job.
      await cmd.shouldSucceed(`attrs ${PIPELINE_INSTANCES_PATH}/test-pool/${eId} -s status=failed -s completedAt=${Date.now()}`);
      await cmd.shouldSucceed('pipeline prune test-pool --keep 0 --status failed');

      assertEquals((await client.exec(`stat ${PIPELINE_INSTANCES_PATH}/test-pool/${eId}`)).success, false);
      assertEquals((await poolCounts()).ready, 0);
    });
  } finally {
    await harness.stop();
  }
});
