/**
 * The text filters' input: FILE operands read from the VFS (stdin when there are none, and for
 * `-`), a log operand read to its current end, lines written as they come, and a terminating
 * signal ending a filter that waits on a stdin nothing writes.
 */

import { assertEquals, assertMatch } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'text filter input',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const run = async (line: string) => await client.execString(line, { json: false });
  const cmd = testCommands(client);

  try {
    const dir = '/tmp/text-filters';
    await run(`mkdir -p ${dir} && printf 'b\\tx\\na\\ty\\na\\ty\\n' > ${dir}/f.txt && printf 'c\\td' > ${dir}/g.txt`);
    await run(`printf '{"a":{"b":1}}' > ${dir}/one.json && printf '{"a":{"b":2}}' > ${dir}/two.json`);

    await t.step('cut, sort, uniq and rev read a file operand', async () => {
      assertEquals(await run(`cut -f1 ${dir}/f.txt`), 'b\na\na\n');
      assertEquals(await run(`sort ${dir}/f.txt`), 'a\ty\na\ty\nb\tx\n');
      assertEquals(await run(`uniq -c ${dir}/f.txt`), '      1 b\tx\n      2 a\ty\n');
      assertEquals(await run(`cd ${dir} && rev f.txt`), 'x\tb\ny\ta\ny\ta\n');
    });

    await t.step('several files are read in turn; a last line without a newline is still a line', async () => {
      assertEquals(await run(`cut -f2 ${dir}/f.txt ${dir}/g.txt`), 'x\ny\ny\nd\n');
      assertEquals(await run(`sort -r ${dir}/g.txt ${dir}/f.txt`), 'c\td\nb\tx\na\ty\na\ty\n');
      assertEquals(await run(`rev ${dir}/g.txt ${dir}/g.txt`), 'd\tc\nd\tc\n');
      assertEquals(await run(`sed -n p ${dir}/g.txt ${dir}/g.txt`), 'c\td\nc\td\n');
    });

    await t.step('jq runs the filter on each file', async () => {
      assertEquals(await run(`jq .a.b ${dir}/one.json`), '1\n');
      assertEquals(await run(`jq -c .a ${dir}/one.json ${dir}/two.json`), '{"b":1}\n{"b":2}\n');
      await cmd.shouldFail(`jq -e .missing ${dir}/one.json`);
    });

    await t.step('- is stdin among the files', async () => {
      assertEquals(await run(`printf 'z\\n' | sort ${dir}/g.txt -`), 'c\td\nz\n');
      assertEquals(await run(`printf 'z\\n' | cut -f1 - ${dir}/g.txt`), 'z\nc\n');
      assertEquals(await run(`printf 'ab\\n' | rev -`), 'ba\n');
      assertEquals(await run(`printf 'z\\nz\\n' | uniq -`), 'z\n');
      assertEquals(await run(`echo '{"a":3}' | jq .a ${dir}/one.json -`), '{\n  "b": 1\n}\n3\n');
      assertEquals(await run(`printf 'z\\n' | grep -c z ${dir}/g.txt -`), '1\n');
      assertEquals(await run(`seq 3 | head -n1 -`), '1\n');
      assertEquals(await run(`seq 3 | tail -n1 -`), '3\n');
    });

    await t.step('a missing file is reported; cut, rev and jq go on with the others', async () => {
      assertMatch(await run(`cut -f1 ${dir}/nope.txt ${dir}/g.txt 2>&1; echo "st=$?"`), /^cut: \S+nope\.txt: .+\nc\nst=1\n$/);
      assertMatch(await run(`rev ${dir}/nope.txt ${dir}/g.txt 2>&1; echo "st=$?"`), /^rev: \S+nope\.txt: .+\nd\tc\nst=1\n$/);
      assertMatch(await run(`jq .a.b ${dir}/nope.json ${dir}/two.json 2>&1; echo "st=$?"`), /^jq: error: could not open \S+nope\.json: .+\n2\nst=2\n$/);
      // sort prints nothing when a file cannot be read, as GNU sort does.
      assertMatch(await run(`sort ${dir}/g.txt ${dir}/nope.txt 2>&1; echo "st=$?"`), /^sort: \S+nope\.txt: .+\nst=2\n$/);
      assertMatch(await run(`grep c ${dir}/g.txt ${dir}/nope.txt 2>&1; echo "st=$?"`), /^\S+g\.txt:c\td\ngrep: \S+nope\.txt: .+\nst=2\n$/);
      await cmd.shouldFailWith(`uniq ${dir}/nope.txt`, 'nope.txt');
      await cmd.shouldFailWith(`uniq ${dir}/f.txt ${dir}/out.txt`, 'redirect stdout instead');
    });

    await t.step('a filter writes each line as it comes, not once its stdin ends', async () => {
      // The writer goes on only once the filter's first line has reached the file, and gives up
      // after five seconds; a filter that waits for the end of its stdin never sees "seen".
      const out = `${dir}/streamed.txt`;
      const writer = `echo hit; for i in $(seq 100); do if grep -q . ${out}; then echo seen; break; fi; sleep 0.05; done`;
      const expected: Record<string, string> = {
        'cat': 'hit\nseen\n',
        'grep -v nothing': 'hit\nseen\n',
        'cut -c1-3': 'hit\nsee\n',
        'rev': 'tih\nnees\n',
        'fold -w2': 'hi\nt\nse\nen\n',
        'head -n2': 'hit\nseen\n',
        'tr a-z A-Z': 'HIT\nSEEN\n',
      };
      for (const [filter, output] of Object.entries(expected)) {
        assertEquals(await run(`printf '' > ${out}; { ${writer}; } | ${filter} > ${out}; cat ${out}`), output, filter);
      }
    });

    await t.step('head keeps a last line without its newline, and refuses a count it cannot use', async () => {
      assertEquals(await run(`printf 'a\\nb' | head -n5`), 'a\nb');
      assertEquals(await run(`printf 'abcdef' | head -c3`), 'abc');
      assertEquals(await run(`seq 3 | head -n0`), '');
      await cmd.shouldFailWith('head -n x /dev/null', "invalid number of lines: 'x'");
    });

    await t.step('a pipe into head or grep -q is read to its end, so its writer finishes', async () => {
      // More than a pipe holds: a writer the reader stopped reading would wait for good.
      assertEquals(await run('seq 30000 | head -n1'), '1\n');
      assertEquals(await run('seq 30000 | grep -q 5; echo "st=$?"'), 'st=0\n');
    });

    await t.step('tr -c translates every character not in SET1', async () => {
      assertEquals(await run(`printf 'a-b c' | tr -c a-z _`), 'a_b_c');
      assertEquals(await run(`printf 'a--b  c' | tr -cs a-z _`), 'a_b_c');
    });

    await t.step('a log operand is read to its current end, not followed', async () => {
      await cmd.shouldSucceed(`mknode -t log ${dir}/log`);
      await cmd.shouldSucceed(`log-append ${dir}/log --data '{"value":20}'`);
      await cmd.shouldSucceed(`log-append ${dir}/log --data '{"value":10}'`);
      assertEquals(await run(`sort ${dir}/log`), '{"value":10}\n{"value":20}\n');
      assertEquals(await run(`wc -l ${dir}/log`), `2 ${dir}/log\n`);
      assertEquals(await run(`head -n1 ${dir}/log`), '{"value":20}\n');
    });

    await t.step('a terminating signal ends each filter waiting on stdin', async () => {
      const filters = [
        'cat',
        'cut -f1',
        'jq .',
        'fold',
        "awk '{ print }'",
        'rev',
        'sed p',
        'grep x',
        'tail',
        'sort',
        'head',
        'uniq',
        'tr a b',
      ];
      for (const filter of filters) {
        // A detached job reads the shell's stdin, which nothing writes.
        const detached = await client.execJson<{ ok: boolean; pid: string }>(`nohup ${filter}`);
        assertEquals(detached.ok, true, filter);
        const stateOf = async () => {
          const list = await client.execJson<{ pid: string; state: string; exitCode: number | null }[]>('detach --list');
          const entry = list.find((entry) => entry.pid === detached.pid);
          return { state: entry?.state, exitCode: entry?.exitCode };
        };
        assertEquals((await stateOf()).state, 'running', filter);

        await client.exec(`kill ${detached.pid}`);
        const deadline = Date.now() + 3000;
        while ((await stateOf()).state !== 'exited' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
        // Ended by SIGTERM, as bash reports it: 128 + 15.
        assertEquals(await stateOf(), { state: 'exited', exitCode: 143 }, filter);
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
