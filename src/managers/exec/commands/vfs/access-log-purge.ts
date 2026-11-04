import { parseArgs } from '../../../../lib/args/mod.ts';
import { parseDuration } from '../pool/lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const accessLogPurge = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['older-than'] });

  try {
    const olderThanMs = parseDuration(flags['older-than'], '--older-than');
    if (olderThanMs === undefined) throw new Error('missing --older-than');

    const count = await cmd.sys.vfs.accessLogPurge(cmd.access, { before: Date.now() - olderThanMs });

    if (cmd.json) await cmd.writeJSON({ ok: true, count });
    else await cmd.write(`removed ${count} access-log records\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmd.json) await cmd.writeJSON({ error: `access-log-purge: ${message}` });
    else await cmd.writeError(`access-log-purge: ${message}\n`);
    return 1;
  }
};

accessLogPurge.spec = {
  name: 'access-log-purge',
  admin: true,
  effect: 'write' as const,
  description: 'Remove access-log records older than a given age, so the access log does not grow without bound (administrators only)',
  flags: [
    { name: 'older-than', type: 'string' as const, description: 'remove the records written longer ago than this, e.g. 90d' },
  ],
  examples: [
    'access-log-purge --older-than 90d',
  ],
};
