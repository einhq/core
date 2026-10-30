import { MOD_INSTALL_PATH, MOD_PATH, WWW_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { readModJson } from '../../../../modules/mod.ts';
import { parsePipeline } from '../../../pipeline/mod.ts';
import { clearCommandLookupCache } from '../../../shell/command-lookup.ts';
import { clearTsCommandCache } from '../../../shell/ts-command-loader.ts';
import { unregisterConfigOptions } from '../../../../lib/config/registry.ts';
import { unregisterContributions } from '../../../../lib/contributions/registry.ts';
import { forgetModuleSetup } from '../../../../modules/setup-state.ts';
import { NodeNotFoundError } from '../../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';
import { removePathLine } from './path-line.ts';
import { writeModuleGroups } from '../../../../modules/audience.ts';
import { unlinkModuleFiles } from './module-links.ts';
import { rebuildModulePages } from './module-pages.ts';

/**
 * Reverse the side effects of `mod setup` (bashrc PATH lines, services,
 * pipeline definitions, /var/www symlink) and forget the groups it was kept to. Scans the still-present module
 * directory, mirroring mod-setup. Best-effort: a failure on one effect logs a
 * warning but never aborts removal.
 */
const undoModuleSetup = async (cmd: Command, modulePath: string, manifestName: string): Promise<void> => {
  // This module's bins are about to stop existing, and a memoised `$PATH` resolution may still
  // point at one. The loaded `#!ts` commands go with it, so no removed module's code stays
  // runnable.
  clearCommandLookupCache();
  clearTsCommandCache();

  // The settings it owned. Values already written for them stay in
  // /etc/config: reinstalling the module should find its settings as they were,
  // and a stray export of a name nothing reads costs nothing.
  const removedOptions = unregisterConfigOptions(manifestName);
  if (removedOptions.length > 0 && !cmd.json) {
    await cmd.write(`  Unregistered settings: ${removedOptions.join(', ')}\n`);
  }

  // What it contributed. Its indexes stay: dropping one is DDL on a table that may be
  // large, and an unused index costs only its upkeep, while a reinstall would rebuild it.
  if (unregisterContributions(manifestName) && !cmd.json) await cmd.write(`  Unregistered contributions\n`);
  forgetModuleSetup(manifestName);

  // 1. Take bin/ off PATH, in /etc/bashrc and every group's, and forget the groups it was kept to
  const binPath = join(modulePath, 'bin');
  if (await cmd.sys.vfs.exists(cmd.access, binPath)) await removePathLine(cmd, binPath);
  try {
    await writeModuleGroups(cmd.sys.vfs, manifestName, []);
  } catch (error) {
    await cmd.writeError(`  failed to forget its groups: ${(error as Error).message}\n`);
  }

  // 2. Stop, disable and remove services
  const servicesPath = join(modulePath, 'services');
  if (await cmd.sys.vfs.exists(cmd.access, servicesPath)) {
    const children = await cmd.sys.vfs.children(cmd.access, servicesPath);
    for (const child of children) {
      const serviceName = child.name;
      await cmd.execute(`service stop ${serviceName}`); // ignore: may not be running
      await cmd.execute(`service disable ${serviceName}`); // ignore: may not be enabled
      const res = await cmd.execute(`service remove ${serviceName}`);
      if (res.code === 0) {
        if (!cmd.json) await cmd.write(`  Removed service '${serviceName}'\n`);
      } else {
        await cmd.writeError(`  failed to remove service ${serviceName}: ${res.stderr}`);
      }
      // A single-script service has a wrapper directory under /etc/service-scripts/<name>.
      if (child.node.type !== NODE_TYPE_DIRECTORY) {
        await cmd.execute(`rm -rf ${join(cmd.env.ETC_PATH, 'service-scripts', serviceName)}`);
      }
    }
  }

  // 3. Undefine pipelines
  const pipelinesDir = join(modulePath, 'pipelines');
  if (await cmd.sys.vfs.exists(cmd.access, pipelinesDir)) {
    const children = await cmd.sys.vfs.children(cmd.access, pipelinesDir);
    for (const child of children) {
      if (!child.name.endsWith('.yaml') && !child.name.endsWith('.yml')) continue;
      const yamlPath = join(pipelinesDir, child.name);
      try {
        const handle = await cmd.sys.vfs.open(cmd.access, yamlPath, { mode: 'r' });
        let yamlContent: string;
        try {
          yamlContent = await toText(handle.readable);
        } finally {
          await handle.close();
        }
        const def = parsePipeline(yamlContent);
        const res = await cmd.execute(`pipeline undefine ${def.name}`);
        if (res.code === 0) {
          if (!cmd.json) await cmd.write(`  Undefined pipeline '${def.name}'\n`);
        }
      } catch (err) {
        await cmd.writeError(`  failed to undefine pipeline ${child.name}: ${(err as Error).message}\n`);
      }
    }
  }

  // 4. Remove the /var/www UI symlink
  const uiPath = join(modulePath, 'ui');
  if (await cmd.sys.vfs.exists(cmd.access, uiPath)) {
    const wwwPath = cmd.env.WWW_PATH || WWW_PATH;
    const linkPath = join(wwwPath, manifestName);
    if (await cmd.sys.vfs.exists(ADMIN_ACCESS, linkPath, { follow: false })) {
      try {
        await cmd.sys.vfs.unlink(cmd.access, linkPath, wwwPath, { readlink: true });
        if (!cmd.json) await cmd.write(`  Unlinked UI at ${linkPath}\n`);
      } catch (err) {
        await cmd.writeError(`  failed to unlink UI: ${(err as Error).message}\n`);
      }
    }
  }

  // 5. Remove its navigation entries and its settings
  await unlinkModuleFiles(cmd, manifestName, modulePath);
};

export const modRemove = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['force'],
    alias: { f: 'force' },
  });

  const name = flags._[0] as string;

  if (!name) {
    await cmd.writeError('mod-remove: module name required\n');
    await cmd.writeError('Usage: mod-remove <name> [--force]\n');
    return 1;
  }

  const modulePath = join(cmd.env.MOD_PATH || MOD_PATH, name);

  try {
    const node = await cmd.sys.vfs.get(cmd.access, modulePath);

    if (node.type !== NODE_TYPE_DIRECTORY) {
      await cmd.writeError(`mod-remove: ${name} is not a directory\n`);
      return 1;
    }

    const manifest = await readModJson(cmd.sys.vfs, cmd.access, modulePath);

    if (!manifest) {
      await cmd.writeError(`mod-remove: ${name} is not a module (no mod.json found)\n`);
      return 1;
    }

    if (!flags.force) {
      const answer = await cmd.prompt(`Remove module '${manifest.name}' (${manifest.version})? (y/N) `, undefined, 'add --force');
      if (answer.toLowerCase() !== 'y') {
        if (cmd.json) {
          await cmd.writeJSON({ ok: true, removed: false });
        } else {
          await cmd.write('Cancelled\n');
        }
        return 0;
      }
    }

    const uninstallScriptPath = `${modulePath}/uninstall.sh`;
    try {
      await cmd.sys.vfs.get(cmd.access, uninstallScriptPath);

      if (!cmd.json) await cmd.write('Running uninstall script...\n');

      const res = await cmd.execute(`[ -e ${uninstallScriptPath} ] && ${uninstallScriptPath}`);

      if (res.code === 0) {
        if (!cmd.json) await cmd.writeLn(res.stdout);
      } else {
        throw new Error(res.stderr);
      }

      if (!cmd.json) await cmd.write('Uninstall script completed successfully\n');
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        if (!cmd.json) await cmd.write('No uninstall.sh found, skipping\n');
      } else {
        throw err;
      }
    }

    // While the module directory is still there: it says what setup did.
    await undoModuleSetup(cmd, modulePath, manifest.name);

    // A linked module goes with its link; one `mod install` installed, with its tree too. The
    // deployment's stays where the deployment mounts it, and boot links it again.
    const modulesPath = cmd.env.MOD_PATH || MOD_PATH;
    const link = (await cmd.sys.vfs.get(ADMIN_ACCESS, modulePath, { follow: false })).props.softlink;
    if (typeof link === 'string') {
      await cmd.sys.vfs.unlink(ADMIN_ACCESS, modulePath, modulesPath, { readlink: true });
      const store = cmd.env.MOD_INSTALL_PATH || MOD_INSTALL_PATH;
      if (link === join(store, name)) await cmd.sys.vfs.unlink(ADMIN_ACCESS, link, store, { recursive: true });
    } else {
      await cmd.sys.vfs.unlink(ADMIN_ACCESS, modulePath, modulesPath, { recursive: true });
    }

    await rebuildModulePages(cmd);

    if (cmd.json) {
      await cmd.writeJSON({ ok: true, removed: true });
    } else {
      await cmd.write(`Module '${name}' removed successfully\n`);
    }
    return 0;
  } catch (err) {
    await cmd.writeError(`mod-remove: ${(err as Error).message}\n`);
    return 1;
  }
};

modRemove.spec = {
  name: 'mod-remove',
  admin: true,
  effect: 'write' as const,
  description: 'Uninstall a module',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Module name',
    },
  ],
  flags: [
    { name: 'force', type: 'bool' as const, description: 'Skip confirmation prompt' },
  ],
};
