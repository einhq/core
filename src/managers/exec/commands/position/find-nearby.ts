import { resolve } from '@std/path';
import { toArrayBuffer } from '@std/streams/to-array-buffer';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_POSITION } from '../../../../vfs/types/position.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const findNearby = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    string: ['radius', 'limit'],
    default: { radius: '10000', limit: '10' },
  });
  const path = resolve(cmd.cwd, flags._[0] as string || '.');
  const radiusMeters = Number(flags.radius);
  const limit = Number(flags.limit);

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);

    if (node.type !== NODE_TYPE_POSITION) {
      throw new Error(`node type is not ${NODE_TYPE_POSITION}`);
    }

    const handle = await cmd.sys.vfs.open(cmd.access, path);

    try {
      const data = await toArrayBuffer(handle.readable);
      if (!data || data.byteLength === 0) {
        throw new Error('node has no position data');
      }

      const json = new TextDecoder().decode(new Uint8Array(data));
      const { lat, lng } = JSON.parse(json);

      const nearby = await cmd.sys.vfs.findNearby(cmd.access, lat, lng, radiusMeters, limit);

      for (const n of nearby) {
        await cmd.write(`Match at ${Math.round(n.distance)}m [${n.id}]:\n`);
        const entries = await cmd.sys.vfs.resolveId(cmd.access, n.id);

        for (const e of entries) {
          await cmd.write(` - ${e.absPath}\n`);
        }
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmd.json) {
      await cmd.writeJSON({ error: `find-nearby: ${message}` });
    } else {
      await cmd.writeError(`find-nearby: ${message}\n`);
    }
    return 1;
  }

  return 0;
};

findNearby.spec = {
  name: 'find-nearby',
  effect: 'read' as const,
  description: 'Find positions near a position node, by distance',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path of a position node',
    },
  ],
  flags: [
    { name: 'radius', type: 'string' as const, description: 'search radius in meters (default: 10000)' },
    { name: 'limit', type: 'string' as const, description: 'max results (default: 10)' },
  ],
};
