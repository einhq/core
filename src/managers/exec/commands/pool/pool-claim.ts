/**
 * pool-claim — take one job under a lease.
 *
 * Mostly for debugging and for shell-script workers. A claim from an
 * interactive shell holds the job for the whole lease: nothing renews it once
 * the command exits, so it stays invisible to other workers until the pool's
 * sweep reclaims it. The default lease is short for that reason.
 */

import { parseArgs } from '../../../../lib/args/mod.ts';
import { parseDuration, parseVector } from './lib.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const DEFAULT_LEASE_MS = 30_000;

export const poolClaim = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['wait'],
    string: ['owner', 'offer', 'kind', 'lease'],
    collect: ['offer', 'kind'],
    alias: { o: 'offer', k: 'kind', w: 'wait' },
  });

  const path = flags._[0] as string | undefined;

  if (!path) {
    await cmd.writeError('pool-claim: missing pool path\n');
    return 1;
  }

  try {
    const owner = flags.owner || `shell:${cmd.env.SESSION_ID || 'anon'}`;
    const kinds = flags.kind && flags.kind.length > 0 ? flags.kind : undefined;

    // --wait blocks until work arrives; Ctrl-C aborts, which resolves null.
    const controller = new AbortController();
    if (flags.wait) cmd.onInterrupt(() => controller.abort());

    const job = await cmd.sys.vfs.poolClaim(cmd.access, path, {
      owner,
      offer: parseVector(flags.offer, 'offer'),
      kinds,
      leaseMs: parseDuration(flags.lease, '--lease') ?? DEFAULT_LEASE_MS,
    }, flags.wait ? controller.signal : undefined);

    if (!job) {
      if (cmd.json) {
        await cmd.writeJSON(null);
      }

      // Nothing claimable is not an error, but the exit code lets a shell loop
      // tell "got work" from "idle" without parsing anything.
      return 1;
    }

    await cmd.writeYAML(job);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pool-claim: ${message}\n`);
    return 1;
  }
};

poolClaim.spec = {
  name: 'pool-claim',
  admin: true,
  effect: 'write' as const,
  description: 'Claim the best matching job from a pool under a lease',
  args: [
    { name: 'path', type: 'path' as const, description: 'Pool node path' },
  ],
  flags: [
    { name: 'owner', type: 'string' as const, description: 'Lease owner (default derives from the session)' },
    { name: 'offer', type: 'string' as const, description: 'Available capacity, key=number (repeatable or comma-separated)' },
    { name: 'kind', type: 'string' as const, description: 'Only consider these kinds (repeatable)' },
    { name: 'lease', type: 'string' as const, description: `Lease duration (default ${DEFAULT_LEASE_MS / 1000}s)` },
    { name: 'wait', type: 'bool' as const, description: 'Block until a job is claimable' },
  ],
};
