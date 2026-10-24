/**
 * awk command: the common one-liners and short scripts, driven through real shell pipelines.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'awk command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  // As text: in JSON mode a line that reads as a number would come back as one, without its newline.
  const run = async (line: string) => await client.execString(line, { json: false });

  try {
    await t.step('fields, NF and $NF', async () => {
      assertEquals(await run(`printf 'a b c\\nd e\\n' | awk '{ print $2, NF, $NF }'`), 'b 3 c\ne 2 e\n');
      assertEquals(await run(`printf '  lead   and trail  \\n' | awk '{ print $1 "-" $2 "-" $3 }'`), 'lead-and-trail\n');
    });

    await t.step('-F with one character, a tab and a regex', async () => {
      assertEquals(await run(`printf 'a:b:c\\n' | awk -F: '{ print $3 }'`), 'c\n');
      assertEquals(await run(`printf 'a\\tb c\\td\\n' | awk -F'\\t' '{ print $2 }'`), 'b c\n');
      assertEquals(await run(`printf 'a1b22c\\n' | awk -F'[0-9]+' '{ print $1 $2 $3 }'`), 'abc\n');
    });

    await t.step('patterns: regex, expression, range, and no action prints the line', async () => {
      assertEquals(await run(`seq 10 | awk '/1/'`), '1\n10\n');
      assertEquals(await run(`seq 10 | awk '$1 % 4 == 0 { print "x" $1 }'`), 'x4\nx8\n');
      assertEquals(await run(`seq 10 | awk '$1 == 3, $1 == 5'`), '3\n4\n5\n');
      assertEquals(await run(`seq 5 | awk 'NR > 3'`), '4\n5\n');
    });

    await t.step('BEGIN and END, sums and averages', async () => {
      assertEquals(await run(`seq 4 | awk '{ s += $1 } END { print s, s / NR }'`), '10 2.5\n');
      assertEquals(await run(`awk 'BEGIN { print 1 + 2, 7 / 2, 2 ^ 10, 10 % 3 }'`), '3 3.5 1024 1\n');
      assertEquals(await run(`echo x | awk 'END { print NR }'`), '1\n');
    });

    await t.step('associative arrays count, and for-in visits every key', async () => {
      const out = await run(`printf 'b\\na\\nb\\nc\\nb\\n' | awk '{ n[$1]++ } END { for (k in n) print k, n[k] }' | sort`);
      assertEquals(out, 'a 1\nb 3\nc 1\n');
      assertEquals(await run(`awk 'BEGIN { a["x"]; if ("x" in a) print "in"; delete a["x"]; if (!("x" in a)) print "gone" }'`), 'in\ngone\n');
      assertEquals(await run(`awk 'BEGIN { a[1,2] = 3; for (k in a) { split(k, p, SUBSEP); print p[1], p[2], a[k] } }'`), '1 2 3\n');
    });

    await t.step('letter frequency with an empty FS', async () => {
      const out = await run(`echo 'hello' | awk 'BEGIN { FS = "" } { for (i = 1; i <= NF; i++) c[$i]++ } END { for (k in c) print k, c[k] }' | sort`);
      assertEquals(out, 'e 1\nh 1\nl 2\no 1\n');
    });

    await t.step('printf formats', async () => {
      assertEquals(
        await run(`awk 'BEGIN { printf "%5.2f|%-4s|%03d|%x|%c|%e|%g\\n", 3.14159, "ab", 7, 255, 65, 12345.678, 0.0001 }'`),
        ' 3.14|ab  |007|ff|A|1.234568e+04|0.0001\n',
      );
      assertEquals(await run(`awk 'BEGIN { printf("%s=%d\\n", "n", 42.9) }'`), 'n=42\n');
      assertEquals(await run(`awk 'BEGIN { printf "%*d|%.3s|%%\\n", 5, 42, "abcdef" }'`), '   42|abc|%\n');
    });

    await t.step('string functions', async () => {
      assertEquals(
        await run(`awk 'BEGIN { s = "Hello World"; print length(s), substr(s, 7), substr(s, 1, 5), index(s, "World"), toupper(s), tolower(s) }'`),
        '11 World Hello 7 HELLO WORLD hello world\n',
      );
      assertEquals(await run(`awk 'BEGIN { n = split("a,b,c", p, ","); print n, p[1] p[3] }'`), '3 ac\n');
      assertEquals(await run(`echo 'foo bar foo' | awk '{ n = gsub(/foo/, "[&]"); print n, $0 }'`), '2 [foo] bar [foo]\n');
      assertEquals(await run(`echo 'aaa' | awk '{ sub("a", "b"); print }'`), 'baa\n');
      assertEquals(await run(`awk 'BEGIN { if (match("xxabcxx", /ab+c/)) print RSTART, RLENGTH }'`), '3 3\n');
      assertEquals(await run(`awk 'BEGIN { x = sprintf("%05.1f", 2.25); print x }'`), '002.2\n');
    });

    await t.step('assigning a field rebuilds $0 with OFS; NF can shrink the record', async () => {
      assertEquals(await run(`echo 'a b c' | awk 'BEGIN { OFS = "-" } { $2 = "X"; print }'`), 'a-X-c\n');
      assertEquals(await run(`echo 'a b c d' | awk '{ NF = 2; print }'`), 'a b\n');
      assertEquals(await run(`echo 'a b' | awk '{ $5 = "e"; print; print NF }'`), 'a b   e\n5\n');
    });

    await t.step('numbers and strings compare as awk compares them', async () => {
      assertEquals(await run(`printf '10\\n9\\n' | awk '$1 > 9'`), '10\n');
      assertEquals(await run(`awk 'BEGIN { print ("10" < "9"), (10 < 9), (x == 0), (x == "") }'`), '1 0 1 1\n');
      assertEquals(await run(`awk 'BEGIN { print 0.1 + 0.2, 1 / 3, 100000 * 100000 }'`), '0.3 0.333333 10000000000\n');
    });

    await t.step('control flow: if/else, while, do, break, continue, next, exit', async () => {
      assertEquals(await run(`awk 'BEGIN { for (i = 0; i < 10; i++) { if (i == 2) continue; if (i == 5) break; printf "%d", i } print "" }'`), '0134\n');
      assertEquals(await run(`awk 'BEGIN { i = 3; while (i--) print i; do { print "once" } while (0) }'`), '2\n1\n0\nonce\n');
      assertEquals(await run(`seq 5 | awk '$1 == 2 { next } { print } $1 == 4 { exit }'`), '1\n3\n4\n');
      assertEquals(await run(`seq 5 | awk '{ if ($1 % 2) print "odd"; else print "even" }'`), 'odd\neven\nodd\neven\nodd\n');
      assertEquals(await run(`seq 3 | awk '{ exit 3 } END { print "end" }'; echo $?`), 'end\n3\n');
    });

    await t.step('user functions, recursion, arrays by reference', async () => {
      assertEquals(await run(`awk 'function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) } BEGIN { print fact(10) }'`), '3628800\n');
      assertEquals(await run(`awk 'function fill(a, n,   i) { for (i = 1; i <= n; i++) a[i] = i * i } BEGIN { fill(sq, 3); print sq[1], sq[2], sq[3] }'`), '1 4 9\n');
      assertEquals(await run(`awk 'function inc(x) { return x + 1 } BEGIN { print inc(y) }'`), '1\n');
    });

    await t.step('-v and var=value operands', async () => {
      assertEquals(await run(`echo 5 | awk -v k=3 '{ print $1 * k }'`), '15\n');
      assertEquals(await run(`awk -v 'msg=a\\tb' 'BEGIN { print msg }'`), 'a\tb\n');
    });

    await t.step('files from the VFS, FILENAME and FNR', async () => {
      await run(`mkdir -p /tmp/awk-test && echo 'x 1' > /tmp/awk-test/a.txt && printf 'y 2\\nz 3\\n' > /tmp/awk-test/b.txt`);
      assertEquals(
        await run(`awk '{ print FILENAME, FNR, NR, $2 }' /tmp/awk-test/a.txt /tmp/awk-test/b.txt`),
        '/tmp/awk-test/a.txt 1 1 1\n/tmp/awk-test/b.txt 1 2 2\n/tmp/awk-test/b.txt 2 3 3\n',
      );
      assertEquals(await run(`cd /tmp/awk-test && awk 'END { print NR }' a.txt b.txt`), '3\n');
    });

    await t.step('paragraph mode with RS=""', async () => {
      assertEquals(await run(`printf 'a b\\nc\\n\\n\\nd\\ne\\n' | awk 'BEGIN { RS = "" } { print NR ": " NF }'`), '1: 3\n2: 2\n');
    });

    await t.step('a multi-line program with comments and semicolons', async () => {
      const program = `
        # count words longer than three letters
        {
          for (i = 1; i <= NF; i++)
            if (length($i) > 3)
              n++
        }
        END { print n + 0 }`;
      assertEquals(await run(`echo 'a sailboat on the water today' | awk '${program}'`), '3\n');
    });

    await t.step('errors say what is wrong, and "/dev/stderr" is not stdout', async () => {
      const cmd = testCommands(client);
      await cmd.shouldFailWith(`awk '{ print $1 '`, 'awk: syntax error');
      await cmd.shouldFailWith(`awk 'BEGIN { getline x }'`, 'getline is not supported');
      await cmd.shouldFailWith(`awk 'BEGIN { print "x" > "/tmp/awk-test/out" }'`, 'output to a file');
      await cmd.shouldFailWith(`awk 'BEGIN { x = 1 / 0 }'`, 'division by zero');
      assertEquals(await run(`awk 'BEGIN { print "oops" > "/dev/stderr"; print "ok" }'`), 'ok\n');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
