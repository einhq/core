import { basename, resolve } from '@std/path';
import { toText } from '@std/streams/to-text';
import type { NodePosition, PositionListing, PositionShape } from '../../../../lib/api/position.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_POSITION } from '../../../../vfs/types/position.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const coordinate = (value: unknown, limit: number): number | undefined => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;

const pointOf = (value: unknown): { lat: number; lng: number } | undefined => {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const lat = coordinate(record?.lat, 90);
  const lng = coordinate(record?.lng, 180);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
};

/** A position node's content as a shape, or nothing when it has none yet. */
const shapeOf = (text: string): PositionShape | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const point = pointOf(parsed);
  if (!point) return undefined;
  const record = parsed as Record<string, unknown>;
  const ring = Array.isArray(record.polygon) ? record.polygon.map(pointOf) : [];
  if (ring.length >= 3 && ring.every((vertex) => !!vertex)) return { ...point, polygon: ring as { lat: number; lng: number }[] };
  const radius = typeof record.radius === 'number' && Number.isFinite(record.radius) && record.radius > 0 ? record.radius : undefined;
  return { ...point, ...(radius ? { radius } : {}) };
};

/**
 * Where nodes are: for each path, its name, its type and the shape of its position — the node's
 * own when it is a position node, otherwise its `position` child's (a location's shape, a
 * picture's GPS). One call for a list of nodes, so a map can pin them all at once; a path that
 * cannot be read is an `error` in its entry, not a failure of the rest.
 *
 *   position-get <path>...
 */
export const positionGet = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});
  const targets = flags._;
  if (targets.length === 0) {
    await cmd.writeError('position-get: missing path\n');
    return 1;
  }

  const nodes: NodePosition[] = [];
  for (const target of targets) {
    const path = resolve(cmd.cwd, target);
    let node;
    try {
      node = await cmd.sys.vfs.get(cmd.access, path);
    } catch (error) {
      nodes.push({ path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const name = typeof node.attrs.name === 'string' && node.attrs.name.trim() ? node.attrs.name.trim() : basename(path);
    let position: PositionShape | undefined;
    try {
      const at = node.type === NODE_TYPE_POSITION ? path : `${path}/position`;
      const handle = await cmd.sys.vfs.open(cmd.access, at, { mode: 'r' });
      try {
        position = shapeOf(await toText(handle.readable));
      } finally {
        await handle.close();
      }
    } catch {
      // No position child, or none the caller may read: the node is where nothing says.
    }
    nodes.push({ path, name, type: node.type, ...(position ? { position } : {}) });
  }

  if (cmd.json) {
    await cmd.writeJSON({ nodes } satisfies PositionListing);
  } else {
    for (const entry of nodes) {
      const at = entry.error ? `error: ${entry.error}` : entry.position ? `${entry.position.lat},${entry.position.lng}` : 'nowhere';
      await cmd.writeLn(`${at}\t${entry.path}`);
    }
  }
  return 0;
};

positionGet.spec = {
  name: 'position-get',
  effect: 'read' as const,
  description: "Where nodes are: each path's name, type and the shape of its position (a location's, a picture's GPS)",
  args: [
    { name: 'path', type: 'path' as const, variadic: true, description: 'the nodes, or position nodes themselves' },
  ],
  flags: [],
  examples: ['position-get /archive/locations/Exempelviken /archive/albums/Sommar/files/IMG_0001.jpg'],
  returns: 'nodes: one per path, in order — path, name, type and position (lat, lng, and radius or polygon) when it has one; error for a path that cannot be read.',
};
