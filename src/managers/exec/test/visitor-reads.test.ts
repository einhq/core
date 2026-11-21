/**
 * Someone who has not signed in reads what is shared with them and not how the household runs: the
 * guest where visitors may browse, and whoever holds a share link, list no accounts, groups or homes
 * and read no log, queue, pool or pipeline. They still learn who they are, get their sidebar, and
 * see who wrote the comments they read. A member reads them.
 */

import { assert, assertEquals } from '@std/assert';
import type { ShareLinkCreated, Whoami } from '../../../lib/api/mod.ts';
import type { CommentEntry } from '../../../lib/api/comments.ts';
import { createTestContext, testCommands } from '../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

/** What a visitor is refused; a member is refused only the system log, the administrators' (ein/core#1378). */
const CLOSED = [
  'ls /etc/users',
  'ls /etc/groups',
  'ls /home',
  'ls /groups',
  'attrs /etc/users/admin',
  'ls /var/logs',
  'tail -n 1 /var/logs/system',
  'ls /var/queues',
  'ls /var/pools',
  'ls /var/pipelines',
];

Deno.test({
  name: 'visitors read nothing of how the household runs',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);

  /** Each of `CLOSED` refused for `client`, and the rest of what a visitor runs answered. */
  const assertVisitor = async (client: Awaited<ReturnType<typeof testCtx.server.createShellClient>>, username: string) => {
    for (const command of CLOSED) assertEquals((await client.exec(command)).success, false, `${command} succeeded`);
    assertEquals((await client.execJson<Whoami>('user-whoami')).username, username);
    assertEquals((await client.exec('ui-nav')).success, true);
    assertEquals((await client.execString('cat /alb/a.txt')).trim(), 'shared');
    assertEquals((await client.execJson<CommentEntry[]>('comment list /alb/a.txt')).map((entry) => entry.author), ['commenter']);
  };

  try {
    await t.step('setup: visitors may browse, an album is shared with them, and a member commented on it', async () => {
      await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
      await cmd.shouldSucceed('mkdir -p /alb && echo shared > /alb/a.txt && share-set /alb --mode 0755 -b && chmod 0755 /');
      await cmd.shouldSucceed('user-create commenter && user-passwd commenter --new-password hunter2 && acl -m u:commenter:rwx /alb/a.txt');
      const commenter = await testCtx.server.createShellClient({ username: 'commenter', password: 'hunter2' });
      try {
        assertEquals((await commenter.exec("comment add /alb/a.txt --body 'Lovely'")).success, true);
      } finally {
        commenter.close();
      }
    });

    await t.step('the guest lists no accounts and reads no logs', async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        await assertVisitor(guest, 'guest');
      } finally {
        guest.close();
      }
    });

    await t.step("a link's holder neither", async () => {
      const created = await admin.execJson<ShareLinkCreated>('share-link create /alb');
      const visitor = await testCtx.server.createShellClient({ login: false });
      try {
        assertEquals((await visitor.exec(`share-link open ${created.link.token} --session`)).success, true);
        await assertVisitor(visitor, 'guest');
      } finally {
        visitor.close();
      }
      await cmd.shouldSucceed(`share-link remove ${created.link.id}`);
    });

    await t.step('a member reads them all', async () => {
      const member = await testCtx.server.createShellClient({ username: 'commenter', password: 'hunter2' });
      try {
        for (const command of CLOSED.filter((command) => !command.includes('/var/logs/system'))) {
          assert((await member.exec(command)).success, `${command} failed`);
        }
      } finally {
        member.close();
      }
    });
  } finally {
    await cmd.shouldSucceed('config set CFG_GUEST_BROWSING false');
    admin.close();
    await testCtx.teardown();
  }
});
