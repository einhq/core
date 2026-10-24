import type { TreeNodeData } from '@mantine/core';
import { useTree } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canList } from '../lib/access.ts';
import type { NodeChildEntry } from '../lib/node-entry.ts';
import { parentPath } from '../lib/node-path.ts';
import { entriesToTreeNodes } from '../lib/node-sort.ts';
import type { NodeSort } from '../lib/nodes-workspace.ts';
import { listingVersion, listNodes } from '../signals/nodes.ts';
import { shellClientEpoch } from '../signals/shell-client.ts';
import { useAccessIds } from './useAccessIds.ts';

export type NodeTreeState = {
  data: TreeNodeData[];
  tree: ReturnType<typeof useTree>;
  /** The root listing is in flight and nothing is shown yet. */
  loading: boolean;
  /** The root listing failed; deeper failures show on their own rows. */
  error: Error | null;
  /** The entry behind a path the tree shows, or `undefined` for the root and for the unknown. */
  entryAt: (path: string) => NodeChildEntry | undefined;
  /** Every entry listed under a directory the tree has loaded. */
  entriesOf: (dir: string) => NodeChildEntry[] | undefined;
  /** Refetch one directory and redraw; the root when omitted. */
  reload: (dir?: string) => Promise<void>;
  /** Directories the tree currently shows the contents of — what to watch. */
  openDirs: string[];
};

/**
 * One tab's tree: a root path, and the listings of whatever is expanded.
 *
 * The tree data is rebuilt from a per-directory cache rather than patched in
 * location. Mantine only asks `onLoadChildren` for a node whose `children` is not
 * yet an array, so a rebuilt tree that carries the cached listings keeps its
 * expanded rows without refetching them, and re-sorting or reloading is the
 * same rebuild with different input. That is one code path where merge-on-
 * load, merge-on-reload and re-sort-in-place would be three.
 */
export function useNodeTree(root: string, sort: NodeSort, showHidden = true): NodeTreeState {
  const access = useAccessIds();
  useSignals();
  const cache = useRef(new Map<string, NodeChildEntry[]>());
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const rootRef = useRef(root);
  rootRef.current = root;

  const load = useCallback(async (dir: string) => {
    const entries = await listNodes(dir);
    // A listing that came back after the tab moved on belongs to nothing.
    if (rootRef.current !== root) return;
    cache.current.set(dir, entries);
    setVersion((n) => n + 1);
  }, [root]);

  const onLoadChildren = useCallback((value: string) => load(value), [load]);
  const tree = useTree({ multiple: true, onLoadChildren });
  // `useTree` returns a fresh object each render; the callbacks below want the latest one without depending on it.
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const reload = useCallback(async (dir: string = rootRef.current) => {
    if (dir === rootRef.current) {
      try {
        await load(dir);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
      return;
    }
    // Only directories the tree shows are worth refetching; anything else is
    // listed on expand anyway.
    if (!cache.current.has(dir)) return;
    try {
      await load(dir);
    } catch {
      // Left as it was: the row keeps its last listing, and the next expand
      // (or event) tries again.
      cache.current.delete(dir);
      treeRef.current.invalidateNode(dir);
      setVersion((n) => n + 1);
    }
  }, [load]);

  // A new root is a new tree: the cache and the expansion belong to the old one.
  // The reconnect epoch is here too — a fresh socket means missed events.
  const epoch = shellClientEpoch.value;
  useEffect(() => {
    cache.current.clear();
    treeRef.current.setExpandedState({});
    treeRef.current.clearSelected();
    setLoading(true);
    setError(null);
    reload(root);
  }, [root, epoch, reload]);

  // Writes the explorer made elsewhere bump the version of the directory they
  // touched; every tree showing it refetches.
  const versions = listingVersion.value;
  const seen = useRef(versions);
  useEffect(() => {
    const previous = seen.current;
    seen.current = versions;
    for (const [dir, n] of versions) {
      if (previous.get(dir) !== n && (dir === rootRef.current || cache.current.has(dir))) reload(dir);
    }
  }, [versions, reload]);

  const data = useMemo(() => {
    const options = { showHidden, listable: (entry: NodeChildEntry) => canList(entry.node.props, access) };
    const attach = (node: TreeNodeData): TreeNodeData => {
      const entries = cache.current.get(node.value);
      if (!entries) return node;
      return { ...node, children: entriesToTreeNodes(entries, node.value, sort, options).map(attach) };
    };
    const entries = cache.current.get(root);
    return entries ? entriesToTreeNodes(entries, root, sort, options).map(attach) : [];
    // `version` is the cache's change counter.
  }, [root, sort, showHidden, access, version]);

  const entriesOf = useCallback((dir: string) => cache.current.get(dir), []);
  const entryAt = useCallback((path: string) => {
    if (path === rootRef.current) return undefined;
    const name = path.slice(path.lastIndexOf('/') + 1);
    return cache.current.get(parentPath(path))?.find((entry) => entry.name === name);
  }, []);

  const expanded = tree.expandedState;
  const openDirs = useMemo(
    () => [root, ...Object.keys(expanded).filter((dir) => expanded[dir] && dir !== root && cache.current.has(dir))],
    // `version` decides which of the expanded rows are actually loaded.
    [root, expanded, version],
  );

  return { data, tree, loading, error, entryAt, entriesOf, reload, openDirs };
}
