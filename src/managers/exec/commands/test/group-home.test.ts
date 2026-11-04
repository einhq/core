/**
 * A group's home: `group-home` makes `/groups/<group>` the group's alone, what its members make
 * there stays the whole group's, nobody else sees it, and it is taken away only into the trash.
 */

import { assertEquals } from '@std/assert';
import type { GroupHome } from '../../../../lib/api/users.ts';
import { USERS_GID } from '../../../../lib/access/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

type Props = { uid: number; gid: number; mode: number };

Deno.test({
  name: 'group homes',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  const clients: ShellClient[] = [admin];

  try {
    await cmd.shouldSucceed('user-create anna && user-passwd anna --new-password hunter2');
    await cmd.shouldSucceed('user-create bo && user-passwd bo --new-password hunter2');
    await cmd.shouldSucceed('user-create cleo && user-passwd cleo --new-password hunter2');
    await cmd.shouldSucceed('group-create family --title "The family" --home');
    await cmd.shouldSucceed('group-add-member family anna && group-add-member family bo');
    const signIn = async (username: string): Promise<ShellClient> => {
      const client = await testCtx.server.createShellClient({ username, password: 'hunter2' });
      clients.push(client);
      return client;
    };
    const anna = await signIn('anna');
    const bo = await signIn('bo');
    const cleo = await signIn('cleo');
    const familyGid = (await admin.execJson<{ gid: number }>('group-info family')).gid;

    await t.step('boot gives the users group a home', async () => {
      const props = await admin.execJson<Props>('props /groups/users');
      assertEquals([props.uid, props.gid, props.mode.toString(8)], [0, USERS_GID, '770']);
    });

    await t.step("a home is the administrator's, the group's, and 0770", async () => {
      const props = await admin.execJson<Props>('props /groups/family');
      assertEquals([props.uid, props.gid, props.mode.toString(8)], [0, familyGid, '770']);
      assertEquals(await admin.execJson<GroupHome>('group-home family'), { groupname: 'family', gid: familyGid, path: '/groups/family', home: true });
    });

    await t.step("what a member makes there is the whole group's", async () => {
      await testCommands(anna).shouldSucceed('mkdir -p /groups/family/lists/shopping');
      const props = await admin.execJson<Props>('props /groups/family/lists/shopping');
      assertEquals([props.gid, props.mode.toString(8)], [familyGid, '770']);
      await testCommands(bo).shouldSucceed('echo milk > /groups/family/lists/shopping/milk');
      assertEquals((await anna.execString('cat /groups/family/lists/shopping/milk')).trim(), 'milk');
    });

    await t.step('ls /groups lists the homes of the groups one is in, and nobody else sees them', async () => {
      assertEquals(await anna.execJson<string[]>('ls /groups'), ['family', 'users']);
      assertEquals(await cleo.execJson<string[]>('ls /groups'), ['users']);
      await testCommands(cleo).shouldFail('ls /groups/family');
      await testCommands(cleo).shouldFail('cat /groups/family/lists/shopping/milk');
      await testCommands(cleo).shouldFail('mkdir /groups/family/mine');
    });

    await t.step("built-in groups and a user's own group have no home", async () => {
      await cmd.shouldFailWith('group-home sudo', 'built-in');
      await cmd.shouldFailWith('group-home admin', 'built-in');
      await cmd.shouldFailWith('group-home anna', 'own group');
      await cmd.shouldFailWith('group-home nosuch', 'does not exist');
      await testCommands(anna).shouldFail('group-home family --off');
    });

    await t.step('group-delete leaves a home only when told to, into the trash', async () => {
      await cmd.shouldFailWith('group-delete family', 'has a home');
      await cmd.shouldSucceed('group-delete family --remove-home');
      assertEquals((await admin.execString('[ -e /groups/family ] && echo yes || echo no')).trim(), 'no');
      const trashed = await admin.execJson<{ origPath: string }[]>('trash list');
      assertEquals(trashed.some((entry) => entry.origPath === '/groups/family'), true);
    });

    await t.step('--off moves a home to the trash, and boot does not bring back the users home', async () => {
      await cmd.shouldSucceed('group-home users --off');
      await admin.execString('/etc/init/01_auth.sh');
      assertEquals((await admin.execString('[ -e /groups/users ] && echo yes || echo no')).trim(), 'no');
    });
  } finally {
    for (const client of clients) client.close();
  }
});
