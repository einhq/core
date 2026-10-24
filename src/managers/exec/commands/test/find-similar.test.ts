/** `find-similar`: the nearest embeddings of the same type, nearest first, as JSON with their paths. */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import type { SimilarAnswer } from '../../../../lib/api/mod.ts';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({ name: 'find-similar', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** An embedding of type `look` holding `values`, at `/vectors/<name>/vector`. */
  const vector = async (name: string, values: number[]) => {
    await vfs.ensure(ADMIN_ACCESS, 'directory', '/vectors', name);
    await vfs.create(ADMIN_ACCESS, 'embedding', `/vectors/${name}`, 'vector', { attrs: { embeddingType: 'look', capacity: values.length } });
    const handle = await vfs.open(ADMIN_ACCESS, `/vectors/${name}/vector`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(values)));
    } finally {
      await handle.close();
    }
  };

  try {
    await vfs.ensure(ADMIN_ACCESS, 'directory', '/', 'vectors');
    await vector('red', [1, 0, 0]);
    await vector('reddish', [0.9, 0.2, 0]);
    await vector('blue', [0, 0, 1]);

    await t.step('answers the nearest first, with where each is linked', async () => {
      const { hits } = await client.execJson<SimilarAnswer>('find-similar /vectors/red/vector --limit 2');
      assertEquals(hits.length, 2);
      assertEquals(hits[0].paths, ['/vectors/red/vector']);
      assertEquals(hits[1].paths, ['/vectors/reddish/vector']);
      assert(hits[0].similarity >= hits[1].similarity);
    });

    await t.step('refuses a limit that is not a positive whole number', async () => {
      await cmd.shouldFail('find-similar /vectors/red/vector --limit 0');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
