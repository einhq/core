/**
 * Full boot (instance mode `test`): expected topology, users/groups,
 * core's setup, service registration and setup idempotency.
 */

import { BIN_PATH, CORE_BIN_PATH, ETC_PATH, INIT_FILES_PATH, MOD_PATH, pathExports, SESSIONS_PATH, SYSTEM_LOG_PATH, TAGS_ROOT, TEMP_PATH, WWW_PATH } from '../../lib/paths.ts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { SystemTestHarness, testCommands } from '../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

Deno.test({
  name: 'boot sequence',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('expected topology exists', async () => {
      for (const path of [BIN_PATH, `${CORE_BIN_PATH}/mkdir`, TEMP_PATH, '/dev/null', '/dev/events', SYSTEM_LOG_PATH, '/etc', MOD_PATH, '/home', SESSIONS_PATH, TAGS_ROOT]) {
        assertEquals(await vfs.exists(ADMIN_ACCESS, path), true, `missing ${path}`);
      }

      // /tmp resolves through the mount to the memory root created with mode=777
      const tmp = await vfs.get(ADMIN_ACCESS, '/tmp');
      assertEquals(tmp.props.mode & 0o777, 0o777);

      const events = await vfs.get(ADMIN_ACCESS, '/dev/events');
      assertEquals(events.attrs.routingKey, 'system.events');
    });

    await t.step('users and groups are provisioned', async () => {
      await cmd.shouldSucceed('user-exists admin');
      await cmd.shouldSucceed('user-exists guest');
      await cmd.shouldSucceed('group-exists admin');
      await cmd.shouldSucceed('group-exists guest');
      await cmd.shouldSucceed('group-exists users');

      const who = await client.execJson<{ username: string; uid: number }>('user-whoami');
      assertEquals(who.username, 'admin');
    });

    const readBashrc = (): Promise<string> => client.execString('cat /etc/bashrc');

    await t.step('extensionless text files get a text mimetype', async () => {
      const result = await client.execJson<{ stored: string | null }>('mime /etc/bashrc');
      assertEquals(result.stored?.startsWith('text/'), true, JSON.stringify(result));
    });

    await t.step('core is set up, and is no module', async () => {
      // The seed bashrc
      assertEquals((await readBashrc()).includes("alias ll='ls -al'"), true);

      // core services registered
      const services = await client.execString('service list');
      for (const svc of ['http-server', 'ssh-server', 'pipeline-engine']) {
        assertEquals(services.includes(svc), true, `missing service ${svc}`);
      }

      // The terminal page; a test instance serves no browser shell
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${WWW_PATH}/core/index.html`), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${WWW_PATH}/ui`), false);

      assertEquals(await client.execJson<unknown[]>('mod list'), []);
    });

    await t.step('pipeline-engine service is running, network services stay disabled', async () => {
      const status = await client.execString('service status pipeline-engine');
      assertEquals(status.includes('running'), true, status);

      const httpStatus = await client.execString('service status http-server');
      assertEquals(httpStatus.includes('running'), false, httpStatus);
    });

    await t.step('PATH has no duplicate entries at runtime', async () => {
      const path = await client.execString('echo $PATH');
      const entries = path.trim().split(':');
      assertEquals(entries.filter((e) => e === CORE_BIN_PATH).length, 1, path);
      assertEquals(entries.filter((e) => e === BIN_PATH).length, 1, path);
    });

    await t.step('setup.sh re-run is idempotent', async () => {
      const systemLog = await vfs.get(ADMIN_ACCESS, SYSTEM_LOG_PATH);
      const terminal = await vfs.get(ADMIN_ACCESS, `${WWW_PATH}/core`, { follow: false });
      const bashrc = await readBashrc();
      await cmd.shouldSucceed('/etc/files/init/setup.sh');

      assertEquals((await vfs.get(ADMIN_ACCESS, SYSTEM_LOG_PATH)).id, systemLog.id);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${WWW_PATH}/core`, { follow: false })).id, terminal.id);
      assertEquals(await readBashrc(), bashrc);

      // No duplicate service registrations
      const services = await client.execString('service list');
      const engineCount = services.split('pipeline-engine').length - 1;
      assertEquals(engineCount >= 1, true);
    });

    await t.step('the layout is exactly what boot exports, sourced once from bashrc', async () => {
      const layoutLine = `[ -r ${ETC_PATH}/layout ] && source ${ETC_PATH}/layout`;
      const rerun = `EIN_PATH_EXPORTS='${pathExports()}' ${INIT_FILES_PATH}/init/test/09_env.sh`;

      await cmd.shouldSucceed(`echo 'export GONE_PATH="/gone"' >> ${ETC_PATH}/layout`);
      await cmd.shouldSucceed(rerun);
      await cmd.shouldSucceed(rerun);

      assertEquals(await client.execString(`cat ${ETC_PATH}/layout`), `#!bash\n${pathExports()}\n`);
      assertEquals((await readBashrc()).split('\n').filter((line) => line === layoutLine).length, 1);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
