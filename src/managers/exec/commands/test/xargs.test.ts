/** xargs: GNU's item splitting and quoting, batches, -I, the commands' stdin, and exit statuses. */

import { assertEquals, assertMatch } from '@std/assert';
import { assertErrorContains, createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

const text = async (line: string): Promise<string> => String((await client.exec(line, { json: false })).data ?? '');

Deno.test({
  name: 'xargs command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await t.step('items split on blanks and newlines go to echo, as many per run as fit', async () => {
      assertEquals(await text("printf 'a b\\n  c\\td\\n' | xargs"), 'a b c d\n');
      assertEquals(await text("printf 'a\\nb\\n' | xargs echo got"), 'got a b\n');
    });

    await t.step('quotes and backslashes keep blanks in an item', async () => {
      assertEquals(await text(`printf '%s\\n' "'a b' \\"c  d\\" e\\\\ f ''" | xargs -n1 echo`), 'a b\nc  d\ne f\n\n');
      assertErrorContains(await client.exec('printf "\'open\\n" | xargs echo'), 'xargs: unmatched single quote');
    });

    await t.step('-0 and -d split on one character and take the text literally', async () => {
      assertEquals(await text('printf "a b\\0\'c\'\\0" | xargs -0 -n1 echo'), "a b\n'c'\n");
      assertEquals(await text("printf 'x,,y' | xargs -d , -n1 echo"), 'x\n\ny\n');
      assertEquals(await text("printf 'p q\\nr\\n' | xargs -d '\\n' -n1 echo"), 'p q\nr\n');
      assertErrorContains(await client.exec('echo x | xargs -d ab echo'), 'xargs: invalid input delimiter specification ab');
    });

    await t.step('-n, -L and -s cut the items into runs', async () => {
      assertEquals(await text('seq 5 | xargs -n 2 echo'), '1 2\n3 4\n5\n');
      assertEquals(await text("printf 'a b\\nc\\nd e f\\n' | xargs -L 2 echo"), 'a b c\nd e f\n');
      // A line ending in a blank goes on on the next one.
      assertEquals(await text("printf 'a \\nb\\nc\\n' | xargs -L 1 echo"), 'a b\nc\n');
      assertEquals(await text('seq 6 | xargs -s 10 echo'), '1 2\n3 4\n5 6\n');
      assertErrorContains(await client.exec('echo toolongitem | xargs -s 10 echo'), 'xargs: argument line too long');
    });

    await t.step('-I runs once per line, the whole line replacing the string', async () => {
      assertEquals(await text("printf '  a b\\nc\\n\\n' | xargs -I {} echo '[{}]' {}"), '[a b] a b\n[c] c\n');
      assertEquals(await text("printf 'x\\n' | xargs -i echo '<{}>'"), '<x>\n');
      assertEquals(await text("printf 'x\\n' | xargs --replace=@ echo @@"), 'xx\n');
      assertEquals(await text("printf 'x\\n' | xargs -rI% echo %"), 'x\n');
      assertErrorContains(await client.exec('echo x | xargs -rI % echo %'), 'xargs: option -I in a group takes its value attached');
    });

    await t.step('empty input runs the command once, but not with -r or -I', async () => {
      assertEquals(await text('printf "" | xargs echo ran'), 'ran\n');
      assertEquals(await text('printf "" | xargs -r echo ran'), '');
      assertEquals(await text('printf "" | xargs -I {} echo ran {}'), '');
    });

    await t.step('-E ends the input at an item, and -t shows each command line', async () => {
      assertEquals(await text('printf "a b END c\\n" | xargs -E END echo'), 'a b\n');
      assertEquals(await text('printf "a b\\n" | xargs -t echo 2>&1'), 'echo a b\na b\n');
    });

    await t.step('the command reads an empty stdin, not the items still to come; with -a it reads stdin as xargs got it', async () => {
      await client.exec("mkdir -p /xt && printf 'one\\ntwo\\n' > /xt/items && printf 'hello\\n' > /xt/greeting");
      assertEquals(await text('printf "a\\nb\\n" | xargs -I {} head -n1'), '');
      assertEquals(await text('xargs -a /xt/items echo'), 'one two\n');
      assertEquals(await text('cat /xt/greeting | xargs -a /xt/items -I {} head -n1'), 'hello\n');
      assertErrorContains(await client.exec('xargs -a /xt/nope echo'), 'xargs: /xt/nope:');
    });

    await t.step('the items run cat on the files they name', async () => {
      assertEquals(await text('printf "/xt/greeting\\n/xt/items\\n" | xargs cat'), 'hello\none\ntwo\n');
    });

    await t.step('exit status: 123 when a run fails, 124 at 255, 127 for a missing command', async () => {
      assertEquals(await text('printf "a b\\n" | xargs -n1 false; echo "st=$?"'), 'st=123\n');
      assertEquals(await text('f() { return 255; }; printf "a b\\n" | xargs -n1 f 2>&1; echo "st=$?"'), 'xargs: f: exited with status 255; aborting\nst=124\n');
      assertMatch(await text('echo a | xargs no-such-command 2>&1; echo "st=$?"'), /not found\nst=127\n$/);
      assertEquals(await text('echo a | xargs true; echo "st=$?"'), 'st=0\n');
    });

    await t.step('an option it does not know is refused', async () => {
      assertErrorContains(await client.exec('echo a | xargs -P 4 echo'), "xargs: invalid option -- 'P'");
      assertErrorContains(await client.exec('echo a | xargs --bogus echo'), "xargs: unrecognized option '--bogus'");
      assertErrorContains(await client.exec('echo a | xargs -n 0 echo'), 'xargs: invalid number "0" for -n option');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
