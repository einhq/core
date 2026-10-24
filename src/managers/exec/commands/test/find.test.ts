/** find: GNU's starting points and expression — tests, operators, depth, actions and errors. */

import { assertEquals } from '@std/assert';
import type { FindEntry } from '../../../../lib/api/node.ts';
import { assertErrorContains, createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

const paths = async (line: string): Promise<string[]> => (await client.execJson<FindEntry[]>(line)).map((entry) => entry.path).sort();
const text = async (line: string): Promise<string> => String((await client.exec(line, { json: false })).data);

Deno.test({
  name: 'find command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();

  try {
    await client.exec(
      'mkdir -p /ft/album/sub /ft/empty /ft/.cache && mkfile /ft/album/a.jpg && mkfile /ft/album/B.JPG && ' +
        'mkfile /ft/album/.tmp1 && mkfile /ft/album/sub/c.jpg && mkfile /ft/album/notes.txt && mkfile /ft/.cache/x.jpg',
    );

    await t.step('-name and -type filter, and the starting point is a candidate at depth 0', async () => {
      assertEquals(await paths("find /ft/album -name '.tmp*' -type f"), ['/ft/album/.tmp1']);
      assertEquals(await paths("find /ft/album -name '*.jpg'"), ['/ft/album/a.jpg', '/ft/album/sub/c.jpg']);
      assertEquals(await paths('find /ft/album -type d'), ['/ft/album', '/ft/album/sub']);
      assertEquals(await paths('find /ft -maxdepth 1 -type directory'), ['/ft', '/ft/.cache', '/ft/album', '/ft/empty']);
    });

    await t.step('a word the expression does not know fails instead of listing everything', async () => {
      assertErrorContains(await client.exec('find /ft/album --size 0'), "find: unknown predicate `--size'");
      assertErrorContains(await client.exec('find /ft/album -bogus'), "find: unknown predicate `-bogus'");
      assertErrorContains(await client.exec('find /ft/album -name'), "find: missing argument to `-name'");
      assertErrorContains(await client.exec('find /ft/album \\( -name x'), "find: missing `)'");
      assertErrorContains(await client.exec('find /ft/album -mmin soon'), "find: invalid argument `soon' to `-mmin'");
    });

    await t.step('the spec flags spell the same tests, and a tool call puts the starting point last', async () => {
      assertEquals(await paths("find /ft/album --name='*.jpg' --type f"), ['/ft/album/a.jpg', '/ft/album/sub/c.jpg']);
      assertEquals(await paths("find --iname='b.*' --maxdepth=1 /ft/album"), ['/ft/album/B.JPG']);
      assertErrorContains(await client.exec('find --name=x /ft/album -print'), "find: paths must precede expression: `/ft/album'");
    });

    await t.step('-iname, -path and -type letters', async () => {
      assertEquals(await paths("find /ft/album -iname '*.jpg' -type f"), ['/ft/album/B.JPG', '/ft/album/a.jpg', '/ft/album/sub/c.jpg']);
      assertEquals(await paths("find /ft -path '*/sub/*'"), ['/ft/album/sub/c.jpg']);
      assertEquals(await paths('find /ft/album -maxdepth 1 -type f,d'), [
        '/ft/album',
        '/ft/album/.tmp1',
        '/ft/album/B.JPG',
        '/ft/album/a.jpg',
        '/ft/album/notes.txt',
        '/ft/album/sub',
      ]);
    });

    await t.step('operators: implicit and, -o, !, and parentheses', async () => {
      assertEquals(await paths("find /ft/album -type f ! -name '*.jpg' -not -name '.*'"), ['/ft/album/B.JPG', '/ft/album/notes.txt']);
      assertEquals(await paths("find /ft/album \\( -name '*.txt' -o -name 'c.*' \\) -a -type f"), ['/ft/album/notes.txt', '/ft/album/sub/c.jpg']);
    });

    await t.step('-mindepth and -maxdepth count from the starting point', async () => {
      assertEquals(await paths('find /ft/album -maxdepth 0'), ['/ft/album']);
      assertEquals(await paths("find /ft/album -mindepth 2 -name '*'"), ['/ft/album/sub/c.jpg']);
    });

    await t.step('-prune keeps the walk out of a directory', async () => {
      assertEquals(await paths("find /ft -name '.cache' -prune -o -name '*.jpg' -print"), ['/ft/album/a.jpg', '/ft/album/sub/c.jpg']);
    });

    await t.step('-quit stops at the first match', async () => {
      assertEquals((await paths("find /ft/album -name '*.jpg' -print -quit")).length, 1);
    });

    await t.step('-empty, -mmin and -newer', async () => {
      assertEquals(await paths('find /ft -type d -empty'), ['/ft/empty']);
      assertEquals((await paths('find /ft/album -type f -mmin -1')).length, 5);
      assertEquals(await paths('find /ft/album -type f -mmin +5'), []);
      await client.exec('sleep 0.02 && mkfile /ft/album/later.jpg');
      assertEquals(await paths('find /ft/album -type f -newer /ft/album/notes.txt'), ['/ft/album/later.jpg']);
    });

    await t.step('paths print as the starting point was given, several starting points in turn', async () => {
      assertEquals(await paths("cd /ft/album && find . -name 'c.jpg'"), ['./sub/c.jpg']);
      assertEquals(await paths("find /ft/album/sub/ /ft/.cache -name '*.jpg'"), ['/ft/.cache/x.jpg', '/ft/album/sub/c.jpg']);
    });

    await t.step('-prune alone still prints what it prunes, as GNU does', async () => {
      assertEquals(await paths("find /ft -name '.cache' -prune"), ['/ft/.cache']);
    });

    await t.step('-size counts whole units, rounded up', async () => {
      await client.exec('mkdir -p /fs && echo hello > /fs/small.txt && mkfile /fs/zero');
      assertEquals(await paths('find /fs -type f -size -1k'), ['/fs/zero']);
      assertEquals(await paths('find /fs -type f -size 1k'), ['/fs/small.txt']);
      assertEquals(await paths('find /fs -type f -size 6c'), ['/fs/small.txt']);
      assertEquals(await paths('find /fs -type f -size +5c'), ['/fs/small.txt']);
      assertErrorContains(await client.exec('find /fs -size 1X'), "find: invalid argument `1X' to `-size'");
    });

    await t.step('-user and -group by name or number, -uid and -gid by number', async () => {
      const ids = JSON.parse(await text(`find /fs/zero -printf '{"uid":%U,"gid":%G}'`)) as { uid: number; gid: number };
      assertEquals(await paths(`find /fs -type f -user ${await text('find /fs/zero -printf %u')}`), ['/fs/small.txt', '/fs/zero']);
      assertEquals(await paths(`find /fs -type f -group ${await text('find /fs/zero -printf %g')}`), ['/fs/small.txt', '/fs/zero']);
      assertEquals(await paths(`find /fs -type f -uid ${ids.uid} -gid ${ids.gid}`), ['/fs/small.txt', '/fs/zero']);
      assertEquals(await paths(`find /fs -type f -user ${ids.uid + 1}`), []);
      assertErrorContains(await client.exec('find /fs -user nosuchuser'), "find: 'nosuchuser' is not the name of a known user");
    });

    await t.step('-regex matches the whole path', async () => {
      assertEquals(await paths("find /ft/album -regex '.*/[a-c]\\.jpg'"), ['/ft/album/a.jpg', '/ft/album/sub/c.jpg']);
      assertEquals(await paths("find /ft/album -regex 'a\\.jpg'"), []);
      assertEquals(await paths("find /ft/album -iregex '.*/b\\.jpg'"), ['/ft/album/B.JPG']);
    });

    await t.step('-printf formats each match, and -print0 ends each with NUL, as text in JSON mode too', async () => {
      assertEquals(await text("find /fs/small.txt -printf '%p|%f|%h|%P|%d|%s|%y|%-4s|%3d|%%\\n'"), '/fs/small.txt|small.txt|/fs||0|6|f|6   |  0|%\n');
      assertEquals(await text("cd /fs && find . -name small.txt -printf '%P %h\\n'"), 'small.txt .\n');
      assertEquals(await text('find /fs -name zero -print0'), '/fs/zero\0');
      assertEquals((await client.exec('find /fs -name zero -printf %f')).data, 'zero');
      assertEquals(/^\d{4}-\d\d-\d\d\+\d\d:\d\d:\d\d\.\d{10}$/.test(await text('find /fs/zero -printf %T+')), true);
      assertErrorContains(await client.exec("find /fs -printf '%z'"), "find: unrecognized format directive `%z' in -printf");
    });

    await t.step('-exec runs a command per match, true when it succeeds', async () => {
      assertEquals(await text("find /fs -type f -exec echo 'got {}' ';' | sort"), 'got /fs/small.txt\ngot /fs/zero\n');
      assertEquals(await text('find /fs -type f -name small.txt -exec cat {} \\; -print'), 'hello\n/fs/small.txt\n');
      assertEquals(await text("find /fs -type f -exec test -s {} ';' -print"), '/fs/small.txt\n');
    });

    await t.step('-exec … + runs the command once with every match', async () => {
      assertEquals((await text('find /fs -type f -exec echo {} +')).trim().split(' ').sort(), ['/fs/small.txt', '/fs/zero']);
      assertErrorContains(await client.exec('find /fs -exec echo {} x +'), "find: `-exec … +' needs `{}' right before the `+'");
      assertErrorContains(await client.exec('find /fs -exec echo {}'), "find: missing argument to `-exec'");
    });

    await t.step('-delete removes matches, children before their directory', async () => {
      await client.exec('mkdir -p /fd/keep /fd/gone/deep && mkfile /fd/keep/a.jpg && mkfile /fd/gone/deep/b.tmp && mkfile /fd/x.tmp');
      await client.exec("find /fd -name '*.tmp' -delete");
      assertEquals(await paths('find /fd -type f'), ['/fd/keep/a.jpg']);
      await client.exec('find /fd/gone -delete');
      assertEquals(await paths('find /fd'), ['/fd', '/fd/keep', '/fd/keep/a.jpg']);
      const result = await client.exec('find /fd -name keep -type d -delete 2>&1; echo "status $?"', { json: false });
      assertEquals(result.data, "find: cannot delete '/fd/keep': Directory not empty\nstatus 1\n");
    });

    await t.step('a missing starting point is reported and the others still searched', async () => {
      const result = await client.exec('find /ft/missing /ft/album/sub 2>&1; echo "status $?"', { json: false });
      assertEquals(result.data, "find: '/ft/missing': No such file or directory\n/ft/album/sub\n/ft/album/sub/c.jpg\nstatus 1\n");
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
