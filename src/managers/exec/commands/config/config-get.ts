import { getConfigOption } from '../../../../lib/config/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { resolveEntries, shownValue } from './store.ts';

export const configGet = async (cmd: Command): CmdReturn => {
  const key = cmd.args[0];

  if (!key) {
    await cmd.writeError('config get: missing setting name\n');
    return 1;
  }

  if (!getConfigOption(key)) {
    await cmd.writeError(`config get: unknown setting '${key}'\n`);
    return 1;
  }

  try {
    const entry = (await resolveEntries(cmd)).find((candidate) => candidate.key === key)!;

    if (cmd.json) {
      await cmd.writeJSON(entry);
    } else {
      await cmd.write(`${shownValue(entry)}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`config get: ${message}\n`);
    return 1;
  }
};

configGet.spec = {
  name: 'config-get',
  effect: 'read' as const,
  description: 'Print the effective value of one setting; for a key, only whether it is set',
  args: [
    {
      name: 'key',
      type: 'string' as const,
      description: 'setting name',
    },
  ],
};
