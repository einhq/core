/**
 * facets — bucket counts for sizing the search UI's controls.
 *
 * Answers "which years have anything, and how much" in a couple of aggregate
 * queries, so a year slider can be built without paging through results. Counts
 * are **not** access-filtered (see NodeVFS.aggregate) — they size controls, they
 * are not a data listing.
 *
 * Region filtering is deliberately absent: a region needs a per-node child read,
 * which an aggregate cannot do. What lies in an unlisted tree is not counted
 * (`unlisted.ts`).
 */

import { parseArgs } from '../args/mod.ts';
import type { AttrCondition } from '../../vfs/query.ts';
import type { Command } from '../../client/mod.ts';
import type { CmdReturn } from '../../client/mod.ts';
import { exclusiveUpperBound, FILE_KINDS, isKind, type Kind, kindConditions, kindNodeTypes, NOT_DERIVED, parseDateBound, TAKEN_AT, timeConditions } from './filters.ts';
import { unlistedRoots } from './unlisted.ts';

export const facets = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['kind', 'from', 'to'] });

  const kinds: Kind[] = [];
  for (const raw of (flags.kind ?? '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    if (!isKind(value)) {
      await cmd.writeError(`facets: '${value}' is not a kind (${FILE_KINDS.join(', ')}, or a node type)\n`);
      return 1;
    }
    if (!kinds.includes(value)) kinds.push(value);
  }

  const from = flags.from !== undefined ? parseDateBound(flags.from) : undefined;
  const to = flags.to !== undefined ? exclusiveUpperBound(flags.to) : undefined;
  if (flags.from !== undefined && from === undefined) {
    await cmd.writeError(`facets: cannot parse --from date '${flags.from}'\n`);
    return 1;
  }
  if (flags.to !== undefined && to === undefined) {
    await cmd.writeError(`facets: cannot parse --to date '${flags.to}'\n`);
    return 1;
  }

  const where: AttrCondition[] = [NOT_DERIVED, ...timeConditions(from, to), ...kindConditions(kinds)];
  const types = kinds.length > 0 ? kindNodeTypes(kinds) : undefined;
  const notWithin = [...await unlistedRoots(cmd.sys.vfs)];

  const yearBuckets = await cmd.sys.vfs.aggregate(cmd.access, {
    types,
    where,
    notWithin,
    group: [{ ref: TAKEN_AT, prefixLength: 4 }],
  });

  const years = yearBuckets
    .filter((bucket) => /^\d{4}$/.test(bucket.key[0]))
    .map((bucket) => ({ year: Number(bucket.key[0]), count: bucket.count }))
    .sort((a, b) => a.year - b.year);

  const total = years.reduce((sum, bucket) => sum + bucket.count, 0);

  // One aggregate per media kind: the condition list is AND-only, so kinds
  // cannot be counted in a single grouped query.
  const kindCounts: { kind: string; count: number }[] = [];
  for (const kind of ['photo', 'video', 'audio'] as const) {
    const buckets = await cmd.sys.vfs.aggregate(cmd.access, {
      types: kindNodeTypes([kind]),
      where: [NOT_DERIVED, ...timeConditions(from, to), ...kindConditions([kind])],
      notWithin,
      group: [{ ref: 'mimetype' }],
    });
    const count = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    if (count > 0) kindCounts.push({ kind, count });
  }

  const payload = {
    total,
    range: years.length > 0 ? { min: years[0].year, max: years[years.length - 1].year } : null,
    years,
    kinds: kindCounts,
  };

  if (cmd.json) {
    await cmd.writeJSON(payload);
    return 0;
  }

  await cmd.writeLn(`total: ${total}`);
  if (payload.range) await cmd.writeLn(`range: ${payload.range.min}-${payload.range.max}`);
  for (const bucket of years) {
    await cmd.writeLn(`  ${bucket.year}  ${bucket.count}`);
  }
  for (const bucket of kindCounts) {
    await cmd.writeLn(`${bucket.kind.padEnd(8)} ${bucket.count}`);
  }

  return 0;
};

facets.spec = {
  name: 'facets',
  effect: 'read' as const,
  description: 'Bucket counts (per year, per kind) for sizing search filters',
  args: [],
  flags: [
    { name: 'kind', type: 'string' as const, description: `restrict to content kinds: ${FILE_KINDS.join(', ')}, or node types` },
    { name: 'from', type: 'string' as const, description: 'only count media taken at/after this date' },
    { name: 'to', type: 'string' as const, description: 'only count media taken before this date, exclusive' },
  ],
  examples: [
    'facets --kind photo --from 2015 --to 2020',
  ],
  returns: 'per-year and per-kind counts for the filters given.',
};
