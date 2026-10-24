import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { LogHandle } from '../../../../registries/log/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * Append a single JSON entry to a log node, optionally at an explicit timestamp.
 *
 *   log-append <log-path> --data '{"value":42}' [--at 2018-01-01T00:00:00Z]
 *
 * `--at` backdates the entry, for a historical series or a baseline at timestamp 0.
 * Without it the entry is stamped with the current time.
 */
export const logAppend = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['data', 'at'] });
  const target = flags._[0] as string | undefined;
  const raw = flags.data ?? (flags._[1] as string | undefined);

  if (!target) {
    await cmd.writeError('log-append: missing log path\n');
    return 1;
  }
  if (raw === undefined) {
    await cmd.writeError('log-append: missing --data\n');
    return 1;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    await cmd.writeError(`log-append: --data is not valid JSON: ${raw}\n`);
    return 1;
  }

  let createdAt: Date | undefined;
  if (flags.at !== undefined) {
    const ts = new Date(flags.at);
    if (Number.isNaN(ts.getTime())) {
      await cmd.writeError(`log-append: invalid --at timestamp: ${flags.at}\n`);
      return 1;
    }
    createdAt = ts;
  }

  const path = resolve(cmd.cwd, target);
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'a' });
  try {
    if (!(handle instanceof LogHandle)) {
      await cmd.writeError(`log-append: ${path}: not a log\n`);
      return 1;
    }
    const id = await handle.appendAt(data, createdAt);
    if (cmd.json) await cmd.writeJSON({ id });
  } catch (error) {
    await cmd.writeError(`log-append: ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await handle.close();
  }
  return 0;
};

logAppend.spec = {
  name: 'log-append',
  effect: 'write' as const,
  description: 'Append a JSON entry to a log, optionally at an explicit (backdated) timestamp',
  args: [
    { name: 'log', type: 'path' as const, description: 'VFS path to the log node' },
    { name: 'data', type: 'string' as const, description: 'JSON entry (alternative to --data)' },
  ],
  flags: [
    { name: 'data', type: 'string' as const, description: 'JSON payload for the entry' },
    { name: 'at', type: 'string' as const, description: 'ISO timestamp to backdate the entry to' },
  ],
};
