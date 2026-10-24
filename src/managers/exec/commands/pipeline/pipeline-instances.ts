/**
 * pipeline-instances — list instances, newest first, a page at a time.
 *
 * Goes through `vfs.query` rather than walking `instances/<pipeline>/` with
 * `children()`, which would be N+1 node reads with no upper bound: the query
 * skips the hierarchy joins and pushes both filters into SQL.
 *
 * Ordering is by `startedAt` descending. Rows without it are excluded by
 * `vfs.query`, which is fine — every instance is created with one.
 */

import { parseArgs } from '../../../../lib/args/mod.ts';
import { instancesRoot } from './lib.ts';
import { stampToObject } from '../../../../lib/datetime/mod.ts';
import { colorer, Table } from '../../../shell/terminal/mod.ts';
import type { PipelineInstanceAttrs } from '../../../pipeline/types.ts';
import type { AttrCondition, NodeQueryCursor } from '../../../../vfs/query.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { InstancePage } from '../../../../lib/api/pipeline.ts';

const DEFAULT_LIMIT = 100;

type InstanceRow = {
  id: string;
  pipeline: string;
  status: string;
  triggerPath: string;
  startedAt: number;
  completedAt?: number;
};

export const pipelineInstances = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['s', 'limit', 'after'],
    alias: { s: 'status', n: 'limit' },
  });

  const color = colorer(!cmd.tty);
  const instancesPath = instancesRoot(cmd);
  const prefix = instancesPath + '/';
  const names = flags._ as string[];

  const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    await cmd.writeError(`pipeline-instances: invalid --limit '${flags.limit}'\n`);
    return 1;
  }

  const where: AttrCondition[] = [{ ref: 'pipelineName', op: 'exists' }];
  // A single name filters in SQL; several are matched on the way out, since
  // conditions are AND-only and `in` over one attr is the only disjunction.
  if (names.length === 1) where.push({ ref: 'pipelineName', op: 'eq', value: names[0] });
  else if (names.length > 1) where.push({ ref: 'pipelineName', op: 'in', value: names });
  if (flags.status) where.push({ ref: 'status', op: 'eq', value: flags.status });

  // `after` is `<startedAt>:<nodeId>` — the keyset cursor flattened for the CLI.
  let after: NodeQueryCursor | undefined;
  if (flags.after) {
    const sep = flags.after.indexOf(':');
    if (sep < 0) {
      await cmd.writeError(`pipeline-instances: invalid --after '${flags.after}' (expected <startedAt>:<id>)\n`);
      return 1;
    }
    after = { value: flags.after.slice(0, sep), id: flags.after.slice(sep + 1) };
  }

  const rows = await cmd.sys.vfs.query(cmd.access, {
    where,
    orderBy: { ref: 'startedAt', dir: 'desc' },
    after,
    limit,
  });

  const items: InstanceRow[] = [];
  let nextCursor: string | null = null;

  for (const row of rows) {
    if (!row.absPath.startsWith(prefix)) continue;
    const parts = row.absPath.slice(prefix.length).split('/').filter(Boolean);
    if (parts.length !== 2) continue;

    const attrs = row.node.attrs as PipelineInstanceAttrs;
    items.push({
      id: parts[1],
      pipeline: parts[0],
      status: attrs.status,
      triggerPath: attrs.triggerPath || '',
      startedAt: attrs.startedAt,
      completedAt: attrs.completedAt,
    });
    nextCursor = `${row.sortValue ?? ''}:${row.id}`;
  }

  // A short page is the last page; only hand back a cursor when there may be more.
  if (rows.length < limit) nextCursor = null;

  if (cmd.json) {
    await cmd.writeJSON({ items, nextCursor } satisfies InstancePage);
    return 0;
  }

  if (items.length === 0) {
    await cmd.write('No pipeline instances\n');
    return 0;
  }

  const table = new Table({
    header: true,
    columns: [
      { name: 'ID', align: 'left' },
      { name: 'PIPELINE', align: 'left' },
      { name: 'STATUS', align: 'left' },
      { name: 'PATH', align: 'left' },
      { name: 'day', align: 'right' },
      { name: 'month', align: 'left' },
      { name: 'year', align: 'right' },
      { name: 'time', align: 'right' },
    ],
  });

  for (const item of items) {
    const time = stampToObject(item.startedAt);
    table.addRow({
      ID: item.id,
      PIPELINE: color('cyan', item.pipeline),
      STATUS: color(getStatusColor(item.status), item.status),
      PATH: item.triggerPath,
      day: color('blue', time.day),
      month: color('blue', time.month),
      year: color('blue', time.year),
      time: color('blue', `${time.hour}:${time.minute}:${time.second}`),
    });
  }

  await cmd.write(table.render());
  if (nextCursor) await cmd.write(`\n(more: --after ${nextCursor})\n`);
  return 0;
};

function getStatusColor(status: string): 'green' | 'yellow' | 'red' | 'cyan' {
  switch (status) {
    case 'completed':
      return 'green';
    case 'running':
    case 'queued':
      return 'yellow';
    case 'failed':
      return 'red';
    case 'cancelled':
      return 'red';
    default:
      return 'cyan';
  }
}

pipelineInstances.spec = {
  name: 'pipeline-instances',
  effect: 'read' as const,
  description: 'List pipeline instances — running, failed or completed — newest first',
  args: [
    { name: 'name', type: 'string' as const, description: 'Pipeline name (optional, repeatable)' },
  ],
  flags: [
    { name: 's', type: 'string' as const, description: 'Filter by status' },
    { name: 'limit', type: 'string' as const, description: `Page size (default ${DEFAULT_LIMIT})` },
    { name: 'after', type: 'string' as const, description: 'Keyset cursor from a previous page (<startedAt>:<id>)' },
  ],
};
