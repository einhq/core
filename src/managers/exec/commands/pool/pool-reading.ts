/**
 * A pool's stat, read at most once per `READING_MAX_AGE_MS` by this process and shared by the
 * readers that poll every pool: `metrics-sampler`, and `pool-stat` without a path, which `health`,
 * `top` and the dashboard run.
 *
 * A pool's counts are a GROUP BY over all of its jobs, which costs seconds on a pool of a million
 * (ein/core#742), and each of those polls on its own timer. Shared, a pool is counted about once
 * per sampler tick however many dashboards and `top`s are open.
 */

import { type Access, ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { TICK_MS } from '../../../../lib/metrics/series.ts';
import type { PoolStat } from '../../../../registries/pool/mod.ts';
import type { NodeVFS } from '../../../../vfs/mod.ts';

/** Just under the sampler's tick, so each of its samples is a new reading and the polls between them share it. */
export const READING_MAX_AGE_MS = TICK_MS - 1_000;

type Reading = { at: number; stat: Promise<PoolStat> };

const readings = new WeakMap<NodeVFS, Map<string, Reading>>();

/**
 * The stat of the pool at `path`, at most `READING_MAX_AGE_MS` old.
 *
 * `access` is checked on every call; the reading itself is made as admin, so one reading serves
 * every caller who may read the pool. A failed reading is not kept.
 */
export const readPoolStat = async (vfs: NodeVFS, access: Access, path: string): Promise<PoolStat> => {
  await vfs.get(access, path);

  let byPath = readings.get(vfs);
  if (!byPath) readings.set(vfs, byPath = new Map());

  const now = Date.now();
  const known = byPath.get(path);
  if (known && now - known.at < READING_MAX_AGE_MS) return await known.stat;

  const reading: Reading = { at: now, stat: vfs.stat(ADMIN_ACCESS, path) as unknown as Promise<PoolStat> };
  byPath.set(path, reading);
  try {
    return await reading.stat;
  } catch (error) {
    if (byPath.get(path) === reading) byPath.delete(path);
    throw error;
  }
};
