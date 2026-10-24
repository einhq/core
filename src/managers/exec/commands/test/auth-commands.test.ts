/**
 * Auth command coverage: user and group management, whoami, login/logout.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'auth commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('user-create creates user with own group', async () => {
      await cmd.shouldSucceed('user-create alice --uid 3000');

      const info = await client.execJson<{ uid: number; name: string }>('attrs /etc/users/alice');
      assertEquals(info.uid, 3000);

      const exists = await client.exec('user-exists alice');
      assertEquals(exists.success, true);
      await cmd.shouldFail('user-exists nobody-here');
    });

    await t.step('duplicate user-create fails', async () => {
      await cmd.shouldFail('user-create alice');
    });

    await t.step('user-passwd sets a password that login accepts', async () => {
      await cmd.shouldSucceed('user-passwd alice --new-password hunter2');
      await cmd.shouldSucceed(`ln -s /archive/people/Alice /etc/users/alice/person`);

      const alice = await testCtx.server.createShellClient({ username: 'alice', password: 'hunter2' });
      try {
        const who = await alice.execJson<{ username: string; uid: number; admin: boolean; personPath?: string }>('user-whoami');
        assertEquals(who.username, 'alice');
        assertEquals(who.uid, 3000);
        assertEquals(who.admin, false);
        assertEquals(who.personPath, `/archive/people/Alice`);
      } finally {
        alice.close();
      }
    });

    await t.step("user-passwd hashes at the process's cost, not one exported in the shell", async () => {
      await cmd.shouldSucceed('export CFG_PASSWORD_HASH_LOGN=1 && user-passwd alice --new-password hunter2');
      const handle = await testCtx.context.vfs.open(ADMIN_ACCESS, '/etc/users/alice/.password', { mode: 'r' });
      const stored = decodeBase64((await toText(handle.readable)).trim());
      await handle.close();
      // Byte 7 of scrypt's format is logN; the test tier's process sets 10.
      assertEquals(stored[7], 10);
    });

    await t.step('user-whoami reports the access context administrator flag', async () => {
      const who = await client.execJson<{ username: string; admin: boolean }>('user-whoami');
      assertEquals(who.username, 'admin');
      assertEquals(who.admin, true);
    });

    await t.step("user-id --uid reports that user's own primary group", async () => {
      const id = await client.execJson<{ uid: number; user: string; gid: number; group: string }>('user-id --uid 3000');
      assertEquals(id.uid, 3000);
      assertEquals(id.user, 'alice');
      assertEquals(id.gid, 3000);
      assertEquals(id.group, 'alice');
    });

    await t.step('a wrong password, an unknown account and an account without a password fail alike', async () => {
      await cmd.shouldSucceed('user-create nopass');
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        for (const attempt of ['login alice wrongpass', 'login nobody-here hunter2', 'login nopass hunter2']) {
          const result = await guest.exec(attempt);
          assertEquals(result.success, false, attempt);
          assertStringIncludes(result.error ?? '', 'login: authentication failed', attempt);
        }
      } finally {
        guest.close();
        await cmd.shouldSucceed('user-delete nopass');
      }
    });

    await t.step('login changes access, logout reverts to guest', async () => {
      const shell = await testCtx.server.createShellClient({ login: false });
      try {
        // Guest has no user node, so whoami fails before login
        assertEquals((await shell.exec('user-whoami')).success, false);

        await shell.exec('login alice hunter2');
        const during = await shell.execJson<{ uid: number; username: string }>('user-whoami');
        assertEquals(during.username, 'alice');

        await shell.exec('logout');
        assertEquals((await shell.exec('user-whoami')).success, false);
      } finally {
        shell.close();
      }
    });

    await t.step('group lifecycle: create, add member, check, remove member', async () => {
      await cmd.shouldSucceed('group-create staff --gid 7000');
      await cmd.shouldSucceed('group-add-member staff alice');

      const isMember = await client.exec('group-is-member staff alice');
      assertEquals(isMember.success, true);

      const members = await client.execString('group-members staff');
      assertEquals(members.includes('alice'), true);

      const page = await client.execJson<{ members: { username: string; personPath?: string }[]; total: number }>('group-members --limit=1 staff');
      assertEquals(page.total, 1);
      assertEquals(page.members.map((member) => member.username), ['alice']);
      // A member's `person` link is answered as is, though no person is there yet.
      assertEquals(page.members[0].personPath, '/archive/people/Alice');
      await cmd.shouldFail('group-members --limit=51 staff');

      await cmd.shouldSucceed('group-remove-member staff alice');
      await cmd.shouldFail('group-is-member staff alice');
    });

    await t.step('group-delete removes the group', async () => {
      await cmd.shouldSucceed('group-create doomed');
      await cmd.shouldSucceed('group-delete doomed');
      await cmd.shouldFail('group-exists doomed');
    });

    await t.step('user-delete removes the user', async () => {
      await cmd.shouldSucceed('user-create shortlived');
      await cmd.shouldSucceed('user-delete shortlived');
      await cmd.shouldFail('user-exists shortlived');
      // Its own group goes with it.
      await cmd.shouldFail('group-exists shortlived');
    });

    await t.step('user-delete hands what the user owned to another user and drops ACL entries naming them', async () => {
      await cmd.shouldSucceed('user-create leaver --uid 2100');
      await cmd.shouldSucceed('user-create heir --uid 2101');
      await cmd.shouldSucceed('mknode -t directory -o 2100 -g 2100 /left');
      await cmd.shouldSucceed('mknode -t directory /granted');
      await cmd.shouldSucceed('acl -m u:leaver:rx -m g:leaver:rx -m u:alice:r /granted');

      const deleted = await client.execJson<{ to: string; owned: number; acl: number; group?: { deleted: boolean } }>(
        'user-delete leaver --to heir',
      );
      assertEquals(deleted.to, 'heir');
      assertEquals(deleted.acl, 1);
      assertEquals(deleted.group?.deleted, true);

      // The uid to the heir, the gid of the user's own group to the heir's own group.
      const left = await client.execJson<{ uid: number; gid: number }>('props /left');
      assertEquals([left.uid, left.gid], [2101, 2101]);

      const entries = await client.execJson<{ uid?: number; gid?: number }[]>('acl /granted');
      assertEquals(entries.map((entry) => entry.uid), [3000]);
    });

    await t.step("user-delete keeps the user's own group while someone else belongs to it", async () => {
      await cmd.shouldSucceed('user-create sharer --uid 2200');
      await cmd.shouldSucceed('group-add-member sharer alice');
      const deleted = await client.execJson<{ group?: { deleted: boolean } }>('user-delete sharer');
      assertEquals(deleted.group?.deleted, false);
      await cmd.shouldSucceed('group-exists sharer');
    });

    await t.step('user-delete refuses an heir that does not exist', async () => {
      await cmd.shouldSucceed('user-create orphan --uid 2300');
      await cmd.shouldFail('user-delete orphan --to nobody-here');
      await cmd.shouldSucceed('user-exists orphan');
      await cmd.shouldSucceed('user-delete orphan');
    });

    await t.step('group-delete hands what the group owned to another group and drops ACL entries naming it', async () => {
      await cmd.shouldSucceed('group-create crew --gid 7100');
      await cmd.shouldSucceed('group-create successors --gid 7101');
      await cmd.shouldSucceed('mknode -t directory -g 7100 /crew-owned');
      await cmd.shouldSucceed('acl -m g:crew:rx /granted');

      const deleted = await client.execJson<{ to: string; owned: number; acl: number }>('group-delete crew --to successors');
      assertEquals([deleted.to, deleted.acl], ['successors', 1]);
      assertEquals((await client.execJson<{ gid: number }>('props /crew-owned')).gid, 7101);
      assertEquals((await client.execJson<{ gid?: number }[]>('acl /granted')).some((entry) => entry.gid === 7100), false);

      // By default the administrators' group takes over, and it cannot itself be deleted.
      await cmd.shouldSucceed('group-create crew2 --gid 7102');
      await cmd.shouldSucceed('mknode -t directory -g 7102 /crew2-owned');
      await cmd.shouldSucceed('group-delete crew2');
      assertEquals((await client.execJson<{ gid: number }>('props /crew2-owned')).gid, 0);
      await cmd.shouldFail('group-delete admin');
    });

    await t.step('group-delete --force moves users whose primary group it is back to their own group', async () => {
      await cmd.shouldSucceed('group-create team --gid 7200');
      await cmd.shouldSucceed('user-set-primary-group alice team');
      await cmd.shouldFail('group-delete team');
      await cmd.shouldSucceed('group-delete team --force');
      assertEquals((await client.execJson<{ gid: number }>('user-info alice')).gid, 3000);
    });

    await t.step('a uid or gid cannot be handed out twice', async () => {
      // Ownership and every ACL entry name a numeric id, never the node, so a
      // second holder of one is indistinguishable to every access check.
      await cmd.shouldFail('user-create imposter --uid 3000');
      await cmd.shouldFail('group-create imposters --gid 7000');

      // The clash is the id, not the name — a fresh id still works.
      await cmd.shouldSucceed('user-create genuine --uid 3010');
      await cmd.shouldSucceed('group-create genuines --gid 7001');
    });

    await t.step("a new user's uid is never another group's gid", async () => {
      // The new user's own group takes the uid as its gid, and a session counts its primary gid
      // as a membership, so a uid that is another group's gid is refused.
      await cmd.shouldSucceed('group-create taken --gid 3002');
      await cmd.shouldFail('user-create squatter --uid 3002');

      // Picked automatically — one past the highest uid, 3010 — the uid steps past a held gid.
      await cmd.shouldSucceed('group-create taken-next --gid 3011');
      await cmd.shouldSucceed('user-create newcomer');
      const newcomer = await client.execJson<{ uid: number; gid: number }>('user-info newcomer');
      assertEquals([newcomer.uid, newcomer.gid], [3012, 3012]);
    });

    await t.step('0 is an id like any other, not a request to pick one', async () => {
      // The administrator holds 0, so `--uid 0` names that id rather than asking for the next free one.
      await cmd.shouldSucceed('group-create wheel --gid 0');
      const wheel = await client.execJson<{ gid: number }>('attrs /etc/groups/wheel');
      assertEquals(wheel.gid, 0);
      await cmd.shouldFail('user-create rootish --uid 0');

      await cmd.shouldFail('user-create malformed --uid abc');
      await cmd.shouldFail('user-create negative --uid -5');
      await cmd.shouldFail('group-create malformed --gid 1.5');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
