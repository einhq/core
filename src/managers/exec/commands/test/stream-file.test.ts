/**
 * `stream-file` asks the command `CFG_FILE_STREAMER` names to make a recording, video or picture for a screen
 * near the browser, to renew it and to let go of it, and refuses without one, so "Show on" offers a
 * screen near the browser for a file only where a module makes them.
 */
import { assertEquals, assertStringIncludes } from '@std/assert';
import type { StreamedFile } from '../../../../lib/api/devices.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({ name: 'stream-file', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  try {
    await t.step('without a streamer it is refused', async () => {
      const run = await client.exec('stream-file /films/boat.mp4');
      assertEquals(run.success, false);
      assertStringIncludes(run.error ?? '', 'CFG_FILE_STREAMER');
    });

    await t.step('one path, or one id to renew or stop', async () => {
      for (const args of ['', 'films/boat.mp4', '/a /b', '/a --renew x', '--renew x --stop y']) {
        const run = await client.exec(`stream-file ${args}`);
        assertEquals(run.success, false, args);
        assertStringIncludes(run.error ?? '', 'usage: stream-file', args);
      }
    });

    await t.step('with one, its answer is passed on, and renew and stop are passed to it with the id', async () => {
      await client.exec('mkdir -p /opt/bin');
      await client.exec('mkfile /opt/bin/fake-files && chmod 755 /opt/bin/fake-files');
      const handle = await vfs.open(ADMIN_ACCESS, '/opt/bin/fake-files', { mode: 'w' });
      try {
        await handle.write(
          new TextEncoder().encode(
            [
              `[ "$1" = start ] && [ "$2" = '/films/a boat.mp4' ] && echo '{"id":"near-1","url":"/file/films/a%20boat.mp4?ticket=t","type":"video/mp4","title":"a boat.mp4","captions":"/file/films/a%20boat.mp4/metadata/transcript?ticket=c"}' && exit 0`,
              `[ "$1" = renew ] && [ "$2" = near-1 ] && exit 0`,
              `[ "$1" = stop ] && [ "$2" = near-1 ] && exit 0`,
              `echo "fake-files: $2: none of yours" >&2`,
              'exit 1',
              '',
            ].join('\n'),
          ),
        );
      } finally {
        await handle.close();
      }
      await client.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
      // What a module's etc/config becomes once mod setup has linked it.
      await client.exec(`mkdir -p /etc/config.d && echo "export CFG_FILE_STREAMER='fake-files'" > /etc/config.d/fake`);

      const streamer = await testCtx.server.createShellClient();
      try {
        assertEquals(await streamer.execJson<StreamedFile>("stream-file '/films/a boat.mp4'"), {
          id: 'near-1',
          url: '/file/films/a%20boat.mp4?ticket=t',
          type: 'video/mp4',
          title: 'a boat.mp4',
          captions: '/file/films/a%20boat.mp4/metadata/transcript?ticket=c',
        });
        assertEquals((await streamer.exec('stream-file --renew near-1')).success, true);
        assertEquals((await streamer.exec('stream-file --stop near-1')).success, true);
        const gone = await streamer.exec('stream-file --renew near-2');
        assertEquals(gone.success, false);
        assertStringIncludes(gone.error ?? '', 'stream-file: near-2: none of yours');
      } finally {
        streamer.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
