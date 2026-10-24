/**
 * Share links: a link is a principal of its own, what it opens to a visitor who has not signed in
 * and acts as it, and that turning it off, or its expiry, takes all of that away again.
 */

import { assert, assertEquals, assertMatch } from '@std/assert';
import { ADMIN_ACCESS, GUEST_GID, GUEST_UID, LINK_UID_BASE } from '../../../../../../lib/access/mod.ts';
import type { ShareInfo, ShareLink, ShareLinkCreated, ShareLinkOpened } from '../../../../../../lib/api/share.ts';
import { LINKS_PATH, SESSIONS_PATH } from '../../../../../../lib/paths.ts';
import { createTestContext, testCommands } from '../../../../../../testing/mod.ts';
import type { SessionAttrs } from '../../../../../../vfs/types/session.ts';

// Booted, so the guest is an account and `/var/links` is made as at any boot.
const testCtx = createTestContext({ boot: true });

type Props = { mode: number; acl?: { uid?: number; gid?: number; mode: number }[] };

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.test({
  name: 'share links',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs, baseUrl } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  const props = (path: string) => admin.execJson<Props>(`props ${path}`);

  let created: ShareLinkCreated | undefined;
  const link = () => created!.link;
  // A link's principal, as its record holds it.
  const uidOf = async (id: string) => (await vfs.get<{ uid: number }>(ADMIN_ACCESS, `${LINKS_PATH}/${id}`)).attrs.uid;
  let linkUid = 0;

  try {
    await t.step('setup: a private album with a folder, photos, and one photo kept private', async () => {
      await cmd.shouldSucceed('mkdir -p /alb/files/sub /other');
      await cmd.shouldSucceed('mkfile /alb/files/a.txt');
      await cmd.shouldSucceed('echo "from the album" > /alb/files/a.txt');
      await cmd.shouldSucceed('mkfile /alb/files/sub/b.txt');
      await cmd.shouldSucceed('mkfile /alb/files/secret.txt');
      await cmd.shouldSucceed('share-set /alb --mode 0750 -b');
      await cmd.shouldSucceed('share-set /alb/files/secret.txt --mode 0700 --pin');
      // The guest may pass through to the album, as through the archive roots.
      await cmd.shouldSucceed('chmod 0755 /');
    });

    await t.step('create gives the album and what is below it the link, but not what keeps its own sharing', async () => {
      created = await admin.execJson<ShareLinkCreated>('share-link create /alb');

      assertMatch(link().token!, /^[A-Za-z0-9]{22}$/);
      assertMatch(link().id, /^[0-9a-f]{16}$/);
      assertEquals(link().path, '/alb');
      assertEquals(link().opened, 0);
      // Thirty days unless told otherwise.
      assert(Math.abs(link().expiresAt! - (Date.now() + 30 * DAY_MS)) < 60_000);
      // /alb, files, sub, a.txt, b.txt — secret.txt keeps its own.
      assertEquals([created.updated, created.pinned, created.failed], [5, 1, 0]);

      linkUid = await uidOf(link().id);
      assert(linkUid >= LINK_UID_BASE);
      const entry = { uid: linkUid, mode: 0o5 };
      assertEquals((await props('/alb')).acl, [entry]);
      assertEquals((await props('/alb/files/sub/b.txt')).acl, [entry]);
      assertEquals((await props('/alb/files/secret.txt')).acl ?? [], []);
    });

    await t.step('a token that names nothing opens nothing', async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        assertEquals((await guest.exec('share-link open AAAAAAAAAAAAAAAAAAAAAA')).success, false);
        assertEquals((await guest.exec('share-link open not-a-token')).success, false);
        assertEquals((await guest.exec('cat /alb/files/a.txt')).success, false);
      } finally {
        guest.close();
      }
    });

    await t.step('open lets the visitor read what the link opens, and nothing it does not', async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        const opened = await guest.execJson<ShareLinkOpened>(`share-link open ${link().token} --session`);
        assertEquals(opened, { id: link().id, path: '/alb', type: 'directory', title: 'alb', expiresAt: link().expiresAt });

        assertEquals(String((await guest.exec('cat /alb/files/a.txt', { json: false })).data).trim(), 'from the album');
        assertEquals((await guest.exec('ls /alb/files/sub')).success, true);
        assertEquals((await guest.exec('cat /alb/files/secret.txt')).success, false);
        assertEquals((await guest.exec('mkfile /alb/files/new.txt')).success, false);
        // Who else has access is not the visitor's to learn.
        assertEquals((await guest.exec('share-info /alb')).success, false);

        // What is added to the album later is opened too.
        await cmd.shouldSucceed('mkfile /alb/files/later.txt');
        assertEquals((await guest.exec('stat /alb/files/later.txt')).success, true);

        // The session acts as it, so the next connection of the same browser does too.
        const sessions = await vfs.children<SessionAttrs>(ADMIN_ACCESS, SESSIONS_PATH);
        assert(sessions.some((entry) => entry.node.attrs.access?.uid === linkUid && entry.node.attrs.access.link?.id === link().id));

        // It answers as the guest, which the web UI keeps from signed-in pages, with its link.
        const whoami = await guest.execJson<{ username: string; links?: { id: string; path: string }[] }>('user-whoami');
        assertEquals(whoami.username, 'guest');
        assertEquals(whoami.links?.map((held) => [held.id, held.path]), [[link().id, '/alb']]);
      } finally {
        guest.close();
      }

      const record = await admin.execJson<ShareLink[]>('share-link list /alb');
      assertEquals(record[0].opened, 1);
      assert(record[0].lastOpenedAt! > 0);
    });

    await t.step('a visitor holds one link: opening another lets go of the first', async () => {
      await cmd.shouldSucceed('mkdir -p /second');
      await cmd.shouldSucceed('mkfile /second/c.txt');
      await cmd.shouldSucceed('share-set /second --mode 0750 -b');
      const second = await admin.execJson<ShareLinkCreated>('share-link create /second');

      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        await guest.execJson<ShareLinkOpened>(`share-link open ${link().token} --session`);
        await guest.execJson<ShareLinkOpened>(`share-link open ${second.link.token} --session`);

        assertEquals((await guest.exec('stat /second/c.txt')).success, true);
        assertEquals((await guest.exec('cat /alb/files/a.txt')).success, false);
        const whoami = await guest.execJson<{ links?: { id: string }[] }>('user-whoami');
        assertEquals(whoami.links?.map((held) => held.id), [second.link.id]);
      } finally {
        guest.close();
      }
      await cmd.shouldSucceed(`share-link remove ${second.link.id}`);
    });

    await t.step('share-info lists the link, its token only for someone who may change the album, and what keeps its own sharing', async () => {
      const info = await admin.execJson<ShareInfo>('share-info /alb');
      assertEquals(info.links.map((each) => [each.id, each.token]), [[link().id, link().token]]);
      assertEquals(info.exceptions.map((each) => [each.path, each.preset]), [['/alb/files/secret.txt', 'private']]);
      assertEquals(info.exceptionCount, 1);
      assertEquals(info.guestBrowsing, false);
      // The link is not a grant the dialog lists as a person or a group.
      assertEquals(info.grants.filter((grant) => grant.source === 'acl'), []);

      await cmd.shouldSucceed('user-create reader');
      await cmd.shouldSucceed('user-passwd reader --new-password secret1');
      await cmd.shouldSucceed('share-set /alb -m u:reader:rx');
      const reader = await testCtx.server.createShellClient({ username: 'reader', password: 'secret1' });
      try {
        const seen = await reader.execJson<ShareInfo>('share-info /alb');
        assertEquals(seen.links.map((each) => [each.id, each.token]), [[link().id, undefined]]);
        // Whom to add is for someone who may add anybody.
        assertEquals([seen.canEdit, seen.users, seen.groups], [false, [], []]);
        assertEquals((await reader.exec(`share-link remove ${link().id}`)).success, false);

        // Someone signed in who opens a link stays themselves.
        await reader.execJson<ShareLinkOpened>(`share-link open ${link().token} --session`);
        assertEquals((await reader.execJson<{ username: string; links?: unknown[] }>('user-whoami')).username, 'reader');
        assertEquals((await reader.execJson<{ links?: unknown[] }>('user-whoami')).links, undefined);
      } finally {
        reader.close();
      }
    });

    await t.step('re-sharing the album from the dialog keeps the link', async () => {
      await cmd.shouldSucceed('share-set /alb --mode 0750 -b -m u:reader:rx');
      assertEquals((await props('/alb/files/a.txt')).acl?.some((entry) => entry.uid === linkUid), true);
    });

    await t.step("a photo given sharing of its own leaves the link, and takes it back with the album's", async () => {
      await cmd.shouldSucceed('share-set /alb/files/a.txt --mode 0700 -b --drop-links --pin');
      assertEquals((await props('/alb/files/a.txt')).acl ?? [], []);

      await cmd.shouldSucceed('share-set /alb/files/a.txt --reference /alb --unpin');
      assertEquals((await props('/alb/files/a.txt')).acl?.some((entry) => entry.uid === linkUid), true);
    });

    await t.step('a session holding the link fetches files over HTTP; turned off, it does not', async () => {
      const { cookie, sessionPath } = await testCtx.harness.createHttpSession({ uid: GUEST_UID, gid: GUEST_GID, gids: [GUEST_GID] });
      const fetchA = async () => {
        const res = await fetch(`${baseUrl}/file/alb/files/a.txt`, { headers: { cookie } });
        await res.body?.cancel();
        return res.status;
      };

      // The guest of an archive that asks visitors to sign in is refused `/file` outright.
      assertEquals(await fetchA(), 401);
      await vfs.update<SessionAttrs>(ADMIN_ACCESS, sessionPath, {
        attrs: { access: { uid: linkUid, gid: linkUid, gids: [], link: { id: link().id, expiresAt: link().expiresAt } } },
      });
      assertEquals(await fetchA(), 200);

      // Moved out of the album, a photo took the entry along; turning the link off reaches it there.
      await cmd.shouldSucceed('mv /alb/files/sub/b.txt /other/b.txt');
      assertEquals((await props('/other/b.txt')).acl?.some((entry) => entry.uid === linkUid), true);

      const removed = await admin.execJson<{ cleared: number }>(`share-link remove ${link().id}`);
      assert(removed.cleared >= 6);

      // Back to the guest.
      assertEquals(await fetchA(), 401);
      assertEquals((await props('/other/b.txt')).acl?.some((entry) => entry.uid === linkUid) ?? false, false);
      // The session acting as it is the guest again.
      assertEquals((await vfs.get<SessionAttrs>(ADMIN_ACCESS, sessionPath)).attrs.access, { uid: GUEST_UID, gid: GUEST_GID, gids: [GUEST_GID] });
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${LINKS_PATH}/${link().id}`), false);
    });

    await t.step('an expired link opens nothing, and reap turns it off', async () => {
      const soon = await admin.execJson<ShareLinkCreated>(`share-link create /alb --expires ${Date.now() + DAY_MS}`);
      const soonUid = await uidOf(soon.link.id);
      // A uid turned off, its entries gone with it, may be handed out again.
      assert(soonUid >= LINK_UID_BASE);
      const never = await admin.execJson<ShareLink>(`share-link set ${soon.link.id} --never`);
      assertEquals(never.expiresAt, undefined);

      await vfs.update(ADMIN_ACCESS, `${LINKS_PATH}/${soon.link.id}`, { attrs: { expiresAt: Date.now() - 1 } });

      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        assertEquals((await guest.exec(`share-link open ${soon.link.token}`)).success, false);
        assertEquals((await guest.exec('cat /alb/files/a.txt')).success, false);
      } finally {
        guest.close();
      }

      assertEquals((await admin.execJson<{ removed: number }>('share-link reap')).removed, 1);
      assertEquals((await props('/alb')).acl?.some((entry) => entry.uid === soonUid) ?? false, false);
      assertEquals(await admin.execJson<ShareLink[]>('share-link list /alb'), []);
    });

    await t.step('only someone who may change a node shares it, and an expiry is in the future', async () => {
      const reader = await testCtx.server.createShellClient({ username: 'reader', password: 'secret1' });
      try {
        assertEquals((await reader.exec('share-link create /alb')).success, false);
        assertEquals((await reader.exec('share-link reap')).success, false);
      } finally {
        reader.close();
      }
      await cmd.shouldFail(`share-link create /alb --expires ${Date.now() - DAY_MS}`);
      await cmd.shouldFail('share-link create /alb --expires tomorrowish');
    });

    await t.step("no account or group is given a number from the range links' uids come from", async () => {
      await cmd.shouldFailWith(`user-create someone --uid ${LINK_UID_BASE + 5}`, 'share links');
      await cmd.shouldFailWith(`group-create somegroup --gid ${LINK_UID_BASE + 5}`, 'share links');
    });
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
