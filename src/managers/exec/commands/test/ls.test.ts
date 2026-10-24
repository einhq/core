/** ls: listing, several operands, hidden entries, long format, an empty directory, unknown flags and paging. */

import { assertEquals } from '@std/assert';
import { assertErrorContains, createTestContext, setupBasicTestDir, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'ls command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await setupBasicTestDir(client);

    await t.step('lists directory contents', async () => {
      const names = await client.execJson<string[]>('ls /test');
      assertEquals(names.toSorted(), ['dir1', 'dir2', 'file1.txt', 'file2.txt']);
    });

    await t.step('returns empty array for empty directory', async () => {
      const result = await client.execJson<unknown[]>('ls /test/dir1');
      assertEquals(result, []);
    });

    await t.step('fails for non-existent path', async () => {
      const result = await client.exec('ls /nonexistent');
      assertEquals(result.success, false);
    });

    await t.step('an unknown flag fails and names the flag instead of listing the working directory', async () => {
      assertErrorContains(await client.exec('cd /test && ls --bogus /test/dir2'), 'ls: unknown flag --bogus');
      assertErrorContains(await client.exec('ls -l --json -x /test'), 'ls: unknown flag --json -x');
    });

    await t.step('--no-a turns -a off and keeps the path', async () => {
      const names = await client.execJson<string[]>('cd / && ls -a --no-a /test');
      assertEquals(names.toSorted(), ['dir1', 'dir2', 'file1.txt', 'file2.txt']);
    });

    await t.step('lists root directory', async () => {
      const names = await client.execJson<string[]>('ls /');
      // At least the directories made above.
      assertEquals(names.includes('test'), true);
      assertEquals(names.includes('tmp'), true);
    });

    await t.step('supports -l flag for long listing', async () => {
      const result = await client.execJson<Array<{ name: string; node: unknown }>>('ls -l /test');
      assertEquals(result.length, 4);
      assertEquals(result.every((e) => 'node' in e), true);
    });

    await t.step('supports -a flag to show hidden files (with -l)', async () => {
      await client.exec('mkfile /test/.hidden');

      // Without -a, -l hides dot entries.
      const resultWithL = await client.execJson<Array<{ name: string }>>('ls -l /test');
      const namesWithL = resultWithL.map((e) => e.name);
      assertEquals(namesWithL.includes('.hidden'), false);

      // -la shows them, and . and .. too.
      const resultWithLA = await client.execJson<Array<{ name: string }>>('ls -la /test');
      const namesWithLA = resultWithLA.map((e) => e.name);
      assertEquals(namesWithLA.includes('.'), true);
      assertEquals(namesWithLA.includes('..'), true);
      assertEquals(namesWithLA.includes('.hidden'), true);
    });

    // cd only persists within a single script (API shell execs spawn contexts)
    await t.step('uses current directory when no path given', async () => {
      const names = await client.execJson<string[]>('cd /test && ls');
      assertEquals(names.includes('dir1'), true);
    });

    // Not even a newline, so `ls empty-dir | wc -l` counts 0.
    await t.step('an empty directory produces no output at all', async () => {
      const out = await client.execString('export JSON_OUTPUT=0\nls /test/dir1 | wc -c');
      assertEquals(out.trim(), '0');
      const lines = await client.execString('export JSON_OUTPUT=0\nls /test/dir1 | wc -l');
      assertEquals(lines.trim(), '0');
    });

    await t.step('-1 lists a name per line, also on a terminal', async () => {
      const out = await client.execString('export JSON_OUTPUT=0 TERM=1\nls -1 /test');
      assertEquals(out.trim().split('\n').toSorted(), ['dir1', 'dir2', 'file1.txt', 'file2.txt']);
    });

    await t.step('-h prints file sizes in units of 1024', async () => {
      // 128 * 16 = 2048 bytes, so the size differs visibly between the two formats.
      await client.execString(`export JSON_OUTPUT=0
        : > /test/big.bin
        for i in $(seq 1 128); do printf '0123456789abcdef' >> /test/big.bin; done`);

      const entries = await client.execJson<Array<{ name: string; node: { attrs: { size: number } } }>>('ls -l /test');
      assertEquals(entries.find((e) => e.name === 'big.bin')?.node.attrs.size, 2048);

      const plain = await client.execString('export JSON_OUTPUT=0\nls -l /test | grep big.bin');
      const human = await client.execString('export JSON_OUTPUT=0\nls -lh /test | grep big.bin');
      assertEquals(plain.includes('2048'), true, plain);
      assertEquals(human.includes('2.0 KB'), true, human);
    });

    await t.step('several operands are each listed under a header', async () => {
      await client.exec('mkdir -p /multi/a/inner /multi/b');
      assertEquals(await client.execString('export JSON_OUTPUT=0\nls /multi /multi/a'), '/multi:\na\nb\n\n/multi/a:\ninner\n');
      assertEquals(await client.execString('export JSON_OUTPUT=0\nls /multi/a /multi'), '/multi/a:\ninner\n\n/multi:\na\nb\n');
      assertEquals(await client.execJson<Record<string, string[]>>('ls /multi/a /multi/b'), { '/multi/a': ['inner'], '/multi/b': [] });
      const long = await client.execString('export JSON_OUTPUT=0\nls -l /multi /multi/a');
      assertEquals(long.includes('/multi/a:\n'), true, long);
      assertEquals(long.includes('inner'), true, long);
    });

    await t.step('an operand that cannot be listed is reported and the others still listed', async () => {
      const result = await client.exec('ls /multi/a /nonexistent');
      assertEquals(result.success, false);
      assertErrorContains(result, "ls: cannot access '/nonexistent'");
      const listed = await client.execString('export JSON_OUTPUT=0\nls /multi/a /nonexistent 2>/tmp/ls-operands.err; true');
      assertEquals(listed, '/multi/a:\ninner\n');
    });

    await t.step('--limit lists a page in name order, and --after the next one', async () => {
      await client.exec('mkdir -p /paged/.cache /paged/b /paged/d && mkfile /paged/a && mkfile /paged/c && mkfile /paged/e');
      assertEquals(await client.execJson<string[]>('ls --limit 2 /paged'), ['a', 'b']);
      assertEquals(await client.execJson<string[]>('ls --limit 2 --after b /paged'), ['c', 'd']);
      assertEquals(await client.execJson<string[]>('ls --limit 2 --after d /paged'), ['e']);
      // A hidden name is read past, not counted: the page still fills.
      assertEquals(await client.execJson<string[]>('ls -A --limit 2 /paged'), ['.cache', 'a']);
      // `-a` adds no `.` or `..` to a page.
      assertEquals(await client.execJson<string[]>('ls -a --limit 2 /paged'), ['.cache', 'a']);
      const long = await client.execJson<Array<{ name: string }>>('ls -l --limit 3 --after a /paged');
      assertEquals(long.map((e) => e.name), ['b', 'c', 'd']);
    });

    await t.step('--limit refuses what would break its order, and --after needs it', async () => {
      assertErrorContains(await client.exec('ls --limit 2 -r /paged'), 'ls: --limit pages in name order');
      assertErrorContains(await client.exec("ls --limit 2 '/paged/*'"), 'ls: --limit pages in name order');
      assertErrorContains(await client.exec('ls --after b /paged'), 'ls: --after continues a page');
      assertErrorContains(await client.exec('ls --limit 0 /paged'), 'ls: --limit must be');
      assertErrorContains(await client.exec('ls --limit 2 /paged /test'), 'ls: --limit pages one directory');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
