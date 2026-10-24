/**
 * pipeline-prune's retention by age, alone and beside the count cap.
 *
 * `--older-than d` removes terminal instances completed more than d ago; given
 * `--keep n` as well, an instance goes when either bound says so. Failed and
 * running instances are left alone, as with the cap.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import type { PipelineOverview } from '../../../../lib/api/pipeline.ts';

const testCtx = createTestContext();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

Deno.test({
  name: 'pipeline prune --older-than',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const dir = `${PIPELINE_INSTANCES_PATH}/aged`;

  /** An instance node as the engine writes it, completed `age` ms ago; a running one has no completedAt. */
  const seed = async (name: string, status: string, age?: number) => {
    const path = `${dir}/${name}`;
    await cmd.shouldSucceed(`mknode -t directory ${path}`);
    const completed = age === undefined ? '' : ` -J completedAt=${Date.now() - age}`;
    await cmd.shouldSucceed(`attrs ${path} -s pipelineName=aged -s status=${status} -s triggerPath=/x -J startedAt=1${completed}`);
  };
  const names = async () => (await client.execJson<string[]>(`ls ${dir}`)).toSorted();

  try {
    const yaml = ['name: aged', 'trigger:', '  event: updated', '  nodeType: file', '  filter: |', '    exit 1', 'steps:', '  only:', '    command: echo done'];
    await cmd.shouldSucceed(`mkdir -p /work && echo '${yaml.join('\n')}' > /work/aged.yaml && pipeline define /work/aged.yaml`);
    await cmd.shouldSucceed(`mkdir -p ${dir}`);

    await t.step('removes only terminal instances completed longer ago', async () => {
      for (const [name, age] of [['new1', 1 * HOUR], ['new2', 2 * HOUR], ['new3', 3 * HOUR], ['old1', 10 * DAY], ['old2', 11 * DAY]] as const) {
        await seed(name, 'completed', age);
      }
      await seed('oldcancelled', 'cancelled', 12 * DAY);
      await seed('oldfailed', 'failed', 12 * DAY);
      await seed('running', 'running');

      const pruned = await client.execJson<{ removed: number }>('pipeline-prune aged --older-than 7d');
      assertEquals(pruned.removed, 3);
      assertEquals(await names(), ['new1', 'new2', 'new3', 'oldfailed', 'running']);

      // The two old completions are banked, so the lifetime total still counts them.
      const overview = await client.execJson<PipelineOverview>('pipeline-overview');
      assertEquals(overview.instances.byPipeline.find((row) => row.pipeline === 'aged')?.completed, 5);
    });

    await t.step('with --keep, an instance goes when either bound says so', async () => {
      await seed('old3', 'completed', 10 * DAY);

      // The cap takes new3, the age takes old3.
      const pruned = await client.execJson<{ removed: number }>('pipeline-prune aged --keep 2 --older-than 7d');
      assertEquals(pruned.removed, 2);
      assertEquals(await names(), ['new1', 'new2', 'oldfailed', 'running']);
    });

    await t.step('the cap applies when every instance is within the age', async () => {
      const pruned = await client.execJson<{ removed: number }>('pipeline-prune aged --keep 1 --older-than 30d');
      assertEquals(pruned.removed, 1);
      assertEquals(await names(), ['new1', 'oldfailed', 'running']);
    });

    await t.step('--status failed reaches failures by age', async () => {
      const pruned = await client.execJson<{ removed: number }>('pipeline-prune aged --status failed --older-than 7d');
      assertEquals(pruned.removed, 1);
      assertEquals(await names(), ['new1', 'running']);
    });

    await t.step('rejects a duration it cannot read', async () => {
      const result = await client.exec('pipeline-prune aged --older-than soon');
      assertEquals(result.success, false);
      assertEquals(await names(), ['new1', 'running']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
