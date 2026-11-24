/**
 * A subject renamed before its run gets to it is read under its new name.
 *
 * An upload to a temporary name, renamed when done (`<name>.tacitpart`, `<name>.filepart`), is
 * announced twice for one node: at the temporary path, then at the final one. Both land on the
 * node's one trigger job, which takes the newer path while it waits; and a run already made for
 * the temporary path, which can no longer reach its node, is replaced by one at the final path
 * rather than left to be cancelled with nothing after it (ein/core#1508).
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { isLiveInstance, type PipelineInstanceAttrs } from '../types.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'pipeline subject renamed before its run',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.start();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: string): Promise<void> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body + '\n'));
    } finally {
      await handle.close();
    }
  };

  const define = async (name: string, lines: string[]): Promise<void> => {
    await client.exec(`mkfile /work/${name}.yaml`);
    await writeFile(`/work/${name}.yaml`, [`name: ${name}`, ...lines].join('\n'));
    assertEquals((await client.exec(`pipeline define /work/${name}.yaml`)).success, true);
  };

  let eventSeq = 0;
  const announce = async (type: string, subject: string): Promise<void> => {
    const id = `01JTESTMOVEDSUBJECT${String(eventSeq++).padStart(7, '0')}`;
    const event = { id, type, subject, time: Date.now(), source: 'moved-subject-test', data: {} };
    await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`);
  };

  const instanceOf = async (pipeline: string, nodeId: string): Promise<PipelineInstanceAttrs | undefined> => {
    try {
      return (await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/${pipeline}/${nodeId}`)).attrs;
    } catch {
      return undefined;
    }
  };

  /** The trigger path of the job waiting under `dedupKey`. */
  const waitingJob = async (dedupKey: string): Promise<string | undefined> => {
    const jobs = await vfs.poolJobs(ADMIN_ACCESS, `${POOLS_PATH}/triggers`);
    const job = jobs.find((j) => j.dedupKey === dedupKey && j.state === 'ready');
    return (job?.params as { triggerPath?: string } | undefined)?.triggerPath;
  };

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /work');
    await client.exec('mkfile /opt/steps/moved-mark && chmod 755 /opt/steps/moved-mark');
    await writeFile('/opt/steps/moved-mark', 'echo "$1" >> /work/moved-marks');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    await t.step('a waiting trigger job takes the path its subject was renamed to', async () => {
      // The hold keeps the first announcement's job waiting while the rename lands.
      await define('test-moved-wait', [
        'trigger:',
        '  on: test.moved.wait',
        'steps:',
        '  mark:',
        '    command: moved-mark $NODE_PATH',
        'options:',
        '  debounceMs: 1500',
      ]);

      await client.exec('mknode -t file --as "name=a.jpg.part" /work/a.jpg.part');
      const node = await vfs.get(ADMIN_ACCESS, '/work/a.jpg.part');
      await announce('test.moved.wait', '/work/a.jpg.part');
      await waitFor(async () => (await waitingJob(`test-moved-wait/${node.id}`)) === '/work/a.jpg.part', "the first announcement's job");
      await client.exec('mv /work/a.jpg.part /work/a.jpg');
      await announce('test.moved.wait', '/work/a.jpg');

      await waitFor(async () => (await instanceOf('test-moved-wait', node.id))?.status === 'completed', 'the run to complete');
      assertEquals((await instanceOf('test-moved-wait', node.id))?.triggerPath, '/work/a.jpg');
      assertEquals((await client.execString('cat /work/moved-marks')).trim(), '/work/a.jpg');
    });

    await t.step('a rename while the trigger job is being made into a run is run after it', async () => {
      // The first step's condition is evaluated while the instance is created, so it holds the
      // trigger job claimed while the rename lands.
      await define('test-moved-claimed', [
        'trigger:',
        '  on: test.moved.claimed',
        'steps:',
        '  mark:',
        '    command: moved-mark $NODE_PATH',
        '    condition: sleep 2; true',
      ]);

      await client.exec('mknode -t file --as "name=c.jpg.part" /work/c.jpg.part');
      const node = await vfs.get(ADMIN_ACCESS, '/work/c.jpg.part');
      await announce('test.moved.claimed', '/work/c.jpg.part');
      await waitFor(async () => {
        const jobs = await vfs.poolJobs(ADMIN_ACCESS, `${POOLS_PATH}/triggers`, { dedupKey: `test-moved-claimed/${node.id}` });
        return jobs.some((j) => j.state === 'claimed');
      }, 'the first job to be claimed');
      await client.exec('mv /work/c.jpg.part /work/c.jpg');
      await announce('test.moved.claimed', '/work/c.jpg');

      await waitFor(async () => {
        const attrs = await instanceOf('test-moved-claimed', node.id);
        return attrs?.triggerPath === '/work/c.jpg' && attrs.status === 'completed';
      }, 'the run at the new path to complete');
      assertEquals((await client.execString('cat /work/moved-marks')).includes('/work/c.jpg\n'), true);
    });

    await t.step('a live run for the old path is replaced by one at the new path', async () => {
      // A pooled step with no worker: the run stays live, waiting on its pool.
      await define('test-moved-live', [
        'trigger:',
        '  on: test.moved.live',
        'steps:',
        '  wait:',
        '    command: moved-mark $NODE_PATH',
        '    pool: moved-live',
        '    kind: moved',
      ]);

      await client.exec('mknode -t file --as "name=b.jpg.part" /work/b.jpg.part');
      const node = await vfs.get(ADMIN_ACCESS, '/work/b.jpg.part');
      await announce('test.moved.live', '/work/b.jpg.part');
      const live = async () => {
        const attrs = await instanceOf('test-moved-live', node.id);
        return attrs !== undefined && isLiveInstance(attrs.status);
      };
      await waitFor(live, 'the first run to be live');

      // Announced again at the same path, the live run is left alone.
      await announce('test.moved.live', '/work/b.jpg.part');
      await new Promise((r) => setTimeout(r, 500));
      assertEquals((await instanceOf('test-moved-live', node.id))?.triggerPath, '/work/b.jpg.part');

      await client.exec('mv /work/b.jpg.part /work/b.jpg');
      await announce('test.moved.live', '/work/b.jpg');

      await waitFor(async () => (await instanceOf('test-moved-live', node.id))?.triggerPath === '/work/b.jpg', 'the run at the new path');
      assertEquals(await live(), true);
      const steps = await vfs.children(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/test-moved-live/${node.id}/steps`);
      assertEquals(steps.map((s) => s.node.attrs.status), ['waiting']);
    });
  } finally {
    await harness.stop();
  }
});
