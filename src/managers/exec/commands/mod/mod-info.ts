import { join } from '@std/path';
import { mayUseModule, readModuleGroups } from '../../../../modules/audience.ts';
import { MODULE_API_VERSION, type ModuleManifest, readManifests, readModJson } from '../../../../modules/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

/** Installed modules that list `name` as a dependency. */
const dependentsOf = (name: string, manifests: Map<string, ModuleManifest>): string[] =>
  [...manifests.values()]
    .filter((other) => Object.hasOwn(other.dependencies ?? {}, name))
    .map((other) => other.name)
    .sort((a, b) => a.localeCompare(b));

export const modInfo = async (cmd: Command): CmdReturn => {
  const name = cmd.args[0];

  if (!name) {
    await cmd.writeError('mod-info: module name required\n');
    return 1;
  }

  const modulePath = join(cmd.env.MOD_PATH, name);

  try {
    const node = await cmd.sys.vfs.get(cmd.access, modulePath);

    if (node.type !== NODE_TYPE_DIRECTORY) {
      await cmd.writeError(`mod-info: ${name} is not a directory\n`);
      return 1;
    }

    const manifest = await readModJson(cmd.sys.vfs, cmd.access, modulePath);

    if (!manifest || !await mayUseModule(cmd.sys.vfs, cmd.access, manifest.name || name)) {
      await cmd.writeError(`mod-info: ${name} is not a module (no mod.json found)\n`);
      return 1;
    }
    const groups = await readModuleGroups(cmd.sys.vfs, manifest.name || name);

    if (cmd.json) {
      let commands: string[] = [];
      let webUis: string[] = [];
      try {
        const binFiles = await cmd.sys.vfs.children(cmd.access, join(modulePath, 'bin'));
        commands = binFiles.filter((f) => f.node.type === NODE_TYPE_FILE).map((f) => f.name);
      } catch { /* no bin/ */ }
      try {
        const wwwDirs = await cmd.sys.vfs.children(cmd.access, join(modulePath, 'www'));
        webUis = wwwDirs.filter((d) => d.node.type === NODE_TYPE_DIRECTORY).map((d) => d.name);
      } catch { /* no www/ */ }
      const usedBy = dependentsOf(manifest.name, await readManifests(cmd.sys.vfs, cmd.access, cmd.env.MOD_PATH));
      await cmd.writeJSON({ ...manifest, commands, webUis, usedBy, ...(groups.length > 0 ? { groups } : {}) });
      return 0;
    }

    await cmd.write(`Name:        ${manifest.name}\n`);
    await cmd.write(`Version:     ${manifest.version}\n`);

    if (manifest.description) {
      await cmd.write(`Description: ${manifest.description}\n`);
    }
    if (manifest.author) {
      await cmd.write(`Author:      ${manifest.author}\n`);
    }
    if (manifest.license) {
      await cmd.write(`License:     ${manifest.license}\n`);
    }
    await cmd.write(`Core API:    ${manifest.coreApi ?? `(undeclared, assumed ${MODULE_API_VERSION})`}\n`);
    await cmd.write(`For:         ${groups.length > 0 ? groups.join(', ') : 'everyone'}\n`);

    const deps = Object.entries(manifest.dependencies ?? {});
    if (deps.length > 0) {
      await cmd.write(`\nRequires modules:\n`);
      for (const [depName, range] of deps) {
        const depManifest = await readModJson(cmd.sys.vfs, cmd.access, join(cmd.env.MOD_PATH, depName));
        const state = depManifest ? `installed ${depManifest.version}` : 'NOT INSTALLED';
        await cmd.write(`  ${depName} ${range} (${state})\n`);
      }
    }

    // The public interface: what another module may import, and under which specifier.
    const exported = Object.entries(manifest.exports ?? {});
    if (exported.length > 0) {
      await cmd.write(`\nExports:\n`);
      for (const [key, target] of exported) {
        await cmd.write(`  @${manifest.name}/${key.slice(2)} -> ${target}\n`);
      }
    }

    const usedBy = dependentsOf(manifest.name, await readManifests(cmd.sys.vfs, cmd.access, cmd.env.MOD_PATH));
    if (usedBy.length > 0) {
      await cmd.write(`\nUsed by:     ${usedBy.join(', ')}\n`);
    }

    let hasBin = false;

    try {
      const binFiles = await cmd.sys.vfs.children(cmd.access, join(modulePath, 'bin'));
      const binNames = binFiles.filter((f) => f.node.type === NODE_TYPE_FILE).map((f) => f.name);
      if (binNames.length > 0) {
        hasBin = true;
        await cmd.write(`\nProvides:\n`);
        await cmd.write(`  Commands:  ${binNames.join(', ')}\n`);
      }
    } catch {
      // No bin/
    }

    try {
      const wwwDirs = await cmd.sys.vfs.children(cmd.access, join(modulePath, 'www'));
      const wwwNames = wwwDirs.filter((d) => d.node.type === NODE_TYPE_DIRECTORY).map((d) => d.name);
      if (wwwNames.length > 0) {
        if (!hasBin) await cmd.write(`\nProvides:\n`);
        await cmd.write(`  Web UIs:   ${wwwNames.join(', ')}\n`);
      }
    } catch {
      // No www/
    }

    return 0;
  } catch (err) {
    await cmd.writeError(`mod-info: ${(err as Error).message}\n`);
    return 1;
  }
};

modInfo.spec = {
  name: 'mod-info',
  effect: 'read' as const,
  description: 'Show module information',
  args: [
    { name: 'name', type: 'string' as const, description: 'Module name' },
  ],
};
