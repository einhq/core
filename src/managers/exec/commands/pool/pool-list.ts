import { parseArgs } from '../../../../lib/args/mod.ts';
import { parseStates } from './lib.ts';
import { colorer, Table } from '../../../shell/terminal/mod.ts';
import type { PoolJob, PoolJobState } from '../../../../registries/pool/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const DEFAULT_LIMIT = 100;

export const poolList = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['state', 'kind', 'limit', 'after'],
    alias: { s: 'state', k: 'kind', n: 'limit' },
  });

  const path = flags._[0] as string | undefined;

  if (!path) {
    await cmd.writeError('pool-list: missing pool path\n');
    return 1;
  }

  try {
    const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`invalid --limit '${flags.limit}'`);
    }

    const jobs = await cmd.sys.vfs.poolJobs(cmd.access, path, {
      state: parseStates(flags.state, '--state'),
      kind: flags.kind,
      limit,
      afterId: flags.after === undefined ? undefined : Number(flags.after),
    });

    // A short page is the last page; only hand back a cursor when there may be more.
    const nextCursor = jobs.length < limit ? null : jobs[jobs.length - 1].id;

    if (cmd.json) {
      await cmd.writeJSON({ items: jobs, nextCursor });
      return 0;
    }

    if (jobs.length === 0) {
      await cmd.write('No jobs\n');
      return 0;
    }

    const color = colorer(!cmd.tty);
    const table = new Table({
      header: true,
      columns: [
        { name: 'ID', align: 'right' },
        { name: 'KIND', align: 'left' },
        { name: 'STATE', align: 'left' },
        { name: 'PRIO', align: 'right' },
        { name: 'REQUIRES', align: 'left' },
        { name: 'TRY', align: 'right' },
        { name: 'OWNER', align: 'left' },
        { name: 'KEY', align: 'left' },
      ],
    });

    for (const job of jobs) {
      table.addRow({
        ID: String(job.id),
        KIND: color('cyan', job.kind),
        STATE: color(stateColor(job.state), job.state),
        // Show the aged value when it differs, since that is what actually sorts.
        PRIO: job.effPriority === job.priority ? String(job.priority) : `${job.priority}+${job.effPriority - job.priority}`,
        REQUIRES: formatVector(job.requires),
        TRY: `${job.attempts}/${job.maxAttempts}`,
        OWNER: job.leaseOwner ?? '',
        KEY: job.dedupKey ?? '',
      });
    }

    await cmd.write(table.render());

    if (nextCursor !== null) {
      await cmd.write(`\n(more: --after ${nextCursor})\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`pool-list: ${message}\n`);
    return 1;
  }
};

function formatVector(requires: PoolJob['requires']): string {
  return Object.entries(requires).map(([key, value]) => `${key}=${value}`).join(' ');
}

function stateColor(state: PoolJobState): 'green' | 'yellow' | 'red' | 'cyan' {
  switch (state) {
    case 'done':
      return 'green';
    case 'claimed':
      return 'yellow';
    case 'failed':
    case 'cancelled':
      return 'red';
    default:
      return 'cyan';
  }
}

poolList.spec = {
  name: 'pool-list',
  effect: 'read' as const,
  description: 'List jobs in a pool',
  args: [
    { name: 'path', type: 'path' as const, description: 'Pool node path' },
  ],
  flags: [
    { name: 'state', type: 'string' as const, description: 'Filter by state (comma-separated)' },
    { name: 'kind', type: 'string' as const, description: 'Filter by kind' },
    { name: 'limit', type: 'string' as const, description: `Page size (default ${DEFAULT_LIMIT})` },
    { name: 'after', type: 'string' as const, description: 'Keyset cursor from a previous page (job id)' },
  ],
};
