/**
 * A reader's trash: `<home>/.trash/<entry>/<the trashed node>`, each entry directory carrying where
 * its node came from and when it left. A batch, `<home>/.trash/<batch>/`, holds entries trashed
 * together — a discard of many files — as one row, restored and purged as one.
 *
 * A move, not a copy: the node keeps its id, so its faces, captions and vectors keep pointing at it,
 * and the links to it are left as they are, so they work again once it is restored. Id-to-path
 * resolution leaves out every path inside a trash (`isTrashPath`), which is what takes a trashed
 * node out of every list.
 */

import { basename, dirname, join } from '@std/path';
import { monotonicUlid } from '@std/ulid';
import type { Access } from '../access/mod.ts';
import type { TrashEntry, TrashPutResult } from '../api/mod.ts';
import { isTrashPath, USER_TRASH_DIR } from '../paths.ts';
import type { NodeEntry, NodeVFS } from '../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';

/**
 * Entries one put makes, and one batch holds, at most: a put makes its entry directories in one
 * `createTree` transaction, and a batch is restored or purged as one piece of work.
 */
export const ENTRY_LIMIT = 2_000;

export type EntryAttrs = { origPath?: string; trashedAt?: string };
export type BatchAttrs = { batch?: boolean; label?: string; trashedAt?: string };

/**
 * A put refused or failed part-way; the message is what its caller is told, and a target that did
 * not move gives the reason as `cause`.
 */
export class TrashError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TrashError';
  }
}

/** An entry or batch id, as `trashPut` makes them. */
export const isEntryId = (value: string): boolean => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);

/** `name`, or `name (2).ext`, `name (3).ext`, … — the first not in `used`. */
export const freeName = (name: string, used: Set<string>): string => {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2;; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) return candidate;
  }
};

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The names taken in each of `dirs`, from one read of their child edges; a directory that does not
 * resolve is absent, and one whose edges `access` may not read has none.
 */
export async function namesIn(vfs: NodeVFS, access: Access, dirs: Iterable<string>): Promise<Map<string, Set<string>>> {
  const ids = new Map<string, string>();
  for (const dir of new Set(dirs)) {
    const id = await vfs.get(access, dir).then((node) => node.id, () => undefined);
    if (id !== undefined) ids.set(dir, id);
  }
  const edges = await vfs.getChildLinksByIds(access, [...ids.values()]);
  return new Map([...ids].map(([dir, id]) => [dir, new Set((edges.get(id) ?? []).map((link) => link.name))]));
}

/** Those of `paths` with nothing at them: one read of their directories' edges, and a look at each not among them. */
async function missingOf(vfs: NodeVFS, access: Access, paths: string[]): Promise<string[]> {
  const names = await namesIn(vfs, access, paths.map((path) => dirname(path)));
  const missing: string[] = [];
  for (const path of paths) {
    if (names.get(dirname(path))?.has(basename(path))) continue;
    if (!(await vfs.exists(access, path, { readlink: true }))) missing.push(path);
  }
  return missing;
}

/**
 * `dir`'s children named `names`, as entries of the VFS holding `dir`, from one read of its child
 * edges; a name not there is absent. Only for plain directories the caller made there, which no
 * mount and no softlink stands on, so each is reached from `dir` by name and not resolved alone.
 */
export async function entriesIn(vfs: NodeVFS, access: Access, dir: NodeEntry, names: string[]): Promise<Map<string, NodeEntry>> {
  const links = (await vfs.getChildLinksByIds(access, [dir.id])).get(dir.id) ?? [];
  const ids = new Map(links.map((link) => [link.name, link.id]));
  return new Map(names.flatMap((name) => {
    const id = ids.get(name);
    return id === undefined ? [] : [[name, { id, vfs: dir.vfs, vfsAbsPath: join(dir.vfsAbsPath, name), absPath: join(dir.absPath || dir.vfsAbsPath, name) }] as const];
  }));
}

/** A resolver of directories by path, each resolved once to be written in. */
export function directories(vfs: NodeVFS, access: Access): (path: string) => Promise<NodeEntry> {
  const resolved = new Map<string, Promise<NodeEntry>>();
  return (path) => {
    let entry = resolved.get(path);
    if (!entry) {
      entry = vfs.resolveEntry(access, path, { write: true });
      resolved.set(path, entry);
    }
    return entry;
  };
}

type TrashPutOptions = {
  /** Into this batch: an existing one, which entries are added to, or a new one by this id. */
  batchId?: string;
  /** What the batch is called in the trash; without `batchId` there is no batch to name. */
  label?: string;
};

/**
 * Move `targets`, absolute paths, into the trash under `home` as `access`, one entry each, or
 * into one batch. Nothing moves when a target is missing or already in a trash, or when there are
 * more than `ENTRY_LIMIT`; a target that fails to move leaves no entry behind, and the put then
 * throws, as it does for every refusal (`TrashError`).
 */
export async function trashPut(vfs: NodeVFS, access: Access, home: string, targets: string[], opts: TrashPutOptions = {}): Promise<TrashPutResult> {
  const { batchId, label } = opts;
  const unique = [...new Set(targets)];
  if (unique.length === 0) throw new TrashError('put needs at least one path');
  if (unique.length > ENTRY_LIMIT) throw new TrashError(`a put moves at most ${ENTRY_LIMIT} paths, not ${unique.length}`);
  const inTrash = unique.find((target) => isTrashPath(target));
  if (inTrash) throw new TrashError(`${inTrash}: already in the trash`);
  const missing = await missingOf(vfs, access, unique);
  if (missing.length > 0) throw new TrashError(`${missing[0]}: not found`);

  // Where each comes from, resolved before anything is made.
  const directory = directories(vfs, access);
  const sources = new Map<string, NodeEntry>();
  for (const target of unique) sources.set(target, await directory(dirname(target)));

  const trashPath = join(home, USER_TRASH_DIR);
  const owner = { uid: access.uid, gid: access.gid, mode: 0o700 };
  await vfs.ensure(access, NODE_TYPE_DIRECTORY, home, USER_TRASH_DIR, { props: owner });

  const trashedAt = new Date().toISOString();
  const batchPath = batchId === undefined ? undefined : join(trashPath, batchId);
  let batchIsNew = false;
  if (batchPath !== undefined) {
    if (await vfs.exists(access, batchPath)) {
      const batch = await vfs.get<BatchAttrs>(access, batchPath);
      if (batch.attrs.batch !== true) throw new TrashError(`${batchId}: not a batch`);
      const held = await vfs.childCount(access, batchPath, { all: true });
      if (held + unique.length > ENTRY_LIMIT) {
        throw new TrashError(`a batch holds at most ${ENTRY_LIMIT} entries: ${batchId} has ${held}, and ${unique.length} more would pass that`);
      }
    } else {
      batchIsNew = true;
    }
  }

  const entries = unique.map((target) => ({ id: monotonicUlid(), target, name: basename(target) }));
  const specs = entries.map(({ id, target }) => ({
    type: NODE_TYPE_DIRECTORY,
    name: id,
    props: owner,
    attrs: { origPath: target, trashedAt } satisfies EntryAttrs,
  }));
  if (batchIsNew) {
    const attrs: BatchAttrs = { batch: true, trashedAt, ...(label !== undefined ? { label } : {}) };
    await vfs.createTree(access, trashPath, [{ type: NODE_TYPE_DIRECTORY, name: batchId!, props: owner, attrs, children: specs }]);
  } else {
    await vfs.createTree(access, batchPath ?? trashPath, specs);
    // A batch's retention counts from the last entries put into it.
    if (batchPath !== undefined) await vfs.update(access, batchPath, { attrs: { trashedAt, ...(label !== undefined ? { label } : {}) } });
  }

  const holder = batchPath ?? trashPath;
  const dirs = await entriesIn(vfs, access, await vfs.resolveEntry(access, holder, { write: true }), entries.map(({ id }) => id));
  const settled = await vfs.renameMany(
    access,
    entries.map(({ id, target, name }) => ({ fromParent: sources.get(target)!, fromName: name, toParent: dirs.get(id)!, toName: name })),
    { failIfExists: true, relink: false },
  );

  const made: TrashEntry[] = [];
  const failed: string[] = [];
  const unused: string[] = [];
  let cause: unknown;
  settled.forEach((outcome, i) => {
    const { id, target, name } = entries[i];
    if (outcome.status === 'rejected') {
      failed.push(`${target}: ${messageOf(outcome.reason)}`);
      unused.push(join(holder, id));
      cause ??= outcome.reason;
      return;
    }
    const node = outcome.value.node;
    made.push({
      id: batchId === undefined ? id : `${batchId}/${id}`,
      name,
      origPath: target,
      path: join(holder, id, name),
      trashedAt,
      type: node.type,
      ...(typeof node.attrs.mimetype === 'string' ? { mimetype: node.attrs.mimetype } : {}),
    });
  });
  if (unused.length > 0) {
    await vfs.unlinkMany(access, unused);
    if (batchIsNew && made.length === 0) await vfs.unlink(access, batchPath!, trashPath);
    throw new TrashError(`${failed.length} of ${unique.length} did not move to the trash; the first, ${failed[0]}`, { cause });
  }

  return { entries: made, ...(batchId !== undefined ? { batch: batchId } : {}) };
}
