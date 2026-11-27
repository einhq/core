/**
 * `gzip` compresses a file into FILE.gz and `gunzip` back, replacing it unless `-k`; `-c` and stdin
 * write to stdout; a copy already there is left unless `-f`; several gzip members one after another
 * read as one stream; and bytes that are not gzip fail without leaving a part behind.
 */

import { assertEquals, assertMatch } from '@std/assert';
import { gunzipSync } from 'node:zlib';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({
  name: 'gzip and gunzip',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const put = async (path: string, bytes: Uint8Array) => {
    await cmd.shouldSucceed(`mkfile '${path}'`);
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  };
  const bytesOf = async (path: string): Promise<Uint8Array> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
    try {
      return new Uint8Array(await new Response(handle.readable).arrayBuffer());
    } finally {
      await handle.close().catch(() => {});
    }
  };
  const exists = (path: string) => vfs.exists(ADMIN_ACCESS, path);

  const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => (i % 251) ^ (i >> 10));

  try {
    await cmd.shouldSucceed('mkdir -p /g');
    await put('/g/karta.bin', bytes);

    await t.step('gzip -k writes FILE.gz beside the file; gunzip -c reads it back', async () => {
      await cmd.shouldSucceed('gzip -k -9 /g/karta.bin');
      assertEquals(await exists('/g/karta.bin'), true);
      const compressed = await bytesOf('/g/karta.bin.gz');
      assertEquals(new Uint8Array(gunzipSync(compressed)), bytes);

      await cmd.shouldSucceed('gunzip -c /g/karta.bin.gz > /g/tillbaka.bin');
      assertEquals(await bytesOf('/g/tillbaka.bin'), bytes);
    });

    await t.step('a copy already there is left unless -f', async () => {
      const result = await cmd.shouldFail('gunzip /g/karta.bin.gz');
      assertMatch(String(result.error), /karta\.bin already exists; -f writes over it/);
      assertEquals(await exists('/g/karta.bin.gz'), true);

      await cmd.shouldSucceed('rm /g/karta.bin && gunzip /g/karta.bin.gz');
      assertEquals(await exists('/g/karta.bin.gz'), false);
      assertEquals(await bytesOf('/g/karta.bin'), bytes);
      const node = await vfs.get(ADMIN_ACCESS, '/g/karta.bin');
      assertEquals(node.attrs.size, bytes.length);
      assertMatch(String(node.attrs.sha256), /^[0-9a-f]{64}$/);
    });

    await t.step('gzip replaces the file; .tgz decompresses to .tar', async () => {
      await cmd.shouldSucceed('gzip /g/karta.bin');
      assertEquals(await exists('/g/karta.bin'), false);
      await cmd.shouldSucceed('mv /g/karta.bin.gz /g/karta.tgz && gunzip /g/karta.tgz');
      assertEquals(await bytesOf('/g/karta.tar'), bytes);
      assertMatch(String((await cmd.shouldFail('gunzip /g/karta.tar')).error), /unknown suffix/);
    });

    await t.step('stdin to stdout, and several members one after another', async () => {
      await cmd.shouldSucceed('cat /g/karta.tar | gzip | gunzip > /g/rör.bin');
      assertEquals(await bytesOf('/g/rör.bin'), bytes);

      await put('/g/a.txt', new TextEncoder().encode('Anna Andersson\n'));
      await put('/g/b.txt', new TextEncoder().encode('seglade till ön\n'));
      await cmd.shouldSucceed('gzip /g/a.txt /g/b.txt && cat /g/a.txt.gz /g/b.txt.gz | gunzip > /g/båda.txt');
      assertEquals(new TextDecoder().decode(await bytesOf('/g/båda.txt')), 'Anna Andersson\nseglade till ön\n');
    });

    await t.step('bytes that are not gzip fail and leave no part behind', async () => {
      await put('/g/trasig.gz', new TextEncoder().encode('not gzip at all'));
      await cmd.shouldFail('gunzip /g/trasig.gz');
      assertEquals(await exists('/g/trasig'), false);
      assertEquals(await exists('/g/trasig.gz'), true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
