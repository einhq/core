/**
 * Ordering a listing and turning it into tree data.
 *
 * Containers first regardless of key: a directory listing where `2019/` sorts
 * between `2018.jpg` and `2020.jpg` reads as a mistake, and nothing in the
 * detail columns changes that. Within each half the key applies, and a tie
 * falls back to name so the order is stable across reloads.
 */
import type { TreeNodeData } from '@mantine/core';
import type { NodeChildEntry } from './node-entry.ts';
import { nodeTypeLabel } from './node-kind.ts';
import { joinPath } from './node-path.ts';
import type { NodeSort } from './nodes-workspace.ts';
import { toMillis } from './node-entry.ts';

/** Types whose children are the point; everything else is a leaf that merely may have some. */
const CONTAINER_TYPES = new Set(['directory', 'album', 'person', 'location', 'device', 'track', 'user', 'group']);

export const isContainer = (entry: Pick<NodeChildEntry, 'node'>): boolean => CONTAINER_TYPES.has(entry.node.type);

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const compareOptional = (a: number | undefined, b: number | undefined): number => {
  if (a === undefined && b === undefined) return 0;
  // Missing values sink to the end in either direction.
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
};

function compareBy(sort: NodeSort, a: NodeChildEntry, b: NodeChildEntry): number {
  switch (sort.key) {
    case 'type':
      return byName.compare(nodeTypeLabel(a), nodeTypeLabel(b));
    case 'size':
      return compareOptional(a.node.attrs.size, b.node.attrs.size);
    case 'modified':
      return compareOptional(toMillis(a.node.props.modtime?.timestamp), toMillis(b.node.props.modtime?.timestamp));
    default:
      return byName.compare(a.name, b.name);
  }
}

export function sortEntries(entries: NodeChildEntry[], sort: NodeSort): NodeChildEntry[] {
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...entries].sort((a, b) => {
    const containers = Number(isContainer(b)) - Number(isContainer(a));
    if (containers !== 0) return containers;
    const primary = compareBy(sort, a, b);
    if (primary !== 0) return primary * sign;
    return byName.compare(a.name, b.name) * sign;
  });
}

/** A name starting with a dot, as `ls` hides it unless asked. */
export const isHidden = (entry: Pick<NodeChildEntry, 'name'>): boolean => entry.name.startsWith('.');

/** What a rendered row can read back from its tree node. */
export type NodeTreeProps = { entry: NodeChildEntry; path: string };

/**
 * Tree nodes for a directory's entries, keyed by absolute path.
 *
 * `hasChildren` from the child count lets the tree draw a chevron before
 * anything under the node has been listed; the listing happens on expand.
 * Hidden entries are left out unless `showHidden`, and a node the reader may
 * not list (`listable`) gets no chevron, so the tree never tries to open it.
 */
export function entriesToTreeNodes(
  entries: NodeChildEntry[],
  parentPath: string,
  sort: NodeSort,
  { showHidden = true, listable = () => true }: { showHidden?: boolean; listable?: (entry: NodeChildEntry) => boolean } = {},
): TreeNodeData[] {
  return sortEntries(showHidden ? entries : entries.filter((entry) => !isHidden(entry)), sort).map((entry) => {
    const path = joinPath(parentPath, entry.name);
    return {
      value: path,
      label: entry.name,
      hasChildren: entry.childCount > 0 && listable(entry),
      nodeProps: { entry, path } satisfies NodeTreeProps,
    };
  });
}
