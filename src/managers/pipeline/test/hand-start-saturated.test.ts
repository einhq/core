/**
 * A hand-started instance with an inline step is advanced at once, however saturated the engine,
 * and a parked inline step runs only if it is still the step it was dispatched for.
 *
 * Every permit is held and every other ready step is parked behind it, and the admission gate
 * is shut, so the trigger claim loop is parked too. `pipeline start` goes around both: its
 * instance-created event schedules an advance directly, and that advance must take the step
 * from 'pending' to 'queued' in moments rather than wait for any of the parked work.
 *
 * A parked dispatch can outlast what it was for. Cancelling the instance leaves its step
 * 'skipped', and starting the pipeline again on the same node puts a new step, with its own
 * dispatch, at the same path. In neither case may the old dispatch run once it gets a permit:
 * the cancelled step never runs, and the replaced one runs once, for the new instance.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import type { PipelineInstanceAttrs, PipelineStepAttrs } from '../types.ts';
import { toText } from '@std/streams/to-text';

const TEST_MIME = 'application/x-hand-start-saturated';
const MAX_CONCURRENT = 1;
const FILES = 3;
/** How long a hand-started step may stay 'pending'. An advance takes milliseconds. */
const ADVANCE_WITHIN_MS = 2000;
const RUNS = '/work/runs.log';

const harness = new SystemTestHarness({
  ssh: false,
  boot: true,
  env: {
    CFG_PIPELINE_MAX_CONCURRENT: String(MAX_CONCURRENT),
    CFG_PIPELINE_MAX_OPEN_INSTANCES: String(FILES),
    CFG_PIPELINE_MAX_ADMITTED_STEPS: String(FILES),
  },
});

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

Deno.test({
  name: 'a hand-started inline step advances while the engine is saturated',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: string): Promise<void> => {
    await client.exec(`mkfile ${path}`);
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body));
    } finally {
      await handle.close();
    }
  };

  const instancePath = async (pipeline: string, file: string): Promise<string> => `${PIPELINE_INSTANCES_PATH}/${pipeline}/${(await vfs.get(ADMIN_ACCESS, file)).id}`;

  const stepStatus = async (pipeline: string, file: string, step: string): Promise<string | undefined> => {
    try {
      return (await vfs.get<PipelineStepAttrs>(ADMIN_ACCESS, `${await instancePath(pipeline, file)}/steps/${step}`)).attrs.status;
    } catch {
      return undefined;
    }
  };

  const instanceStatus = async (pipeline: string, file: string): Promise<string | undefined> => {
    try {
      return (await vfs.get<PipelineInstanceAttrs>(ADMIN_ACCESS, await instancePath(pipeline, file))).attrs.status;
    } catch {
      return undefined;
    }
  };

  const hogs = Array.from({ length: FILES }, (_, i) => `/work/h${i}.bin`);

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /work');
    await writeFile(RUNS, '');
    // Long enough that the hand starts below all land while the first step holds the only permit.
    await writeFile('/opt/steps/step-hog', `echo "$1" >> ${RUNS}\nsleep 2\n`);
    await writeFile('/opt/steps/step-quick', 'true\n');
    await client.exec('chmod 755 /opt/steps/step-hog /opt/steps/step-quick');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    await writeFile(
      '/work/hog.yaml',
      [
        'name: test-hog',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: ${TEST_MIME}`,
        'steps:',
        '  hog:',
        '    command: step-hog $NODE_PATH',
        '',
      ].join('\n'),
    );
    // Nothing triggers it: it is only ever started by hand.
    await writeFile(
      '/work/hand.yaml',
      [
        'name: test-hand',
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        '    mimetype: application/x-never',
        'steps:',
        '  quick:',
        '    command: step-quick',
        '',
      ].join('\n'),
    );
    assertEquals((await client.exec('pipeline define /work/hog.yaml')).success, true);
    assertEquals((await client.exec('pipeline define /work/hand.yaml')).success, true);

    for (const [i, path] of hogs.entries()) {
      await client.exec(`mknode -t file --as "name=h${i}.bin" --as "mimetype=${TEST_MIME}" ${path}`);
      await client.exec(`chmod 644 ${path}`);
    }
    await waitFor(async () => {
      const steps = await Promise.all(hogs.map((path) => stepStatus('test-hog', path, 'hog')));
      return steps.filter((s) => s === 'running').length === 1 && steps.filter((s) => s === 'queued').length === FILES - 1;
    }, 'one step to hold the permit and the rest to park behind it');

    const [, cancelled, replaced] = await (async () => {
      const parked: string[] = [];
      for (const path of hogs) if (await stepStatus('test-hog', path, 'hog') === 'queued') parked.push(path);
      return [undefined, ...parked];
    })();

    await t.step('a fresh instance leaves pending at once', async () => {
      await client.exec(`mknode -t file --as "name=fresh.bin" --as "mimetype=application/x-other" /work/fresh.bin`);
      assertEquals((await client.exec('pipeline start test-hand /work/fresh.bin')).success, true);

      await waitFor(async () => await stepStatus('test-hand', '/work/fresh.bin', 'quick') !== 'pending', 'the hand-started step to be advanced', ADVANCE_WITHIN_MS);
    });

    await t.step('a start that replaces a parked instance of the same node is advanced too', async () => {
      const id = (await vfs.get(ADMIN_ACCESS, cancelled)).id;
      assertEquals((await client.exec(`pipeline cancel ${id}`)).success, true);

      assertEquals((await client.exec(`pipeline start test-hog ${replaced}`)).success, true);
      await waitFor(async () => await stepStatus('test-hog', replaced, 'hog') !== 'pending', 'the replacing instance to be advanced', ADVANCE_WITHIN_MS);
    });

    await t.step('a cancelled step never runs and a replaced one runs once', async () => {
      await waitFor(async () => {
        const statuses = await Promise.all([
          ...hogs.map((path) => instanceStatus('test-hog', path)),
          instanceStatus('test-hand', '/work/fresh.bin'),
        ]);
        return statuses.every((s) => s === 'completed' || s === 'cancelled');
      }, 'every instance to finish');
      // A stale dispatch would still be parked behind the last permit holder: give it the time.
      await new Promise((r) => setTimeout(r, 2500));

      const handle = await vfs.open(ADMIN_ACCESS, RUNS, { mode: 'r' });
      const runs = (await toText(handle.readable)).split('\n').filter(Boolean);
      await handle.close();

      assertEquals(runs.filter((path) => path === cancelled), [], `cancelled ${cancelled} ran: ${runs.join(',')}`);
      assertEquals(runs.filter((path) => path === replaced), [replaced], `replaced ${replaced} ran ${runs.join(',')}`);
      assertEquals(await stepStatus('test-hog', cancelled, 'hog'), 'skipped');
      assertEquals(await stepStatus('test-hog', replaced, 'hog'), 'completed');
    });
  } finally {
    await harness.stop();
  }
});
