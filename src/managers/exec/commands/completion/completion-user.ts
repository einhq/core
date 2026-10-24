import { parseArgs } from '../../../../lib/args/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';
import { printWords } from './lib/utils.ts';

export const completeUser = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['word'],
  });
  const word = flags.word || '';

  try {
    const entries = await cmd.sys.vfs.children(ADMIN_ACCESS, cmd.env.USERS_PATH);
    await printWords(cmd, entries.map((e) => e.name).filter((name) => name.startsWith(word)));
  } catch {
    // No completions.
  }

  return 0;
};

completeUser.spec = {
  name: 'completion-user',
  effect: 'read' as const,
  json: false,
  description: 'Autocomplete a user',
  flags: [
    {
      name: 'word',
      type: 'string' as const,
      description: 'Word to autocomplete',
    },
  ],
};
