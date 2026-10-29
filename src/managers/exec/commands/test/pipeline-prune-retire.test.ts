/**
 * pipeline-prune retires pipelines that are no longer defined: their instances, failures
 * included, and the directory with its banked total, so neither `pipeline-overview` nor the
 * completed counts the metrics sampler records list them.
 * Only once the definition has stayed gone for the grace period, and never one that comes back.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import type { PipelineOverview } from '../../../../lib/api/pipeline.ts';
import { RETIRE_GRACE_MS } from '../pipeline/pipeline-prune.ts';
import { countCompleted } from '../system/metrics-sampler.ts';

const testCtx = createTestContext();

type Prune = { removed: number; retired: string[] };

Deno.test({
  name: 'pipeline prune retires undefined pipelines',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const define = async (pipeline: string) => {
    const yaml = ['name: ' + pipeline, 'trigger:', '  event: updated', '  nodeType: file', '  filter: |', '    exit 1', 'steps:', '  only:', '    command: echo done'];
    await cmd.shouldSucceed(`mkdir -p /work && echo '${yaml.join('\n')}' > /work/${pipeline}.yaml && pipeline define /work/${pipeline}.yaml`);
  };
  const seed = async (pipeline: string, index: number, status: string) => {
    const path = `${PIPELINE_INSTANCES_PATH}/${pipeline}/i${index}`;
    await cmd.shouldSucceed(`mknode -p -t directory ${path}`);
    await cmd.shouldSucceed(`attrs ${path} -s pipelineName=${pipeline} -s status=${status} -s triggerPath=/x -J startedAt=${1000 + index} -J completedAt=${2000 + index}`);
  };
  const exists = async (path: string) => (await client.exec(`test -e ${path}`)).success;
  const backdate = (pipeline: string) => cmd.shouldSucceed(`attrs ${PIPELINE_INSTANCES_PATH}/${pipeline} -J undefinedSince=${Date.now() - RETIRE_GRACE_MS - 1000}`);
  const pipelines = async () => [
    ...(await client.execJson<PipelineOverview>('pipeline-overview')).instances.byPipeline.map((row) => row.pipeline),
    ...Object.keys(await countCompleted(vfs, PIPELINE_INSTANCES_PATH)),
  ];

  try {
    await define('kept');
    for (const pipeline of ['kept', 'renamed']) {
      await seed(pipeline, 0, 'completed');
      await seed(pipeline, 1, 'failed');
    }
    await cmd.shouldSucceed(`attrs ${PIPELINE_INSTANCES_PATH}/renamed -J prunedCompleted=5`);

    await t.step('an undefined pipeline is only marked the first time', async () => {
      const result = await client.execJson<Prune>('pipeline-prune --keep 1');
      assertEquals(result.retired, []);
      assertEquals(await exists(`${PIPELINE_INSTANCES_PATH}/renamed/i0`), true);
      const attrs = await client.execJson<{ undefinedSince?: number }>(`attrs ${PIPELINE_INSTANCES_PATH}/renamed`);
      assertEquals(typeof attrs.undefinedSince, 'number');
    });

    await t.step('once the grace has passed it goes, failures, bank and directory', async () => {
      await backdate('renamed');
      const result = await client.execJson<Prune>('pipeline-prune --keep 1');
      assertEquals(result.retired, ['renamed']);
      assertEquals(await exists(`${PIPELINE_INSTANCES_PATH}/renamed`), false);
      assertEquals((await pipelines()).includes('renamed'), false);
      // The defined pipeline keeps its failure and its newest completion.
      assertEquals(await exists(`${PIPELINE_INSTANCES_PATH}/kept/i0`), true);
      assertEquals(await exists(`${PIPELINE_INSTANCES_PATH}/kept/i1`), true);
    });

    await t.step('a definition that comes back clears the mark and keeps the instances', async () => {
      await seed('returning', 0, 'completed');
      await client.execJson<Prune>('pipeline-prune --keep 1');
      await backdate('returning');
      await define('returning');

      const result = await client.execJson<Prune>('pipeline-prune --keep 1');
      assertEquals(result.retired, []);
      assertEquals(await exists(`${PIPELINE_INSTANCES_PATH}/returning/i0`), true);
      const attrs = await client.execJson<{ undefinedSince?: number }>(`attrs ${PIPELINE_INSTANCES_PATH}/returning`);
      assertEquals(attrs.undefinedSince, undefined);
    });

    await t.step('a prune of one pipeline or one status retires nothing', async () => {
      await seed('elsewhere', 0, 'failed');
      await client.execJson<Prune>('pipeline-prune --keep 1');
      await backdate('elsewhere');

      assertEquals((await client.execJson<Prune>('pipeline-prune elsewhere --keep 1')).retired, []);
      assertEquals((await client.execJson<Prune>('pipeline-prune -s failed')).retired, []);
      assertEquals(await exists(`${PIPELINE_INSTANCES_PATH}/elsewhere`), true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
