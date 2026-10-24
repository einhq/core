import { parseArgs } from '../../../../lib/args/mod.ts';
import { parseSelector } from './lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const poolRetry = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['job', 'key', 'prefix', 'kind'],
    alias: { j: 'job', k: 'key', p: 'prefix' },
  });

  const path = flags._[0] as string | undefined;

  if (!path) {
    await cmd.writeError('pool-retry: missing pool path\n');
    return 1;
  }

  try {
    const count = await cmd.sys.vfs.poolRetry(cmd.access, path, parseSelector(flags));

    if (cmd.json) {
      await cmd.writeJSON({ ok: true, count });
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pool-retry: ${message}\n`);
    return 1;
  }
};

poolRetry.spec = {
  name: 'pool-retry',
  admin: true,
  effect: 'write' as const,
  description: 'Return failed or cancelled jobs to the pool with a clean attempt count',
  args: [
    { name: 'path', type: 'path' as const, description: 'Pool node path' },
  ],
  flags: [
    { name: 'job', type: 'string' as const, description: 'Retry one job by id' },
    { name: 'key', type: 'string' as const, description: 'Retry the job with this dedup key' },
    { name: 'prefix', type: 'string' as const, description: 'Retry every job whose dedup key starts with this' },
    { name: 'kind', type: 'string' as const, description: 'Retry every job of this kind' },
  ],
};
