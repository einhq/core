/**
 * `renditions` answers the table in `/etc/renditions.yaml`, to anyone signed in: as JSON for the
 * shell's pages, as a line per role for a person. What the file gets wrong is left out and said
 * on stderr, and no file is no renditions.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../../lib/access/mod.ts';
import { NO_RENDITIONS, type RenditionTable } from '../../../../../lib/api/renditions.ts';
import { RENDITIONS_PATH } from '../../../../../lib/paths.ts';
import { createTestContext } from '../../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

const TABLE = `
image:
  thumb: { width: 320, height: 320, fit: cover, quality: 55 }
  large: { width: 2560, height: 2560, fit: contain, quality: 60, kinds: [photo] }
  broken: { width: 10, fit: contain, quality: 60 }
video:
  playback: { width: 1920, height: 1080, crf: 32, preset: 8, audioBitrate: 128k }
`;

Deno.test({
  name: 'renditions answers the rendition table',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const writeTable = async (text: string) => {
    await vfs.ensure(ADMIN_ACCESS, 'file', '/etc', 'renditions.yaml');
    const handle = await vfs.open(ADMIN_ACCESS, RENDITIONS_PATH, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(text));
    } finally {
      await handle.close();
    }
  };

  try {
    await t.step('no file is no renditions', async () => {
      await vfs.unlink(ADMIN_ACCESS, RENDITIONS_PATH, '/etc').catch(() => false);
      assertEquals(await client.execJson<RenditionTable>('renditions'), NO_RENDITIONS);
    });

    await t.step('the table, without the entry the file gets wrong', async () => {
      await writeTable(TABLE);
      const table = await client.execJson<RenditionTable>('renditions');
      assertEquals(Object.keys(table.image), ['thumb', 'large']);
      assertEquals(table.image.thumb.kinds, ['photo', 'video', 'audio']);
      assertEquals(table.video.playback.audioBitrate, '128k');

      const text = await client.exec('renditions 2>&1', { json: false });
      assertEquals(text.success, true);
      assertStringIncludes(String(text.data), '320x320.avif');
      assertStringIncludes(String(text.data), '1920x1080.mp4');
      assertStringIncludes(String(text.data), 'image.broken: needs a width and a height above 0, left out');
    });
  } finally {
    await testCtx.teardown();
  }
});
