/**
 * `mv` on `renameMany`: a moved directory keeps every link into it, a relation link's `peerLink`
 * follows, several sources move in one call, a file named as the destination is replaced,
 * `--no-relink` leaves the links, and each source that does not move is answered for while the
 * others move.
 */

import { assertEquals } from '@std/assert';
import type { MvAnswer } from '../../../../lib/api/node.ts';
import type { RelationAttrs } from '../../../../lib/api/relation.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({
  name: 'mv',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const softlink = async (path: string) => (await client.execJson<{ softlink: string }>(`props -L ${path}`)).softlink;

  try {
    await cmd.shouldSucceed('mkdir -p /m/batch/day/sub /m/links /m/people/anna /m/library');
    await cmd.shouldSucceed('echo a > /m/batch/day/a.txt && echo b > /m/batch/day/sub/b.txt && echo c > /m/batch/dayx.txt');
    await cmd.shouldSucceed('ln -s /m/batch/day /m/links/day');
    await cmd.shouldSucceed('ln -s /m/batch/day/a.txt /m/links/a');
    await cmd.shouldSucceed('ln -s /m/batch/day/sub/b.txt /m/links/b');
    await cmd.shouldSucceed('ln -s /m/batch/dayx.txt /m/links/dayx');
    await cmd.shouldSucceed('relate /m/people/anna /m/batch/day/a.txt in --reverse of');

    await t.step('moving a directory keeps every link into it, and a relation keeps its peer', async () => {
      const answer = await client.execJson<MvAnswer>('mv /m/batch/day /m/library/day');

      assertEquals(answer, { ok: true, moved: 1, relinked: 4, failed: [] });
      assertEquals(await softlink('/m/links/day'), '/m/library/day');
      assertEquals(await softlink('/m/links/a'), '/m/library/day/a.txt');
      assertEquals(await softlink('/m/links/b'), '/m/library/day/sub/b.txt');
      assertEquals((await client.execString('cat /m/links/b')).trim(), 'b');
      // Not under the moved path, though it shares its prefix.
      assertEquals(await softlink('/m/links/dayx'), '/m/batch/dayx.txt');

      const half = await client.execJson<RelationAttrs>('attrs -L /m/people/anna/relations/in-a.txt');
      assertEquals(half.relation?.peerLink, '/m/library/day/a.txt/relations/of-anna');
      assertEquals(await softlink('/m/people/anna/relations/in-a.txt'), '/m/library/day/a.txt');
    });

    await t.step('several sources move into an existing directory in one call', async () => {
      await cmd.shouldSucceed('mkdir -p /m/many/src /m/many/dst');
      await cmd.shouldSucceed('echo 1 > /m/many/src/one.txt && echo 2 > /m/many/src/two.txt');
      await cmd.shouldSucceed('ln -s /m/many/src/two.txt /m/links/two');

      const answer = await client.execJson<MvAnswer>('mv /m/many/src/one.txt /m/many/src/two.txt /m/many/dst');

      assertEquals(answer, { ok: true, moved: 2, relinked: 1, failed: [] });
      assertEquals((await client.execString('cat /m/many/dst/two.txt')).trim(), '2');
      assertEquals(await softlink('/m/links/two'), '/m/many/dst/two.txt');
    });

    await t.step('--no-relink leaves the links on the old paths', async () => {
      await cmd.shouldSucceed('mkdir -p /m/keep/dir && echo k > /m/keep/dir/k.txt');
      await cmd.shouldSucceed('ln -s /m/keep/dir/k.txt /m/links/k');

      const answer = await client.execJson<MvAnswer>('mv --no-relink /m/keep/dir /m/keep/moved');

      assertEquals(answer, { ok: true, moved: 1, relinked: 0, failed: [] });
      assertEquals(await softlink('/m/links/k'), '/m/keep/dir/k.txt');
    });

    await t.step('a source that does not move is answered for, and the others move', async () => {
      await cmd.shouldSucceed('mkdir -p /m/part/src /m/part/dst && echo p > /m/part/src/p.txt && echo q > /m/part/src/q.txt');
      await cmd.shouldSucceed('echo taken > /m/part/dst/q.txt');

      const answer = await client.execJson<MvAnswer>('mv -n /m/part/src/p.txt /m/part/src/q.txt /m/part/src/gone.txt /m/part/dst');

      assertEquals(answer.ok, false);
      assertEquals(answer.moved, 1);
      assertEquals(answer.failed.map((entry) => entry.path), ['/m/part/src/q.txt', '/m/part/src/gone.txt']);
      assertEquals((await client.execString('cat /m/part/dst/q.txt')).trim(), 'taken');
      assertEquals((await client.execString('cat /m/part/dst/p.txt')).trim(), 'p');
    });

    await t.step('a move that makes nothing fails', async () => {
      await cmd.shouldFail('mv /m/part/src/gone.txt /m/part/dst/gone.txt');
      await cmd.shouldFail('mv /m/library/day /m/library/day/sub/day');
      await cmd.shouldFail('mv /m/part/dst/p.txt /m/nowhere/p.txt');
    });

    await t.step('a file as the destination is replaced, any other node takes the source', async () => {
      await cmd.shouldSucceed('mkdir -p /m/onto/dir && echo new > /m/onto/new.txt && echo old > /m/onto/old.txt');
      await cmd.shouldSucceed('mv /m/onto/new.txt /m/onto/old.txt');
      assertEquals((await client.execString('cat /m/onto/old.txt')).trim(), 'new');
      await cmd.shouldFail('ls /m/onto/new.txt');
      await cmd.shouldFail('ls /m/onto/old.txt/new.txt');

      await cmd.shouldSucceed('mknode -t album /m/onto/album');
      await cmd.shouldSucceed('mv /m/onto/old.txt /m/onto/album');
      assertEquals((await client.execString('cat /m/onto/album/old.txt')).trim(), 'new');

      await cmd.shouldSucceed('echo a > /m/onto/a.txt && echo b > /m/onto/b.txt && echo c > /m/onto/c.txt');
      await cmd.shouldFailWith('mv /m/onto/a.txt /m/onto/b.txt /m/onto/c.txt', 'is not a directory');
      await cmd.shouldFailWith('mv /m/onto/dir /m/onto/c.txt', 'which is not a file');
      assertEquals((await client.execString('cat /m/onto/c.txt')).trim(), 'c');
    });

    await t.step('a trailing slash on the destination names a directory', async () => {
      await cmd.shouldSucceed('mkdir -p /m/slash/dir && echo x > /m/slash/x.txt && echo f > /m/slash/file.txt');
      await cmd.shouldSucceed('ln -s /m/slash/dir /m/slash/link');

      await cmd.shouldFailWith('mv /m/slash/x.txt /m/slash/missing/', 'No such file or directory');
      await cmd.shouldFail('ls /m/slash/missing');
      await cmd.shouldFailWith('mv /m/slash/x.txt /m/slash/file.txt/', 'Not a directory');
      await cmd.shouldFail('ls /m/slash/file.txt/x.txt');

      await cmd.shouldSucceed('mv /m/slash/x.txt /m/slash/link/');
      assertEquals((await client.execString('cat /m/slash/dir/x.txt')).trim(), 'x');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
