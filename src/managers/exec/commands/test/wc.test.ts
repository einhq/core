/**
 * wc command: counting file operands and stdin, the total line, GNU's column widths, and a
 * terminating signal ending a wc that waits on a stdin nothing writes.
 */

import { assertEquals, assertMatch } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import { Counter } from '../utils/wc.ts';

Deno.test('Counter', () => {
  const counter = new Counter();
  const bytes = new TextEncoder().encode('hello wörld\nfoo\n');
  // Split inside "wörld" and inside the two bytes of "ö": still one word and one character.
  counter.add(bytes.slice(0, 8));
  counter.add(bytes.slice(8, 9));
  counter.add(bytes.slice(9));
  counter.end();
  assertEquals(counter.counts, { lines: 2, words: 3, chars: 16, bytes: 17 });
});

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'wc command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const run = async (line: string) => await client.execString(line, { json: false });
  const cmd = testCommands(client);

  try {
    await run(`mkdir -p /tmp/wc-test && printf 'a\\nb\\n' > /tmp/wc-test/f.txt && printf 'hello world\\nfoo\\n' > /tmp/wc-test/g.txt`);

    await t.step('a file operand is counted and named', async () => {
      assertEquals(await run(`wc -l /tmp/wc-test/f.txt`), '2 /tmp/wc-test/f.txt\n');
      assertEquals(await run(`wc /tmp/wc-test/f.txt`), '2 2 4 /tmp/wc-test/f.txt\n');
      assertEquals(await run(`cd /tmp/wc-test && wc -c f.txt`), '4 f.txt\n');
    });

    await t.step('several files end with a total, as wide as their total size', async () => {
      assertEquals(
        await run(`wc /tmp/wc-test/f.txt /tmp/wc-test/g.txt`),
        ' 2  2  4 /tmp/wc-test/f.txt\n 2  3 16 /tmp/wc-test/g.txt\n 4  5 20 total\n',
      );
    });

    await t.step('stdin without operands, padded to 7 unless it is a single count', async () => {
      assertEquals(await run(`seq 5 | wc -l`), '5\n');
      assertEquals(await run(`seq 5 | wc`), '      5       5      10\n');
      assertEquals(await run(`seq 5 | wc -lw`), '      5       5\n');
    });

    await t.step('- is stdin among the files', async () => {
      assertEquals(
        await run(`seq 5 | wc -l /tmp/wc-test/f.txt -`),
        '      2 /tmp/wc-test/f.txt\n      5 -\n      7 total\n',
      );
    });

    await t.step('counts come in the order lines, words, characters, bytes', async () => {
      assertEquals(await run(`printf 'ö x' | wc -c -m -w -l`), '      0       2       3       4\n');
    });

    await t.step('a missing file is an error; the others are still counted', async () => {
      const out = await run(`wc -l /tmp/wc-test/f.txt /tmp/wc-test/nope.txt 2>&1; echo "st=$?"`);
      assertMatch(out, /^wc: \/tmp\/wc-test\/nope\.txt: .+\n2 \/tmp\/wc-test\/f\.txt\n2 total\nst=1\n$/);
      await cmd.shouldFailWith(`wc /tmp/wc-test/nope.txt`, 'nope.txt');
      await cmd.shouldFailWith(`wc -x /tmp/wc-test/f.txt`, 'unknown flag -x');
    });

    await t.step('a terminating signal ends a wc waiting on stdin', async () => {
      // A detached job reads the shell's stdin, which nothing writes.
      const detached = await client.execJson<{ ok: boolean; pid: string }>('nohup wc');
      assertEquals(detached.ok, true);
      const stateOf = async () => {
        const list = await client.execJson<{ pid: string; state: string; exitCode: number | null }[]>('detach --list');
        const entry = list.find((entry) => entry.pid === detached.pid);
        return { state: entry?.state, exitCode: entry?.exitCode };
      };
      assertEquals((await stateOf()).state, 'running');

      await client.exec(`kill ${detached.pid}`);
      const deadline = Date.now() + 3000;
      while ((await stateOf()).state !== 'exited' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // Ended by SIGTERM, as bash reports it: 128 + 15.
      assertEquals(await stateOf(), { state: 'exited', exitCode: 143 });
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
