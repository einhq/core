/**
 * pipeline-prune's completed counter.
 *
 * Deleting an instance also deletes the only evidence it ever ran, so a count of
 * surviving rows stops being a counter the moment retention bites — it pins at
 * `--keep` and reports that number forever. The dashboard displayed exactly that
 * for months: "1,998 of 253,444 indexed", where 1,998 was the pruner's cap and
 * not a fact about the library at all.
 *
 * So the contract here is that pruning does not lower the completed total the
 * metrics sampler records, which `pipeline-overview` reports: the lifetime figure
 * rather than the surviving one.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import { countCompleted } from '../system/metrics-sampler.ts';

const testCtx = createTestContext();

/** Instance nodes as the engine writes them, without running a pipeline to get them. */
const seedInstance = async (cmd: ReturnType<typeof testCommands>, pipeline: string, index: number, status: string) => {
  const path = `${PIPELINE_INSTANCES_PATH}/${pipeline}/i${index}`;
  await cmd.shouldSucceed(`mknode -t directory ${path}`);
  // -J for the timestamps: the retention cap orders on completedAt, and a
  // string sorts differently from the number the engine writes.
  await cmd.shouldSucceed(
    `attrs ${path} -s pipelineName=${pipeline} -s status=${status} -s triggerPath=/x -J startedAt=${1000 + index} -J completedAt=${2000 + index}`,
  );
};

/** A definition for `pipeline`, so a whole-tree prune treats its instances as live history. */
const define = async (cmd: ReturnType<typeof testCommands>, pipeline: string) => {
  const yaml = ['name: ' + pipeline, 'trigger:', '  event: updated', '  nodeType: file', '  filter: |', '    exit 1', 'steps:', '  only:', '    command: echo done'];
  await cmd.shouldSucceed(`mkdir -p /work && echo '${yaml.join('\n')}' > /work/${pipeline}.yaml && pipeline define /work/${pipeline}.yaml`);
};

Deno.test({
  name: 'pipeline prune keeps the completed total honest',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const completed = () => countCompleted(vfs, PIPELINE_INSTANCES_PATH);
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    for (const pipeline of ['ingest', 'other']) await define(cmd, pipeline);
    await cmd.shouldSucceed(`mkdir -p ${PIPELINE_INSTANCES_PATH}/ingest`);
    for (let index = 0; index < 6; index++) await seedInstance(cmd, 'ingest', index, 'completed');

    await t.step('counts every completed instance before any pruning', async () => {
      assertEquals(await completed(), { ingest: 6 });
    });

    await t.step('a prune to a cap does not lower the reported total', async () => {
      const pruned = await client.execJson<{ removed: number }>('pipeline-prune --keep 2');
      assertEquals(pruned.removed, 4);

      // Four rows are gone from the tree...
      const remaining = await client.execJson<string[]>(`ls ${PIPELINE_INSTANCES_PATH}/ingest`);
      assertEquals(remaining.length, 2);

      // ...and the reported total is still six, because they still happened.
      assertEquals(await completed(), { ingest: 6 });
    });

    await t.step('a second prune adds to the bank rather than replacing it', async () => {
      await seedInstance(cmd, 'ingest', 10, 'completed');
      await client.execJson<{ removed: number }>('pipeline-prune --keep 1');

      assertEquals(await completed(), { ingest: 7 });
    });

    await t.step('only completed instances are banked', async () => {
      await cmd.shouldSucceed(`mkdir -p ${PIPELINE_INSTANCES_PATH}/other`);
      for (let index = 0; index < 4; index++) await seedInstance(cmd, 'other', index, 'failed');

      await client.execJson<{ removed: number }>('pipeline-prune other --keep 1');

      // Three failures pruned away, and none of them turned into completions.
      assertEquals((await completed()).other, undefined);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
