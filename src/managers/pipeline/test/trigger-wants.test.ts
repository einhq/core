/**
 * A trigger's `wants` starts it only where the subject's folder wants one of its families, in both
 * trigger forms, before any shell is spawned: the nearest directory with a `processing` attr
 * decides, a nested one overriding its parent, none means every family and an empty list none.
 *
 * Each guarded trigger's `filter` writes a marker and passes, so a filter evaluation is observable.
 * A probe pipeline without `wants` watches the same nodes: its instance for a skipped node shows
 * the event reached the definitions, so the guarded pipeline's silence is a verdict, not a delay.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { PROCESSING_ATTR } from '../../../lib/processing.ts';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testwants';
const FACT = 'test.wants.happened';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function countLines(client: ShellClient, path: string): Promise<number> {
  const result = await client.exec(`cat ${path}`);
  if (!result.success) return 0;
  return String(result.data).trim().split('\n').filter(Boolean).length;
}

Deno.test({
  name: "trigger wants follows the subject's folder",
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.start();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body + '\n'));
    } finally {
      await handle.close();
    }
  };

  const define = async (name: string, triggerLines: string[]) => {
    const yaml = [
      `name: ${name}`,
      'description: trigger wants fixture',
      '',
      'trigger:',
      ...triggerLines,
      '',
      'steps:',
      '  noop:',
      '    command: echo ran',
    ].join('\n');
    await client.exec(`mkfile /work/${name}.yaml`);
    await writeFile(`/work/${name}.yaml`, yaml);
    assertEquals((await client.exec(`pipeline define /work/${name}.yaml`)).success, true, `define ${name}`);
  };

  // `wants` is tested before the filter, which records each evaluation and passes.
  const filtered = (marker: string) => ['  filter: |', `    echo eval >> /tmp/markers/${marker}`];

  /** A file node with the fixture mimetype; the `chmod` is the `updated` event. */
  const makeFile = async (path: string): Promise<string> => {
    await client.exec(`mknode -t file --as "name=${path.split('/').pop()}" --as "mimetype=${TEST_MIME}" ${path}`);
    await client.exec(`chmod 644 ${path}`);
    return (await vfs.get(ADMIN_ACCESS, path)).id;
  };

  const hasInstance = (pipeline: string, nodeId: string): Promise<boolean> => vfs.exists(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/${pipeline}/${nodeId}`);

  const emit = async (subject: string, id: string) => {
    const event = { id, type: FACT, subject, time: Date.now(), source: 'trigger-wants-test', data: { mimetype: TEST_MIME } };
    await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`);
  };

  try {
    await client.exec('mkdir -p /work/all /work/thumbs/vectors /work/none /tmp/markers');
    await vfs.update(ADMIN_ACCESS, '/work/thumbs', { attrs: { [PROCESSING_ATTR]: ['renditions'] } });
    await vfs.update(ADMIN_ACCESS, '/work/thumbs/vectors', { attrs: { [PROCESSING_ATTR]: ['picture-vectors'] } });
    await vfs.update(ADMIN_ACCESS, '/work/none', { attrs: { [PROCESSING_ATTR]: [] } });

    await define('test-wants-vfs', ['  event: updated', '  nodeType: file', '  match:', `    mimetype: ${TEST_MIME}`, '  wants: picture-vectors', ...filtered('vfs-evals')]);
    await define('test-wants-fact', [`  on: ${FACT}`, '  wants: [renditions, text]', ...filtered('fact-evals')]);
    await define('test-wants-probe', ['  event: updated', '  nodeType: file', '  match:', `    mimetype: ${TEST_MIME}`]);

    let thumbsId = '';
    let vectorsId = '';
    let allId = '';
    let noneId = '';

    await t.step('a folder that wants other families starts nothing and runs no filter', async () => {
      thumbsId = await makeFile('/work/thumbs/a.bin');
      await waitFor(() => hasInstance('test-wants-probe', thumbsId), 'probe instance for the node in /work/thumbs');
      await new Promise((r) => setTimeout(r, 500));

      assertEquals(await hasInstance('test-wants-vfs', thumbsId), false);
      assertEquals(await countLines(client, '/tmp/markers/vfs-evals'), 0, 'wants must reject before the filter runs');
    });

    await t.step('a nested folder that wants the family overrides its parent', async () => {
      vectorsId = await makeFile('/work/thumbs/vectors/b.bin');
      await waitFor(() => hasInstance('test-wants-vfs', vectorsId), 'instance for the node in the nested folder');
      assertEquals(await countLines(client, '/tmp/markers/vfs-evals'), 1);
    });

    await t.step('a folder with no setting above it wants every family', async () => {
      allId = await makeFile('/work/all/c.bin');
      await waitFor(() => hasInstance('test-wants-vfs', allId), 'instance for the node with no setting');
      assertEquals(await countLines(client, '/tmp/markers/vfs-evals'), 2);
    });

    await t.step('a fact starts where its folder wants any of the families, and nowhere else', async () => {
      noneId = await makeFile('/work/none/d.bin');
      await waitFor(() => hasInstance('test-wants-probe', noneId), 'probe instance for the node in /work/none');

      await emit('/work/none/d.bin', '01JTESTWANTSNONE');
      await emit('/work/thumbs/vectors/b.bin', '01JTESTWANTSVECTORS');
      await emit('/work/thumbs/a.bin', '01JTESTWANTSTHUMBS');
      await waitFor(() => hasInstance('test-wants-fact', thumbsId), 'fact instance for the node in /work/thumbs');
      await new Promise((r) => setTimeout(r, 500));

      assertEquals(await hasInstance('test-wants-fact', noneId), false, 'an empty list wants nothing');
      assertEquals(await hasInstance('test-wants-fact', vectorsId), false, 'the nested folder wants neither family');
      assertEquals(await countLines(client, '/tmp/markers/fact-evals'), 1, 'only the wanted fact reaches the filter');
    });
  } finally {
    await harness.stop();
  }
});
