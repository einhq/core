/**
 * `stream-page` asks the command `CFG_PAGE_STREAMER` names for a page as live video, and refuses
 * without one, so "Show on" offers a screen near the browser only where a module renders pages. A
 * path in one of EiN's folders is a file, not a page, and is refused before the streamer is asked.
 * `--press`, `--state` and `--message` hand the stream's id and what follows to the command
 * `CFG_PAGE_CONTROL` names, and are refused without one.
 */
import { assertEquals, assertStringIncludes } from '@std/assert';
import type { ScreenState, StreamedPage } from '../../../../lib/api/devices.ts';
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
            `[ "$1" = press ] && echo "$2 $3 $4" > /tmp/pressed && exit 0\n` +
              `[ "$1" = state ] && echo '{"title":"IMG_0001.jpg","position":"3 of 31"}' && exit 0\n` +
              `[ "$1" = message ] && echo "$2 $3" > /tmp/told && exit 0\n` +
              `[ "$1" = start ] && [ "$2" = '/media?q=sailboat&slideshow=screen' ] && echo '{"id":"page-1","path":"/live/abc","remote":"/live/def/screen.mp4","hls":"/live/def/index.m3u8"}'\n`,
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
          id: 'page-1',
          path: '/live/abc',
          remote: '/live/def/screen.mp4',
          hls: '/live/def/index.m3u8',
        });
        const file = await streamer.exec('stream-page /opt/bin/fake-stream');
        assertEquals(file.success, false);
        assertStringIncludes(file.error ?? '', 'names a file, not a page');
        const unset = await streamer.exec('stream-page --press page-1 ArrowRight');
        assertEquals(unset.success, false);
        assertStringIncludes(unset.error ?? '', 'CFG_PAGE_CONTROL');
      } finally {
        streamer.close();
      }
    });

    await t.step('--press, --state and --message go to the command CFG_PAGE_CONTROL names', async () => {
      await client.exec(`echo "export CFG_PAGE_CONTROL='fake-stream'" >> /etc/config.d/fake`);
      const presser = await testCtx.server.createShellClient();
      try {
        assertEquals((await presser.exec('stream-page --press page-1 ArrowRight Space')).success, true);
        assertEquals(String((await presser.exec('cat /tmp/pressed')).data).trim(), 'page-1 ArrowRight Space');
        assertEquals((await presser.exec('stream-page --press page-1')).success, false);
        assertEquals(await presser.execJson<ScreenState>('stream-page --state page-1'), { title: 'IMG_0001.jpg', position: '3 of 31' });
        assertEquals((await presser.exec(`stream-page --message page-1 '{"seek":80}'`)).success, true);
        assertEquals(String((await presser.exec('cat /tmp/told')).data).trim(), 'page-1 {"seek":80}');
        assertEquals((await presser.exec('stream-page --message page-1 80')).success, false);
      } finally {
        presser.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
