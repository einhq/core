import { parseArgs } from '../../../../lib/args/mod.ts';
import { parseSelector } from './lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const poolCancel = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['job', 'key', 'prefix', 'kind'],
    alias: { j: 'job', k: 'key', p: 'prefix' },
  });

  const path = flags._[0] as string | undefined;

  if (!path) {
    await cmd.writeError('pool-cancel: missing pool path\n');
    return 1;
  }

  try {
    const count = await cmd.sys.vfs.poolCancel(cmd.access, path, parseSelector(flags));

    if (cmd.json) {
      await cmd.writeJSON({ ok: true, count });
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pool-cancel: ${message}\n`);
    return 1;
  }
};

poolCancel.spec = {
  name: 'pool-cancel',
  admin: true,
  effect: 'write' as const,
  description: 'Cancel pending or claimed jobs',
  args: [
    { name: 'path', type: 'path' as const, description: 'Pool node path' },
  ],
  flags: [
    { name: 'job', type: 'string' as const, description: 'Cancel one job by id' },
    { name: 'key', type: 'string' as const, description: 'Cancel the job with this dedup key' },
    { name: 'prefix', type: 'string' as const, description: 'Cancel every job whose dedup key starts with this' },
    { name: 'kind', type: 'string' as const, description: 'Cancel every job of this kind' },
  ],
};
