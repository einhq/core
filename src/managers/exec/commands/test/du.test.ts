/**
 * du command: logical file-byte totals across the tiered VFS.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { basename, dirname } from '@std/path';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import type { FileTier } from '../../../../registries/file/types.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import type { DuResult } from '../node/du.ts';

const testCtx = createTestContext({ rootMount: true });
const encoder = new TextEncoder();
let client: ShellClient;

Deno.test({
  name: 'du command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const writeFile = async (path: string, body: string, tier?: FileTier) => {
    await vfs.create(ADMIN_ACCESS, 'file', dirname(path), basename(path), {
      props: tier ? { tier } : undefined,
      attrs: { name: basename(path), mimetype: 'application/octet-stream', size: 0 },
    });
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    await handle.write(encoder.encode(body));
    await handle.close();
  };

  try {
    await cmd.shouldSucceed('mkdir -p /du/one/container');
    await cmd.shouldSucceed('mkdir -p /du/two');
    await writeFile('/du/one/disk.bin', 'abc');
    await writeFile('/du/one/volatile.bin', 'x'.repeat(2048), 'volatile');
    await writeFile('/du/one/container/db.bin', '12345', 'db');
    await writeFile('/du/two/tiny.bin', 'tiny');
    await vfs.update(ADMIN_ACCESS, '/du/one/container', { attrs: { size: 999_999 } });
    await cmd.shouldSucceed('ln /du/one/disk.bin /du/one/disk-hard');
    await cmd.shouldSucceed('ln -s /du/one/volatile.bin /du/one/volatile-soft');

    await t.step('summarizes expanded structures and totals every storage tier', async () => {
      const result = await client.execJson<DuResult>('du -cs /du/*');
      assertEquals(result.entries, [
        { path: '/du/one', size: 2056 },
        { path: '/du/two', size: 4 },
      ]);
      assertEquals(result.total, 2060);
    });

    await t.step('clustered -chs flags produce human-readable text', async () => {
      const output = await client.execString('export JSON_OUTPUT=0\ndu -chs /du/*');
      assertEquals(output, '2.0 KB\t/du/one\n4 B\t/du/two\n2.0 KB\ttotal\n');
    });

    await t.step('counts file nodes once per structure and ignores other node sizes and softlinks', async () => {
      const expanded = await client.execJson<DuResult>('du /du/one');
      assertEquals(expanded.entries, [
        { path: '/du/one/container', size: 5 },
        { path: '/du/one', size: 2056 },
      ]);

      const links = await client.execJson<DuResult>('du /du/one/disk.bin /du/one/disk-hard /du/one/volatile-soft');
      assertEquals(links.entries, [
        { path: '/du/one/disk.bin', size: 3 },
        { path: '/du/one/disk-hard', size: 3 },
        { path: '/du/one/volatile-soft', size: 0 },
      ]);
    });

    await t.step('reports unreadable operands', async () => {
      const result = await client.exec('du -s /du/two /missing');
      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', "du: cannot read '/missing'");
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
