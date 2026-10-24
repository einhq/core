/**
 * The open-instance ceiling is not a wall for a pipeline below its fair share.
 *
 * `tryClaimLeastLoaded` orders ready pipelines by how much of the ceiling they
 * hold, which is fair for slots that come free. A pipeline whose only step
 * waits on a pool that never answers frees none, so once it has borrowed the
 * whole ceiling the least-loaded ordering has nothing left to order: the
 * trigger loop parks, and a second pipeline is admitted only as its own
 * instances finish.
 *
 * So past the ceiling the engine keeps claiming for the pipelines that hold
 * less than `ceiling / definitions`, up to twice the ceiling in total. Two
 * pooled pipelines against a ceiling of 4: the hog fills it (plus the
 * in-flight overshoot), and the second one must still get its share of 2.
 */

import { PIPELINE_INSTANCES_PATH } from '../../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../lib/access/mod.ts';
import { SystemTestHarness } from '../../../testing/mod.ts';

const HOG_MIME = 'application/x-fair-share-hog';
const FAST_MIME = 'application/x-fair-share-fast';
const MAX_OPEN = 4;
const TRIGGER_CONCURRENCY = 1;
/** `ceil(MAX_OPEN / 2 definitions)`. */
const SHARE = 2;

const harness = new SystemTestHarness({
  ssh: false,
  boot: true,
  env: {
    CFG_PIPELINE_MAX_OPEN_INSTANCES: String(MAX_OPEN),
    CFG_PIPELINE_TRIGGER_CONCURRENCY: String(TRIGGER_CONCURRENCY),
  },
});

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'engine admits a pipeline below its fair share past the open-instance ceiling',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();

  const writeFile = async (path: string, body: string): Promise<void> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body + '\n'));
    } finally {
      await handle.close();
    }
  };

  const instances = async (pipeline: string): Promise<string[]> => {
    const res = await client.exec(`ls ${PIPELINE_INSTANCES_PATH}/${pipeline}`);
    return res.success ? res.data as string[] : [];
  };

  const define = async (name: string, mime: string): Promise<void> => {
    await client.exec(`mkfile /work/${name}.yaml`);
    await writeFile(
      `/work/${name}.yaml`,
      [
        `name: ${name}`,
        'trigger:',
        '  event: updated',
        '  nodeType: file',
        '  match:',
        `    mimetype: ${mime}`,
        'steps:',
        '  heavy:',
        // Never runs: nothing claims this pool for the length of the test, so
        // every admitted instance stays open.
        '    command: pool-never $NODE_PATH',
        '    pool: sharepool',
        '    kind: heavy',
      ].join('\n'),
    );
    assertEquals((await client.exec(`pipeline define /work/${name}.yaml`)).success, true);
  };

  const files = async (mime: string, prefix: string, count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      await client.exec(`mknode -t file --as "name=${prefix}${i}.bin" --as "mimetype=${mime}" /work/${prefix}${i}.bin`);
      await client.exec(`chmod 644 /work/${prefix}${i}.bin`);
    }
  };

  try {
    await client.exec('mkdir -p /work');
    await define('test-share-hog', HOG_MIME);
    await define('test-share-fast', FAST_MIME);

    await t.step('the hog borrows the whole ceiling', async () => {
      await files(HOG_MIME, 'h', 12);
      await waitFor(async () => (await instances('test-share-hog')).length >= MAX_OPEN, 'the ceiling to be reached');
      await new Promise((r) => setTimeout(r, 2000));
      const hog = (await instances('test-share-hog')).length;
      assertEquals(hog <= MAX_OPEN + TRIGGER_CONCURRENCY, true, `hog holds ${hog} with a ceiling of ${MAX_OPEN}`);
    });

    await t.step('a second pipeline still gets its share', async () => {
      await files(FAST_MIME, 'f', 6);
      await waitFor(async () => (await instances('test-share-fast')).length >= SHARE, 'the fair share to be admitted');
      await new Promise((r) => setTimeout(r, 2000));

      const fast = (await instances('test-share-fast')).length;
      const hog = (await instances('test-share-hog')).length;
      assertEquals(fast <= SHARE + TRIGGER_CONCURRENCY, true, `fast holds ${fast} with a share of ${SHARE}`);
      // The opening is for the pipeline below its share, never for the holder.
      assertEquals(hog <= MAX_OPEN + TRIGGER_CONCURRENCY, true, `hog grew to ${hog} past the ceiling`);
      assertEquals(fast + hog <= MAX_OPEN * 2, true, `${fast + hog} open instances against a hard cap of ${MAX_OPEN * 2}`);
    });
  } finally {
    await client.close();
    await harness.stop();
  }
});
