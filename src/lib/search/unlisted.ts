/**
 * Unlisted trees: what the views of the whole library leave out.
 *
 * A directory whose `unlisted` attr is true holds what is not part of the library yet, such as a
 * staging area of files still to sort. A library view (search's feed, its facets and its
 * candidates; the media a module lists across the archive) leaves out everything at or under one,
 * and a view that names a place inside one (`search --within` it) lists that place as usual.
 *
 * The roots are found with administrative access: leaving rows out reveals nothing, and one
 * cached list serves every caller. They are kept per VFS until a
 * directory is created or changed with the marker, or moved or removed, and for `CACHE_MS` at
 * most, which covers a write the VFS never announced.
 */

import { ADMIN_ACCESS } from '../access/constants.ts';
import type { NodeId } from '../../vfs/node.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import type { NodeQueryCursor } from '../../vfs/query.ts';
import type { NodeEvent } from '../../vfs/types.ts';
import { UNLISTED_ATTR } from '../../vfs/types/directory.ts';

export { UNLISTED_ATTR };

/** How long the roots are kept when no change is seen. */
const CACHE_MS = 60_000;

/** Unlisted directories read per query. */
const PAGE = 1000;

type Cache = {
  /** Resolves once the VFS's changes are watched, whether or not it can announce them. */
  watching: Promise<void>;
  roots?: Promise<string[]>;
  at: number;
};

const caches = new WeakMap<NodeVFS, Cache>();

/** Whether `path` is one of `roots` or lies under one. */
export const isUnlistedPath = (roots: readonly string[], path: string): boolean => roots.some((root) => path === root || path.startsWith(`${root}/`));

/**
 * The absolute paths of the unlisted directories, sorted, leaving out one that lies under
 * another. Read once and kept (see the file's comment).
 */
export const unlistedRoots = async (vfs: NodeVFS): Promise<readonly string[]> => {
  let cache = caches.get(vfs);
  if (!cache) {
    const entry: Cache = {
      at: 0,
      watching: watch(vfs, () => {
        entry.roots = undefined;
      }),
    };
    caches.set(vfs, cache = entry);
  }
  await cache.watching;
  if (cache.roots && Date.now() - cache.at > CACHE_MS) cache.roots = undefined;
  if (!cache.roots) {
    const reading = readRoots(vfs);
    cache.roots = reading;
    cache.at = Date.now();
    reading.catch(() => {
      if (cache.roots === reading) cache.roots = undefined;
    });
  }
  return await cache.roots;
};

/**
 * The roots a view over `within` leaves out, the whole archive when it is undefined: every root
 * inside it. A view at or under a root names that tree, and leaves nothing out.
 */
export const unlistedWithin = (roots: readonly string[], within?: string): string[] => {
  if (within === undefined || within === '/') return [...roots];
  if (isUnlistedPath(roots, within)) return [];
  return roots.filter((root) => root.startsWith(`${within}/`));
};

/**
 * Which of `ids`, files or directories, lie in an unlisted tree: for a view that holds nodes by id,
 * such as the files above a map's positions, and would rather not resolve each one.
 *
 * Read the cheaper way round: while the trees hold fewer nodes than were asked about (counted up
 * to that many), their members' ids, one aggregate per tree; otherwise the ids' parents, in one
 * read, and the paths of the distinct parents, which a batch of pictures shares few of.
 */
export const unlistedIds = async (vfs: NodeVFS, ids: NodeId[]): Promise<Set<NodeId>> => {
  const asked = new Set(ids);
  const roots = await unlistedRoots(vfs);
  if (roots.length === 0 || asked.size === 0) return new Set();

  let held = 0;
  for (const root of roots) {
    if (held > asked.size) break;
    held += await vfs.countWithin(ADMIN_ACCESS, root, asked.size + 1 - held).catch(() => 0);
  }
  if (held <= asked.size) {
    const hidden = new Set<NodeId>();
    for (const root of roots) {
      const members = await vfs.aggregate(ADMIN_ACCESS, { within: root, group: [{ column: 'id' }] }).catch(() => []);
      for (const bucket of members) if (asked.has(bucket.key[0])) hidden.add(bucket.key[0]);
    }
    return hidden;
  }

  const links = await vfs.getParentLinksByIds(ADMIN_ACCESS, [...asked]);
  const parents = new Set<NodeId>();
  for (const list of links.values()) for (const link of list) parents.add(link.parentId);
  const paths = await vfs.resolveIdPaths(ADMIN_ACCESS, [...parents]);
  const unlisted = new Set([...parents].filter((parent) => (paths.get(parent) ?? []).some((path) => isUnlistedPath(roots, path))));
  return new Set([...links].filter(([, list]) => list.some((link) => unlisted.has(link.parentId))).map(([id]) => id));
};

/** Every unlisted directory's path, a page at a time, without those under another. */
const readRoots = async (vfs: NodeVFS): Promise<string[]> => {
  const found: string[] = [];
  let after: NodeQueryCursor | undefined;
  for (;;) {
    const page = await vfs.query(ADMIN_ACCESS, {
      types: ['directory'],
      where: [{ ref: UNLISTED_ATTR, op: 'eq', value: true }],
      ...(after ? { after } : {}),
      limit: PAGE,
    });
    found.push(...page.map((entry) => entry.absPath));
    if (page.length < PAGE) break;
    after = { value: null, id: page[page.length - 1].id };
  }
  const roots: string[] = [];
  for (const path of [...new Set(found)].sort()) if (!isUnlistedPath(roots, path)) roots.push(path);
  return roots;
};

/** Whether `event` can change the roots or their paths: the marker set or cleared, a directory moved or removed. */
const changesRoots = (event: NodeEvent): boolean => {
  if (event.type === 'moved' || event.type === 'deleted') return true;
  return event.node.attrs[UNLISTED_ATTR] !== event.previousNode?.attrs[UNLISTED_ATTR];
};

/** Call `changed` after a directory event that `changesRoots`, when the VFS announces its changes. */
const watch = async (vfs: NodeVFS, changed: () => void): Promise<void> => {
  if (!vfs.subscribe) return;
  await vfs.subscribe(() => ADMIN_ACCESS, (event) => {
    if (changesRoots(event)) changed();
  }, { nodeTypes: ['directory'], eventTypes: ['created', 'updated', 'moved', 'deleted'] });
};
