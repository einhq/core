/**
 * The trees PgStore's scoped statements leave out, walked once and kept: a library view leaves out
 * the same unlisted trees on every call, and walking one held 500 000 files took 1.4 s, alone and
 * before each aggregate (ein/core#692).
 */

import type { NodeId } from '../../vfs/mod.ts';

/** Sets of roots kept; past it the least recently used goes first. */
const TREE_CACHE_SIZE = 16;

/** How many recent drops are remembered; a walk read before all of them is not cached. */
const DROP_MEMORY = 4_096;

/**
 * The nodes of each set of roots whose children lie within them: the roots and every node below
 * that is neither a file nor a softlink (`treeCte` in `query.ts`).
 *
 * Kept per set of roots. Nothing expires. Which nodes a tree holds changes only with an edge under
 * one of them, so the store drops the parent of every edge a write adds, removes or moves, but for
 * a new file or softlink, which holds no tree below it, and every node it deletes, when that
 * write's transaction ends; a tree holding a dropped node is forgotten. As in `PathCache`, `fill`
 * leaves out a walk that holds a node dropped since its `version`.
 */
export class TreeCache {
  private trees = new Map<string, { nodes: Set<NodeId>; list: NodeId[] }>();
  /** Recently dropped nodes and the version that dropped each; oldest first. */
  private dropped = new Map<NodeId, number>();
  /** The newest version whose drop is no longer in `dropped`. */
  private forgotten = 0;
  private _version = 0;

  constructor(
    private readonly capacity = TREE_CACHE_SIZE,
    private readonly dropMemory = DROP_MEMORY,
  ) {}

  /** Changes on every drop; `fill` takes what it was before the walk was read. */
  get version(): number {
    return this._version;
  }

  /** The nodes the walk from `roots` holds, or undefined when it is not known. */
  get(roots: NodeId[]): NodeId[] | undefined {
    const key = treeKey(roots);
    const tree = this.trees.get(key);
    if (!tree) return undefined;
    this.trees.delete(key);
    this.trees.set(key, tree);
    return tree.list;
  }

  /** Remember the walk from `roots`, unless it holds a node dropped after `version` was read. */
  fill(version: number, roots: NodeId[], nodes: NodeId[]): void {
    if (version < this.forgotten) return;
    const held = new Set(nodes);
    for (const [id, at] of this.dropped) if (at > version && held.has(id)) return;
    const key = treeKey(roots);
    this.trees.delete(key);
    this.trees.set(key, { nodes: held, list: nodes });
    if (this.trees.size > this.capacity) this.trees.delete(this.trees.keys().next().value!);
  }

  /** Forget every tree holding `id`: an edge under it changed, or it was deleted. */
  drop(id: NodeId): void {
    for (const [key, tree] of this.trees) if (tree.nodes.has(id)) this.trees.delete(key);
    this._version++;
    this.dropped.delete(id);
    this.dropped.set(id, this._version);
    if (this.dropped.size > this.dropMemory) {
      const [oldest, at] = this.dropped.entries().next().value!;
      this.dropped.delete(oldest);
      this.forgotten = at;
    }
  }

  clear(): void {
    this._version++;
    this.forgotten = this._version;
    this.dropped.clear();
    this.trees.clear();
  }
}

/** The same roots in any order are one tree. */
const treeKey = (roots: NodeId[]): string => [...new Set(roots)].sort().join(',');
