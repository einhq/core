import { parseArgs } from '../../../../lib/args/mod.ts';
import { deferred } from '../../../../lib/async/deferred.ts';
import { parseVector } from '../pool/lib.ts';
import { PoolWorker } from '../../../pipeline/pool-worker.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** How often `--while` is asked when `--while-every` does not say. */
const DEFAULT_WHILE_EVERY_SECONDS = 60;

export const pipelineWorker = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['concurrency', 'pool', 'capacity', 'kind', 'reserve-capacity', 'reserve-kind', 'kind-quantum', 'lease', 'name', 'env', 'while', 'while-every'],
    boolean: ['pass-on'],
    collect: ['capacity', 'kind', 'reserve-capacity', 'reserve-kind', 'env'],
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

  const env: Record<string, string> = {};
  for (const pair of (flags.env as string[]).filter(Boolean)) {
    const at = pair.indexOf('=');
    if (at <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair.slice(0, at))) {
      await cmd.writeError(`pipeline-worker: --env takes NAME=value, not '${pair}'\n`);
      return 1;
    }
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }

  const whileCommand = typeof flags.while === 'string' && flags.while.trim() ? flags.while : undefined;
  const whileEveryMs = (Number(flags['while-every']) || DEFAULT_WHILE_EVERY_SECONDS) * 1000;

  const concurrency = Number(flags.concurrency ?? cmd.env.PIPELINE_WORKER_CONCURRENCY) || 1;

  const worker = new PoolWorker(cmd.sys.vfs, cmd.opts.tty, {
    poolPath,
    // A service's worker is known by the service's name; `--name` names one started by hand.
    name: (flags.name as string | undefined) || cmd.env.SERVICE_NAME || undefined,
    capacity,
    kinds: (flags.kind as string[]).filter(Boolean),
    reserveKinds: (flags['reserve-kind'] as string[]).filter(Boolean),
    reserveCapacity,
    concurrency,
    kindQuantumMs: flags['kind-quantum'] !== undefined ? Number(flags['kind-quantum']) : Number(cmd.env.CFG_PIPELINE_KIND_QUANTUM_MS) || undefined,
    leaseMs: flags.lease === undefined ? undefined : Number(flags.lease),
    env,
    passOn: flags['pass-on'] === true,
  });

  await worker.start();

  const offer = Object.entries(capacity ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || 'unconstrained';
  await cmd.write(`Pipeline worker running (pool ${poolPath}, capacity ${offer}, concurrency ${concurrency})\n`);

  const done = deferred<void>();
  cmd.onInterrupt(() => {
    done.resolve();
  });

  // The condition is asked once each `--while-every`; its first failure stops the worker.
  let ended: string | undefined;
  let check: ReturnType<typeof setTimeout> | undefined;
  const ask = async () => {
    const { code, stderr } = await cmd.execute(whileCommand!).catch((error) => ({ code: 1, stderr: String(error) }));
    if (code !== 0) {
      ended = `${whileCommand} exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`;
      done.resolve();
    } else if (!done.isFinished()) {
      check = setTimeout(ask, whileEveryMs);
    }
  };
  if (whileCommand) check = setTimeout(ask, whileEveryMs);

  await done;
  clearTimeout(check);
  cmd.onInterrupt(null);

  await worker.stop();
  await cmd.write(ended ? `Pipeline worker stopped: ${ended}\n` : 'Pipeline worker stopped\n');
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
    { name: 'name', type: 'string' as const, description: 'What pool-stat and the dashboard call this worker (default: the service it runs as)' },
    { name: 'concurrency', type: 'number' as const, description: 'Upper bound on concurrent jobs (default 1)' },
    { name: 'env', type: 'string' as const, description: 'A variable every step runs with, NAME=value (repeatable)' },
    {
      name: 'pass-on',
      type: 'bool' as const,
      description: 'A step that could not run yet (exit 75) goes straight back to the pool for another worker, and its kind rests in this one',
    },
    { name: 'while', type: 'string' as const, description: 'A command asked every --while-every seconds; the worker stops, handing its jobs back, once it fails' },
    { name: 'while-every', type: 'number' as const, description: `How often --while is asked, in seconds (default ${DEFAULT_WHILE_EVERY_SECONDS})` },
  ],
};
