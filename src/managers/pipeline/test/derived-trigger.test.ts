/**
 * A derived file never triggers a pipeline unless the pipeline asks for it.
 *
 * Renditions and `versions/` members are the same picture as the file they hang
 * off, so indexing them duplicates every description and every face. The
 * invariant lives in the guard chain, where no emitting path can get around it.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { type ShellClient, SystemTestHarness } from '../../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const TEST_MIME = 'application/x-testderived';

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function instanceIds(client: ShellClient, pipeline: string): Promise<string[]> {
  const result = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/${pipeline}`);
  if (!result.success) return [];
  return await client.execJson<string[]>(`ls ${PIPELINE_INSTANCES_PATH}/${pipeline}`);
}

Deno.test({
  name: 'derived files are excluded from triggers unless allowDerived',
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

  const define = async (name: string, allowDerived: boolean) => {
    const yaml = [
      `name: ${name}`,
      'description: derived-exclusion fixture',
      '',
      'trigger:',
      '  event: updated',
      '  nodeType: file',
      '  match:',
      `    mimetype: ${TEST_MIME}`,
      ...(allowDerived ? ['  allowDerived: true'] : []),
      '',
      'steps:',
      '  noop:',
      '    command: echo ran',
    ].join('\n');
    await client.exec(`mkfile /work/${name}.yaml`);
    await writeFile(`/work/${name}.yaml`, yaml);
    await client.exec(`pipeline define /work/${name}.yaml`);
  };

  try {
    await client.exec('mkdir -p /work');
    await define('test-derived-excluded', false);
    await define('test-derived-allowed', true);

    // The original: a plain file node with no `sourceId`.
    await client.exec(`mknode -t file --as "name=orig.bin" --as "mimetype=${TEST_MIME}" /work/orig.bin`);
    await client.exec('chmod 644 /work/orig.bin');
    const originalId = (await vfs.get(ADMIN_ACCESS, '/work/orig.bin')).id;

    await t.step('an original triggers both pipelines', async () => {
      await waitFor(async () => (await instanceIds(client, 'test-derived-excluded')).length === 1, 'excluded-pipeline instance');
      await waitFor(async () => (await instanceIds(client, 'test-derived-allowed')).length === 1, 'allowed-pipeline instance');
      assertEquals(await instanceIds(client, 'test-derived-excluded'), [originalId]);
    });

    await t.step('a derived file triggers only the pipeline that opted in', async () => {
      // Same shape as a `versions/` member: linked anywhere, marked by sourceId.
      await client.exec(
        `mknode -t file --as "name=raw.bin" --as "mimetype=${TEST_MIME}" --as "sourceId=${originalId}" /work/raw.bin`,
      );
      await client.exec('chmod 644 /work/raw.bin');
      const derivedId = (await vfs.get(ADMIN_ACCESS, '/work/raw.bin')).id;

      await waitFor(async () => (await instanceIds(client, 'test-derived-allowed')).length === 2, 'allowed-pipeline second instance');

      // The opted-in pipeline saw it; the default one did not, and its verdict is
      // stable rather than merely late — the allowed pipeline reaching two proves
      // the event was dispatched to the whole definition loop.
      assertEquals((await instanceIds(client, 'test-derived-allowed')).includes(derivedId), true);
      assertEquals(await instanceIds(client, 'test-derived-excluded'), [originalId]);
    });
  } finally {
    await harness.stop();
  }
});
