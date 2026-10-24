/**
 * What only an administrator may do: run a command whose spec says `admin`, and change who an
 * account is — a user's uid, primary group and sign-in state, a group's gid and its members.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({
  name: 'admin commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const asAdmin = testCommands(admin);
  let alice: ShellClient | undefined;

  try {
    await asAdmin.shouldSucceed('user-create alice --uid 3000');
    await asAdmin.shouldSucceed('user-passwd alice --new-password secret');
    await asAdmin.shouldSucceed('user-create bob --uid 3001');
    await asAdmin.shouldSucceed('group-create family --gid 7000');
    await asAdmin.shouldSucceed('group-add-member family alice');
    alice = await testCtx.server.createShellClient({ username: 'alice', password: 'secret' });
    const asAlice = testCommands(alice);

    await t.step('anyone else is refused an administrator command, by any name', async () => {
      await asAlice.shouldFailWith('service-stop http-server', 'only an administrator may run it');
      await asAlice.shouldFailWith('service stop http-server', 'only an administrator may run it');
      await asAlice.shouldFailWith('/usr/bin/pipeline-prune', "operation 'x'");
      await asAlice.shouldFailWith('user-create mallory', 'only an administrator may run it');
    });

    await t.step('its help is refused too', async () => {
      await asAlice.shouldFailWith('http-server --help', 'only an administrator may run it');
    });

    await t.step('a command anyone may run still runs', async () => {
      await asAlice.shouldSucceed('pipeline-list');
      await asAlice.shouldSucceed('user-whoami');
    });

    await t.step('its node is executable by the administrator alone', async () => {
      const mode = async (name: string) => (await alice!.execJson<{ props: { mode: number } }>(`stat /usr/bin/${name}`)).props.mode;
      assertEquals(await mode('service-stop'), 0o544);
      assertEquals(await mode('service-list'), 0o555);
    });

    await t.step('the command reference lists only what the reader may run', async () => {
      const names = async (client: ShellClient) => (await client.execJson<{ name: string }[]>('docs-commands')).map((entry) => entry.name);
      const theirs = await names(alice!);
      assertEquals(theirs.includes('service-stop'), false);
      assertEquals(theirs.includes('service-list'), true);
      assertEquals((await names(admin)).includes('service-stop'), true);
    });

    await t.step("a group's help lists only the subcommands the reader may run", async () => {
      const help = await alice!.execString('service --help', { json: false });
      assertStringIncludes(help, 'list');
      assertEquals(/^\s+stop\s*$/m.test(help), false);
    });

    await t.step("a user cannot change their account, which is the administrator's, but their home is theirs", async () => {
      for (const command of ['attrs -J uid=0', 'attrs -J gid=0', 'attrs -J inactive=true', 'attrs -s description=hello', 'chown :0', 'chown bob']) {
        await asAlice.shouldFail(`${command} /etc/users/alice`);
      }
      assertEquals((await alice!.execJson<{ uid: number; gid: number }>('attrs /etc/users/alice')).uid, 3000);

      // What is theirs to say about themselves still is, through user-update.
      await asAlice.shouldSucceed('user-update alice --name Alicia --description hello');
      assertEquals((await alice!.execJson<{ name: string }>('attrs /etc/users/alice')).name, 'Alicia');
      await asAlice.shouldFail('user-update bob --name Bobby');
      await asAlice.shouldSucceed('attrs -s description=mine /home/alice && chown :family /home/alice');
    });

    await t.step('the administrator still can', async () => {
      await asAdmin.shouldSucceed('attrs -s description=hers /etc/users/alice');
      await asAdmin.shouldSucceed('chown :alice /home/alice');
    });

    await t.step("a member cannot change their group's members", async () => {
      await asAlice.shouldFailWith('ln -s /etc/users/bob /etc/groups/family/users/bob', "operation 'w'");
      const members = await alice!.execJson<({ name: string } | string)[]>('ls /etc/groups/family/users');
      assertEquals(members.map((entry) => typeof entry === 'string' ? entry : entry.name), ['alice']);
    });

    await t.step('a session started afterwards is still who it was', async () => {
      const again = await testCtx.server.createShellClient({ username: 'alice', password: 'secret' });
      try {
        const who = await again.execJson<{ uid: number; admin: boolean }>('user-whoami');
        assertEquals([who.uid, who.admin], [3000, false]);
      } finally {
        again.close();
      }
    });
  } finally {
    alice?.close();
    admin.close();
    await testCtx.teardown();
  }
});
