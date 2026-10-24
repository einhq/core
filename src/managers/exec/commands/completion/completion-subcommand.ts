import { parseArgs } from '../../../../lib/args/mod.ts';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';
import { listCommands, printWords } from './lib/utils.ts';

export const completeSubcommand = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['word'],
  });
  const command = flags._[0] as string;
  const word = flags.word || '';

  if (!command) {
    await cmd.writeError('completion-subcommand: missing command argument');
    return 1;
  }

  if (word === '.' || word.includes('/') || !cmd.env.PATH) {
    return 0;
  }

  const entries = await listCommands(cmd);

  if (!entries.some((e) => e.name === command)) {
    await cmd.writeError('completion-subcommand: command does not match a known command');
    return 1;
  }

  const completions = entries
    .map((e) => e.name)
    .filter((name) => name.startsWith(`${command}-`))
    .map((name) => name.replace(`${command}-`, ''))
    .filter((name) => !name.startsWith('_'))
    .filter((name) => !word || name.startsWith(word));

  await printWords(cmd, completions);

  return 0;
};

completeSubcommand.spec = {
  name: 'completion-subcommand',
  effect: 'read' as const,
  json: false,
  description: 'Autocomplete a command',
  args: [
    {
      name: 'command',
      type: 'command' as const,
      description: 'Command to which the subcommand belongs',
    },
  ],
  flags: [
    {
      name: 'word',
      type: 'string' as const,
      description: 'Word to autocomplete',
    },
  ],
};
