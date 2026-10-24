/** A null resource reads as empty at once and takes any write whole, keeping nothing. */

import { assertEquals } from '@std/assert';
import { toText } from '@std/streams/to-text';
import { NullRegistry } from '../mod.ts';

Deno.test('NullRegistry', async (t) => {
  const registry = new NullRegistry();

  await t.step('a read ends at once', async () => {
    const handle = await registry.open('n', {}, 'r');
    assertEquals(await handle.read(1024), new Uint8Array(0));
    assertEquals(await toText(handle.readable), '');
    await handle.close();
  });

  await t.step('a write is accepted and not read back', async () => {
    const handle = await registry.open('n', {}, 'r+');
    assertEquals(await handle.write(new TextEncoder().encode('gone')), 4);
    assertEquals(await handle.read(1024), new Uint8Array(0));
    await handle.close();
  });
});
