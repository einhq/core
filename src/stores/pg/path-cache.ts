/**
 * What PgStore's path walks have read, kept so that a walk it has answered before costs no query.
 */

import type { NodeId, PathEntry, PathNode, ResolvedNodeChain } from '../../vfs/mod.ts';

/** Entries per map; past it the least recently used go first. */
const PATH_CACHE_SIZE = 65_536;

/** How many recent drops are remembered; a walk read before all of them is not cached. */
const DROP_MEMORY = 4_096;

/**
 * The hierarchy edges a path walk follows — which child a parent has under a name, or that it has
 * none — and the props the walk checks on each node.
 *
 * Keyed by edge rather than by path: renaming or moving a directory changes one edge, and every
 * path below it is made of the same edges as before. Nothing expires. The store drops what a write
 * changed when that write's transaction ends. A walk that was in flight across that moment may
 * have read the old value, so `fill` leaves out every key dropped since the walk's `version` and
 * caches the rest: a busy writer elsewhere does not keep a walk from being cached.
 */
export class PathCache {
  /** `parentId/name` → the child, or null when the parent has no child of that name. */
  private edges = new Map<string, NodeId | null>();
  private props = new Map<NodeId, PathNode['props']>();
  /** Recently dropped keys, edge or node, and the version that dropped each; oldest first. */
  private dropped = new Map<string, number>();
  /** The newest version whose drop is no longer in `dropped`. */
  private forgotten = 0;
  private _version = 0;

  constructor(
    private readonly capacity = PATH_CACHE_SIZE,
    private readonly dropMemory = DROP_MEMORY,
  ) {}

  /** Changes on every drop; `fill` takes what it was before the walk was read. */
  get version(): number {
    return this._version;
  }

  /** The walk of `segments` from `fromId`, or undefined when any step of it is not known. */
  chain(fromId: NodeId, segments: string[]): ResolvedNodeChain | undefined {
    const rootProps = this.get(this.props, fromId);
    if (!rootProps) return undefined;

    const entries: PathEntry[] = [];
    let parent = fromId;
    for (const name of segments) {
      const child = this.get(this.edges, edgeKey(parent, name));
      if (child === undefined) return undefined;
      if (child === null) break;
      const props = this.get(this.props, child);
      if (!props) return undefined;
      entries.push({ id: child, name, props });
      parent = child;
    }
    return { root: { id: fromId, props: rootProps }, entries };
  }

  /**
   * Remember a walk the store answered — and, when it stopped short, that the next name is not
   * there — leaving out whatever was dropped after `version` was read.
   */
  fill(version: number, fromId: NodeId, segments: string[], chain: ResolvedNodeChain): void {
    if (version < this.forgotten) return;
    const unchanged = (key: string) => (this.dropped.get(key) ?? 0) <= version;

    if (unchanged(fromId)) this.put(this.props, fromId, chain.root.props);
    let parent = fromId;
    for (const entry of chain.entries) {
      const edge = edgeKey(parent, entry.name);
      if (unchanged(edge)) this.put(this.edges, edge, entry.id);
      if (unchanged(entry.id)) this.put(this.props, entry.id, entry.props);
      parent = entry.id;
    }
    if (chain.entries.length < segments.length) {
      const edge = edgeKey(parent, segments[chain.entries.length]);
      if (unchanged(edge)) this.put(this.edges, edge, null);
    }
  }

  /** Forget which child `parentId` has under `name`, or that it has none. */
  dropEdge(parentId: NodeId, name: string): void {
    const key = edgeKey(parentId, name);
    this.edges.delete(key);
    this.remember(key);
  }

  /** Forget a node's props; no walk through the node is answered here until it is read again. */
  dropNode(id: NodeId): void {
    this.props.delete(id);
    this.remember(id);
  }

  clear(): void {
    this._version++;
    this.forgotten = this._version;
    this.dropped.clear();
    this.edges.clear();
    this.props.clear();
  }

  /** Note a drop for `fill`, forgetting the oldest one past `dropMemory`. */
  private remember(key: string): void {
    this._version++;
    this.dropped.delete(key);
    this.dropped.set(key, this._version);
    if (this.dropped.size > this.dropMemory) {
      const [oldest, at] = this.dropped.entries().next().value!;
      this.dropped.delete(oldest);
      this.forgotten = at;
    }
  }

  /** `map.get`, moving a hit to the back of the eviction order. */
  private get<K, V>(map: Map<K, V>, key: K): V | undefined {
    if (!map.has(key)) return undefined;
    const value = map.get(key)!;
    map.delete(key);
    map.set(key, value);
    return value;
  }

  /** `map.set`, evicting the least recently used entry past `capacity`. */
  private put<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > this.capacity) map.delete(map.keys().next().value!);
  }
}

/** A node id holds no `/`, so the first one separates the two halves, and no edge key is an id. */
const edgeKey = (parentId: NodeId, name: string) => `${parentId}/${name}`;
