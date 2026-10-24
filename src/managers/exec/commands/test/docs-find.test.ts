/** `docs find` asks the command `CFG_COMMAND_FINDER` names, and with none matches commands by their words. */
import { assertEquals } from '@std/assert';
import type { CommandFind } from '../../../../lib/api/docs.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({ name: 'docs find', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  try {
    await t.step('without a finder, commands are matched by their words', async () => {
      const { hits } = await client.execJson<CommandFind>("docs find 'restart a service' --limit 5");
      assertEquals(hits.length > 0 && hits.length <= 5, true, JSON.stringify(hits));
      assertEquals(hits[0].name.includes('service'), true, JSON.stringify(hits));
      assertEquals((await client.execJson<CommandFind>("docs find 'xyzzy plugh'")).hits, []);
    });

    await t.step('with one, its hits are the answer, and the limit is passed on', async () => {
      await client.exec('mkdir -p /opt/bin && mkfile /opt/bin/fake-find && chmod 755 /opt/bin/fake-find');
      const handle = await vfs.open(ADMIN_ACCESS, '/opt/bin/fake-find', { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(`echo "{\\"hits\\":[{\\"name\\":\\"service\\",\\"effect\\":\\"write\\",\\"score\\":$4}]}"\n`));
      } finally {
        await handle.close();
      }
      await client.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
      await client.exec(`mkdir -p /etc/config.d && echo "export CFG_COMMAND_FINDER='fake-find'" > /etc/config.d/fake`);
      const finder = await testCtx.server.createShellClient();
      try {
        assertEquals(await finder.execJson<CommandFind>("docs find 'restart a service' --limit 3"), { hits: [{ name: 'service', effect: 'write', score: 3 }] });
      } finally {
        finder.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
