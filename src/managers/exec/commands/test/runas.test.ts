/**
 * runas: a line run as another account has that account's rights, name, home and settings and no
 * more, is the administrator's to give, and leaves no session behind.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({ name: 'runas command', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const clients: ShellClient[] = [admin];
  const cmd = testCommands(admin);

  try {
    await admin.execString('user-create anna && user-passwd anna --new-password hunter2 && user-create bo');

    await t.step("the line runs as the account, in its home, and what it writes is the account's", async () => {
      assertEquals((await admin.execString(`runas anna 'echo $USER $HOME'`)).trim(), 'anna /home/anna');
      await admin.execString(`runas anna 'echo hej > /home/anna/note.txt'`);
      const note = await admin.execJson<{ props: { uid: number } }>('stat /home/anna/note.txt');
      const anna = await admin.execJson<{ uid: number }>('user-info anna');
      assertEquals(note.props.uid, anna.uid);
    });

    await t.step('the words of a line are quoted again; the uid names the account too', async () => {
      const anna = await admin.execJson<{ uid: number }>('user-info anna');
      assertEquals((await admin.execString(`runas ${anna.uid} echo 'two words'`)).trim(), 'two words');
    });

    await t.step('it can do no more than the account can', async () => {
      await cmd.shouldFailWith(`runas anna 'echo x > /home/bo/x.txt'`, 'denied');
    });

    await t.step("its exit status is the line's", async () => {
      assertEquals((await admin.exec(`runas anna 'false'`)).success, false);
    });

    await t.step('only an administrator gives it, and only for an active account', async () => {
      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'hunter2' });
      clients.push(anna);
      assertEquals((await anna.exec(`runas bo 'echo x'`)).success, false);
      await admin.execString('user-disable bo');
      await cmd.shouldFailWith(`runas bo 'echo x'`, 'no active account');
      await cmd.shouldFailWith(`runas nobody 'echo x'`, 'no active account');
    });

    await t.step('no session is left behind', async () => {
      const sessions = await admin.execString('ls /var/sessions');
      assertEquals(sessions.includes('runas-'), false);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
