/**
 * Unlisted trees: what the views of the whole library leave out.
 *
 * A directory whose `unlisted` attr is true holds what is not part of the library yet, such as a
 * staging area of files still to sort. A library view (search's feed, its facets and its
 * candidates; the media a module lists across the archive) leaves out everything at or under one,
 * and a view that names a place inside one (`search --within` it) lists that place as usual.
 *
 * The roots are found with administrative access: leaving rows out reveals nothing, and one
 * kept list serves every caller, until a directory is created or changed with the marker, or
 * moved or removed (`keptPerVfs`).
 */

import { ADMIN_ACCESS } from '../access/constants.ts';
import { keptPerVfs } from '../kept-per-vfs.ts';
import type { NodeId } from '../../vfs/node.ts';
import type { ModuleVFS } from '../../vfs/node-vfs.ts';
import type { NodeQueryCursor } from '../../vfs/query.ts';
import type { NodeEvent } from '../../vfs/types.ts';
import { UNLISTED_ATTR } from '../../vfs/types/directory.ts';

export { UNLISTED_ATTR };

/** Unlisted directories read per query. */
const PAGE = 1000;

/** Whether `path` is one of `roots` or lies under one. */
export const isUnlistedPath = (roots: readonly string[], path: string): boolean => roots.some((root) => path === root || path.startsWith(`${root}/`));

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
export const unlistedIds = async (vfs: ModuleVFS, ids: NodeId[]): Promise<Set<NodeId>> => {
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
const readRoots = async (vfs: ModuleVFS): Promise<string[]> => {
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

const keptRoots = keptPerVfs({ read: readRoots, nodeTypes: ['directory'], changes: changesRoots });

/**
 * The absolute paths of the unlisted directories, sorted, leaving out one that lies under
 * another. Read once and kept (see the file's comment).
 */
export const unlistedRoots = async (vfs: ModuleVFS): Promise<readonly string[]> => await keptRoots(vfs);
