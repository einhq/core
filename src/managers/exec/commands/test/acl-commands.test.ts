/**
 * `acl` command coverage: display, add/replace/remove entries, and
 * enforcement of user- and group-based grants (the latter through the
 * access.gids login derives from group memberships).
 */

import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '../../../../testing/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

type AclEntry = { uid?: number; gid?: number; mode: number };

Deno.test({
  name: 'acl commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await cmd.shouldSucceed('mknode -t directory /d');
    await cmd.shouldSucceed('mknode -t file --as "name=f.txt" --as "mimetype=text/plain" /d/f.txt');
    await cmd.shouldSucceed('user-create eve');
    await cmd.shouldSucceed('user-passwd eve --new-password secret1');

    await t.step('acl -m adds a user entry and acl displays it', async () => {
      await cmd.shouldSucceed('acl -m u:eve:rwx /d/f.txt');

      const entries = await client.execJson<AclEntry[]>('acl /d/f.txt');
      assertEquals(entries.length, 1);
      assertEquals(entries[0].mode, 0o7);
    });

    await t.step('acl -m replaces an existing grantee (idempotent)', async () => {
      await cmd.shouldSucceed('acl -m u:eve:r /d/f.txt');
      const entries = await client.execJson<AclEntry[]>('acl /d/f.txt');
      assertEquals(entries.length, 1);
      assertEquals(entries[0].mode, 0o4);
    });

    await t.step('user acl entry enforces for a second identity', async () => {
      // admin-owned file, mode 600 (other gets nothing)
      await cmd.shouldSucceed('mknode -t file --as "name=p.txt" --as "mimetype=text/plain" -m 600 /d/p.txt');
      await client.exec('echo "top" > /d/p.txt');

      const eve = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });
      try {
        const eveCmd = testCommands(eve);
        await eveCmd.shouldFail('cat /d/p.txt');

        // A uid grant is matched against eve's uid live — no relogin needed
        await cmd.shouldSucceed('acl -m u:eve:r /d/p.txt');
        assertEquals((await eve.execString('cat /d/p.txt')).trim(), 'top');
      } finally {
        eve.close();
      }
    });

    await t.step('group acl entry enforces after membership + relogin', async () => {
      await cmd.shouldSucceed('group-create staff --gid 7000');
      await cmd.shouldSucceed('mknode -t directory -m 700 /d/vault');
      await cmd.shouldSucceed('mknode -t file --as "name=v.txt" --as "mimetype=text/plain" -m 644 /d/vault/v.txt');
      await client.exec('echo "vaulted" > /d/vault/v.txt');

      // Grant staff traverse+read on the otherwise-inaccessible vault
      await cmd.shouldSucceed('acl -m g:staff:rx /d/vault');

      // Not a member yet: a fresh login still lacks gid 7000
      const eve1 = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });
      try {
        await testCommands(eve1).shouldFail('cat /d/vault/v.txt');
      } finally {
        eve1.close();
      }

      // After joining staff, a fresh login recomputes gids to include 7000
      await cmd.shouldSucceed('group-add-member staff eve');
      const eve2 = await testCtx.server.createShellClient({ username: 'eve', password: 'secret1' });
      try {
        assertEquals((await eve2.execString('cat /d/vault/v.txt')).trim(), 'vaulted');
      } finally {
        eve2.close();
      }
    });

    await t.step('acl -x removes a grantee; acl -b clears all', async () => {
      await cmd.shouldSucceed('acl -x u:eve /d/f.txt');
      assertEquals((await client.execJson<AclEntry[]>('acl /d/f.txt')).length, 0);

      await cmd.shouldSucceed('acl -m u:eve:r -m g:staff:r /d/f.txt');
      assertEquals((await client.execJson<AclEntry[]>('acl /d/f.txt')).length, 2);

      await cmd.shouldSucceed('acl -b /d/f.txt');
      assertEquals((await client.execJson<AclEntry[]>('acl /d/f.txt')).length, 0);
    });

    await t.step('acl reports errors', async () => {
      await cmd.shouldFail('acl -m u:eve:r /missing');
      await cmd.shouldFail('acl -m u:nobody:r /d/f.txt');
      await cmd.shouldFail('acl -m x:eve:r /d/f.txt');
      await cmd.shouldFail('acl -m u:eve /d/f.txt');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
