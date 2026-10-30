import { parseArgs } from '../../../../lib/args/mod.ts';
import { mayUseModule } from '../../../../modules/audience.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { resolveEntries, shownValue } from './store.ts';

export const configList = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['scope'] });
  const scope = flags.scope;

  if (scope && scope !== 'system' && scope !== 'user') {
    await cmd.writeError(`config list: unknown scope '${scope}', expected 'system' or 'user'\n`);
    return 1;
  }

  try {
    const entries = [];
    for (const entry of await resolveEntries(cmd)) {
      if (scope && entry.scope !== scope) continue;
      // A module kept to groups the caller is in none of has no settings for them.
      if (entry.owner && !await mayUseModule(cmd.sys.vfs, cmd.access, entry.owner)) continue;
      entries.push(entry);
    }

    if (cmd.json) {
      await cmd.writeJSON(entries);
    } else {
      for (const entry of entries) {
        // The source is the interesting column: it is the difference between a
        // value someone chose and one nobody has ever looked at.
        const marker = entry.source === 'default' ? '' : ` (${entry.source === 'module' && entry.sourceModule ? `module ${entry.sourceModule}` : entry.source})`;
        await cmd.write(`${entry.key}\t${shownValue(entry)}${marker}\n`);
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`config list: ${message}\n`);
    return 1;
  }
};

configList.spec = {
  name: 'config-list',
  guest: true,
  effect: 'read' as const,
  description: 'List settings with their effective values',
  args: [],
  flags: [
    {
      name: 'scope',
      type: 'string' as const,
      description: "limit to 'system' or 'user' settings",
    },
  ],
};
