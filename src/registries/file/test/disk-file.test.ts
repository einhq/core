import { assertEquals, assertRejects } from '@std/assert';
import { binaryConformanceTests } from '../../test/binary-conformance.ts';
import type { ResourceOptions } from '../../types.ts';
import { DiskFileRegistry } from '../mod.ts';

binaryConformanceTests('DiskFileRegistry conformance', async () => {
  const root = await Deno.makeTempDir({ prefix: 'mrx-disk-file-' });
  const registry = new DiskFileRegistry({ rootPath: root });
  await registry.init();

  return {
    registry,
    teardown: async () => {
      await registry.dispose();
      await Deno.remove(root, { recursive: true });
    },
  };
}, { times: true });

Deno.test('DiskFileRegistry: touch keeps a frozen file read-only and gives the owner write back when lifted', async () => {
  const root = await Deno.makeTempDir({ prefix: 'mrx-disk-frozen-' });
  const registry = new DiskFileRegistry({ rootPath: root });
  await registry.init();
  const id = '01JFX7Q2M8K4T6V9B3N5R0WD1C';
  const path = `${root}/1C/${id}`;
  const mode = async (p: string) => (await Deno.lstat(p)).mode! & 0o777;

  try {
    assertEquals(await registry.touch(id, {}), true);
    await Deno.chmod(path, 0o664);

    assertEquals(await registry.touch(id, { frozen: true } as ResourceOptions), false);
    assertEquals(await mode(path), 0o444);
    // Root writes whatever the mode
    if (Deno.uid() !== 0) await assertRejects(() => Deno.open(path, { write: true }), Deno.errors.PermissionDenied);

    await registry.touch(id, {});
    assertEquals(await mode(path), 0o644);

    // A file created frozen is read-only from the start
    const frozenId = '01JFX7Q3A2P9S4D8F6G1J5K07H';
    await registry.touch(frozenId, { frozen: true } as ResourceOptions);
    assertEquals((await mode(`${root}/7H/${frozenId}`)) & 0o222, 0);

    // Bytes kept elsewhere, behind a symlink, are not changed
    const outside = `${root}/outside.jpg`;
    await Deno.writeTextFile(outside, 'old');
    await Deno.chmod(outside, 0o644);
    const linkedId = '01JG2B8E5C7X1Z3V6N9M4Q2R7H';
    await Deno.mkdir(`${root}/7H`, { recursive: true });
    await Deno.symlink(outside, `${root}/7H/${linkedId}`);
    assertEquals(await registry.touch(linkedId, { frozen: true } as ResourceOptions), false);
    assertEquals(await mode(outside), 0o644);
  } finally {
    await registry.dispose();
    await Deno.remove(root, { recursive: true });
  }
});
