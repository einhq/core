/**
 * config tests: the two layers, who may write which, and — the part that
 * actually matters — that a written value reaches a shell's environment.
 *
 * The last one is the whole mechanism. Everything else here is bookkeeping
 * around a file; if `/etc/bashrc` stops sourcing the layers, every command in
 * the system quietly goes back to its compiled-in default and nothing else in
 * this file would notice.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext } from '../../../../testing/mod.ts';
import type { ConfigEntry } from '../../../../lib/config/mod.ts';
import type { UserCreated } from '../../../../lib/api/users.ts';

// Stands in for `-e CFG_SESSION_EXPIRES_SEC=...` on the container: the boot
// shell's environment is exactly what a deployment supplies.
const DEPLOYED_EXPIRY = '3600';

const testCtx = createTestContext({ boot: true, env: { CFG_SESSION_EXPIRES_SEC: DEPLOYED_EXPIRY } });

type SetResult = {
  key: string;
  value: string;
  scope: 'system' | 'user';
  restarted: string[];
  failed: { name: string; error: string }[];
  restartNote?: string;
};

Deno.test({
  name: 'config',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();

  try {
    await t.step('lists options with their defaults', async () => {
      const entries = await admin.execJson<ConfigEntry[]>('config list');
      const concurrency = entries.find((entry) => entry.key === 'CFG_PIPELINE_MAX_CONCURRENT');

      assert(concurrency, 'CFG_PIPELINE_MAX_CONCURRENT should be registered');
      assertEquals(concurrency.value, '4');
      assertEquals(concurrency.source, 'default');
      assertEquals(concurrency.scope, 'system');
    });

    await t.step('a value from the deployment is published and reported as such', async () => {
      // Published into /etc/environment so a service restarted later still
      // receives it — the boot shell's environment reaches the services it
      // starts, and nothing else.
      const environment = await admin.execString('cat /etc/environment');
      assertStringIncludes(environment, `export CFG_SESSION_EXPIRES_SEC='${DEPLOYED_EXPIRY}'`);

      const entry = await admin.execJson<ConfigEntry>('config get CFG_SESSION_EXPIRES_SEC');
      assertEquals(entry.value, DEPLOYED_EXPIRY);
      assertEquals(entry.source, 'environment');
    });

    await t.step('a setting the deployment no longer passes is gone after a publish', async () => {
      await admin.exec(`echo "export CFG_GONE='x'" >> /etc/environment`);
      await admin.exec('config publish');

      const environment = await admin.execString('cat /etc/environment');
      assertEquals(environment.startsWith('#!bash\n'), true, environment);
      assertEquals(environment.includes('CFG_GONE'), false, environment);
      assertStringIncludes(environment, `export CFG_SESSION_EXPIRES_SEC='${DEPLOYED_EXPIRY}'`);

      const bashrc = await admin.execString('cat /etc/bashrc');
      assertEquals(bashrc.includes('CFG_SESSION_EXPIRES_SEC'), false, bashrc);
    });

    await t.step('a setting overrides what the deployment supplied', async () => {
      await admin.exec('config set CFG_SESSION_EXPIRES_SEC 7200');
      const entry = await admin.execJson<ConfigEntry>('config get CFG_SESSION_EXPIRES_SEC');
      assertEquals(entry.value, '7200');
      assertEquals(entry.source, 'system');

      // /etc/config is sourced after /etc/environment, so the setting is
      // what a new shell actually gets.
      const fresh = await testCtx.server.createShellClient();
      try {
        assertEquals((await fresh.execString('echo $CFG_SESSION_EXPIRES_SEC')).trim(), '7200');
      } finally {
        fresh.close();
      }

      // And clearing it falls back to the deployment, not to the table default.
      await admin.exec('config unset CFG_SESSION_EXPIRES_SEC');
      const cleared = await admin.execJson<ConfigEntry>('config get CFG_SESSION_EXPIRES_SEC');
      assertEquals(cleared.value, DEPLOYED_EXPIRY);
      assertEquals(cleared.source, 'environment');
    });

    await t.step('a shell already open takes a change at its next command', async () => {
      const open = await testCtx.server.createShellClient();
      // Read through a marker: an unset variable echoes an empty line, which
      // the API shell hands back as null rather than as ''.
      const show = (key: string) => `echo "value=\${${key}:-unset}"`;
      try {
        assertEquals((await open.execString(show('CFG_SESSION_EXPIRES_SEC'))).trim(), `value=${DEPLOYED_EXPIRY}`);
        assertEquals((await open.execString(show('CFG_DEFAULT_SHARE_MODE'))).trim(), 'value=unset');

        await admin.exec('config set CFG_SESSION_EXPIRES_SEC 7200');
        await admin.exec('config set CFG_DEFAULT_SHARE_MODE 0700');
        assertEquals((await open.execString(show('CFG_SESSION_EXPIRES_SEC'))).trim(), 'value=7200');
        assertEquals((await open.execString(show('CFG_DEFAULT_SHARE_MODE'))).trim(), 'value=0700');
        assertEquals((await admin.execString(show('CFG_DEFAULT_SHARE_MODE'))).trim(), 'value=0700');

        // A cleared setting falls back as in a new shell: to the deployment's
        // value where it supplies one, and to nothing where it does not.
        await admin.exec('config unset CFG_SESSION_EXPIRES_SEC');
        await admin.exec('config unset CFG_DEFAULT_SHARE_MODE');
        assertEquals((await open.execString(show('CFG_SESSION_EXPIRES_SEC'))).trim(), `value=${DEPLOYED_EXPIRY}`);
        assertEquals((await open.execString(show('CFG_DEFAULT_SHARE_MODE'))).trim(), 'value=unset');
      } finally {
        open.close();
      }
    });

    await t.step('--scope narrows the list', async () => {
      const user = await admin.execJson<ConfigEntry[]>('config list --scope user');
      assert(user.length > 0);
      assert(user.every((entry) => entry.scope === 'user'));
    });

    await t.step('an admin sets a system value', async () => {
      const result = await admin.execJson<SetResult>('config set CFG_PIPELINE_MAX_CONCURRENT 8');
      assertEquals(result.value, '8');
      assertEquals(result.scope, 'system');
      assertEquals(result.failed, []);

      const entry = await admin.execJson<ConfigEntry>('config get CFG_PIPELINE_MAX_CONCURRENT');
      assertEquals(entry.value, '8');
      assertEquals(entry.source, 'system');
    });

    await t.step('a new shell sees the value in its environment', async () => {
      // The point of the whole design: a fresh shell sources /etc/bashrc, which
      // sources /etc/config, so the setting is simply in the environment.
      const fresh = await testCtx.server.createShellClient();
      try {
        // Trimmed: `echo` writes a trailing newline and the API shell only
        // strips it for output that happens to parse as JSON.
        assertEquals((await fresh.execString('echo $CFG_PIPELINE_MAX_CONCURRENT')).trim(), '8');
      } finally {
        fresh.close();
      }
    });

    await t.step('setting the same key twice leaves one line', async () => {
      // Deliberately an option no service reads: this is about the file, and
      // bouncing the pipeline engine twice to find out would only add seconds.
      await admin.exec('config set CFG_DEFAULT_SHARE_MODE 0750');
      await admin.exec('config set CFG_DEFAULT_SHARE_MODE 0770');

      const file = await admin.execString('cat /etc/config');
      const occurrences = file.split('\n').filter((line) => line.includes('CFG_DEFAULT_SHARE_MODE')).length;
      assertEquals(occurrences, 1, file);
      assertEquals((await admin.execJson<ConfigEntry>('config get CFG_DEFAULT_SHARE_MODE')).value, '0770');
    });

    await t.step('unset reverts to the default', async () => {
      await admin.exec('config unset CFG_DEFAULT_SHARE_MODE');
      const entry = await admin.execJson<ConfigEntry>('config get CFG_DEFAULT_SHARE_MODE');
      assertEquals(entry.value, '0750');
      assertEquals(entry.source, 'default');
    });

    await t.step('rejects an unknown key', async () => {
      const result = await admin.exec('config set CFG_NOT_A_SETTING 1');
      assertEquals(result.success, false);
      assertStringIncludes(result.error ?? '', 'unknown setting');
    });

    await t.step('rejects a value of the wrong shape', async () => {
      const number = await admin.exec('config set CFG_SESSION_EXPIRES_SEC lots');
      assertEquals(number.success, false);
      assertStringIncludes(number.error ?? '', 'expected a number');

      const mode = await admin.exec('config set CFG_DEFAULT_SHARE_MODE rwxr-xr-x');
      assertEquals(mode.success, false);
      assertStringIncludes(mode.error ?? '', 'octal mode');

      const choice = await admin.exec('config set CFG_USER_DEFAULT_SHARE loud');
      assertEquals(choice.success, false);
      assertStringIncludes(choice.error ?? '', 'expected one of');
    });

    await t.step('a port change reports rather than restarting its server', async () => {
      // Restarting http-server from here would drop the connection carrying the
      // request, so the option names no services and explains itself instead.
      const result = await admin.execJson<SetResult>('config set CFG_HTTP_PORT 9090');
      assertEquals(result.restarted, []);
      assert(result.restartNote, 'a port change should explain when it takes effect');
      await admin.exec('config unset CFG_HTTP_PORT');
    });

    await t.step('an empty value is refused unless the option allows one', async () => {
      const refused = await admin.exec("config set CFG_SESSION_EXPIRES_SEC ''");
      assertEquals(refused.success, false);

      // The default owner is whoever creates it, which is what empty means.
      const allowed = await admin.exec("config set CFG_DEFAULT_SHARE_OWNER ''");
      assertEquals(allowed.success, true);
      await admin.exec('config unset CFG_DEFAULT_SHARE_OWNER');

      // No default groups: a new account is in its own group alone.
      assertEquals((await admin.exec("config set CFG_DEFAULT_USER_GROUPS ''")).success, true);
      try {
        const created = await admin.execJson<UserCreated>('user-create anna');
        assertEquals(created.groups, ['anna']);
      } finally {
        await admin.exec('config unset CFG_DEFAULT_USER_GROUPS');
      }
    });

    await t.step('a non-admin cannot write the system layer', async () => {
      await admin.exec("user create alice --title 'Alice'");
      await admin.exec('user passwd alice --new-password secret');

      const alice = await testCtx.server.createShellClient({ username: 'alice', password: 'secret' });
      try {
        const refused = await alice.exec('config set CFG_SESSION_EXPIRES_SEC 99');
        assertEquals(refused.success, false);
        assertStringIncludes(refused.error ?? '', 'administrator');
      } finally {
        alice.close();
      }
    });

    await t.step("a user's own settings are theirs alone", async () => {
      await admin.exec("user create bob --title 'Bob'");
      await admin.exec('user passwd bob --new-password secret');

      const alice = await testCtx.server.createShellClient({ username: 'alice', password: 'secret' });
      const bob = await testCtx.server.createShellClient({ username: 'bob', password: 'secret' });
      try {
        assertEquals((await alice.exec('config set CFG_USER_DEFAULT_SHARE private')).success, true);

        assertEquals((await alice.execJson<ConfigEntry>('config get CFG_USER_DEFAULT_SHARE')).value, 'private');
        assertEquals((await bob.execJson<ConfigEntry>('config get CFG_USER_DEFAULT_SHARE')).value, 'default');

        // And it is in alice's environment, not bob's — the login re-source is
        // what puts it there, since both shells opened as guest.
        // Read through a marker: an unset variable echoes an empty line, which
        // the API shell hands back as null rather than as ''.
        const show = 'echo "share=${CFG_USER_DEFAULT_SHARE:-unset}"';

        const freshAlice = await testCtx.server.createShellClient({ username: 'alice', password: 'secret' });
        try {
          assertEquals((await freshAlice.execString(show)).trim(), 'share=private');
        } finally {
          freshAlice.close();
        }
        assertEquals((await bob.execString(show)).trim(), 'share=unset');
      } finally {
        alice.close();
        bob.close();
      }
    });
  } finally {
    admin.close();
    await testCtx.teardown();
  }
});
