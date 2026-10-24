/**
 * pipeline-heal: a failed instance is run again after its wait, with the count carried on the
 * new instance; one that failed on its input, or whose pipeline is no longer defined, is left
 * alone; one that keeps failing is marked for a person; and retention leaves failed instances to
 * heal. Undefining a pipeline cancels its running instances.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../../../testing/mod.ts';
import { HEAL_AFTER_MS, healVerdict } from '../pipeline-heal.ts';
import type { HealReport } from '../../../../../lib/api/pipeline.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../../../../pipeline/types.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test('a failed instance waits longer with every heal, then is left for a person', () => {
  const failedAt = 1_000_000;
  const attrs = (healAttempts?: number) => ({ status: 'failed', completedAt: failedAt, healAttempts }) as PipelineInstanceAttrs;
  const step = { status: 'failed' } as PipelineStepAttrs;

  assertEquals(healVerdict(attrs(), [step], failedAt + HEAL_AFTER_MS[0] - 1, false), 'waiting');
  assertEquals(healVerdict(attrs(), [step], failedAt + HEAL_AFTER_MS[0], false), 'rerun');
  assertEquals(healVerdict(attrs(1), [step], failedAt + HEAL_AFTER_MS[0], false), 'waiting');
  assertEquals(healVerdict(attrs(2), [step], failedAt + HEAL_AFTER_MS[2], false), 'rerun');
  assertEquals(healVerdict(attrs(HEAL_AFTER_MS.length), [step], failedAt, true), 'needs-person');
  // The cause passed (`--now`): no wait.
  assertEquals(healVerdict(attrs(1), [step], failedAt, true), 'rerun');
  // The input's own failure meets the same bytes every time.
  assertEquals(healVerdict(attrs(), [{ ...step, cause: 'input' }], failedAt + HEAL_AFTER_MS[2], true), 'input');
});

Deno.test({
  name: 'pipeline heal',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const dir = `${PIPELINE_INSTANCES_PATH}/healing`;

  const writeFile = async (path: string, body: string): Promise<void> => {
    await client.exec(`mkfile ${path}`);
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body + '\n'));
    } finally {
      await handle.close();
    }
  };
  const attrsOf = (id: string) => client.execJson<PipelineInstanceAttrs>(`attrs ${dir}/${id}`);
  const heal = (flags: string) => client.execJson<HealReport>(`pipeline heal ${flags}`);

  try {
    await client.exec('mkdir -p /work /opt/steps');
    // Fails until /tmp/heal-ok exists: the cause that passes.
    await writeFile('/opt/steps/heal-step', 'test -e /tmp/heal-ok');
    await client.exec('chmod 755 /opt/steps/heal-step');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);
    await writeFile(
      '/work/healing.yaml',
      [
        'name: healing',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  filter: |',
        '    exit 1',
        'steps:',
        '  only:',
        '    command: heal-step',
        'options:',
        '  maxAttempts: 1',
      ]
        .join('\n'),
    );
    assertEquals((await client.exec('pipeline define /work/healing.yaml')).success, true);
    for (const name of ['a.bin', 'b.bin']) await client.exec(`mknode -t file --as "name=${name}" /work/${name}`);

    let failed = '';
    await t.step('a fresh failure waits for its first heal', async () => {
      failed = (await client.execJson<{ id: string }>('pipeline start healing /work/a.bin')).id;
      await waitFor(async () => (await attrsOf(failed)).status === 'failed', 'the instance fails');

      const report = await heal('--apply');
      assertEquals(report.rerun, []);
      assertEquals(report.waiting, 1);
      assertEquals((await attrsOf(failed)).status, 'failed');
    });

    await t.step('--now runs it again out of turn, which does not count as a heal', async () => {
      await client.exec('mkfile /tmp/heal-ok');
      const report = await heal('--now --apply');
      assertEquals(report.rerun, [`healing/${failed}`]);

      await waitFor(async () => (await attrsOf(failed)).status === 'completed', 'the rerun completes');
      // A new EMS build every hour must not walk a failure up the ladder in an afternoon.
      assertEquals((await attrsOf(failed)).healAttempts, undefined);
    });

    await t.step('a failure on the input is not run again', async () => {
      await client.exec(
        `mknode -t directory --as 'pipelineName=healing' --as 'triggerPath=/work/b.bin' --as 'status=failed' --an 'startedAt=1' --an 'completedAt=1' ${dir}/undecodable`,
      );
      await client.exec(`mkdir -p ${dir}/undecodable/steps`);
      await client.exec(
        `mknode -t directory --as 'status=failed' --as 'cause=input' --as 'command=heal-step' ${dir}/undecodable/steps/only`,
      );

      const report = await heal('--now --apply');
      assertEquals(report.input, 1);
      assertEquals(report.rerun, []);
    });

    await t.step('one that failed through every heal is marked, and not looked at again', async () => {
      await client.exec(
        `mknode -t directory --as 'pipelineName=healing' --as 'triggerPath=/work/b.bin' --as 'status=failed' --an 'startedAt=1' --an 'completedAt=1' --an 'healAttempts=${HEAL_AFTER_MS.length}' ${dir}/hopeless`,
      );

      const report = await heal('--apply');
      assertEquals(report.needsPerson, ['healing/hopeless']);
      assertEquals((await attrsOf('hopeless')).needsPerson, true);
      assertEquals((await heal('--apply')).needsPerson, []);
    });

    await t.step('an instance of a pipeline no longer defined is not run again', async () => {
      await client.exec(`mkdir -p ${PIPELINE_INSTANCES_PATH}/retired`);
      await client.exec(
        `mknode -t directory --as 'pipelineName=retired' --as 'triggerPath=/work/b.bin' --as 'status=failed' --an 'startedAt=1' --an 'completedAt=1' ${PIPELINE_INSTANCES_PATH}/retired/old`,
      );

      const report = await heal('--now --apply');
      assertEquals(report.retired, 1);
      assertEquals(report.rerun, []);
    });

    await t.step('undefining a pipeline cancels its running instances, and leaves the finished ones', async () => {
      await writeFile('/opt/steps/slow-step', 'sleep 5');
      await client.exec('chmod 755 /opt/steps/slow-step');
      await writeFile(
        '/work/leaving.yaml',
        ['name: leaving', 'trigger:', '  event: updated', '  nodeType: file', '  filter: |', '    exit 1', 'steps:', '  only:', '    command: slow-step']
          .join('\n'),
      );
      assertEquals((await client.exec('pipeline define /work/leaving.yaml')).success, true);
      const live = (await client.execJson<{ id: string }>('pipeline start leaving /work/a.bin')).id;
      const leaving = `${PIPELINE_INSTANCES_PATH}/leaving`;
      await waitFor(async () => (await client.execJson<PipelineInstanceAttrs>(`attrs ${leaving}/${live}`)).status === 'running', 'the step runs');
      await client.exec(
        `mknode -t directory --as 'pipelineName=leaving' --as 'triggerPath=/work/b.bin' --as 'status=failed' --an 'startedAt=1' --an 'completedAt=1' ${leaving}/done`,
      );

      const out = await client.execJson<{ ok: boolean; cancelled: number }>('pipeline undefine leaving');
      assertEquals(out, { ok: true, cancelled: 1 });
      assertEquals((await client.execJson<PipelineInstanceAttrs>(`attrs ${leaving}/${live}`)).status, 'cancelled');
      assertEquals((await client.execJson<PipelineStepAttrs>(`attrs ${leaving}/${live}/steps/only`)).status, 'skipped');
      assertEquals((await client.execJson<PipelineInstanceAttrs>(`attrs ${leaving}/done`)).status, 'failed');
    });

    await t.step('retention leaves failed instances to heal', async () => {
      const res = await client.execJson<{ removed: number }>('pipeline prune healing --keep 0');
      assertEquals(res.removed, 1); // the completed rerun
      assertEquals((await attrsOf('hopeless')).status, 'failed');
      assertEquals((await attrsOf('undecodable')).status, 'failed');
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
