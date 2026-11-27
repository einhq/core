/**
 * tail command: stdin, and path mode over file/blob/log nodes. -c, and head's, cut a binary file's
 * bytes as they are, from a file and from a pipe.
 * Follow (-f) is covered in tail-follow.test.ts.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'tail command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const printsNothing = async (command: string) => {
    const result = await client.exec(command);
    assertEquals([result.success, result.data ?? null], [true, null]);
  };

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

    await t.step('-n 0 prints nothing: stdin, file', async () => {
      await printsNothing('seq 5 | tail -n 0');
      await printsNothing('seq 5 | tail -c 0');
      await printsNothing('tail -n 0 /f');
    });

    await t.step('stdin: -n larger than the input prints all of it', async () => {
      assertEquals((await client.execString('seq 3 | tail -n 7')).trim().split('\n'), ['1', '2', '3']);
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

    await t.step('log: -n 0 prints no entries', async () => {
      await printsNothing('tail -n 0 /mylog');
    });

    await t.step('-c writes bytes as they are, which no text decoding would keep', async () => {
      const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31 + (i >> 9)) & 0xff);
      await client.exec('mkfile /bin.dat');
      const handle = await vfs.open(ADMIN_ACCESS, '/bin.dat', { mode: 'w' });
      await handle.write(bytes);
      await handle.close();
      const read = async (path: string) => {
        const h = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
        try {
          return new Uint8Array(await new Response(h.readable).arrayBuffer());
        } finally {
          await h.close().catch(() => {});
        }
      };

      await cmd.shouldSucceed('tail -c +5469 /bin.dat > /from-file.dat');
      assertEquals(await read('/from-file.dat'), bytes.slice(5468));
      await cmd.shouldSucceed('tail -c 1000 /bin.dat > /last-file.dat');
      assertEquals(await read('/last-file.dat'), bytes.slice(-1000));

      await cmd.shouldSucceed('cat /bin.dat | tail -c +5469 > /from-pipe.dat');
      assertEquals(await read('/from-pipe.dat'), bytes.slice(5468));
      await cmd.shouldSucceed('cat /bin.dat | tail -c 70000 > /last-pipe.dat');
      assertEquals(await read('/last-pipe.dat'), bytes.slice(-70000));

      await cmd.shouldSucceed('head -c 5468 /bin.dat > /head-file.dat');
      assertEquals(await read('/head-file.dat'), bytes.slice(0, 5468));
      await cmd.shouldSucceed('cat /bin.dat | head -c 100000 > /head-pipe.dat');
      assertEquals(await read('/head-pipe.dat'), bytes.slice(0, 100000));
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
