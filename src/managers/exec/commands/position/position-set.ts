import { basename, dirname, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { assertPolygon, polygonCentroid } from '../../../../registries/position/geo.ts';
import type { PositionData } from '../../../../registries/position/types.ts';
import { NODE_TYPE_POSITION } from '../../../../vfs/types/position.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * Set the shape of a position node: a point, a circle (point + radius) or a
 * polygon ring. A polygon recenters the point on its centroid. A missing
 * position node is made under its parent, so `position-set <location>/position`
 * gives a location its first shape.
 *
 *   position-set <path> --lat=57.7 --lng=11.97 [--radius 500]
 *   position-set <path> --polygon '[{"lat":..,"lng":..},...]'
 *   position-set <path> --clear
 */
export const positionSet = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['lat', 'lng', 'radius', 'polygon'],
    boolean: ['clear'],
  });
  const target = flags._[0] as string | undefined;

  if (!target) {
    await cmd.writeError('position-set: missing position path\n');
    return 1;
  }

  const path = resolve(cmd.cwd, target);

  try {
    const node = await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_POSITION, dirname(path), basename(path));
    if (node.type !== NODE_TYPE_POSITION) {
      throw new Error(`node type is not ${NODE_TYPE_POSITION}`);
    }

    let payload: Uint8Array;
    let data: PositionData | null = null;

    if (flags.clear) {
      payload = new Uint8Array(0);
    } else if (flags.polygon !== undefined) {
      const ring = assertPolygon(JSON.parse(flags.polygon));
      const centroid = polygonCentroid(ring);
      data = { ...centroid, polygon: ring };
      if (flags.radius !== undefined) data.radius = Number(flags.radius);
      payload = new TextEncoder().encode(JSON.stringify(data));
    } else {
      const lat = Number(flags.lat);
      const lng = Number(flags.lng);
      if (flags.lat === undefined || flags.lng === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
        throw new Error('requires --lat and --lng (or --polygon / --clear)');
      }
      data = { lat, lng };
      if (flags.radius !== undefined) data.radius = Number(flags.radius);
      payload = new TextEncoder().encode(JSON.stringify(data));
    }

    if (data?.radius !== undefined && (Number.isNaN(data.radius) || data.radius < 0)) {
      throw new Error('invalid --radius, must be a non-negative number of meters');
    }

    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
    try {
      await handle.write(payload);
    } finally {
      await handle.close();
    }

    if (cmd.json) {
      await cmd.writeJSON(data ?? { cleared: true });
    } else if (data) {
      const shape = data.polygon ? `polygon with ${data.polygon.length} points` : data.radius ? `circle radius ${data.radius}m` : 'point';
      await cmd.writeLn(`Set ${shape} at ${data.lat},${data.lng} on ${path}`);
    } else {
      await cmd.writeLn(`Cleared position on ${path}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`position-set: ${message}\n`);
    return 1;
  }

  return 0;
};

positionSet.spec = {
  name: 'position-set',
  effect: 'write' as const,
  description: 'Set the shape of a position node (point, circle or polygon), making the node when it is missing',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path of the position node, such as <location>/position',
    },
  ],
  flags: [
    { name: 'lat', type: 'string' as const, description: 'latitude of the center point' },
    { name: 'lng', type: 'string' as const, description: 'longitude of the center point' },
    { name: 'radius', type: 'string' as const, description: 'circle radius in meters' },
    { name: 'polygon', type: 'string' as const, description: 'polygon ring as JSON: [{"lat":..,"lng":..},...]' },
    { name: 'clear', type: 'bool' as const, description: 'clear the stored shape' },
  ],
};
