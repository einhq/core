/**
 * Node command coverage: mknode, ln, cp, mv, rm, chmod, chown,
 * stat/info/attrs/props, find — success and failure paths.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, modeUnder } from '../../../../lib/access/mod.ts';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';
import type { FindEntry } from '../../../../lib/api/node.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({
  name: 'node commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('mknode creates typed nodes', async () => {
      await cmd.shouldSucceed('mknode -t directory /d');
      await cmd.shouldSucceed('mknode -t file --as "name=f.txt" --as "mimetype=text/plain" /d/f.txt');
      await cmd.shouldSucceed('mknode -t queue --al "routingKeys=evt.a" /d/q');
      await cmd.shouldSucceed('mknode -t log --as "retention=forever" /d/l');
      await cmd.shouldSucceed('mknode -t router --as "routingKey=evt.b" /d/r');

      const stat = await client.execJson<{ type: string }>('info /d/q');
      assertEquals(stat.type, 'queue');

      const defaults = await client.execJson<{ mode: number; uid: number; gid: number }>('props /d/f.txt');
      const folder = await client.execJson<{ mode: number }>('props /d');
      assertEquals(defaults.mode, modeUnder(folder.mode));
      assertEquals(defaults.uid, ADMIN_ACCESS.uid);
      assertEquals(defaults.gid, ADMIN_ACCESS.gid);
    });

    // Node types are dynamic by design (modules define 'person', say), so an
    // unknown type is allowed; only a name collision fails.
    await t.step('mknode fails on existing node', async () => {
      await cmd.shouldFail('mknode -t directory /d');
    });

    await t.step('mknode -m sets mode, -o/-g set ownership', async () => {
      await cmd.shouldSucceed('mknode -t directory -m 700 -o 4242 -g 4243 /d/owned');

      const props = await client.execJson<{ mode: number; uid: number; gid: number }>('props /d/owned');
      assertEquals(props.mode & 0o777, 0o700);
      assertEquals(props.uid, 4242);
      assertEquals(props.gid, 4243);
    });

    await t.step('cp copies a file, cp -r copies a tree', async () => {
      await client.exec('echo "original" > /d/f.txt');
      await cmd.shouldSucceed('cp /d/f.txt /d/copy.txt');
      assertEquals((await client.execString('cat /d/copy.txt')).trim(), 'original');

      await cmd.shouldSucceed('mkdir -p /d/tree/sub');
      await client.exec('mkfile /d/tree/sub/deep.txt && echo "deep" > /d/tree/sub/deep.txt');

      await cmd.shouldFail('cp /d/tree /d/tree2');
      await cmd.shouldSucceed('cp -r /d/tree /d/tree2');
      assertEquals((await client.execString('cat /d/tree2/sub/deep.txt')).trim(), 'deep');
    });

    await t.step('mv renames and moves', async () => {
      await cmd.shouldSucceed('mv /d/copy.txt /d/renamed.txt');
      await cmd.shouldFail('cat /d/copy.txt');
      assertEquals((await client.execString('cat /d/renamed.txt')).trim(), 'original');

      await cmd.shouldSucceed('mkdir /d/movehere');
      await cmd.shouldSucceed('mv /d/renamed.txt /d/movehere/final.txt');
      assertEquals((await client.execString('cat /d/movehere/final.txt')).trim(), 'original');
    });

    await t.step('cp and mv accept multiple glob-expanded sources', async () => {
      await cmd.shouldSucceed('mkdir -p /d/batch/source');
      await cmd.shouldSucceed('mkdir -p /d/batch/copied');
      await cmd.shouldSucceed('mkdir -p /d/batch/moved');
      await cmd.shouldSucceed('echo one > /d/batch/source/one.txt');
      await cmd.shouldSucceed('echo two > /d/batch/source/two.txt');

      await cmd.shouldSucceed('cp /d/batch/source/*.txt /d/batch/copied');
      assertEquals((await client.execString('cat /d/batch/copied/one.txt')).trim(), 'one');
      assertEquals((await client.execString('cat /d/batch/copied/two.txt')).trim(), 'two');

      await cmd.shouldSucceed('mv /d/batch/source/*.txt /d/batch/moved');
      assertEquals((await client.execString('cat /d/batch/moved/one.txt')).trim(), 'one');
      assertEquals((await client.execString('cat /d/batch/moved/two.txt')).trim(), 'two');
      await cmd.shouldFail('cat /d/batch/source/one.txt');
      await cmd.shouldFail('cat /d/batch/source/two.txt');
    });

    await t.step('mv retargets external and contained softlinks', async () => {
      await cmd.shouldSucceed('mkdir -p /d/relink/source');
      await cmd.shouldSucceed('mkdir -p /d/relink/destination');
      await cmd.shouldSucceed('mkdir -p /d/relink/links');
      await cmd.shouldSucceed('echo one > /d/relink/source/one.txt');
      await cmd.shouldSucceed('echo two > /d/relink/source/two.txt');
      await cmd.shouldSucceed('mkdir -p /d/relink/source/one.txt/relations');
      await cmd.shouldSucceed('ln -s /d/relink/source/one.txt /d/relink/links/one.txt');
      await cmd.shouldSucceed(
        'ln -s /d/relink/source/two.txt /d/relink/source/one.txt/relations/related-two.txt',
      );

      await cmd.shouldSucceed('mv /d/relink/source/* /d/relink/destination');
      assertEquals(
        (await client.execJson<{ softlink: string }>('props -L /d/relink/links/one.txt')).softlink,
        '/d/relink/destination/one.txt',
      );
      assertEquals(
        (await client.execJson<{ softlink: string }>(
          'props -L /d/relink/destination/one.txt/relations/related-two.txt',
        )).softlink,
        '/d/relink/destination/two.txt',
      );
    });

    await t.step('mv --no-relink leaves softlinks on the old path', async () => {
      await cmd.shouldSucceed('mkdir -p /d/norelink/source /d/norelink/links');
      await cmd.shouldSucceed('echo one > /d/norelink/source/one.txt');
      await cmd.shouldSucceed('ln -s /d/norelink/source/one.txt /d/norelink/links/one.txt');

      await cmd.shouldSucceed('mv --no-relink /d/norelink/source/one.txt /d/norelink/moved.txt');
      assertEquals(
        (await client.execJson<{ softlink: string }>('props -L /d/norelink/links/one.txt')).softlink,
        '/d/norelink/source/one.txt',
      );
      await cmd.shouldFail('mv --relink /d/norelink/moved.txt /d/norelink/again.txt');
    });

    await t.step('ln -s creates a softlink, ln creates a hard link', async () => {
      await cmd.shouldSucceed('ln -s /d/f.txt /d/soft');
      assertEquals((await client.execString('cat /d/soft')).trim(), 'original');

      const props = await client.execJson<{ softlink: string }>('props -L /d/soft');
      assertEquals(props.softlink, '/d/f.txt');

      await cmd.shouldSucceed('ln /d/f.txt /d/hard');
      const orig = await client.execJson<{ id: string }>('info /d/f.txt');
      const hard = await client.execJson<{ id: string }>('info /d/hard');
      assertEquals(hard.id, orig.id);
    });

    await t.step('rm removes files; rm -r removes trees', async () => {
      await cmd.shouldSucceed('rm /d/movehere/final.txt');
      await cmd.shouldSucceed('mkdir -p /d/remove-many');
      await cmd.shouldSucceed('echo one > /d/remove-many/one.txt');
      await cmd.shouldSucceed('echo two > /d/remove-many/two.txt');
      await cmd.shouldSucceed('rm /d/remove-many/*.txt');
      await cmd.shouldFail('cat /d/remove-many/one.txt');
      await cmd.shouldFail('cat /d/remove-many/two.txt');
      await cmd.shouldFail('rm /d/tree2');
      await cmd.shouldSucceed('rm -r /d/tree2');
      await cmd.shouldFail('cat /d/tree2/sub/deep.txt');
      await cmd.shouldSucceed('rm -f /d/already-gone');
    });

    await t.step('chmod and chown update props', async () => {
      await cmd.shouldSucceed('chmod 640 /d/f.txt');
      const props = await client.execJson<{ mode: number }>('props /d/f.txt');
      assertEquals(props.mode & 0o777, 0o640);

      await cmd.shouldSucceed('chmod u+x /d/f.txt');
      const symbolic = await client.execJson<{ mode: number }>('props /d/f.txt');
      assertEquals(symbolic.mode & 0o777, 0o740);

      // A leading zero is part of the mode, not a number's padding
      await cmd.shouldSucceed('chmod 040 /d/f.txt');
      const zero = await client.execJson<{ mode: number }>('props /d/f.txt');
      assertEquals(zero.mode & 0o777, 0o040);
      await cmd.shouldSucceed('chmod 640 /d/f.txt');

      await cmd.shouldSucceed('chown 4242 /d/f.txt');
      const after = await client.execJson<{ uid: number }>('props /d/f.txt');
      assertEquals(after.uid, 4242);
    });

    await t.step('chmod and chown change every path they are given, past one that fails', async () => {
      await cmd.shouldSucceed('mkdir /d/m1 /d/m2');
      const modes = async () => [
        (await client.execJson<{ mode: number }>('props /d/m1')).mode & 0o777,
        (await client.execJson<{ mode: number }>('props /d/m2')).mode & 0o777,
      ];

      await cmd.shouldSucceed('chmod 700 /d/m1 /d/m2');
      assertEquals(await modes(), [0o700, 0o700]);

      // A symbolic mode is resolved against each named node.
      await cmd.shouldSucceed('chmod 750 /d/m1 && chmod 700 /d/m2 && chmod o+x /d/m1 /d/m2');
      assertEquals(await modes(), [0o751, 0o701]);

      const partial = await client.exec('chmod 711 /d/missing /d/m1 /d/m2');
      assertEquals(partial.success, false);
      assertEquals(await modes(), [0o711, 0o711]);

      await cmd.shouldSucceed('chown 4343 /d/m1 /d/m2');
      const uids = [
        (await client.execJson<{ uid: number }>('props /d/m1')).uid,
        (await client.execJson<{ uid: number }>('props /d/m2')).uid,
      ];
      assertEquals(uids, [4343, 4343]);

      assertEquals(await client.execJson<Record<string, unknown>>('chmod 755 /d/m1 /d/m2'), {
        ok: true,
        updated: 2,
        pinned: 0,
        skipped: 0,
        failed: 0,
      });
    });

    // `attrs -d` removes the key, on its own or beside -s/-J.
    await t.step('attrs -d removes a key', async () => {
      await cmd.shouldSucceed('mknode -t file --as "name=del.txt" --as "mimetype=text/plain" /d/del.txt');
      await cmd.shouldSucceed('attrs -s "keep=yes" -s "drop=no" /d/del.txt');
      assertEquals((await client.execJson<{ drop?: string }>('attrs /d/del.txt')).drop, 'no');

      // -d alone, with no -s/-J alongside it.
      await cmd.shouldSucceed('attrs -d drop /d/del.txt');
      const after = await client.execJson<Record<string, unknown>>('attrs /d/del.txt');
      assertEquals(Object.hasOwn(after, 'drop'), false, 'drop should be gone, not null');
      assertEquals(after.keep, 'yes', 'other attrs survive');
    });

    await t.step('attrs and stat report node metadata', async () => {
      const attrs = await client.execJson<{ mimetype: string }>('attrs /d/f.txt');
      assertEquals(attrs.mimetype, 'text/plain');

      const statOut = await client.execString('stat /d/f.txt');
      assertStringIncludes(statOut, 'file');
    });

    await t.step('find locates nodes by name', async () => {
      const result = await client.exec('find /d -name "f.txt"');
      assertEquals(result.success, true);
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
      assertStringIncludes(text, '/d/f.txt');
    });

    await t.step('find answers each match with its child count, and lists one type at its last level', async () => {
      await cmd.shouldSucceed('mkdir -p /found/one/inner /found/two && mkfile /found/loose.txt && mkfile /found/one/x.txt');
      const found = await client.execJson<FindEntry[]>('find /found -mindepth 1 -maxdepth 1 -type d');
      assertEquals(found.toSorted((a, b) => a.name.localeCompare(b.name)), [
        { path: '/found/one', type: 'directory', name: 'one', childCount: 2 },
        { path: '/found/two', type: 'directory', name: 'two', childCount: 0 },
      ]);
      const deeper = await client.execJson<FindEntry[]>('find /found -mindepth 1 -maxdepth 2 -type d');
      assertEquals(deeper.map((entry) => entry.path).sort(), ['/found/one', '/found/one/inner', '/found/two']);
    });

    await t.step('failure paths report errors', async () => {
      await cmd.shouldFail('cp /missing /d/');
      await cmd.shouldFail('mv /missing /d/x');
      await cmd.shouldFail('rm /missing');
      await cmd.shouldFail('chmod 777 /missing');
      await cmd.shouldFail('attrs /missing');
    });

    await t.step('non-admin user is denied where modes forbid', async () => {
      await cmd.shouldSucceed('user-create eve');
      await cmd.shouldSucceed('user-passwd eve --new-password secret1');
      await cmd.shouldSucceed('mknode -t directory -m 700 /d/private');

      const eve = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });
      try {
        const eveCmd = testCommands(eve);
        // /d/private is admin-owned mode 700
        await eveCmd.shouldFail('mknode -t directory /d/private/sub');
        await eveCmd.shouldFail('chmod 777 /d/private');
        // eve can work in her own home
        await eveCmd.shouldSucceed('mkdir /home/eve/mine');
      } finally {
        eve.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
