/**
 * A trigger's `unless` skips an event before any shell is spawned, in both
 * trigger forms.
 *
 * Each guarded trigger's `filter` writes a marker and passes, so a filter
 * evaluation is observable. A probe pipeline without `unless` watches the same
 * nodes: its instance for a skipped node shows the event reached the
 * definitions, so the guarded pipeline's silence is a verdict, not a delay.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testunless';
const FACT = 'test.unless.happened';

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
  name: 'trigger unless skips without a shell',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
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
      'description: trigger unless fixture',
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

  // `unless` is tested before the filter, which records each evaluation and passes.
  const guarded = (marker: string) => [
    '  unless:',
    "    nodePath: '/work/skip/**'",
    '  filter: |',
    `    echo eval >> /tmp/markers/${marker}`,
  ];

  /** A file node with the fixture mimetype; the `chmod` is the `updated` event. */
  const makeFile = async (path: string): Promise<string> => {
    await client.exec(`mknode -t file --as "name=${path.split('/').pop()}" --as "mimetype=${TEST_MIME}" ${path}`);
    await client.exec(`chmod 644 ${path}`);
    return (await vfs.get(ADMIN_ACCESS, path)).id;
  };

  const hasInstance = (pipeline: string, nodeId: string): Promise<boolean> => vfs.exists(ADMIN_ACCESS, `${PIPELINE_INSTANCES_PATH}/${pipeline}/${nodeId}`);

  const emit = async (subject: string, id: string) => {
    const event = { id, type: FACT, subject, time: Date.now(), source: 'trigger-unless-test', data: { mimetype: TEST_MIME } };
    await client.exec(`echo ${JSON.stringify(JSON.stringify(event))} > /dev/events`);
  };

  try {
    await client.exec('mkdir -p /work/skip && mkdir -p /work/keep && mkdir -p /tmp/markers');
    await define('test-unless-vfs', ['  event: updated', '  nodeType: file', '  match:', `    mimetype: ${TEST_MIME}`, ...guarded('vfs-evals')]);
    await define('test-unless-fact', [`  on: ${FACT}`, ...guarded('fact-evals')]);
    await define('test-unless-probe', ['  event: updated', '  nodeType: file', '  match:', `    mimetype: ${TEST_MIME}`]);

    let skippedId = '';
    let keptId = '';

    await t.step('a VFS event the unless matches starts nothing and runs no filter', async () => {
      skippedId = await makeFile('/work/skip/a.bin');
      await waitFor(() => hasInstance('test-unless-probe', skippedId), 'probe instance for the skipped node');
      await new Promise((r) => setTimeout(r, 500));

      assertEquals(await hasInstance('test-unless-vfs', skippedId), false);
      assertEquals(await countLines(client, '/tmp/markers/vfs-evals'), 0, 'unless must reject before the filter runs');
    });

    await t.step('a VFS event it does not match goes on to the filter and starts an instance', async () => {
      keptId = await makeFile('/work/keep/b.bin');
      await waitFor(() => hasInstance('test-unless-vfs', keptId), 'instance for the kept node');
      assertEquals(await countLines(client, '/tmp/markers/vfs-evals'), 1);
    });

    await t.step('a fact the unless matches starts nothing and runs no filter; another fact does', async () => {
      await emit('/work/skip/a.bin', '01JTESTUNLESSSKIP');
      await emit('/work/keep/b.bin', '01JTESTUNLESSKEEP');
      await waitFor(() => hasInstance('test-unless-fact', keptId), 'fact instance for the kept node');
      await new Promise((r) => setTimeout(r, 500));

      assertEquals(await hasInstance('test-unless-fact', skippedId), false);
      assertEquals(await countLines(client, '/tmp/markers/fact-evals'), 1, 'only the kept fact reaches the filter');
    });
  } finally {
    await harness.stop();
  }
});
