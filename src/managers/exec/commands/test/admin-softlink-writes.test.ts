/**
 * What a pipeline step does as the administrator under a member's file — `mkdir -p`, `mknode`, a
 * write, `cp`, `mv` and `rm -r` into `metadata/`, `thumbnails/`, `regions/` or `versions/` — goes
 * through no softlink the member laid there, so it lands nowhere the member could not write
 * themselves. Nor can the member give one of the administrator's files a name there.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({
  name: "an administrator's steps under a member's file write through no link of theirs",
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  let anna: ShellClient | undefined;

  try {
    await cmd.shouldSucceed('mkdir -p /etc && echo "export PS1" > /etc/bashrc');
    for (const name of ['anna', 'bo']) {
      await cmd.shouldSucceed(`user-create ${name} && user-passwd ${name} --new-password secret1`);
    }
    anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
    const member = testCommands(anna);
    await member.shouldFail('echo planted > /home/bo/content');
    await member.shouldSucceed('echo "export PLANTED=1" > ~/a.txt');
    await member.shouldSucceed('ln -s /home/bo ~/a.txt/metadata && ln -s /home/bo ~/a.txt/thumbnails');
    await member.shouldSucceed('mkdir ~/a.txt/regions && ln -s /etc/bashrc ~/a.txt/regions/face-1.jpg');
    await member.shouldSucceed('ln -s /home/bo ~/a.txt/versions');

    const file = '/home/anna/a.txt';
    const bashrc = await admin.execString('cat /etc/bashrc');
    const bosHome = async () => (await admin.execString('ls /home/bo')).trim();
    const before = await bosHome();

    await t.step('a metadata child is not made through a linked metadata/', async () => {
      const result = await admin.exec(`mkdir -p ${file}/metadata && mknode -t file ${file}/metadata/content && echo text > ${file}/metadata/content`);
      assertEquals(result.success, false);
      assertStringIncludes(String(result.error), `write through a softlink owned by uid`);
      assertEquals(await bosHome(), before);
    });

    await t.step('a rendition is neither copied nor moved into a linked thumbnails/', async () => {
      await cmd.shouldSucceed(`echo small > ${file}/.small.jpg.tmp`);
      await cmd.shouldFail(`mv ${file}/.small.jpg.tmp ${file}/thumbnails/small.jpg`);
      await cmd.shouldFail(`cp ${file}/.small.jpg.tmp ${file}/thumbnails/small.jpg`);
      assertEquals(await bosHome(), before);
    });

    await t.step('a region is not written over a link to a file', async () => {
      await cmd.shouldFail(`echo face > ${file}/regions/face-1.jpg`);
      assertEquals(await admin.execString('cat /etc/bashrc'), bashrc);
    });

    await t.step('a linked versions/ is not emptied, and is removed as the link', async () => {
      await cmd.shouldFail(`chmod 777 ${file}/versions`);
      await cmd.shouldSucceed(`rm -r ${file}/versions`);
      assertEquals(await bosHome(), before);
    });

    await t.step("the member cannot hard-link the administrator's file there", async () => {
      await member.shouldFail('ln /etc/bashrc ~/a.txt/regions/face-2.jpg');
      await member.shouldSucceed('ln ~/a.txt ~/b.txt');
    });
  } finally {
    anna?.close();
    admin.close();
    await testCtx.teardown();
  }
});
