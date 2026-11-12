/**
 * Display links: a share link made `--as` an account shows what it opens, and everything else,
 * as that account sees it — its groups, its home — to a visitor who never signs in, who still
 * writes nothing. Only the account itself or an administrator makes one, never as an account that
 * is or may become an administrator; it opens nothing once the account may no longer be shown as,
 * once it has expired, or once it is turned off, and a deleted account's links go with it.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../../../lib/access/mod.ts';
import type { ShareInfo, ShareLink, ShareLinkCreated, Whoami } from '../../../../../../lib/api/mod.ts';
import { LINKS_PATH, SESSIONS_PATH } from '../../../../../../lib/paths.ts';
import { createTestContext, testCommands } from '../../../../../../testing/mod.ts';
import type { SessionAttrs } from '../../../../../../vfs/types/session.ts';

const testCtx = createTestContext({ boot: true });

type Props = { acl?: { uid?: number; gid?: number; mode: number }[] };

Deno.test({
  name: 'display links',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  const text = async (client: Awaited<ReturnType<typeof testCtx.server.createShellClient>>, line: string) =>
    String((await client.exec(line, { json: false })).data ?? '').trim();

  let display: ShareLinkCreated | undefined;

  try {
    await t.step('setup: a board only the administrator reads, a household, and the accounts', async () => {
      await cmd.shouldSucceed('mkdir -p /archive/boards && echo "the board" > /archive/boards/kitchen.yaml');
      await cmd.shouldSucceed('share-set /archive/boards/kitchen.yaml --mode 0700 -b');
      await cmd.shouldSucceed('chmod 0771 /archive/boards');
      await cmd.shouldSucceed('group-create household --gid 7300');
      // The household's home, as a group's is: its members', closed to everyone else.
      await cmd.shouldSucceed('mkdir -p /groups/household && chown admin:household /groups/household && chmod 0770 /groups/household');
      await cmd.shouldSucceed('mkdir -p /groups/household/todos && echo "rye bread" > /groups/household/todos/shopping.md');
      for (const name of ['display', 'anna', 'bo', 'sudoer']) await cmd.shouldSucceed(`user-create ${name}`);
      await cmd.shouldSucceed('user-passwd anna --new-password secret1');
      await cmd.shouldSucceed('group-add-member household display');
      await cmd.shouldSucceed('group-add-member sudo sudoer');
      await cmd.shouldSucceed('echo "only display" > /home/display/own.txt && chown display /home/display/own.txt && chmod 0600 /home/display/own.txt');
      await cmd.shouldSucceed('echo "only anna" > /home/anna/secret.txt && chown anna /home/anna/secret.txt && chmod 0600 /home/anna/secret.txt');
      // Shared with the account itself, which no link of it may take away.
      await cmd.shouldSucceed('echo "for display" > /archive/boards/notes.txt && chmod 0700 /archive/boards/notes.txt && acl -m u:display:r /archive/boards/notes.txt');
    });

    await t.step('an administrator makes one as an account a link may show things as, and no other', async () => {
      display = await admin.execJson<ShareLinkCreated>('share-link create /archive/boards/kitchen.yaml --as display --never');
      assertEquals(display.link.as?.uid !== undefined && display.link.as.refusal === undefined, true);
      assertEquals(display.link.expiresAt, undefined);
      // The board opens through the link's own entry, whoever the account is.
      assertEquals((await admin.execJson<Props>('props /archive/boards/kitchen.yaml')).acl?.length, 1);

      await cmd.shouldFailWith('share-link create /archive/boards/kitchen.yaml --as admin', 'administrator');
      await cmd.shouldFailWith('share-link create /archive/boards/kitchen.yaml --as guest', 'guest');
      await cmd.shouldFailWith('share-link create /archive/boards/kitchen.yaml --as sudoer', 'sudo');
      await cmd.shouldFailWith('share-link create /archive/boards/kitchen.yaml --as nobody', 'no such account');

      // The dialog offers the accounts a link may show things as.
      const info = await admin.execJson<ShareInfo>('share-info /archive/boards/kitchen.yaml');
      const offered = info.displayAccounts.map((account) => account.username);
      assert(offered.includes('display') && offered.includes('anna'), offered.join(','));
      assertEquals(offered.some((name) => ['admin', 'guest', 'sudoer'].includes(name)), false);
    });

    await t.step('someone else makes one only as themselves', async () => {
      await cmd.shouldSucceed('echo "anna\'s board" > /home/anna/board.yaml && chown anna /home/anna/board.yaml');
      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
      try {
        const refused = await anna.exec('share-link create /home/anna/board.yaml --as display');
        assertEquals([refused.success, refused.error?.includes('only an administrator')], [false, true]);
        const own = await anna.execJson<ShareLinkCreated>('share-link create /home/anna/board.yaml --as anna');
        assertEquals(own.link.as?.name !== undefined || own.link.as?.uid !== undefined, true);
        const info = await anna.execJson<ShareInfo>('share-info /home/anna/board.yaml');
        assertEquals(info.displayAccounts.map((account) => [account.username, account.you]), [['anna', true]]);
        await anna.execJson(`share-link remove ${own.link.id}`);
      } finally {
        anna.close();
      }
    });

    await t.step('opened, it reads as the account does, and writes nothing', async () => {
      const visitor = await testCtx.server.createShellClient({ login: false });
      try {
        assertEquals((await visitor.exec(`share-link open ${display!.link.token} --session`)).success, true);
        assertEquals(await text(visitor, 'echo $USER $HOME'), 'display /home/display');
        assertEquals(await text(visitor, 'cat /archive/boards/kitchen.yaml'), 'the board');
        assertEquals(await text(visitor, 'cat /groups/household/todos/shopping.md'), 'rye bread');
        assertEquals(await text(visitor, 'cat /home/display/own.txt'), 'only display');
        assertEquals((await visitor.exec('cat /home/anna/secret.txt')).success, false);

        assertEquals((await visitor.exec('echo more >> /groups/household/todos/shopping.md')).success, false);
        assertEquals((await visitor.exec('mkfile /home/display/new.txt')).success, false);
        const refused = await visitor.exec('user-update display --name Someone');
        assertEquals([refused.success, refused.error?.includes('sign in first')], [false, true]);

        // It answers as the guest with its link, which keeps the Web UI to the board.
        const whoami = await visitor.execJson<Whoami>('user-whoami');
        assertEquals([whoami.username, whoami.admin, whoami.links?.map((held) => held.path)], ['guest', false, ['/archive/boards/kitchen.yaml']]);

        // The session lasts as a link's does, and holds the account with the link.
        const sessions = await vfs.children<SessionAttrs>(ADMIN_ACCESS, SESSIONS_PATH);
        const held = sessions.find((entry) => entry.node.attrs.access?.link?.id === display!.link.id);
        assertEquals(held?.node.attrs.expiresSec, 2592000);
        assertEquals(held?.node.attrs.env?.USER, 'display');
      } finally {
        visitor.close();
      }
    });

    await t.step('expired, it reads nothing of the account’s, and turned off, nothing at all', async () => {
      const visitor = await testCtx.server.createShellClient({ login: false });
      try {
        await visitor.exec(`share-link open ${display!.link.token}`);
        assertEquals(await text(visitor, 'cat /groups/household/todos/shopping.md'), 'rye bread');
        await admin.execJson<ShareLink>(`share-link set ${display!.link.id} --expires ${Date.now() + 1500}`);
        await new Promise((resolve) => setTimeout(resolve, 1600));
        assertEquals((await visitor.exec('cat /groups/household/todos/shopping.md')).success, false);
        assertEquals((await visitor.exec('cat /home/display/own.txt')).success, false);
        assertEquals((await visitor.exec(`share-link open ${display!.link.token}`)).success, false);
      } finally {
        visitor.close();
      }

      await admin.execJson(`share-link set ${display!.link.id} --never`);
      await admin.execJson(`share-link remove ${display!.link.id}`);
      // Turning it off took the link's entry and left the account's own sharing alone.
      assertEquals((await admin.execJson<Props>('props /archive/boards/kitchen.yaml')).acl ?? [], []);
      assertEquals((await admin.execJson<Props>('props /archive/boards/notes.txt')).acl?.length, 1);
    });

    await t.step('one shown as an account that may no longer be opens nothing, and goes when the account does', async () => {
      const again = await admin.execJson<ShareLinkCreated>('share-link create /archive/boards/kitchen.yaml --as display');
      await cmd.shouldSucceed('group-add-member sudo display');
      const visitor = await testCtx.server.createShellClient({ login: false });
      try {
        assertEquals((await visitor.exec(`share-link open ${again.link.token}`)).success, false);
        const listed = await admin.execJson<ShareLink[]>('share-link list /archive/boards/kitchen.yaml');
        assert(listed[0].as?.refusal?.includes('sudo'), JSON.stringify(listed[0].as));
      } finally {
        visitor.close();
      }

      await cmd.shouldSucceed('user-delete display');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${LINKS_PATH}/${again.link.id}`), false);
    });
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
