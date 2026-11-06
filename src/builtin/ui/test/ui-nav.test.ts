/**
 * `ui-nav` reads the fragments in /etc/ui/nav.d and the groups' homes, and the overlays, from the VFS. The merge
 * rules themselves are nav.test.ts's; this is the files: which are read, in what order, and
 * that a broken one is a warning rather than a broken sidebar.
 */

import { assertEquals } from '@std/assert';
import { GUEST_ACCESS } from '../../../lib/access/constants.ts';
import { groupHomePath, HOME_UI_NAV_D, HOME_UI_NAV_FILE, UI_NAV_D_PATH, UI_NAV_PATH } from '@ein/paths';
import { createTestContext, type ShellClient } from '@ein/testing';
import type { NavLayer, UiNav } from '@ui/nav';
import { READ_OWN_NAV, resetArrangement, writeOwnNavScript } from '../src/client/lib/nav-arrange.ts';

const testCtx = createTestContext();

Deno.test({ name: 'ui-nav', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const write = (path: string, value: unknown) => client.exec(`echo ${JSON.stringify(JSON.stringify(value))} > ${path}`);

  try {
    await t.step('with nothing configured the navigation is empty', async () => {
      assertEquals(await client.execJson<UiNav>('ui-nav'), { sections: [], topbar: [], panels: [], layers: [], warnings: [] });
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

    await t.step("a group's overlay applies to its members alone, under the member's own", async () => {
      // The visitors' group, as boot makes it; gids clear of the ones boot reserves.
      await client.exec(`group-create guest --gid ${GUEST_ACCESS.gid} && group-create sailors --gid 7000 && group-create gardeners --gid 7001`);
      await client.exec('user-create anna && user-passwd anna --new-password secret1 && group-add-member sailors anna');
      await client.exec('mkdir -p /groups && group-home sailors && group-home gardeners');
      await client.exec(`mkdir -p ${groupHomePath('sailors')}/.ui ${groupHomePath('gardeners')}/.ui`);
      await write(`${groupHomePath('sailors')}/${HOME_UI_NAV_FILE}`, {
        sidebar: [{ id: 'sailors.boats', section: 'main', label: 'Boats', icon: 'sailboat', to: '/search?q=sailboat' }, { id: 'ui.home', order: 2000 }],
      });
      await write(`${groupHomePath('gardeners')}/${HOME_UI_NAV_FILE}`, { hide: ['ui.home'] });
      const annaHome = `${(await client.exec('echo $HOMES_PATH')).data}`.trim() + '/anna';
      await client.exec(`mkdir -p ${annaHome}/.ui && chown anna ${annaHome}/.ui`);
      await write(`${annaHome}/.ui/nav.json`, { sidebar: [{ id: 'sailors.boats', label: 'Our boats' }] });

      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
      try {
        const nav = await anna.execJson<UiNav>('ui-nav');
        assertEquals(nav.sections.map((s) => s.items.map((i) => [i.id, i.label])), [[['ui.media', 'Pictures'], ['sailors.boats', 'Our boats'], ['ui.home', 'Home']]]);
      } finally {
        anna.close();
      }
      // The administrator is in neither group.
      const nav = await client.execJson<UiNav>('ui-nav');
      assertEquals(nav.sections.flatMap((s) => s.items.map((i) => i.id)).includes('sailors.boats'), false);
      await client.exec(`rm ${groupHomePath('sailors')}/${HOME_UI_NAV_FILE} ${groupHomePath('gardeners')}/${HOME_UI_NAV_FILE}`);
    });

    await t.step("a module's fragment in a group's home is its members' and the administrator's", async () => {
      await client.exec(`mkdir -p ${groupHomePath('sailors')}/${HOME_UI_NAV_D}`);
      await write(`${groupHomePath('sailors')}/${HOME_UI_NAV_D}/charts.json`, {
        sidebar: [{ id: 'charts.map', section: 'main', label: 'Charts', icon: 'map', to: '/charts' }],
      });
      const ids = (nav: UiNav) => nav.sections.flatMap((s) => s.items.map((i) => i.id));
      await client.exec('user-create bert && user-passwd bert --new-password secret1 && group-add-member gardeners bert');
      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
      const bert = await testCtx.server.createShellClient({ username: 'bert', password: 'secret1' });
      try {
        assertEquals(ids(await anna.execJson<UiNav>('ui-nav')).includes('charts.map'), true);
        assertEquals(ids(await bert.execJson<UiNav>('ui-nav')).includes('charts.map'), false);
      } finally {
        anna.close();
        bert.close();
      }
      // The administrator is in neither group, and is given every module.
      assertEquals(ids(await client.execJson<UiNav>('ui-nav')).includes('charts.map'), true);
      await client.exec(`rm -r ${groupHomePath('sailors')}/${HOME_UI_NAV_D}`);
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
        // The administrator's overlay keeps an entry from visitors.
        await write(UI_NAV_PATH, { sidebar: [{ id: 'ui.media', label: 'Pictures', signedIn: true }] });
        assertEquals((await guest.execJson<UiNav>('ui-nav')).sections.map((s) => s.items.map((i) => i.id)), [['ui.home']]);
      } finally {
        guest.close();
        await client.execString('config unset CFG_GUEST_BROWSING');
      }
    });

    await t.step("arranging writes the person's own overlay, which ui-nav draws by, and a reset removes it", async () => {
      await client.exec('user-create cara && user-passwd cara --new-password secret1');
      const cara = await testCtx.server.createShellClient({ username: 'cara', password: 'secret1' });
      try {
        // Run as the browser runs them: without JSON_OUTPUT, stdout as text.
        const script = async (line: string) => `${(await cara.exec(line, { json: false })).data ?? ''}`;
        const own = () => script(READ_OWN_NAV);
        assertEquals(await own(), '');
        // A quote in the overlay survives the shell.
        const mine: NavLayer = { sidebar: [{ id: 'ui.home', place: 'topbar', parent: null, order: 5, label: "Cara's home" }] };
        await script(writeOwnNavScript(mine));
        assertEquals(JSON.parse(await own()), mine);
        const nav = await cara.execJson<UiNav>('ui-nav');
        assertEquals(nav.topbar.map((entry) => [entry.list, entry.id, entry.title, entry.action]), [['sidebar', 'ui.home', "Cara's home", { navigate: '/' }], [
          'topbar',
          'ui.chat',
          'Chat',
          { drawer: '/chat' },
        ]]);
        await script(writeOwnNavScript(resetArrangement(mine)));
        assertEquals(JSON.parse(await own()), { sidebar: [{ id: 'ui.home', label: "Cara's home" }] });
        await script(writeOwnNavScript({}));
        assertEquals(await own(), '');
      } finally {
        cara.close();
      }
    });
  } finally {
    await testCtx.teardown();
  }
});
