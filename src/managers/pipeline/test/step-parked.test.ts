/**
 * An inline step is 'running' only once it holds a concurrency permit.
 *
 * `dispatchStep` acquires the semaphore *after* the advance has written the step's status, and
 * can park there for as long as the cap makes it wait. So the advance writes 'queued' and
 * `dispatchStep` flips to 'running' once it has the permit.
 * This pins both halves: exactly `MAX_CONCURRENT` steps execute, the rest are parked and say so,
 * and the instances holding parked steps are not reported as running either.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../types.ts';

const TEST_MIME = 'application/x-step-parked';
const MAX_CONCURRENT = 1;
const FILES = 4;

const harness = new SystemTestHarness({
  ssh: false,
  boot: true,
  env: { CFG_PIPELINE_MAX_CONCURRENT: String(MAX_CONCURRENT) },
});

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'an inline step parked on the concurrency cap is not reported as running',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const root = `${PIPELINE_INSTANCES_PATH}/test-parked`;

  const stepStatuses = async (): Promise<string[]> => {
    const res = await client.exec(`ls ${root}`);
    const ids = res.success ? res.data as string[] : [];
    const out: string[] = [];
    for (const id of ids) {
      try {
        out.push((await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, `${root}/${id}/steps/slow`)).attrs.status);
      } catch { /* instance torn down mid-read */ }
    }
    return out;
  };

  const instanceStatuses = async (): Promise<string[]> => {
    const res = await client.exec(`ls ${root}`);
    const ids = res.success ? res.data as string[] : [];
    const out: string[] = [];
    for (const id of ids) {
      try {
        out.push((await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, `${root}/${id}`)).attrs.status);
      } catch { /* ditto */ }
    }
    return out;
  };

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /work');
    await client.exec('mkfile /opt/steps/step-slow && chmod 755 /opt/steps/step-slow');
    const handle = await vfs.open(ADMIN_ACCESS, '/opt/steps/step-slow', { mode: 'w' });
    try {
      // Long enough that every file is dispatched while the first still holds the only permit.
      await handle.write(new TextEncoder().encode('sleep 10\n'));
    } finally {
      await handle.close();
    }
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    await client.exec('mkfile /work/parked.yaml');
    const def = await vfs.open(ADMIN_ACCESS, '/work/parked.yaml', { mode: 'w' });
    try {
      await def.write(new TextEncoder().encode([
        'name: test-parked',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: ${TEST_MIME}`,
        'steps:',
        '  slow:',
        '    command: step-slow',
        '',
      ].join('\n')));
    } finally {
      await def.close();
    }
    assertEquals((await client.exec('pipeline define /work/parked.yaml')).success, true);

    await t.step('only the permit holder is running; the rest are queued', async () => {
      for (let i = 0; i < FILES; i++) {
        await client.exec(`mknode -t file --as "name=p${i}.bin" --as "mimetype=${TEST_MIME}" /work/p${i}.bin`);
        await client.exec(`chmod 644 /work/p${i}.bin`);
      }

      await waitFor(async () => (await stepStatuses()).filter((s) => s === 'running').length === MAX_CONCURRENT, 'a step to take the permit');
      // Long enough that any step destined to park has been dispatched and parked.
      await new Promise((r) => setTimeout(r, 2000));

      const steps = await stepStatuses();
      const running = steps.filter((s) => s === 'running').length;
      const queued = steps.filter((s) => s === 'queued').length;

      assertEquals(running, MAX_CONCURRENT, `expected ${MAX_CONCURRENT} running, got ${steps.join(',')}`);
      assertEquals(queued > 0, true, `expected parked steps, got ${steps.join(',')}`);

      // And the instance status follows the step: a parked step is live, not executing.
      const instances = await instanceStatuses();
      assertEquals(
        instances.filter((s) => s === 'running').length,
        MAX_CONCURRENT,
        `expected ${MAX_CONCURRENT} running instances, got ${instances.join(',')}`,
      );
    });
  } finally {
    await harness.stop();
  }
});
