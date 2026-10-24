/**
 * stats-overview — archive history for the dedicated statistics page.
 *
 * Unlike `host-metrics` or `df`, this is not an operational poll. It runs bounded
 * aggregate queries for per-type node growth. A page fetches it once: no host
 * probes, service status commands, or timer. The life-event charts beside it
 * are people's (`person-stats`).
 */

import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { NodeTypeGrowth, StatsOverview } from '../../../../lib/api/system.ts';
export type { NodeTypeGrowth, StatsOverview } from '../../../../lib/api/system.ts';

export const EXCLUDED_NODE_TYPES = new Set([
  'tty',
  'user',
  'session',
  'group',
  'router',
  'null',
  'pool',
  'queue',
  'softlink',
  'exif',
  'embedding',
  'directory',
]);

const monthRange = (first: string, last: string): string[] => {
  const months: string[] = [];
  const end = new Date(`${last}-01T00:00:00Z`);
  for (const cursor = new Date(`${first}-01T00:00:00Z`); cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    months.push(cursor.toISOString().slice(0, 7));
  }
  return months;
};

/** Per-type annual additions and monthly cumulative totals from VFS birthtime. */
const nodeTypeGrowth = async (cmd: Command): Promise<StatsOverview['nodeTypes']> => {
  const buckets = await cmd.sys.vfs.aggregate(cmd.access, {
    group: [{ column: 'type' }, { column: 'birthtime', truncate: 'month' }],
    sum: 'size',
  });

  const byType = new Map<string, Map<string, { count: number; bytes: number }>>();
  let first = '';
  let last = '';
  for (const bucket of buckets) {
    const [type, month] = bucket.key;
    if (EXCLUDED_NODE_TYPES.has(type) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) continue;
    const values = byType.get(type) ?? new Map<string, { count: number; bytes: number }>();
    const current = values.get(month) ?? { count: 0, bytes: 0 };
    current.count += bucket.count;
    current.bytes += bucket.sum ?? 0;
    values.set(month, current);
    byType.set(type, values);
    if (!first || month < first) first = month;
    if (!last || month > last) last = month;
  }
  if (!first || !last) return [];

  const allMonths = monthRange(first, last);
  return [...byType.entries()]
    .map(([type, values]): NodeTypeGrowth => {
      let total = 0;
      let totalBytes = 0;
      const months = allMonths.map((month) => {
        const { count, bytes } = values.get(month) ?? { count: 0, bytes: 0 };
        return { month, count, total: total += count, bytes, totalBytes: totalBytes += bytes };
      });
      const years = new Map<string, { count: number; total: number; bytes: number; totalBytes: number }>();
      for (const point of months) {
        const year = point.month.slice(0, 4);
        const annual = years.get(year) ?? { count: 0, total: 0, bytes: 0, totalBytes: 0 };
        annual.count += point.count;
        annual.total = point.total;
        annual.bytes += point.bytes;
        annual.totalBytes = point.totalBytes;
        years.set(year, annual);
      }
      return {
        type,
        total,
        totalBytes,
        years: [...years.entries()].map(([year, point]) => ({ year, ...point })),
        months,
      };
    })
    .sort((a, b) => {
      if (a.type === b.type) return 0;
      if (a.type === 'file') return -1;
      if (b.type === 'file') return 1;
      return b.total - a.total || a.type.localeCompare(b.type);
    });
};

export const statsOverview = async (cmd: Command): CmdReturn => {
  const payload = { nodeTypes: await nodeTypeGrowth(cmd) } satisfies StatsOverview;

  if (cmd.json) {
    await cmd.writeJSON(payload);
    return 0;
  }

  await cmd.writeLn(`node types  ${payload.nodeTypes.length.toLocaleString()}`);
  return 0;
};

statsOverview.spec = {
  name: 'stats-overview',
  effect: 'read' as const,
  description: 'Per-type archive growth: nodes and bytes added by year and month',
  args: [],
};
