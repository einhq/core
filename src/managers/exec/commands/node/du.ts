import { join, resolve } from '@std/path';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { humanizeSize } from '../../../../lib/utils/humanize-size.ts';
import type { Node } from '../../../../vfs/mod.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

type DuEntry = {
  path: string;
  size: number;
};

export type DuResult = {
  entries: DuEntry[];
  total?: number;
};

const ownSize = (node: Node): number => {
  const size = node.attrs.size;
  return node.type === NODE_TYPE_FILE && typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0;
};

export const du = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    boolean: ['c', 'total', 'h', 'human-readable', 's', 'summarize'],
    alias: {
      c: 'total',
      h: 'human-readable',
      s: 'summarize',
    },
    unknown: collectUnknownFlags(unknown),
  });

  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const paths = flags._.length > 0 ? flags._ : ['.'];
  const summarize = flags.summarize;
  const rows: DuEntry[] = [];
  let total = 0;
  let exitCode = 0;
  let running = true;

  cmd.onInterrupt(() => {
    running = false;
  });

  const measure = async (
    path: string,
    displayPath: string,
    node: Node,
    childCount: number,
    seen: Set<string>,
    topLevel: boolean,
  ): Promise<{ size: number; rows: DuEntry[] }> => {
    if (!running) {
      return { size: 0, rows: [] };
    }

    if (node.props.softlink || seen.has(node.id)) {
      return { size: 0, rows: !summarize && topLevel ? [{ path: displayPath, size: 0 }] : [] };
    }

    seen.add(node.id);
    let size = ownSize(node);
    const childRows: DuEntry[] = [];

    if (childCount > 0) {
      const children = await cmd.sys.vfs.children(cmd.access, path, { readlink: true });
      for (const child of children) {
        if (!running) break;

        const measured = await measure(
          join(path, child.name),
          join(displayPath, child.name),
          child.node,
          child.childCount,
          seen,
          false,
        );
        size += measured.size;
        childRows.push(...measured.rows);
      }
    }

    if (!summarize && (topLevel || node.type !== NODE_TYPE_FILE)) {
      childRows.push({ path: displayPath, size });
    }

    return { size, rows: childRows };
  };

  for (const pathArg of paths) {
    if (!running) break;

    const path = resolve(cmd.cwd, pathArg);
    try {
      const node = await cmd.sys.vfs.get(cmd.access, path, { readlink: true });
      const childCount = node.props.softlink ? 0 : await cmd.sys.vfs.childCount(cmd.access, path, { readlink: true });
      const measured = await measure(path, pathArg, node, childCount, new Set(), true);
      total += measured.size;
      rows.push(...measured.rows);

      if (summarize) {
        rows.push({ path: pathArg, size: measured.size });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`du: cannot read '${pathArg}': ${message}\n`);
      exitCode = 1;
    }
  }

  if (!running) return 130;

  if (cmd.json) {
    const result: DuResult = {
      entries: rows,
      ...(flags.total ? { total } : {}),
    };
    await cmd.writeJSON(result);
  } else {
    const formatSize = (size: number) => flags['human-readable'] ? humanizeSize(size) : size.toString();
    for (const row of rows) {
      await cmd.writeLn(`${formatSize(row.size)}\t${row.path}`);
    }
    if (flags.total) {
      await cmd.writeLn(`${formatSize(total)}\ttotal`);
    }
  }

  return exitCode;
};

du.spec = {
  name: 'du',
  effect: 'read' as const,
  description: 'Estimate file usage in node structures',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'one or more structures to measure (default: .)',
    },
  ],
  flags: [
    { name: 'c', type: 'bool' as const, description: 'print a grand total' },
    { name: 'h', type: 'bool' as const, description: 'print sizes in units of 1024 (e.g. 1.5 KB)' },
    { name: 's', type: 'bool' as const, description: 'print only a total for each argument' },
  ],
  examples: [
    'du -sh /archive/albums/Exempelalbum_2019',
  ],
  returns: 'the size of each path, and a total with -c.',
};
