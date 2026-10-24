import { join, resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { ChownLookup, parseChown } from '../../../../lib/mode/mod.ts';
import { NodePropsUpdate } from '../../../../vfs/mod.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { applySubtree } from './share/walk.ts';

export const chown = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['L', 'r'],
  });

  const recursive = flags.r;
  // parseArgs turns numeric positionals into numbers (`chown 4242 <path>`).
  const spec = flags._[0] !== undefined ? String(flags._[0]) : '';
  const paths = flags._.length > 1 ? flags._.slice(1).map(String) : ['.'];

  const resolveOpts = {
    readlink: flags.L,
  };

  if (!spec) {
    await cmd.writeError('chown: missing user and/or group\n');
    return 1;
  }

  let props: NodePropsUpdate;
  try {
    const lookup: ChownLookup = {
      user: async (name) => {
        try {
          const node = await cmd.sys.vfs.get<UserAttrs>(ADMIN_ACCESS, join(cmd.env.USERS_PATH, name), resolveOpts);
          return node.attrs.uid;
        } catch {
          // No such user.
        }
      },
      group: async (name) => {
        try {
          const node = await cmd.sys.vfs.get<GroupAttrs>(ADMIN_ACCESS, join(cmd.env.GROUPS_PATH, name), resolveOpts);
          return node.attrs.gid;
        } catch {
          // No such group.
        }
      },
    };

    props = await parseChown(spec, lookup);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`chown: ${message}\n`);
    return 1;
  }

  const interrupt = new AbortController();
  cmd.onInterrupt(() => interrupt.abort());

  // Each path is applied on its own and a failing one does not stop the rest, as coreutils does.
  const totals = { updated: 0, pinned: 0, skipped: 0, failed: 0 };

  for (const pathArg of paths) {
    const path = resolve(cmd.cwd, pathArg);
    try {
      const result = await applySubtree(cmd.sys.vfs, cmd.access, path, { props }, {
        rootResolve: resolveOpts,
        recursive,
        signal: interrupt.signal,
      });

      for (const failure of result.failures) {
        await cmd.writeError(`chown: ${failure.path}: ${failure.message}\n`);
      }
      totals.updated += result.updated;
      totals.pinned += result.pinned;
      totals.skipped += result.skipped;
      totals.failed += result.failed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`chown: ${path}: ${message}\n`);
      totals.failed++;
    }
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: totals.failed === 0, ...totals });
  }

  return totals.failed > 0 ? 1 : 0;
};

chown.spec = {
  name: 'chown',
  effect: 'write' as const,
  description: 'Change file owner and group',
  args: [
    {
      name: 'usergroup',
      type: 'string' as const,
      description: 'user or group to set',
    },
    {
      name: 'path',
      type: 'path' as const,
      description: 'node(s) to change',
    },
  ],
  flags: [
    { name: 'L', type: 'bool' as const, description: 'do not follow symbolic links' },
    { name: 'r', type: 'bool' as const, description: 'apply to the whole subtree, skipping nodes that hold their own access' },
  ],
};
