/**
 * Stars/bookmarks: per-user softlinks under $HOME/stars/. Several paths star or unstar together,
 * which is how a selection of pictures becomes favourites in one call.
 */

import { basename, join, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import type { StarEntry } from '../../../../lib/api/mod.ts';

const STARS_DIR = 'stars';

export const star = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['d'],
    alias: { d: 'delete' },
  });
  const args = flags._.map(String);

  const home = cmd.env.HOME;
  if (!home || home === '/') {
    await cmd.writeError('star: no home directory (log in first)\n');
    return 1;
  }
  const starsPath = join(home, STARS_DIR);

  /** The stars as they are now; none when the directory does not exist yet. */
  const readStars = async (): Promise<StarEntry[]> => {
    try {
      const children = await cmd.sys.vfs.children(cmd.access, starsPath);
      return children.filter((c) => c.node.props.softlink).map((c) => ({ name: c.name, target: c.node.props.softlink! }));
    } catch {
      return [];
    }
  };

  try {
    // `star` or `star list` lists.
    if (args.length === 0 || (args.length === 1 && args[0] === 'list')) {
      const entries = await readStars();
      if (cmd.json) {
        await cmd.writeJSON(entries satisfies StarEntry[]);
      } else {
        for (const e of entries) await cmd.writeLn(`${e.name} -> ${e.target}`);
      }
      return 0;
    }

    const targets = [...new Set(args.map((arg) => resolve(cmd.cwd, arg)))];
    const stars = await readStars();
    const linkOf = (target: string) => stars.find((entry) => entry.target === target);

    if (flags.d) {
      // Every one is checked before any is removed, so a mistyped path changes nothing.
      const missing = targets.filter((target) => !linkOf(target));
      if (missing.length > 0) {
        await cmd.writeError(`star: ${missing.join(', ')}: not starred\n`);
        return 1;
      }
      for (const target of targets) {
        await cmd.sys.vfs.unlink(cmd.access, join(starsPath, linkOf(target)!.name), starsPath, { readlink: true });
      }
      if (cmd.json) {
        await cmd.writeJSON({ ok: true });
      } else {
        for (const target of targets) await cmd.writeLn(`Unstarred ${target}`);
      }
      return 0;
    }

    for (const target of targets) await cmd.sys.vfs.get(cmd.access, target);

    await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, home, STARS_DIR, {
      props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o755 },
    });

    const usedNames = new Set(stars.map((entry) => entry.name));
    for (const target of targets) {
      if (linkOf(target)) {
        if (!cmd.json) await cmd.writeLn(`Already starred: ${target}`);
        continue;
      }
      let name = basename(target);
      for (let i = 2; usedNames.has(name); i++) {
        name = `${basename(target)}-${i}`;
      }
      usedNames.add(name);
      await cmd.sys.vfs.create(cmd.access, NODE_TYPE_SOFTLINK, starsPath, name, {
        props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: target },
      });
      if (!cmd.json) await cmd.writeLn(`Starred ${target}`);
    }

    if (cmd.json) await cmd.writeJSON({ ok: true });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`star: ${message}\n`);
    return 1;
  }
};

star.spec = {
  name: 'star',
  effect: 'read' as const,
  description: 'Bookmark nodes as softlinks in $HOME/stars (star <path>..., star -d <path>..., star [list])',
  args: [
    { name: 'path', writes: true, type: 'path' as const, variadic: true, description: 'nodes to star/unstar, or "list"' },
  ],
  flags: [
    { name: 'd', writes: true, type: 'bool' as const, description: 'remove the star' },
  ],
};
