/** cat: files' contents one after the other, stdin for -, and an error for a path that is not there. */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'cat command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('reads file contents', async () => {
      await client.exec('mkfile /testfile');
      await client.exec('echo "Hello World" > /testfile');
      const content = await client.execString('cat /testfile');
      assertEquals(content.trim(), 'Hello World');
    });

    await t.step('fails for non-existent file', async () => {
      await cmd.shouldFail('cat /nonexistent');
    });

    await t.step('several files and - are printed in turn; a missing one fails but the rest still print', async () => {
      await client.exec('echo "second" > /testfile2');
      assertEquals(await client.execString('cat /testfile /testfile2'), 'Hello World\nsecond\n');
      assertEquals(await client.execString('echo piped | cat /testfile - /testfile2'), 'Hello World\npiped\nsecond\n');
      assertEquals(await client.execString('cat /nonexistent /testfile2 2>&1; echo "st=$?"'), 'cat: /nonexistent: Node not found: /nonexistent\nsecond\nst=1\n');
    });

    await t.step('reads empty file', async () => {
      await client.exec('mkfile /emptyfile');
      const result = await client.exec('cat /emptyfile');
      assertEquals(result.success, true);
    });

    await t.step('prints a log and exits instead of following it', async () => {
      await cmd.shouldSucceed('mknode -t log /catlog');
      await cmd.shouldSucceed(`log-append /catlog --data '{"value":10}'`);
      await cmd.shouldSucceed(`log-append /catlog --data '{"value":20}'`);
      const content = await client.execString('cat /catlog');
      assertEquals(content.trim().split('\n').map((l) => JSON.parse(l)), [{ value: 10 }, { value: 20 }]);
    });

    await t.step('-t puts each log entry after the time it was written', async () => {
      await cmd.shouldSucceed('mknode -t log /timedlog');
      await cmd.shouldSucceed(`log-append /timedlog --data '{"value":83.4}' --at 2016-09-04T16:13:27.739Z`);
      await cmd.shouldSucceed(`log-append /timedlog --data '{"value":82.4}' --at 2016-09-11T08:00:00.000Z`);
      const content = await client.execString('cat -t /timedlog');
      assertEquals(content.trim().split('\n'), ['2016-09-04T16:13:27.739Z\t{"value":83.4}', '2016-09-11T08:00:00.000Z\t{"value":82.4}']);
    });

    await t.step('prints an empty log and exits', async () => {
      await cmd.shouldSucceed('mknode -t log /emptylog');
      const result = await client.exec('cat /emptylog');
      assertEquals(result.success, true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
