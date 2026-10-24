/**
 * The modules `mod install` installed live in a folder of the host's, which boot mounts read-write
 * at MOD_INSTALL_PATH and links into MOD_PATH: an instance started on a new store, as a new
 * container is, finds and sets up the ones already there, and fetches the ones the deployment
 * asks for (`INSTALL_MODULES`) that are not.
 */

import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import type { ModuleEntry } from '../../lib/api/mod.ts';
import { MODULE_API_VERSION } from '../../modules/mod.ts';
import { FakeForge, moduleFiles } from '../../testing/fake-forge.ts';
import { createTestContext } from '../../testing/mod.ts';

const folder = await Deno.makeTempDir({ prefix: 'ein-installed-modules-' });
await Deno.mkdir(join(folder, 'hello', 'bin'), { recursive: true });
await Deno.writeTextFile(join(folder, 'hello', 'mod.json'), JSON.stringify({ name: 'hello', version: '1.0.0', coreApi: `^${MODULE_API_VERSION}` }));
await Deno.writeTextFile(join(folder, 'hello', 'bin', 'hello'), '#!bash\necho "hello from the folder"\n', { mode: 0o755 });
// What an install cut short leaves, and anything else that is no module, is not linked.
await Deno.mkdir(join(folder, '.staging-cut-short'));
await Deno.writeTextFile(join(folder, 'notes.txt'), 'not a module');

const forge = new FakeForge();
forge.start();
await forge.publish('acme', 'module-fetched', moduleFiles('fetched', '1.0.0', 'fetched at boot'));

const testCtx = createTestContext({
  boot: true,
  env: { EXTERNAL_MODULE_INSTALL_PATH: folder, INSTALL_MODULES: 'hello fetched', CFG_MODULE_SOURCES: forge.url('acme') },
});

Deno.test({ name: 'installed modules', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  try {
    await t.step('a module in the folder is linked and set up at boot', async () => {
      assertEquals((await admin.execJson<{ softlink?: string }>('props -L $MOD_PATH/hello')).softlink, '/var/lib/modules/hello');
      assertEquals((await admin.execString('JSON_OUTPUT=0 $MOD_PATH/hello/bin/hello')).trim(), 'hello from the folder');
      assertEquals((await admin.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === 'hello')?.setup?.ok, true);
      assertEquals((await admin.execJson<string[]>('ls $MOD_PATH')).filter((name) => name !== 'hello' && name !== 'fetched'), []);
    });

    await t.step('a module the deployment asks for is fetched into the folder and set up; one there already is left alone', async () => {
      assertEquals((await admin.execString('JSON_OUTPUT=0 $MOD_PATH/fetched/bin/fetched')).trim(), 'fetched at boot');
      assertEquals(JSON.parse(await Deno.readTextFile(join(folder, 'fetched', 'mod.json'))).name, 'fetched');
      const modules = await admin.execJson<ModuleEntry[]>('mod-list');
      assertEquals(modules.find((module) => module.name === 'fetched')?.setup?.ok, true);
      assertEquals(modules.find((module) => module.name === 'hello')?.installed, undefined);
    });

    await t.step("what is written there is the host's folder", async () => {
      await admin.execString('echo kept > $MOD_INSTALL_PATH/hello/written');
      assertEquals((await Deno.readTextFile(join(folder, 'hello', 'written'))).trim(), 'kept');
    });
  } finally {
    admin.close();
    await testCtx.teardown();
    await forge.stop();
    await Deno.remove(folder, { recursive: true });
  }
});
