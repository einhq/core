/**
 * Which processing a folder wants for what lies under it.
 *
 * A directory's `processing` attr lists families of pipeline work by name (`['renditions']`,
 * `['renditions', 'picture-vectors']`); a single name counts as a list of one. The nearest
 * directory carrying it decides for every path under it, a nested one overriding its parent. With
 * no such directory above a path every family is wanted, and an empty list wants none.
 *
 * A pipeline trigger names the family its work belongs to (`wants`), and the engine skips the
 * trigger for a subject whose folder does not want it; a pass that looks for missing work asks
 * the same. A pipeline that names no family runs wherever its trigger says.
 *
 * The folders are found with administrative access, off core's `processing` index, and kept per
 * VFS until a directory is created or changed in the attr, or moved or removed (`keptPerVfs`).
 */

import { ADMIN_ACCESS } from './access/constants.ts';
import { keptPerVfs } from './kept-per-vfs.ts';
import type { ModuleVFS } from '../vfs/node-vfs.ts';
import type { NodeQueryCursor } from '../vfs/query.ts';
import type { NodeEvent } from '../vfs/types.ts';
import { PROCESSING_ATTR } from '../vfs/types/directory.ts';

export { PROCESSING_ATTR };

/** A directory that says which families of work it wants. */
export type ProcessingRoot = { path: string; families: readonly string[] };

/** Directories read per query. */
const PAGE = 1000;

/** The families an attr value names: a list of names, or one name; undefined for anything else. */
export const familiesOf = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') return value ? [value] : undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((name): name is string => typeof name === 'string' && name.length > 0);
};

/** The families the nearest folder at or above `path` names, or undefined when none does. */
export const processingAt = (roots: readonly ProcessingRoot[], path: string): readonly string[] | undefined =>
  roots.find((root) => path === root.path || path.startsWith(root.path === '/' ? '/' : `${root.path}/`))?.families;

/** Whether the folder of `path` wants any of `families`: its nearest setting names one, or there is none. */
export const wantsProcessing = (roots: readonly ProcessingRoot[], path: string, families: readonly string[]): boolean => {
  const wanted = processingAt(roots, path);
  return wanted === undefined || families.some((family) => wanted.includes(family));
};

/** Every directory carrying the attr, nearest first: the deepest paths come first, so the first that holds a path decides. */
const readRoots = async (vfs: ModuleVFS): Promise<ProcessingRoot[]> => {
  const roots = new Map<string, readonly string[]>();
  let after: NodeQueryCursor | undefined;
  for (;;) {
    const page = await vfs.query(ADMIN_ACCESS, {
      types: ['directory'],
      where: [{ ref: PROCESSING_ATTR, op: 'exists' }],
      ...(after ? { after } : {}),
      limit: PAGE,
    });
    for (const entry of page) {
      const families = familiesOf(entry.node.attrs[PROCESSING_ATTR]);
      if (families) roots.set(entry.absPath, families);
    }
    if (page.length < PAGE) break;
    after = { value: null, id: page[page.length - 1].id };
  }
  return [...roots].map(([path, families]) => ({ path, families })).sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
};

/** Whether `event` can change the folders or their paths: the attr set, changed or cleared, a directory moved or removed. */
const changesRoots = (event: NodeEvent): boolean => {
  if (event.type === 'moved' || event.type === 'deleted') return true;
  return JSON.stringify(event.node.attrs[PROCESSING_ATTR] ?? null) !== JSON.stringify(event.previousNode?.attrs[PROCESSING_ATTR] ?? null);
};

const keptRoots = keptPerVfs({ read: readRoots, nodeTypes: ['directory'], changes: changesRoots });

/** The directories that say which processing they want, nearest first. Read once and kept (see the file's comment). */
export const processingRoots = async (vfs: ModuleVFS): Promise<readonly ProcessingRoot[]> => await keptRoots(vfs);
