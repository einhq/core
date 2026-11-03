import { parseArgs } from '../../../../lib/args/mod.ts';
import { parseDuration } from '../pool/lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const auditPurge = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['older-than'],
    boolean: ['pipeline'],
  });

  try {
    const olderThanMs = parseDuration(flags['older-than'], '--older-than');
    if (olderThanMs === undefined) throw new Error('missing --older-than');

    const count = await cmd.sys.vfs.auditPurge(cmd.access, { before: Date.now() - olderThanMs, pipeline: flags.pipeline });

    if (cmd.json) await cmd.writeJSON({ ok: true, count });
    else await cmd.write(`removed ${count} audit records\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmd.json) await cmd.writeJSON({ error: `audit-purge: ${message}` });
    else await cmd.writeError(`audit-purge: ${message}\n`);
    return 1;
  }
};

auditPurge.spec = {
  name: 'audit-purge',
  admin: true,
  effect: 'write' as const,
  description: 'Remove audit records older than a given age, so the audit trail does not grow without bound (administrators only)',
  flags: [
    { name: 'older-than', type: 'string' as const, description: 'remove the records written longer ago than this, e.g. 14d' },
    { name: 'pipeline', type: 'bool' as const, description: "only the records of pipeline runs' writes" },
  ],
  examples: [
    'audit-purge --older-than 14d --pipeline',
    'audit-purge --older-than 365d',
  ],
};
