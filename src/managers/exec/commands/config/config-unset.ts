import { getConfigOption, unsetRcEntry } from '../../../../lib/config/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { editOptionFile, resolveEntries, restartConsumers, shownValue } from './store.ts';
import { isAdmin } from '../../../../lib/access/mod.ts';

export const configUnset = async (cmd: Command): CmdReturn => {
  const key = cmd.args[0];

  if (!key) {
    await cmd.writeError('config unset: missing setting name\n');
    return 1;
  }

  const option = getConfigOption(key);
  if (!option) {
    await cmd.writeError(`config unset: unknown setting '${key}'\n`);
    return 1;
  }

  if (option.scope === 'system' && !isAdmin(cmd.access)) {
    await cmd.writeError(`config unset: '${key}' is a system setting and needs administrator rights\n`);
    return 1;
  }

  try {
    await editOptionFile(cmd, option, (text) => unsetRcEntry(text, key));

    // What it falls back *to*, not what the table says: on a host whose
    // container supplies the value, clearing a setting lands on the
    // deployment's number and reporting the compiled default would be a lie.
    const fallback = (await resolveEntries(cmd)).find((entry) => entry.key === key)!;

    const { restarted, failed } = await restartConsumers(cmd, option.restarts);

    if (cmd.json) {
      await cmd.writeJSON({
        ok: failed.length === 0,
        key,
        value: fallback.value,
        source: fallback.source,
        scope: option.scope,
        restarted,
        failed,
        restartNote: option.restartNote,
      });
    } else {
      await cmd.write(`${key} reset to ${shownValue(fallback) || '(empty)'} (${fallback.source})\n`);
      if (restarted.length) await cmd.write(`Restarted: ${restarted.join(', ')}\n`);
      if (option.restartNote) await cmd.write(`${option.restartNote}\n`);
    }

    for (const failure of failed) {
      await cmd.writeError(`config unset: failed to restart '${failure.name}': ${failure.error}\n`);
    }

    return failed.length ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`config unset: ${message}\n`);
    return 1;
  }
};

configUnset.spec = {
  name: 'config-unset',
  effect: 'write' as const,
  description: 'Reset a setting to its default',
  args: [
    { name: 'key', type: 'string' as const, description: 'setting name' },
  ],
};
