/**
 * `ui-notice` answers the first paragraph of the administrator's /etc/ui/notice.md, to the guest too
 * where visitors are asked to sign in: the sign-in page shows it before anyone has.
 */

import { assertEquals } from '@std/assert';
import type { UiNotice } from '@ein/api';
import { UI_NOTICE_PATH } from '@ein/paths';
import { createTestContext } from '@ein/testing';
import { firstParagraph } from '../commands/ui-notice.ts';

Deno.test('ui-notice: the first paragraph, its lines kept together', () => {
  assertEquals(
    firstParagraph('\n\nAn invented family.\nReset [every night](https://example.org).\n\nMore below.\n'),
    'An invented family.\nReset [every night](https://example.org).',
  );
  assertEquals(firstParagraph('One line\r\n  \r\nanother'), 'One line');
  assertEquals(firstParagraph(' \n\n '), '');
});

const testCtx = createTestContext({ boot: true });

Deno.test({ name: 'ui-notice', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const guest = await testCtx.server.createShellClient({ login: false });

  try {
    await t.step('nothing while there is no file', async () => {
      assertEquals(await admin.execJson<UiNotice>('ui-notice'), { markdown: null });
      assertEquals(await guest.execJson<UiNotice>('ui-notice'), { markdown: null });
    });

    await t.step("the administrator's note reaches the guest who must sign in, as it reaches everyone", async () => {
      await admin.exec('config set CFG_GUEST_BROWSING false');
      await admin.exec('mkdir -p /etc/ui');
      await admin.exec(`printf '%s\\n' 'Ask [Anna](https://example.org/anna) for an account.' '' 'Kept for the administrator.' > ${UI_NOTICE_PATH}`);
      assertEquals((await guest.exec('ls /etc')).success, false);
      const expected = { markdown: 'Ask [Anna](https://example.org/anna) for an account.' };
      assertEquals(await guest.execJson<UiNotice>('ui-notice'), expected);
      assertEquals(await admin.execJson<UiNotice>('ui-notice'), expected);
      assertEquals((await admin.execString('ui-notice', { json: false })).trim(), expected.markdown);
    });

    await t.step('an empty file is no note', async () => {
      await admin.exec(`printf '\\n' > ${UI_NOTICE_PATH}`);
      assertEquals(await guest.execJson<UiNotice>('ui-notice'), { markdown: null });
      assertEquals(await admin.execString('ui-notice', { json: false }), '');
    });
  } finally {
    await admin.exec(`rm -f ${UI_NOTICE_PATH}`);
    guest.close();
    admin.close();
  }
});
