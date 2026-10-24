import { parseArgs } from '../../../../lib/args/mod.ts';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';
import { listCommands, printWords } from './lib/utils.ts';

/**
 * The commands on PATH a command's name completes to: those starting with
 * `--word`, without the subcommands of a group (`pipeline-run`), which are
 * reached as `pipeline run`.
 */
export const completeCommands = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['word'],
  });
  const word = flags.word || '';

  if (word.includes('/') || !cmd.env.PATH) {
    return 0;
  }

  const entries = await listCommands(cmd);
  const groups = entries.filter((e) => (e.node.attrs as { group?: boolean }).group).map((e) => `${e.name}-`);
  const names = entries
    .map((e) => e.name)
    .filter((name) => name.startsWith(word))
    .filter((name) => !groups.some((group) => name.startsWith(group)));

  await printWords(cmd, [...new Set(names)]);

  return 0;
};

completeCommands.spec = {
  name: 'completion-commands',
  effect: 'read' as const,
  json: false,
  description: 'Autocomplete a command name, without the subcommands of groups',
  flags: [
    {
      name: 'word',
      type: 'string' as const,
      description: 'Word to autocomplete',
    },
  ],
};
