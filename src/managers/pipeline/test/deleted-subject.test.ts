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
 *
 * A step that fails because its node went while it ran, inline or pooled, is
 * skipped rather than failed or retried, cancels the instance, and logs no error.
 */

import { PIPELINE_INSTANCES_PATH, POOLS_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';
import { TARGET_MISSING } from '../types.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testvanish';
const INLINE_FAIL_MIME = 'application/x-testvanish-inline';
const POOLED_FAIL_MIME = 'application/x-testvanish-pooled';

/** A pipeline of one step, `fail`, on files of `mime`; `pool` makes it a pooled step. */
function failingPipeline(name: string, mime: string, pool?: string): string {
  return [
    `name: ${name}`,
    'description: deleted-subject failure fixture',
    '',
    'trigger:',
    '  event: updated',
    '  nodeType: file',
    '  filter: |',
    '    case "$MIMETYPE" in',
    `      ${mime}) exit 0;;`,
    '      *) exit 1;;',
    '    esac',
    '',
    'steps:',
    '  fail:',
    '    command: vanish-fail $NODE_PATH',
    ...(pool ? [`    pool: ${pool}`, '    kind: vanish'] : []),
    '',
    'options:',
    '  maxAttempts: 3',
  ].join('\n');
}

type StepAttrs = { status: string; error?: string; attempts?: number };

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
    // `fail` marks that it started, gives the test time to delete its node, and then fails
    // reading it — what a step meets when its photo is deleted during ingest.
    await client.exec('mkfile /opt/steps/vanish-fail && chmod 755 /opt/steps/vanish-fail');
    await writeFile(vfs, '/opt/steps/vanish-fail', 'echo started >> "/tmp/markers/$(basename "$1")"\nsleep 3\ninfo "$1" > /dev/null');
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

    /**
     * Start the failing pipeline `name` on a new file of `mime` under `dir`, delete `dir` once its
     * step has started, and return the instance path once the instance has ended, with what was
     * logged as an error meanwhile.
     */
    const deleteWhileFailing = async (name: string, mime: string, dir: string): Promise<{ instance: string; errors: string[] }> => {
      await client.exec(`mkdir -p ${dir}`);
      await client.exec(`mknode -t file --as "name=${name}.bin" --as "mimetype=${mime}" ${dir}/${name}.bin`);
      const node = await vfs.get(ADMIN_ACCESS, `${dir}/${name}.bin`);
      const instance = `${PIPELINE_INSTANCES_PATH}/${name}/${node.id}`;

      const original = console.error;
      const errors: string[] = [];
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
      try {
        await client.exec(`chmod 644 ${dir}/${name}.bin`);
        await waitFor(async () => (await client.exec(`cat /tmp/markers/${name}.bin`)).success, `${name}'s step to start`);
        assertEquals((await client.exec(`rm -rf ${dir}`)).success, true);
        await waitFor(async () => {
          const attrs = await client.exec(`JSON_OUTPUT=1 attrs ${instance}`);
          const status = attrs.success ? (attrs.data as { status?: string }).status : undefined;
          return status !== undefined && status !== 'running' && status !== 'queued';
        }, `${name}'s instance to end`);
      } finally {
        console.error = original;
      }

      return { instance, errors };
    };

    await t.step('an inline step failing on its deleted node is skipped, not retried', async () => {
      await client.exec('mkfile /work/test-vanish-inline.yaml');
      await writeFile(vfs, '/work/test-vanish-inline.yaml', failingPipeline('test-vanish-inline', INLINE_FAIL_MIME));
      assertEquals((await client.exec('pipeline define /work/test-vanish-inline.yaml')).success, true);

      const { instance, errors } = await deleteWhileFailing('test-vanish-inline', INLINE_FAIL_MIME, '/work/inline');

      assertEquals((await client.execJson<{ status: string }>(`attrs ${instance}`)).status, 'cancelled');
      const step = await client.execJson<StepAttrs>(`attrs ${instance}/steps/fail`);
      assertEquals([step.status, step.error, step.attempts], ['skipped', TARGET_MISSING, 1]);
      assertEquals(errors.filter((line) => line.includes('[ERROR]') && line.includes('test-vanish-inline')), []);
    });

    await t.step('a pooled step failing on its deleted node is skipped, not retried', async () => {
      await client.exec('mkdir -p /opt/vanishpool-worker && mkfile /opt/vanishpool-worker/start.sh && chmod 755 /opt/vanishpool-worker/start.sh');
      await writeFile(vfs, '/opt/vanishpool-worker/start.sh', `pipeline-worker --pool ${POOLS_PATH}/vanishpool --concurrency 1`);
      await client.exec('mkfile /work/test-vanish-pooled.yaml');
      await writeFile(vfs, '/work/test-vanish-pooled.yaml', failingPipeline('test-vanish-pooled', POOLED_FAIL_MIME, 'vanishpool'));
      assertEquals((await client.exec('pipeline define /work/test-vanish-pooled.yaml')).success, true);
      await waitFor(async () => (await client.exec(`info ${POOLS_PATH}/vanishpool`)).success, 'the pool to be created');
      assertEquals(
        (await client.exec('service add vanishpool-worker /opt/vanishpool-worker && service enable vanishpool-worker && service start vanishpool-worker')).success,
        true,
      );

      const { instance, errors } = await deleteWhileFailing('test-vanish-pooled', POOLED_FAIL_MIME, '/work/pooled');

      assertEquals((await client.execJson<{ status: string }>(`attrs ${instance}`)).status, 'cancelled');
      const step = await client.execJson<StepAttrs>(`attrs ${instance}/steps/fail`);
      assertEquals([step.status, step.error, step.attempts], ['skipped', TARGET_MISSING, 1]);
      const counts = (await client.execJson<{ counts: Record<string, number> }>(`pool stat ${POOLS_PATH}/vanishpool`)).counts;
      assertEquals([counts.done, counts.ready ?? 0], [1, 0]);
      assertEquals(errors.filter((line) => line.includes('[ERROR]') && line.includes('test-vanish-pooled')), []);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
