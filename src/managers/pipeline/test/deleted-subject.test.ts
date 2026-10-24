/**
 * An instance whose subject node is gone does not keep running.
 *
 * Deleting a file mid-pipeline cancels the instance: its remaining steps do not
 * run against the gone path, where the first to write a child would rebuild
 * every missing ancestor as a `directory` (`mknode -p`).
 *
 * The engine requires the subject to exist to *create* an instance, and a pooled
 * step re-checks it when a worker claims the job. This covers the third place:
 * an inline step about to be dispatched.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testvanish';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function writeFile(vfs: Awaited<ReturnType<SystemTestHarness['startPrimary']>>['vfs'], path: string, body: string) {
  const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(body + '\n'));
  } finally {
    await handle.close();
  }
}

Deno.test({
  name: 'pipeline instance whose subject is deleted',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const exists = async (path: string): Promise<boolean> => (await client.exec(`info ${path}`)).success;

  try {
    await client.exec('mkdir -p /opt/steps && mkdir -p /tmp/markers && mkdir -p /work');

    // `hold` marks that it started and then stays busy long enough for the test
    // to delete the node underneath it. `derive` is the writer: exactly what a
    // derivative step does, and what would rebuild the tree.
    await client.exec('mkfile /opt/steps/vanish-hold && chmod 755 /opt/steps/vanish-hold');
    await writeFile(vfs, '/opt/steps/vanish-hold', 'echo held >> /tmp/markers/vanish\nsleep 3');
    await client.exec('mkfile /opt/steps/vanish-derive && chmod 755 /opt/steps/vanish-derive');
    await writeFile(vfs, '/opt/steps/vanish-derive', 'echo derived >> /tmp/markers/vanish\nmkdir -p "$1/metadata"');
    await client.exec(`echo 'export PATH="$PATH:/opt/steps"' >> /etc/bashrc`);

    const yaml = [
      'name: test-vanish',
      'description: deleted-subject fixture',
      '',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  filter: |',
      '    case "$MIMETYPE" in',
      `      ${TEST_MIME}) exit 0;;`,
      '      *) exit 1;;',
      '    esac',
      '',
      'steps:',
      '  hold:',
      '    command: vanish-hold $NODE_PATH',
      '  derive:',
      '    command: vanish-derive $NODE_PATH',
      '    dependsOn: [hold]',
    ].join('\n');
    await client.exec('mkfile /work/test-vanish.yaml');
    await writeFile(vfs, '/work/test-vanish.yaml', yaml);
    assertEquals((await client.exec('pipeline define /work/test-vanish.yaml')).success, true);

    let instancePath = '';

    await t.step('deleting the subject mid-run cancels the instance', async () => {
      await client.exec('mkdir -p /work/album/files');
      await client.exec(`mknode -t file --as "name=photo.bin" --as "mimetype=${TEST_MIME}" /work/album/files/photo.bin`);
      const node = await vfs.get(ADMIN_ACCESS, '/work/album/files/photo.bin');
      instancePath = `${PIPELINE_INSTANCES_PATH}/test-vanish/${node.id}`;

      // event: updated, so this is what triggers it.
      await client.exec('chmod 644 /work/album/files/photo.bin');

      await waitFor(async () => (await client.exec('cat /tmp/markers/vanish')).success, 'the first step to start');

      // The album goes while `hold` is still busy — the verification run that
      // found this deleted its own scratch album the same way.
      assertEquals((await client.exec('rm -rf /work/album')).success, true);

      await waitFor(async () => {
        const attrs = await client.exec(`JSON_OUTPUT=1 attrs ${instancePath}`);
        return attrs.success && (attrs.data as { status?: string }).status === 'cancelled';
      }, 'the instance to be cancelled');
    });

    await t.step('the dependent step never runs', async () => {
      const marker = await client.exec('cat /tmp/markers/vanish');
      assertEquals(String(marker.data).includes('derived'), false);

      const steps = await client.execJson<{ status: string }>(`attrs ${instancePath}/steps/derive`);
      assertEquals(steps.status, 'skipped');
    });

    await t.step('and the deleted tree stays deleted', async () => {
      // Give any straggling write the time it would have needed to land.
      await new Promise((r) => setTimeout(r, 1000));

      assertEquals(await exists('/work/album'), false);
      assertEquals(await exists('/work/album/files/photo.bin'), false);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
