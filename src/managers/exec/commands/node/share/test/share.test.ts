/**
 * Recursive access changes and the pin that stops them.
 *
 * The point of the pin is one photo staying private inside an album that is
 * otherwise shared, so most of what is asserted here is what a recursive apply
 * must *not* touch: a pinned node, anything below it, whatever is on the far
 * end of a softlink, and the walk itself when one node refuses.
 */

import { assert, assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '../../../../../../testing/mod.ts';

const testCtx = createTestContext();

type Props = { mode: number; uid: number; gid: number; acl?: { uid?: number; gid?: number; mode: number }[] };

Deno.test({
  name: 'recursive sharing',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const props = (path: string) => client.execJson<Props>(`props ${path}`);

  try {
    await t.step('setup: an album with a subfolder, a photo and a linked-in photo', async () => {
      await cmd.shouldSucceed('mkdir -p /alb/files/sub');
      await cmd.shouldSucceed('mkfile /alb/files/a.jpg');
      await cmd.shouldSucceed('mkfile /alb/files/sub/b.jpg');
      await cmd.shouldSucceed('mkfile /alb/files/sub/pinned.jpg');
      // Lives outside the album and is only linked into it, the way an album of
      // members rather than of files is built.
      await cmd.shouldSucceed('mkdir -p /elsewhere');
      await cmd.shouldSucceed('mkfile /elsewhere/target.jpg');
      await cmd.shouldSucceed('ln -s /elsewhere/target.jpg /alb/files/link.jpg');
      await cmd.shouldSucceed('chmod 700 /elsewhere/target.jpg');
    });

    await t.step('share-set reaches every node below the album', async () => {
      const result = await client.execJson<{ ok: boolean; updated: number; failed: number }>(
        'share-set /alb --mode 0750',
      );

      assertEquals(result.ok, true);
      assertEquals(result.failed, 0);
      // /alb, files, sub, a.jpg, b.jpg, pinned.jpg, link.jpg
      assertEquals(result.updated, 7);

      assertEquals((await props('/alb')).mode & 0o777, 0o750);
      assertEquals((await props('/alb/files/sub/b.jpg')).mode & 0o777, 0o750);
    });

    await t.step('a softlink is changed, never followed', async () => {
      // The link node moved with the rest; what it points at did not.
      assertEquals((await client.execJson<Props>('props -L /alb/files/link.jpg')).mode & 0o777, 0o750);
      assertEquals((await props('/elsewhere/target.jpg')).mode & 0o777, 0o700);
    });

    await t.step('a pinned node and its subtree are left alone', async () => {
      await cmd.shouldSucceed('share-set /alb/files/sub --mode 0700 --pin');
      // The pin is the subject of that call, so its own subtree still moved.
      assertEquals((await props('/alb/files/sub/b.jpg')).mode & 0o777, 0o700);

      const result = await client.execJson<{ updated: number; pinned: number }>('share-set /alb --mode 0755');

      // /alb, files, a.jpg, link.jpg — sub and everything under it skipped.
      assertEquals(result.updated, 4);
      assertEquals(result.pinned, 1);

      assertEquals((await props('/alb')).mode & 0o777, 0o755);
      assertEquals((await props('/alb/files/a.jpg')).mode & 0o777, 0o755);
      assertEquals((await props('/alb/files/sub')).mode & 0o777, 0o700);
      assertEquals((await props('/alb/files/sub/b.jpg')).mode & 0o777, 0o700);
    });

    await t.step('a pinned node aimed at directly still changes', async () => {
      await cmd.shouldSucceed('share-set /alb/files/sub --mode 0770');
      assertEquals((await props('/alb/files/sub')).mode & 0o777, 0o770);
      // Still pinned: the change came from here, not from above.
      const info = await client.execJson<{ pinned: boolean }>('share-info /alb/files/sub');
      assertEquals(info.pinned, true);
    });

    await t.step('--unpin lets changes from above through again', async () => {
      await cmd.shouldSucceed('share-set /alb/files/sub --unpin');
      assertEquals((await client.execJson<{ pinned: boolean }>('share-info /alb/files/sub')).pinned, false);

      const result = await client.execJson<{ pinned: number; updated: number }>('share-set /alb --mode 0755');
      assertEquals(result.pinned, 0);
      assertEquals(result.updated, 7);
      assertEquals((await props('/alb/files/sub/b.jpg')).mode & 0o777, 0o755);
    });

    await t.step('the pin is written to the root only', async () => {
      await cmd.shouldSucceed('share-set /alb --mode 0750 --pin');
      assertEquals((await client.execJson<{ pinned: boolean }>('share-info /alb')).pinned, true);
      assertEquals((await client.execJson<{ pinned: boolean }>('share-info /alb/files/a.jpg')).pinned, false);
      await cmd.shouldSucceed('share-set /alb --unpin');
    });

    await t.step('share-set writes mode and the whole acl in one pass', async () => {
      // Explicit gid, so the grant names a number nothing else in the test holds.
      await cmd.shouldSucceed('group-create friends --gid 7100');
      await cmd.shouldSucceed('user-create anna');

      await cmd.shouldSucceed('share-set /alb --mode 0750 -b -m g:friends:rx -m u:anna:rwx');

      const album = await props('/alb');
      assertEquals(album.acl?.length, 2);

      // The list reached the leaves, not just the album.
      const leaf = await props('/alb/files/sub/b.jpg');
      assertEquals(leaf.acl?.length, 2);
      assert(leaf.acl?.some((entry) => entry.uid !== undefined && (entry.mode & 0o2) !== 0));
    });

    await t.step('--reference shares a subtree as another node is, owner aside', async () => {
      await cmd.shouldSucceed('mkdir -p /ref /loose/inner');
      await cmd.shouldSucceed('mkfile /loose/inner/c.jpg');
      await cmd.shouldSucceed('share-set /ref --owner anna --group friends --mode 0750 -b -m u:anna:rwx');
      const owner = (await props('/loose')).uid;

      await cmd.shouldSucceed('share-set /loose --reference /ref');

      const ref = await props('/ref');
      const leaf = await props('/loose/inner/c.jpg');
      assertEquals(leaf.gid, 7100);
      assertEquals(leaf.mode & 0o777, 0o750);
      assertEquals(leaf.acl, ref.acl);
      assertEquals(leaf.uid, owner);
      await cmd.shouldFail('share-set /loose --reference /ref --mode 0700');
    });

    await t.step('share-info reports the grants and who they reach', async () => {
      const info = await client.execJson<{
        preset: string;
        owner: { username?: string; path?: string; level: string };
        everyone: string;
        grants: { kind: string; name: string; path?: string; level: string; source: string }[];
        effective: { username: string; path: string; level: string; via: string }[];
        users: { username: string; gids: number[]; admin: boolean }[];
      }>('share-info /alb');

      assertEquals(info.preset, 'shared');
      assertEquals(info.owner.username, 'admin');
      assertEquals(info.owner.path, '/etc/users/admin');
      assertEquals(info.owner.level, 'edit');
      assertEquals(info.everyone, 'none');

      const friends = info.grants.find((grant) => grant.name === 'friends');
      assertEquals(friends?.level, 'view');
      assertEquals(friends?.source, 'acl');

      const anna = info.grants.find((grant) => grant.name === 'anna');
      assertEquals(anna?.kind, 'user');
      assertEquals(anna?.path, '/etc/users/anna');
      assertEquals(anna?.level, 'edit');

      // anna reads through `users` like everyone else, but only her own acl
      // entry carries the write — so that is the rule the row must name.
      const effectiveAnna = info.effective.find((entry) => entry.username === 'anna');
      assertEquals(effectiveAnna?.path, '/etc/users/anna');
      assertEquals(effectiveAnna?.level, 'edit');
      assertEquals(effectiveAnna?.via, 'direct');

      assertEquals(info.users.find((user) => user.username === 'admin')?.admin, true);
      assert(info.users.find((user) => user.username === 'anna')?.gids.length);
    });

    await t.step('share-info names the person an account is, whose picture stands for it', async () => {
      await cmd.shouldSucceed('mkdir -p /people/anna-andersson');
      await cmd.shouldSucceed('ln -s /people/anna-andersson /etc/users/anna/person');

      const info = await client.execJson<{
        owner: { personPath?: string };
        grants: { name: string; personPath?: string }[];
        users: { username: string; personPath?: string }[];
      }>('share-info /alb');

      assertEquals(info.grants.find((grant) => grant.name === 'anna')?.personPath, '/people/anna-andersson');
      assertEquals(info.users.find((user) => user.username === 'anna')?.personPath, '/people/anna-andersson');
      // An account with no person has none.
      assertEquals(info.owner.personPath, undefined);
    });

    await t.step('share-info withholds group membership from non-admin callers', async () => {
      await cmd.shouldSucceed('user-passwd anna --new-password secret1');
      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
      try {
        const info = await anna.execJson<{
          effective: unknown[];
          users: { username: string; gids?: number[]; admin?: boolean }[];
        }>('share-info /alb');

        assertEquals(info.effective, []);
        assertEquals(info.users.every((user) => user.gids === undefined && user.admin === undefined), true);
        assertEquals((await anna.exec('group-members friends')).success, false);
      } finally {
        anna.close();
      }
    });

    await t.step('the reason names the group that actually granted it', async () => {
      // The shape the real corpus is in: the node's group is `users`, which
      // every session carries, and write comes from an access-list entry for a
      // group only some people are in. A row saying "member of users" for that
      // write would name the wrong group.
      // `users` carries USERS_GID, which every session is given whatever else it
      // has — that is what makes the node's group universal on the real corpus.
      await cmd.shouldSucceed('group-create users --gid 1002');
      await cmd.shouldSucceed('group-create editors --gid 7101');
      await cmd.shouldSucceed('user-create bo');
      await cmd.shouldSucceed('group-add-member editors anna');

      await cmd.shouldSucceed('mkdir -p /corpus');
      await cmd.shouldSucceed('chown :users /corpus');
      await cmd.shouldSucceed('share-set /corpus --mode 0750 -b -m g:editors:rwx');

      const info = await client.execJson<{ effective: { username: string; level: string; via: string; viaGroup?: string }[] }>(
        'share-info /corpus',
      );

      const anna = info.effective.find((entry) => entry.username === 'anna');
      assertEquals(anna?.level, 'edit');
      assertEquals(anna?.viaGroup, 'editors');

      // bo reads through `users` like everyone signed in, and that is the group
      // his row must name — not the one that granted anna's write.
      const bo = info.effective.find((entry) => entry.username === 'bo');
      assertEquals(bo?.level, 'view');
      assertEquals(bo?.viaGroup, 'users');
    });

    await t.step('everyone is a grant to visitors, shared counts the other bits, private is the owner alone', async () => {
      await cmd.shouldSucceed('share-set /alb --mode 0700 -b -m g:1001:rx');
      assertEquals((await client.execJson<{ preset: string }>('share-info /alb')).preset, 'everyone');

      await cmd.shouldSucceed('share-set /alb --mode 0705 -b');
      assertEquals((await client.execJson<{ preset: string }>('share-info /alb')).preset, 'shared');

      await cmd.shouldSucceed('share-set /alb --mode 0700 -b');
      assertEquals((await client.execJson<{ preset: string }>('share-info /alb')).preset, 'private');
    });

    await t.step('a node the caller cannot write is counted, not fatal', async () => {
      await cmd.shouldSucceed('user-create eve');
      await cmd.shouldSucceed('user-passwd eve --new-password secret1');
      await cmd.shouldSucceed('mkdir -p /shared/mine');
      await cmd.shouldSucceed('mkfile /shared/mine/ok.txt');
      await cmd.shouldSucceed('mkfile /shared/locked.txt');
      // eve may work in /shared but does not own the file inside it. `mine` is
      // deliberately unwritable while its content is not: a directory she
      // cannot change must not hide the file inside it that she can.
      await cmd.shouldSucceed('chmod 777 /shared');
      await cmd.shouldSucceed('chmod 555 /shared/mine');
      await cmd.shouldSucceed('chmod 777 /shared/mine/ok.txt');
      await cmd.shouldSucceed('chmod 700 /shared/locked.txt');

      const eve = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });
      try {
        // 0770 takes away the other-bits eve was reaching /shared through, so
        // this also pins down that the tree is read before anything is written
        // — applied the other way round she would lock herself out of her own
        // operation after the first node and silently change nothing else.
        const result = await eve.execJson<{ updated: number; failed: number; failures: { path: string }[] }>(
          'share-set /shared --mode 0770',
        );

        // /shared and ok.txt — `mine` refused, and refusing `mine` did not hide the writable file
        // underneath it. locked.txt is not listed to eve, so it is counted against /shared
        // without its name.
        assertEquals(result.updated, 2);
        assertEquals(result.failed, 2);
        assertEquals(result.failures.map((failure) => failure.path).sort(), ['/shared', '/shared/mine']);
      } finally {
        eve.close();
      }
    });

    await t.step('--default-owner reaches only the nodes the caller could write', async () => {
      const anna = (await props('/ref')).uid;
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_OWNER anna');
      await cmd.shouldSucceed('config set CFG_DEFAULT_SHARE_GROUP friends');
      await cmd.shouldSucceed('mkdir -p /given/open');
      await cmd.shouldSucceed('mkfile /given/open/photo.jpg');
      await cmd.shouldSucceed('mkfile /given/closed.jpg');
      await cmd.shouldSucceed('chmod -r 777 /given');
      await cmd.shouldSucceed('chmod 755 /given/closed.jpg');
      const closed = await props('/given/closed.jpg');

      const eve = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });
      try {
        // The owner and group are the server's to give, so they are written with more authority
        // than eve has — and still land only where eve could have written herself.
        const result = await eve.execJson<{ updated: number; failures: { path: string }[] }>('share-set /given --default-owner');

        assertEquals(result.updated, 3);
        assertEquals(result.failures.map((failure) => failure.path), ['/given/closed.jpg']);
      } finally {
        eve.close();
        await cmd.shouldSucceed('config unset CFG_DEFAULT_SHARE_OWNER');
        await cmd.shouldSucceed('config unset CFG_DEFAULT_SHARE_GROUP');
      }

      const photo = await props('/given/open/photo.jpg');
      assertEquals([photo.uid, photo.gid], [anna, 7100]);
      const after = await props('/given/closed.jpg');
      assertEquals([after.uid, after.gid], [closed.uid, closed.gid]);
    });

    await t.step('chmod -r and acl -r recurse and honour the pin', async () => {
      await cmd.shouldSucceed('mkdir -p /r/keep');
      await cmd.shouldSucceed('mkfile /r/keep/deep.txt');
      await cmd.shouldSucceed('mkfile /r/plain.txt');
      await cmd.shouldSucceed('share-set /r/keep --mode 0700 --pin');

      await cmd.shouldSucceed('chmod -r 0755 /r');
      assertEquals((await props('/r')).mode & 0o777, 0o755);
      assertEquals((await props('/r/plain.txt')).mode & 0o777, 0o755);
      assertEquals((await props('/r/keep')).mode & 0o777, 0o700);
      assertEquals((await props('/r/keep/deep.txt')).mode & 0o777, 0o700);

      await cmd.shouldSucceed('acl -r -m g:friends:r /r');
      assertEquals((await props('/r/plain.txt')).acl?.length, 1);
      assertEquals((await props('/r/keep/deep.txt')).acl ?? [], []);
    });

    await t.step('a symbolic chmod -r changes the bits it names on each node and keeps the rest', async () => {
      await cmd.shouldSucceed('mkdir -p /sym/dir && mkfile /sym/a.txt && mkfile /sym/dir/b.txt');
      await cmd.shouldSucceed('chmod 0775 /sym && chmod 0755 /sym/dir && chmod 0644 /sym/a.txt && chmod 0604 /sym/dir/b.txt');

      await cmd.shouldSucceed('chmod -r o-rw /sym');
      assertEquals((await props('/sym')).mode & 0o777, 0o771);
      assertEquals((await props('/sym/dir')).mode & 0o777, 0o751);
      assertEquals((await props('/sym/a.txt')).mode & 0o777, 0o640);
      assertEquals((await props('/sym/dir/b.txt')).mode & 0o777, 0o600);
      await cmd.shouldFail('chmod -r q+z /sym');
    });

    await t.step('chmod without -r still touches only the named node', async () => {
      await cmd.shouldSucceed('chmod 0700 /r');
      assertEquals((await props('/r')).mode & 0o777, 0o700);
      assertEquals((await props('/r/plain.txt')).mode & 0o777, 0o755);
    });

    await t.step('a node linked in twice is written once, not endlessly', async () => {
      await cmd.shouldSucceed('mkdir -p /multi/a');
      await cmd.shouldSucceed('mkdir -p /multi/b');
      await cmd.shouldSucceed('mkfile /multi/a/shared.txt');
      // The same node under two parents inside the same subtree.
      await cmd.shouldSucceed('ln /multi/a/shared.txt /multi/b/shared.txt');

      const result = await client.execJson<{ updated: number }>('share-set /multi --mode 0750');

      // /multi, a, b, shared.txt — counted once however many ways in there are.
      assertEquals(result.updated, 4);
      assertEquals((await props('/multi/b/shared.txt')).mode & 0o777, 0o750);
    });

    await t.step('share-set refuses an empty change and contradictory pins', async () => {
      await cmd.shouldFail('share-set /r');
      await cmd.shouldFail('share-set /r --pin --unpin');
    });

    await t.step('each node edits its own list: what a folder inside lists beyond the edit stays', async () => {
      await cmd.shouldSucceed('mkdir -p /own/inner /own/other');
      await cmd.shouldSucceed('share-set /own/inner -m u:anna:rx');

      await cmd.shouldSucceed('share-set /own -m g:friends:rx');

      assertEquals((await props('/own')).acl, [{ gid: 7100, mode: 0o5 }]);
      assertEquals((await props('/own/other')).acl, [{ gid: 7100, mode: 0o5 }]);
      assertEquals((await props('/own/inner')).acl, [{ uid: (await props('/home/anna')).uid, mode: 0o5 }, { gid: 7100, mode: 0o5 }]);

      // -b clears what each node lists for users and groups before the new list goes on.
      await cmd.shouldSucceed('share-set /own -b -m g:editors:rwx');
      assertEquals((await props('/own/inner')).acl, [{ gid: 7101, mode: 0o7 }]);
    });

    await t.step('several paths in one call, a refused one counted rather than fatal', async () => {
      await cmd.shouldSucceed('mkdir -p /many/a /many/b');
      await cmd.shouldSucceed('mkfile /many/a/one.jpg');
      await cmd.shouldSucceed('chmod 0700 /many/b');

      const result = await client.execJson<{ updated: number; failed: number }>('share-set /many/a /many/b --mode 0750 --pin');
      assertEquals(result.updated, 3);
      assertEquals((await client.execJson<{ pinned: boolean }>('share-info /many/b')).pinned, true);

      const eve = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });
      try {
        await cmd.shouldSucceed('chmod 0777 /many/a');
        const partly = await eve.execJson<{ updated: number; failed: number; failures: { path: string }[] }>(
          'share-set /many/a /many/b --mode 0777 --no-recursive',
        );
        assertEquals(partly.failed, 1);
        assertEquals(partly.failures.map((failure) => failure.path), ['/many/b']);
        // Refused on every node it names: nothing changed, and the command fails.
        assertEquals((await eve.exec('share-set /many/b --mode 0777')).success, false);
      } finally {
        eve.close();
      }
    });

    await t.step('--pinned-below changes every pinned node below, past the ones share-info lists, and nothing else', async () => {
      await cmd.shouldSucceed('mkdir -p /exc/sub && share-set /exc --mode 0750');
      const pinned = Array.from({ length: 52 }, (_, i) => `/exc/sub/${i}.jpg`);
      for (const path of pinned) await cmd.shouldSucceed(`mkfile ${path} && share-set ${path} --mode 0700 --pin`);
      await cmd.shouldSucceed('mkfile /exc/plain.jpg && chmod 0700 /exc/plain.jpg');
      assertEquals((await client.execJson<{ exceptionCount: number; exceptions: unknown[] }>('share-info /exc')).exceptions.length, 50);

      const result = await client.execJson<{ updated: number; failed: number }>('share-set /exc --pinned-below --reference /exc --unpin');
      assertEquals(result, { ...result, updated: 52, failed: 0 });
      assertEquals((await client.execJson<{ exceptionCount: number }>('share-info /exc')).exceptionCount, 0);
      assertEquals((await props('/exc/sub/51.jpg')).mode & 0o777, 0o750);
      assertEquals((await props('/exc/plain.jpg')).mode & 0o777, 0o700);

      // With none left there is nothing to change, which is not a failure.
      assertEquals((await client.execJson<{ updated: number }>('share-set /exc --pinned-below --reference /exc --unpin')).updated, 0);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
