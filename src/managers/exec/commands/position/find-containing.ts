import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * Find positions whose shape contains a point (polygon coverage, or within
 * radius for a circle), resolving each match to its VFS paths.
 *
 *   find-containing --lat=57.685 --lng=11.944 [--limit 10]
 *   find-containing <lat> <lng> [--limit 10]
 *
 * The flag form is the one that works everywhere. A western or southern
 * coordinate cannot be a positional — parseArgs reads the leading `-` of
 * `-122.3493` as the next flag, so the point never arrives.
 */
export const findContaining = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['limit', 'lat', 'lng'],
    default: { limit: '10' },
  });
  // Flags win over positionals, and are the only form a negative coordinate survives.
  const latArg = flags.lat ?? flags._[0];
  const lngArg = flags.lng ?? flags._[1];
  const lat = Number(latArg);
  const lng = Number(lngArg);
  const limit = Number(flags.limit);

  try {
    if (latArg === undefined || lngArg === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
      throw new Error('requires numeric lat and lng arguments (write --lat=-122.3 for a negative coordinate)');
    }

    const matches = await cmd.sys.vfs.findContaining(cmd.access, lat, lng, limit);
    const results = [];

    for (const match of matches) {
      const entries = await cmd.sys.vfs.resolveId(cmd.access, match.id);
      if (entries.length === 0) continue;

      results.push({
        id: match.id,
        distance: match.distance,
        paths: entries.map((e) => e.absPath),
      });
    }

    if (cmd.json) {
      await cmd.writeJSON({ results });
    } else {
      for (const r of results) {
        await cmd.write(`Contains point, center ${Math.round(r.distance)}m away [${r.id}]:\n`);
        for (const p of r.paths) {
          await cmd.write(` - ${p}\n`);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`find-containing: ${message}\n`);
    return 1;
  }

  return 0;
};

findContaining.spec = {
  name: 'find-containing',
  effect: 'read' as const,
  description: 'Find positions whose shape contains a point',
  args: [
    {
      name: 'lat',
      type: 'string' as const,
      description: 'latitude of the point',
    },
    {
      name: 'lng',
      type: 'string' as const,
      description: 'longitude of the point',
    },
  ],
  flags: [
    {
      name: 'lat',
      type: 'string' as const,
      description: 'latitude, as --lat=<n> — required form for a negative coordinate',
    },
    {
      name: 'lng',
      type: 'string' as const,
      description: 'longitude, as --lng=<n> — required form for a negative coordinate',
    },
    { name: 'limit', type: 'string' as const, description: 'max results (default: 10)' },
  ],
};
