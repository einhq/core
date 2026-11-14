import { setRcEntry, validateConfigValue } from '../../../../lib/config/mod.ts';
import type { ConfigWriteAnswer } from '../../../../lib/api/config.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { resolveEntries, shownValue, writableOptions, writeOptions } from './store.ts';

/**
 * The settings a call names, as key and value: `KEY=VALUE` for each of several, or `KEY VALUE`
 * for one, whose words are joined so an unquoted value of several lands whole (the shell has
 * already split it). Undefined when a `KEY=VALUE` call has a word without `=`.
 */
const namedValues = (args: string[]): [string, string][] | undefined => {
  const first = args[0] ?? '';
  if (first.indexOf('=') <= 0) return first ? [[first, args.slice(1).join(' ')]] : [];
  const pairs: [string, string][] = [];
  for (const arg of args) {
    const equals = arg.indexOf('=');
    if (equals <= 0) return undefined;
    pairs.push([arg.slice(0, equals), arg.slice(equals + 1)]);
  }
  return pairs;
};

export const configSet = async (cmd: Command): CmdReturn => {
  const values = namedValues(cmd.args);
  if (!values) {
    await cmd.writeError('config set: several settings are given as KEY=VALUE each\n');
    return 1;
  }
  if (values.length === 0) {
    await cmd.writeError('config set: missing setting name\n');
    return 1;
  }

  const options = writableOptions(cmd, values.map(([key]) => key), 'config set');
  if (typeof options === 'string') {
    await cmd.writeError(`${options}\n`);
    return 1;
  }
  for (const [index, option] of options.entries()) {
    const invalid = validateConfigValue(option, values[index][1]);
    if (invalid) {
      await cmd.writeError(`config set: ${invalid}\n`);
      return 1;
    }
  }

  try {
    const { restarted, failed, notes } = await writeOptions(cmd, options.map((option, index) => ({ option, edit: (text) => setRcEntry(text, option.key, values[index][1]) })));
    const entries = await resolveEntries(cmd);
    // A key is never said back: what was typed may be on a screen someone else sees.
    const settings = options.map((option) => entries.find((entry) => entry.key === option.key)!);

    if (cmd.json) {
      await cmd.writeJSON(
        {
          ok: failed.length === 0,
          settings: settings.map(({ key, value, scope, source }) => ({ key, value, scope, source })),
          restarted,
          failed,
          notes,
        } satisfies ConfigWriteAnswer,
      );
    } else {
      for (const entry of settings) await cmd.write(entry.type === 'secret' ? `${entry.key} set\n` : `${entry.key} = ${shownValue(entry)}\n`);
      if (restarted.length) await cmd.write(`Restarted: ${restarted.join(', ')}\n`);
      for (const note of notes) await cmd.write(`${note}\n`);
    }

    for (const failure of failed) {
      await cmd.writeError(`config set: failed to restart '${failure.name}': ${failure.error}\n`);
    }

    // The values are written either way; a failed restart is still a failure,
    // since the service runs on the previous settings.
    return failed.length ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`config set: ${message}\n`);
    return 1;
  }
};

configSet.spec = {
  name: 'config-set',
  effect: 'write' as const,
  description: 'Change a setting, or several at once, and restart the services that read them only at start',
  examples: ['config set CFG_TRASH_RETENTION_DAYS 60', 'config set CFG_LANGUAGE=sv CFG_TIME_LOCALE=sv-SE'],
  args: [
    { name: 'key', type: 'string' as const, description: 'setting name, or KEY=VALUE for each of several settings' },
    { name: 'value', type: 'string' as const, description: 'new value, after a setting name alone', variadic: true, optional: true },
  ],
  returns: 'settings (each key with the value in force, its scope and source; a key comes back empty), restarted, failed, notes',
};
