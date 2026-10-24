/**
 * tail command: stdin, and path mode over file/blob/log nodes.
 * Follow (-f) is covered in tail-follow.test.ts.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'tail command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('slices a stdin pipe (regression)', async () => {
      assertEquals((await client.execString('seq 5 | tail -n 2')).trim().split('\n'), ['4', '5']);
    });

    await t.step('file: last N lines', async () => {
      const content = Array.from({ length: 12 }, (_, i) => i + 1).join('\\n');
      await client.exec('mkfile /f');
      await client.exec(`echo -e "${content}" > /f`);
      const out = await client.execString('tail -n 2 /f');
      assertEquals(out.trim().split('\n'), ['11', '12']);
    });

    await t.step('file: default is last 10 lines', async () => {
      const out = await client.execString('tail /f');
      assertEquals(out.trim().split('\n'), ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    });

    await t.step('file: last N bytes', async () => {
      // last 5 bytes of "…11\n12\n" — kept as a string (not a bare-number output)
      const out = await client.execString('tail -c 5 /f');
      assertEquals(out, '1\n12\n');
    });

    await t.step('log: last N entries as JSON lines', async () => {
      await client.execJson('mknode -t log /mylog');
      await client.execJson(`log-append /mylog --data '{"value":1}'`);
      await client.execJson(`log-append /mylog --data '{"value":2}'`);
      await client.execJson(`log-append /mylog --data '{"value":3}'`);

      const out = await client.execString('tail -n 2 /mylog');
      const lines = out.trim().split('\n').map((l) => JSON.parse(l));
      assertEquals(lines, [{ value: 2 }, { value: 3 }]);
    });

    await t.step('log: -n larger than length shows all entries', async () => {
      const out = await client.execString('tail -n 100 /mylog');
      const lines = out.trim().split('\n').map((l) => JSON.parse(l));
      assertEquals(lines, [{ value: 1 }, { value: 2 }, { value: 3 }]);
    });

    await t.step('unsupported node type fails', async () => {
      await client.exec('mkdir /adir');
      await cmd.shouldFail('tail /adir');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
