import { getConfigOption, setRcEntry, validateConfigValue } from '../../../../lib/config/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { editOptionFile, restartConsumers } from './store.ts';
import { isAdmin } from '../../../../lib/access/mod.ts';

export const configSet = async (cmd: Command): CmdReturn => {
  const key = cmd.args[0];
  // Joined rather than [1] alone so an unquoted multi-word value still lands
  // whole; the shell has already split it.
  const value = cmd.args.slice(1).join(' ');

  if (!key) {
    await cmd.writeError('config set: missing setting name\n');
    return 1;
  }

  const option = getConfigOption(key);
  if (!option) {
    await cmd.writeError(`config set: unknown setting '${key}'\n`);
    return 1;
  }

  // The scope is the option's, never the caller's choice: the two files are
  // sourced in a fixed order, so a system key written into a user file would
  // be read by nothing and silently do nothing.
  if (option.scope === 'system' && !isAdmin(cmd.access)) {
    await cmd.writeError(`config set: '${key}' is a system setting and needs administrator rights\n`);
    return 1;
  }

  const invalid = validateConfigValue(option, value);
  if (invalid) {
    await cmd.writeError(`config set: ${invalid}\n`);
    return 1;
  }

  // A secret is never said back: what was typed may be on a screen someone else sees.
  const secret = option.type === 'secret';

  try {
    await editOptionFile(cmd, option, (text) => setRcEntry(text, key, value));

    const { restarted, failed } = await restartConsumers(cmd, option.restarts);

    if (cmd.json) {
      await cmd.writeJSON({ ok: failed.length === 0, key, value: secret ? '' : value, scope: option.scope, restarted, failed, restartNote: option.restartNote });
    } else {
      await cmd.write(secret ? `${key} set\n` : `${key} = ${value}\n`);
      if (restarted.length) await cmd.write(`Restarted: ${restarted.join(', ')}\n`);
      if (option.restartNote) await cmd.write(`${option.restartNote}\n`);
    }

    for (const failure of failed) {
      await cmd.writeError(`config set: failed to restart '${failure.name}': ${failure.error}\n`);
    }

    // The value is written either way; a failed restart is still a failure,
    // since the service runs on the previous setting.
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
  description: 'Change a setting and restart the services that read it only at start',
  args: [
    { name: 'key', type: 'string' as const, description: 'setting name' },
    { name: 'value', type: 'string' as const, description: 'new value' },
  ],
};
