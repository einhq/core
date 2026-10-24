/**
 * pool-wake — end the rests of kinds this process's pool workers stopped claiming, so they are
 * tried again now rather than when the rest runs out.
 *
 * A kind rests after a step of it could not run: its service could not do it yet. Whoever knows
 * the cause has passed — the service restarted — wakes them.
 */

import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import type { PoolWakeAnswer } from '../../../../lib/api/system.ts';
import { endRests } from '../../../pipeline/pool-worker.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const poolWake = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const kinds = (flags._ as string[]).filter(Boolean);

  const woken = endRests({ kinds: kinds.length > 0 ? kinds : undefined });

  if (cmd.json) {
    await cmd.writeJSON({ ok: true, woken } satisfies PoolWakeAnswer);
    return 0;
  }
  if (woken.length === 0) await cmd.writeLn('nothing resting');
  for (const { pool, kind } of woken) await cmd.writeLn(`${kind} (${pool})`);
  return 0;
};

poolWake.spec = {
  name: 'pool-wake',
  admin: true,
  effect: 'write' as const,
  description: 'Try resting job kinds again now, every resting kind without a name',
  args: [
    { name: 'kind', type: 'string' as const, description: 'Job kind to wake (repeatable)', optional: true, variadic: true },
  ],
};
