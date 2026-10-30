import { join } from '@std/path';
import type { ModuleGroups } from '../../../../lib/api/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { groupGid } from '../../../../lib/auth/member-gids.ts';
import { readModuleGroups, writeModuleGroups } from '../../../../modules/audience.ts';
import { readManifests, readModJson } from '../../../../modules/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { setupOne } from './mod-setup.ts';
import { rebuildModulePages } from './module-pages.ts';

const USAGE = 'usage: mod groups <name> [<group>...] [--everyone]\n';

/**
 * Say which groups a module is kept to, or keep it to others, or make it everyone's again. A
 * module kept to groups is on its members' PATH, in their navigation and pages, and its commands
 * are refused to anyone else; an administrator is given every module. Setting it up again moves
 * its PATH line and navigation to where they now belong.
 */
export const modGroups = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['everyone'] });
  const [name, ...groups] = flags._.map(String);
  if (!name) {
    await cmd.writeError(`mod groups: name a module\n${USAGE}`);
    return 1;
  }
  if (!await readModJson(cmd.sys.vfs, cmd.access, join(cmd.env.MOD_PATH, name))) {
    await cmd.writeError(`mod groups: no module ${name}\n`);
    return 1;
  }
  if (flags.everyone && groups.length > 0) {
    await cmd.writeError(`mod groups: --everyone or groups, not both\n${USAGE}`);
    return 1;
  }

  if (!flags.everyone && groups.length === 0) {
    const kept = await readModuleGroups(cmd.sys.vfs, name);
    if (cmd.json) await cmd.writeJSON({ name, groups: kept } satisfies ModuleGroups);
    else await cmd.writeLn(kept.length > 0 ? kept.join('\n') : 'everyone');
    return 0;
  }

  for (const group of groups) {
    if (await groupGid(cmd.sys.vfs, group) === undefined) {
      await cmd.writeError(`mod groups: no group ${group}\n`);
      return 1;
    }
  }
  await writeModuleGroups(cmd.sys.vfs, name, groups);

  // What depends on it and is everyone's calls it for people it is now refused to.
  if (groups.length > 0) {
    const dependents: string[] = [];
    for (const [other, manifest] of await readManifests(cmd.sys.vfs, cmd.access, cmd.env.MOD_PATH)) {
      if (Object.hasOwn(manifest.dependencies ?? {}, name) && (await readModuleGroups(cmd.sys.vfs, other)).length === 0) dependents.push(other);
    }
    if (dependents.length > 0) {
      const one = dependents.length === 1;
      await cmd.writeError(
        `mod groups: ${dependents.sort().join(', ')} ${one ? 'depends' : 'depend'} on ${name} and ${one ? 'is' : 'are'} everyone's: what ${
          one ? 'it runs' : 'they run'
        } of ${name} fails for anyone outside ${groups.join(', ')}\n`,
      );
    }
  }

  const code = await setupOne(cmd, name);
  await rebuildModulePages(cmd);
  if (code !== 0) {
    await cmd.writeError(`mod groups: ${name}: its setup failed (mod list --long says why)\n`);
    return 1;
  }
  if (cmd.json) await cmd.writeJSON({ name, groups } satisfies ModuleGroups);
  return 0;
};

modGroups.spec = {
  name: 'mod-groups',
  admin: true,
  effect: 'read' as const,
  description: "Say which groups a module is kept to, or keep it to some groups, or make it everyone's again",
  examples: ['mod groups archive', 'mod groups archive family friends', 'mod groups archive --everyone'],
  returns: "The module and the groups it is kept to, none when it is everyone's",
  args: [
    { name: 'name', type: 'string' as const, description: 'The module' },
    {
      name: 'group',
      writes: true,
      type: 'string' as const,
      variadic: true,
      description: 'Keep it to these groups: on their PATH and in their navigation alone, its commands refused to anyone else',
    },
  ],
  flags: [
    { name: 'everyone', writes: true, type: 'bool' as const, description: "Make it everyone's again" },
  ],
};
