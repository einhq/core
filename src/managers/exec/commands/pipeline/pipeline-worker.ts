import { ETC_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { deferred } from '../../../../lib/async/deferred.ts';
import { parseVector } from '../pool/lib.ts';
import { PoolWorker } from '../../../pipeline/pool-worker.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const pipelineWorker = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['concurrency', 'pool', 'capacity', 'kind', 'reserve-capacity', 'reserve-kind', 'kind-quantum', 'lease'],
    collect: ['capacity', 'kind', 'reserve-capacity', 'reserve-kind'],
    alias: { c: 'concurrency', p: 'pool' },
  });

  const poolPath = flags.pool || cmd.env.PIPELINE_WORKER_POOL;

  if (!poolPath) {
    await cmd.writeError('pipeline-worker: --pool <path> is required\n');
    return 1;
  }

  // The worker states its capacity; the pool picks the best job that fits.
  // Priority lives on the jobs, so it is deliberately not expressible here.
  let capacity: Record<string, number> | undefined;
  let reserveCapacity: Record<string, number> | undefined;

  try {
    capacity = parseVector(flags.capacity as string[], 'capacity');
    reserveCapacity = parseVector(flags['reserve-capacity'] as string[], 'reserve-capacity');
  } catch (error) {
    await cmd.writeError(`pipeline-worker: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const concurrency = Number(flags.concurrency ?? cmd.env.PIPELINE_WORKER_CONCURRENCY) || 1;

  const worker = new PoolWorker(cmd.sys.vfs, cmd.opts.tty, {
    poolPath,
    capacity,
    kinds: (flags.kind as string[]).filter(Boolean),
    reserveKinds: (flags['reserve-kind'] as string[]).filter(Boolean),
    reserveCapacity,
    concurrency,
    kindQuantumMs: flags['kind-quantum'] !== undefined ? Number(flags['kind-quantum']) : Number(cmd.env.CFG_PIPELINE_KIND_QUANTUM_MS) || undefined,
    leaseMs: flags.lease === undefined ? undefined : Number(flags.lease),
    bashrcPath: join(cmd.env.ETC_PATH || ETC_PATH, 'bashrc'),
  });

  await worker.start();

  const offer = Object.entries(capacity ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || 'unconstrained';
  await cmd.write(`Pipeline worker running (pool ${poolPath}, capacity ${offer}, concurrency ${concurrency})\n`);

  const done = deferred<void>();
  cmd.onInterrupt(() => {
    done.resolve();
  });

  await done;
  cmd.onInterrupt(null);

  await worker.stop();
  await cmd.write('Pipeline worker stopped\n');
  return 0;
};

pipelineWorker.spec = {
  name: 'pipeline-worker',
  admin: true,
  effect: 'write' as const,
  daemon: true,
  json: false,
  description: 'Run a pool worker (long-running)',
  flags: [
    { name: 'pool', type: 'path' as const, description: 'Pool node path to claim from' },
    { name: 'capacity', type: 'string' as const, description: 'Capacity offered to the pool, key=number (repeatable)' },
    { name: 'kind', type: 'string' as const, description: 'Only claim these job kinds (repeatable)' },
    { name: 'reserve-kind', type: 'string' as const, description: 'Prefer these kinds within reserved capacity (repeatable)' },
    { name: 'reserve-capacity', type: 'string' as const, description: 'Soft capacity reservation, key=number (repeatable)' },
    {
      name: 'kind-quantum',
      type: 'number' as const,
      description: 'Batch by kind: drain one kind for this many ms before rotating (default 0, off)',
    },
    { name: 'lease', type: 'number' as const, description: 'Lease duration in ms (default 60000)' },
    { name: 'concurrency', type: 'number' as const, description: 'Upper bound on concurrent jobs (default 1)' },
  ],
};
