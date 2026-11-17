/**
 * `stream-page` asks the command `CFG_PAGE_STREAMER` names for a page as live video, and refuses
 * without one, so "Show on" offers a screen near the browser only where a module renders pages. A
 * path in one of EiN's folders is a file, not a page, and is refused before the streamer is asked.
 */
import { assertEquals, assertStringIncludes } from '@std/assert';
import type { StreamedPage } from '../../../../lib/api/devices.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({ name: 'stream-page', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  try {
    await t.step('without a streamer it is refused', async () => {
      const run = await client.exec('stream-page /dashboard-wall/Kitchen');
      assertEquals(run.success, false);
      assertStringIncludes(run.error ?? '', 'CFG_PAGE_STREAMER');
    });

    await t.step("with one, the stream's paths are the answer, and the route is passed on whole", async () => {
      await client.exec('mkdir -p /opt/bin');
      await client.exec('mkfile /opt/bin/fake-stream && chmod 755 /opt/bin/fake-stream');
      const handle = await vfs.open(ADMIN_ACCESS, '/opt/bin/fake-stream', { mode: 'w' });
      try {
        await handle.write(
          new TextEncoder().encode(
            `[ "$1" = start ] && [ "$2" = '/media?q=sailboat&slideshow=screen' ] && echo '{"path":"/live/abc","remote":"/live/def/screen.mp4","hls":"/live/def/index.m3u8"}'\n`,
          ),
        );
      } finally {
        await handle.close();
      }
      await client.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
      // What a module's etc/config becomes once mod setup has linked it.
      await client.exec(`mkdir -p /etc/config.d && echo "export CFG_PAGE_STREAMER='fake-stream start'" > /etc/config.d/fake`);

      const streamer = await testCtx.server.createShellClient();
      try {
        assertEquals(await streamer.execJson<StreamedPage>("stream-page '/media?q=sailboat&slideshow=screen'"), {
          path: '/live/abc',
          remote: '/live/def/screen.mp4',
          hls: '/live/def/index.m3u8',
        });
        const file = await streamer.exec('stream-page /opt/bin/fake-stream');
        assertEquals(file.success, false);
        assertStringIncludes(file.error ?? '', 'names a file, not a page');
      } finally {
        streamer.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
