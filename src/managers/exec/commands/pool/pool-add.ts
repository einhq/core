import { parseArgs } from '../../../../lib/args/mod.ts';
import { parseDuration, parseVector } from './lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const poolAdd = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['kind', 'priority', 'requires', 'params', 'key', 'exclusive', 'attempts', 'delay'],
    collect: ['requires'],
    alias: { k: 'kind', p: 'priority', r: 'requires', e: 'exclusive', n: 'attempts' },
  });

  const path = flags._[0] as string | undefined;

  if (!path) {
    await cmd.writeError('pool-add: missing pool path\n');
    return 1;
  }

  try {
    if (!flags.kind) {
      throw new Error('missing --kind');
    }

    const job = await cmd.sys.vfs.poolAdd(cmd.access, path, {
      kind: flags.kind,
      priority: flags.priority === undefined ? undefined : Number(flags.priority),
      requires: parseVector(flags.requires, 'requires'),
      params: flags.params === undefined ? undefined : JSON.parse(flags.params),
      dedupKey: flags.key,
      exclusive: flags.exclusive,
      maxAttempts: flags.attempts === undefined ? undefined : Number(flags.attempts),
      delayMs: parseDuration(flags.delay, '--delay'),
    });

    if (cmd.json) {
      await cmd.writeJSON({ ok: true, id: job.id });
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pool-add: ${message}\n`);
    return 1;
  }
};

poolAdd.spec = {
  name: 'pool-add',
  admin: true,
  effect: 'write' as const,
  description: 'Add a job to a pool',
  args: [
    { name: 'path', type: 'path' as const, description: 'Pool node path' },
  ],
  flags: [
    { name: 'kind', type: 'string' as const, description: 'Capability class the job needs (required)' },
    { name: 'priority', type: 'string' as const, description: 'Higher runs first (default 0)' },
    { name: 'requires', type: 'string' as const, description: 'Resource vector, key=number (repeatable or comma-separated)' },
    { name: 'params', type: 'string' as const, description: 'JSON payload handed to the worker' },
    { name: 'key', type: 'string' as const, description: 'Dedup key; re-adding a live one updates it instead of duplicating' },
    { name: 'exclusive', type: 'string' as const, description: 'Mutex class; one claimed job per class at a time' },
    { name: 'attempts', type: 'string' as const, description: 'Attempts before the job fails' },
    { name: 'delay', type: 'string' as const, description: 'Hold the job back this long (e.g. 30s, 5m)' },
  ],
};
