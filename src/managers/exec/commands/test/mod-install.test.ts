/**
 * mod install and mod search against a forge that answers as Forgejo does: git's ref
 * advertisement, `/archive/<commit>.tar.gz` and the organisation's repositories in its API.
 *
 * What is pinned down: a module named by its name comes from the first source that has it, with
 * its dependencies; it is unpacked into the installed modules and linked into /usr/modules; the
 * same commit is not fetched again and a new one replaces the module whole; an update a dependent
 * does not accept is refused unless forced; --missing and --no-setup, as boot runs it, leave an
 * installed module alone and set nothing up; a module the deployment provides, one for another core
 * and a repository that holds no module leave nothing behind; a private repository is read with
 * its host's token; and mod remove takes an installed module's tree with it.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { ModuleEntry, ModuleInstallResult, ModuleSearch, SystemInfo } from '../../../../lib/api/mod.ts';
import { FakeForge, moduleFiles } from '../../../../testing/fake-forge.ts';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const forge = new FakeForge();
const testCtx = createTestContext();
let client: ShellClient;

const install = async (args: string): Promise<{ success: boolean; answer?: ModuleInstallResult; error?: string }> => {
  const result = await client.exec(`mod install ${args}`);
  return { success: result.success, answer: result.data as ModuleInstallResult | undefined, error: result.error };
};

const run = async (command: string): Promise<string> => (await client.execString(`JSON_OUTPUT=0 ${command}`)).trim();

/** What else is beside the installed modules: a staging or a replaced tree left behind. */
const hidden = async (path: string): Promise<string[]> => (await client.execJson<string[]>(`ls -A ${path}`)).filter((name) => name.startsWith('.'));

Deno.test({ name: 'mod-install', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  forge.start();
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  try {
    await forge.publish('acme', 'module-base', moduleFiles('base', '1.0.0', 'base 1'));
    const first = await forge.publish('acme', 'module-greet', {
      ...moduleFiles('greet', '1.0.0', 'greet 1', { dependencies: { base: '^1.0.0' } }),
      'bin/greet-ts': {
        text:
          "#!ts\nimport type { CmdReturn, Command } from '@ein/client';\nconst greetTs = async (cmd: Command): CmdReturn => {\n  await cmd.write('greet from ts\\n');\n  return 0;\n};\ngreetTs.spec = { name: 'greet-ts', description: 'says so' };\nexport default greetTs;\n",
        mode: 0o755,
      },
    }, { tag: 'v1', description: 'Greets' });
    await client.execString(`config set CFG_MODULE_SOURCES '${forge.url('nobody')} ${forge.url('acme')}'`);

    await t.step('a module named by its name comes from the first source that has it, its dependency first', async () => {
      const { success, answer, error } = await install('greet');
      assert(success, error);
      assertEquals(answer?.installed.map((module) => [module.name, module.version, module.updated]), [['base', '1.0.0', false], ['greet', '1.0.0', false]]);
      assertEquals(answer?.installed[1].commit, first);
      assertEquals(answer?.installed[1].repository, `${forge.url('acme')}/module-greet`);

      assertEquals(await client.execJson<string[]>('ls $MOD_INSTALL_PATH'), ['base', 'greet']);
      const link = await client.execJson<{ softlink?: string }>('props -L $MOD_PATH/greet');
      assertEquals(link.softlink, '/var/lib/modules/greet');
      assertEquals(await run('$MOD_PATH/greet/bin/greet'), 'greet 1');
      assertEquals(await run('$MOD_PATH/greet/bin/greet-ts'), 'greet from ts');
      assertEquals(await run('$MOD_PATH/base/bin/base'), 'base 1');

      const listed = (await client.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === 'greet');
      assertEquals(listed?.installed?.commit, first);
      assertEquals(listed?.installed?.ref, 'main');
      assertEquals(listed?.setup?.ok, true);
      const info = await client.execJson<SystemInfo>('system-info');
      if (info.build) assertEquals(info.build.modules?.greet, first.slice(0, 9));
    });

    await t.step('the same commit is left alone; a new one replaces the module whole', async () => {
      const again = await install('greet');
      assert(again.success, again.error);
      assertEquals(again.answer?.installed, []);

      const second = await forge.publish('acme', 'module-greet', moduleFiles('greet', '1.1.0', 'greet 2', { dependencies: { base: '^1.0.0' } }));
      const update = await install('greet');
      assert(update.success, update.error);
      assertEquals(update.answer?.installed.map((module) => [module.name, module.commit, module.updated]), [['greet', second, true]]);
      assertEquals(await run('$MOD_PATH/greet/bin/greet'), 'greet 2');
      // The new tree replaced the old one rather than being laid over it.
      assertEquals(await client.execJson<string[]>('ls $MOD_INSTALL_PATH/greet/bin'), ['greet']);
      assertEquals(await hidden('$MOD_INSTALL_PATH'), []);
    });

    await t.step('a ref pins the commit, and the record says which', async () => {
      const pinned = await install(`${forge.url('acme')}/module-greet@v1`);
      assert(pinned.success, pinned.error);
      assertEquals(pinned.answer?.installed[0]?.commit, first);
      assertEquals(await run('$MOD_PATH/greet/bin/greet'), 'greet 1');
      assertEquals((await client.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === 'greet')?.installed?.ref, 'v1');
      assert((await install('greet@main')).success);

      const missing = await install('greet@v9');
      assertEquals(missing.success, false);
      assertStringIncludes(missing.error ?? '', "no branch or tag 'v9'");
    });

    await t.step('an update a dependent does not accept is refused, unless forced', async () => {
      await forge.publish('acme', 'module-fan', moduleFiles('fan', '1.0.0', 'fan', { dependencies: { greet: '^1.0.0' } }));
      assert((await install(`${forge.url('acme')}/module-fan.git`)).success);

      await forge.publish('acme', 'module-greet', moduleFiles('greet', '2.0.0', 'greet 3', { dependencies: { base: '^1.0.0' } }));
      const refused = await install('greet');
      assertEquals(refused.success, false);
      assertStringIncludes(refused.error ?? '', 'fan needs greet ^1.0.0');
      assertEquals(await run('$MOD_PATH/greet/bin/greet'), 'greet 2');

      // Forced, the update is made, and the dependent set up again says it does not accept it.
      const forced = await install('greet --force');
      assertEquals(forced.success, false);
      assertStringIncludes(forced.error ?? '', 'fan: its setup failed after the update');
      assertEquals(await run('$MOD_PATH/greet/bin/greet'), 'greet 3');
      const fan = (await client.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === 'fan');
      assertEquals(fan?.setup?.ok, false);
    });

    await t.step('--missing leaves an installed module as it is, and --no-setup puts one in place without setting it up', async () => {
      await forge.publish('acme', 'module-greet', moduleFiles('greet', '2.1.0', 'greet 4', { dependencies: { base: '^1.0.0' } }));
      const kept = await install('--missing greet');
      assert(kept.success, kept.error);
      assertEquals(kept.answer?.installed, []);
      assertEquals(await run('$MOD_PATH/greet/bin/greet'), 'greet 3');

      await forge.publish('acme', 'module-quiet', moduleFiles('quiet', '1.0.0', 'quiet'));
      const placed = await install('--missing --no-setup quiet');
      assert(placed.success, placed.error);
      assertEquals(placed.answer?.installed.map((module) => module.name), ['quiet']);
      assertEquals((await client.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === 'quiet')?.setup, undefined);
      await client.execString('mod-remove --force quiet');
    });

    await t.step("the deployment's module, one for another core, and a repository with no module leave nothing behind", async () => {
      await client.execString(`mkdir -p $DEV_MODULES_PATH/kept && echo '{"name":"kept","version":"1.0.0"}' > $DEV_MODULES_PATH/kept/mod.json`);
      await forge.publish('acme', 'module-kept', moduleFiles('kept', '2.0.0', 'kept'));
      await forge.publish('acme', 'module-future', {
        ...moduleFiles('future', '1.0.0', 'future'),
        'mod.json': JSON.stringify({ name: 'future', version: '1.0.0', coreApi: '^99.0.0' }),
      });
      await forge.publish('acme', 'module-empty', { 'README.md': 'nothing' });

      for (const [name, says] of [['kept', "one of the deployment's modules"], ['future', 'needs @ein/client ^99.0.0'], ['empty', 'no mod.json']]) {
        const refused = await install(name);
        assertEquals(refused.success, false, name);
        assertStringIncludes(refused.error ?? '', says);
      }
      assertEquals(await client.execJson<string[]>('ls $MOD_INSTALL_PATH'), ['base', 'fan', 'greet']);
      assertEquals(await hidden('$MOD_INSTALL_PATH'), []);
    });

    await t.step("a private repository is read with its host's token", async () => {
      await forge.publish('acme', 'module-secret', moduleFiles('secret', '1.0.0', 'secret'), { token: 'let-me-in' });
      const refused = await install('secret');
      assertEquals(refused.success, false);
      assertStringIncludes(refused.error ?? '', 'CFG_MODULE_SOURCES_KEY');

      await client.execString(`config set CFG_MODULE_SOURCES_KEY '${forge.host}=let-me-in'`);
      const allowed = await install('secret');
      assert(allowed.success, allowed.error);
      assertEquals(await run('$MOD_PATH/secret/bin/secret'), 'secret');
    });

    await t.step('mod search lists the published modules with what their default branch holds', async () => {
      const search = await client.execJson<ModuleSearch>('mod search');
      assertEquals(search.modules.map((module) => module.name), ['base', 'empty', 'fan', 'future', 'greet', 'kept', 'quiet', 'secret']);
      const greet = search.modules.find((module) => module.name === 'greet');
      assertEquals([greet?.version, greet?.compatible, greet?.description, greet?.commit], [
        '2.1.0',
        true,
        'Greets',
        forge.repositories.get('acme/module-greet')!.branches.get('main'),
      ]);
      assertEquals(search.modules.find((module) => module.name === 'future')?.compatible, false);
      // The source with nothing in it is named, and the other still answers.
      assertEquals(search.failed.map((failure) => failure.source), [forge.url('nobody')]);

      assertEquals((await client.execJson<ModuleSearch>('mod search gree')).modules.map((module) => module.name), ['greet']);
      // greet is installed at 2.0.0's commit, and 2.1.0's is published; base is as published.
      const installed = (await client.execJson<ModuleEntry[]>('mod-list')).find((module) => module.name === 'greet')!.installed!.commit;
      assertStringIncludes(
        (await client.exec('JSON_OUTPUT=0 mod search greet')).data as string,
        `greet 2.1.0 [installed ${installed.slice(0, 9)}, ${greet!.commit!.slice(0, 9)} published]`,
      );
      assertStringIncludes((await client.exec('JSON_OUTPUT=0 mod search base')).data as string, 'base 1.0.0 [installed]');
    });

    await t.step("mod remove takes an installed module's tree with it", async () => {
      await client.execString('mod-remove --force fan');
      assertEquals(await client.execJson<string[]>('ls $MOD_INSTALL_PATH'), ['base', 'greet', 'secret']);
      assertEquals((await client.execJson<ModuleEntry[]>('mod-list')).some((module) => module.name === 'fan'), false);
    });
  } finally {
    client?.close();
    await testCtx.teardown();
    await forge.stop();
  }
});
