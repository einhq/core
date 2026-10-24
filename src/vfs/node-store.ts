/**
 * NodeStore: where a VFS keeps its nodes and the edges between them. A store reads and writes;
 * mounts, path resolution, access and events are the VFS's.
 */

import { GroupId, Mode, Ownership, UserId } from '../lib/mode/mod.ts';
import type { Access } from '../lib/access/types.ts';
import type { Node, NodeAttrs, NodeChild, NodeId, NodePath, NodeType } from './node.ts';
import type { AggregateBucket, NodeAggregateQuery, NodeQuery, NodeQueryRow, ParentLink, ResolvedPath } from './query.ts';
import { NodeAttrsUpdate, NodeChildEntry, NodePropsCreate, NodePropsUpdate } from './types.ts';
import type { IndexDecl } from '../lib/contributions/types.ts';
import type { AuditQuery, AuditRecord } from '../lib/api/audit.ts';

/**
 * Narrows a child-edge lookup: by name or by child. `getChildren` also takes a page of the
 * listing and the node types to list.
 */
export type ChildLinkFilter = {
  name?: string;
  childId?: NodeId;
  /**
   * `limit` children in name order (the store's collation), after the one named `after`: a
   * listing read a page at a time. An unpaged listing is in `(position, name)` order.
   */
  page?: { limit: number; after?: string };
  /** Only children of these node types. */
  types?: NodeType[];
};

/**
 * `ChildLinkFilter.page` and `types` applied to a listing already in hand, for a store that reads
 * a whole directory anyway: the children of those types, then in name order (code units) the ones
 * after `page.after`, `page.limit` of them.
 */
export const pageChildEntries = <T extends NodeAttrs>(entries: NodeChildEntry<T>[], opts?: ChildLinkFilter): NodeChildEntry<T>[] => {
  const types = opts?.types;
  let result = types ? entries.filter((entry) => types.includes(entry.node.type)) : entries;
  const page = opts?.page;
  if (page) {
    result = result
      .filter((entry) => page.after === undefined || entry.name > page.after)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, page.limit);
  }
  return result;
};

/** One child `createNodes` makes: what `createNode` takes of it. */
export type NewChild<T extends NodeAttrs = NodeAttrs> = { type: NodeType; name: string; props: NodePropsCreate; attrs?: T };

/** One edge `moveChildren` moves: from `(parentId, name)` to its new parent and name. */
export type EdgeMove = { from: ParentLink; to: ParentLink };

/** One node's change in `updateNodesEach`. */
export type NodeUpdate<T extends NodeAttrs = NodeAttrs> = { id: NodeId; props?: NodePropsUpdate; attrs?: NodeAttrsUpdate<T> };

/** The subtree a store query is limited to, by this store's node ids; see `NodeQuery.within`. */
export type StoreScope = { withinId?: NodeId; notWithinIds?: NodeId[] };

/**
 * A query as a store is asked it: the VFS has resolved `within` and `notWithin` to ids. With
 * `reader`, only nodes it may read and reach are returned, as `StoreAggregateQuery` counts them;
 * the VFS passes it only to a store that keeps reach (`NodeStore.reachable`), and leaves it out for
 * an administrator.
 */
export type StoreNodeQuery = Omit<NodeQuery, 'within' | 'notWithin'> & StoreScope & { reader?: Access };

/**
 * An aggregate as a store is asked it; see `StoreNodeQuery`. With `reader`, only nodes it may
 * read and reach are counted: its stored reach admits the reader (see `NodeStore.reachable`), and
 * the node grants it read. The VFS leaves `reader` out for an administrator.
 */
export type StoreAggregateQuery = Omit<NodeAggregateQuery, 'within' | 'notWithin'> & StoreScope & { reader?: Access };

/**
 * A path as a store resolves it: `ResolvedPath` plus the ids of every directory it
 * passes through, root first and the direct parent last (the root's own path has
 * none). The VFS strips them before a path leaves it.
 */
export type StoredPath = ResolvedPath & { ancestors: NodeId[] };

/** What a path walk reads of a node: who may pass through it, and where a softlink sends it. */
export type PathNode = {
  id: NodeId;
  props: Ownership & { softlink?: NodePath };
};

/** A node a path walk reached, with the name it was reached by. */
export type PathEntry = PathNode & { name: string };

/**
 * An id `releaseOwner` takes off every node: a deleted user's uid — a share link's turned off among
 * them, which owns nothing — or a deleted group's gid, and the id that owns in its place.
 */
export type OwnerRelease =
  | { kind: 'uid'; id: UserId; to: UserId }
  | { kind: 'gid'; id: GroupId; to: GroupId };

/** How many nodes `releaseOwner` changed: those it owned, and those whose ACL named it. */
export type ReleasedOwner = { owned: number; acl: number };

/** The root and the nodes reached below it in one store walk. */
export type ResolvedNodeChain = {
  root: PathNode;
  entries: PathEntry[];
};

// ===== Transaction Support =====

/**
 * Transaction handle for atomic multi-operation sequences.
 * Stores that don't support real transactions return a no-op transaction.
 */
export interface Transaction {
  /** Unique transaction ID */
  readonly id: string;

  /** Whether the transaction is still active */
  readonly active: boolean;

  /** Commit all changes made within this transaction */
  commit(): Promise<void>;

  /** Rollback all changes made within this transaction */
  rollback(): Promise<void>;

  /**
   * Tell the transaction what kind of state it is writing.
   *
   * A transaction whose every write was declared `ephemeral` may commit without
   * waiting for the write-ahead log to reach disk: the writes are lost if the
   * server crashes in the next fraction of a second, which is fine for state
   * that does not outlive the process anyway (sessions, ttys). One `durable`
   * write pins the whole commit, and a write nobody declared counts as durable.
   * Stores without the distinction leave this out.
   */
  declareWrite?(durability: WriteDurability): void;
}

/** See `Transaction.declareWrite`. */
export type WriteDurability = 'durable' | 'ephemeral';

/**
 * No-op transaction for stores that don't support transactions.
 * commit() and rollback() do nothing.
 */
export const NO_OP_TRANSACTION: Transaction = {
  id: 'no-op',
  active: true,
  commit: async () => {},
  rollback: async () => {},
};

export type NodeStoreConfig = {
  rootId?: NodeId;
  rootMode?: Mode;
};

export interface NodeStore {
  // ===== Identity =====

  /** Store name for debugging/logging */
  readonly name: string;

  readonly type: 'persistent' | 'dynamic' | 'readonly';

  readonly rootId: NodeId;

  /** Whether another VFS can be mounted inside this one */
  readonly supportsMount: boolean;

  /**
   * The store mirrors a tree that lives elsewhere (a host directory, an SFTP
   * server): a node's id is derived from its path, so it changes when the node
   * moves, and its content is addressed by the path within the mount — the file
   * registry is handed that path, not the id.
   */
  readonly pathAddressed?: boolean;

  /** Where the content comes from, for `mount` to show (`user@host:path`) */
  readonly source?: string;

  readonly config: NodeStoreConfig;

  // ===== Lifecycle =====

  initialize(): Promise<void>;

  dispose(): Promise<void>;

  isHealthy(): Promise<boolean>;

  // ===== Transaction Support =====

  /**
   * Begin a new transaction.
   * Stores that don't support real transactions return NO_OP_TRANSACTION.
   */
  beginTransaction(): Promise<Transaction>;

  // ===== Core Read Operations (Required) =====

  /**
   * Get a node by ID
   * @param id Node ID to fetch
   * @param tx Optional transaction (for row locking in supported stores)
   * @throws NodeNotFoundError if node doesn't exist
   */
  getNode<T extends NodeAttrs = NodeAttrs>(
    id: NodeId,
    tx?: Transaction,
  ): Promise<Node<T>>;

  /**
   * List children of a node, as entries — the node plus the name it is linked
   * under. One round trip for the whole directory, or for one page of it
   * (`opts.page`, `opts.types`): the caller must not follow up with a `getNode`
   * per child.
   */
  getChildren<T extends NodeAttrs = NodeAttrs>(
    parentId: NodeId,
    opts?: ChildLinkFilter,
    tx?: Transaction,
  ): Promise<NodeChildEntry<T>[]>;

  /**
   * `getChildren` for many parents in one round trip, each listing in its own
   * order. A parent with no children here is absent.
   *
   * Optional; callers fall back to one `getChildren` per parent.
   */
  getChildrenMany?<T extends NodeAttrs = NodeAttrs>(
    parentIds: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, NodeChildEntry<T>[]>>;

  /**
   * The hierarchy edges under a parent.
   *
   * With `opts.name` this is a point lookup (name is unique within a parent),
   * which is what the name-collision checks in create/link/rename want; with
   * `opts.childId` it is the reverse, for unlink. `page` and `types` are
   * `getChildren`'s and are not read here.
   */
  getChildLinks(
    parentId: NodeId,
    opts?: ChildLinkFilter,
    tx?: Transaction,
  ): Promise<NodeChild[]>;

  /**
   * Number of children, without listing them: the "is it empty?" probe.
   */
  countChildren(parentId: NodeId, tx?: Transaction): Promise<number>;

  /**
   * How many children of each parent `reader` may read, judged by each child's own access columns
   * as `verifyAccess` judges them. A parent with none is absent. Administrators are the caller's to
   * let through.
   *
   * Optional; without it the VFS judges the children's access columns itself.
   */
  countReadableChildren?(
    reader: Access,
    parentIds: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, number>>;

  /**
   * Child edges for many parents at once, for listings that need each entry's
   * own children (see `ChildrenOptions.childLinks`). Optional; callers fall
   * back to one `getChildLinks` per parent.
   */
  getChildLinksMany?(
    parentIds: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, NodeChild[]>>;

  /**
   * List parents of a node, as full nodes.
   *
   * Prefer `getParentLinks` when all you need is "which parent, under what
   * name", which is what path resolution wants — it answers from the hierarchy
   * alone, without reading a node row at all.
   */
  getParents<T extends NodeAttrs = NodeAttrs>(
    childId: NodeId,
    tx?: Transaction,
  ): Promise<Node<T>[]>;

  /**
   * The hierarchy edges pointing at a node: which parent links it, under which
   * name. A node hard-linked twice under one parent yields two entries.
   *
   * This is all path resolution needs, and it avoids reading the parent nodes.
   *
   * Optional; callers fall back to `getParents` + `getChildLinks`.
   */
  getParentLinks?(
    childId: NodeId,
    tx?: Transaction,
  ): Promise<{ parentId: NodeId; name: string }[]>;

  /**
   * The batched form of `getParentLinks`, for callers holding thousands of ids.
   *
   * `resolvePaths` answers the same question, but pays to build every ancestor
   * name into a string on the way — which is wasted when all the caller wants
   * is "which node is this hanging under, and called what". Ids with no parent
   * edge are absent from the map.
   *
   * Optional; callers fall back to `getParentLinks` per id.
   */
  getParentLinksMany?(
    childIds: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, ParentLink[]>>;

  /**
   * Check if node exists
   */
  exists(id: NodeId, tx?: Transaction): Promise<boolean>;

  // ===== Write Operations (Optional) =====

  /**
   * Create a node *and* the edge naming it under `parentId` — one operation,
   * because every store can do both in a single round trip and the VFS has no
   * use for a node that nothing points at. The returned node's `count` is 1.
   *
   * Throws `NodeAlreadyExistsError` if the name is taken under the parent and
   * `NodeNotFoundError` if the parent is gone. Stores are expected to let their
   * own uniqueness constraint answer the first of those rather than asking in a
   * separate read.
   *
   * @param tx Optional transaction
   * @returns Node if created
   */
  createNode?<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    type: NodeType,
    parentId: NodeId,
    name: string,
    prop: NodePropsCreate,
    attrs?: T,
    tx?: Transaction,
  ): Promise<Node<T>>;

  /**
   * `createNode` for many children of one parent, in a fixed number of statements however many
   * there are: each named under the parent in the order given, and returned in it. A name taken,
   * there or twice among them, throws `NodeAlreadyExistsError` and creates none.
   *
   * Optional; the VFS falls back to one `createNode` per child in the same transaction.
   */
  createNodes?<T extends NodeAttrs = NodeAttrs>(uid: UserId, parentId: NodeId, children: NewChild<T>[], tx?: Transaction): Promise<Node<T>[]>;

  /**
   * Update a node.
   *
   * Not a place to change hierarchy: `count` is a fact about the edges naming
   * the node, so the store keeps it true from `createNode`/`linkChild`/
   * `unlinkChild` and nothing writes it directly.
   *
   * @param tx Optional transaction
   * @returns Node if updated
   */
  updateNode?<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    id: NodeId,
    props?: NodePropsUpdate,
    attrs?: NodeAttrsUpdate<T>,
    tx?: Transaction,
  ): Promise<Node<T>>;

  /**
   * `updateNode` for many nodes given the same change, in a fixed number of
   * statements however many there are.
   *
   * Optional; the VFS falls back to one `updateNode` per id in the same
   * transaction.
   *
   * @returns the nodes as written, link count included. An id with no node is
   *   absent.
   */
  updateNodes?<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    ids: NodeId[],
    props?: NodePropsUpdate,
    attrs?: NodeAttrsUpdate<T>,
    tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>>;

  /**
   * `updateNode` for many nodes, each with its own change, in a fixed number of statements however
   * many there are. One id at most once.
   *
   * Optional; the VFS falls back to one `updateNode` per node in the same transaction.
   *
   * @returns the nodes as written, link count included. An id with no node is absent.
   */
  updateNodesEach?<T extends NodeAttrs = NodeAttrs>(
    uid: UserId,
    changes: NodeUpdate<T>[],
    tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>>;

  /**
   * Delete a node
   * @param tx Optional transaction
   * @returns true if deleted
   */
  deleteNode?(
    uid: UserId,
    id: NodeId,
    tx?: Transaction,
  ): Promise<boolean>;

  /**
   * Delete many nodes, in a fixed number of statements however many there are; each must have
   * no children left, as for `deleteNode`.
   *
   * Optional; the VFS falls back to one `deleteNode` per node in the same transaction.
   */
  deleteNodes?(uid: UserId, ids: NodeId[], tx?: Transaction): Promise<void>;

  // ===== Hierarchy Writes (Optional) =====
  //
  // Each write names the edges it changes; none touches their siblings.

  /**
   * Link an existing node under a parent, and raise its link count by one.
   * Throws `NodeAlreadyExistsError` if the name is taken.
   */
  linkChild?(
    uid: UserId,
    parentId: NodeId,
    childId: NodeId,
    name: string,
    tx?: Transaction,
  ): Promise<void>;

  /**
   * Drop the edge `name` from a parent to a child, and lower its link count by
   * one. Another edge to the same child, under this parent or any other, stays.
   */
  unlinkChild?(
    uid: UserId,
    parentId: NodeId,
    childId: NodeId,
    name: string,
    tx?: Transaction,
  ): Promise<void>;

  /**
   * `unlinkChild` for many edges, in a fixed number of statements however many there are.
   *
   * Optional; the VFS falls back to one `unlinkChild` per edge in the same transaction.
   */
  unlinkChildren?(uid: UserId, edges: (ParentLink & { id: NodeId })[], tx?: Transaction): Promise<void>;

  /** Move an edge: rename in place, or re-parent, in one operation. */
  moveChild?(
    uid: UserId,
    oldParentId: NodeId,
    oldName: string,
    newParentId: NodeId,
    newName: string,
    tx?: Transaction,
  ): Promise<void>;

  /**
   * `moveChild` for many edges, in a fixed number of statements however many there are. No two
   * moves may name the same edge, and none may move onto an edge another one moves away.
   *
   * Optional; the VFS falls back to one `moveChild` per edge in the same transaction.
   */
  moveChildren?(uid: UserId, moves: EdgeMove[], tx?: Transaction): Promise<void>;

  /**
   * The edges named by many `(parent, name)` pairs, in one round trip: what a batched move reads
   * of its sources and destinations. A pair no edge has is absent.
   *
   * Optional; the VFS falls back to one `getChildLinks` per pair.
   */
  findChildLinks?(edges: ParentLink[], tx?: Transaction): Promise<(ParentLink & { id: NodeId })[]>;

  // ===== Attribute Queries (Optional) =====

  /**
   * Find nodes by their attrs, without walking the tree.
   *
   * Stores that don't implement it simply contribute no results — callers must
   * treat absence as "this store has nothing to offer", not as an error.
   */
  queryNodes?<T extends NodeAttrs = NodeAttrs>(
    query: StoreNodeQuery,
    tx?: Transaction,
  ): Promise<NodeQueryRow<T>[]>;

  /**
   * How many nodes are within `rootId` (see `NodeQuery.within`), counted up to `cap`: `cap` means
   * at least that many. A node linked twice within may count twice. What a caller asks before it
   * reads a whole subtree, to know whether it is small enough to read at once.
   *
   * Present wherever `queryNodes` is.
   */
  countWithin?(rootId: NodeId, cap: number, tx?: Transaction): Promise<number>;

  /**
   * Create the attr indexes a module declared (`mod.json` `indexes`) if they are missing. Absent
   * for a store with no indexes to create — in memory every query is a scan anyway.
   */
  ensureAttrIndexes?(indexes: IndexDecl[]): Promise<void>;

  // ===== Audit Trail (Optional) =====

  /** Whether this store keeps an audit trail; when true, `appendAudit` and `queryAudit` exist. */
  readonly auditing?: boolean;

  /**
   * Record a mutation's audit trail in the mutation's own transaction, so it commits or rolls
   * back with the writes it describes. A store without it keeps no trail.
   */
  appendAudit?(records: AuditRecord[], tx?: Transaction): Promise<void>;

  /** Read the trail back, newest first. */
  queryAudit?(query: AuditQuery): Promise<AuditRecord[]>;

  /** Bucket-count nodes by one or more attr or node-column dimensions. */
  groupCount?(
    query: StoreAggregateQuery,
    tx?: Transaction,
  ): Promise<AggregateBucket[]>;

  /**
   * Hand every node the released id owns to `release.to`, and drop every ACL entry naming it — an
   * entry left behind would grant whoever is given that id next. A node whose ACL ends up empty
   * has none. Bulk and unaudited: it is what deleting the account or group leaves to do, not a
   * write to any one node.
   *
   * Optional; a store whose ownership is not its own to change (a mounted file system) has nothing
   * to release.
   */
  releaseOwner?(release: OwnerRelease, changeUid: UserId): Promise<ReleasedOwner>;

  /**
   * Find the softlinks pointing *at* the given paths — the reverse of following
   * one.
   *
   * Links are one-directional, so answering "what points here?" otherwise
   * means walking the whole tree. The target is already a stored column, so this is an
   * indexed lookup.
   *
   * Rows carry no link count, like `getNodes`. Same contract as the other
   * optional methods: a store that doesn't implement it contributes nothing.
   */
  findSoftlinks?(
    targets: NodePath[],
    limit: number,
    tx?: Transaction,
  ): Promise<Node[]>;

  /**
   * `findSoftlinks` for the links pointing at one of `paths` or anywhere under one: a target under
   * `/a/b` starts `/a/b/`, so `/a/bc` is not. What a move re-points. Inside a transaction the rows
   * are locked until it ends.
   *
   * Present wherever `findSoftlinks` is.
   */
  findSoftlinksUnder?(
    paths: NodePath[],
    limit: number,
    tx?: Transaction,
  ): Promise<Node[]>;

  /**
   * Resolve many node ids to their absolute paths in one go.
   *
   * The generic path (`getParents` up to the root, per id) reads every ancestor
   * node in full, once per id. A store that can answer this from the hierarchy
   * alone should, since path resolution needs nothing but `(parent_id, name)`
   * edges.
   *
   * Returns one entry per id that resolved; hard-linked nodes map to several
   * paths. Ids absent from the map were not found in this store. Each path
   * carries the ids it passes through, which is what lets the VFS check execute
   * on every ancestor without walking the path again.
   */
  resolvePaths?(
    ids: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, StoredPath[]>>;

  /**
   * The access columns of many nodes — mode, owner, group, ACL — and nothing else.
   *
   * What an access check needs, without the attrs `getNodes` joins in: filtering a
   * registry's hits or a batch of ancestors reads these for thousands of ids. Ids
   * absent from the map were not found in this store.
   */
  getOwnership?(
    ids: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, Ownership>>;

  /**
   * Of `ids`, those this store holds that `access` can reach — some path from the root has execute
   * for it on every node above — each with its access columns, for the caller to check the node's
   * own bits. Administrators are the caller's to let through.
   *
   * Answered from the reach the store keeps on every node (`vfs/reach.ts`), which every write
   * that changes a node's parents or who a node lets through brings up to date in its own
   * transaction. A store without it leaves the VFS to walk the parents.
   */
  reachable?(
    access: Access,
    ids: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, Ownership>>;

  /**
   * The uids and gids the reach of some node in this store names: whom a released id would let
   * through if it still appeared. Present wherever `reachable` is.
   */
  reachNamed?(): Promise<{ uids: UserId[]; gids: GroupId[] }>;

  /**
   * Fetch many nodes by id in one round trip.
   *
   * Same motivation as `resolvePaths`: filtering a page of candidates one
   * `getNode` at a time pays N round trips. Rows carry no link count
   * (`count` 0), like query rows — callers that need it should `getNode` the
   * few they actually care about.
   *
   * Inside a transaction the rows are locked until it ends, as `getNode`'s are:
   * a batched write reads its nodes this way before deciding to write them.
   */
  getNodes?<T extends NodeAttrs = NodeAttrs>(
    ids: NodeId[],
    tx?: Transaction,
  ): Promise<Map<NodeId, Node<T>>>;

  /**
   * Walk `segments` down from `fromId`, returning the root and the node at each
   * reached level — only what a walk checks of them (`PathNode`), not attrs or
   * timestamps.
   *
   * The downward counterpart to {@link resolvePaths}: resolving a path one
   * `getChildren(parent, {name})` at a time costs a round trip per segment,
   * which every VFS call pays before it does anything.
   *
   * The root is included because traversal must check its execute permission,
   * and fetching it separately would cost another round trip. `entries` is in segment order and **may be shorter than `segments`** — the
   * walk simply stops where the hierarchy does. A short result is not an error:
   * the caller replays its own per-level logic (permission checks, mount points,
   * softlinks) over these nodes and falls back to stepping for whatever is
   * missing. That is what keeps this a pure read optimization; the store is not
   * asked to know about mounts or links.
   */
  resolveChain?(
    fromId: NodeId,
    segments: string[],
    tx?: Transaction,
  ): Promise<ResolvedNodeChain>;
}
