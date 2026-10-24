/**
 * The root layout is a claim the whole system leans on, so it is asserted rather
 * than described.
 *
 * `ls /` is checked exactly, not for a subset: the point of the split is that
 * nothing new appears at the top level, and the failures worth catching are all
 * additions — a lazily created `/queues`, a bootstrap mount left behind, a
 * command that pinned a parent to `'/'` and passed a basename. Every one of
 * those looks fine to a subset check.
 *
 * `/var` is checked for the same reason in reverse: it must be complete on an
 * instance that has done no work at all, not only once the pipeline engine or
 * `mod setup` first writes to it.
 */

import { assertEquals } from '@std/assert';
import { createTestContext } from '../../testing/mod.ts';
import { GROUPS_PATH, SESSIONS_PATH, TAGS_ROOT, VAR_DIRS } from '../../lib/paths.ts';

/** Exactly what `ls /` shows once boot has finished. */
const ROOT_ENTRIES = ['archive', 'dev', 'etc', 'home', 'tmp', 'usr', 'var'];

const testCtx = createTestContext({ boot: true });

const basenames = (paths: readonly string[]): string[] => [...new Set(paths.map((p) => p.split('/')[2]))].sort();

Deno.test({
  name: 'root layout',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();

  try {
    await t.step('the root holds exactly the seven regions', async () => {
      assertEquals(await admin.execJson<string[]>('ls /'), [...ROOT_ENTRIES]);
    });

    // The other roots are the modules' (`roots` in mod.json, created by `mod setup`), and this
    // instance has none.
    await t.step("/archive holds core's own root, and no module's", async () => {
      assertEquals(await admin.execJson<string[]>('ls /archive'), basenames([TAGS_ROOT]));
    });

    await t.step('/var is complete before anything has written to it', async () => {
      assertEquals(await admin.execJson<string[]>('ls /var'), basenames(VAR_DIRS));
    });

    await t.step('anyone may discard output into /dev/null', async () => {
      await admin.execString('user-create devnull-user && user-passwd devnull-user --new-password hunter2');
      const user = await testCtx.server.createShellClient({ username: 'devnull-user', password: 'hunter2' });
      try {
        const discard = await user.exec('echo discarded > /dev/null');
        assertEquals(discard.success, true, discard.error);
      } finally {
        user.close();
      }
    });

    await t.step('/dev/null reads as empty at once, and keeps nothing written to it', async () => {
      assertEquals(await admin.execString('echo kept > /dev/null; head -n1 < /dev/null; cat /dev/null; wc -c < /dev/null'), '0');
      assertEquals((await admin.execJson<{ path: string }[]>('find /dev -maxdepth 1 -type c')).map((hit) => hit.path), ['/dev/null']);
    });

    await t.step('boot makes /dev/null a null node again whatever is found there', async () => {
      await admin.execString('rm /dev/null && mknode -t router /dev/null');
      await admin.execString('/etc/init/00_mount.sh');
      assertEquals(await admin.execString('[ -c /dev/null ] && echo null'), 'null');
    });

    // As on Linux: the administrator's group may read the system tree but not write it, so adding
    // someone to `admin` does not let them change what every shell sources.
    await t.step('the system directories are 0755', async () => {
      for (const path of ['/etc', '/var', '/usr', '/home', GROUPS_PATH, SESSIONS_PATH, ...VAR_DIRS]) {
        const { mode } = await admin.execJson<{ mode: number }>(`props ${path}`);
        assertEquals(mode.toString(8), '755', path);
      }
    });

    // What boot and `mod setup` put in /etc and /var, files included, is no more open to the group.
    await t.step('a member of admin can change nothing under /etc and /var', async () => {
      await admin.execString('user-create admin-member && user-passwd admin-member --new-password hunter2 && group-add-member admin admin-member');
      const member = await testCtx.server.createShellClient({ username: 'admin-member', password: 'hunter2' });
      try {
        for (const dir of ['/etc', '/var']) {
          for (const name of await admin.execJson<string[]>(`ls ${dir}`)) {
            const path = `${dir}/${name}`;
            const { type } = await admin.execJson<{ type: string }>(`info ${path}`);
            const probe = type === 'file' ? `echo probe >> ${path}` : `mkfile ${path}/probe`;
            assertEquals((await member.exec(probe)).success, false, `${probe} succeeded`);
          }
        }
      } finally {
        member.close();
      }
    });

    await t.step('/usr holds the code and the shipped payload', async () => {
      assertEquals(await admin.execJson<string[]>('ls /usr'), ['bin', 'docs', 'lib', 'modules']);
    });
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
