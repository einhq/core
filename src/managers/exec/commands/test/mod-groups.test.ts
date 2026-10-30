/**
 * A module kept to groups (`mod groups`): its PATH line moves from /etc/bashrc to
 * /etc/bashrc.d/<group> and its navigation from /etc/ui/nav.d to /etc/ui/groups/<group>/nav.d, for
 * each of its groups and the administrators; a member's shell has its commands and navigation, and
 * anyone else's has neither and is refused its commands by path. Making it everyone's again, and
 * removing it, move them back and forget the groups.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { UiNav } from '@ui/nav';
import type { ModuleEntry, ModuleGroups } from '../../../../lib/api/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { BASHRC_GROUPS_PATH, MODULE_GROUPS_PATH, UI_GROUPS_PATH, UI_NAV_D_PATH } from '../../../../lib/paths.ts';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({ name: 'mod groups', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin: ShellClient = await testCtx.server.createShellClient();
  const id = crypto.randomUUID().slice(0, 8);
  const name = `kept-${id}`;
  const bin = `/usr/modules/${name}/bin`;
  const nav = `{"sections":[{"id":"main"}],"sidebar":[{"id":"${name}.page","section":"main","label":"Kept","icon":"x","to":"/kept"}]}`;

  const read = async (path: string): Promise<string | undefined> => {
    const res = await admin.exec(`cat ${path}`);
    return res.success ? `${res.data}` : undefined;
  };
  const exists = async (path: string): Promise<boolean> => await vfs.exists(ADMIN_ACCESS, path, { follow: false });
  const navIds = (answer: UiNav) => answer.sections.flatMap((section) => section.items.map((item) => item.id));

  try {
    // The administrators' group, as boot makes it; gids clear of the ones boot reserves.
    await admin.exec(`group-exists admin || group-create admin --gid 0`);
    await admin.exec(`group-create sailors-${id} --gid 7200 && group-create gardeners-${id} --gid 7201`);
    await admin.exec(`user-create anna-${id} && user-passwd anna-${id} --new-password secret1 && group-add-member sailors-${id} anna-${id}`);
    await admin.exec(`user-create bert-${id} && user-passwd bert-${id} --new-password secret1 && group-add-member gardeners-${id} bert-${id}`);
    await admin.exec(
      `mkdir -p $MOD_PATH/${name}/ui $MOD_PATH/${name}/bin && echo '{"name":"${name}","version":"1.0.0"}' > $MOD_PATH/${name}/mod.json && echo '${nav}' > $MOD_PATH/${name}/ui/nav.json`,
    );
    await admin.exec(`echo 'echo ahoy' > $MOD_PATH/${name}/bin/hello-${id} && chmod 755 $MOD_PATH/${name}/bin/hello-${id}`);
    assertEquals((await admin.exec(`mod-setup ${name}`)).success, true);

    await t.step("everyone's: its PATH line in /etc/bashrc, its navigation in /etc/ui/nav.d", async () => {
      assertStringIncludes((await read('/etc/bashrc')) ?? '', bin);
      assert(await exists(`${UI_NAV_D_PATH}/${name}.json`));
      assertEquals(await admin.execJson<ModuleGroups>(`mod-groups ${name}`), { name, groups: [] });
    });

    await t.step('a group that is not there is refused', async () => {
      const res = await admin.exec(`mod-groups ${name} nobody-${id}`);
      assertEquals(res.success, false);
      assertEquals(await exists(`${MODULE_GROUPS_PATH}/${name}.groups`), false);
    });

    await t.step('kept to a group: its lines and links move to the group and the administrators', async () => {
      assertEquals((await admin.exec(`mod-groups ${name} sailors-${id}`)).success, true);
      assertEquals(`${await read(`${MODULE_GROUPS_PATH}/${name}.groups`)}`.trim(), `sailors-${id}`);
      assertEquals((await read('/etc/bashrc'))?.includes(bin), false);
      assertStringIncludes((await read(`${BASHRC_GROUPS_PATH}/sailors-${id}`)) ?? '', bin);
      assertStringIncludes((await read(`${BASHRC_GROUPS_PATH}/admin`)) ?? '', bin);
      assertEquals(await exists(`${UI_NAV_D_PATH}/${name}.json`), false);
      assert(await exists(`${UI_GROUPS_PATH}/sailors-${id}/nav.d/${name}.json`));
      assert(await exists(`${UI_GROUPS_PATH}/admin/nav.d/${name}.json`));
    });

    await t.step('a member has its commands, navigation and listing; someone else none of them, and its commands are refused', async () => {
      const anna = await testCtx.server.createShellClient({ username: `anna-${id}`, password: 'secret1' });
      const bert = await testCtx.server.createShellClient({ username: `bert-${id}`, password: 'secret1' });
      try {
        assertEquals(`${(await anna.exec(`hello-${id}`)).data}`.trim(), 'ahoy');
        assert(navIds(await anna.execJson<UiNav>('ui-nav')).includes(`${name}.page`));
        assert((await anna.execJson<ModuleEntry[]>('mod-list')).some((entry) => entry.name === name && entry.groups?.[0] === `sailors-${id}`));

        assertEquals(`${(await bert.exec('echo $PATH')).data}`.includes(bin), false);
        assertEquals((await bert.exec(`hello-${id}`)).success, false);
        const refused = await bert.exec(`${bin}/hello-${id}`);
        assertEquals(refused.success, false);
        assertStringIncludes(`${refused.error ?? ''}${refused.data ?? ''}`, 'kept to groups');
        assertEquals(navIds(await bert.execJson<UiNav>('ui-nav')).includes(`${name}.page`), false);
        assertEquals((await bert.execJson<ModuleEntry[]>('mod-list')).some((entry) => entry.name === name), false);
      } finally {
        anna.close();
        bert.close();
      }
      // The administrator is in neither group, and has it all.
      const own = await testCtx.server.createShellClient();
      try {
        assertEquals(`${(await own.exec(`hello-${id}`)).data}`.trim(), 'ahoy');
        assert(navIds(await own.execJson<UiNav>('ui-nav')).includes(`${name}.page`));
      } finally {
        own.close();
      }
    });

    await t.step("everyone's again: back in /etc/bashrc and /etc/ui/nav.d, the groups' files emptied of it", async () => {
      assertEquals((await admin.exec(`mod-groups ${name} --everyone`)).success, true);
      assertEquals(await exists(`${MODULE_GROUPS_PATH}/${name}.groups`), false);
      assertStringIncludes((await read('/etc/bashrc')) ?? '', bin);
      assertEquals(await exists(`${BASHRC_GROUPS_PATH}/sailors-${id}`), false);
      assertEquals(await exists(`${UI_GROUPS_PATH}/sailors-${id}/nav.d/${name}.json`), false);
      assert(await exists(`${UI_NAV_D_PATH}/${name}.json`));
      const bert = await testCtx.server.createShellClient({ username: `bert-${id}`, password: 'secret1' });
      try {
        assertEquals(`${(await bert.exec(`hello-${id}`)).data}`.trim(), 'ahoy');
      } finally {
        bert.close();
      }
    });

    await t.step("a group's own setup reaches its members' shells, those open already at their next command", async () => {
      const anna = await testCtx.server.createShellClient({ username: `anna-${id}`, password: 'secret1' });
      const bert = await testCtx.server.createShellClient({ username: `bert-${id}`, password: 'secret1' });
      const show = 'echo "value=${SAILING:-unset}"';
      try {
        assertEquals((await anna.execString(show)).trim(), 'value=unset');
        await admin.exec(`echo 'export SAILING=yes' > ${BASHRC_GROUPS_PATH}/sailors-${id}`);
        assertEquals((await anna.execString(show)).trim(), 'value=yes');
        assertEquals((await bert.execString(show)).trim(), 'value=unset');
      } finally {
        anna.close();
        bert.close();
        await admin.exec(`rm ${BASHRC_GROUPS_PATH}/sailors-${id}`);
      }
    });

    await t.step('mod remove takes it out of every group and forgets its groups', async () => {
      await admin.exec(`mod-groups ${name} gardeners-${id}`);
      assertEquals((await admin.exec(`mod-remove --force ${name}`)).success, true);
      assertEquals(await exists(`${MODULE_GROUPS_PATH}/${name}.groups`), false);
      assertEquals((await read(`${BASHRC_GROUPS_PATH}/gardeners-${id}`))?.includes(bin) ?? false, false);
      assertEquals((await read(`${BASHRC_GROUPS_PATH}/admin`))?.includes(bin) ?? false, false);
      assertEquals(await exists(`${UI_GROUPS_PATH}/gardeners-${id}/nav.d/${name}.json`), false);
    });
  } finally {
    await testCtx.teardown();
  }
});
