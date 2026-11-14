import { unsetRcEntry } from '../../../../lib/config/mod.ts';
import type { ConfigWriteAnswer } from '../../../../lib/api/config.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { resolveEntries, shownValue, writableOptions, writeOptions } from './store.ts';

export const configUnset = async (cmd: Command): CmdReturn => {
  if (cmd.args.length === 0) {
    await cmd.writeError('config unset: missing setting name\n');
    return 1;
  }

  const options = writableOptions(cmd, cmd.args, 'config unset');
  if (typeof options === 'string') {
    await cmd.writeError(`${options}\n`);
    return 1;
  }

  try {
    const { restarted, failed, notes } = await writeOptions(cmd, options.map((option) => ({ option, edit: (text) => unsetRcEntry(text, option.key) })));

    // What each falls back *to*, not what the table says: on a host whose
    // container supplies the value, clearing a setting lands on the
    // deployment's number and reporting the compiled default would be a lie.
    const entries = await resolveEntries(cmd);
    const fallbacks = options.map((option) => entries.find((entry) => entry.key === option.key)!);

    if (cmd.json) {
      await cmd.writeJSON(
        {
          ok: failed.length === 0,
          settings: fallbacks.map(({ key, value, scope, source }) => ({ key, value, scope, source })),
          restarted,
          failed,
          notes,
        } satisfies ConfigWriteAnswer,
      );
    } else {
      for (const fallback of fallbacks) await cmd.write(`${fallback.key} reset to ${shownValue(fallback) || '(empty)'} (${fallback.source})\n`);
      if (restarted.length) await cmd.write(`Restarted: ${restarted.join(', ')}\n`);
      for (const note of notes) await cmd.write(`${note}\n`);
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
  description: 'Reset settings to what the deployment or the default says',
  examples: ['config unset CFG_TRASH_RETENTION_DAYS', 'config unset CFG_LLM_URL CFG_LLM_MODEL CFG_LLM_KEY CFG_LLM_PROVIDER'],
  args: [
    { name: 'key', type: 'string' as const, description: 'setting name', variadic: true },
  ],
  returns: 'settings (each key with the value it falls back to, its scope and source), restarted, failed, notes',
};
