import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { listCommands } from '../../../../lib/commands/catalogue.ts';
import type { ListedCommand } from '../../../../lib/api/docs.ts';

/**
 * Every command on the caller's PATH with its whole spec: the documentation's command reference.
 * Read from the command catalogue at each call, so a module installed a minute ago is in it and
 * one removed is not.
 */
export const docsCommands = async (cmd: Command): CmdReturn => {
  const commands = (await listCommands(cmd)) satisfies ListedCommand[];
  if (cmd.json) {
    await cmd.writeJSON(commands);
    return 0;
  }
  for (const entry of commands) {
    await cmd.writeLn(`${entry.name.padEnd(24)} ${entry.module.padEnd(10)} ${entry.spec.description ?? ''}`);
  }
  return 0;
};

docsCommands.spec = {
  name: 'docs-commands',
  effect: 'read' as const,
  description: 'List every command on your PATH with its full spec and the module it comes from',
  args: [],
  flags: [],
  examples: ['docs commands'],
  returns: 'One entry per command: name, module (core or the module whose bin it is) and its whole spec.',
};
