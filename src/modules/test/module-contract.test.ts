/**
 * Module contract suite — the executable spec of the module interface.
 *
 * Installs the fixture module (src/testing/fixtures/modules/mod-fixture) into
 * a fully booted system and asserts every observable effect of `mod setup`,
 * `mod list`/`mod info` and `mod remove`.
 */

import { MOD_PATH, PIPELINE_DEFINITIONS_PATH, SERVICES_PATH, WWW_PATH } from '../../lib/paths.ts';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { ADMIN_UID, USERS_GID } from '../../lib/access/constants.ts';
import { SystemTestHarness, testCommands } from '../../testing/mod.ts';

const harness = new SystemTestHarness({ ssh: false, boot: true });

const FIXTURES_PATH = join(import.meta.dirname!, '..', '..', 'testing', 'fixtures', 'modules');

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({
  name: 'module contract',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  /**
   * A module with a manifest and one bin, and nothing else.
   *
   * Deliberately not a copy of the fixture: that carries services, pipelines and a ui/, so
   * setting one up re-registers `fixture-svc` and the later teardown assertions stop meaning
   * what they say. These cases are about the manifest, so the module is only a manifest.
   */
  const miniModule = async (name: string, manifest: Record<string, unknown>): Promise<void> => {
    await client.exec(`mkdir -p ${MOD_PATH}/${name}/bin`);
    await client.exec(`echo 'echo hi' > ${MOD_PATH}/${name}/bin/${name}-hi`);
    await client.exec(`echo '${JSON.stringify(manifest)}' > ${MOD_PATH}/${name}/mod.json`);
  };

  const readVfsFile = async (path: string): Promise<string> => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
    try {
      const chunks: string[] = [];
      const dec = new TextDecoder();
      while (true) {
        const chunk = await handle.read(64 * 1024);
        if (chunk.length === 0) break;
        chunks.push(dec.decode(chunk));
      }
      return chunks.join('');
    } finally {
      await handle.close();
    }
  };

  try {
    // Install: mount the fixture read-only, copy it into the VFS as a real
    // module directory (like a git-installed module), then set it up
    await client.exec('mkdir -p /tmp/module-fixtures');
    await client.exec(`mount /tmp/module-fixtures filesystem "filesPath=${FIXTURES_PATH},readonly"`);
    await cmd.shouldSucceed(`cp -r /tmp/module-fixtures/mod-fixture ${MOD_PATH}/mod-fixture`);

    await t.step('mod setup succeeds', async () => {
      await cmd.shouldSucceed('mod setup mod-fixture');
    });

    await t.step('mod list and mod info know the module', async () => {
      const list = await client.execString('mod list');
      assertStringIncludes(list, 'mod-fixture');

      const info = await client.execString('mod info mod-fixture');
      assertStringIncludes(info, 'mod-fixture');
      assertStringIncludes(info, '0.1.0');
    });

    await t.step("the archive root it declares is created, the admin's and the users group's", async () => {
      const root = await vfs.get(ADMIN_ACCESS, '/archive/fixtures');
      assertEquals([root.type, root.props.mode, root.props.uid, root.props.gid], ['directory', 0o775, ADMIN_UID, USERS_GID]);
    });

    await t.step('etc/ files are copied and not overwritten on re-setup', async () => {
      assertEquals((await readVfsFile('/etc/fixture.conf')).trim(), 'setting=original');

      // Modify the installed copy, re-run setup — must not be clobbered
      await client.exec('echo "setting=changed" > /etc/fixture.conf');
      await cmd.shouldSucceed('mod setup mod-fixture');
      assertEquals((await readVfsFile('/etc/fixture.conf')).trim(), 'setting=changed');
    });

    await t.step('bin/ is on PATH via /etc/bashrc exactly once', async () => {
      const bashrc = await readVfsFile('/etc/bashrc');
      const line = `export PATH="$PATH:${MOD_PATH}/mod-fixture/bin"`;
      assertEquals(bashrc.split(line).length - 1, 1, bashrc);
    });

    await t.step('shell script and #!ts commands run from a fresh shell', async () => {
      const out = await client.execString('source /etc/bashrc && hello');
      assertEquals(out.trim(), 'hello from fixture');

      const ts = await client.execJson<{ hello: string }>('source /etc/bashrc && hello-ts');
      assertEquals(ts.hello, 'typescript');
    });

    await t.step('a #!ts command reads its stdin through cmd.stdin', async () => {
      assertEquals(await client.execString(`source /etc/bashrc && printf 'a\\nb\\n' | hello-stdin`, { json: false }), 'hello a\nhello b\n');
    });

    await t.step('a bin resolves imports core has never heard of', async () => {
      // The point of the whole exercise. `@fixture/greeting` exists only in the fixture's
      // mod.json, and the relative import resolves although the staged copy does not sit next
      // to the original. Both have to work for a module to live outside this repo.
      const out = await client.execJson<{ alias: string; relative: string }>('source /etc/bashrc && hello-deps');
      assertEquals(out.alias, 'hello alias');
      assertEquals(out.relative, 'hello relative');
    });

    await t.step("a module imports another's export through its declared dependency", async () => {
      await cmd.shouldSucceed(`cp -r /tmp/module-fixtures/mod-consumer ${MOD_PATH}/mod-consumer`);
      await cmd.shouldSucceed('mod setup mod-consumer');

      const out = await client.execJson<{ greeting: string }>('source /etc/bashrc && hello-consumer');
      assertEquals(out.greeting, 'hello consumer');

      // The interface is visible from the provider's side, along with who depends on it.
      const info = await client.execJson<{ exports: Record<string, string>; usedBy: string[] }>('mod info mod-fixture');
      assertEquals(info.exports, { './greeting': './lib/greeting.ts' });
      assertEquals(info.usedBy, ['mod-consumer']);

      await cmd.shouldSucceed('mod remove mod-consumer --force');
    });

    await t.step('services are registered and enabled', async () => {
      const list = await client.execString('service list');
      assertStringIncludes(list, 'fixture-svc');

      const status = await client.execJson<{ enabled: boolean }>('service status fixture-svc');
      assertEquals(status.enabled, true);

      await cmd.shouldSucceed('service start fixture-svc');
      const running = await client.execString('service status fixture-svc');
      assertStringIncludes(running, 'running');
      await cmd.shouldSucceed('service stop fixture-svc');
    });

    await t.step('pipelines are defined and fire on matching events', async () => {
      const defs = await client.execJson<string[]>(`ls ${PIPELINE_DEFINITIONS_PATH}`);
      assertEquals(defs.includes('fixture-index'), true);

      await client.exec('mkdir -p /tmp/markers && mkdir -p /work');
      await client.exec('mknode -t file --as "name=item.bin" --as "mimetype=application/x-fixture" /work/item.bin');
      await client.exec('chmod 644 /work/item.bin');

      await waitFor(async () => {
        const result = await client.exec('cat /tmp/markers/item.bin');
        return result.success && String(result.data).includes('hello');
      }, 'fixture pipeline to run');
    });

    await t.step('mod setup retires an owned pipeline whose YAML was removed', async () => {
      const pipeline = `${MOD_PATH}/mod-fixture/pipelines/fixture-index.yaml`;
      const retired = `${pipeline}.retired`;
      await cmd.shouldSucceed(`mv --no-relink ${pipeline} ${retired}`);
      await cmd.shouldSucceed('mod setup mod-fixture');

      let defs = await client.execJson<string[]>(`ls ${PIPELINE_DEFINITIONS_PATH}`);
      assertEquals(defs.includes('fixture-index'), false);

      // Restore it for the remaining contract checks and for mod remove, which
      // independently verifies that installed definitions are torn down.
      await cmd.shouldSucceed(`mv --no-relink ${retired} ${pipeline}`);
      await cmd.shouldSucceed('mod setup mod-fixture');
      defs = await client.execJson<string[]>(`ls ${PIPELINE_DEFINITIONS_PATH}`);
      assertEquals(defs.includes('fixture-index'), true);
    });

    await t.step('mod setup retires an owned service its module no longer ships', async () => {
      // A service a new module version drops is retired on upgrade, as its pipelines are,
      // rather than staying registered and failing to start at every boot.
      const service = `${MOD_PATH}/mod-fixture/services/fixture-svc`;
      const parked = `${MOD_PATH}/mod-fixture/parked-svc`;
      await cmd.shouldSucceed(`mv --no-relink ${service} ${parked}`);

      // A service the operator registered by hand is not the module's to retire, even when it
      // was set up from the same script.
      await cmd.shouldSucceed(`service add operator-svc ${parked}`);

      await cmd.shouldSucceed('mod setup mod-fixture');

      let services = await client.execString('service list');
      assertEquals(services.includes('fixture-svc'), false, services);
      assertStringIncludes(services, 'operator-svc');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/etc/services/enabled/fixture-svc', { follow: false }), false);

      await cmd.shouldSucceed('service remove operator-svc');
      await cmd.shouldSucceed(`mv --no-relink ${parked} ${service}`);
      await cmd.shouldSucceed('mod setup mod-fixture');
      services = await client.execString('service list');
      assertStringIncludes(services, 'fixture-svc');
      const status = await client.execJson<{ enabled: boolean }>('service status fixture-svc');
      assertEquals(status.enabled, true);
    });

    await t.step(`ui/ is linked into ${WWW_PATH}`, async () => {
      const props = await client.execJson<{ softlink: string }>(`props -L ${WWW_PATH}/mod-fixture`);
      assertEquals(props.softlink, `${MOD_PATH}/mod-fixture/ui`);
    });

    await t.step('a module with an unsatisfiable dependency refuses to install', async () => {
      // The point of validating: setup puts bins on PATH and starts services the moment it runs,
      // so a module that cannot work must refuse rather than half-wire itself.
      await miniModule('mod-needy', { name: 'mod-needy', version: '0.1.0', dependencies: { ghost: '^1.0.0' } });

      const result = await client.exec('mod setup mod-needy');
      assertEquals(result.success, false, 'setup should have refused');

      // and nothing was wired up
      const bashrc = await readVfsFile('/etc/bashrc');
      assertEquals(bashrc.includes(`${MOD_PATH}/mod-needy/bin`), false, bashrc);

      await client.exec(`rm -rf ${MOD_PATH}/mod-needy`);
    });

    await t.step('a module exporting a file it does not have refuses to install', async () => {
      // A dependent would resolve the export the moment it ran; refusing here keeps that failure
      // out of somebody else's pipeline step.
      await miniModule('mod-hollow', { name: 'mod-hollow', version: '0.1.0', exports: { './thing': './lib/missing.ts' } });

      const result = await client.exec('mod setup mod-hollow');
      assertEquals(result.success, false, 'setup should have refused');
      assertStringIncludes(result.error ?? '', "export './thing' points at a missing file");

      await client.exec(`rm -rf ${MOD_PATH}/mod-hollow`);
    });

    await t.step('a module declaring a coreApi this core cannot provide refuses', async () => {
      await miniModule('mod-future', { name: 'mod-future', version: '0.1.0', coreApi: '^99.0.0' });

      const result = await client.exec('mod setup mod-future');
      assertEquals(result.success, false, 'setup should have refused');

      const bashrc = await readVfsFile('/etc/bashrc');
      assertEquals(bashrc.includes(`${MOD_PATH}/mod-future/bin`), false, bashrc);

      await client.exec(`rm -rf ${MOD_PATH}/mod-future`);
    });

    await t.step("a module's etc/config is linked as /etc/config.d/<module>, never copied over /etc/config", async () => {
      await miniModule('mod-settings', { name: 'mod-settings', version: '0.1.0' });
      await client.exec(`mkdir -p ${MOD_PATH}/mod-settings/etc && echo "export CFG_SEARCH_PARSER='mod-settings-parse'" > ${MOD_PATH}/mod-settings/etc/config`);

      await cmd.shouldSucceed('mod setup mod-settings');
      const link = await vfs.get(ADMIN_ACCESS, '/etc/config.d/mod-settings', { follow: false });
      assertEquals(link.props.softlink, `${MOD_PATH}/mod-settings/etc/config`);
      assertEquals((await readVfsFile('/etc/config.d/mod-settings')).includes('mod-settings-parse'), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/etc/config') && (await readVfsFile('/etc/config')).includes('mod-settings-parse'), false);
      // A new shell has it, through /etc/bashrc.
      const fresh = await harness.createShellClient();
      try {
        assertEquals((await fresh.execString('echo $CFG_SEARCH_PARSER')).trim(), 'mod-settings-parse');
      } finally {
        fresh.close();
      }

      await cmd.shouldSucceed('mod remove mod-settings --force');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/etc/config.d/mod-settings'), false);
    });

    await t.step('mod setup --all orders dependencies and isolates a failed module', async () => {
      // The dependent sorts before its dependency, so only the manifest graph can put these
      // bashrc writes in the right order. The broken fixture then fails service registration;
      // mod-z-after sorts after it and proves setup continued rather than aborting the walk.
      await miniModule('mod-a-dependent', {
        name: 'mod-a-dependent',
        version: '0.1.0',
        dependencies: { 'mod-z-base': '^1.0.0' },
      });
      await miniModule('mod-z-base', { name: 'mod-z-base', version: '1.0.0' });
      await cmd.shouldSucceed(`cp -r /tmp/module-fixtures/mod-failing ${MOD_PATH}/mod-failing`);
      await miniModule('mod-z-after', { name: 'mod-z-after', version: '0.1.0' });

      const result = await client.exec('mod setup --all');
      assertEquals(result.success, false, 'the aggregate command must report the broken module');

      const bashrc = await readVfsFile('/etc/bashrc');
      const base = bashrc.indexOf(`${MOD_PATH}/mod-z-base/bin`);
      const dependent = bashrc.indexOf(`${MOD_PATH}/mod-a-dependent/bin`);
      assertEquals(base >= 0, true, bashrc);
      assertEquals(dependent > base, true, bashrc);
      assertEquals(bashrc.includes(`${MOD_PATH}/mod-z-after/bin`), true, bashrc);

      for (const name of ['mod-a-dependent', 'mod-z-base', 'mod-failing', 'mod-z-after']) {
        await cmd.shouldSucceed(`mod remove ${name} --force`);
      }
    });

    await t.step('mod setup --all forgets a module whose code is gone, so another can take its service', async () => {
      // What a deploy that drops a module leaves: `/usr/modules/<name>` still links to where the
      // code was, and its bashrc line and service are both still registered. `mod remove`
      // cannot undo it — it reads the module's own directory to know what to undo.
      const source = '/tmp/mod-src/mod-gone';
      await client.exec(`mkdir -p ${source}/bin ${source}/services/shared-svc`);
      await client.exec(`echo '${JSON.stringify({ name: 'mod-gone', version: '0.1.0' })}' > ${source}/mod.json`);
      await client.exec(`echo 'echo gone' > ${source}/bin/gone-hi`);
      await client.exec(`echo 'echo old' > ${source}/services/shared-svc/start.sh`);
      await cmd.shouldSucceed(`ln -s ${source} ${MOD_PATH}/mod-gone`);
      await cmd.shouldSucceed('mod setup mod-gone');

      const registration = join(SERVICES_PATH, 'available', 'shared-svc');
      const target = async () => (await vfs.get(ADMIN_ACCESS, registration, { follow: false })).props.softlink as string;
      assertEquals((await target()).startsWith(`${MOD_PATH}/mod-gone/`), true);

      // The deploy drops the module; another now ships the same service.
      await cmd.shouldSucceed(`rm -rf ${source}`);
      await miniModule('mod-heir', { name: 'mod-heir', version: '0.1.0' });
      await client.exec(`mkdir -p ${MOD_PATH}/mod-heir/services/shared-svc && echo 'echo new' > ${MOD_PATH}/mod-heir/services/shared-svc/start.sh`);

      const result = await client.execJson<{ pruned: string[] }>('mod setup --all');
      assertEquals(result.pruned, ['mod-gone']);

      assertEquals(await vfs.exists(ADMIN_ACCESS, `${MOD_PATH}/mod-gone`, { follow: false }), false);
      const bashrc = await readVfsFile('/etc/bashrc');
      assertEquals(bashrc.includes(`${MOD_PATH}/mod-gone/bin`), false, bashrc);
      assertEquals((await target()).startsWith(`${MOD_PATH}/mod-heir/`), true, await target());

      await cmd.shouldSucceed('mod remove mod-heir --force');
    });

    await t.step('mod remove runs uninstall.sh and deletes the module', async () => {
      await cmd.shouldSucceed('mod remove mod-fixture --force');

      // uninstall.sh ran
      assertStringIncludes(await readVfsFile('/tmp/fixture-uninstalled'), 'removed');

      // module directory is gone
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${MOD_PATH}/mod-fixture`), false);
    });

    await t.step('mod remove undoes setup side effects', async () => {
      const bashrc = await readVfsFile('/etc/bashrc');
      assertEquals(bashrc.includes(`${MOD_PATH}/mod-fixture/bin`), false, bashrc);

      const services = await client.execString('service list');
      assertEquals(services.includes('fixture-svc'), false, services);

      const defs = await client.execJson<string[]>(`ls ${PIPELINE_DEFINITIONS_PATH}`);
      assertEquals(defs.includes('fixture-index'), false);

      assertEquals(await vfs.exists(ADMIN_ACCESS, `${WWW_PATH}/mod-fixture`, { follow: false }), false);
      // Not its archive root: that holds content.
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/archive/fixtures'), true);
    });
  } finally {
    client.close();
    await harness.stop();
  }
});
