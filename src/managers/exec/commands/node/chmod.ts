import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { chmodToMode } from '../../../../lib/mode/mod.ts';
import { NodePropsUpdate } from '../../../../vfs/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { applySubtree } from './share/walk.ts';

export const chmod = async (cmd: Command): CmdReturn => {
  // Positionals stay strings: `040` read as a number is 40, not a mode.
  const flags = parseArgs(cmd.args, {
    boolean: ['L', 'r'],
    string: ['_'],
  });

  const recursive = flags.r;
  // `string: ['_']` types `_` as a single string, though it holds every positional.
  const [flagsMode, ...pathArgs] = flags._ as unknown as string[];
  const paths = pathArgs.length > 0 ? pathArgs : ['.'];

  const resolveOpts = {
    readlink: flags.L,
  };

  if (!flagsMode) {
    await cmd.writeError('chmod: missing mode\n');
    return 1;
  }

  const interrupt = new AbortController();
  cmd.onInterrupt(() => interrupt.abort());

  // Each path is applied on its own and a failing one does not stop the rest, as coreutils does.
  const totals = { updated: 0, pinned: 0, skipped: 0, failed: 0 };

  for (const pathArg of paths) {
    const path = resolve(cmd.cwd, pathArg);
    try {
      // A numeric mode is the same for every node. A symbolic one is applied to each node's own
      // mode, as coreutils' `chmod -R o-rw` does: the bits it names change, every other bit of
      // each node stays.
      const numeric = /^[0-7]{3,4}$/.test(flagsMode);
      // A mode that does not parse is refused before the walk, not once per node.
      chmodToMode(flagsMode);
      const change = numeric ? { props: { mode: chmodToMode(flagsMode) } satisfies NodePropsUpdate } : { mode: (current: number) => chmodToMode(flagsMode, current) };

      const result = await applySubtree(cmd.sys.vfs, cmd.access, path, change, {
        rootResolve: resolveOpts,
        recursive,
        signal: interrupt.signal,
      });

      for (const failure of result.failures) {
        await cmd.writeError(`chmod: ${failure.path}: ${failure.message}\n`);
      }
      totals.updated += result.updated;
      totals.pinned += result.pinned;
      totals.skipped += result.skipped;
      totals.failed += result.failed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`chmod: ${path}: ${message}\n`);
      totals.failed++;
    }
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok: totals.failed === 0, ...totals });
  }

  return totals.failed > 0 ? 1 : 0;
};

chmod.spec = {
  name: 'chmod',
  effect: 'write' as const,
  description: 'Change file mode bits',
  args: [
    {
      name: 'mode',
      type: 'string' as const,
      description: 'mode to set',
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
