import { Access } from '../lib/access/types.ts';
import type { GroupId, UserId } from '../lib/mode/mod.ts';
import type { SimilarityMatch, SimilarPair } from '../registries/embedding/types.ts';
import type { GeoBounds, NearbyMatch, PositionPoint, WithinMatch } from '../registries/position/types.ts';
import type {
  PoolClaimRequest,
  PoolCounts,
  PoolFailOptions,
  PoolJob,
  PoolJobFilter,
  PoolJobId,
  PoolJobInput,
  PoolJobSelector,
  PoolPurgeOptions,
  PoolSweepResult,
} from '../registries/pool/types.ts';
import type { QueueDeadAction, QueueDeadEntry, QueueEntryId, QueuePeekEntry } from '../registries/queue/types.ts';
import type { TrackSummary } from '../registries/track/types.ts';
import { ResourceHandleIf, ResourceMode, ResourceStat } from '../registries/types.ts';
import { Node, NodeAttrs, NodeChild, NodeId, NodePath, NodeType } from './node.ts';
import type { AggregateBucket, LinkEntry, NodeAggregateQuery, NodeQuery, NodeQueryEntry, ParentLink, ResolvedPath } from './query.ts';
import {
  ChildCountOptions,
  ChildrenOptions,
  CopyOptions,
  EventSubscription,
  EventSubscriptionFilter,
  EventSubscriptionHandler,
  Mount,
  NodeAttrsUpdate,
  NodeChange,
  NodeChildEntry,
  NodeEntry,
  NodePropsCreate,
  NodePropsUpdate,
  NodeReference,
  NodeResolveOptions,
  NodeTreeSpec,
  RenamedNode,
  RenameManyOptions,
  RenameMove,
  UnlinkTarget,
  UpdateManyOptions,
} from './types.ts';
import type { IndexDecl } from '../lib/contributions/types.ts';
import type { AuditQuery, AuditRecord } from './audit.ts';
import type { OwnerRelease, ReleasedOwner } from './node-store.ts';

/**
 * The virtual filesystem as callers see it: every operation takes the caller's `Access` first and
 * a node by id, path or entry, and reaches whatever is mounted below.
 */
export interface NodeVFS {
  /** The store's name, for debugging and logging */
  readonly name: string;

  /** The store's type */
  readonly type: 'persistent' | 'dynamic' | 'readonly';

  /** Where the content comes from, when it is somewhere else (`user@host:path`) */
  readonly source?: string;

  readonly rootId: NodeId;

  initialize(): Promise<void>;

  dispose(): Promise<void>;

  isHealthy(): Promise<boolean>;

  // ===== Read Operations =====
  /**
   * Get a node by ID, path, or entry
   * @throws NodeNotFoundError if node doesn't exist
   */
  get<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions,
  ): Promise<Node<T>>;

  /** List the children of a node, each with the name it is linked under. */
  children<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    parentRef: NodeReference,
    opts?: NodeResolveOptions & ChildrenOptions,
  ): Promise<NodeChildEntry<T>[]>;

  /**
   * `children` for many directories at once: the directories in one read and their children in
   * another per store, rather than a round trip or two per directory. Each directory is checked as
   * `children` checks it, and one that cannot be listed fails alone.
   *
   * @returns one listing per ref, in order.
   */
  childrenMany<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    refs: NodeReference[],
    opts?: NodeResolveOptions & ChildCountOptions,
  ): Promise<PromiseSettledResult<NodeChildEntry<T>[]>[]>;

  /**
   * How many children a node has, without listing them: the cheap way to ask
   * "is it empty?" of a directory that is not. It counts those the caller may
   * read, as `children` lists them, unless asked for all.
   */
  childCount(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions & ChildCountOptions,
  ): Promise<number>;

  /**
   * Check if node exists
   */
  exists(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions,
  ): Promise<boolean>;

  resolvePath(
    access: Access,
    path: NodePath,
    opts?: NodeResolveOptions,
  ): Promise<NodeEntry>;

  /**
   * Resolve a node reference to an entry: an entry is returned as it is, a
   * path is resolved through whatever is mounted along it
   */
  resolveEntry(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions,
  ): Promise<NodeEntry>;

  resolveId(
    access: Access,
    id: NodeId,
  ): Promise<NodeEntry[]>;

  /**
   * Absolute paths for many ids at once — the batched form of `resolveId`.
   *
   * Prefer this whenever resolving more than a couple of ids: `resolveId`
   * reads every ancestor node in full, per id. Ids that resolve nowhere are
   * absent from the map; hard-linked nodes map to several paths.
   */
  resolveIdPaths(
    access: Access,
    ids: NodeId[],
  ): Promise<Map<NodeId, string[]>>;

  /** As `resolveIdPaths`, but each path also carries its direct parent id. */
  resolveIdEntries(
    access: Access,
    ids: NodeId[],
  ): Promise<Map<NodeId, ResolvedPath[]>>;

  /**
   * Which parent each id hangs under, and the name it is linked as — without
   * building a single path.
   *
   * For callers that hold a batch of ids from a registry and need to know what
   * kind of thing each one is before deciding which ones are worth resolving in
   * full. A link is kept only when its parent is a directory the caller can
   * reach and pass through; the node itself is not read, so a caller that shows
   * the result to a user must read the nodes it ends up naming.
   */
  getParentLinksByIds(
    access: Access,
    ids: NodeId[],
  ): Promise<Map<NodeId, ParentLink[]>>;

  /**
   * The child edges under each of many nodes — name and id — in one batched
   * lookup per store, without building a path or reading a node.
   *
   * For walking down a known layout from thousands of nodes at once (a file's
   * `metadata/content/text_jina5s`). Only ids the caller can reach and read
   * are listed; the children themselves are not read, so a caller that shows
   * what it reaches must read or resolve those nodes. An id held here maps to
   * its children, `[]` for a leaf; an id nobody holds is absent.
   */
  getChildLinksByIds(
    access: Access,
    ids: NodeId[],
  ): Promise<Map<NodeId, NodeChild[]>>;

  /**
   * Fetch many nodes by id at once, access-filtered.
   *
   * Prefer over a `get` loop when filtering a batch of candidates. Rows carry
   * no link count (`count` 0) — `get` the few that actually need it.
   */
  getNodesByIds<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    ids: NodeId[],
  ): Promise<Map<NodeId, Node<T>>>;

  // ===== Write Operations =====
  /**
   * Ensure a node exists, if exists props and attrs are ignored
   * @returns Node if created or exists
   */
  ensure<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    type: NodeType,
    parentRef: NodeReference,
    name: string,
    opts?: NodeResolveOptions & {
      props?: Partial<NodePropsCreate>;
      attrs?: T;
    },
  ): Promise<Node<T>>;

  /**
   * Create a node
   * @returns Node if created
   */
  create<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    type: NodeType,
    parentRef: NodeReference,
    name: string,
    opts?: NodeResolveOptions & {
      props?: Partial<NodePropsCreate>;
      attrs?: T;
    },
  ): Promise<Node<T>>;

  /**
   * Create a whole subtree under one existing parent, as one transaction and
   * one batch of post-commit events. Use it whenever the nodes are written
   * together and a reader has no use for a half-built tree.
   *
   * @returns the created top-level nodes, in spec order.
   */
  createTree<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    parentRef: NodeReference,
    specs: NodeTreeSpec<T>[],
    opts?: NodeResolveOptions,
  ): Promise<Node<T>[]>;

  /**
   * Update a node
   * @returns Node if updated
   */
  update<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions & {
      props?: NodePropsUpdate;
      attrs?: NodeAttrsUpdate<T>;
    },
  ): Promise<Node<T>>;

  /**
   * `update` for many nodes, each given the same change, in batches: a batch takes its whole lock
   * set, is one transaction, and commits and lets go before the next begins. The nodes are not
   * changed atomically: one transaction for them all would hold every lock until the last node was
   * written, with every other writer to any of them queued behind it. A reader can see some
   * changed and others not, and an aborted call leaves the rest as they were.
   *
   * A node that refuses (no write access, gone, on a read-only mount) fails alone, and the others
   * go on. A node reached by several entries is written once.
   *
   * @returns one result per ref, in order.
   */
  updateMany<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    refs: NodeReference[],
    opts?: UpdateManyOptions<T>,
  ): Promise<PromiseSettledResult<Node<T>>[]>;

  /**
   * `update` for many nodes, each given its own change, in batches as `updateMany` makes them: a
   * batch takes its whole lock set, is one transaction, and commits before the next begins. A node
   * that refuses fails alone. Two changes to one node are made one after the other, in order.
   *
   * @returns one result per change, in order.
   */
  updateEach<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    changes: NodeChange<T>[],
    opts?: { signal?: AbortSignal },
  ): Promise<PromiseSettledResult<Node<T>>[]>;

  /**
   * Rename/move a node. Within one backend the node itself moves; between two mounted backends
   * its tree is copied and the source removed, so the node at the destination is a new one.
   * A node already at the destination name is replaced, as Unix `rename` does, unless it has
   * children (`NodeInvalidOperationError`) or `failIfExists` is set (`NodeAlreadyExistsError`).
   * @returns Node if renamed/moved
   */
  rename<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    oldParentRef: NodeReference,
    oldName: string,
    newParentRef: NodeReference,
    newName: string,
    opts?: NodeResolveOptions & { failIfExists?: boolean },
  ): Promise<Node<T>>;

  /**
   * Move many nodes, as `rename` moves one, in the order given: in chunks of a fixed size, each of
   * which takes its whole lock set and is one transaction. In the same transaction every softlink
   * the store holds whose target is a moved path, or lies under one, is re-pointed at the new
   * path, and a relation link's `relation.peerLink` with it; the caller must be able to write each
   * such link, or the chunk fails. Links another store holds, and those to a node moved between
   * stores, are re-pointed once the moves are made, as far as the caller can see them.
   *
   * A move that refuses — no access, a source that is gone, a taken name with `failIfExists`, a
   * move into its own subtree, a destination another move in the chunk names or empties — fails
   * alone, before anything is written. A failure while writing fails its whole chunk, with nothing
   * in it written. A source that is gone with its destination there is a move an earlier call made
   * (`already`), so a call cut short can be made again.
   *
   * @returns one result per move, in order.
   */
  renameMany<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    moves: RenameMove[],
    opts?: RenameManyOptions,
  ): Promise<PromiseSettledResult<RenamedNode<T>>[]>;

  /**
   * Link an existing node as child of another parent (hard link)
   * Increments the node's link count (props.count)
   * @returns Node if linked
   */
  link<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    ref: NodeReference,
    parentRef: NodeReference,
    name: string,
    opts?: NodeResolveOptions,
  ): Promise<Node<T>>;

  /**
   * Unlink a node from a parent
   * Decrements link count (props.count), deletes node if count reaches 0
   * @returns true if unlinked (and possibly deleted)
   */
  unlink(
    access: Access,
    ref: NodeReference,
    parentRef: NodeReference,
    opts?: NodeResolveOptions & {
      recursive?: boolean;
    },
  ): Promise<boolean>;

  /**
   * `unlink` for many nodes, each by the edge its path names — the node there itself, a softlink
   * never followed — in chunks of a fixed size, each of which takes its whole lock set and is one
   * transaction. A node losing its last link is deleted. One that would lose it while it still has
   * children, a parent the caller may not write, and a path with nothing at it fail alone, before
   * anything in the chunk is written. With `recursive`, as `unlink` with it, a node losing its last
   * link is emptied of its descendants first; a chunk's subtrees are emptied together.
   *
   * @returns one result per path, in order: true when the node itself went with its last link.
   */
  unlinkMany(
    access: Access,
    targets: UnlinkTarget[],
    opts?: { signal?: AbortSignal; recursive?: boolean },
  ): Promise<PromiseSettledResult<boolean>[]>;

  /**
   * Copy a node to a new location, across VFS backends too. The source tree is read and checked
   * before anything is written, and a copy that fails part-way is removed again.
   * @param access Access context
   * @param sourceRef Source node reference
   * @param destParentRef Destination parent reference
   * @param newName Optional new name (defaults to source name)
   * @param opts Options including recursive, overwrite, maxDepth
   * @returns The newly created node copy
   * @throws NodeInvalidOperationError for a node with children without `recursive`
   * @throws NodeAlreadyExistsError if dest exists and overwrite=false
   */
  copy<T extends NodeAttrs = NodeAttrs>(
    access: Access,
    sourceRef: NodeReference,
    destParentRef: NodeReference,
    newName?: string,
    opts?: NodeResolveOptions & CopyOptions,
  ): Promise<Node<T>>;

  // ===== Streaming Operations =====

  /**
   * Open a node's content through its type's registry
   *
   * @param access - Access context (uid, gid, etc.)
   * @param ref - Node reference (ID, path, or entry)
   * @param opts - Open options (mode, truncate, etc.)
   * @returns the registry's handle
   */
  open(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions & {
      mode?: ResourceMode;
    },
  ): Promise<ResourceHandleIf>;

  stat(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions,
  ): Promise<ResourceStat>;

  statX(
    access: Access,
    ref: NodeReference,
    opts?: NodeResolveOptions,
  ): Promise<ResourceStat>;

  // ===== Work Pools =====
  /**
   * Operations on a `pool` node. Unlike the similarity and geo searches below,
   * these are path-scoped rather than a fan-out across mounts: each one resolves
   * its node, checks access on it, and routes to the owning VFS, exactly as
   * `open` does.
   *
   * Add a job, or upsert it when its `dedupKey` matches a live one. Requires
   * write access to the pool node.
   */
  poolAdd(access: Access, ref: NodeReference, job: PoolJobInput): Promise<PoolJob>;

  /**
   * Claim the best job the offer can run, under a lease. Blocking when `signal`
   * is given, in which case it resolves null only on a genuine abort.
   */
  poolClaim(access: Access, ref: NodeReference, req: PoolClaimRequest, signal?: AbortSignal): Promise<PoolJob | null>;

  /** Extend a lease. False when the job is no longer claimed by `owner`. */
  poolHeartbeat(access: Access, ref: NodeReference, jobId: PoolJobId, owner: string, leaseMs?: number): Promise<boolean>;

  poolComplete(access: Access, ref: NodeReference, jobId: PoolJobId, owner: string, result?: unknown): Promise<PoolJob | null>;

  /** Retry with backoff until the attempts run out, then fail terminally. */
  poolFail(access: Access, ref: NodeReference, jobId: PoolJobId, owner: string, error: string, opts?: PoolFailOptions): Promise<PoolJob | null>;

  /** Hand a claimed job back unrun, giving back the attempt its claim counted. */
  poolRelease(access: Access, ref: NodeReference, jobId: PoolJobId, owner: string, delayMs?: number): Promise<PoolJob | null>;

  poolCancel(access: Access, ref: NodeReference, sel: PoolJobSelector): Promise<number>;

  /** Return terminal jobs to `ready` with a clean attempt count. */
  poolRetry(access: Access, ref: NodeReference, sel: PoolJobSelector): Promise<number>;

  /** Delete terminal jobs, so a pool does not grow without bound. */
  poolPurge(access: Access, ref: NodeReference, opts?: PoolPurgeOptions): Promise<number>;

  poolJobs(access: Access, ref: NodeReference, filter?: PoolJobFilter): Promise<PoolJob[]>;

  poolCounts(access: Access, ref: NodeReference): Promise<PoolCounts>;

  /** Reclaim expired leases, fail exhausted jobs, promote aging. Idempotent. */
  poolSweep(access: Access, ref: NodeReference): Promise<PoolSweepResult>;

  // ===== Queue Operations =====

  /** The first `limit` live entries of a queue in delivery order, claiming none; reading a queue would consume them. */
  queuePeek(access: Access, ref: NodeReference, limit: number): Promise<QueuePeekEntry[]>;

  /** The first `limit` entries a queue set aside after they ran out of delivery attempts. */
  queueDead(access: Access, ref: NodeReference, limit: number): Promise<QueueDeadEntry[]>;

  /** Retry or drop a queue's dead-lettered entries, all or those of `ids`; returns how many. Needs write access. */
  queueSettleDead(access: Access, ref: NodeReference, action: QueueDeadAction, ids?: QueueEntryId[]): Promise<number>;

  // ===== Similarity Search =====
  /**
   * Find embeddings similar to the given vector across this VFS and all
   * mounted sub-VFS instances recursively, returning the global top matches
   * sorted by similarity (descending).
   *
   * `within` ranks only those embedding ids, exactly — for "which of these
   * pictures", which the nearest-neighbour search over the whole type cannot
   * answer once the set is larger than the few hundred rows it returns.
   */
  findSimilar(
    access: Access,
    embeddingType: string,
    data: Uint8Array,
    limit?: number,
    threshold?: number,
    within?: NodeId[],
  ): Promise<SimilarityMatch[]>;

  /**
   * All near-neighbour edges among the embeddings of one type across this VFS
   * and all mounted sub-VFS instances recursively — each mount's edges
   * concatenated (edges never cross a mount boundary). The clustering primitive
   * behind duplicate detection and face grouping.
   */
  findAllPairs(
    access: Access,
    embeddingType: string,
    limit?: number,
    threshold?: number,
  ): Promise<SimilarPair[]>;

  /**
   * The raw vectors behind a set of embedding node ids, gathered across this VFS
   * and all mounted sub-VFS instances. For callers that need every pairwise
   * comparison inside a subset the index cannot express — the alternative is one
   * `open`/`read` round trip per id. Ids with no stored vector are absent.
   */
  getVectors(
    access: Access,
    embeddingType: string,
    ids: NodeId[],
  ): Promise<Map<NodeId, Uint8Array>>;

  // ===== Geo Search =====
  /**
   * Find positions within a radius of a point across this VFS and all
   * mounted sub-VFS instances recursively, sorted by distance.
   */
  findNearby(
    access: Access,
    lat: number,
    lng: number,
    radiusMeters?: number,
    limit?: number,
  ): Promise<NearbyMatch[]>;

  /**
   * Find position points inside a bounding box across this VFS and all
   * mounted sub-VFS instances recursively.
   */
  findWithin(
    access: Access,
    bounds: GeoBounds,
    limit?: number,
  ): Promise<WithinMatch[]>;

  /**
   * Find positions whose shape (polygon, or radius fallback) contains a
   * point, across this VFS and all mounted sub-VFS instances recursively,
   * sorted by distance to the shape's center.
   */
  findContaining(
    access: Access,
    lat: number,
    lng: number,
    limit?: number,
  ): Promise<NearbyMatch[]>;

  /**
   * The point of each of many position nodes, by id, gathered across this VFS and all mounted
   * sub-VFS instances: for a caller that holds a batch of `position` ids (a page of files'
   * children) and needs their coordinates, where a search would read the whole map. A polygon's
   * point is its centroid. Ids the caller cannot reach and read, and ids with no stored point, are
   * absent.
   */
  getPoints(
    access: Access,
    ids: NodeId[],
  ): Promise<Map<NodeId, PositionPoint>>;

  /**
   * The summary of each of many track nodes, by id — point count, time span and extent — in one
   * registry read per VFS, gathered across this VFS and all mounted sub-VFS instances: for a
   * listing of tracks, which must not open each one. Ids the caller cannot reach and read, and ids
   * that are not tracks, are absent.
   */
  trackSummaries(
    access: Access,
    ids: NodeId[],
  ): Promise<Map<NodeId, TrackSummary>>;

  // ===== Attribute Queries =====
  /**
   * Find nodes by their attrs across this VFS and all mounted sub-VFS
   * instances, without walking the tree. Results are access-filtered and
   * resolved to absolute paths. Fewer than `limit` entries means there are no
   * more: a page is never cut short by rows the caller may not see.
   *
   * `within` limits it to a subtree, answered by the store holding the root;
   * `notWithin` leaves subtrees out (see `NodeQuery`).
   */
  query(access: Access, query: NodeQuery): Promise<NodeQueryEntry[]>;

  /**
   * How many nodes are within `path` (see `NodeQuery.within`), counted up to
   * `cap`: `cap` means at least that many. What a caller asks before reading a
   * whole subtree at once. Needs read and execute on `path`.
   */
  countWithin(access: Access, path: NodePath, cap: number): Promise<number>;

  /**
   * Find the softlinks pointing at `targets` — the reverse of following one.
   *
   * Links are one-directional, so this is how a subject answers "what refers
   * to me?" without walking the tree. Results are
   * access-filtered and resolved to absolute paths, and each carries the id of
   * the directory the link sits in — usually the node the caller actually
   * wants.
   */
  findLinks(
    access: Access,
    targets: NodePath | NodePath[],
    limit?: number,
  ): Promise<LinkEntry[]>;

  /**
   * `findLinks` for the links pointing at one of `paths` or anywhere under one
   * (`/a/b` covers `/a/b/c`, not `/a/bc`): what a move of `paths` re-points.
   */
  findLinksUnder(
    access: Access,
    paths: NodePath[],
    limit?: number,
  ): Promise<LinkEntry[]>;

  /**
   * Bucket-count nodes by one or more attr or node-column dimensions across
   * this VFS and all mounted sub-VFS instances. A per-year histogram for a
   * date range control; a pipeline×status matrix for the dashboard.
   *
   * Only nodes the caller may read and reach are counted, as `query` returns
   * them; a node below a file is counted only when it hangs directly under one
   * (a face under a photo). `within` needs read and execute on its root, as
   * listing it does.
   */
  aggregate(access: Access, query: NodeAggregateQuery): Promise<AggregateBucket[]>;

  /**
   * Create the attr indexes a module declared (`mod.json` `indexes`) in this VFS's store, if they
   * are missing. Administrators only: it is DDL, and on a large table it takes a while.
   */
  ensureAttrIndexes(access: Access, indexes: IndexDecl[]): Promise<void>;

  /**
   * Take a deleted user's uid or group's gid off every node in this VFS and every mount: what it
   * owned goes to `release.to`, and every ACL entry naming it is dropped. Administrators only.
   */
  releaseOwner(access: Access, release: OwnerRelease): Promise<ReleasedOwner>;

  /**
   * The uids and gids named by the stored reach of some node, in this VFS and every mount (see
   * `NodeStore.reachNamed`): after an id's release it should be among them no more. Administrators
   * only.
   */
  reachNamed(access: Access): Promise<{ uids: UserId[]; gids: GroupId[] }>;

  /**
   * Read the audit trail, newest first, or with `query.after` oldest first from there: who
   * created, changed, moved, linked or removed which node, and when. Administrators only. Covers
   * this VFS's own store and what is mounted into it, merged in id order.
   */
  audit(access: Access, query: AuditQuery): Promise<AuditRecord[]>;

  // ===== Mount Operations =====
  /**
   * Mount a backend at a specific path
   */
  mount(
    access: Access,
    path: NodePath,
    vfs: NodeVFS,
    opts?: Mount['options'] & NodeResolveOptions,
  ): Promise<void>;

  /**
   * Unmount a backend from a path
   */
  unmount(
    access: Access,
    path: NodePath,
    opts?: NodeResolveOptions,
  ): Promise<void>;

  /**
   * Get all mount points
   */
  mounts(access: Access): Mount[];

  // ===== Event Notifications (Optional) =====
  /**
   * Subscribe to node changes.
   *
   * Handlers run after the mutation that produced the event has committed and
   * released its locks, so one may read or write the VFS freely. They are still
   * awaited, so the mutation does not return until they are done.
   */
  subscribe?<T extends NodeAttrs = NodeAttrs>(
    getAccess: () => Promise<Access> | Access,
    handler: EventSubscriptionHandler<T>,
    filter?: EventSubscriptionFilter,
  ): Promise<EventSubscription>;

  /**
   * Told by the VFS it is mounted into (true) or detached from (false).
   *
   * A mounted VFS sees its own paths relative to its mount point, so it leaves
   * publishing to the queues to the outermost VFS, which knows the absolute
   * path.
   */
  setMounted?(mounted: boolean): void;
}
