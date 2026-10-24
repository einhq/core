import { parseArgs } from '../../../../lib/args/mod.ts';
import { resolve } from '@std/path';
import { Node } from '../../../../vfs/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const attrs = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['L'],
    collect: ['s', 'J', 'd'],
  });

  const set = flags.s as string[];
  const setJson = flags.J as string[];
  const unset = flags.d as string[];
  const path = resolve(cmd.cwd, flags._[0] as string || '.');

  const resolveOpts = {
    readlink: flags.L,
  };

  try {
    let node: Node;

    if (set?.length > 0 || setJson?.length > 0 || unset?.length > 0) {
      const attrs: Record<string, unknown> = {};

      if (set?.length > 0) {
        for (const s of set) {
          const [key, ...rest] = s.split('=');
          attrs[key] = rest.join('=');
        }
      }

      if (setJson?.length > 0) {
        for (const s of setJson) {
          const [key, ...rest] = s.split('=');
          const rawValue = rest.join('=');
          try {
            attrs[key] = JSON.parse(rawValue);
          } catch {
            throw new Error(`invalid JSON for attribute '${key}': ${rawValue}`);
          }
        }
      }

      // `attrs` is the patch sent to vfs.update, which the store merges: an absent key is
      // left alone, and null deletes it (see NodeAttrsUpdate).
      if (unset?.length > 0) {
        for (const u of unset) {
          attrs[u] = null;
        }
      }

      node = await cmd.sys.vfs.update(cmd.access, path, {
        ...resolveOpts,
        attrs,
      });
    } else {
      node = await cmd.sys.vfs.get(cmd.access, path, resolveOpts);
    }

    if (cmd.json) {
      await cmd.writeJSON(node.attrs);
    } else {
      if (Object.keys(node.attrs).length > 0) {
        await cmd.writeYAML(node.attrs);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`attrs: ${path}: ${message}\n`);
    return 1;
  }

  return 0;
};

attrs.spec = {
  name: 'attrs',
  effect: 'read' as const,
  description: 'Display or set node attributes',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to node',
    },
  ],
  flags: [
    { name: 'L', type: 'bool' as const, description: 'do not follow symbolic links' },
    {
      name: 's',
      writes: true,
      type: 'string' as const,
      description: 'set attribute as string',
    },
    {
      name: 'd',
      writes: true,
      type: 'string' as const,
      description: 'unset attribute',
    },
    {
      name: 'J',
      writes: true,
      type: 'string' as const,
      description: 'set attribute as JSON',
    },
  ],
  examples: [
    'attrs /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg',
    "attrs -s 'description=Ett exempel' /archive/albums/Exempelalbum_2019/files/IMG_0007.jpg",
  ],
  returns: 'every attribute on the node, or nothing when setting one.',
};
