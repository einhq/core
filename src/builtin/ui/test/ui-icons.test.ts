/**
 * `ui-icons` answers many icons in one call, outline and filled, with null for a name it has
 * none of. Run against a stand-in for core's files: the real icons exist only in a built
 * shell.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '@ein/testing';

const testCtx = createTestContext();

Deno.test({ name: 'ui-icons', sanitizeResources: false, sanitizeOps: false }, async () => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const root = `/tmp/ui-icons-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await client.exec(`mkdir -p ${root}/ui/ui/icons/tabler/outline ${root}/ui/ui/icons/tabler/filled`);
    await client.exec(`echo '<svg a/>' > ${root}/ui/ui/icons/tabler/outline/map-pin.svg && echo '<svg b/>' > ${root}/ui/ui/icons/tabler/filled/heart.svg`);
    const icons = await client.execJson<Record<string, string | null>>(`LIB_PATH=${root} ui-icons map-pin heart-filled nope ../x map-pin`);
    assertEquals(Object.fromEntries(Object.entries(icons).map(([name, svg]) => [name, svg?.trim() ?? null])), {
      'map-pin': '<svg a/>',
      'heart-filled': '<svg b/>',
      'nope': null,
      '../x': null,
    });
  } finally {
    await testCtx.teardown();
  }
});
