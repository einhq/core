/**
 * `mod setup` registers a module's services, a directory with a start.sh or a single script, and
 * enables one only when it registers it for the first time: a service an administrator disabled
 * stays disabled when `mod setup` runs again, as it does at every boot.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { SERVICES_PATH } from '../../../../lib/paths.ts';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({ name: 'mod setup keeps a service disabled', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const id = crypto.randomUUID().slice(0, 8);
  const name = `svc-${id}`;
  const worker = `${name}-worker`;
  const scan = `${name}-scan`;

  const exists = (path: string) => vfs.exists(ADMIN_ACCESS, path, { follow: false });
  const registered = (service: string) => exists(`${SERVICES_PATH}/available/${service}`);
  const enabled = (service: string) => exists(`${SERVICES_PATH}/enabled/${service}`);
  const setup = async () => assertEquals((await client.exec(`mod-setup ${name}`)).success, true);

  try {
    await client.exec(
      `mkdir -p $MOD_PATH/${name}/services/${worker} && echo '{"name":"${name}","version":"1.0.0"}' > $MOD_PATH/${name}/mod.json` +
        ` && echo 'sleep 3600' > $MOD_PATH/${name}/services/${worker}/start.sh && echo 'sleep 3600' > $MOD_PATH/${name}/services/${scan}`,
    );

    await t.step('a service registered for the first time is enabled', async () => {
      await setup();
      for (const service of [worker, scan]) {
        assertEquals(await registered(service), true, service);
        assertEquals(await enabled(service), true, service);
      }
    });

    await t.step('a disabled service stays disabled when mod setup runs again', async () => {
      for (const service of [worker, scan]) assertEquals((await client.exec(`service-disable ${service}`)).success, true);
      await setup();
      for (const service of [worker, scan]) {
        assertEquals(await registered(service), true, service);
        assertEquals(await enabled(service), false, service);
      }
    });

    await t.step('one enabled again stays enabled', async () => {
      assertEquals((await client.exec(`service-enable ${worker}`)).success, true);
      await setup();
      assertEquals(await enabled(worker), true);
      assertEquals(await enabled(scan), false);
    });
  } finally {
    await testCtx.teardown();
  }
});
