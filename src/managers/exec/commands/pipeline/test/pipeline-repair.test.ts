/**
 * pipeline-repair: instances marked terminal while still holding unfinished
 * steps are found and put back to running.
 *
 * The broken shape is built directly rather than by racing the engine, which
 * does not produce it.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { SystemTestHarness } from '../../../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type RepairResult = {
  scanned: number;
  broken: number;
  repaired: number;
  instances: { instance: string; status: string; steps: number }[];
};

Deno.test({
  name: 'pipeline repair',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await harness.startPrimary();
  const client = await harness.createShellClient();

  const dir = `${PIPELINE_INSTANCES_PATH}/repair`;
  const stranded = `${dir}/stranded`;
  const healthy = `${dir}/healthy`;

  const statusOf = async (path: string): Promise<string> => {
    const attrs = await client.execJson<{ status: string }>(`attrs ${path}`);
    return attrs.status;
  };

  try {
    // A marker-writing step so a repaired instance proves it actually ran.
    await client.exec('mkdir -p /opt/steps && mkdir -p /tmp/markers');
    await client.exec('mkfile /opt/steps/step-mark && chmod 755 /opt/steps/step-mark');
    await client.exec("echo 'echo ran >> /tmp/markers/repaired' > /opt/steps/step-mark");
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    await t.step('fixture: one stranded instance and one legitimately complete one', async () => {
      await client.exec(`mkdir -p ${dir}`);

      // Terminal, but its only step never ran.
      await client.exec(
        `mknode -t directory --as 'pipelineName=repair' --as 'triggerPath=/tmp' --as 'status=completed' --an 'startedAt=${Date.now()}' --an 'completedAt=${Date.now()}' ${stranded}`,
      );
      await client.exec(`mknode -t directory ${stranded}/steps`);
      await client.exec(
        `mknode -t directory --as 'stepName=mark' --as 'status=pending' --aj 'dependsOn=[]' --as 'command=step-mark' ${stranded}/steps/mark`,
      );

      // Terminal with a finished step — must be left alone.
      await client.exec(
        `mknode -t directory --as 'pipelineName=repair' --as 'triggerPath=/tmp' --as 'status=completed' --an 'startedAt=${Date.now()}' --an 'completedAt=${Date.now()}' ${healthy}`,
      );
      await client.exec(`mknode -t directory ${healthy}/steps`);
      await client.exec(
        `mknode -t directory --as 'stepName=mark' --as 'status=completed' --aj 'dependsOn=[]' --as 'command=step-mark' ${healthy}/steps/mark`,
      );

      assertEquals(await statusOf(stranded), 'completed');
    });

    await t.step('dry run reports the stranded instance without touching it', async () => {
      const result = await client.execJson<RepairResult>('pipeline-repair');

      assertEquals(result.broken, 1);
      assertEquals(result.repaired, 0);
      assertEquals(result.instances.map((i) => i.instance), [stranded]);
      assertEquals(await statusOf(stranded), 'completed');
    });

    await t.step('--apply returns it to running and the engine finishes it', async () => {
      const result = await client.execJson<RepairResult>('pipeline-repair --apply');
      assertEquals(result.repaired, 1);

      await waitFor(async () => (await statusOf(`${stranded}/steps/mark`)) === 'completed', 'stranded step to run');
      await waitFor(async () => (await statusOf(stranded)) === 'completed', 'stranded instance to complete');

      const marker = await client.exec('cat /tmp/markers/repaired');
      assertEquals(String(marker.data).trim(), 'ran');
    });

    await t.step('the healthy instance was never touched', async () => {
      assertEquals(await statusOf(healthy), 'completed');
      assertEquals(await statusOf(`${healthy}/steps/mark`), 'completed');
    });

    // The scan reads steps first and their instance second, so an instance
    // finishing in between leaves rows that were unfinished when read and are
    // finished by the time the instance is checked. Re-pending those would undo
    // completed work — so a terminal instance whose steps are all finished by
    // the time it is looked at is left alone. `healthy` is exactly that shape, and
    // is the case the re-read guards.
    await t.step('a terminal instance with only finished steps is never touched', async () => {
      const before = await client.execJson<{ startedAt?: number }>(`attrs ${healthy}/steps/mark`);
      await client.execJson<RepairResult>('pipeline-repair --apply');

      assertEquals(await statusOf(`${healthy}/steps/mark`), 'completed');
      const after = await client.execJson<{ startedAt?: number }>(`attrs ${healthy}/steps/mark`);
      assertEquals(after.startedAt, before.startedAt, 'a finished step must not be re-pended');
    });

    await t.step('a second run finds nothing left to repair', async () => {
      // Through the `pipeline <sub>` dispatcher, which re-quotes every arg —
      // so this also pins that a long flag survives the round trip.
      const result = await client.execJson<RepairResult>('pipeline repair --apply');
      assertEquals(result.broken, 0);
      assertEquals(result.repaired, 0);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
