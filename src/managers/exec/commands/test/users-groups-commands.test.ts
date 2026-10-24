/**
 * Account and group commands against the accounts and groups boot makes: what `user-list` and
 * `group-list` report, how `user-create` picks its groups and its own group, the name rule, which
 * membership links make someone a member, and what the built-in accounts and groups refuse.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import type {
  GroupCreated,
  GroupEntry,
  GroupResolved,
  GroupUpdated,
  MembershipChanged,
  PrimaryGroupSet,
  UserCreated,
  UserEntry,
  UserInactive,
  UserResolved,
  UserUpdated,
} from '../../../../lib/api/users.ts';
import type { ShareInfo } from '../../../../lib/api/share.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'users and groups commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  const clients: ShellClient[] = [admin];
  const signIn = async (username: string, password: string): Promise<ShellClient> => {
    const client = await testCtx.server.createShellClient({ username, password });
    clients.push(client);
    return client;
  };
  const userNamed = (users: UserEntry[], username: string): UserEntry => {
    const user = users.find((entry) => entry.username === username);
    assert(user, `no user ${username} in ${JSON.stringify(users)}`);
    return user;
  };
  const groupNamed = (groups: GroupEntry[], groupname: string): GroupEntry => {
    const group = groups.find((entry) => entry.groupname === groupname);
    assert(group, `no group ${groupname} in ${JSON.stringify(groups)}`);
    return group;
  };

  try {
    await t.step('user-create answers with the account and the groups it linked, its own first', async () => {
      const created = await admin.execJson<UserCreated>('user-create anna --title "Anna Andersson" --description "Keeps the photos"');
      assertEquals(created, { username: 'anna', uid: created.uid, gid: created.uid, path: '/etc/users/anna', home: '/home/anna', groups: ['anna', 'users'] });
    });

    await t.step('user-list reports user nodes only, with primary group, state, person and role', async () => {
      await cmd.shouldSucceed('ln -s /archive/people/Anna /etc/users/anna/person');
      await cmd.shouldSucceed('mknode -t directory /etc/users/stray');
      await cmd.shouldSucceed('user-create bo');
      await cmd.shouldSucceed('attrs -J mustResetPassword=true /etc/users/bo');

      const users = await admin.execJson<UserEntry[]>('user-list');
      assertEquals(users.some((entry) => entry.username === 'stray'), false);

      const anna = userNamed(users, 'anna');
      assertEquals(anna, {
        username: 'anna',
        uid: anna.uid,
        gid: anna.uid,
        title: 'Anna Andersson',
        description: 'Keeps the photos',
        inactive: false,
        mustResetPassword: false,
        hasPassword: false,
        personPath: '/archive/people/Anna',
      });
      assertEquals(userNamed(users, 'bo').mustResetPassword, true);

      const adminEntry = userNamed(users, 'admin');
      assertEquals([adminEntry.uid, adminEntry.role, adminEntry.hasPassword], [0, 'administrator', true]);
      const guest = userNamed(users, 'guest');
      assertEquals([guest.role, guest.hasPassword], ['guest', false]);

      await cmd.shouldSucceed('user-passwd anna --new-password secret');
      assertEquals(userNamed(await admin.execJson<UserEntry[]>('user-list'), 'anna').hasPassword, true);
    });

    await t.step('whether a password is set is reported to an administrator only', async () => {
      const anna = await signIn('anna', 'secret');
      const users = await anna.execJson<UserEntry[]>('user-list');
      assertEquals(users.some((entry) => 'hasPassword' in entry), false);
      assertEquals(userNamed(users, 'anna').personPath, '/archive/people/Anna');
    });

    await t.step('group-create answers with the new group', async () => {
      const created = await admin.execJson<GroupCreated>('group-create family --title Family --description "The household"');
      assertEquals(created, { groupname: 'family', gid: created.gid, path: '/etc/groups/family' });
      assertEquals(
        await admin.execJson<MembershipChanged>('group-add-member family anna'),
        { group: 'family', user: 'anna', action: 'added' },
      );
      await cmd.shouldSucceed('group-add-member family bo');
    });

    await t.step('group-list reports group nodes only, with description and role', async () => {
      await cmd.shouldSucceed('mknode -t directory /etc/groups/stray');
      const groups = await admin.execJson<GroupEntry[]>('group-list');
      assertEquals(groups.some((entry) => entry.groupname === 'stray'), false);
      assertEquals(groups.some((entry) => 'members' in entry), false);

      const family = groupNamed(groups, 'family');
      assertEquals(family, { groupname: 'family', gid: family.gid, title: 'Family', description: 'The household' });
      assertEquals(
        ['admin', 'guest', 'users', 'ssh', 'anna'].map((name) => groupNamed(groups, name).role),
        ['administrators', 'guests', 'everyone', 'ssh', undefined],
      );
    });

    await t.step('group-list --members lists the usernames linked into each group the caller may list', async () => {
      const groups = await admin.execJson<GroupEntry[]>('group-list --members');
      assertEquals(groupNamed(groups, 'family').members, ['anna', 'bo']);
      assertEquals(groupNamed(groups, 'anna').members, ['anna']);
      assertEquals(groupNamed(groups, 'users').members?.includes('anna'), true);

      const text = await admin.execString('group-list --members', { json: false });
      const familyLine = text.split('\n').find((line) => line.startsWith('family\t'));
      assertEquals(familyLine?.split('\t').slice(2), ['Family', 'anna,bo']);

      // Signed in after joining family: its members are hers to see, admin's are not.
      const anna = await signIn('anna', 'secret');
      const seen = await anna.execJson<GroupEntry[]>('group-list --members');
      assertEquals(groupNamed(seen, 'family').members, ['anna', 'bo']);
      assertEquals('members' in groupNamed(seen, 'admin'), false);
      assertEquals(groupNamed(seen, 'admin').role, 'administrators');
    });

    await t.step('user-groups rows carry role and description', async () => {
      const groups = await admin.execJson<GroupEntry[]>('user-groups anna');
      assertEquals(groupNamed(groups, 'family').description, 'The household');
      assertEquals(groupNamed(groups, 'users').role, 'everyone');
      assertEquals(groupNamed(groups, 'anna').role, undefined);
    });

    await t.step('user-create --groups names the groups besides its own; empty names none', async () => {
      assertEquals((await admin.execJson<UserCreated>('user-create cleo --groups family')).groups, ['cleo', 'family']);
      assertEquals((await admin.execJson<UserCreated>('user-create dag --groups=')).groups, ['dag']);
      assertEquals((await admin.execJson<UserCreated>("user-create dina --groups ''")).groups, ['dina']);

      // A group that cannot be linked is left out with a warning; the account is still made.
      const result = await admin.exec('user-create edit --groups family,nosuch');
      assertEquals(result.success, true);
      assertEquals((result.data as UserCreated).groups, ['edit', 'family']);
    });

    await t.step('without --groups, user-create reads CFG_DEFAULT_USER_GROUPS as set now', async () => {
      // Set in this session, after its shell's environment was read.
      await cmd.shouldSucceed('config set CFG_DEFAULT_USER_GROUPS family');
      // Opened while it is set, so its environment holds it.
      const later = await testCtx.server.createShellClient();
      clients.push(later);
      try {
        assertEquals((await admin.execJson<UserCreated>('user-create filip')).groups, ['filip', 'family']);
      } finally {
        await testCommands(later).shouldSucceed('config unset CFG_DEFAULT_USER_GROUPS');
      }
      assertEquals((await later.execJson<UserCreated>('user-create gun')).groups, ['gun', 'users']);
    });

    await t.step('user-create and group-create refuse a name that is not an account name', async () => {
      await cmd.shouldFailWith("user-create 'anna andersson'", 'user create: a name holds only letters, digits and . _ -');
      await cmd.shouldFailWith("user-create 'a/b'", 'user create: a name holds only');
      await cmd.shouldFailWith('user-create .hidden', 'user create: a name starts with a letter or _');
      await cmd.shouldFailWith(`user-create ${'a'.repeat(65)}`, 'user create: a name is at most 64 characters');
      await cmd.shouldFailWith("group-create 'the family'", 'group create: a name holds only');
      await cmd.shouldFailWith('group-create .family', 'group create: a name starts with');
      await cmd.shouldFail('user-exists .hidden');
      await cmd.shouldFail("group-exists 'the family'");

      // A word of digits is read as a uid or gid, so a name never starts with a digit.
      await cmd.shouldFailWith('user-create 2024', 'user create: a name starts with a letter or _');
      await cmd.shouldFailWith('group-create 007', 'group create: a name starts with a letter or _');
      await cmd.shouldFail('user-exists 2024');
      await cmd.shouldFail('group-exists 007');

      // An e-mail address is no name: `@` is what marks an address at sign-in. A name is lower case.
      await cmd.shouldFailWith('user-create anna@example.com', 'user create: a name holds only');
      await cmd.shouldFailWith('user-create Anna', 'user create: a name is lower case');
      await cmd.shouldFailWith('group-create Family', 'group create: a name is lower case');

      // A name with digits after its first character is one, in any script.
      await cmd.shouldSucceed('user-create anna.andersson');
      await cmd.shouldSucceed('user-create åsa');
      assertEquals((await admin.execJson<GroupCreated>('group-create _007')).groupname, '_007');
      assertEquals((await admin.execJson<GroupCreated>('group-create class2024')).groupname, 'class2024');
    });

    await t.step("a node under /etc/groups that is not a group is no one's own group", async () => {
      await cmd.shouldSucceed('mknode -t directory /etc/groups/zed');
      await cmd.shouldFailWith('user-create zed', "user create: '/etc/groups/zed' exists and is not a group");
      await cmd.shouldFail('user-exists zed');
      await cmd.shouldSucceed('rm -r /etc/groups/zed');
    });

    await t.step('a group named like a new user becomes its own group when its gid is free as a uid', async () => {
      await cmd.shouldSucceed('group-create kids --gid 5000');
      const kids = await admin.execJson<UserCreated>('user-create kids');
      assertEquals([kids.uid, kids.gid, kids.groups], [5000, 5000, ['kids', 'users']]);
      assertEquals((await admin.execJson<{ gid: number }>('user-info kids')).gid, 5000);
      await cmd.shouldFailWith('user-create kids', "user create: user 'kids' already exists");

      // Given another uid, or with the gid already someone's uid, it is refused.
      await cmd.shouldSucceed('group-create teens --gid 5100');
      await cmd.shouldFailWith('user-create teens --uid 5101', "user create: a group 'teens' exists with gid 5100");
      await cmd.shouldSucceed('user-create ida --uid 5300 && user-set-primary-group ida family && group-delete ida');
      await cmd.shouldSucceed('group-create jon --gid 5300');
      await cmd.shouldFailWith('user-create jon', "which is already the uid of 'ida'");
      await cmd.shouldFail('user-exists jon');

      // `users` and `ssh` are every member's, never one account's own.
      await cmd.shouldFailWith('user-create users', "user create: 'users' is the name of a built-in group");
      await cmd.shouldFailWith('user-create ssh', "user create: 'ssh' is the name of a built-in group");
    });

    await t.step("an account's number is fixed once it exists, for the administrator too", async () => {
      await cmd.shouldSucceed('group-create scouts --gid 5400');
      await cmd.shouldFailWith('group-update scouts --gid 5500 --title X', "group update: a group's gid is set when it is created and cannot be changed");
      await cmd.shouldFailWith('group-update scouts --gid=5500', "group update: a group's gid is set when it is created and cannot be changed");
      await cmd.shouldFailWith('group-update scouts --name X', 'unknown flag --name');
      assertEquals((await admin.execJson<{ title?: string }>('attrs /etc/groups/scouts')).title, undefined);
      await cmd.shouldFailWith('attrs -J gid=5500 /etc/groups/scouts', "a group's gid is set when it is created and cannot be changed");
      await cmd.shouldFailWith('attrs -J uid=5500 /etc/users/bo', "a user's uid is set when it is created and cannot be changed");
      await cmd.shouldFailWith('attrs -d uid /etc/users/bo', "a user's uid is set when it is created and cannot be changed");
      assertEquals((await admin.execJson<{ gid: number }>('attrs /etc/groups/scouts')).gid, 5400);

      assertEquals(
        await admin.execJson<GroupUpdated>('group-update scouts --title Scouts'),
        { groupname: 'scouts', updated: { title: 'Scouts' } },
      );
      // A built-in group's title and description are still the administrator's to set.
      await cmd.shouldSucceed('group-update users --description "Everyone who signs in"');
    });

    await t.step('only a user node is an account and only a group node a group, and only the administrator makes either', async () => {
      await cmd.shouldSucceed('user-create mallory && user-passwd mallory --new-password secret && group-add-member admin mallory');
      await cmd.shouldSucceed('group-create vault --gid 8800 && mkdir /vault && chown :vault /vault && chmod 0770 /vault');
      const mallory = await signIn('mallory', 'secret');
      const asMallory = testCommands(mallory);

      // /etc/users and /etc/groups are 0755, as on Linux, so being in admin gives no write there,
      // and an account's password is the administrator's alone to read.
      await asMallory.shouldFailWith('mkdir /etc/users/forged', "Access denied for operation 'w'");
      await asMallory.shouldFail('cat /etc/users/mallory/.password');
      await asMallory.shouldFail('rm /etc/users/mallory/.password');
      await asMallory.shouldFailWith('mkdir /etc/groups/forged', "Access denied for operation 'w'");

      // Opened to the group here, so what is checked below is that a node there is an identity
      // only by its type and only when the administrator made it, whatever the directory's mode.
      await cmd.shouldSucceed('chmod 0775 /etc/users /etc/groups');

      await asMallory.shouldSucceed('mkdir /etc/users/forged && attrs -J uid=0 /etc/users/forged && attrs -J gid=0 /etc/users/forged');
      await cmd.shouldSucceed('cp /etc/users/mallory/.password /etc/users/forged/.password');
      await assertRejects(() => testCtx.server.createShellClient({ username: 'forged', password: 'secret' }));
      assertEquals((await admin.execJson<UserEntry[]>('user-list')).some((user) => user.username === 'forged'), false);

      await asMallory.shouldSucceed('mkdir -p /etc/groups/forged/users && attrs -J gid=8800 /etc/groups/forged && ln -s /etc/users/mallory /etc/groups/forged/users/mallory');
      const again = testCommands(await signIn('mallory', 'secret'));
      await again.shouldFail('ls /vault');
      assertEquals((await admin.execJson<GroupEntry[]>('group-list')).some((group) => group.groupname === 'forged'), false);

      await asMallory.shouldFailWith('mknode --type=user /etc/users/forged2', "'create user'");
      await asMallory.shouldFailWith('mknode --type=group /etc/groups/forged2', "'create group'");
      await asMallory.shouldFailWith('cp -r /etc/users/bo /etc/users/bo2', "'create user'");
      await asMallory.shouldFailWith('ln /etc/users/bo /home/mallory/bo', "'link user'");
      await asMallory.shouldFailWith('ln /etc/groups/vault /home/mallory/vault', "'link group'");
      await cmd.shouldSucceed('rm -r /etc/users/forged /etc/groups/forged && group-remove-member admin mallory && chmod 0755 /etc/users /etc/groups');
    });

    await t.step('a membership link counts for the account it points at, and only for it', async () => {
      const inVault = async (): Promise<boolean> => {
        const members = groupNamed(await admin.execJson<GroupEntry[]>('group-list --members'), 'vault').members ?? [];
        const groups = (await admin.execJson<GroupEntry[]>('user-groups mallory')).map((group) => group.groupname);
        const isMember = (await admin.exec('group-is-member vault mallory')).success;
        const preview = await admin.execJson<ShareInfo>('share-info /vault');
        const previewed = preview.effective.some((entry) => entry.username === 'mallory');
        const signedIn = (await (await signIn('mallory', 'secret')).exec('ls /vault')).success;
        assertEquals([members.includes('mallory'), groups.includes('vault'), isMember, previewed], [signedIn, signedIn, signedIn, signedIn]);
        return signedIn;
      };

      // Named after mallory, pointing at bo's account: it makes neither of them a member.
      await cmd.shouldSucceed('ln -s /etc/users/bo /etc/groups/vault/users/mallory');
      assertEquals(await inVault(), false);
      assertEquals(groupNamed(await admin.execJson<GroupEntry[]>('group-list --members'), 'vault').members, []);
      await cmd.shouldSucceed('rm /etc/groups/vault/users/mallory');

      await cmd.shouldSucceed('ln -s ../../../users/mallory /etc/groups/vault/users/mallory');
      assertEquals(await inVault(), true);
      await cmd.shouldSucceed('rm /etc/groups/vault/users/mallory');

      await cmd.shouldSucceed('group-add-member vault mallory');
      assertEquals(await inVault(), true);
      await cmd.shouldSucceed('group-remove-member vault mallory');
    });

    await t.step('the built-in accounts and groups stay, and the guest has no password', async () => {
      await cmd.shouldFailWith('user-delete guest', 'user delete: cannot delete the guest account');
      await cmd.shouldFailWith('user-disable guest', 'user disable: cannot disable the guest account');
      await cmd.shouldFailWith('user-passwd guest --new-password secret', 'user passwd: the guest account cannot have a password');
      await cmd.shouldFailWith('user-delete admin', 'user delete: cannot delete the administrator');
      for (const group of ['admin', 'guest', 'users', 'ssh']) {
        await cmd.shouldFailWith(`group-delete ${group}`, `group delete: cannot delete the built-in group '${group}'`);
      }
      await cmd.shouldSucceed('user-exists guest');
      assertEquals(userNamed(await admin.execJson<UserEntry[]>('user-list'), 'guest').hasPassword, false);
    });

    await t.step('user-resolve and group-resolve take a numeric id, 0 included', async () => {
      assertEquals(await admin.execJson<UserResolved>('user-resolve 0'), { uid: 0, username: 'admin', title: 'Administrator' });
      assertEquals((await admin.execJson<UserResolved>('user-resolve 1001')).username, 'guest');
      assertEquals((await admin.execJson<UserResolved>('user-resolve kids')).uid, 5000);
      assertEquals((await admin.execJson<GroupResolved>('group-resolve 0')).groupname, 'admin');
      assertEquals((await admin.execJson<GroupResolved>('group-resolve 5000')).groupname, 'kids');
      assertEquals((await admin.execJson<GroupResolved>('group-resolve kids')).gid, 5000);
      assertEquals((await admin.execString('user-resolve 0', { json: false })).trim(), 'admin');
    });

    await t.step("an e-mail address is one account's, kept lower case, and signs in like the username", async () => {
      const made = await admin.execJson<UserCreated>('user-create eva --email=Eva.Ek@Example.com --title "Eva Ek"');
      assertEquals(made.username, 'eva');
      assertEquals(userNamed(await admin.execJson<UserEntry[]>('user-list'), 'eva').email, 'eva.ek@example.com');
      await cmd.shouldFailWith('user-create eve --email=eva.ek@example.com', "user create: 'eva.ek@example.com' is already the e-mail address of 'eva'");
      await cmd.shouldFailWith('user-create eve --email=nobody', 'user create: an e-mail address is a name, @ and a domain');
      await cmd.shouldFail('user-exists eve');

      await cmd.shouldSucceed('user-passwd eva --new-password secret');
      for (const name of ['eva', 'EVA', 'eva.ek@example.com', 'EVA.EK@example.com']) {
        const client = await signIn(name, 'secret');
        assertEquals((await client.execString('whoami', { json: false })).trim(), 'eva', name);
      }
      await assertRejects(() => signIn('eva.ek@example.org', 'secret'));

      // The administrator moves it, but no account takes another's, and the account, which is the
      // administrator's node, cannot set its own; its home is its own to write.
      await cmd.shouldSucceed('user-create ola --email=ola@example.com');
      await cmd.shouldFailWith('user-update ola --email=eva.ek@example.com', "user update: 'eva.ek@example.com' is already the e-mail address of 'eva'");
      assertEquals(await admin.execJson<UserUpdated>('user-update eva --email=eva@example.com'), { username: 'eva', updated: { email: 'eva@example.com' } });
      const eva = await signIn('eva@example.com', 'secret');
      await testCommands(eva).shouldFail('user-update eva --email=ola@example.com');
      await testCommands(eva).shouldFail('attrs -J email=evil@example.com /etc/users/eva');
      assertEquals((await admin.execJson<{ email?: string }>('attrs /etc/users/eva')).email, 'eva@example.com');
      await testCommands(eva).shouldSucceed(`mkdir ~/notes && attrs -J 'title="Mine"' /home/eva`);

      // An empty address removes it.
      await cmd.shouldSucceed("user-update ola --email=''");
      assertEquals((await admin.execJson<{ email?: string }>('attrs /etc/users/ola')).email, undefined);
    });

    await t.step('a home lets others pass through only, so what is made in it shares through a grant', async () => {
      for (const name of ['pia', 'ulf']) {
        await cmd.shouldSucceed(`user-create ${name} && user-passwd ${name} --new-password secret`);
      }
      const pia = testCommands(await signIn('pia', 'secret'));
      const ulfClient = await signIn('ulf', 'secret');
      const ulf = testCommands(ulfClient);
      await pia.shouldSucceed('mkdir ~/notes ~/shared && echo hej > ~/notes/a.txt && echo hej > ~/shared/b.txt');

      await ulf.shouldSucceed('ls /home');
      await ulf.shouldFail('ls /home/pia');
      await ulf.shouldFail('ls /home/pia/notes');
      await ulf.shouldFail('cat /home/pia/notes/a.txt');

      await pia.shouldSucceed('acl -r -m u:ulf:rx ~/shared');
      await ulf.shouldSucceed('ls /home/pia/shared');
      assertEquals((await ulfClient.execString('cat /home/pia/shared/b.txt', { json: false })).trim(), 'hej');
    });

    await t.step('the other account writes answer with their declared shapes', async () => {
      assertEquals(
        await admin.execJson<UserUpdated>('user-update bo --name "Bo Berg"'),
        { username: 'bo', updated: { name: 'Bo Berg' } },
      );
      assertEquals(await admin.execJson<UserInactive>('user-disable bo'), { username: 'bo', inactive: true });
      assertEquals(await admin.execJson<UserInactive>('user-enable bo'), { username: 'bo', inactive: false });
      const bo = userNamed(await admin.execJson<UserEntry[]>('user-list'), 'bo');
      const family = groupNamed(await admin.execJson<GroupEntry[]>('group-list'), 'family');
      assertEquals(
        await admin.execJson<PrimaryGroupSet>('user-set-primary-group bo family'),
        { username: 'bo', oldGid: bo.gid, newGid: family.gid, primaryGroup: 'family' },
      );
      assertEquals(
        await admin.execJson<MembershipChanged>('group-remove-member family bo'),
        { group: 'family', user: 'bo', action: 'removed' },
      );
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
