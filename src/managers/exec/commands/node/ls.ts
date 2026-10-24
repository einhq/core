import { basename, dirname, join, resolve } from '@std/path';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { stampToObject } from '../../../../lib/datetime/mod.ts';
import { getModeString } from '../../../../lib/mode/mode.ts';
import { humanizeSize } from '../../../../lib/utils/humanize-size.ts';
import { GroupAttrs } from '../../../../vfs/types/group.ts';
import { UserAttrs } from '../../../../vfs/types/user.ts';
import { colorer, columns, Table } from '../../../shell/terminal/mod.ts';
import type { NodeChildEntry } from '../../../../vfs/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * One page of `path`'s children: `limit` of them in the store's name order after `after`, the
 * hidden ones left out unless `hidden`. Read until the page is full or the listing ends, so a run
 * of hidden names does not end it early; the last name returned continues it.
 */
const listPage = async (cmd: Command, path: string, opts: { limit: number; after?: string; hidden: boolean; readlink: boolean; childLinks: boolean }) => {
  const page: NodeChildEntry[] = [];
  let after = opts.after;
  for (;;) {
    const read = await cmd.sys.vfs.children(cmd.access, path, { readlink: opts.readlink, childLinks: opts.childLinks, page: { limit: opts.limit, after } });
    page.push(...read.filter(({ name }) => opts.hidden || !name.startsWith('.')));
    if (page.length >= opts.limit || read.length < opts.limit) return page.slice(0, opts.limit);
    after = read[read.length - 1].name;
  }
};

type LsFlags = { l: boolean; a: boolean; A: boolean; r: boolean; L: boolean; C: boolean; h: boolean; '1': boolean; after?: string };

/** The entries `ls` shows for one operand: a directory's children, or those matching a `*` pattern. */
const listOperand = async (cmd: Command, operand: string, flags: LsFlags, limit: number | undefined) => {
  const hasFilter = operand.includes('*');
  const inFilter = hasFilter ? basename(operand) : undefined;
  const path = resolve(cmd.cwd, hasFilter ? dirname(operand) : operand);

  const resolveOpts = {
    readlink: flags.L,
  };

  // A page keeps the store's order, so its last name is where the next one starts.
  let entries = limit !== undefined
    ? await listPage(cmd, path, { limit, after: flags.after, hidden: flags.a || flags.A, readlink: flags.L, childLinks: flags.C })
    : await cmd.sys.vfs.children(cmd.access, path, {
      ...resolveOpts,
      childLinks: flags.C,
      ...(hasFilter && inFilter ? { filter: { name: inFilter } } : {}),
    });

  if (!flags.A) {
    // A page holds children only, so its length and last name keep saying where the next starts.
    if (flags.a && limit === undefined) {
      if (path !== '/') {
        const parentPath = join(path, '..');

        entries.unshift({
          node: await cmd.sys.vfs.get(cmd.access, parentPath, resolveOpts),
          name: '..',
          childCount: await cmd.sys.vfs.childCount(cmd.access, parentPath, resolveOpts),
        });
      }

      entries.unshift({
        node: await cmd.sys.vfs.get(cmd.access, path, resolveOpts),
        name: '.',
        childCount: await cmd.sys.vfs.childCount(cmd.access, path, resolveOpts),
      });
    } else if (!flags.a) {
      entries = entries.filter(({ name }) => !name.startsWith('.'));
    }
  }

  if (flags.r) {
    entries.sort((a, b) => b.name.localeCompare(a.name));
  } else if (limit === undefined) {
    entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  return entries;
};

/** The long listing of `entries`, its owners named from `ucache` and `gcache`. */
const longListing = (cmd: Command, entries: NodeChildEntry[], flags: LsFlags, ucache: Record<number, string>, gcache: Record<number, string>) => {
  const color = colorer(!cmd.tty);
  const table = new Table({
    columns: [
      { name: 'type', align: 'left' },
      { name: 'mode', align: 'left' },
      { name: 'count', align: 'right' },
      { name: 'uid', align: 'left' },
      { name: 'gid', align: 'left' },
      { name: 'size', align: 'right' },
      { name: 'day', align: 'right' },
      { name: 'month', align: 'left' },
      { name: 'year', align: 'right' },
      { name: 'time', align: 'right' },
      { name: 'name', align: 'left' },
      { name: 'extra', align: 'left' },
    ],
  });
  for (const entry of entries) {
    const uid = entry.node.props.uid;
    const gid = entry.node.props.gid;
    const name = entry.name;
    let extra = '';
    const type = color('blue', entry.node.type);

    if (entry.node.props.softlink) {
      extra = ` -> ${entry.node.props.softlink}`;
    }

    const acl = entry.node.props.acl && entry.node.props.acl.length > 0 ? '+' : '';
    const mode = getModeString(entry.node.props.mode).split('').map((c) => {
      if (c === '-') {
        return color('dim', c);
      } else if (c === 'r') {
        return color('yellow', c);
      } else if (c === 'w') {
        return color('red', c);
      } else if (c === 'x') {
        return color('green', c);
      } else if (c === '+') {
        return color('magenta', c);
      }
    }).join('');

    const maxTimestamp = Math.max(entry.node.props.changetime.timestamp, entry.node.props.modtime.timestamp);
    const time = stampToObject(maxTimestamp);

    // Only a file has a size in bytes; for everything else this column is a
    // child count, which -h must leave alone.
    const bytes = entry.node.attrs?.size;
    const size = typeof bytes === 'number' ? (flags.h ? humanizeSize(bytes) : bytes.toString()) : entry.childCount.toString();

    table.addRow({
      type,
      mode: mode + acl,
      count: color('dim', entry.node.props.count.toString()),
      uid: color('yellow', ucache[uid] ?? uid.toString()),
      gid: color('yellow', gcache[gid] ?? gid.toString()),
      size: color('dim', size),
      day: color('blue', time.day),
      month: color('blue', time.month),
      year: color('blue', time.year),
      time: color('blue', `${time.hour}:${time.minute}:${time.second}`),
      name: color('bold', color('white', name)),
      extra: extra ? color('magenta', extra) : '',
    });
  }

  return table.render();
};

export const ls = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    boolean: ['l', 'a', 'A', 'r', 'L', 'C', 'h', '1'],
    string: ['limit', 'after'],
    unknown: collectUnknownFlags(unknown),
  });

  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const operands = flags._.length > 0 ? flags._.map(String) : ['.'];
  const several = operands.length > 1;
  const hasFilter = operands.some((operand) => operand.includes('*'));

  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    await cmd.writeError(`ls: --limit must be a whole number above 0, not '${flags.limit}'\n`);
    return 1;
  }
  if (flags.after !== undefined && limit === undefined) {
    await cmd.writeError('ls: --after continues a page; give --limit too\n');
    return 1;
  }
  if (limit !== undefined && (hasFilter || flags.r)) {
    await cmd.writeError(`ls: --limit pages in name order, so it takes no ${hasFilter ? 'pattern' : '-r'}\n`);
    return 1;
  }
  if (limit !== undefined && several) {
    await cmd.writeError('ls: --limit pages one directory, so it takes one path\n');
    return 1;
  }

  // Like GNU ls, an operand that cannot be listed is reported, the others are still listed, and
  // the exit status is 2.
  let status = 0;
  const listings: Array<{ operand: string; entries: NodeChildEntry[] }> = [];
  for (const operand of operands) {
    try {
      listings.push({ operand, entries: await listOperand(cmd, operand, flags, limit) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`ls: cannot access '${operand}': ${message}\n`);
      status = 2;
    }
  }

  if (cmd.json) {
    const answer = (entries: NodeChildEntry[]) => flags.l ? entries : entries.map(({ name }) => name);
    // One operand answers its listing; several answer each one's listing under the operand.
    if (several) {
      await cmd.writeJSON(Object.fromEntries(listings.map(({ operand, entries }) => [operand, answer(entries)])));
    } else if (listings.length > 0) {
      await cmd.writeJSON(answer(listings[0].entries));
    }
    return status;
  }

  const ucache: Record<number, string> = {};
  const gcache: Record<number, string> = {};

  if (flags.l && listings.some(({ entries }) => entries.length > 0)) {
    try {
      const users = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH);
      for (const user of users) {
        ucache[user.node.attrs.uid] = user.name;
      }
    } catch { /* users not accessible */ }

    try {
      const groups = await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH);
      for (const group of groups) {
        gcache[group.node.attrs.gid] = group.name;
      }
    } catch { /* groups not accessible */ }
  }

  for (const [index, { operand, entries }] of listings.entries()) {
    // Several operands are listed each under its own header, a blank line between them.
    if (several) {
      await cmd.write(`${index > 0 ? '\n' : ''}${operand}:\n`);
    }

    // Nothing to list is no output at all, so `ls … | wc -l` counts 0.
    if (entries.length === 0) continue;

    if (flags.l) {
      await cmd.write(longListing(cmd, entries, flags, ucache, gcache));
    } else {
      const names = entries.map(({ name }) => name);
      await cmd.write((cmd.tty && !flags['1'] ? columns(names, cmd.cols) : names.join('\n')) + '\n');
    }
  }

  return status;
};

ls.spec = {
  name: 'ls',
  effect: 'read' as const,
  description: 'List directory contents',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      variadic: true,
      description: 'paths to list, each under its own header when there are several',
    },
  ],
  flags: [
    { name: 'l', type: 'bool' as const, description: 'use a long listing format' },
    { name: 'a', type: 'bool' as const, description: 'do not ignore entries starting with .' },
    { name: 'A', type: 'bool' as const, description: 'do not ignore entries starting with . except for . and ..' },
    { name: 'r', type: 'bool' as const, description: 'reverse order while sorting' },
    { name: 'L', type: 'bool' as const, description: 'do not follow symbolic links' },
    { name: 'C', type: 'bool' as const, description: "include each entry's own child names (extra lookup, JSON output only)" },
    { name: '1', type: 'bool' as const, description: 'list one entry per line, also on a terminal' },
    { name: 'h', type: 'bool' as const, description: 'with -l, print file sizes in units of 1024 (e.g. 1.5 KB)' },
    { name: 'limit', type: 'string' as const, description: "list one page of this many entries, in the store's name order" },
    { name: 'after', type: 'string' as const, description: 'with --limit, the page after this name: the last one of the page before' },
  ],
  examples: [
    'ls -l /archive/albums/Exempelalbum_2019/files',
    'ls /archive/people',
    'ls -l --limit 200 --after IMG_0412.jpg /home/anna/staging/files/inbox',
  ],
  returns: "the directory's entries; for several paths, an object of each path's entries.",
};
