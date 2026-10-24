import { basename, dirname, join } from '@std/path';
import { isPinned } from '../../../../../lib/access/mod.ts';
import type { Access } from '../../../../../lib/access/mod.ts';
import type { ModeACL } from '../../../../../lib/mode/mod.ts';
import { assertAccess } from '../../../../../vfs/mod.ts';
import type { Node, NodeAttrsUpdate, NodeEntry, NodeId, NodePath, NodePropsUpdate, NodeResolveOptions, NodeVFS } from '../../../../../vfs/mod.ts';

/** What one node in the subtree could not be given. */
type SubtreeFailure = {
  path: NodePath;
  message: string;
};

export type SubtreeResult = {
  /** Nodes written, the root included. */
  updated: number;
  /** Nodes left alone because they hold their own access, subtree and all. */
  pinned: number;
  /** Nodes not descended into because something else is mounted there. */
  skipped: number;
  failed: number;
  failures: SubtreeFailure[];
};

/** What the walk writes. */
type SubtreeChange = {
  /** Given to the root and to every node below it the walk keeps. */
  props?: NodePropsUpdate;
  /**
   * Each written node's access list, worked out from the list it has: an entry added to or
   * dropped from every node leaves the rest of each node's own list as it was.
   */
  acl?: (current: readonly ModeACL[]) => ModeACL[];
  /** Each written node's mode, worked out from the mode it has: `chmod -r o-rw` keeps each node's other bits. */
  mode?: (current: number) => number;
  /** Given to the root alone: a pin is a statement about the node it is set on. */
  rootAttrs?: NodeAttrsUpdate;
};

type SubtreeOptions = {
  /** Descend below the root. Off, only the root is written. */
  recursive?: boolean;
  /**
   * Ctrl-C: stops the walk between batches rather than the process. Nothing is written after it
   * aborts, the root included, and the nodes not reached are not counted as failed.
   */
  signal?: AbortSignal;
  /** Failures kept for reporting; the counts stay exact past this. */
  maxFailures?: number;
  /**
   * How the **named** node is resolved — the command's own `-L`. Descendants are not resolved at
   * all: each is written as the node its directory lists, so a softlink is written as itself.
   */
  rootResolve?: NodeResolveOptions;
  /**
   * The authority the writes are made with, when it is more than `access` has
   * (`share-set --default-owner`). Every node written is still one `access` may write.
   */
  writer?: Access;
};

const DEFAULT_MAX_FAILURES = 20;

/** A directory holding fewer roots than this is not listed for them: each is resolved by its path. */
const LIST_MIN_ROOTS = 4;

/**
 * A directory is listed for its roots only when it holds at most this many children per root: a
 * path walk and a read per root cost about what a few dozen listed children do.
 */
const LIST_RATIO = 16;

/** What one node is written with: the change's props, and its own list and mode edited when the change edits them. */
const propsFor = (change: SubtreeChange, own: { acl?: readonly ModeACL[]; mode?: number }): NodePropsUpdate | undefined => {
  if (!change.acl && !change.mode) return change.props;
  return {
    ...change.props,
    ...(change.acl ? { acl: change.acl(own.acl ?? []) } : {}),
    ...(change.mode && own.mode !== undefined ? { mode: change.mode(own.mode) } : {}),
  };
};

/**
 * Apply a props change to a node and, with `recursive`, to everything below it.
 *
 * Three things it deliberately does not do:
 *
 * - **It never follows a softlink.** Children come from the hierarchy, so a
 *   softlink child is the softlink node itself, and it is written as that node
 *   rather than resolved by path. An album whose members are links to media
 *   elsewhere must not have that media rewritten from here.
 * - **It stops at a mount point.** `children` reports a mount point as the
 *   mounted root, so descending would walk into another store's tree. Those
 *   paths are recognised from `vfs.mounts` and left alone.
 * - **It stops at a pinned node.** Neither the node nor anything below it is
 *   written, which is what lets one photo stay private inside a shared album.
 *   The root is exempt: a pin defends against a change from above, not against
 *   being the subject of one.
 *
 * The writes go through `updateMany`, which takes them a batch of locks and one
 * transaction at a time — never one transaction for the subtree.
 *
 * A descendant that cannot be written is counted and the walk continues, the
 * way `chmod -R` does over files someone else owns. A failure on the **root**
 * throws instead — there is nothing useful left to do, and the caller reports
 * it as the command failing.
 */
export const applySubtree = async (
  vfs: NodeVFS,
  access: Access,
  rootPath: NodePath,
  change: SubtreeChange,
  opts: SubtreeOptions = {},
): Promise<SubtreeResult> => {
  const [outcome] = await applySubtrees(vfs, access, [rootPath], change, opts);
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
};

/**
 * `applySubtree` for many roots given the same change, in one walk: a level of every subtree is
 * one `childrenMany`, and the writes are batched across all of them. Each root is written after
 * its subtree, and a root that does not resolve, or that the caller may not write, fails alone
 * with nothing of its subtree written.
 *
 * @returns one result per root, in order, counting what its own walk reached.
 */
export const applySubtrees = async (
  vfs: NodeVFS,
  access: Access,
  rootPaths: NodePath[],
  change: SubtreeChange,
  opts: SubtreeOptions = {},
): Promise<PromiseSettledResult<SubtreeResult>[]> => {
  const { signal } = opts;
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;

  const results: SubtreeResult[] = rootPaths.map(() => ({ updated: 0, pinned: 0, skipped: 0, failed: 0, failures: [] }));
  const fail = (root: number, path: NodePath, error: unknown, nodes = 1) => {
    const result = results[root];
    result.failed += nodes;
    if (result.failures.length < maxFailures) {
      result.failures.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  };

  const outcomes: PromiseSettledResult<SubtreeResult>[] = new Array(rootPaths.length);
  const resolved = await resolveRoots(vfs, access, rootPaths, opts.rootResolve);
  const roots: { index: number; entry: NodeEntry; node: Node }[] = [];
  resolved.forEach((outcome, index) => {
    if (outcome.status === 'rejected') outcomes[index] = outcome;
    else roots.push({ index, ...outcome.value });
  });

  // ----- 1. Read the whole tree, before a single node is written -----
  //
  // Collecting first is not tidiness, it is correctness: the walk has to *read*
  // every directory it descends into, and the change it is applying can take
  // that read away. A user relying on the other-bits to reach a folder who sets
  // it to `0770` locks themselves out of their own operation half way down, and
  // the change silently stops there. Reading the tree under the permissions
  // that existed when the command was issued removes the hazard entirely, and
  // makes the pin and mount decisions consistent for the same reason.
  //
  // The tree is read a level at a time, every directory of a level in one
  // `childrenMany`, and each node is kept as the entry its directory listed it
  // under rather than as a path: the writes then resolve nothing, and cannot
  // lose their way through a directory the change has already closed. Each node
  // is counted to the root whose walk reached it first.
  // `count` is how many children a directory holds, those the caller may not read included.
  type Target = { root: number; entry: NodeEntry; path: NodePath; acl?: ModeACL[]; mode?: number; count?: number };
  const targets: Target[] = [];

  if (opts.recursive) {
    const mounted = new Set(vfs.mounts(access).map((mount) => mount.point.absPath));

    // A node can hang under more than one parent, so the same node can be
    // reached twice in one subtree — and, with a hard link back up, endlessly.
    // Writing it once is also the correct answer: there is one node, not one
    // per path.
    const seen = new Set<NodeId>(roots.map((root) => root.node.id));

    const counts = await Promise.all(roots.map((root) => vfs.childCount(access, root.entry, { all: true }).catch(() => undefined)));
    let level: Target[] = roots.map((root, i) => ({ root: root.index, entry: root.entry, path: rootPaths[root.index], count: counts[i] }));

    while (level.length > 0 && !signal?.aborted) {
      const listings = await vfs.childrenMany(access, level.map((dir) => dir.entry), { all: true });
      const next: Target[] = [];

      for (const [i, listing] of listings.entries()) {
        const dir = level[i];

        if (listing.status === 'rejected') {
          // Unreadable directory: report it once and leave its subtree alone.
          fail(dir.root, dir.path, listing.reason);
          continue;
        }

        // A listing leaves out the children the caller may not read. They are left as they are,
        // and counted, so the answer does not read as though the whole subtree changed.
        const hidden = (dir.count ?? 0) - listing.value.length;
        if (hidden > 0) {
          fail(dir.root, dir.path, `${hidden} ${hidden === 1 ? 'child' : 'children'} the caller may not read left unchanged`, hidden);
        }

        for (const child of listing.value) {
          const absPath = join(dir.entry.absPath, child.name);

          if (mounted.has(absPath)) {
            results[dir.root].skipped++;
            continue;
          }

          if (isPinned(child.node)) {
            results[dir.root].pinned++;
            continue;
          }

          if (seen.has(child.node.id)) {
            continue;
          }
          seen.add(child.node.id);

          // Not a mount point, so the child lives where its directory does.
          const target: Target = {
            root: dir.root,
            entry: { id: child.node.id, vfs: dir.entry.vfs, vfsAbsPath: join(dir.entry.vfsAbsPath, child.name), absPath },
            path: join(dir.path, child.name),
            acl: child.node.props.acl,
            mode: child.node.props.mode,
            count: child.childCount,
          };
          targets.push(target);

          if (child.childCount > 0) {
            next.push(target);
          }
        }
      }

      level = next;
    }
  }

  // ----- 2. Write -----
  //
  // Refused up front rather than after the subtree has been rewritten. Failing
  // on the root is the walk failing for that root — it is what the caller aimed
  // at, and there is nothing useful left to do without it — so it must be found
  // before any work, not after.
  const writable = roots.filter((root) => {
    try {
      assertAccess(access, root.node, 'w');
      return true;
    } catch (reason) {
      outcomes[root.index] = { status: 'rejected', reason };
      return false;
    }
  });
  const written = new Set(writable.map((root) => root.index));

  const writer = opts.writer ?? access;
  const guard = opts.writer ? (node: Node) => assertAccess(access, node, 'w') : undefined;

  // Nodes whose props come out the same are written together, so a subtree sharing one list and
  // mode — the usual case — is one batched write, as a change that edits neither always is.
  const batchesOf = <T>(items: T[], own: (item: T) => { acl?: readonly ModeACL[]; mode?: number }) => {
    const batches = new Map<string, { props?: NodePropsUpdate; items: T[] }>();
    for (const item of items) {
      const props = propsFor(change, own(item));
      const key = JSON.stringify([props?.acl ?? null, props?.mode ?? null]);
      const batch = batches.get(key) ?? { props, items: [] };
      batch.items.push(item);
      batches.set(key, batch);
    }
    return [...batches.values()];
  };

  for (const batch of batchesOf(targets.filter((target) => written.has(target.root)), (target) => target)) {
    const settled = await vfs.updateMany(writer, batch.items.map((target) => target.entry), { props: batch.props, guard, signal });

    settled.forEach((outcome, i) => {
      const target = batch.items[i];
      if (outcome.status === 'fulfilled') {
        results[target.root].updated++;
      } else if (!(signal?.aborted && outcome.reason === signal.reason)) {
        // A node someone else owns stops here, not the whole walk.
        fail(target.root, target.path, outcome.reason);
      }
    });
  }

  // **Roots last**, once everything below them has its access: what a root says
  // — and `share-info` reads it — is never ahead of its subtree, and a walk cut
  // short leaves it as it was, ready to be run again.
  if (!signal?.aborted) {
    for (const batch of batchesOf(writable, (root) => root.node.props)) {
      const settled = await vfs.updateMany(writer, batch.items.map((root) => root.entry), { props: batch.props, attrs: change.rootAttrs, guard });
      settled.forEach((outcome, i) => {
        const { index } = batch.items[i];
        if (outcome.status === 'rejected') {
          outcomes[index] = outcome;
          written.delete(index);
        } else {
          results[index].updated++;
        }
      });
    }
  }

  for (const index of written) outcomes[index] = { status: 'fulfilled', value: results[index] };
  return outcomes;
};

/**
 * The roots of a walk with their entries and nodes, as `vfs.get` would read them. A directory
 * holding many of them, and not many more besides, is listed once for all of them, so they cost
 * no path walk each; every other root is resolved by its own path, so a root in a wide directory
 * reads nothing of its siblings. A root that is a softlink to follow, a mount point, or not found
 * in its listing is resolved by its path too, which also says why one fails.
 */
const resolveRoots = async (
  vfs: NodeVFS,
  access: Access,
  paths: NodePath[],
  resolve?: NodeResolveOptions,
): Promise<PromiseSettledResult<{ entry: NodeEntry; node: Node }>[]> => {
  const outcomes: PromiseSettledResult<{ entry: NodeEntry; node: Node }>[] = new Array(paths.length);
  const byPath: number[] = [];

  const dirs = new Map<NodePath, number[]>();
  paths.forEach((path, index) => {
    if (path === '/') {
      byPath.push(index);
      return;
    }
    const indexes = dirs.get(dirname(path));
    if (indexes) indexes.push(index);
    else dirs.set(dirname(path), [index]);
  });

  const candidates = [...dirs].filter(([, indexes]) => indexes.length >= LIST_MIN_ROOTS);
  for (const [, indexes] of dirs) if (indexes.length < LIST_MIN_ROOTS) byPath.push(...indexes);

  const sized = await Promise.allSettled(candidates.map(async ([dir, indexes]) => {
    const entry = await vfs.resolveEntry(access, dir);
    return await vfs.childCount(access, entry, { all: true }) <= LIST_RATIO * indexes.length ? entry : undefined;
  }));
  const listable = candidates.flatMap(([, indexes], i) => {
    const size = sized[i];
    if (size.status === 'fulfilled' && size.value) return [{ indexes, entry: size.value }];
    byPath.push(...indexes);
    return [];
  });

  const mounted = new Set(vfs.mounts(access).map((mount) => mount.point.absPath));
  const listings = await vfs.childrenMany(access, listable.map(({ entry }) => entry));

  for (const [i, { indexes, entry: parent }] of listable.entries()) {
    const listing = listings[i];
    if (listing.status === 'rejected') {
      byPath.push(...indexes);
      continue;
    }
    const children = new Map(listing.value.map((child) => [child.name, child]));
    for (const index of indexes) {
      const path = paths[index];
      const child = children.get(basename(path));
      if (!child || mounted.has(path) || (child.node.props.softlink && !resolve?.readlink)) {
        byPath.push(index);
        continue;
      }
      try {
        assertAccess(access, child.node, 'r');
        const entry: NodeEntry = {
          id: child.node.id,
          vfs: parent.vfs,
          vfsAbsPath: join(parent.vfsAbsPath, child.name),
          absPath: join(parent.absPath || parent.vfsAbsPath, child.name),
        };
        outcomes[index] = { status: 'fulfilled', value: { entry, node: child.node } };
      } catch (reason) {
        outcomes[index] = { status: 'rejected', reason };
      }
    }
  }

  for (const index of byPath) {
    try {
      const entry = await vfs.resolveEntry(access, paths[index], resolve);
      outcomes[index] = { status: 'fulfilled', value: { entry, node: await vfs.get(access, entry) } };
    } catch (reason) {
      outcomes[index] = { status: 'rejected', reason };
    }
  }

  return outcomes;
};
