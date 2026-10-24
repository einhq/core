import { join } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { readModJson } from '../../../../modules/mod.ts';
import { moduleSetupOf } from '../../../../modules/setup-state.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';
import type { ModuleEntry } from '../../../../lib/api/mod.ts';

/** The names in a module's directory, of one node type or any; none when it has no such directory. */
const namesIn = async (cmd: Command, path: string, type?: string): Promise<string[]> => {
  try {
    const children = await cmd.sys.vfs.children(cmd.access, path);
    return children.filter((child) => !type || child.node.type === type).map((child) => child.name).sort();
  } catch {
    return [];
  }
};

export const modList = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['long'],
    alias: { l: 'long' },
  });

  try {
    const children = await cmd.sys.vfs.children(cmd.access, cmd.env.MOD_PATH);

    // A module is a directory, or a link to one: on a host running dev modules every module is a
    // softlink into the mounted checkout. A link with no mod.json behind it is skipped below.
    const directories = children.filter((n) => n.node.type === NODE_TYPE_DIRECTORY || n.node.type === NODE_TYPE_SOFTLINK);

    if (cmd.json) {
      const modules: ModuleEntry[] = [];
      for (const dir of directories) {
        const modulePath = join(cmd.env.MOD_PATH, dir.name);
        const manifest = await readModJson(cmd.sys.vfs, cmd.access, modulePath);
        if (!manifest) continue;
        const name = manifest.name || dir.name;
        modules.push({
          name,
          version: manifest.version || null,
          description: manifest.description,
          ...(manifest.coreApi ? { coreApi: manifest.coreApi } : {}),
          dependencies: manifest.dependencies ?? {},
          path: modulePath,
          commands: await namesIn(cmd, join(modulePath, 'bin'), NODE_TYPE_FILE),
          webUis: await namesIn(cmd, join(modulePath, 'www'), NODE_TYPE_DIRECTORY),
          // `mod setup` registers each entry of services/ under its own name.
          services: await namesIn(cmd, join(modulePath, 'services')),
          routes: Object.keys(manifest.ui?.routes ?? {}).sort(),
          setup: moduleSetupOf(name),
        });
      }
      await cmd.writeJSON(modules);
      return 0;
    }

    if (directories.length === 0) {
      await cmd.write('No modules installed\n');
      return 0;
    }

    let foundModules = 0;

    for (const dir of directories) {
      const modulePath = join(cmd.env.MOD_PATH, dir.name);
      const manifest = await readModJson(cmd.sys.vfs, cmd.access, modulePath);

      if (!manifest) {
        continue;
      }

      foundModules++;
      const name = manifest.name || dir.name;
      const version = manifest.version || 'N/A';

      // Installed is not the same as working: boot carries on past a module whose setup failed.
      const setup = moduleSetupOf(name);
      const state = !setup ? ' [not set up]' : setup.ok ? '' : ' [setup failed]';

      if (flags.long) {
        await cmd.write(`${name} (${version})${state}\n`);
        if (manifest.description) {
          await cmd.write(`  ${manifest.description}\n`);
        }
        for (const problem of setup?.problems ?? []) {
          await cmd.write(`  Problem: ${problem}\n`);
        }
        await cmd.write(`  Path: ${modulePath}\n`);

        const lines: [string, string[]][] = [
          ['Commands', await namesIn(cmd, join(modulePath, 'bin'), NODE_TYPE_FILE)],
          ['Services', await namesIn(cmd, join(modulePath, 'services'))],
          ['Web UIs', await namesIn(cmd, join(modulePath, 'www'), NODE_TYPE_DIRECTORY)],
        ];
        for (const [label, names] of lines) {
          if (names.length > 0) await cmd.write(`  ${label}: ${names.join(', ')}\n`);
        }

        await cmd.write('\n');
      } else {
        await cmd.write(`${name} (${version})${state}\n`);
      }
    }

    if (foundModules === 0) {
      await cmd.write('No modules installed\n');
    }

    return 0;
  } catch (err) {
    await cmd.writeError(`mod-list: ${(err as Error).message}\n`);
    return 1;
  }
};

modList.spec = {
  name: 'mod-list',
  effect: 'read' as const,
  description: 'List installed modules',
  flags: [
    { name: 'long', type: 'bool' as const, description: 'Show detailed information' },
  ],
};
