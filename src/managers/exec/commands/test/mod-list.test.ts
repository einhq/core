/**
 * mod-list lists every module, linked ones included.
 *
 * A host running dev modules links each one into /usr/modules from the mounted checkout, and the
 * links are modules all the same.
 */

import { assert, assertEquals } from '@std/assert';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';
import type { ModuleEntry } from '../../../../lib/api/mod.ts';

const testCtx = createTestContext();
let client: ShellClient;

Deno.test({ name: 'mod-list', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  try {
    await t.step('a module linked into the modules directory is listed; a dangling link is not', async () => {
      const source = `/tmp/mod-list-${crypto.randomUUID()}`;
      await client.exec(`mkdir -p ${source}/linked && echo '{"name":"linked","version":"1.2.3","description":"A linked module"}' > ${source}/linked/mod.json`);
      await client.exec(`ln -s ${source}/linked $MOD_PATH/linked && ln -s ${source}/nowhere $MOD_PATH/gone`);
      const modules = await client.execJson<{ name: string; version: string }[]>('mod-list');
      const linked = modules.find((module) => module.name === 'linked');
      assertEquals(linked?.version, '1.2.3');
      assert(!modules.some((module) => module.name === 'gone'));
      assert(`${(await client.exec('JSON_OUTPUT=0 mod-list')).data}`.includes('linked (1.2.3) [not set up]'));
    });

    await t.step('each module lists its services and the paths of its pages', async () => {
      const name = `with-parts-${crypto.randomUUID().slice(0, 8)}`;
      const manifest = JSON.stringify({ name, version: '1.0.0', ui: { routes: { '/things/:id': 'ui/thing.tsx', '/things': 'ui/things.tsx' } } });
      await client.exec(`mkdir -p $MOD_PATH/${name}/services/worker && echo '${manifest}' > $MOD_PATH/${name}/mod.json`);
      await client.exec(`echo 'exit 0' > $MOD_PATH/${name}/services/sweep.sh`);
      const entry = (await client.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === name);
      assertEquals(entry?.services, ['sweep.sh', 'worker']);
      assertEquals(entry?.routes, ['/things', '/things/:id']);
      assertEquals(entry?.commands, []);
      assert(`${(await client.exec('JSON_OUTPUT=0 mod-list --long')).data}`.includes('Services: sweep.sh, worker'));
    });

    await t.step('each module says how its last setup went', async () => {
      const id = crypto.randomUUID().slice(0, 8);
      const good = `setup-ok-${id}`;
      const bad = `setup-bad-${id}`;
      await client.exec(`mkdir -p $MOD_PATH/${good} && echo '{"name":"${good}","version":"1.0.0"}' > $MOD_PATH/${good}/mod.json`);
      await client.exec(`mkdir -p $MOD_PATH/${bad} && echo '{"name":"${bad}","version":"1.0.0","coreApi":"^999.0.0"}' > $MOD_PATH/${bad}/mod.json`);
      await client.exec(`mod-setup ${good}`);
      await client.exec(`mod-setup ${bad}`);

      const modules = await client.execJson<ModuleEntry[]>('mod-list');
      const setupOf = (name: string) => modules.find((module) => module.name === name)?.setup;
      assertEquals(setupOf(good)?.ok, true);
      assertEquals(setupOf(good)?.problems, []);
      assertEquals(setupOf(bad)?.ok, false);
      assert(setupOf(bad)!.problems.some((problem) => problem.includes('999')));
      assertEquals(setupOf('linked'), undefined);
      assert(`${(await client.exec('JSON_OUTPUT=0 mod-list')).data}`.includes(`${bad} (1.0.0) [setup failed]`));

      // What each is written against; core is none of them.
      const entry = (name: string) => modules.find((module) => module.name === name);
      assertEquals(entry(bad)?.coreApi, '^999.0.0');
      assertEquals(entry(good)?.coreApi, undefined);
      assertEquals(entry('core'), undefined);

      // A removed module that comes back has not been set up again.
      await client.exec(`mod-remove --force ${good}`);
      await client.exec(`mkdir -p $MOD_PATH/${good} && echo '{"name":"${good}","version":"1.0.0"}' > $MOD_PATH/${good}/mod.json`);
      assertEquals((await client.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === good)?.setup, undefined);
    });
  } finally {
    await testCtx.teardown();
  }
});
