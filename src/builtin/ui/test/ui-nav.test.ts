/**
 * `ui-nav` reads the fragments in /etc/ui/nav.d and the two overlays from the VFS. The merge
 * rules themselves are nav.test.ts's; this is the files: which are read, in what order, and
 * that a broken one is a warning rather than a broken sidebar.
 */

import { assertEquals } from '@std/assert';
import { UI_NAV_D_PATH, UI_NAV_PATH } from '@ein/paths';
import { createTestContext, type ShellClient } from '@ein/testing';
import type { UiNav } from '@ui/nav';

const testCtx = createTestContext();

Deno.test({ name: 'ui-nav', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const write = (path: string, value: unknown) => client.exec(`echo ${JSON.stringify(JSON.stringify(value))} > ${path}`);

  try {
    await t.step('with nothing configured the navigation is empty', async () => {
      assertEquals(await client.execJson<UiNav>('ui-nav'), { sections: [], topbar: [], panels: [], warnings: [] });
    });

    await t.step('fragments, then the administrator, then the user', async () => {
      await client.exec(`mkdir -p ${UI_NAV_D_PATH}`);
      await write(`${UI_NAV_D_PATH}/ui.json`, {
        sections: [{ id: 'main' }],
        sidebar: [{ id: 'ui.home', section: 'main', label: 'Home', icon: 'home', to: '/' }, { id: 'ui.media', section: 'main', label: 'Media', icon: 'photo', to: '/media' }],
        topbar: [{ id: 'ui.chat', title: 'Chat', icon: 'message-circle', action: { drawer: '/chat' } }],
      });
      await write(`${UI_NAV_D_PATH}/broken.json`, 'not json');
      await client.exec(`echo '{' > ${UI_NAV_D_PATH}/syntax.json`);
      await write(UI_NAV_PATH, { sidebar: [{ id: 'ui.media', label: 'Pictures' }] });
      const home = `${(await client.exec('echo $HOME')).data}`.trim();
      await client.exec(`mkdir -p ${home}/.ui`);
      await write(`${home}/.ui/nav.json`, { hide: ['ui.chat'], sidebar: [{ id: 'ui.media', order: 1 }] });

      const nav = await client.execJson<UiNav>('ui-nav');
      assertEquals(nav.sections.map((s) => s.items.map((i) => [i.id, i.label])), [[['ui.media', 'Pictures'], ['ui.home', 'Home']]]);
      assertEquals(nav.topbar, []);
      assertEquals(nav.warnings.length, 2, nav.warnings.join('\n'));
      assertEquals(nav.warnings[0].startsWith(`${UI_NAV_D_PATH}/syntax.json: `), true, nav.warnings[0]);
      assertEquals(nav.warnings[1], 'broken: not a navigation object');
    });

    await t.step('the guest is not given what is for someone signed in', async () => {
      await write(`${UI_NAV_D_PATH}/own.json`, {
        sidebar: [{ id: 'own.favourites', section: 'main', label: 'Favourites', icon: 'heart', to: '/favourites', signedIn: true }],
      });
      const signedIn = await client.execJson<UiNav>('ui-nav');
      assertEquals(signedIn.sections.flatMap((s) => s.items.map((i) => i.id)).includes('own.favourites'), true);

      // The guest is given a navigation where visitors may browse.
      await client.execString('config set CFG_GUEST_BROWSING true');
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        const nav = await guest.execJson<UiNav>('ui-nav');
        // Without the signed-in reader's own overlay, which put Media first.
        assertEquals(nav.sections.map((s) => s.items.map((i) => i.id)), [['ui.home', 'ui.media']]);
      } finally {
        guest.close();
        await client.execString('config unset CFG_GUEST_BROWSING');
      }
    });
  } finally {
    await testCtx.teardown();
  }
});
