/**
 * trash — the reader's trash, `$HOME/.trash`, laid out as `lib/trash` makes it: an entry directory
 * per trashed node, or a batch of them.
 *
 *   trash put [--batch [<id>]] [--label <text>] <path>...      move nodes into the trash
 *   trash list                                                what is in it, newest first
 *   trash restore <id | batch | batch/entry>... [--limit n]   put entries back where they were
 *   trash empty [<id>...] [--older-than <days>] [--all]
 *
 * `empty --all` (an administrator's) empties every user's trash, which is what the trash-purger
 * service runs.
 */

import { basename, dirname, join, resolve } from '@std/path';
import { monotonicUlid } from '@std/ulid';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { isAdmin } from '../../../../lib/access/mod.ts';
import type { TrashEntry, TrashPutResult, TrashRestoreResult } from '../../../../lib/api/mod.ts';
import { HOMES_PATH, USER_TRASH_DIR } from '../../../../lib/paths.ts';
import { type BatchAttrs, directories, entriesIn, ENTRY_LIMIT, type EntryAttrs, freeName, isEntryId, namesIn, trashPut } from '../../../../lib/trash/mod.ts';
import { NodeAlreadyExistsError, type NodeEntry, NodeNotFoundError } from '../../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const USAGE = 'Usage: trash <put|list|restore|empty> [<path>|<id>...] [--batch [<id>]] [--label <text>] [--limit <n>] [--older-than <days>] [--all]';

/** How often a restore picks a new name for an entry whose name was taken while it moved. */
const RESTORE_ROUNDS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The rows of the trash at `trashPath`, newest first: one per entry, one per batch; none when it does not exist. */
async function readTrash(cmd: Command, trashPath: string): Promise<TrashEntry[]> {
  let dirs;
  try {
    dirs = (await cmd.sys.vfs.children<EntryAttrs & BatchAttrs>(cmd.access, trashPath)).filter((dir) => dir.node.type === NODE_TYPE_DIRECTORY);
  } catch {
    return [];
  }
  const entries = dirs.filter((dir) => dir.node.attrs.batch !== true);
  const insides = entries.length > 0 ? await cmd.sys.vfs.childrenMany(cmd.access, entries.map((dir) => join(trashPath, dir.name))) : [];

  const rows: TrashEntry[] = [];
  entries.forEach((dir, i) => {
    const listed = insides[i];
    const inside = listed.status === 'fulfilled' ? listed.value[0] : undefined;
    if (!inside) return;
    rows.push({
      id: dir.name,
      name: inside.name,
      origPath: dir.node.attrs.origPath ?? '',
      path: join(trashPath, dir.name, inside.name),
      trashedAt: dir.node.attrs.trashedAt ?? '',
      type: inside.node.type,
      ...(typeof inside.node.attrs.mimetype === 'string' ? { mimetype: inside.node.attrs.mimetype } : {}),
    });
  });
  for (const dir of dirs) {
    if (dir.node.attrs.batch !== true) continue;
    const label = dir.node.attrs.label;
    rows.push({
      id: dir.name,
      name: label ?? dir.name,
      origPath: '',
      path: join(trashPath, dir.name),
      trashedAt: dir.node.attrs.trashedAt ?? '',
      type: 'batch',
      count: dir.childCount,
      ...(label !== undefined ? { label } : {}),
    });
  }
  return rows.toSorted((a, b) => b.trashedAt.localeCompare(a.trashedAt));
}

/** One entry to restore: the id it is restored by, its directory, the node in it and where that came from. */
type Restorable = { id: string; dir: string; name?: string; origPath: string };

/**
 * The entry directory of each of `entries` as a VFS entry, by its directory's path: the
 * directories holding them (the trash, a batch) each resolved once, the entries read from their
 * child edges.
 */
async function entryDirs(cmd: Command, entries: Restorable[]): Promise<Map<string, NodeEntry>> {
  const byHolder = new Map<string, string[]>();
  for (const entry of entries) byHolder.set(dirname(entry.dir), [...byHolder.get(dirname(entry.dir)) ?? [], basename(entry.dir)]);
  const found = new Map<string, NodeEntry>();
  for (const [holder, names] of byHolder) {
    const holderEntry = await cmd.sys.vfs.resolveEntry(cmd.access, holder, { write: true });
    for (const [name, entry] of await entriesIn(cmd.sys.vfs, cmd.access, holderEntry, names)) found.set(join(holder, name), entry);
  }
  return found;
}

/**
 * Move each of `entries` back to where it came from, under its old name or a numbered one beside
 * it, in one `renameMany`; a name taken while it moved is chosen again. The entry directories left
 * empty are removed in one `unlinkMany`.
 */
async function restoreEntries(cmd: Command, entries: Restorable[]): Promise<{ restored: TrashRestoreResult['restored']; failed: string[] }> {
  const { vfs } = cmd.sys;
  const restored: TrashRestoreResult['restored'] = [];
  const failed: string[] = [];
  const emptied: string[] = [];

  let pending = entries.filter((entry) => {
    if (entry.name === undefined) emptied.push(entry.dir);
    return entry.name !== undefined;
  });
  const dirs = await entryDirs(cmd, pending);
  const directory = directories(vfs, cmd.access);
  for (let round = 0; pending.length > 0; round++) {
    // The names taken beside each destination, from one read of their child edges.
    const used = await namesIn(vfs, cmd.access, pending.map((entry) => dirname(entry.origPath)));

    const moves: { entry: Restorable; to: string; move: { fromParent: NodeEntry; fromName: string; toParent: NodeEntry; toName: string } }[] = [];
    for (const entry of pending) {
      const parent = dirname(entry.origPath);
      const from = dirs.get(entry.dir);
      const toParent = used.has(parent) ? await directory(parent).catch(() => undefined) : undefined;
      if (!toParent) {
        failed.push(`${entry.id}: ${parent} is gone`);
        continue;
      }
      if (!from) {
        failed.push(`${entry.id}: not in the trash`);
        continue;
      }
      const name = freeName(basename(entry.origPath), used.get(parent)!);
      used.get(parent)!.add(name);
      moves.push({ entry, to: join(parent, name), move: { fromParent: from, fromName: entry.name!, toParent, toName: name } });
    }

    const settled = await vfs.renameMany(cmd.access, moves.map(({ move }) => move), { failIfExists: true, relink: false });
    pending = [];
    settled.forEach((outcome, i) => {
      const { entry, to } = moves[i];
      if (outcome.status === 'fulfilled') {
        restored.push({ id: entry.id, path: to });
        emptied.push(entry.dir);
      } else if (outcome.reason instanceof NodeAlreadyExistsError && round < RESTORE_ROUNDS) {
        pending.push(entry);
      } else {
        failed.push(`${entry.id}: ${messageOf(outcome.reason)}`);
      }
    });
  }

  const unlinked = await vfs.unlinkMany(cmd.access, emptied);
  unlinked.forEach((outcome, i) => {
    if (outcome.status === 'rejected') failed.push(`${emptied[i]}: ${messageOf(outcome.reason)}`);
  });
  return { restored, failed };
}

export const trash = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { string: ['older-than', 'batch', 'label', 'limit'], boolean: ['all'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const [sub, ...rest] = flags._.map(String);
  const home = cmd.env.HOME;
  const { vfs } = cmd.sys;
  const fail = async (message: string): Promise<number> => {
    await cmd.writeError(`trash: ${message}\n`);
    return 1;
  };

  if (!sub) return await fail(USAGE);
  // Emptying every trash is a service's job and needs no home of its own.
  const everyone = sub === 'empty' && flags.all;
  if (!everyone && (!home || home === '/')) return await fail('no home directory (log in first)');
  const trashPath = join(home ?? '/', USER_TRASH_DIR);

  try {
    if (sub === 'list') {
      const entries = await readTrash(cmd, trashPath);
      if (cmd.json) await cmd.writeJSON(entries satisfies TrashEntry[]);
      else {
        for (const entry of entries) {
          const what = entry.type === 'batch' ? `${entry.count} entries${entry.label ? `: ${entry.label}` : ''}` : entry.origPath;
          await cmd.writeLn(`${entry.id}  ${entry.trashedAt}  ${what}`);
        }
      }
      return 0;
    }

    if (sub === 'put') {
      // `--batch` takes an id when one follows; what follows otherwise is the first path.
      const batchFlag = typeof flags.batch === 'string' ? flags.batch : undefined;
      const batchId = batchFlag === undefined ? undefined : isEntryId(batchFlag) ? batchFlag : monotonicUlid();
      const paths = batchFlag && !isEntryId(batchFlag) ? [batchFlag, ...rest] : rest;
      const label = typeof flags.label === 'string' && flags.label !== '' ? flags.label : undefined;
      if (label !== undefined && batchId === undefined) return await fail('--label names a batch, so it needs --batch');

      const result = await trashPut(vfs, cmd.access, home!, paths.map((arg) => resolve(cmd.cwd, arg)), { batchId, label });
      if (cmd.json) await cmd.writeJSON(result satisfies TrashPutResult);
      else if (batchId !== undefined) await cmd.writeLn(`Trashed ${result.entries.length} into batch ${batchId}`);
      else for (const entry of result.entries) await cmd.writeLn(`Trashed ${entry.origPath} (${entry.id})`);
      return 0;
    }

    if (sub === 'restore') {
      if (rest.length === 0) return await fail('restore needs at least one entry id');
      const limit = flags.limit === undefined ? undefined : Number(flags.limit);
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) return await fail('--limit takes a whole number above 0');

      // Every id is read before anything moves, so a mistyped one changes nothing.
      const entries: Restorable[] = [];
      const batches = new Set<string>();
      for (const ref of new Set(rest)) {
        const parts = ref.split('/');
        if (parts.length > 2 || parts.some((part) => part === '' || part === '.' || part === '..')) return await fail(`${ref}: not in the trash`);
        const [top, inner] = parts;
        const topPath = join(trashPath, top);
        const node = await vfs.get<EntryAttrs & BatchAttrs>(cmd.access, topPath).catch(() => undefined);
        if (node?.type !== NODE_TYPE_DIRECTORY || (inner !== undefined && node.attrs.batch !== true)) return await fail(`${ref}: not in the trash`);

        if (node.attrs.batch === true && inner === undefined) {
          const page = await vfs.children<EntryAttrs>(cmd.access, topPath, { childLinks: true, ...(limit !== undefined ? { page: { limit } } : {}) });
          for (const entry of page) {
            if (entry.node.type !== NODE_TYPE_DIRECTORY) continue;
            entries.push({ id: `${top}/${entry.name}`, dir: join(topPath, entry.name), name: entry.children?.[0]?.name, origPath: entry.node.attrs.origPath ?? '' });
          }
          batches.add(topPath);
          continue;
        }

        const dir = inner === undefined ? topPath : join(topPath, inner);
        const entry = inner === undefined ? node : await vfs.get<EntryAttrs>(cmd.access, dir).catch(() => undefined);
        if (!entry?.attrs.origPath) return await fail(`${ref}: not in the trash`);
        const [inside] = await vfs.children(cmd.access, dir);
        if (!inside) return await fail(`${ref}: not in the trash`);
        entries.push({ id: ref, dir, name: inside.name, origPath: entry.attrs.origPath });
        if (inner !== undefined) batches.add(topPath);
      }

      // An entry named twice, alone and with its batch, is restored once.
      const { restored, failed } = await restoreEntries(cmd, [...new Map(entries.map((entry) => [entry.dir, entry])).values()]);

      // A batch goes once its last entry has.
      let remaining = 0;
      for (const batchPath of batches) {
        const left = await vfs.childCount(cmd.access, batchPath, { all: true });
        if (left === 0) await vfs.unlink(cmd.access, batchPath, trashPath);
        remaining += left;
      }

      if (failed.length > 0) return await fail(`${failed.length} of ${entries.length} were not restored; the first, ${failed[0]}`);
      if (cmd.json) await cmd.writeJSON({ restored, ...(batches.size > 0 ? { remaining } : {}) } satisfies TrashRestoreResult);
      else {
        for (const entry of restored) await cmd.writeLn(`Restored ${entry.path}`);
        if (remaining > 0) await cmd.writeLn(`${remaining} left in the trash`);
      }
      return 0;
    }

    if (sub === 'empty') {
      const days = flags['older-than'] === undefined ? undefined : Number(flags['older-than']);
      if (days !== undefined && !(Number.isFinite(days) && days >= 0)) return await fail('--older-than takes a number of days');
      if (flags.all && !isAdmin(cmd.access)) return await fail('--all empties every trash, which only an administrator may');

      const trashes = flags.all ? (await vfs.children(cmd.access, HOMES_PATH)).map((home) => join(HOMES_PATH, home.name, USER_TRASH_DIR)) : [trashPath];
      const cutoff = days === undefined ? undefined : Date.now() - days * DAY_MS;
      const only = rest.length > 0 ? new Set(rest) : undefined;

      // Every entry chosen, of every trash, goes in one recursive `unlinkMany`: their subtrees are
      // emptied together rather than one small tree at a time.
      const entries: string[] = [];
      const inner: string[] = [];
      for (const path of trashes) {
        let dirs;
        try {
          dirs = await vfs.children<EntryAttrs & BatchAttrs>(cmd.access, path);
        } catch {
          continue;
        }
        const chosen = new Set<string>();
        for (const dir of dirs) {
          if (dir.node.type !== NODE_TYPE_DIRECTORY) continue;
          if (only && !only.has(dir.name)) continue;
          if (cutoff !== undefined && !(Date.parse(dir.node.attrs.trashedAt ?? '') < cutoff)) continue;
          entries.push(join(path, dir.name));
          chosen.add(dir.name);
        }

        // One entry of a batch, by the id `put` gave it, unless its whole batch goes.
        for (const ref of only ?? []) {
          const [top, name, ...more] = ref.split('/');
          if (name === undefined || more.length > 0 || [top, name].some((part) => part === '' || part === '.' || part === '..')) continue;
          if (!chosen.has(top)) inner.push(join(path, top, name));
        }
      }

      let removed = 0;
      const failed: string[] = [];
      const settle = (paths: string[], outcomes: PromiseSettledResult<boolean>[]) => {
        outcomes.forEach((outcome, i) => {
          if (outcome.status === 'fulfilled') removed++;
          else if (!(outcome.reason instanceof NodeNotFoundError)) failed.push(`${paths[i]}: ${messageOf(outcome.reason)}`);
        });
      };
      settle(entries, await vfs.unlinkMany(cmd.access, entries, { recursive: true }));
      settle(inner, await vfs.unlinkMany(cmd.access, inner, { recursive: true }));

      // A batch goes with its last entry.
      for (const batchPath of new Set(inner.map((path) => dirname(path)))) {
        try {
          if ((await vfs.childCount(cmd.access, batchPath, { all: true })) === 0) await vfs.unlink(cmd.access, batchPath, dirname(batchPath));
        } catch (error) {
          if (!(error instanceof NodeNotFoundError)) failed.push(`${batchPath}: ${messageOf(error)}`);
        }
      }

      if (failed.length > 0) return await fail(`${failed.length} were not removed; the first, ${failed[0]}`);
      if (cmd.json) await cmd.writeJSON({ removed });
      else await cmd.writeLn(`Removed ${removed} from the trash`);
      return 0;
    }

    return await fail(`unknown subcommand '${sub}'\n${USAGE}`);
  } catch (error) {
    return await fail(messageOf(error));
  }
};

trash.spec = {
  name: 'trash',
  effect: 'write' as const,
  description: "Move nodes into the reader's trash, alone or as one batch, list it, restore entries, or empty it",
  args: [
    { name: 'subcommand', type: 'string' as const, description: 'put | list | restore | empty' },
    {
      name: 'items',
      type: 'path' as const,
      variadic: true,
      description: `put: paths to trash, at most ${ENTRY_LIMIT}; restore and empty: entry ids, batch ids, or <batch>/<entry> for one entry of a batch`,
    },
  ],
  flags: [
    { name: 'batch', type: 'string' as const, description: `put: into one batch, the one with this id or, with no id, a new one (at most ${ENTRY_LIMIT} entries)` },
    { name: 'label', type: 'string' as const, description: 'put: what the batch is called in the trash' },
    { name: 'limit', type: 'number' as const, description: 'restore: at most this many entries of each batch named' },
    { name: 'older-than', type: 'number' as const, description: 'empty: only entries trashed more than this many days ago' },
    { name: 'all', type: 'bool' as const, description: "empty: every user's trash (administrators)" },
  ],
  examples: [
    'trash put /archive/albums/Exempelalbum/files/IMG_0001.jpg',
    "trash put --batch --label 'Copies of a sailboat' /archive/albums/Exempelalbum/files/IMG_0002.jpg /archive/albums/Exempelalbum/files/IMG_0003.jpg",
    'trash list',
    'trash restore 01J9Z8Q4R7XKD3V5B2N6M0PA1C --limit 500',
    'trash empty --older-than 30',
  ],
  returns:
    'put: the entries made and their batch (TrashPutResult); list: TrashEntry[], a batch as one row; restore: where each went, and what is left of the batches named (TrashRestoreResult); empty: how many were removed.',
};
