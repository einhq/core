import { parseArgs } from '../../../../lib/args/mod.ts';
import { parseDuration, parseStates } from './lib.ts';
import type { PoolJobState } from '../../../../registries/pool/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const TERMINAL: PoolJobState[] = ['done', 'failed', 'cancelled'];

export const poolPurge = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['state', 'older-than'],
    alias: { s: 'state' },
  });

  const path = flags._[0] as string | undefined;

  if (!path) {
    await cmd.writeError('pool-purge: missing pool path\n');
    return 1;
  }

  try {
    const states = parseStates(flags.state, '--state');

    for (const state of states ?? []) {
      if (!TERMINAL.includes(state)) {
        throw new Error(`cannot purge '${state}' jobs (only ${TERMINAL.join(', ')})`);
      }
    }

    const count = await cmd.sys.vfs.poolPurge(cmd.access, path, {
      state: states,
      olderThanMs: parseDuration(flags['older-than'], '--older-than'),
    });

    if (cmd.json) {
      await cmd.writeJSON({ ok: true, count });
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pool-purge: ${message}\n`);
    return 1;
  }
};

poolPurge.spec = {
  name: 'pool-purge',
  admin: true,
  effect: 'write' as const,
  description: 'Delete finished jobs so a pool does not grow without bound',
  args: [
    { name: 'path', type: 'path' as const, description: 'Pool node path' },
  ],
  flags: [
    { name: 'state', type: 'string' as const, description: `States to drop (default ${TERMINAL.join(',')})` },
    { name: 'older-than', type: 'string' as const, description: 'Only drop jobs finished longer ago than this (e.g. 7d)' },
  ],
};
